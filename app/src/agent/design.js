'use strict';
// The design stage of scaffolding: the whole model laid out and agreed before anything is built. A design is a draft
// like any other (kind "design"); accepting it writes design.json at the top of the model folder and nothing else.
// Validation is pure and enforces the checkable rules of app/standards/designing-models.md. Later module and tile
// drafts are compared with the accepted design and say where they depart from it (warnings, never refusals).
const fs = require('fs');
const path = require('path');
const { SNAKE, descriptionProblems } = require('./source');
const { count, hasCycle, expressionProblems } = require('./validate');

const STEPS = ['choose', 'convert', 'apply', 'limit', 'combine'];
const MEASURES = ['amount', 'proportion', 'weighted', 'rate', 'other'];
const INPUT_KINDS = ['field', 'lookup', 'time'];
const CASE_ID = /^[a-z0-9][a-z0-9_]*$/;
const LIMIT_WORDS = /\b(not below|not above|capped|floored|limited to|at most|at least|no more than|no less than|the greater of|the lesser of|the smaller of|the larger of)\b/i;

const FILE = 'design.json';
const designFile = modelDir => path.join(modelDir, FILE);

function loadDesign(modelDir) {
  try { const d = JSON.parse(fs.readFileSync(designFile(modelDir), 'utf8')); return d && Array.isArray(d.modules) ? d : null; } catch { return null; }
}

const list = x => (Array.isArray(x) ? x : []);
const text = x => (typeof x === 'string' ? x.trim() : '');

// The design as it is stored: only the fields this file knows, trimmed.
function normalise(d = {}) {
  return {
    summary: text(d.summary),
    order_in_month: list(d.order_in_month).map(text).filter(Boolean),
    results: list(d.results).map(String),
    modules: list(d.modules).map(m => ({
      id: m && m.id, title: text(m && m.title), layer: m && m.layer, timing: (m && m.timing) || 'step', purpose: text(m && m.purpose), weights: !!(m && m.weights),
      tiles: list(m && m.tiles).map(t => ({
        name: t && t.name, label: text(t && t.label), reads: list(t && t.reads).map(String), spec: text(t && t.spec), step: t && t.step, measure: t && t.measure,
        timing: text(t && t.timing), branches: list(t && t.branches).map(b => ({ when: text(b && b.when), case: b && b.case })), assumed: list(t && t.assumed).map(text).filter(Boolean),
      })),
      states: list(m && m.states).map(s => ({ name: s && s.name, from: s && s.from, initial: s && s.initial, label: text(s && s.label) })),
      checks: list(m && m.checks).map(c => ({ label: text(c && c.label), expression: text(c && c.expression).replace(/\s+/g, ' ') })),
    })),
    model_point_fields: list(d.model_point_fields).map(f => ({ name: f && f.name, label: text(f && f.label) })),
    inputs: list(d.inputs).map(i => ({ name: i && i.name, label: text(i && i.label), kind: i && i.kind })),
    params: list(d.params).map(p => ({ name: p && p.name, label: text(p && p.label) })),
    tables: list(d.tables).map(t => ({ name: t && t.name, label: text(t && t.label) })),
    cases: list(d.cases).map(c => ({ id: c && c.id, name: text(c && c.name), purpose: text(c && c.purpose) })),
  };
}

/**
 * graph: `tilekit graph`; d: a normalised design; caseIds: the ids of the model's existing cases.
 * Returns {problems, warnings}. Problems stop the draft; warnings are shown with it.
 */
