'use strict';
// Operations that change (or simulate changing) the model: write one tile, what-if, accept drafts.
// Every function takes `ctx` = {modelDir, tilekit, confirm, runPytest}.
const fs = require('fs');
const os = require('os');
const path = require('path');
const src = require('./source');
const { signoffImpact, sameTile, validateTileDraft, validateModuleDraft, validateLayout, count } = require('./validate');

const read = f => fs.readFileSync(f, 'utf8');
const exists = f => fs.existsSync(f);

function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(6);
  return String(Number(v.toPrecision(10)));
}

function testRel(name) { return path.posix.join('tests', 'tiles', `test_${name}.py`); }

function caseResultsSentence(entry) {
  const results = Object.entries((entry && entry.case_results) || {});
  if (!results.length) return 'no case results';
  const zero = results.filter(([, r]) => r.pass);
  if (zero.length === results.length) return `differences are zero in ${results.length} of ${results.length} cases`;
  const bad = results.filter(([, r]) => !r.pass)
    .map(([c, r]) => (typeof r.max_abs_difference === 'number' ? `${c} (largest ${fmt(r.max_abs_difference)})` : c));
  return `differences are zero in ${zero.length} of ${results.length} cases; not zero in ${bad.join(', ')}`;
}

// ---------------------------------------------------------------- rebuilding workbooks

const reviewFile = (ctx, ...parts) => path.join(ctx.modelDir, 'review', ...parts);

function builtName(b) {
  if (b.kind === 'tile') return b.name;
  if (b.kind === 'module') return `the ${b.name} module workbook`;
  return 'the model workbook';
}

function listWords(items) {
  return items.length > 1 ? items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1] : items[0];
}

// One sentence for a set of `tilekit build` results: what was rebuilt and whether every difference is zero.
function builtSentence(built, failures = []) {
  const parts = [];
  if (built.length) {
    const names = built.length > 5 ? [count(built.length, 'workbook')] : built.map(builtName);
    const bad = built.filter(b => b.checks_pass === false);
    const diff = bad.length
      ? `differences are not zero in ${bad.map(b => `${b.kind === 'model' ? 'the model' : b.name} (largest ${fmt(b.max_abs_difference)})`).join(', ')}`
      : 'every difference is zero';
    parts.push(`Rebuilt ${listWords(names)}: ${diff}.`);
  }
  for (const f of failures) parts.push(f);
  return parts.join(' ') || null;
}

async function buildOne(ctx, args, built, failures, what) {
  try {
    const r = await ctx.tilekit('build', args);
    built.push(...(r.built || []));
  } catch (e) {
    failures.push(`${what[0].toUpperCase()}${what.slice(1)} did not build: ${String(e.message).replace(/\.$/, '')}.`);
  }
}

// After a change: rebuild the given modules' workbooks and the model workbook, when they exist.
async function rebuildRelated(ctx, modules) {
  const built = [], failures = [];
  for (const m of [...new Set(modules)].filter(Boolean)) {
    if (fs.existsSync(reviewFile(ctx, 'modules', m, 'workbook.xlsx'))) await buildOne(ctx, ['--module', m], built, failures, `the ${m} module workbook`);
  }
  if (fs.existsSync(reviewFile(ctx, 'model', 'workbook.xlsx'))) await buildOne(ctx, ['--whole-model'], built, failures, 'the model workbook');
  return { built, failures, sentence: builtSentence(built, failures) };
}

/**
 * Rebuild what is out of date for a target: {kind: 'tile'|'module'|'model', name}. A tile also rebuilds its
 * module and the model workbook (when they exist); a module rebuilds its stale tiles, itself and the model
 * workbook; the model rebuilds everything that is unbuilt or stale.
 */
