'use strict';
// The modelling agent's side of the app: the tiles tools that Claude Code in the pane calls (through
// cli-bridge.js), drafts that apply only when accepted, sign-off and push requests that only the reviewer's click
// settles, and the audit trail (review/.../log.jsonl). `send` runs a turn with the Agent SDK and no window: nothing in
// the app sends through it; the real-agent tests do. It gets the same prompt and the same tools as the pane.
// Plain Node; no Electron imports.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const edits = require('./edits');
const scaffold = require('./scaffold');
const signoff = require('./signoff');
const testsMod = require('./tests');
const { systemPrompt, turnPreamble } = require('./prompt');
const { createHandlers, sdkTools, TOOL_NAMES } = require('./tools');
const { findUv, defaultProject } = require('../tilekit');
const gitMod = require('../git');

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
  return String(text).replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1').replace(/^\s*[-*]\s+/gm, '').trim();
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

// One test file run through the tooling (`tilekit test --file`), which keeps the result of a tile's or a module's own
// test in the model's test cache: a tile cannot be signed off until its test has passed since the last change, so the
// run the agent's tools make when they write a tile or its tests is the one that counts.
function tilekitPytest(tilekit) {
  return async rel => {
    try {
      const d = await tilekit('test', ['--file', rel]);
      return { passed: d.failed === 0 && d.passed > 0, output: String(d.output || '').trim().split('\n').slice(-40).join('\n') };
    } catch (e) { return { passed: false, output: String(e && e.message || e) }; }
  };
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

const SCAFFOLD_KINDS = new Set(['params', 'inputs', 'cases']);
const FORBIDDEN_FOR_TOOLS = new Set(['signoff', 'reconfirm']);

const pushSentence = r => { const n = (r.commits || []).length; return `Push ${n} commit${n === 1 ? '' : 's'} on ${r.branch} to GitHub? Click Push to do it.`; };

// The parts of a sign-off request the window shows (no stamps or scope).
function publicPush(r) {
  return { id: r.id, kind: 'push', name: 'push', branch: r.branch, remote: r.remote, commits: r.commits, status: r.status };
}

function publicRequest(r) {
  if (r.kind === 'push') return publicPush(r);
  const out = { id: r.id, kind: r.kind, name: r.name, label: r.label, spec: r.spec, formula: r.formula, assumed: r.assumed,
    cases: r.cases, blockers: r.blockers, values_only: r.values_only, status: r.status };
  if (r.checks) out.checks = r.checks;
  if (r.kind === 'reconfirm') { out.tiles = r.tiles; out.skipped = r.skipped; out.module = r.module; }
  return out;
}

/**
 * createAgentService({modelDir, repoRoot, tilekit, emit, confirm, modelName, pythonProject, runPytest, maxTurns})
 */
function createAgentService(options) {
  const { modelDir, repoRoot, tilekit, emit = () => {}, confirm = async () => false } = options;
  if (!modelDir || !tilekit) throw new Error('createAgentService needs modelDir and tilekit.');
  const modelName = options.modelName || DEFAULT_MODEL;
  const runPytest = options.runPytest === undefined ? tilekitPytest(tilekit) : options.runPytest;
  let active = null; // {controller, scope, started}
  let selection = null;   // what the window has selected now: the scope of the next message typed in the pane
  let cliGreeted = false; // the first message after the app starts carries a note that tools may have changed
  let cliTurn = null;     // the running turn's state in the pane, shared by its tool calls
  let sdkSession = null;  // the Agent SDK session of `send` (UI-less), kept only while this service lives
  const notes = []; // what happened outside the chat since the model's last turn (confirmations, drafts accepted)
  const totals = { turns: 0, cost_usd: 0, last: null };
  let signedIn = null;
  let lastError = null;

  function emitEvent(scope, ev) {
    const event = { scope, ...ev, at: store.now() };
    if (event.text !== undefined) event.text = String(event.text);
    try { store.appendEvent(modelDir, scope, event); } catch (e) { /* the log must not stop the agent */ }
    try { emit(event); } catch { /* listener errors are theirs */ }
    return event;
  }

  // The tools get a tilekit that cannot sign off or re-confirm; only confirmSignoff uses the real one.
  const toolTilekit = (command, args = []) => (FORBIDDEN_FOR_TOOLS.has(command)
    ? Promise.reject(new Error('The agent cannot sign off or re-confirm; only the reviewer can, with the button in the app.'))
    : tilekit(command, args));

  const svc = {
    modelDir, repoRoot, tilekit: toolTilekit, confirm, runPytest, emitEvent,
    // tell the window to open an item (not part of the conversation's record)
    showInApp(route) { try { emit({ type: 'navigate', route, at: store.now() }); } catch { /* listener errors are theirs */ } },
    // what the tools may do with git: read and commit. Pushing is not here; see confirmPush.
    git: { status: d => (options.git || gitMod).status(d), unpushed: d => (options.git || gitMod).unpushed(d), commit: (d, m) => (options.git || gitMod).commit(d, m) },
    savePushRequestEvent(req) {
      for (const old of store.listRequests(modelDir)) {
        if (old.status === 'pending' && old.kind === 'push') { old.status = 'superseded'; old.superseded_by = req.id; store.saveRequest(modelDir, old); }
      }
      store.saveRequest(modelDir, req);
      emitEvent(req.scope, { type: 'push_request', text: pushSentence(req), request: publicPush(req) });
      return req;
    },
    saveDraftEvent(draft) {
      store.saveDraft(modelDir, draft);
      emitEvent(draft.scope, { type: 'draft', text: draft.summary, draft: { id: draft.id, kind: draft.kind, items: draft.items, warnings: draft.warnings || [], result: draft.result, ...(draft.module ? { module: draft.module } : {}),
        ...(draft.sections ? { sections: draft.sections } : {}), ...(draft.checks ? { checks: draft.checks } : {}), ...(draft.file ? { file: draft.file } : {}) } });
    },
    saveRequestEvent(req) {
      for (const old of store.listRequests(modelDir)) {
        if (old.status === 'pending' && old.kind === req.kind && old.name === req.name) {
          old.status = 'superseded'; old.superseded_by = req.id;
          store.saveRequest(modelDir, old);
        }
      }
      store.saveRequest(modelDir, req);
      emitEvent(req.scope, { type: 'signoff_request', text: signoff.requestSentence(req), request: publicRequest(req) });
    },
  };

  async function scopeExists(scope) {
    if (scope.level === 'model') return true;
    const graph = await tilekit('graph');
    if (scope.level === 'module') return graph.modules.some(m => m.id === scope.id);
    return !!(graph.quantities[scope.id] && graph.quantities[scope.id].kind === 'tile');
  }

  const scopeWords = s => (s.level === 'model' ? 'the model' : `${s.level} ${s.id}`);

  // One agent turn run with the Agent SDK (no window), with `scope` selected.
  // Returns {ok, writes, drafts, cost_usd, ms, num_turns, session_id, error}.
  async function runTurn(scope, text, { batchModule = null } = {}) {
    if (active) {
      const msg = `The agent is busy with ${scopeWords(active.scope)}. Wait for it or stop it first.`;
      emitEvent(scope, { type: 'error', text: msg });
      return { ok: false, error: msg };
    }
    const controller = new AbortController();
    active = { controller, scope, started: Date.now() };
    const turn = { scope, batchModule, approved: new Set(), writes: [], drafts: [] };
    const started = Date.now();
    let outcome = { ok: false };
    try {
      const { sdk, z } = await loadSdk();
      const handlers = createHandlers(svc, turn);
      const prompt = `${turnPreamble(scope, { batchModule, notes: notes.splice(0) })}\n${text}`;
      let resume = sdkSession;
      for (let attempt = 0; attempt < 2; attempt++) {
        const server = sdk.createSdkMcpServer({ name: 'tiles', version: '0.2.0', tools: sdkTools(sdk, z, handlers) });
        const q = sdk.query({
          prompt,
          options: {
            cwd: modelDir,
            model: modelName,
            systemPrompt: systemPrompt({ modelDir }),
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
          resume = sdkSession = null;
          continue;
        }
        outcome = r;
        break;
      }
    } catch (e) {
      if (controller.signal.aborted) outcome = { ok: false, aborted: true };
      else {
        const msg = AUTH_TEXT.test(String(e && e.message)) ? NOT_SIGNED_IN : errorSentence('other', e && e.message);
        if (msg === NOT_SIGNED_IN) signedIn = false;
        lastError = msg;
        emitEvent(scope, { type: 'error', text: msg });
        outcome = { ok: false, error: msg };
      }
    } finally {
      active = null;
    }
    const ms = Date.now() - started;
    totals.turns += 1;
    totals.cost_usd += outcome.cost_usd || 0;
    totals.last = { scope, ms, cost_usd: outcome.cost_usd || 0, num_turns: outcome.num_turns || 0 };
    emitEvent(scope, { type: 'done', text: outcome.aborted ? 'Stopped.' : '', ms, cost_usd: outcome.cost_usd || 0,
      num_turns: outcome.num_turns || 0, usage: outcome.usage || null, ok: !!outcome.ok });
    return { ...outcome, writes: turn.writes, drafts: turn.drafts, ms };
  }

  async function consume(q, scope, resumed) {
    let sessionId = null;
    let sawAssistant = false;
    let reported = false;
    const report = msg => { if (!reported) { reported = true; lastError = msg; emitEvent(scope, { type: 'error', text: msg }); } };
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        sessionId = m.session_id;
        if (sessionId) sdkSession = sessionId;
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
          if (block.type === 'tool_use' && options.debug) options.debug({ use: block.name, input: block.input });
        }
      } else if (m.type === 'user' && options.debug) {
        for (const block of (m.message && Array.isArray(m.message.content) ? m.message.content : [])) {
          if (block.type === 'tool_result') options.debug({ result: JSON.stringify(block.content).slice(0, 400), isError: !!block.is_error });
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

  // A plain end-of-action marker for things the window started (no model turn).
  const doneEvent = (scope, ok = true) => emitEvent(scope, { type: 'done', text: '', ms: 0, cost_usd: 0, num_turns: 0, usage: null, ok });

  return {
    // The UI-less way to give the agent a message: one Agent SDK turn. Nothing in the window calls it (the pane is
    // Claude Code); the real-agent tests do (test/agent-harness.js, test/live-agent.js).
    async send(scopeIn, text, extra) {
      const scope = store.checkScope(scopeIn);
      if (typeof text !== 'string' || !text.trim()) throw new Error('Say something to the agent.');
      if (!(await scopeExists(scope))) {
        const msg = `There is no ${scope.level} ${scope.id} in the model.`;
        emitEvent(scope, { type: 'error', text: msg });
        return { ok: false, error: msg };
      }
      emitEvent(scope, { type: 'user', text: text.trim(), ...(extra ? { extra } : {}) });
      return runTurn(scope, `${text.trim()}${extraText(extra)}`);
    },

    // Stops the running turn, whatever was selected when it started. `scope` is accepted and ignored.
    interrupt() {
      if (!active) return false;
      active.controller.abort();
      return true;
    },

    // One selection's audit trail (review/.../log.jsonl).
    history(scopeIn) {
      return store.readLog(modelDir, store.checkScope(scopeIn)).filter(e => e.type !== 'session');
    },

    // ---- Claude Code in the terminal pane (src/agent/cli-bridge.js speaks to these over the local server).
    // The conversation is Claude Code's own; the tools, their scoping to the selection, drafts and sign-off requests
    // are exactly the ones above. A turn runs from the prompt hook to the stop hook.
    setSelection(scopeIn) { selection = store.checkScope(scopeIn); return selection; },
    async cliTools() {
      const { z } = await loadSdk();
      const fake = { tool: (name, description, shape) => ({ name, description, inputSchema: z.toJSONSchema(z.object(shape)) }) };
      return sdkTools(fake, z, {});
    },
    // The user sent a message in the pane: a turn starts on the current selection. Returns the bracketed lines
    // that tell the model what is selected and what happened in the app since its last message.
    cliPrompt() {
      const scope = selection || { level: 'model', id: 'model' };
      cliTurn = { scope, batchModule: null, approved: new Set(), writes: [], drafts: [] };
      active = { controller: { abort() {} }, scope, started: Date.now(), cli: true };
      // A conversation carried over from before the app started may hold conclusions about tools that have since
      // changed ("I can only do that at model level"). Say so once, on the first message after each start.
      if (!cliGreeted) {
        cliGreeted = true;
        notes.unshift(`The app has been restarted and its tools and rules may have changed. Anything said earlier in this conversation about what a tool allows or refuses, or about a tool not existing, may be out of date: do not repeat it from memory. Your tools now are: ${TOOL_NAMES.join(', ')}. Read their descriptions again before saying something cannot be done.`);
      }
      try { emit({ type: 'turn_start', scope, at: store.now() }); } catch { /* listener errors are theirs */ }
      return turnPreamble(scope, { notes: notes.splice(0) });
    },
    cliStop() {
      if (!active || !active.cli) return false;
      const scope = active.scope, ms = Date.now() - active.started;
      active = null; cliTurn = null;
      try { emit({ type: 'done', scope, text: '', ms, cost_usd: 0, num_turns: 0, usage: null, ok: true, at: store.now() }); } catch { /* theirs */ }
      return true;
    },
    async cliCall(name, args) {
      if (!cliTurn) this.cliPrompt();
      const { z } = await loadSdk();
      const handlers = createHandlers(svc, cliTurn);
      let found = null;
      sdkTools({ tool: (n, _d, _s, fn) => { if (n === name) found = fn; return null; } }, z, handlers);
      if (!found) return { content: [{ type: 'text', text: `There is no tool ${name}.` }], isError: true };
      return found(args || {});
    },
    cliSystemPrompt() { return systemPrompt({ modelDir }); },

    drafts() {
      return store.listDrafts(modelDir);
    },

    // The agreed design (design.json), or null when the model has none.
    design() {
      return require('./design').loadDesign(modelDir);
    },

    requests() {
      // `text` is the sentence the card opens with, so the window can draw a waiting card again after a reload
      return store.listRequests(modelDir).map(r => ({ ...publicRequest(r), scope: r.scope, at: r.at, text: r.kind === 'push' ? pushSentence(r) : signoff.requestSentence(r),
        ...(r.reviewer ? { reviewer: r.reviewer } : {}), ...(r.reason ? { reason: r.reason } : {}) }));
    },

    async acceptDraft(id) {
      const draft = store.loadDraft(modelDir, id);
      if (draft.status !== 'proposed') throw new Error(`Draft ${id} is already ${draft.status}.`);
      if (active) throw new Error('Wait for the agent to finish before accepting a draft.');
      let r;
      if (draft.kind === 'tiles') r = await edits.acceptTileDraft(svc, draft);
      else if (draft.kind === 'modules') r = await edits.acceptModuleDraft(svc, draft);
      else if (draft.kind === 'design') r = require('./design').acceptDesignDraft(svc, draft);
      else if (SCAFFOLD_KINDS.has(draft.kind)) {
        r = await scaffold.acceptScaffoldDraft(svc, draft);
        if (r.accepted) {
          const rb = await edits.rebuildTarget(svc, { kind: 'model' });
          if (rb.built.length || rb.failures.length) r.actions.push(rb.sentence);
        }
      } else if (draft.kind === 'tests') {
        r = await testsMod.acceptTestsDraft(svc, draft);
      } else if (draft.kind === 'module_test') {
        const [graph, casesDoc] = await Promise.all([tilekit('graph'), tilekit('cases').catch(() => ({ cases: [] }))]);
        const mod = graph.modules.find(m => m.id === draft.module);
        if (!mod) throw new Error(`There is no module ${draft.module} any more.`);
        const caseIds = (Array.isArray(casesDoc) ? casesDoc : (casesDoc.cases || [])).map(c => c.id);
        r = await testsMod.acceptModuleTestDraft(svc, draft, mod, { caseIds, months: graph.model && graph.model.months });
      } else if (draft.kind === 'what_if') {
        const it = draft.items[0];
        if (!it.code) throw new Error('This what-if changes parameters; it is for information only and cannot be applied from here.');
        const a = await edits.applyTileCode(svc, { name: it.name, code: it.code, testCode: null, approved: null });
        r = { accepted: a.ok, actions: a.ok ? a.actions : [...a.actions, a.declined ? 'The what-if was not applied.' : `The what-if was not applied: ${a.text.split('\n')[0]}`] };
      } else throw new Error(`Unknown draft kind ${draft.kind}.`);
      for (const t of r.actions) emitEvent(draft.scope, { type: 'action', text: t });
      const what = draft.summary.replace(/^Draft: |\.$/g, '');
      if (r.accepted) {
        draft.status = 'accepted';
        draft.accepted_at = store.now();
        store.saveDraft(modelDir, draft);
        notes.push(`The user accepted draft ${id} (${what}). ${r.actions.join(' ')}`);
      } else notes.push(`The user tried to accept draft ${id} (${what}) but it was not applied: ${r.actions.join(' ')}`);
      return { accepted: !!r.accepted, actions: r.actions, draft };
    },

    discardDraft(id) {
      const draft = store.loadDraft(modelDir, id);
      if (draft.status !== 'proposed') throw new Error(`Draft ${id} is already ${draft.status}.`);
      draft.status = 'discarded';
      draft.discarded_at = store.now();
      store.saveDraft(modelDir, draft);
      const what = draft.summary.replace(/^Draft: |\.$/g, '');
      emitEvent(draft.scope, { type: 'action', text: `Discarded the draft (${what}).` });
      notes.push(`The user discarded draft ${id} (${what}).`);
      return { discarded: true, draft };
    },

    // The reviewer's click on a sign-off request. Never reachable from the model's tools.
    async confirmSignoff(id, { reviewer, comment, valuesOnlyReason } = {}) {
      const req = store.loadRequest(modelDir, id);
      if (req.kind === 'push') throw new Error('That is a push request, not a sign-off request.');
      const scope = req.scope || { level: 'model', id: 'model' };
      const refuse = (error, expire) => {
        if (expire) { req.status = 'expired'; req.reason = error; store.saveRequest(modelDir, req); }
        emitEvent(scope, { type: 'error', text: error });
        doneEvent(scope, false);
        notes.push(`The reviewer tried to confirm the sign-off request for ${req.name}, but it was refused: ${error}`);
        return { signed: false, error, request: publicRequest(req) };
      };
      if (req.status !== 'pending') return refuse(`This sign-off request is already ${req.status}.`, false);
      if (active) return refuse('Wait for the agent to finish before signing off.', false);
      let r;
      try { r = await signoff.performRequest(tilekit, modelDir, req, { reviewer, comment, valuesOnlyReason }); }
      catch (e) { return refuse(`Not signed: ${String(e.message).replace(/\.$/, '')}.`, false); }
      if (!r.ok) return refuse(r.error, !!r.expired);
      req.status = 'confirmed';
      req.confirmed_at = store.now();
      req.reviewer = r.reviewer;
      if (comment) req.comment = String(comment);
      store.saveRequest(modelDir, req);
      emitEvent(scope, { type: 'action', text: r.text });
      doneEvent(scope, true);
      notes.push(`The reviewer confirmed with the button: ${r.text}`);
      return { signed: true, text: r.text, result: r.result, request: publicRequest(req) };
    },

    declineSignoff(id) {
      const req = store.loadRequest(modelDir, id);
      if (req.kind === 'push') throw new Error('That is a push request, not a sign-off request.');
      if (req.status !== 'pending') throw new Error(`This sign-off request is already ${req.status}.`);
      const scope = req.scope || { level: 'model', id: 'model' };
      req.status = 'declined';
      req.declined_at = store.now();
      store.saveRequest(modelDir, req);
      emitEvent(scope, { type: 'action', text: 'Not signed.' });
      doneEvent(scope, true);
      notes.push(`The reviewer declined the sign-off request for ${req.kind === 'reconfirm' ? 're-confirmation' : req.name}; nothing was signed.`);
      return { declined: true, request: publicRequest(req) };
    },

    // The user's click on a push request. Never reachable from the model's tools. Pushes the current branch to
    // origin (never forced), but only if the request is still what the user was shown.
    async confirmPush(id) {
      const req = store.loadRequest(modelDir, id);
      if (req.kind !== 'push') throw new Error('That is not a push request.');
      const scope = req.scope || { level: 'model', id: 'model' };
      const refuse = (error, expire) => {
        if (expire) { req.status = 'expired'; req.reason = error; store.saveRequest(modelDir, req); }
        emitEvent(scope, { type: 'error', text: error });
        doneEvent(scope, false);
        notes.push(`The user clicked Push but it was refused: ${error}`);
        return { pushed: false, error, request: publicPush(req) };
      };
      if (req.status !== 'pending') return refuse(`This push request is already ${req.status}.`, false);
      if (active) return refuse('Wait for the agent to finish before pushing.', false);
      let st;
      try { st = await (options.git || gitMod).status(modelDir); } catch (e) { return refuse(`Not pushed: ${e.message}`, false); }
      if (!st.isRepo || st.branch !== req.branch || st.remote !== req.remote) return refuse('Not pushed: the branch or remote changed since this was asked.', true);
      let r;
      try { r = await (options.git || gitMod).push(modelDir); } catch (e) { return refuse(`Not pushed: ${e.message}`, false); }
      req.status = 'confirmed';
      req.confirmed_at = store.now();
      store.saveRequest(modelDir, req);
      const text = `Pushed to ${r.remote}.`;
      emitEvent(scope, { type: 'action', text });
      doneEvent(scope, true);
      notes.push(`The user clicked Push: ${text}`);
      return { pushed: true, text, request: publicPush(req) };
    },

    declinePush(id) {
      const req = store.loadRequest(modelDir, id);
      if (req.kind !== 'push') throw new Error('That is not a push request.');
      if (req.status !== 'pending') throw new Error(`This push request is already ${req.status}.`);
      const scope = req.scope || { level: 'model', id: 'model' };
      req.status = 'declined';
      req.declined_at = store.now();
      store.saveRequest(modelDir, req);
      emitEvent(scope, { type: 'action', text: 'Not pushed.' });
      doneEvent(scope, true);
      notes.push('The user declined the push request; nothing was pushed.');
      return { declined: true, request: publicPush(req) };
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
        const r = await runTurn(tscope, `Implement ${name} from the spec in its docstring, with its hand-calculation test.`, { batchModule: moduleId });
        const status = await tilekit('status').catch(() => null);
        const entry = status && status.tiles[name];
        const done = entry && entry.state !== 'not_built' && r.writes.some(w => w.name === name && w.ok);
        if (done) {
          built.push(name);
          emitEvent(scope, { type: 'action', text: `Built ${name}: ${edits.caseResultsSentence(entry)}.` });
          continue;
        }
        const why = r.aborted ? 'it was stopped' : r.error ? r.error.replace(/\.$/, '') : 'it was not written';
        emitEvent(scope, { type: 'action', text: `Stopped at ${name}: ${why}.` });
        return { built, stoppedAt: name, reason: why };
      }
      return { built, stoppedAt: null };
    },

    // The tools exactly as the model gets them, for a selection (tests call handlers directly; no model).
    handlersFor(scopeIn, { batchModule = null } = {}) {
      const scope = store.checkScope(scopeIn);
      return createHandlers(svc, { scope, batchModule, approved: new Set(), writes: [], drafts: [] });
    },

    status() {
      return {
        busy: active ? [{ scope: active.scope, since: new Date(active.started).toISOString() }] : [],
        model: modelName, strongModel: STRONG_MODEL, signedIn, lastError,
        turns: totals.turns, cost_usd: Number(totals.cost_usd.toFixed(4)), last: totals.last,
      };
    },
  };
}

module.exports = { createAgentService, defaultPytest, tilekitPytest, readGuard, publicRequest, publicPush, DEFAULT_MODEL, STRONG_MODEL, NOT_SIGNED_IN };
