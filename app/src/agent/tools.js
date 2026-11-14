'use strict';
// The tiles tools: plain async handlers (testable without the SDK) and their SDK wrappers.
// Each handler returns {text, isError?}. Handlers refuse targets outside the turn's scope.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const edits = require('./edits');
const v = require('./validate');

const TRACE_MONTHS = 12;
const MAX_TRACE_ROWS = 120;
const MAX_TRACE_COLS = 12;

function defaultCase(modelDir, cases) {
  try {
    const m = fs.readFileSync(path.join(modelDir, 'tilekit.toml'), 'utf8').match(/^\s*default_case\s*=\s*"([^"]+)"/m);
    if (m && cases.some(c => c.id === m[1])) return m[1];
  } catch { /* fall through */ }
  return cases.length ? cases[0].id : null;
}

const r6 = x => (typeof x === 'number' ? Number(x.toPrecision(12)) : x);

/**
 * svc: {modelDir, tilekit, confirm, runPytest, emitEvent(scope, event), saveDraftEvent(draft)}
 * turn: {scope, batchModule, asked, approved: Set, writes: []}
 */
function createHandlers(svc, turn) {
  const tk = svc.tilekit;
  const scope = turn.scope;
  const action = text => svc.emitEvent(scope, { type: 'action', text });
  const refuse = text => { action(`Refused: ${text}`); return { text, isError: true }; };
  const waiting = () => (turn.asked ? { text: 'You have asked the user a question. End your turn now and wait for the answer.', isError: true } : null);

  async function inScopeTile(name, graph, purpose) {
    const q = graph.quantities[name];
    if (!q || q.kind !== 'tile') return `${name} is not a tile in the model.`;
    if (scope.level === 'tile') {
      if (name === scope.id) return null;
      if (turn.batchModule && q.module === turn.batchModule) return null;
      return `${name} is outside the selection (tile ${scope.id}). Ask the user to select ${name} to ${purpose} it.`;
    }
    if (scope.level === 'module') return q.module === scope.id ? null : `${name} is in module ${q.module}, outside the selected module ${scope.id}.`;
    return null;
  }

  return {
    async get_selection() {
      const [graph, status, casesDoc] = await Promise.all([tk('graph'), tk('status'), tk('cases')]);
      const cases = casesDoc.cases.map(c => ({ id: c.id, name: c.name, purpose: c.purpose, model_point: c.model_point, params: c.params, months: c.months }));
      const dc = defaultCase(svc.modelDir, cases);
      const brief = n => {
        const e = graph.quantities[n] || {};
        return { name: n, kind: e.kind, label: e.label, ...(e.module ? { module: e.module } : {}), ...(e.kind === 'param' ? { value: e.value } : {}), format: e.format };
      };
      let out;
      if (scope.level === 'tile') {
        const q = graph.quantities[scope.id];
        if (!q) return { text: `The selected tile ${scope.id} no longer exists.`, isError: true };
        const s = status.tiles[scope.id] || {};
        const trace = dc ? await tk('trace', ['--case', dc]) : null;
        const names = [...q.args, scope.id];
        out = {
          selected: { level: 'tile', name: scope.id, module: q.module },
          tile: { label: q.label, spec: q.spec, units: q.units, timing: q.timing, format: q.format, assumed: q.assumed, args: q.args,
            file: q.source.file, line: q.source.line, code: q.source.code, formula: q.formula, translatable: q.translatable, branches: q.branches },
          status: { state: s.state, drift: s.drift, signed_off: s.signed_off, case_results: s.case_results, rule_violations: s.rule_violations,
            uncovered_branches: s.uncovered_branches, blockers: s.blockers },
          inputs: q.args.map(brief),
          used_by: q.used_by.map(brief),
          downstream: v.downstream(graph, scope.id),
          hand_test: fs.existsSync(path.join(svc.modelDir, edits.testRel(scope.id))) ? edits.testRel(scope.id) : null,
          cases,
          trace: trace && {
            case: dc, months: `1-${TRACE_MONTHS}`,
            params: Object.fromEntries(q.args.filter(a => a in trace.params).map(a => [a, trace.params[a]])),
            series: Object.fromEntries(names.filter(n => trace.series[n]).map(n => [n, trace.series[n].slice(0, TRACE_MONTHS).map(r6)])),
            summary: Object.fromEntries(names.filter(n => n in trace.summary).map(n => [n, r6(trace.summary[n])])),
            branches: trace.branches[scope.id] || null,
          },
        };
        action(`Read ${scope.id}, its neighbours and the ${dc} trace.`);
      } else if (scope.level === 'module') {
        const m = graph.modules.find(x => x.id === scope.id);
        if (!m) return { text: `The selected module ${scope.id} does not exist.`, isError: true };
        out = {
          selected: { level: 'module', id: m.id, title: m.title, layer: m.layer, timing: m.timing },
          file: m.tiles.length ? graph.quantities[m.tiles[0]].source.file : null,
          status: status.modules[m.id] || null,
          tiles: m.tiles.map(t => {
            const q = graph.quantities[t];
            const s = status.tiles[t] || {};
            return { name: t, label: q.label, spec: q.spec, args: q.args, units: q.units, timing: q.timing, format: q.format,
              assumed: q.assumed, expression: q.expression, state: s.state };
          }),
          inputs: m.inputs.map(brief),
          feeds: m.feeds, fed_by: m.fed_by,
          other_quantities: Object.keys(graph.quantities).filter(n => !m.tiles.includes(n)).map(brief),
          cases,
        };
        action(`Read module ${m.id} and its tiles.`);
      } else {
        out = {
          selected: { level: 'model', name: graph.model.name, months: graph.model.months },
          layers: graph.layers,
          modules: graph.modules.map(m => ({ id: m.id, title: m.title, layer: m.layer, timing: m.timing, tiles: m.tiles, feeds: m.feeds, fed_by: m.fed_by,
            state: status.modules[m.id] && status.modules[m.id].state })),
          parameters: Object.keys(graph.quantities).filter(n => graph.quantities[n].kind === 'param').map(brief),
          inputs: Object.keys(graph.quantities).filter(n => graph.quantities[n].kind === 'input').map(brief),
          states: Object.entries(graph.quantities).filter(([, e]) => e.kind === 'state').map(([n, e]) => ({ name: n, label: e.label, from: e.from })),
          status: status.model,
          cases,
        };
        action('Read the model structure.');
      }
      return { text: JSON.stringify(out) };
    },

    async read_trace({ case: caseId, quantities, from_month, to_month }) {
      const graph = await tk('graph');
      const unknown = quantities.filter(n => !graph.quantities[n]);
      if (unknown.length) return { text: `Unknown quantities: ${unknown.join(', ')}.`, isError: true };
      if (quantities.length > MAX_TRACE_COLS) return { text: `Ask for at most ${MAX_TRACE_COLS} quantities at a time.`, isError: true };
      let trace;
      try { trace = await tk('trace', ['--case', caseId]); } catch (e) { return { text: e.message, isError: true }; }
      const a = Math.max(1, from_month || 1);
      const b = Math.min(trace.months, to_month || trace.months, a + MAX_TRACE_ROWS - 1);
      const series = quantities.filter(n => trace.series[n]);
      const rows = ['month\t' + series.join('\t')];
      for (let m = a; m <= b; m++) rows.push(m + '\t' + series.map(n => r6(trace.series[n][m - 1])).join('\t'));
      const extra = [];
      const params = quantities.filter(n => n in trace.params);
      if (params.length) extra.push('parameters: ' + params.map(n => `${n}=${trace.params[n]}`).join(', '));
      const summ = quantities.filter(n => n in trace.summary);
      if (summ.length) extra.push('summary: ' + summ.map(n => `${n}=${r6(trace.summary[n])}`).join(', '));
      const br = quantities.filter(n => trace.branches[n]);
      if (br.length) extra.push('branches (months taken): ' + br.map(n => `${n} ${JSON.stringify(trace.branches[n])}`).join('; '));
      action(`Read the ${caseId} trace for ${quantities.join(', ')}, months ${a} to ${b}.`);
      return { text: `case ${caseId}, ${trace.months} months\n${series.length ? rows.join('\n') : ''}${extra.length ? '\n' + extra.join('\n') : ''}` };
    },

    async propose_structure({ summary, modules, tiles }) {
      const w = waiting(); if (w) return w;
      const graph = await tk('graph');
      let kind, items, check, line;
      if (scope.level === 'model') {
        if (tiles && tiles.length) return refuse('tiles are proposed at module level; select the module.');
        kind = 'modules'; items = modules || [];
        check = v.validateModuleDraft(graph, items);
        if (!check.problems.length) line = v.moduleDraftSummary(graph, items);
      } else if (scope.level === 'module') {
        if (modules && modules.length) return refuse('modules are proposed at model level; select the model.');
        kind = 'tiles'; items = (tiles || []).map(t => ({ ...t, assumed: t.assumed || [] }));
        check = v.validateTileDraft(graph, scope.id, items);
        if (!check.problems.length) line = v.tileDraftSummary(graph, items);
      } else {
        return refuse('at tile level the tile is written directly with write_tile, not proposed.');
      }
      if (check.problems.length) {
        action(`The draft was not valid (${v.count(check.problems.length, 'problem')}); nothing was saved.`);
        return { text: 'The draft was not saved. Problems:\n' + check.problems.map(p => '- ' + p).join('\n') +
          (check.warnings.length ? '\nWarnings:\n' + check.warnings.map(p => '- ' + p).join('\n') : ''), isError: true };
      }
      const draft = { id: store.newDraftId(), scope, kind, summary: `Draft: ${line}.`, note: summary, items, warnings: check.warnings, at: store.now(), status: 'proposed' };
      svc.saveDraftEvent(draft);
      turn.drafts.push(draft.id);
      return { text: `Saved as draft ${draft.id} (${line}). The user accepts or discards it in the app; nothing is written until then.` +
        (check.warnings.length ? '\nWarnings:\n' + check.warnings.map(p => '- ' + p).join('\n') : '') };
    },

    async write_tile({ name, code, test_code }) {
      const w = waiting(); if (w) return w;
      if (scope.level !== 'tile') return refuse(`tiles are written at tile level; select ${name} first.`);
      const graph = await tk('graph');
      const bad = await inScopeTile(name, graph, 'change');
      if (bad) return refuse(bad);
      const r = await edits.applyTileCode(svc, { name, code, testCode: test_code, approved: turn.approved });
      r.actions.forEach(action);
      turn.writes.push({ name, ok: r.ok, declined: !!r.declined, changed: r.changed });
      return { text: r.text, isError: !r.ok && !r.declined };
    },

    async what_if({ name, code, params }) {
      const w = waiting(); if (w) return w;
      const graph = await tk('graph');
      if (name) { const bad = await inScopeTile(name, graph, 'try a change to'); if (bad) return refuse(bad); }
      else if (code) return { text: 'Name the tile the code replaces.', isError: true };
      const r = await edits.whatIf(svc, { name, code, params });
      if (!r.ok) return { text: r.text, isError: true };
      action(`Ran a what-if${name ? ` on ${name}` : ''}${params && Object.keys(params).length ? ` with ${Object.entries(params).map(([k, x]) => `${k}=${x}`).join(', ')}` : ''} in a copy of the model.`);
      const draft = { id: store.newDraftId(), scope, kind: 'what_if', summary: `What if: ${r.summary}. Nothing has been applied.`,
        items: [{ name: name || null, code: code || null, params: params || null }], result: r.result, at: store.now(), status: 'proposed' };
      svc.saveDraftEvent(draft);
      turn.drafts.push(draft.id);
      return { text: `Draft ${draft.id}; nothing in the real model changed. ${draft.items[0].code ? 'The user can apply it from the app.' : 'Parameter what-ifs are for information only; they cannot be applied from the agent.'}\n${r.text}` };
    },

    async ask_user({ question, options }) {
      const w = waiting(); if (w) return w;
      turn.asked = true;
      svc.emitEvent(scope, { type: 'question', text: question, ...(options && options.length ? { options } : {}) });
      return { text: 'The question is shown to the user. End your turn now with no further text; their next message is the answer.' };
    },

    async add_input_request({ description, kind }) {
      const w = waiting(); if (w) return w;
      turn.asked = true;
      const d = String(description).trim().replace(/\.$/, '');
      svc.emitEvent(scope, { type: 'question', text: `This needs a new ${kind || 'input'}: ${d}. Add it?`, request: { kind: kind || 'input', description: d } });
      return { text: 'The request is shown to the user. Nothing was created. End your turn now with no further text.' };
    },
  };
}

