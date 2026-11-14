'use strict';
// The embedded modelling agent: one Claude Agent SDK conversation per scope, in-process tiles tools,
// drafts that apply only when accepted. Plain Node; no Electron imports.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const edits = require('./edits');
const { systemPrompt } = require('./prompt');
const { createHandlers, sdkTools } = require('./tools');
const { findUv } = require('../tilekit');

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const STRONG_MODEL = 'claude-opus-5-5';
const MAX_TURNS = 40;
const NOT_SIGNED_IN = 'The agent is not signed in. Sign in to Claude Code on this Mac, or set ANTHROPIC_API_KEY.';
const BUILTIN = new Set(['Read', 'Glob', 'Grep']);

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const zod = await import('zod');
      return { sdk, z: zod.z || zod.default || zod };
    })();
  }
  return sdkPromise;
}

function plain(text) {
  // The log is plain text: drop headings, bold and bullets the model may still produce.
  return String(text).replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^\s*[-*]\s+/gm, '').trim();
}

function errorSentence(kind, detail) {
  switch (kind) {
    case 'authentication_failed': case 'oauth_org_not_allowed': case 'cloud_credential_error': return NOT_SIGNED_IN;
    case 'billing_error': return 'The agent cannot run: the Claude account has a billing problem.';
    case 'account_on_hold': return 'The agent cannot run: the Claude account is on hold.';
    case 'rate_limit': return 'The agent is rate limited. Try again in a minute.';
    case 'overloaded': case 'server_error': return 'The model service is busy or failing. Try again shortly.';
    case 'model_not_found': return 'The configured agent model is not available to this account.';
    default: return `The agent stopped with an error${detail ? ': ' + String(detail).slice(0, 300) : ''}.`;
  }
}

const AUTH_TEXT = /not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|oauth token/i;