async function rebuildTarget(ctx, target) {
  const tk = ctx.tilekit;
  const built = [], failures = [];
  if (target.kind === 'model') {
    await buildOne(ctx, [], built, failures, 'the rebuild');
  } else {
    const [graph, status] = await Promise.all([tk('graph'), tk('status')]);
    if (target.kind === 'tile') {
      const q = graph.quantities[target.name];
      if (!q || q.kind !== 'tile') return { built, failures, sentence: `${target.name} is not a tile in the model.`, error: true };
      if (q.status === 'not_built') return { built, failures, sentence: `${target.name} is not built yet, so it has no workbook.`, error: true };
      await buildOne(ctx, ['--tile', target.name], built, failures, `the ${target.name} workbook`);
      const r = await rebuildRelated(ctx, [q.module]);
      built.push(...r.built); failures.push(...r.failures);
    } else {
      const m = graph.modules.find(x => x.id === target.name);
      if (!m) return { built, failures, sentence: `${target.name} is not a module in the model.`, error: true };
      for (const t of m.tiles) {
        const e = status.tiles[t] || {};
        if (e.state === 'not_built' || e.workbook_current) continue;
        await buildOne(ctx, ['--tile', t], built, failures, `the ${t} workbook`);
      }
      if (m.tiles.length) await buildOne(ctx, ['--module', m.id], built, failures, `the ${m.id} module workbook`);
      if (fs.existsSync(reviewFile(ctx, 'model', 'workbook.xlsx'))) await buildOne(ctx, ['--whole-model'], built, failures, 'the model workbook');
    }
  }
  return { built, failures, sentence: builtSentence(built, failures) || 'Every workbook was already up to date.' };
}

// Module python file for a module id, from a tile in it or from tilekit.toml.
function moduleFile(ctx, graph, moduleId) {
  const m = graph.modules.find(x => x.id === moduleId);
  if (m && m.tiles.length) return path.join(ctx.modelDir, graph.quantities[m.tiles[0]].source.file);
  const block = src.tomlModules(read(path.join(ctx.modelDir, 'tilekit.toml'))).find(b => b.id === moduleId);
  if (!block || !block.python) throw new Error(`Cannot find the Python file of module ${moduleId}.`);
  const base = exists(path.join(ctx.modelDir, 'src')) ? path.join(ctx.modelDir, 'src') : ctx.modelDir;
  return path.join(base, ...block.python.split('.')) + '.py';
}

// ---------------------------------------------------------------- write one tile

/**
 * Replace tile `name` with `code`, write its test, check, build and report.
 * Returns {ok, changed, declined?, text (for the model), actions: [sentences]}.
 * `approved` (a Set) remembers tiles whose sign-off loss the human already accepted in this turn.
 */