// ---------------------------------------------------------------- SDK wrappers

const DESCRIPTIONS = {
  get_selection: 'What is selected: its graph entry, source, review status, neighbours, the cases, and for a tile the values of its inputs and output for the default case, months 1 to 12. Call it at the start of a conversation and after changes.',
  read_trace: 'Values of up to 12 quantities for one case over a range of months (default all months, at most 120 rows), plus parameter values, summary values and branch counts. Use it to explain numbers.',
  propose_structure: 'Propose a draft. At model level pass `modules` (id, title, layer, purpose, feeds). At module level pass `tiles` (name, label, args, units, timing, format, spec, assumed). The draft is validated and saved for the user to accept or discard; nothing is written until they accept. Problems are returned for you to fix.',
  write_tile: 'Tile level only. Replace the selected tile with `code` (the whole function: def line, full docstring, body) and write `test_code` (the complete hand-calculation test file tests/tiles/test_<name>.py). Checks the rules (restoring the old code on errors), rebuilds the tile workbook, runs the test, and returns the differences per case and uncovered branches. Asks the human first if sign-offs would go stale.',
  what_if: 'Show the effect of a change without applying it: replace tile `name` with `code` and/or override parameter values in every case, on a copy of the model. Returns the change in the tile and in the model\'s final outputs per case, and saves a draft the user can apply (code changes only) or discard.',
  ask_user: 'Ask the user one question (an actuarial choice you must not guess). Ends your turn; the next user message is the answer. Optional short answer options.',
  add_input_request: 'Record that the work needs something that does not exist (a parameter, input series, state or a tile in another module), shown to the user as a question. Never creates it. Ends your turn.',
};