function validateDesign(graph, d, caseIds = []) {
  const problems = [], warnings = [];
  const q = (graph && graph.quantities) || {};
  const layers = (graph && graph.layers) || [];

  // ---- names: one name, one thing, whatever the case of the letters
  const kind = {};                      // design name -> 'tile' | 'state' | 'input' | 'param'
  const lower = new Map();
  const claim = (n, k, what) => {
    if (!SNAKE.test(n || '')) { problems.push(`'${n}' is not a snake_case name for ${what}.`); return false; }
    const was = lower.get(n.toLowerCase());
    if (was) { problems.push(was === n ? `${n} is named twice in the design; names are unique across the model.` : `${n} differs from ${was} only by case; Excel names ignore case.`); return false; }
    if (q[n] && q[n].kind !== k) { problems.push(`${n} already exists in the model as a ${q[n].kind}; names are unique across the model.`); return false; }
    lower.set(n.toLowerCase(), n); kind[n] = k; return true;
  };
  const fields = new Set();
  for (const f of d.model_point_fields) {
    if (!SNAKE.test(f.name || '')) { problems.push(`'${f.name}' is not a snake_case name for a model-point field.`); continue; }
    if (fields.has(f.name)) problems.push(`The model-point field ${f.name} is listed twice.`);
    fields.add(f.name);
    if (!f.label) problems.push(`The model-point field ${f.name} needs a plain-English label.`);
  }
  for (const i of d.inputs) {
    if (!claim(i.name, 'input', 'an input series')) continue;
    if (!i.label) problems.push(`The input ${i.name} needs a plain-English label.`);
    if (!INPUT_KINDS.includes(i.kind)) problems.push(`The input ${i.name} has kind '${i.kind}'; an input series is data only: a model-point field as it is (field), a value looked up from a table (lookup) or time bookkeeping (time). Anything with an actuarial choice in it is a function in a module.`);
    else if (i.kind === 'field' && !fields.has(i.name)) problems.push(`The input ${i.name} is a model-point field passed through, but ${i.name} is not in model_point_fields.`);
  }
  for (const p of d.params) { if (claim(p.name, 'param', 'a parameter') && !p.label) problems.push(`The parameter ${p.name} needs a plain-English label.`); }

  // ---- modules, in calculation order
  const moduleIds = new Set();
  const home = {};                      // tile or state -> index of its module
  const measure = {};                   // tile or state -> measure
  const tiles = [];                     // {t, m, k}
  if (!d.modules.length) problems.push('The design has no modules.');
  d.modules.forEach((m, k) => {
    if (!SNAKE.test(m.id || '')) { problems.push(`'${m.id}' is not a snake_case module id.`); return; }
    if (moduleIds.has(m.id)) problems.push(`The module ${m.id} is listed twice.`);
    moduleIds.add(m.id);
    if (!m.title) problems.push(`The module ${m.id} needs a title.`);
    if (!m.purpose) problems.push(`The module ${m.id} needs a one-sentence purpose: the one question it answers for a reviewer.`);
    else if (m.purpose.split(/[.;]\s+\S/).length > 1) warnings.push(`The purpose of ${m.id} takes more than one sentence; a module answers one reviewer question, so check whether it is two modules.`);
    if (layers.length && !layers.includes(m.layer)) problems.push(`The module ${m.id} has layer '${m.layer}'; use one of ${layers.join(', ')}.`);
    if (!['step', 'summary'].includes(m.timing)) problems.push(`The module ${m.id} has timing '${m.timing}'; use step (each month) or summary (once, after the projection).`);
    if (!m.tiles.length) problems.push(`The module ${m.id} has no functions.`);
    for (const t of m.tiles) {
      if (!claim(t.name, 'tile', 'a function')) continue;
      home[t.name] = k; measure[t.name] = t.measure; tiles.push({ t, m, k });
    }
  });
  d.modules.forEach((m, k) => {
    for (const s of m.states) {
      if (!claim(s.name, 'state', 'a carried value')) continue;
      home[s.name] = k;
      if (!s.label) problems.push(`The carried value ${s.name} needs a plain-English label.`);
      if (typeof s.initial !== 'number' || !Number.isFinite(s.initial)) problems.push(`The carried value ${s.name} needs a number for its value in month 1 (initial).`);
      if (kind[s.from] !== 'tile') problems.push(`The carried value ${s.name} takes its value from '${s.from}', which is not a function in the design.`);
      else if (home[s.from] !== k) problems.push(`The carried value ${s.name} is listed under ${m.id} but takes its value from ${s.from} in ${d.modules[home[s.from]].id}; a roll-forward and its carried value belong to one module.`);
      else measure[s.name] = measure[s.from];
    }
    if (m.timing === 'summary' && (m.states.length || m.checks.length)) problems.push(`The module ${m.id} runs once after the projection, so it cannot have carried values or reconciliations.`);
    if (m.states.length > 1) warnings.push(`The module ${m.id} has ${count(m.states.length, 'carried value')}. The standard is one roll-forward per module; keep them together only if they cannot be reviewed apart.`);
  });

  // ---- functions
  const known = n => !!kind[n] || !!q[n];
  const readBy = {};
  const cases = new Set([...caseIds, ...d.cases.map(c => c.id)]);
  for (const { t, m, k } of tiles) {
    const n = t.name;
    if (!t.label) problems.push(`${n} needs a plain-English label.`);
    if (!t.spec) problems.push(`${n} needs a one-sentence spec.`);
    else for (const pr of descriptionProblems(`"""x.\n\n${t.spec}\n\nUnits: x\n"""`)) problems.push(`${n}: ${pr.replace('The description in the docstring', 'the spec')}`);
    if (!STEPS.includes(t.step)) problems.push(`${n} has step '${t.step}'; say which one step it does: ${STEPS.join(', ')}.`);
    if (!MEASURES.includes(t.measure)) problems.push(`${n} has measure '${t.measure}'; use one of ${MEASURES.join(', ')} (amount: per policy in force; proportion: in force or a decrement; weighted: an amount times a proportion).`);
    if (m.timing === 'step' && !t.timing) problems.push(`${n} needs its timing: where in the month's order it sits.`);
    if (!t.reads.length) problems.push(`${n} reads nothing; every function reads at least one quantity.`);
    if (new Set(t.reads).size !== t.reads.length) problems.push(`${n} lists a quantity it reads twice.`);
    for (const a of t.reads) {
      if (a === n) { problems.push(`${n} cannot read itself; carry it forward as a carried value instead.`); continue; }
      (readBy[a] ||= []).push(n);
      if (!known(a)) { problems.push(fields.has(a) ? `${n} reads the model-point field ${a} directly; functions read input series, so list ${a} in inputs with kind field.` : `${n} reads '${a}', which is not a function, carried value, input or parameter in the design or the model.`); continue; }
      if (kind[a] === 'tile' && home[a] > k) problems.push(`${n} (in ${m.id}) reads ${a} from ${d.modules[home[a]].id}, a later module. Modules are listed in calculation order and read only from earlier ones; move the function or reorder the modules.`);
      if (kind[a] === 'tile' && layers.length && layers.indexOf(d.modules[home[a]].layer) > layers.indexOf(m.layer)) problems.push(`${n} (layer ${m.layer}) reads ${a} from a later layer (${d.modules[home[a]].layer}).`);
      if (kind[a] === 'tile' && d.modules[home[a]].timing === 'summary' && m.timing === 'step') problems.push(`${n} runs each month but reads ${a}, which is only known after the projection.`);
    }
    // one step per function: a cap or floor is its own function
    if (t.spec && t.step && t.step !== 'limit' && LIMIT_WORDS.test(t.spec)) warnings.push(`${n} is a '${t.step}' step but its spec limits a value ("${t.spec.match(LIMIT_WORDS)[0]}"). A cap or floor is its own function: the value before the limit, then the limit.`);
    // every branch has a case that takes it
    if (t.step === 'choose' || t.step === 'limit') {
      if (t.branches.length < 2) problems.push(`${n} ${t.step === 'choose' ? 'chooses between values' : 'limits a value'}, so it has at least two branches. List each in branches with the case that takes it: [{when, case}].`);
      for (const b of t.branches) {
        if (!b.when) problems.push(`A branch of ${n} does not say when it applies.`);
        if (!cases.has(b.case)) problems.push(`The branch "${b.when}" of ${n} names the case '${b.case}', which is not a case in the design or the model.`);
      }
    }
    // per-policy amounts and the weighting stay apart
    const reads = t.reads.filter(a => measure[a]);
    const mixes = reads.some(a => measure[a] === 'amount') && reads.some(a => measure[a] === 'proportion');
    if (mixes && !m.weights) problems.push(`${n} multiplies a per-policy amount (${reads.filter(a => measure[a] === 'amount').join(', ')}) by an in-force or decrement proportion (${reads.filter(a => measure[a] === 'proportion').join(', ')}) in ${m.id}. Only a module marked weights: true does that, normally the cash flow module.`);
    if (t.measure === 'weighted' && !m.weights) problems.push(`${n} is a weighted amount but ${m.id} is not marked weights: true.`);
    if (mixes && t.measure !== 'weighted') problems.push(`${n} reads a per-policy amount and a proportion, so its measure is weighted.`);
  }

  // ---- no loops (a loop through a carried value is not one)
  if (!problems.length) {
    const deps = {};
    for (const { t } of tiles) deps[t.name] = t.reads.filter(a => kind[a] === 'tile');
    if (hasCycle(deps)) problems.push('The design has a loop between functions; carry one of them forward as a carried value instead.');
  }

  // ---- work backward from the results: nothing that nothing reads
  if (!d.results.length) problems.push('Name the results the model is for in results: the functions whose values are the output.');
  for (const r of d.results) if (kind[r] !== 'tile') problems.push(`The result '${r}' is not a function in the design.`);
  const results = new Set(d.results);
  const sources = new Set(d.modules.flatMap(m => m.states.map(s => s.from)));
  const checked = new Set(d.modules.flatMap(m => m.checks.flatMap(c => c.expression.match(/[A-Za-z_]\w*/g) || [])));
  for (const { t, m } of tiles) {
    if (!(readBy[t.name] || []).length && !results.has(t.name) && !sources.has(t.name) && !checked.has(t.name)) {
      problems.push(`Nothing reads ${t.name} (in ${m.id}) and it is not a result. Work backward from the results: drop it, or name what reads it.`);
    }
  }
  for (const i of d.inputs) if (kind[i.name] === 'input' && !(readBy[i.name] || []).length) warnings.push(`No function reads the input ${i.name}.`);
  for (const p of d.params) if (kind[p.name] === 'param' && !(readBy[p.name] || []).length) warnings.push(`No function reads the parameter ${p.name}; keep it only if an input series is worked out from it.`);

  // ---- each thing worked out once
  const bySig = new Map();
  for (const { t } of tiles) {
    if (t.reads.length < 2) continue;
    const sig = t.step + '|' + [...t.reads].sort().join(',');
    if (bySig.has(sig)) warnings.push(`${t.name} and ${bySig.get(sig)} do the same step on the same quantities; work each thing out once and read it where it is needed.`);
    else bySig.set(sig, t.name);
  }

  // ---- a reconciliation for every roll-forward
  const names = new Set([...Object.keys(kind), ...Object.keys(q)]);
  for (const m of d.modules) {
    for (const c of m.checks) {
      if (!c.label) problems.push(`A reconciliation of ${m.id} needs a plain-English label.`);
      for (const p of expressionProblems(c.expression, names)) problems.push(`The reconciliation "${c.label || c.expression}" of ${m.id}: ${p}.`);
    }
    for (const s of m.states) {
      const uses = c => { const toks = new Set(c.expression.match(/[A-Za-z_]\w*/g) || []); return toks.has(s.name) && toks.has(s.from); };
      if (kind[s.name] === 'state' && !m.checks.some(uses)) problems.push(`The carried value ${s.name} makes a roll-forward in ${m.id}, so the module needs a reconciliation naming both ${s.name} and ${s.from}: opening plus movements minus closing is zero.`);
    }
  }

  // ---- a narrow interface
  d.modules.forEach((m, k) => {
    const out = m.tiles.filter(t => (readBy[t.name] || []).some(r => home[r] !== k));
    if (m.tiles.length >= 5 && out.length > m.tiles.length / 2) warnings.push(`Other modules read ${out.length} of the ${m.tiles.length} functions of ${m.id}. A module hands on a few quantities; check where it is cut.`);
  });

  // ---- timing stated once, and cases
  if (d.modules.some(m => m.timing === 'step') && !d.order_in_month.length) problems.push('State the order of events within a month once, in order_in_month (for example premium, interest, withdrawals, deaths, surrenders).');
  if (!d.cases.length && !caseIds.length) problems.push('The design has no cases. Design the cases with the functions, so that every branch has a case that takes it.');
  const ids = new Set();
  for (const c of d.cases) {
    if (!CASE_ID.test(c.id || '')) { problems.push(`'${c.id}' is not a valid case id (lower-case letters, digits and underscores).`); continue; }
    if (ids.has(c.id)) problems.push(`The case ${c.id} is listed twice.`);
    ids.add(c.id);
    if (!c.name) problems.push(`The case ${c.id} needs a name.`);
    if (!c.purpose) problems.push(`The case ${c.id} needs a purpose: what it exercises.`);
  }
  return { problems: [...new Set(problems)], warnings: [...new Set(warnings)] };
}