async function applyTileCode(ctx, { name, code, testCode, approved }) {
  const tk = ctx.tilekit;
  const graph = await tk('graph');
  const q = graph.quantities[name];
  if (!q || q.kind !== 'tile') return fail(`${name} is not a tile in the model.`);
  code = src.normaliseCode(code);
  const problems = src.tileCodeProblems(name, code);
  if (problems.length) return fail('The code was not written. ' + problems.join(' '));

  const status = await tk('status');
  const impact = signoffImpact(graph, status, name);
  if (impact && !(approved && approved.has(name))) {
    const ok = await ctx.confirm({ title: `Change ${name}?`, message: impact.message + ' Change it anyway?', detail: impact.detail });
    if (!ok) {
      return { ok: false, changed: false, declined: true, actions: [`Did not change ${name}: the sign-offs were kept.`],
        text: `The user declined: ${impact.message} Nothing was changed. Do not try again unless the user asks.` };
    }
    if (approved) approved.add(name);
  }

  const file = path.join(ctx.modelDir, q.source.file);
  const before = read(file);
  const testFile = path.join(ctx.modelDir, testRel(name));
  const testBefore = exists(testFile) ? read(testFile) : null;
  const restore = () => {
    fs.writeFileSync(file, before);
    if (testCode) { if (testBefore === null) fs.rmSync(testFile, { force: true }); else fs.writeFileSync(testFile, testBefore); }
  };
  let after;
  try { after = src.ensureTkImport(src.spliceFunction(before, q.source, code), code); } catch (e) { return fail(e.message); }
  fs.writeFileSync(file, after);
  if (testCode) {
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    fs.writeFileSync(testFile, src.normaliseCode(testCode) + '\n');
  }

  // Rule check; restore on errors in this tile or if the model no longer loads.
  let check, graph2;
  try {
    check = await tk('check');
    graph2 = await tk('graph');
  } catch (e) {
    restore();
    return fail(`The model no longer loads with this code (${e.message}). The previous code was restored.`);
  }
  const own = (check.violations || []).filter(v => v.tile === name);
  const errors = own.filter(v => v.severity === 'error');
  if (errors.length) {
    restore();
    return {
      ok: false, changed: false, actions: [`Rule check failed for ${name}; the previous code was restored.`],
      text: 'Rule violations, so the previous code was restored:\n' + errors.map(v => `- line ${v.line}, ${v.rule}: ${v.message}`).join('\n'),
    };
  }
  const others = Object.entries(graph.quantities).filter(([n, e]) => e.kind === 'tile' && n !== name && e.source.file === q.source.file);
  const moved = others.filter(([n, e]) => !graph2.quantities[n] || graph2.quantities[n].source.code !== e.source.code);
  if (moved.length || !graph2.quantities[name]) {
    restore();
    return fail(`Writing ${name} would have changed other functions (${moved.map(m => m[0]).join(', ')}); the previous code was restored.`);
  }

  const actions = [testCode ? `Wrote ${name} and its test.` : `Wrote ${name}.`];
  const lines = [];
  if (own.length) lines.push('Rule warnings: ' + own.map(v => `${v.rule}: ${v.message}`).join('; '));
  const unchanged = before === after;

  // Build the tile workbook and read the per-case differences.
  let buildText;
  try {
    await tk('build', ['--tile', name]);
    const st = await tk('status');
    const entry = st.tiles[name] || {};
    const sentence = caseResultsSentence(entry);
    buildText = `Rebuilt the workbook: ${sentence}`;
    lines.push(`Workbook rebuilt. Per case: ${Object.entries(entry.case_results || {}).map(([c, r]) => `${c} max abs difference ${fmt(r.max_abs_difference)} (${r.pass ? 'pass' : 'fail'})`).join('; ')}.`);
    if (entry.formula) lines.push(`Excel formula: ${entry.formula}`);
    if (entry.translatable === false) lines.push('The tile does not translate to one Excel formula; rewrite it with the supported functions.');
    if ((entry.uncovered_branches || []).length) lines.push(`Uncovered branches (no case takes them; the user must add a case): ${entry.uncovered_branches.join(', ')}.`);
    else lines.push('Every branch is taken by at least one case.');
  } catch (e) {
    buildText = `The workbook did not build: ${e.message}`;
    lines.push(buildText);
  }
  const related = await rebuildRelated(ctx, [q.module]);
  if (related.sentence) lines.push(related.sentence);

  let testText = '';
  if (ctx.runPytest && exists(testFile)) {
    const r = await ctx.runPytest(testRel(name));
    testText = r.passed ? 'the hand-calculation test passes' : 'the hand-calculation test fails';
    lines.push(r.passed ? 'Hand-calculation test passes.' : 'Hand-calculation test FAILS:\n' + r.output);
  }
  actions.push(buildText + (testText ? `; ${testText}.` : '.'));
  if (related.sentence) actions.push(related.sentence);
  return { ok: true, changed: !unchanged || !!testCode, actions, text: `Wrote ${name}.\n` + lines.join('\n') };

  function fail(text) { return { ok: false, changed: false, actions: [], text }; }
}

// ---------------------------------------------------------------- what-if

function copyModel(modelDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whatif-'));
  const skipTop = new Set(['review', '.venv', '.pytest_cache', 'real-data', 'tests', '.git', 'node_modules']);
  fs.cpSync(modelDir, tmp, {
    recursive: true,
    filter: s => {
      const rel = path.relative(modelDir, s);
      if (!rel) return true;
      const parts = rel.split(path.sep);
      return !skipTop.has(parts[0]) && !parts.includes('__pycache__');
    },
  });
  return tmp;
}

function compareSeries(before, after) {
  let maxAbs = 0, maxRel = 0, at = null;
  const n = Math.max(before.length, after.length);
  for (let i = 0; i < n; i++) {
    const a = before[i], b = after[i];
    if (a == null || b == null) { if (a !== b) { maxAbs = Infinity; at = i + 1; } continue; }
    const d = Math.abs(b - a);
    if (d > maxAbs) { maxAbs = d; at = i + 1; }
    if (a !== 0) maxRel = Math.max(maxRel, d / Math.abs(a));
  }
  return { maxAbs, maxRel, at };
}

/**
 * Run every case on a copy of the model with tile `name` replaced by `code` (and/or parameter
 * overrides added to every case), and compare with the real model. Nothing real changes.
 */
