'use strict';
// Operations that change (or simulate changing) the model: write one tile, what-if, accept drafts.
// Every function takes `ctx` = {modelDir, tilekit, confirm, runPytest}.
const fs = require('fs');
const os = require('os');
const path = require('path');
const src = require('./source');
const { signoffImpact, validateTileDraft, validateModuleDraft, count } = require('./validate');

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
  try { after = src.spliceFunction(before, q.source, code); } catch (e) { return fail(e.message); }
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

  let testText = '';
  if (ctx.runPytest && exists(testFile)) {
    const r = await ctx.runPytest(testRel(name));
    testText = r.passed ? 'the hand-calculation test passes' : 'the hand-calculation test fails';
    lines.push(r.passed ? 'Hand-calculation test passes.' : 'Hand-calculation test FAILS:\n' + r.output);
  }
  actions.push(buildText + (testText ? `; ${testText}.` : '.'));
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
      fs.writeFileSync(file, src.spliceFunction(read(file), q.source, code));
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

async function acceptTileDraft(ctx, draft) {
  const tk = ctx.tilekit;
  const graph = await tk('graph');
  const moduleId = draft.scope.id;
  const { problems } = validateTileDraft(graph, moduleId, draft.items);
  if (problems.length) throw new Error('The draft no longer fits the model: ' + problems.join(' '));
  const file = moduleFile(ctx, graph, moduleId);
  const before = read(file);
  const q = graph.quantities;
  const added = draft.items.filter(i => !q[i.name]);
  const changed = draft.items.filter(i => q[i.name]);

  if (changed.length) {
    const status = await tk('status');
    const impacts = changed.map(i => signoffImpact(graph, status, i.name)).filter(Boolean);
    if (impacts.length) {
      const ok = await ctx.confirm({
        title: 'Accept draft?', message: impacts.map(x => x.message).join(' ') + ' Accept the draft anyway?',
        detail: impacts.map(x => x.detail).join('\n'),
      });
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
    for (const a of it.args) if (names.has(a)) place(added.find(x => x.name === a));
    ordered.push(it);
  };
  added.forEach(place);

  let text = before;
  for (const it of changed) {
    const cur = q[it.name];
    text = src.spliceFunction(text, cur.source, src.skeleton(it, cur.expression));
    // later splices search by content, so positions shifting is fine
  }
  text = src.appendFunctions(text, ordered.map(it => src.skeleton(it)));
  fs.writeFileSync(file, text);
  try {
    await tk('graph');
  } catch (e) {
    fs.writeFileSync(file, before);
    throw new Error(`The model would not load with the draft (${e.message}); nothing was changed.`);
  }
  const actions = [];
  if (ordered.length) actions.push(`Added ${count(ordered.length, 'tile skeleton')} to ${moduleId}: ${ordered.map(i => i.name).join(', ')}.`);
  if (changed.length) actions.push(`Respecified ${changed.map(i => i.name).join(', ')}; ${changed.length === 1 ? 'it is' : 'they are'} now not built.`);
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
      const layerPkg = it.layer.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
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

module.exports = { applyTileCode, whatIf, acceptTileDraft, acceptModuleDraft, moduleFile, caseResultsSentence, fmt, testRel, copyModel };