// pytest for one test file, using the model project's environment with the model's own src first.
function defaultPytest({ modelDir, project }) {
  return rel => new Promise(resolve => {
    const uv = findUv();
    if (!uv) return resolve({ passed: false, output: 'uv not found' });
    const child = spawn(uv, ['run', '--project', project, 'python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', rel], {
      cwd: modelDir, env: { ...process.env, PYTHONPATH: path.join(modelDir, 'src') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', e => resolve({ passed: false, output: e.message }));
    child.on('close', code => resolve({ passed: code === 0, output: out.trim().split('\n').slice(-40).join('\n') }));
  });
}

// Deny Read/Glob/Grep outside the model directory.
function readGuard(modelDir) {
  const root = fs.realpathSync(modelDir);
  const inside = p => {
    let full = path.resolve(root, p);
    try { full = fs.realpathSync(full); } catch {
      try { full = path.join(fs.realpathSync(path.dirname(full)), path.basename(full)); } catch { /* keep */ }
    }
    return full === root || full.startsWith(root + path.sep);
  };
  return async input => {
    const ti = input.tool_input || {};
    const candidates = [ti.file_path, ti.path, ti.notebook_path].filter(x => typeof x === 'string' && x);
    if (typeof ti.pattern === 'string' && input.tool_name === 'Glob') {
      if (ti.pattern.split(/[\\/]/).includes('..')) candidates.push('/');
      else if (path.isAbsolute(ti.pattern)) candidates.push(ti.pattern.split(/[*?[{]/)[0] || '/');
    }
    if (typeof ti.glob === 'string' && ti.glob.split(/[\\/]/).includes('..')) candidates.push('/');
    const bad = candidates.find(c => !inside(c));
    if (!bad) return {};
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: `Only files inside the model directory can be read (${bad} is outside).` } };
  };
}

function builtinSentence(name, input, modelDir) {
  let real = modelDir;
  try { real = fs.realpathSync(modelDir); } catch { /* keep */ }
  const rel = p => {
    if (!p) return '.';
    const abs = path.resolve(modelDir, p);
    for (const base of [modelDir, real]) if (abs === base || abs.startsWith(base + path.sep)) return path.relative(base, abs) || '.';
    return abs;
  };
  if (name === 'Read') return `Read ${rel(input.file_path)}.`;
  if (name === 'Glob') return `Listed files matching ${input.pattern}${input.path ? ' in ' + rel(input.path) : ''}.`;
  if (name === 'Grep') return `Searched for "${input.pattern}"${input.path ? ' in ' + rel(input.path) : ''}.`;
  return `Used ${name}.`;
}

/**
 * createAgentService({modelDir, repoRoot, tilekit, emit, confirm, modelName, pythonProject, runPytest, maxTurns})
 */
function createAgentService(options) {
  const { modelDir, repoRoot, tilekit, emit = () => {}, confirm = async () => false } = options;
  if (!modelDir || !tilekit) throw new Error('createAgentService needs modelDir and tilekit.');
  const modelName = options.modelName || DEFAULT_MODEL;
  const runPytest = options.runPytest === undefined
    ? defaultPytest({ modelDir, project: options.pythonProject || modelDir }) : options.runPytest;
  const active = new Map(); // scopeKey -> {controller, scope, started}
  const totals = { turns: 0, cost_usd: 0, last: null };
  let signedIn = null;
  let lastError = null;

  function emitEvent(scope, ev) {
    const event = { scope, ...ev, at: store.now() };
    if (event.text !== undefined) event.text = String(event.text);
    try { store.appendLog(modelDir, scope, event); } catch (e) { /* the log must not stop the agent */ }
    try { emit(event); } catch { /* listener errors are theirs */ }
    return event;
  }

  const svc = {
    modelDir, repoRoot, tilekit, confirm, runPytest, emitEvent,
    saveDraftEvent(draft) {
      store.saveDraft(modelDir, draft);
      emitEvent(draft.scope, { type: 'draft', text: draft.summary, draft: { id: draft.id, kind: draft.kind, items: draft.items, warnings: draft.warnings || [], result: draft.result } });
    },
  };

  async function scopeExists(scope) {
    if (scope.level === 'model') return true;
    const graph = await tilekit('graph');
    if (scope.level === 'module') return graph.modules.some(m => m.id === scope.id);
    return !!(graph.quantities[scope.id] && graph.quantities[scope.id].kind === 'tile');
  }

  // One agent turn in `scope`. Returns {ok, asked, writes, drafts, cost_usd, ms, num_turns, error}.
  async function runTurn(scope, prompt, { batchModule = null } = {}) {
    const key = store.scopeKey(scope);
    if (active.size) {
      const busy = [...active.values()][0].scope;
      const text = `The agent is busy with ${busy.level === 'model' ? 'the model' : `${busy.level} ${busy.id}`}. Wait for it or stop it first.`;
      emitEvent(scope, { type: 'error', text });
      return { ok: false, error: text };
    }
    const controller = new AbortController();
    active.set(key, { controller, scope, started: Date.now() });
    const turn = { scope, batchModule, asked: false, approved: new Set(), writes: [], drafts: [] };
    const started = Date.now();
    let outcome = { ok: false };
    try {
      const { sdk, z } = await loadSdk();
      const handlers = createHandlers(svc, turn);
      let resume = store.lastSession(modelDir, scope);
      for (let attempt = 0; attempt < 2; attempt++) {
        const server = sdk.createSdkMcpServer({ name: 'tiles', version: '0.1.0', tools: sdkTools(sdk, z, handlers, scope) });
        const q = sdk.query({
          prompt,
          options: {
            cwd: modelDir,
            model: modelName,
            systemPrompt: systemPrompt(scope, { batchModule }),
            tools: ['Read', 'Glob', 'Grep'],
            mcpServers: { tiles: server },
            allowedTools: ['Read', 'Glob', 'Grep', 'mcp__tiles__*'],
            permissionMode: 'dontAsk',
            settingSources: [],
            strictMcpConfig: true,
            env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'actuarial-modelling-app/0.0.1' },
            maxTurns: options.maxTurns || MAX_TURNS,
            abortController: controller,
            hooks: { PreToolUse: [{ matcher: 'Read|Glob|Grep', hooks: [readGuard(modelDir)] }] },
            ...(resume ? { resume } : {}),
          },
        });
        const r = await consume(q, scope, resume);
        if (r.resumeFailed && attempt === 0) {
          store.appendLog(modelDir, scope, { type: 'session', session_id: null, at: store.now(), note: 'previous session could not be resumed' });
          resume = null;
          continue;
        }
        outcome = r;
        break;
      }
    } catch (e) {
      if (controller.signal.aborted) outcome = { ok: false, aborted: true };
      else {
        const text = AUTH_TEXT.test(String(e && e.message)) ? NOT_SIGNED_IN : errorSentence('other', e && e.message);
        if (text === NOT_SIGNED_IN) signedIn = false;
        lastError = text;
        emitEvent(scope, { type: 'error', text });
        outcome = { ok: false, error: text };
      }
    } finally {
      active.delete(key);
    }
    const ms = Date.now() - started;
    totals.turns += 1;
    totals.cost_usd += outcome.cost_usd || 0;
    totals.last = { scope, ms, cost_usd: outcome.cost_usd || 0, num_turns: outcome.num_turns || 0 };
    emitEvent(scope, { type: 'done', text: outcome.aborted ? 'Stopped.' : '', ms, cost_usd: outcome.cost_usd || 0,
      num_turns: outcome.num_turns || 0, usage: outcome.usage || null, ok: !!outcome.ok });
    return { ...outcome, asked: turn.asked, writes: turn.writes, drafts: turn.drafts, ms };
  }

  async function consume(q, scope, resumed) {
    let sessionId = null;
    let sawAssistant = false;
    let reported = false;
    const report = text => { if (!reported) { reported = true; lastError = text; emitEvent(scope, { type: 'error', text }); } };
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        sessionId = m.session_id;
        if (sessionId && sessionId !== resumed) store.appendLog(modelDir, scope, { type: 'session', session_id: sessionId, model: m.model, at: store.now() });
      } else if (m.type === 'assistant') {
        if (m.error) {
          if (m.error === 'authentication_failed' || m.error === 'oauth_org_not_allowed') signedIn = false;
          report(errorSentence(m.error));
          continue;
        }
        sawAssistant = true;
        signedIn = true;
        for (const block of (m.message && m.message.content) || []) {
          if (block.type === 'text' && block.text && block.text.trim()) emitEvent(scope, { type: 'agent', text: plain(block.text) });
          else if (block.type === 'tool_use' && BUILTIN.has(block.name)) emitEvent(scope, { type: 'action', text: builtinSentence(block.name, block.input || {}, modelDir) });
        }
      } else if (m.type === 'result') {
        const base = { cost_usd: m.total_cost_usd, num_turns: m.num_turns, usage: m.usage, session_id: sessionId };
        if (m.subtype === 'success' && !m.is_error) return { ok: true, ...base };
        const detail = m.subtype === 'success' ? m.result : (m.errors || []).join(' ') || m.subtype;
        if (resumed && !sawAssistant && /conversation|session/i.test(String(detail))) return { ok: false, resumeFailed: true, ...base };
        if (AUTH_TEXT.test(String(detail))) { signedIn = false; report(NOT_SIGNED_IN); }
        else if (m.subtype === 'error_max_turns') report('The agent used its step limit for this message and stopped. Say "continue" to let it carry on.');
        else report(errorSentence('other', detail));
        return { ok: false, error: lastError, ...base };
      }
    }
    return { ok: sawAssistant, session_id: sessionId };
  }

  function extraText(extra) {
    if (!extra) return '';
    const parts = [];
    if (extra.formula) {
      parts.push(`The user typed this Excel formula in the tile's sheet; treat it as the spec: ${extra.formula}`);
      if (extra.rows && typeof extra.rows === 'object') {
        parts.push('Row map (sheet row -> quantity): ' + Object.entries(extra.rows).map(([r, n]) => `${r} -> ${n}`).join(', ') +
          '. Defined names in the formula are parameters.');
      }
      if (extra.cell) parts.push(`It was typed in cell ${extra.cell}.`);
    }
    if (extra.case) parts.push(`The user is looking at case ${extra.case}.`);
    return parts.length ? '\n\n' + parts.join('\n') : '';
  }

  function selectionLine(scope) {
    return scope.level === 'model' ? '[Selected: the whole model]' : `[Selected: ${scope.level} ${scope.id}]`;
  }

  return {
    async send(scopeIn, text, extra) {
      const scope = store.checkScope(scopeIn);
      if (typeof text !== 'string' || !text.trim()) throw new Error('Say something to the agent.');
      if (!(await scopeExists(scope))) {
        const msg = `There is no ${scope.level} ${scope.id} in the model.`;
        emitEvent(scope, { type: 'error', text: msg });
        return { ok: false, error: msg };
      }
      emitEvent(scope, { type: 'user', text: text.trim(), ...(extra ? { extra } : {}) });
      return runTurn(scope, `${selectionLine(scope)}\n${text.trim()}${extraText(extra)}`);
    },

    interrupt(scopeIn) {
      const scope = store.checkScope(scopeIn);
      const a = active.get(store.scopeKey(scope));
      if (!a) return false;
      a.controller.abort();
      return true;
    },

    history(scopeIn) {
      return store.readLog(modelDir, store.checkScope(scopeIn)).filter(e => e.type !== 'session');
    },

    drafts() {
      return store.listDrafts(modelDir);
    },

    async acceptDraft(id) {
      const draft = store.loadDraft(modelDir, id);
      if (draft.status !== 'proposed') throw new Error(`Draft ${id} is already ${draft.status}.`);
      if (active.size) throw new Error('Wait for the agent to finish before accepting a draft.');
      let r;
      if (draft.kind === 'tiles') r = await edits.acceptTileDraft(svc, draft);
      else if (draft.kind === 'modules') r = await edits.acceptModuleDraft(svc, draft);
      else if (draft.kind === 'what_if') {
        const it = draft.items[0];
        if (!it.code) throw new Error('This what-if changes parameters; it is for information only and cannot be applied from here.');
        const a = await edits.applyTileCode(svc, { name: it.name, code: it.code, testCode: null, approved: null });
        r = { accepted: a.ok, actions: a.ok ? a.actions : [...a.actions, a.declined ? 'The what-if was not applied.' : `The what-if was not applied: ${a.text.split('\n')[0]}`] };
      } else throw new Error(`Unknown draft kind ${draft.kind}.`);
      for (const t of r.actions) emitEvent(draft.scope, { type: 'action', text: t });
      if (r.accepted) {
        draft.status = 'accepted';
        draft.accepted_at = store.now();
        store.saveDraft(modelDir, draft);
      }
      return { accepted: !!r.accepted, actions: r.actions, draft };
    },

    discardDraft(id) {
      const draft = store.loadDraft(modelDir, id);
      if (draft.status !== 'proposed') throw new Error(`Draft ${id} is already ${draft.status}.`);
      draft.status = 'discarded';
      draft.discarded_at = store.now();
      store.saveDraft(modelDir, draft);
      emitEvent(draft.scope, { type: 'action', text: `Discarded the draft (${draft.summary.replace(/^Draft: |\.$/g, '')}).` });
      return { discarded: true, draft };
    },

    async buildModule(moduleId) {
      const scope = store.checkScope({ level: 'module', id: moduleId });
      const graph = await tilekit('graph');
      const mod = graph.modules.find(m => m.id === moduleId);
      if (!mod) throw new Error(`There is no module ${moduleId}.`);
      const todo = mod.tiles.filter(t => /^\s*Status:\s*not built/im.test(graph.quantities[t].source.code));
      if (!todo.length) {
        emitEvent(scope, { type: 'action', text: `Every tile in ${moduleId} is built.` });
        return { built: [], stoppedAt: null };
      }
      emitEvent(scope, { type: 'action', text: `Building ${todo.length} tile${todo.length === 1 ? '' : 's'} in ${moduleId}: ${todo.join(', ')}.` });
      const built = [];
      for (const name of todo) {
        const tscope = { level: 'tile', id: name };
        emitEvent(tscope, { type: 'user', text: `Implement ${name} from its spec (batch build of ${moduleId}).` });
        const r = await runTurn(tscope, `${selectionLine(tscope)}\nImplement ${name} from the spec in its docstring, with its hand-calculation test. Remove the \`Status: not built\` line. Ask with ask_user if the spec leaves an actuarial choice open.`, { batchModule: moduleId });
        const status = await tilekit('status').catch(() => null);
        const entry = status && status.tiles[name];
        const done = entry && entry.state !== 'not_built' && r.writes.some(w => w.name === name && w.ok);
        if (done) {
          built.push(name);
          emitEvent(scope, { type: 'action', text: `Built ${name}: ${edits.caseResultsSentence(entry)}.` });
          continue;
        }
        const why = r.asked ? 'it needs an answer to a question (see the tile log)' : r.aborted ? 'it was stopped' : r.error ? r.error.replace(/\.$/, '') : 'it was not written';
        emitEvent(scope, { type: 'action', text: `Stopped at ${name}: ${why}.` });
        return { built, stoppedAt: name, reason: why };
      }
      return { built, stoppedAt: null };
    },

    status() {
      return {
        busy: [...active.values()].map(a => ({ scope: a.scope, since: new Date(a.started).toISOString() })),
        model: modelName, strongModel: STRONG_MODEL, signedIn, lastError,
        turns: totals.turns, cost_usd: Number(totals.cost_usd.toFixed(4)), last: totals.last,
      };
    },
  };
}

module.exports = { createAgentService, readGuard, DEFAULT_MODEL, STRONG_MODEL, NOT_SIGNED_IN };