function designCounts(d) {
  return {
    modules: d.modules.length, tiles: d.modules.reduce((n, m) => n + m.tiles.length, 0), states: d.modules.reduce((n, m) => n + m.states.length, 0),
    checks: d.modules.reduce((n, m) => n + m.checks.length, 0), cases: d.cases.length,
  };
}

function designSummary(d) {
  const c = designCounts(d);
  return `designs ${count(c.modules, 'module')} with ${count(c.tiles, 'function')}, ${count(c.states, 'carried value')}, ${count(c.checks, 'reconciliation')} and ${count(c.cases, 'case')}`;
}

// Where a later draft departs from the accepted design. `design` may be null (no design: nothing to say).
function moduleDepartures(design, modules) {
  if (!design) return [];
  const byId = Object.fromEntries(design.modules.map(m => [m.id, m]));
  const out = [];
  for (const m of modules || []) {
    const want = byId[m.id];
    if (!want) out.push(`Departs from the agreed design: the module ${m.id} is not in it.`);
    else if (want.layer !== m.layer) out.push(`Departs from the agreed design: ${m.id} is in layer ${m.layer}; the design has ${want.layer}.`);
  }
  return out;
}

function tileDepartures(design, moduleId, tiles) {
  if (!design) return [];
  const mod = design.modules.find(m => m.id === moduleId);
  if (!mod) return (tiles || []).length ? [`Departs from the agreed design: the module ${moduleId} is not in it.`] : [];
  const byName = Object.fromEntries(mod.tiles.map(t => [t.name, t]));
  const elsewhere = Object.fromEntries(design.modules.flatMap(m => m.tiles.map(t => [t.name, m.id])));
  const out = [];
  for (const t of tiles || []) {
    const want = byName[t.name];
    if (!want) { out.push(`Departs from the agreed design: ${t.name} is ${elsewhere[t.name] ? `in ${elsewhere[t.name]} there, not ${moduleId}` : `not in it for ${moduleId}`}.`); continue; }
    const a = [...(t.args || [])].sort(), b = [...want.reads].sort();
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const extra = a.filter(x => !b.includes(x)), less = b.filter(x => !a.includes(x));
      out.push(`Departs from the agreed design: ${t.name}${extra.length ? ` also reads ${extra.join(', ')}` : ''}${extra.length && less.length ? ' and' : ''}${less.length ? ` does not read ${less.join(', ')}` : ''}.`);
    }
  }
  return out;
}

// Accepting a design writes design.json and nothing else: no module, tile, parameter, input or case is created.
function acceptDesignDraft(svc, draft) {
  const d = normalise(draft.design);
  const had = fs.existsSync(designFile(svc.modelDir));
  fs.writeFileSync(designFile(svc.modelDir), JSON.stringify({ version: 1, ...d, accepted_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }, null, 2) + '\n');
  const c = designCounts(d);
  return { accepted: true, actions: [`${had ? 'Replaced' : 'Saved'} the agreed design in ${FILE} (${count(c.modules, 'module')}, ${count(c.tiles, 'function')}). Nothing has been built.`] };
}

module.exports = {
  STEPS, MEASURES, INPUT_KINDS, FILE, loadDesign, normalise, validateDesign, designSummary, designCounts, moduleDepartures, tileDepartures, acceptDesignDraft,
};