function sdkTools(sdk, z, handlers, scope) {
  const run = (name, fn) => async args => {
    try {
      const r = await fn(args || {});
      return { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) };
    } catch (e) {
      return { content: [{ type: 'text', text: `${name} failed: ${e && e.message || e}` }], isError: true };
    }
  };
  const extras = { alwaysLoad: true };
  const tileItem = z.object({
    name: z.string(), label: z.string(), args: z.array(z.string()), units: z.string(), timing: z.string(),
    format: z.enum(['amount', 'units', 'percent', 'rate', 'irr', 'number', 'small', 'integer']), spec: z.string(),
    assumed: z.array(z.string()).optional(),
  });
  const moduleItem = z.object({ id: z.string(), title: z.string(), layer: z.string(), purpose: z.string(), feeds: z.array(z.string()) });
  const defs = [
    sdk.tool('get_selection', DESCRIPTIONS.get_selection, {}, run('get_selection', handlers.get_selection), extras),
    sdk.tool('read_trace', DESCRIPTIONS.read_trace, {
      case: z.string().describe('case id'), quantities: z.array(z.string()).describe('quantity names'),
      from_month: z.number().int().optional(), to_month: z.number().int().optional(),
    }, run('read_trace', handlers.read_trace), extras),
    sdk.tool('what_if', DESCRIPTIONS.what_if, {
      name: z.string().optional().describe('tile to replace'), code: z.string().optional().describe('the whole replacement function'),
      params: z.record(z.string(), z.number()).optional().describe('parameter overrides applied to every case'),
    }, run('what_if', handlers.what_if), extras),
    sdk.tool('ask_user', DESCRIPTIONS.ask_user, { question: z.string(), options: z.array(z.string()).optional() }, run('ask_user', handlers.ask_user), extras),
    sdk.tool('add_input_request', DESCRIPTIONS.add_input_request, {
      description: z.string().describe('what is needed and why, in one sentence'),
      kind: z.enum(['parameter', 'input', 'state', 'tile']).optional(),
    }, run('add_input_request', handlers.add_input_request), extras),
  ];
  if (scope.level === 'tile') {
    defs.push(sdk.tool('write_tile', DESCRIPTIONS.write_tile, { name: z.string(), code: z.string(), test_code: z.string() },
      run('write_tile', handlers.write_tile), extras));
  } else {
    defs.push(sdk.tool('propose_structure', DESCRIPTIONS.propose_structure, {
      summary: z.string().describe('one sentence on what the draft does'),
      modules: z.array(moduleItem).optional(), tiles: z.array(tileItem).optional(),
    }, run('propose_structure', handlers.propose_structure), extras));
  }
  return defs;
}

module.exports = { createHandlers, sdkTools, defaultCase };