async function whatIf(ctx, { name, code, params }) {
  const tk = ctx.tilekit;
  const graph = await tk('graph');
  const q = name ? graph.quantities[name] : null;
  if (name && (!q || q.kind !== 'tile')) return { ok: false, text: `${name} is not a tile in the model.` };
  for (const p of Object.keys(params || {})) {
    if (!graph.quantities[p] || graph.quantities[p].kind !== 'param') return { ok: false, text: `${p} is not a parameter of the model.` };
    if (typeof params[p] !== 'number' || !Number.isFinite(params[p])) return { ok: false, text: `The value for ${p} must be a number.` };
  }
  if (code) {
    code = src.normaliseCode(code);
    const problems = src.tileCodeProblems(name, code).filter(p => !/Status: not built/.test(p));
    if (problems.length) return { ok: false, text: problems.join(' ') };
  }
  if (!code && !(params && Object.keys(params).length)) return { ok: false, text: 'Give new code for the tile, parameter values, or both.' };

  const tmp = copyModel(ctx.modelDir);
  try {
    if (code) {
      const file = path.join(tmp, q.source.file);
      fs.writeFileSync(file, src.ensureTkImport(src.spliceFunction(read(file), q.source, code), code));
    }
    if (params && Object.keys(params).length) {
      const dir = path.join(tmp, 'cases');
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
        const doc = JSON.parse(read(path.join(dir, f)));
        doc.params = { ...(doc.params || {}), ...params };
        fs.writeFileSync(path.join(dir, f), JSON.stringify(doc, null, 2));
      }
    }
    const inCopy = ['--model', tmp]; // argparse keeps the last --model
    let check;
    try { check = await tk('check', inCopy); } catch (e) { return { ok: false, text: `The changed model does not load: ${e.message}` }; }
    const violations = (check.violations || []).filter(v => v.tile === name && v.severity === 'error');
    const caseIds = (await tk('cases')).cases.map(c => c.id);
    const pairs = await Promise.all(caseIds.map(async c => {
      const [b, a] = await Promise.all([tk('trace', ['--case', c]), tk('trace', ['--case', c, ...inCopy])]);
      return [c, b, a];
    }));
    const sinks = graph.order.filter(t => !(graph.quantities[t].used_by || []).length);
    const watch = [...new Set([...(name ? [name] : []), ...sinks])];
    const result = { cases: {} };
    const lines = [];
    const unchanged = [];
    const best = {}; // quantity -> case with the largest absolute change
    for (const [c, b, a] of pairs) {
      result.cases[c] = {};
      for (const qn of watch) {
        const isSeries = b.series[qn] !== undefined;
        const sb = isSeries ? b.series[qn] : (qn in b.summary ? [b.summary[qn]] : undefined);
        const sa = isSeries ? a.series[qn] : (qn in a.summary ? [a.summary[qn]] : undefined);
        if (!sb || !sa) continue;
        const cmp = compareSeries(sb, sa);
        const months = isSeries ? [1, 12, 60, sb.length].filter((m, i, arr) => m <= sb.length && arr.indexOf(m) === i) : [1];
        const at = months.map(m => ({ month: m, before: sb[m - 1], after: sa[m - 1] }));
        result.cases[c][qn] = { ...cmp, at, summary: !isSeries };
        if (cmp.maxAbs === 0) { unchanged.push(`${c} ${qn}`); continue; }
        lines.push(isSeries
          ? `${c} ${qn}: largest change ${fmt(cmp.maxAbs)} (month ${cmp.at}), largest relative change ${(cmp.maxRel * 100).toPrecision(4)}%; ` +
            at.map(x => `month ${x.month} ${fmt(x.before)} -> ${fmt(x.after)}`).join(', ')
          : `${c} ${qn} (summary): ${fmt(sb[0])} -> ${fmt(sa[0])}, relative change ${(cmp.maxRel * 100).toPrecision(4)}%`);
        if (!best[qn] || cmp.maxAbs > best[qn].maxAbs) best[qn] = { case: c, ...cmp, last: at[at.length - 1], isSeries };
      }
    }
    if (unchanged.length) lines.push('No change: ' + unchanged.join(', ') + '.');
    if (violations.length) lines.push('Rule violations in the changed tile: ' + violations.map(v => `${v.rule}: ${v.message}`).join('; '));
    const label = qn => (graph.quantities[qn] && graph.quantities[qn].label) || qn;
    const say = qn => {
      const h = best[qn];
      return h.isSeries
        ? `${label(qn)} changes by up to ${fmt(h.maxAbs)} (case ${h.case}, month ${h.at}; month ${h.last.month} ${fmt(h.last.before)} to ${fmt(h.last.after)})`
        : `${label(qn)} goes from ${fmt(h.last.before)} to ${fmt(h.last.after)} (case ${h.case})`;
    };
    const parts = [];
    if (name && best[name]) parts.push(say(name));
    const outs = sinks.filter(s => s !== name && best[s]).sort((x, y) => best[y].maxRel - best[x].maxRel);
    if (outs.length) parts.push(say(outs[0]));
    const summary = parts.length ? parts.join('; ') : 'No value changes in any case';
    return { ok: true, result, summary, violations, text: lines.join('\n') };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- accept drafts

// A removed tile's record is kept, not deleted. Its review folder (sign-off, expected values, log, stored workbook
// and sidecar) becomes review/removed/<tile>-<UTC time>/, its test file moves in beside them, and removed.json says
// what was removed, when, by which draft, whether it was signed off, and the code as it was. Nothing reads
// review/removed/: the tooling finds tiles from the model graph and looks only in review/tiles/<name>.
// `tiles` is [{name, code}]. Returns {folders, undo}; if any step fails, everything already moved is put back
// before the error is thrown.
function archiveRemovedTiles(ctx, moduleId, tiles, draftId) {
  const root = path.join(ctx.modelDir, 'review', 'removed');
  const rootMade = !exists(root);
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');   // 20261115T051500Z
  const steps = [];
  const undo = () => {
    for (const step of steps.reverse()) { try { step(); } catch { /* put back what can be */ } }
    steps.length = 0;
    if (rootMade) fs.rmSync(root, { recursive: true, force: true });
  };
  const folders = [];
  try {
    for (const { name, code } of tiles) {
      const reviewDir = path.join(ctx.modelDir, 'review', 'tiles', name);
      const testFile = path.join(ctx.modelDir, 'tests', 'tiles', `test_${name}.py`);
      const hasReview = exists(reviewDir);
      const hasTest = exists(testFile);
      if (!hasReview && !hasTest && !code) continue;
      fs.mkdirSync(root, { recursive: true });
      // the kept tests are a record, not tests of the model: pytest run from the model folder must not collect them
      const conftest = path.join(root, 'conftest.py');
      if (!exists(conftest)) fs.writeFileSync(conftest, '# Records of removed tiles. Their kept test files are not tests of the model.\ncollect_ignore_glob = ["*"]\n');
      let dir = path.join(root, `${name}-${stamp}`);
      for (let k = 2; exists(dir); k++) dir = path.join(root, `${name}-${stamp}-${k}`);
      let signoff = null;
      try { signoff = JSON.parse(read(path.join(reviewDir, 'signoff.json'))); } catch { /* never signed off */ }
      if (hasReview) { fs.renameSync(reviewDir, dir); steps.push(() => fs.renameSync(dir, reviewDir)); }
      else { fs.mkdirSync(dir); steps.push(() => fs.rmSync(dir, { recursive: true, force: true })); }
      if (hasTest) {
        const kept = path.join(dir, `test_${name}.py`);
        fs.renameSync(testFile, kept);
        steps.push(() => fs.renameSync(kept, testFile));
      }
      const note = path.join(dir, 'removed.json');
      fs.writeFileSync(note, JSON.stringify({
        tile: name, module: moduleId, removed_at: now.toISOString(), was_signed_off: !!signoff,
        signed_off: signoff ? { reviewer: signoff.reviewer === undefined ? null : signoff.reviewer, at: signoff.at === undefined ? null : signoff.at } : null,
        draft: draftId || null, code: code || '',
      }, null, 2) + '\n');
      steps.push(() => fs.rmSync(note, { force: true }));
      folders.push(path.relative(ctx.modelDir, dir).split(path.sep).join('/'));
    }
  } catch (e) {
    undo();
    throw e;
  }
  return { folders, undo };
}

async function acceptTileDraft(ctx, draft) {
  const tk = ctx.tilekit;
  const graph = await tk('graph');
  const moduleId = draft.module || draft.scope.id;
  const states = draft.states || [];
  const removed = (draft.remove || []).map(r => (typeof r === 'string' ? r : r.name));
  const sections = Array.isArray(draft.sections) ? draft.sections : undefined;
  const checks = Array.isArray(draft.checks) ? draft.checks : undefined;
  // the house rules were enforced when the draft was proposed; here only that it still fits the model
  const problems = [...validateTileDraft(graph, moduleId, draft.items, states, removed, { layoutOnly: !!(draft.sections || draft.checks) }).problems,
    ...validateLayout(graph, moduleId, draft.items, states, removed, sections, checks).problems];
  if (problems.length) throw new Error('The draft no longer fits the model: ' + problems.join(' '));
  const file = moduleFile(ctx, graph, moduleId);
  const before = read(file);
  const q = graph.quantities;

  // The model may have moved on since the draft was proposed. A tile the draft ADDS that is in the model now was
  // added (and perhaps built) since: the draft is refused, never written over it. A tile the draft CHANGES that
  // already is what the draft says is left alone, as it would have been left out when the draft was proposed.
  // `new_tiles` / `changed_tiles` are recorded on the draft at proposal. A draft saved before they were recorded
  // cannot say which it meant, so it never puts a placeholder over a tile that is built.
  const recorded = Array.isArray(draft.new_tiles) && Array.isArray(draft.changed_tiles);
  const wasNew = new Set(recorded ? draft.new_tiles : []);
  const sinceAdded = [], builtNow = [], leftAlone = [], added = [], changed = [];
  for (const it of draft.items) {
    const cur = q[it.name];
    if (!cur) added.push(it);
    else if (wasNew.has(it.name)) sinceAdded.push(it.name);
    else if (sameTile(cur, it, moduleId)) leftAlone.push(it.name);
    else if (!recorded && cur.status !== 'not_built') builtNow.push(it.name);
    else changed.push(it);
  }
  if (sinceAdded.length || builtNow.length) {
    const reasons = [];
    if (sinceAdded.length) reasons.push(`${sinceAdded.join(', ')} ${sinceAdded.length === 1 ? 'was' : 'were'} new when this draft was proposed and ${sinceAdded.length === 1 ? 'has' : 'have'} been added to the model since, so accepting it would put a not-built placeholder over ${sinceAdded.length === 1 ? 'the tile' : 'the tiles'} as ${sinceAdded.length === 1 ? 'it is' : 'they are'} now.`);
    if (builtNow.length) reasons.push(`This draft was saved before the app recorded which of its tiles were new, and ${builtNow.join(', ')} ${builtNow.length === 1 ? 'is' : 'are'} built now, so accepting it would put a not-built placeholder over built code.`);
    throw new Error(`The draft no longer fits the model: ${reasons.join(' ')} Nothing was changed. Discard this draft and ask for a new one if a change is still wanted.`);
  }

  // What the draft does to tilekit.toml is worked out before anything is written, so an edit that has to be
  // refused (a section that cannot be read with certainty) leaves every file as it was.
  const tomlFile = path.join(ctx.modelDir, 'tilekit.toml');
  const tomlTouched = states.length || sections || checks || removed.length;
  const tomlBefore = tomlTouched ? read(tomlFile) : null;
  let toml = tomlBefore;
  if (tomlTouched) {
    try {
      if (sections || checks) toml = src.setModuleLayout(toml, moduleId, { sections, checks });
      // tiles that go are taken out of the module's sections (unless the draft gave the sections afresh)
      if (removed.length && !sections) toml = src.dropTilesFromSections(toml, moduleId, removed);
    } catch (e) {
      throw new Error(`The draft was not applied: ${e.message} Nothing was changed.`);
    }
    if (states.length) {
      const qs = x => JSON.stringify(String(x));
      const blocks = states.flatMap(st => ['', `[state.${st.name}]`, `from = ${qs(st.from)}`, `initial = ${Number.isInteger(st.initial) ? st.initial.toFixed(1) : String(st.initial)}`, `label = ${qs(st.label)}`, `format = ${qs(st.format)}`]);
      toml = toml.replace(/\s+$/, '') + '\n' + blocks.join('\n') + '\n';
    }
  }

  // Sign-offs the draft would undo: asked about once, before anything is written. Changed and removed tiles un-tick
  // themselves and what is downstream. Sections and checks are part of what a module sign-off and the model sign-off
  // cover (the layout of the module sheet), so a draft that changes them makes those two sign-offs stale even when
  // it touches no tile.
  const mod = graph.modules.find(m => m.id === moduleId) || {};
  const shape = (list, keys) => JSON.stringify((Array.isArray(list) ? list : [{ unknown: true }]).map(x => keys.map(k => (x && x[k] != null && x[k] !== '' ? x[k] : null))));
  const sectionsChange = !!sections && shape(sections, ['title', 'tiles']) !== shape(mod.sections, ['title', 'tiles']);
  const checksChange = !!checks && shape(checks, ['name', 'label', 'expression']) !== shape(mod.checks, ['name', 'label', 'expression']);
  const layoutChanges = sectionsChange || checksChange;
  if (changed.length || removed.length || layoutChanges) {
    const status = await tk('status');
    const impacts = [...changed.map(i => i.name), ...removed].map(n => signoffImpact(graph, status, n)).filter(Boolean);
    const messages = impacts.map(x => x.message);
    const details = impacts.map(x => x.detail);
    if (layoutChanges) {
      const signed = x => !!x && x.state === 'signed_off';
      const lost = [];
      if (signed((status.modules || {})[moduleId]) && !impacts.some(x => x.modules.includes(moduleId))) lost.push(`the module sign-off of \`${moduleId}\``);
      if (signed(status.model) && !impacts.some(x => x.model)) lost.push('the model sign-off');
      if (lost.length) {
        const what = sectionsChange && checksChange ? 'sections and reconciliation checks' : sectionsChange ? 'sections' : 'reconciliation checks';
        messages.push(`This changes the ${what} of ${moduleId}, which are part of what was signed off, so ${lost.join(' and ')} will need to be given again.`);
        details.push(`The layout of the ${moduleId} sheet is part of what was signed off. No tile sign-off is affected by the layout.`);
      }
    }
    if (messages.length) {
      const ok = await ctx.confirm({ title: 'Accept draft?', message: messages.join(' ') + ' Accept the draft anyway?', detail: details.join('\n') });
      if (!ok) return { accepted: false, actions: ['Did not accept the draft: the sign-offs were kept.'] };
    }
  }

  // New tiles in dependency order (proposed tiles after the proposed tiles they read).
  const names = new Set(added.map(i => i.name));
  const ordered = [];
  const done = new Set();
  const place = it => {
    if (done.has(it.name)) return;
    done.add(it.name);
    for (const a of it.args) if (names.has(a)) place(added.find(x => x.name === a));   // a state is not a dependency
    ordered.push(it);
  };
  added.forEach(place);

  let text = before;
  for (const it of changed) {
    const cur = q[it.name];
    text = src.spliceFunction(text, cur.source, src.skeleton(it, cur.expression));
    // later splices search by content, so positions shifting is fine
  }
  // tiles to delete are cut out of the module file (nothing reads them: the draft was checked for that); the code
  // as it was goes into the kept record. Blank lines are tidied only where each stood, so no other tile's text
  // (a docstring with blank lines in it, say) changes and no other sign-off goes stale.
  const removedCode = removed.map(n => ({ name: n, code: String(q[n].source.code) }));
  for (const n of removed) text = src.removeFunction(text, q[n].source);
  if (ordered.length) text = src.appendFunctions(text, ordered.map(it => src.skeleton(it)));
  const restore = () => {
    fs.writeFileSync(file, before);
    if (tomlBefore !== null) fs.writeFileSync(tomlFile, tomlBefore);
  };
  if (text !== before) fs.writeFileSync(file, text);
  // the states the tiles read, and the module's sections and reconciliation checks, go into tilekit.toml in the same
  // step, so the model loads with both files changed or neither
  let graph2;
  try {
    if (tomlTouched && toml !== tomlBefore) fs.writeFileSync(tomlFile, toml);
    graph2 = await tk('graph');
  } catch (e) {
    restore();
    throw new Error(`The model would not load with the draft (${e.message}); nothing was changed.`);
  }
  // every tile of the file that the draft does not change or remove must read exactly as it did
  const touched = new Set([...changed.map(i => i.name), ...removed]);
  const moved = Object.entries(q).filter(([n, e]) => e.kind === 'tile' && !touched.has(n) && e.source && path.join(ctx.modelDir, e.source.file) === file &&
    (!graph2.quantities[n] || graph2.quantities[n].source.code !== e.source.code)).map(([n]) => n);
  if (moved.length) {
    restore();
    throw new Error(`Accepting the draft would have changed the text of other tiles (${moved.join(', ')}); nothing was changed.`);
  }
  // With the model loading without them, the removed tiles' tests and review files leave the live folders. They are
  // kept under review/removed/, never deleted. This comes after the load check, so a draft that is put back because
  // the model would not load has archived nothing; if the archive itself fails, it and both files are put back.
  if (removed.length) {
    try {
      archiveRemovedTiles(ctx, moduleId, removedCode, draft.id);
    } catch (e) {
      restore();
      throw new Error(`The records of the removed tiles could not be kept (${e.message}); nothing was changed.`);
    }
  }
  const actions = [];
  if (ordered.length) actions.push(`Added ${count(ordered.length, 'tile skeleton')} to ${moduleId}: ${ordered.map(i => i.name).join(', ')}.`);
  if (removed.length) {
    actions.push(`Removed ${count(removed.length, 'tile')} from ${moduleId}: ${removed.join(', ')}. ` + (removed.length === 1
      ? 'Its code, test, sign-off record, log and stored workbook were kept under review/removed/.'
      : 'Their code, tests, sign-off records, logs and stored workbooks were kept under review/removed/.'));
  }
  if (states.length) actions.push(`Added ${count(states.length, 'carried-forward state')}: ${states.map(x => `${x.name} (from ${x.from})`).join(', ')}.`);
  if (sections) actions.push(sections.length ? `Laid out ${moduleId} in ${count(sections.length, 'section')}: ${sections.map(s => s.title).join(', ')}.` : `Removed the sections of ${moduleId}.`);
  if (checks) actions.push(checks.length ? `Set ${count(checks.length, 'reconciliation check')} for ${moduleId}: ${checks.map(c => c.name).join(', ')}.` : `Removed the reconciliation checks of ${moduleId}.`);
  if (changed.length) actions.push(`Respecified ${changed.map(i => i.name).join(', ')}; ${changed.length === 1 ? 'it is' : 'they are'} now not built.`);
  if (leftAlone.length) actions.push(`Left ${leftAlone.join(', ')} as ${leftAlone.length === 1 ? 'it is' : 'they are'}: ${leftAlone.length === 1 ? 'it already is' : 'they already are'} what the draft says.`);
  const related = await rebuildRelated(ctx, [moduleId]);
  if (related.sentence) actions.push(related.sentence);
  return { accepted: true, actions };
}

async function acceptModuleDraft(ctx, draft) {
  const tk = ctx.tilekit;
  const graph = await tk('graph');
  const { problems } = validateModuleDraft(graph, draft.items);
  if (problems.length) throw new Error('The draft no longer fits the model: ' + problems.join(' '));
  const tomlFile = path.join(ctx.modelDir, 'tilekit.toml');
  const tomlBefore = read(tomlFile);
  const pkg = src.tomlPackage(tomlBefore);
  if (!pkg) throw new Error('tilekit.toml has no package name.');
  const existing = new Set(graph.modules.map(m => m.id));
  const added = draft.items.filter(i => !existing.has(i.id));
  const created = [];
  let toml = tomlBefore;
  const base = exists(path.join(ctx.modelDir, 'src')) ? path.join(ctx.modelDir, 'src') : ctx.modelDir;
  try {
    for (const it of added) {
      let layerPkg = it.layer.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'layer';
      // a layer called "Inputs" must not shadow inputs.py (or params.py) with a package of the same name
      if (exists(path.join(base, pkg, `${layerPkg}.py`)) || /^\d/.test(layerPkg)) layerPkg = `${layerPkg}_layer`;
      const python = `${pkg}.${layerPkg}.${it.id}`;
      const dir = path.join(base, pkg, layerPkg);
      if (!exists(dir)) { fs.mkdirSync(dir, { recursive: true }); created.push(dir); }
      const init = path.join(dir, '__init__.py');
      if (!exists(init)) { fs.writeFileSync(init, ''); created.push(init); }
      const file = path.join(dir, `${it.id}.py`);
      if (exists(file)) throw new Error(`${path.relative(ctx.modelDir, file)} already exists.`);
      fs.writeFileSync(file, `"""${it.title}: ${String(it.purpose || '').replace(/"""/g, '')}"""\n\nimport numpy as np\n`);
      created.push(file);
      toml = src.insertModuleToml(toml, { ...it, python });
    }
    fs.writeFileSync(tomlFile, toml);
    await tk('graph');
  } catch (e) {
    fs.writeFileSync(tomlFile, tomlBefore);
    for (const f of created.reverse()) fs.rmSync(f, { recursive: true, force: true });
    throw new Error(`The draft was not applied (${e.message}); nothing was changed.`);
  }
  const actions = [];
  if (added.length) actions.push(`Added ${count(added.length, 'module')} to tilekit.toml: ${added.map(i => i.id).join(', ')}.`);
  const relinked = draft.items.filter(i => existing.has(i.id));
  if (relinked.length || added.some(i => (i.feeds || []).length)) {
    actions.push('Links follow from tile arguments; they appear once a tile in the fed module reads a quantity from the feeding one.');
  }
  return { accepted: true, actions };
}

module.exports = {
  applyTileCode, whatIf, acceptTileDraft, acceptModuleDraft, moduleFile, caseResultsSentence, fmt, testRel, copyModel,
  rebuildRelated, rebuildTarget, builtSentence,
};
