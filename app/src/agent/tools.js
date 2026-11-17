'use strict';
const testsMod = require('./tests');
// The tiles tools: plain async handlers (testable without the SDK) and their SDK wrappers.
// Each handler returns {text, isError?}. Handlers refuse targets outside the turn's scope.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const edits = require('./edits');
const v = require('./validate');
const src = require('./source');
const scaffold = require('./scaffold');
const signoff = require('./signoff');
const design = require('./design');

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
 * svc: {modelDir, tilekit, confirm, runPytest, emitEvent(scope, event), saveDraftEvent(draft),
 *       saveRequestEvent(request)}. `tilekit` here refuses signoff and reconfirm.
 * turn: {scope, batchModule, approved: Set, writes: [], drafts: []}
 */
function createHandlers(svc, turn) {
  const tk = svc.tilekit;
  const scope = turn.scope;
  const action = text => svc.emitEvent(scope, { type: 'action', text });
  const refuse = text => { action(`Refused: ${text}`); return { text, isError: true }; };

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

  // Is target ({kind, name}) the selection or beneath it? Returns null or the reason it is not.
  function beneath(target, graph) {
    if (target.kind === 'model') return scope.level === 'model' ? null : 'the model is above the selection; select the whole model first.';
    if (target.kind === 'module') {
      if (!graph.modules.some(m => m.id === target.name)) return `${target.name} is not a module in the model.`;
      if (scope.level === 'model' || (scope.level === 'module' && scope.id === target.name)) return null;
      return `module ${target.name} is not the selection or beneath it; select ${scope.level === 'tile' ? 'the module' : target.name} first.`;
    }
    const q = graph.quantities[target.name];
    if (!q || q.kind !== 'tile') return `${target.name} is not a tile in the model.`;
    if (scope.level === 'model') return null;
    if (scope.level === 'module') return q.module === scope.id ? null : `${target.name} is in module ${q.module}, not in the selected module ${scope.id}.`;
    return target.name === scope.id ? null : `${target.name} is not the selected tile (${scope.id}); ask the user to select it.`;
  }

  function draftSaved(kind, line, items, check, extra = {}) {
    const draft = { id: store.newDraftId(), scope, kind, summary: `Draft: ${line}.`, items, warnings: check.warnings, at: store.now(), status: 'proposed', ...extra };
    svc.saveDraftEvent(draft);
    turn.drafts.push(draft.id);
    return { text: `Saved as draft ${draft.id} (${line}). The user accepts or discards it in the app; nothing is written until then.` +
      (check.warnings.length ? '\nWarnings:\n' + check.warnings.map(p => '- ' + p).join('\n') : '') };
  }

  function invalid(check) {
    action(`The draft was not valid (${v.count(check.problems.length, 'problem')}); nothing was saved. ${check.problems.map(x => String(x).split('. ')[0]).join('; ').slice(0, 600)}`);
    return { text: 'The draft was not saved. Problems:\n' + check.problems.map(p => '- ' + p).join('\n') +
      (check.warnings.length ? '\nWarnings:\n' + check.warnings.map(p => '- ' + p).join('\n') : ''), isError: true };
  }

  const handlers = {
    async get_selection({ tile, module } = {}) {
      const [graph, status, casesDoc] = await Promise.all([tk('graph'), tk('status'), tk('cases')]);
      if (tile && module) return { text: 'Name a tile or a module, not both.', isError: true };
      if (tile && !(graph.quantities[tile] && graph.quantities[tile].kind === 'tile')) return { text: `${tile} is not a tile in the model.`, isError: true };
      if (module && !graph.modules.some(m => m.id === module)) return { text: `${module} is not a module in the model.`, isError: true };
      const view = tile ? { level: 'tile', id: tile } : module ? { level: 'module', id: module } : scope;
      const cases = casesDoc.cases.map(c => ({ id: c.id, name: c.name, purpose: c.purpose, model_point: c.model_point, params: c.params, months: c.months }));
      const dc = defaultCase(svc.modelDir, cases);
      const brief = n => {
        const e = graph.quantities[n] || {};
        return { name: n, kind: e.kind, label: e.label, ...(e.module ? { module: e.module } : {}), ...(e.kind === 'param' ? { value: e.value } : {}), format: e.format };
      };
      let out;
      if (view.level === 'tile') {
        const q = graph.quantities[view.id];
        if (!q) return { text: `The selected tile ${view.id} no longer exists.`, isError: true };
        const s = status.tiles[view.id] || {};
        const trace = dc ? await tk('trace', ['--case', dc]) : null;
        const names = [...q.args, view.id];
        out = {
          item: { level: 'tile', name: view.id, module: q.module },
          selection: view === scope ? 'this is the selection' : `read only: the user has selected ${scope.level === 'model' ? 'the whole model' : `${scope.level} ${scope.id}`}`,
          tile: { label: q.label, spec: q.spec, units: q.units, timing: q.timing, format: q.format, assumed: q.assumed, args: q.args,
            file: q.source.file, line: q.source.line, code: q.source.code, formula: q.formula, translatable: q.translatable, branches: q.branches },
          status: { state: s.state, drift: s.drift, signed_off: s.signed_off, case_results: s.case_results, rule_violations: s.rule_violations,
            uncovered_branches: s.uncovered_branches, blockers: s.blockers },
          inputs: q.args.map(brief),
          used_by: q.used_by.map(brief),
          downstream: v.downstream(graph, view.id),
          hand_test: fs.existsSync(path.join(svc.modelDir, edits.testRel(view.id))) ? edits.testRel(view.id) : null,
          cases,
          trace: trace && {
            case: dc, months: `1-${TRACE_MONTHS}`,
            params: Object.fromEntries(q.args.filter(a => a in trace.params).map(a => [a, trace.params[a]])),
            series: Object.fromEntries(names.filter(n => trace.series[n]).map(n => [n, trace.series[n].slice(0, TRACE_MONTHS).map(r6)])),
            summary: Object.fromEntries(names.filter(n => n in trace.summary).map(n => [n, r6(trace.summary[n])])),
            branches: trace.branches[view.id] || null,
          },
        };
        action(`Read ${view.id}, its neighbours and the ${dc} trace.`);
      } else if (view.level === 'module') {
        const m = graph.modules.find(x => x.id === view.id);
        if (!m) return { text: `The selected module ${view.id} does not exist.`, isError: true };
        out = {
          item: { level: 'module', id: m.id, title: m.title, layer: m.layer, timing: m.timing },
          selection: view === scope ? 'this is the selection' : `read only: the user has selected ${scope.level === 'model' ? 'the whole model' : `${scope.level} ${scope.id}`}`,
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
          // the layout of the module sheet and its reconciliation checks (absent from tooling that does not report them)
          sections: Array.isArray(m.sections) ? m.sections : null,
          reconciliation_checks: Array.isArray(m.checks) ? m.checks : null,
          module_test: fs.existsSync(path.join(svc.modelDir, testsMod.moduleTestRel(m.id))) ? testsMod.moduleTestRel(m.id) : null,
          other_quantities: Object.keys(graph.quantities).filter(n => !m.tiles.includes(n)).map(brief),
          cases,
        };
        action(`Read module ${m.id} and its tiles.`);
      } else {
        out = {
          item: { level: 'model', name: graph.model.name, months: graph.model.months },
          selection: 'this is the selection',
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

    async model_overview() {
      const [graph, status, casesDoc] = await Promise.all([tk('graph'), tk('status'), tk('cases')]);
      const short = list => (list || []).slice(0, 3);
      const out = {
        model: { name: graph.model.name, state: status.model.state, drift: status.model.drift, blockers: short(status.model.blockers),
          signed_off: status.model.signed_off },
        counts: status.counts,
        layers: graph.layers,
        modules: graph.modules.map(m => {
          const ms = status.modules[m.id] || {};
          return {
            id: m.id, title: m.title, layer: m.layer, state: ms.state || (m.tiles.length ? null : 'empty'), drift: ms.drift || null,
            signed_off: ms.signed_off || null, blockers: short(ms.blockers),
            tiles: m.tiles.map(t => {
              const ts = status.tiles[t] || {};
              return { name: t, label: graph.quantities[t].label, state: ts.state, drift: ts.drift || null,
                ...(ts.state !== 'signed_off' && (ts.blockers || []).length ? { blockers: short(ts.blockers) } : {}),
                ...(ts.signed_off ? { signed_off_by: ts.signed_off.reviewer } : {}) };
            }),
          };
        }),
        cases: casesDoc.cases.map(c => ({ id: c.id, name: c.name, purpose: c.purpose })),
        pending_signoff_requests: store.listRequests(svc.modelDir).filter(r => r.status === 'pending' && r.kind !== 'push').map(r => ({ id: r.id, kind: r.kind, name: r.name })),
      };
      action('Read the review status of the whole model.');
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

    async propose_structure({ summary, modules, tiles, module, states, remove, sections, checks }) {
      const graph = await tk('graph');
      if (modules && modules.length && tiles && tiles.length) return refuse('propose modules and tiles in separate drafts.');
      if (modules && modules.length) {
        if ((sections && sections.length) || (checks && checks.length)) return { text: 'Sections and reconciliation checks belong to a module\'s tiles draft: propose them with the tiles, naming the module.', isError: true };
        if (scope.level !== 'model') return refuse('modules are proposed at model level; select the whole model.');
        const check = v.validateModuleDraft(graph, modules);
        if (check.problems.length) return invalid(check);
        check.warnings.push(...design.moduleDepartures(design.loadDesign(svc.modelDir), modules));
        return draftSaved('modules', v.moduleDraftSummary(graph, modules), modules, check, { note: summary });
      }
      // A tiles draft may come from a selected tile, for that tile's own module: the draft still needs the user's Accept.
      const ownModule = scope.level === 'tile' && graph.quantities[scope.id] ? graph.quantities[scope.id].module : null;
      if (scope.level === 'tile' && !(ownModule && (!module || module === ownModule))) {
        return refuse(`from a tile, tiles are proposed or removed in its own module (${ownModule}) only.`);
      }
      const target = scope.level === 'tile' ? ownModule : scope.level === 'module' ? (module || scope.id) : module;
      if (!target) return { text: 'Name the module the tiles belong to (module).', isError: true };
      if (scope.level === 'module' && target !== scope.id) return refuse(`tiles for ${target} are proposed with that module or the whole model selected.`);
      if (!graph.modules.some(m => m.id === target)) return { text: `${target} is not a module in the model; propose the module first.`, isError: true };
      // A tile sent exactly as it already is changes nothing, so it is left out of the draft. Otherwise accepting the
      // draft would write its placeholder again and a built (even signed-off) tile would go back to not built.
      const same = t => v.sameTile(graph.quantities[t.name], t, target);
      const sent = (tiles || []).map(t => ({ ...t, assumed: t.assumed || [] }));
      const items = sent.filter(t => !same(t));
      const unchanged = sent.length - items.length;
      const sts = (states || []).map(x => ({ name: x.name, from: x.from, initial: x.initial, label: x.label, format: x.format }));
      const gone = [...new Set((remove || []).map(String))];
      // sections and reconciliation checks for the module; given (even empty) they replace the module's own
      const secs = Array.isArray(sections) ? sections.map(s => ({ title: s && typeof s.title === 'string' ? s.title.trim() : s && s.title, tiles: (s && Array.isArray(s.tiles) ? s.tiles : []).map(String) })) : undefined;
      const chks = Array.isArray(checks) ? checks.map(c => ({ name: c && c.name, label: c && typeof c.label === 'string' ? c.label.trim() : c && c.label, expression: c && typeof c.expression === 'string' ? c.expression.replace(/\s+/g, ' ').trim() : c && c.expression })) : undefined;
      const check = v.validateTileDraft(graph, target, items, sts, gone, { layoutOnly: !!(secs || chks) });
      if (unchanged) check.warnings.push(`${v.count(unchanged, 'tile')} sent exactly as ${unchanged === 1 ? 'it already is' : 'they already are'}: left out of the draft, so ${unchanged === 1 ? 'it stays' : 'they stay'} built as ${unchanged === 1 ? 'it is' : 'they are'}.`);
      const layout = v.validateLayout(graph, target, items, sts, gone, secs, chks, { rules: true });
      check.problems.push(...layout.problems); check.warnings.push(...layout.warnings);
      if (check.problems.length) return invalid(check);
      check.warnings.push(...design.tileDepartures(design.loadDesign(svc.modelDir), target, items));
      const parts = [items.length ? v.tileDraftSummary(graph, items) : '', gone.length ? `removes ${v.count(gone.length, 'tile')} (${gone.join(', ')})` : ''].filter(Boolean);
      const lay = v.layoutSummary(secs, chks);
      const line = parts.length
        ? `${parts.join(' and ')}${scope.level !== 'module' ? ` in ${target}` : ''}${sts.length ? ` and ${v.count(sts.length, 'carried-forward state')}` : ''}${lay ? ' ' + lay : ''}`
        : `lays out ${target}${lay ? ' ' + lay : ''}; no tile changes`;
      const removing = gone.map(n => ({ name: n, label: (graph.quantities[n] || {}).label || '' }));
      const mod = graph.modules.find(m => m.id === target) || {};
      const replaces = {
        ...(secs && (mod.sections || []).some(s => s && s.title) ? { sections: (mod.sections || []).filter(s => s && s.title).map(s => s.title) } : {}),
        ...(chks && (mod.checks || []).length ? { checks: mod.checks.map(c => c.label || c.name) } : {}),
      };
      // which tiles were new when the draft was proposed and which were changes to tiles the model had: accepting
      // the draft later refuses to put a placeholder over a tile that has been added (and perhaps built) since
      const newTiles = items.filter(t => !graph.quantities[t.name]).map(t => t.name);
      const changedTiles = items.filter(t => graph.quantities[t.name]).map(t => t.name);
      return draftSaved('tiles', line, items, check, { note: summary, module: target, new_tiles: newTiles, changed_tiles: changedTiles, ...(sts.length ? { states: sts } : {}), ...(removing.length ? { remove: removing } : {}),
        ...(secs ? { sections: secs } : {}), ...(chks ? { checks: chks } : {}), ...(Object.keys(replaces).length ? { replaces } : {}) });
    },

    // The design stage: the whole model laid out for the user to agree before anything is built. Accepting it writes
    // design.json only.
    async propose_design(args = {}) {
      if (scope.level !== 'model') return refuse('the design is proposed at model level; select the whole model.');
      const [graph, casesDoc] = await Promise.all([tk('graph'), tk('cases').catch(() => ({ cases: [] }))]);
      const caseIds = (Array.isArray(casesDoc) ? casesDoc : (casesDoc.cases || [])).map(c => c.id);
      const d = design.normalise(args);
      const check = design.validateDesign(graph, d, caseIds);
      if (check.problems.length) return invalid(check);
      const had = !!design.loadDesign(svc.modelDir);
      return draftSaved('design', design.designSummary(d) + (had ? ', replacing the agreed design' : ''), d.modules.map(m => ({ id: m.id, title: m.title })), check, { note: d.summary, design: d });
    },

    // The module's own hand-worked test (tests/modules/test_<module>.py), as a draft: the whole file when there is
    // none yet, or test functions added to it. Nothing is written until the user accepts; then it is run, and nothing
    // is saved if a check fails.
    async propose_module_test({ summary, module, code, tests }) {
      const graph = await tk('graph');
      const own = scope.level === 'tile' ? (graph.quantities[scope.id] || {}).module : scope.level === 'module' ? scope.id : null;
      const target = module || own;
      if (!target) return { text: 'Name the module the test is for (module).', isError: true };
      if (scope.level !== 'model' && target !== own) return refuse(`the module test for ${target} is proposed with that module, one of its tiles or the whole model selected.`);
      const mod = graph.modules.find(m => m.id === target);
      if (!mod) return { text: `${target} is not a module in the model.`, isError: true };
      const rel = testsMod.moduleTestRel(target);
      let existing = null;
      try { existing = fs.readFileSync(path.join(svc.modelDir, rel), 'utf8'); } catch { /* none yet */ }
      const cases = await tk('cases').catch(() => ({ cases: [] }));
      const ids = (Array.isArray(cases) ? cases : (cases.cases || [])).map(c => c.id);
      const items = (tests || []).map(t => ({ name: t && t.name, kind: (t && t.kind) || '', code: String((t && t.code) || '') }));
      const check = testsMod.validateModuleTest(mod, { code, items, existing, caseIds: ids, months: graph.model && graph.model.months });
      if (check.problems.length) return invalid(check);
      const whole = existing === null;
      const names = whole ? testsMod.testNames(code) : items.map(i => i.name);
      return draftSaved('module_test', whole ? `writes the module test for ${target} (${v.count(names.length, 'test')})` : `adds ${v.count(items.length, 'test')} to the module test for ${target}`,
        whole ? names.map(n => ({ name: n })) : items, check, { note: summary, module: target, file: rel, ...(whole ? { code: String(code).replace(/\r\n?/g, '\n').replace(/\s+$/, '') + '\n' } : {}) });
    },

    async propose_params({ summary, params }) {
      const graph = await tk('graph');
      const items = (params || []).map(p => ({ name: p.name, default: p.default, label: p.label, format: p.format, units: p.units }));
      const check = scaffold.validateParams(graph, items);
      if (check.problems.length) return invalid(check);
      return draftSaved('params', scaffold.paramsSummary(graph, items), items, check, { note: summary });
    },

    async propose_inputs({ summary, model_point_fields, inputs, tables }) {
      const graph = await tk('graph');
      const draft = { model_point_fields: model_point_fields || [], inputs: inputs || [], tables: tables || [] };
      const check = scaffold.validateInputs(graph, svc.modelDir, draft);
      if (check.problems.length) return invalid(check);
      return draftSaved('inputs', scaffold.inputsSummary(draft), scaffold.inputsItems(draft), check, { note: summary });
    },

    async propose_cases({ summary, cases }) {
      const graph = await tk('graph');
      const items = (cases || []).map(c => ({ id: c.id, name: c.name, purpose: c.purpose, model_point: c.model_point || {}, params: c.params || {}, ...(c.months ? { months: c.months } : {}) }));
      const check = scaffold.validateCases(graph, svc.modelDir, items);
      if (check.problems.length) return invalid(check);
      return draftSaved('cases', scaffold.casesSummary(svc.modelDir, items), items, check, { note: summary });
    },

    async request_signoff({ kind, name }) {
      const graph = await tk('graph');
      const target = { kind, name: kind === 'model' ? graph.model.name : name };
      if (kind !== 'model' && !name) return { text: 'Name the tile or module to sign off.', isError: true };
      const bad = beneath(target, graph);
      if (bad) return refuse(bad);
      let req;
      try { req = await signoff.prepareSignoff(tk, svc.modelDir, scope, target); } catch (e) { return { text: e.message, isError: true }; }
      svc.saveRequestEvent(req);
      const what = kind === 'model' ? 'the model' : `${kind} ${req.name}`;
      return { text: `The sign-off request for ${what} is now shown to the reviewer with a Confirm button. It is not signed off: only the reviewer's click records a sign-off, and you must not say it is signed off. ` +
        (req.blockers.length
          ? `It cannot be signed off yet; confirming will be refused until these are fixed:\n${req.blockers.map(b => '- ' + b).join('\n')}\nTell the reviewer what blocks it.`
          : `Tell the reviewer to confirm with the button${req.values_only ? ', giving the reason for the values-only acknowledgement,' : ''} if they are happy.`) };
    },

    async request_reconfirm({ module } = {}) {
      if (scope.level === 'tile') return refuse('re-confirmation is requested with a module or the whole model selected.');
      if (scope.level === 'module' && module && module !== scope.id) return refuse(`module ${module} is not the selection; select it or the whole model.`);
      const moduleId = scope.level === 'module' ? scope.id : (module || null);
      let req;
      try { req = await signoff.prepareReconfirm(tk, svc.modelDir, scope, moduleId); } catch (e) { return { text: e.message, isError: true }; }
      svc.saveRequestEvent(req);
      return { text: req.tiles.length
        ? `A re-confirmation request for ${v.count(req.tiles.length, 'tile')} (${req.tiles.map(t => t.name).join(', ')}) is now shown to the reviewer with a Confirm button. Nothing is re-confirmed until they click it; do not say it is done.` +
          (req.skipped.length ? `\nNot included: ${req.skipped.map(x => `${x.name} (${x.reason})`).join('; ')}.` : '')
        : `There is nothing to re-confirm.${req.skipped.length ? ' Not eligible: ' + req.skipped.map(x => `${x.name} (${x.reason})`).join('; ') + '.' : ''} The request shown to the reviewer says so.` };
    },

    async rebuild({ kind, name } = {}) {
      const graph = await tk('graph');
      const target = kind ? { kind, name: kind === 'model' ? graph.model.name : name }
        : scope.level === 'model' ? { kind: 'model', name: graph.model.name } : { kind: scope.level, name: scope.id };
      if (target.kind !== 'model' && !target.name) return { text: 'Name the tile or module to rebuild.', isError: true };
      const bad = beneath(target, graph);
      if (bad) return refuse(bad);
      const r = await edits.rebuildTarget(svc, target);
      action(r.sentence);
      return { text: r.sentence, isError: !!r.error };
    },

    async write_tile({ name, code, test_code }) {
      if (scope.level !== 'tile') return refuse(`tiles are written at tile level; select ${name} first.`);
      const graph = await tk('graph');
      const bad = await inScopeTile(name, graph, 'change');
      if (bad) return refuse(bad);
      const twoSteps = src.chooseConvertProblems(src.normaliseCode(code || ''));
      if (twoSteps.length) { action(`The tile was not written: ${name} both chooses and converts a rate; it is two tiles.`); return { text: 'Not written. ' + twoSteps.join(' '), isError: true }; }
      if (test_code) {
        const cases = await tk('cases').catch(() => ({ cases: [] }));
        const ids = (Array.isArray(cases) ? cases : (cases.cases || [])).map(c => c.id);
        const pr = testsMod.caseCheckProblems(test_code, ids, graph.model && graph.model.months);
        if (pr.length) { action('The tile was not written: its test has no check on a case of the model.'); return { text: 'Not written. ' + pr.join(' '), isError: true }; }
      }
      const r = await edits.applyTileCode(svc, { name, code, testCode: test_code, approved: turn.approved });
      r.actions.forEach(action);
      turn.writes.push({ name, ok: r.ok, declined: !!r.declined, changed: r.changed });
      return { text: r.text, isError: !r.ok && !r.declined };
    },

    // Deleting tiles has a tool of its own so it is easy to find; it is a tiles draft with only removals.
    async remove_tiles({ tiles, module, summary }) {
      if (!Array.isArray(tiles) || !tiles.length) return { text: 'Name the tiles to remove.', isError: true };
      return handlers.propose_structure({ summary: summary || `Removes ${tiles.join(', ')}.`, module, remove: tiles });
    },

    // More hand-calculation tests for a built tile, as a draft: nothing is added to the test file until the user accepts.
    async propose_tests({ summary, tile, tests }) {
      const graph = await tk('graph');
      const name = tile || (scope.level === 'tile' ? scope.id : null);
      if (!name) return { text: 'Name the tile the tests are for (tile).', isError: true };
      const bad = await inScopeTile(name, graph, 'add tests to');
      if (bad) return refuse(bad);
      let existing = null;
      try { existing = fs.readFileSync(path.join(svc.modelDir, testsMod.testRel(name)), 'utf8'); } catch { /* none */ }
      const items = (tests || []).map(t => ({ name: t.name, kind: t.kind || '', code: String(t.code || '') }));
      const check = testsMod.validateTests(name, items, existing);
      if (check.problems.length) return invalid(check);
      return draftSaved('tests', `adds ${v.count(items.length, 'test')} to ${name}`, items, check, { note: summary, tile: name });
    },

    async what_if({ name, code, params }) {
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

    // Opens a tile or a module in the window, so the user sees it and their next message is about it. It changes
    // nothing in the model and does not change what this turn may write.
    async show_in_app({ tile, module }) {
      // The reviewer is looking at what was just written: the window stays there until they choose to move on.
      if (turn.writes.some(x => x.ok)) {
        return { text: 'Not shown: you wrote a tile in this turn and the user is reviewing it. Leave the window on it. Name the next tile in words only; open it in a later turn, when the user says to move on.', isError: true };
      }
      const graph = await tk('graph');
      if (tile) {
        const q = graph.quantities[tile];
        if (!q || q.kind !== 'tile') return { text: `${tile} is not a tile in the model.`, isError: true };
        svc.showInApp('#/tile/' + encodeURIComponent(tile));
        return { text: `The window now shows the tile ${tile}. This turn's selection is unchanged: the user's next message will have ${tile} selected.` };
      }
      if (module) {
        if (!graph.modules.some(m => m.id === module)) return { text: `${module} is not a module in the model.`, isError: true };
        svc.showInApp('#/module/' + encodeURIComponent(module));
        return { text: `The window now shows the module ${module}. This turn's selection is unchanged.` };
      }
      return { text: 'Name a tile or a module to show.', isError: true };
    },

    // Git. The tools can read the state and commit the model's own folder; there is no tool that pushes. A push is
    // asked for with request_push and happens only when the user clicks Push on the card.
    async git_status() {
      let st;
      try { st = await svc.git.status(svc.modelDir); } catch (e) { return { text: `git failed: ${e.message}`, isError: true }; }
      if (!st.isRepo) return { text: 'The model folder is not a git repository of its own, so there is nothing to commit.', isError: true };
      const shown = st.changed.slice(0, 80);
      action('Read the git status of the model.');
      return { text: [`Branch: ${st.branch || '(none)'}${st.upstream ? ` (tracking ${st.upstream})` : ''}`,
        `Remote origin: ${st.remote || 'none'}`, `Commits not pushed: ${st.ahead}${st.behind ? `; behind origin by ${st.behind}` : ''}`,
        st.changed.length ? `Changed files (${st.changed.length}):\n` + shown.map(c => `${c.state}: ${c.path}`).join('\n') + (st.changed.length > shown.length ? `\n... and ${st.changed.length - shown.length} more` : '') : 'No changed files.'].join('\n') };
    },

    async commit({ message } = {}) {
      if (typeof message !== 'string' || !message.trim()) return { text: 'A commit message is required: one short factual sentence on what changed.', isError: true };
      if (message.length > 500) return { text: 'The commit message is too long; keep it to a few lines.', isError: true };
      let c;
      try { c = await svc.git.commit(svc.modelDir, message); } catch (e) { return refuse(e.message); }
      const sentence = `Committed ${c.files} file${c.files === 1 ? '' : 's'} (${c.hash}): ${c.subject}.`;
      action(sentence);
      return { text: `${sentence}\nFiles:\n${c.filesList.slice(0, 80).join('\n')}\nNothing was pushed. A push is the user's button: use request_push only if they asked to push.` };
    },

    async request_push() {
      let st, commits;
      try { st = await svc.git.status(svc.modelDir); commits = st.isRepo ? await svc.git.unpushed(svc.modelDir) : []; } catch (e) { return { text: `git failed: ${e.message}`, isError: true }; }
      if (!st.isRepo) return { text: 'The model folder is not a git repository of its own.', isError: true };
      if (!st.remote) return { text: 'This model has no remote called origin, so there is nothing to push to.', isError: true };
      if (!st.branch) return { text: 'No branch is checked out.', isError: true };
      if (!commits.length) return { text: 'Nothing to push: every commit is already on origin.', isError: true };
      const req = svc.savePushRequestEvent({ id: store.newRequestId(), kind: 'push', name: 'push', branch: st.branch, remote: st.remote, commits, scope, at: store.now(), status: 'pending' });
      return { text: `A push request for ${req.branch} (${commits.length} commit${commits.length === 1 ? '' : 's'}) is now shown to the user with Push and Not now buttons. Nothing is pushed: only their click pushes, and you must not say it was pushed.` };
    },
  };
  return handlers;
}

// ---------------------------------------------------------------- SDK wrappers

const DESCRIPTIONS = {
  git_status: 'Read only: the model folder\'s git branch, remote, commits not pushed and changed files.',
  commit: 'Commit the open model\'s changed files locally (git add -A, then commit; .gitignore is respected and files outside the model are never touched). Only when the user asked for a commit in this message or as part of the task they set. `message` is a short factual sentence on what changed. Never pushes.',
  request_push: 'Show the user a push request (branch, remote and the commits not yet pushed) with Push and Not now buttons. Only when the user asked to push or to commit-and-push. Pushes nothing: only their click does.',
  get_selection: 'One item in detail: by default the selection; pass `tile` or `module` to read another item (read only). For a tile: its graph entry, source, review status, neighbours, the cases, and the values of its inputs and output for the default case, months 1 to 12. For a module: its tiles and specs. For the model: modules, parameters, inputs, states and cases. Call it at the start and after changes.',
  model_overview: 'Review progress of the whole model in one call: status counts, every module with its tiles and their states and blockers, the model\'s blockers, the cases, and pending sign-off requests. Use it for "what is left to review?" and similar questions.',
  read_trace: 'Values of up to 12 quantities (any in the model) for one case over a range of months (default all, at most 120 rows), plus parameter values, summary values and branch counts. Use it to explain numbers.',
  propose_structure: 'Propose a structure draft. With the whole model selected: `modules` (id, title, layer, purpose, feeds, and timing when it is not step: backward for a module worked out from the last month to the first, summary for one evaluated once after the projection), or `tiles` with `module` naming the module. With a module selected: `tiles` for that module (name, label, args, units, timing, format, spec, assumed). In a backward module a state holds NEXT month\'s value of its tile (name it <tile>_next; its `initial` is the value after the last month) and needs no reconciliation. When a tile reads last month\'s value of something, give the carried-forward state in `states` in the same draft (name, the tile it comes `from`, its `initial` value in month 1, label, format); the state\'s `from` tile must be in the draft or the model. Do not ask the user separately whether to add a state. Lay the module sheet out with the tiles: `sections` ([{title, tiles}], in calculation order, for example "Rates in the period", then "Unit roll-forward", then "Results"; required once the module has more than three tiles, covering every tile) and `checks` (reconciliations: [{name, label, expression}], the expression using only + - * /, parentheses, numbers and quantity names, and zero when the module is right; required with `states`: opening plus movements minus closing). Given, they replace the module\'s current sections or checks in tilekit.toml. To change only how a module is laid out, give `sections` and/or `checks` with no `tiles`: existing tiles are not touched. Never resend a tile that is not changing (a tile respecified in a draft goes back to not built). To remove tiles that nothing reads any more, give their names in `remove` (alone, or with `tiles`); the draft shows the user what goes and nothing is removed until they accept. The code and test of a removed tile leave the model; its sign-off record, log, test and stored workbook are kept under review/removed/. This is how a tile is removed: never tell the user to delete one themselves. Validated and saved for the user to accept or discard; nothing is written until they accept. Problems are returned for you to fix.',
  propose_design: 'The design stage of scaffolding, with the whole model selected: lay out the whole model for the user to agree before anything is built. Give `summary` (one sentence on what the model is for), `order_in_month` (the order of events within a month, stated once), `results` (the functions whose values are the output; work backward from these), `modules` in calculation order (id, title, layer, timing step or summary, purpose: the one reviewer question it answers, `weights: true` only for the module that multiplies per-policy amounts by in-force or decrements, its `tiles`, `states` and `checks`), `model_point_fields`, `inputs` (kind field, lookup or time: data only), `params`, `tables` and `cases`. Each tile: name, label, reads, a one-sentence spec, timing, `step` (the one thing it does: choose between values, convert a rate or basis, apply a rate or charge, limit with a cap or floor, combine by adding or netting), `measure` (amount per policy in force, proportion in force or leaving, weighted amount, rate, other), `branches` for a choose or limit step ([{when, case}]: the case that takes each branch) and `assumed`. Each state: name, from, initial, label, with a reconciliation in `checks` ({label, expression}) naming both. The draft is checked against the design standards (names resolve, modules read only earlier modules, one step per function, nothing unread, a reconciliation for every roll-forward, a case for every branch, per-policy amounts kept apart from weighting); problems are returned for you to fix. Accepting it saves design.json and builds nothing. Later module and tile drafts are compared with it and say where they depart.',
  propose_params: 'Propose new parameters, or new defaults and metadata for existing ones, as a draft that edits params.py when the user accepts it. Each: name (snake_case), default (number), label, format, units.',
  propose_inputs: 'Input series are data only (a model-point field as it is, a table lookup, time bookkeeping); a quantity with an actuarial choice in it, such as a rate conversion or a switch by term, is a tile instead. Propose model-point fields (name, label, format, example value written into the existing cases), assumption tables (name, label, columns, rows, formats; the first column is the key) and input series (name, label, format, description in plain words, python: plain assignments computing `name` inside build_inputs from model-point fields, month and the tables: each table is loaded for you under its own name as a dict of column arrays, so look a value up with lookup(keys, table_name["key_column"], table_name["value_column"]); optional excel template). A draft; edits inputs.py, tilekit.toml and adds table files when accepted. Omit python for a series that is a model-point field used as it is.',
  propose_cases: 'Propose named synthetic single-policy cases (id, name, purpose, model_point with every model-point field, optional params overrides and months). A draft; writes cases/<id>.json when accepted. Between them the cases should take every branch.',
  write_tile: 'Tile level only. Replace the selected tile with `code` (the whole function: def line, full docstring, body) and write `test_code` (the complete hand-calculation test file tests/tiles/test_<name>.py; one of its tests must be taken from a case of the model and say so in its docstring with a line `Case: base, month 1`, so the hand figure can be set beside the spreadsheet\'s). One step per tile: a tile that both chooses a value with np.where and converts a rate (a power over a period, or np.exp with np.log) is refused; split it into two tiles. Checks the rules (restoring the old code on errors), rebuilds the tile, module and model workbooks, runs the test, and returns the differences per case and uncovered branches. Asks the human first if sign-offs would go stale.',
  remove_tiles: 'Remove tiles from a module. Their code and tests leave the model; their sign-off records, logs, tests and stored workbooks are kept under review/removed/, not deleted. Saved as a draft the user accepts or discards in the app; nothing is removed until then. Only tiles that nothing reads any more (change the tiles that read them first). `tiles`: the names; `module` only when the whole model is selected. Use this whenever tiles should go: never tell the user to delete a tile or edit the file themselves, and never delete the review folder of a tile.',
  propose_tests: 'Propose more hand-calculation tests for a built tile, as a draft the user accepts or discards (the only way to add tests to an existing test file). `tests`: each {name: test_<what_it_checks>, kind: the kind of test asked for, code: the whole function `def test_x():` with a docstring (first line: what is checked; then the working by hand, figure by figure) and its asserts on the tile}. No imports. On accept the tests are added and run; if one does not agree with the tile nothing is saved and you are told which.',
  propose_module_test: 'Propose the module\'s own hand-worked test, tests/modules/test_<module>.py, as a draft the user accepts or discards (with the module, one of its tiles or the whole model selected; name `module` at model level). It walks one case of the model through the module\'s tiles for the first months and the month where behaviour changes, calling the tiles in order with plain numbers and asserting each figure worked by hand. When the file does not exist give `code`: the whole file (a module docstring stating the case figures, imports of pytest and the module\'s tiles, then test functions, each with a docstring whose first line says what is checked, a line `Case: base, month 1` naming the case and month, then the working figure by figure). When it exists give `tests` instead: functions to add, as for propose_tests. On accept the file is written and run; if a check fails nothing is saved and you are told which.',
  what_if: 'Show the effect of a change without applying it: replace tile `name` with `code` and/or override parameter values in every case, on a copy of the model. Returns the change in the tile and in the model\'s final outputs per case, and saves a draft the user can apply (code changes only) or discard.',
  show_in_app: 'Open a tile or a module in the app\'s window so the user is looking at it (for example the next tile to build, once the user has said to move on). Never in the same turn as write_tile: after building a tile the window stays on it for the user to review. Changes nothing in the model. The selection for this turn stays as it is; the user\'s next message is sent with the shown item selected.',
  request_signoff: 'When the reviewer says they are happy with an item: show them a sign-off request with a Confirm button for the selected item (or, with a module or the model selected, any item beneath it). Records nothing; only their click signs off. Returns any blockers.',
  request_reconfirm: 'Show the reviewer a request to re-confirm, in bulk, the signed-off tiles whose values changed but whose formulas did not (in the selected module, or `module`, or the whole model). Records nothing; only their click re-confirms.',
  rebuild: 'Regenerate stale or missing workbooks: by default for the selection (a tile also rebuilds its module and the model workbook; the model rebuilds everything). Optional `kind` and `name` for an item beneath the selection. Says what was rebuilt and whether every difference is zero.',
};

// One tool list, the one Claude Code in the pane gets (the UI-less `send` gets the same).
// Every tool is offered at every level (the tool list stays the same across the conversation, which keeps
// the prompt cache warm); the handlers refuse what the current selection does not allow.
function sdkTools(sdk, z, handlers) {
  const run = (name, fn) => async args => {
    try {
      const r = await fn(args || {});
      return { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) };
    } catch (e) {
      return { content: [{ type: 'text', text: `${name} failed: ${e && e.message || e}` }], isError: true };
    }
  };
  const extras = { alwaysLoad: true };
  const format = z.enum(['amount', 'units', 'percent', 'rate', 'irr', 'number', 'small', 'integer']);
  const tileItem = z.object({
    name: z.string(), label: z.string(), args: z.array(z.string()), units: z.string(), timing: z.string(),
    format, spec: z.string(), assumed: z.array(z.string()).optional(),
  });
  const moduleItem = z.object({ id: z.string(), title: z.string(), layer: z.string(), purpose: z.string(), feeds: z.array(z.string()),
    timing: z.enum(['step', 'backward', 'summary']).optional().describe('step (default): each month; backward: each month from the last to the first, for reserves; summary: once, after the projection') });
  const paramItem = z.object({ name: z.string(), default: z.number(), label: z.string(), format, units: z.string() });
  const fieldItem = z.object({ name: z.string(), label: z.string(), format: format.optional(), example: z.number() });
  const inputItem = z.object({ name: z.string(), label: z.string(), format, description: z.string(),
    python: z.string().optional(), excel: z.string().optional() });
  const tableItem = z.object({ name: z.string(), label: z.string(), columns: z.array(z.string()), rows: z.array(z.array(z.number())),
    formats: z.record(z.string(), format).optional(), file: z.string().optional() });
  const caseItem = z.object({ id: z.string(), name: z.string(), purpose: z.string(), model_point: z.record(z.string(), z.number()),
    params: z.record(z.string(), z.number()).optional(), months: z.number().int().optional() });
  const kind3 = z.enum(['tile', 'module', 'model']);
  const t = (name, shape) => sdk.tool(name, DESCRIPTIONS[name], shape, run(name, handlers[name]), extras);
  return [
    t('get_selection', { tile: z.string().optional().describe('another tile to read'), module: z.string().optional().describe('another module to read') }),
    t('model_overview', {}),
    t('read_trace', {
      case: z.string().describe('case id'), quantities: z.array(z.string()).describe('quantity names'),
      from_month: z.number().int().optional(), to_month: z.number().int().optional(),
    }),
    t('what_if', {
      name: z.string().optional().describe('tile to replace'), code: z.string().optional().describe('the whole replacement function'),
      params: z.record(z.string(), z.number()).optional().describe('parameter overrides applied to every case'),
    }),
    t('show_in_app', { tile: z.string().optional().describe('a tile name'), module: z.string().optional().describe('a module id') }),
    t('write_tile', { name: z.string(), code: z.string(), test_code: z.string() }),
    t('remove_tiles', { tiles: z.array(z.string()).describe('names of the tiles to remove'), module: z.string().optional(), summary: z.string().optional().describe('one sentence on why they go') }),
    t('propose_tests', { summary: z.string().describe('one sentence on what the tests add'), tile: z.string().optional().describe('the tile (default: the selected tile)'),
      tests: z.array(z.object({ name: z.string(), kind: z.string().optional(), code: z.string() })) }),
    t('propose_structure', {
      summary: z.string().describe('one sentence on what the draft does'),
      modules: z.array(moduleItem).optional(), tiles: z.array(tileItem).optional(),
      remove: z.array(z.string()).optional().describe('names of tiles to remove from the module (the code and test leave the model; the sign-off record, log, test and stored workbook are kept under review/removed/); only tiles that nothing reads any more'),
      states: z.array(z.object({ name: z.string().describe('for example account_value_bop'), from: z.string().describe('the tile whose value it takes next month, for example account_value_eop'),
        initial: z.number().describe('its value in month 1'), label: z.string(), format })).optional().describe('carried-forward states the tiles read; with tiles only'),
      module: z.string().optional().describe('the module the tiles belong to (needed with the whole model selected)'),
      sections: z.array(z.object({ title: z.string().describe('what the block does, for example "Rates in the period"'), tiles: z.array(z.string()).describe('its tiles, in calculation order') }))
        .optional().describe('the module sheet\'s blocks, top to bottom as the calculation reads; every tile in exactly one; replaces the module\'s current sections'),
      checks: z.array(z.object({ name: z.string().describe('snake_case, for example units_reconcile'), label: z.string().describe('for example "Units roll-forward reconciles"'),
        expression: z.string().describe('zero when the module is right, for example "units_bop + units_allocated - units_amc - units_eop"; only + - * /, parentheses, numbers and quantity names') }))
        .optional().describe('reconciliation checks for the module; replaces the module\'s current checks'),
    }),
    t('propose_design', {
      summary: z.string().describe('one sentence on what the model is for'),
      order_in_month: z.array(z.string()).describe('the order of events within a month, for example ["Premium", "Interest credited", "Deaths", "Surrenders"]'),
      results: z.array(z.string()).describe('the functions whose values are the output of the model'),
      modules: z.array(z.object({
        id: z.string(), title: z.string(), layer: z.string(), timing: z.enum(['step', 'backward', 'summary']).optional().describe('step: each month; backward: each month from the last to the first (reserves); summary: once at the end'), purpose: z.string().describe('the one question the module answers for a reviewer'),
        weights: z.boolean().optional().describe('true only for the module that multiplies per-policy amounts by in-force or decrements'),
        tiles: z.array(z.object({
          name: z.string(), label: z.string(), reads: z.array(z.string()), spec: z.string().describe('one plain sentence; never the formula'), timing: z.string().optional().describe('where in the month it sits'),
          step: z.enum(design.STEPS).describe('the one thing it does'), measure: z.enum(design.MEASURES),
          branches: z.array(z.object({ when: z.string(), case: z.string().describe('the id of the case that takes this branch') })).optional(),
          assumed: z.array(z.string()).optional().describe('assumptions the reviewer confirms at sign-off'),
        })),
        states: z.array(z.object({ name: z.string(), from: z.string(), initial: z.number(), label: z.string() })).optional(),
        checks: z.array(z.object({ label: z.string(), expression: z.string().describe('zero when the module is right') })).optional(),
      })).describe('in calculation order'),
      model_point_fields: z.array(z.object({ name: z.string(), label: z.string() })).optional(),
      inputs: z.array(z.object({ name: z.string(), label: z.string(), kind: z.enum(design.INPUT_KINDS) })).optional(),
      params: z.array(z.object({ name: z.string(), label: z.string() })).optional(),
      tables: z.array(z.object({ name: z.string(), label: z.string() })).optional(),
      cases: z.array(z.object({ id: z.string(), name: z.string(), purpose: z.string() })),
    }),
    t('propose_module_test', {
      summary: z.string().describe('one sentence on what the test walks through'),
      module: z.string().optional().describe('the module (default: the selected module, or the selected tile\'s module)'),
      code: z.string().optional().describe('the whole test file, when the module has none yet'),
      tests: z.array(z.object({ name: z.string(), kind: z.string().optional(), code: z.string() })).optional().describe('test functions to add, when the file exists'),
    }),
    t('propose_params', { summary: z.string(), params: z.array(paramItem) }),
    t('propose_inputs', { summary: z.string(), model_point_fields: z.array(fieldItem).optional(), inputs: z.array(inputItem).optional(), tables: z.array(tableItem).optional() }),
    t('propose_cases', { summary: z.string(), cases: z.array(caseItem) }),
    t('request_signoff', { kind: kind3, name: z.string().optional().describe('tile or module name; omit for the model') }),
    t('request_reconfirm', { module: z.string().optional() }),
    t('rebuild', { kind: kind3.optional(), name: z.string().optional() }),
    t('git_status', {}),
    t('commit', { message: z.string().describe('a short factual commit message') }),
    t('request_push', {}),
  ];
}

const TOOL_NAMES = Object.keys(DESCRIPTIONS);

module.exports = { createHandlers, sdkTools, defaultCase, TOOL_NAMES };
