'use strict';
// Draft validation and graph helpers (pure functions of the `tilekit graph` / `status` documents).
const { FORMATS, SNAKE, descriptionProblems } = require('./source');

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const count = (n, one, many = one + 's') => `${n < WORDS.length ? WORDS[n] : n} ${n === 1 ? one : many}`;

// Tiles downstream of `name` through arguments and through carried-forward states.
function downstream(graph, name) {
  const q = graph.quantities;
  const statesFrom = {};
  for (const [s, e] of Object.entries(q)) if (e.kind === 'state' && e.from) (statesFrom[e.from] ||= []).push(s);
  const seen = new Set();
  const stack = [name];
  while (stack.length) {
    const n = stack.pop();
    const users = [...((q[n] && q[n].used_by) || [])];
    for (const s of statesFrom[n] || []) users.push(...((q[s] && q[s].used_by) || []));
    for (const u of users) if (u !== name && !seen.has(u)) { seen.add(u); stack.push(u); }
  }
  return graph.order.filter(t => seen.has(t));
}

// Sign-offs that changing tile `name` would make stale, and a sentence saying so (null when none).
function signoffImpact(graph, status, name) {
  const down = downstream(graph, name);
  const signed = t => status.tiles[t] && status.tiles[t].state === 'signed_off';
  const self = signed(name);
  const tiles = down.filter(signed);
  const affected = new Set([name, ...down]);
  const modules = Object.entries(status.modules || {})
    .filter(([id, m]) => m.state === 'signed_off' && graph.modules.some(g => g.id === id && g.tiles.some(t => affected.has(t))))
    .map(([id]) => id);
  const model = status.model && status.model.state === 'signed_off';
  if (!self && !tiles.length && !modules.length && !model) return null;
  const parts = [];
  if (self) parts.push(`\`${name}\`` + (tiles.length ? ` and ${count(tiles.length, 'tile')} downstream` : ''));
  else if (tiles.length) parts.push(`${count(tiles.length, 'tile')} downstream of \`${name}\``);
  if (modules.length) parts.push(`the module sign-off of ${modules.map(m => `\`${m}\``).join(', ')}`);
  if (model) parts.push('the model sign-off');
  const list = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];
  const message = `This un-ticks ${list}.`;
  const detail = [
    self ? `${name}: signed off by ${status.tiles[name].signed_off && status.tiles[name].signed_off.reviewer}; its formula changes, so it needs a full re-review.` : null,
    tiles.length ? `Downstream: ${tiles.join(', ')}. Only their values change; they can be re-confirmed in bulk if their checks pass.` : null,
    modules.length ? `Modules: ${modules.join(', ')}.` : null,
    model ? 'The model sign-off.' : null,
  ].filter(Boolean).join('\n');
  return { self, tiles, modules, model, message, detail };
}

// ---------------------------------------------------------------- tile drafts (module level)

function hasCycle(deps) {
  const state = {};
  const visit = n => {
    if (state[n] === 1) return true;
    if (state[n] === 2) return false;
    state[n] = 1;
    for (const d of deps[n] || []) if (deps[d] && visit(d)) return true;
    state[n] = 2;
    return false;
  };
  return Object.keys(deps).some(visit);
}

// Is the proposed tile `t` exactly what the model's quantity `cur` already is (in module `moduleId`)? Such a tile
// changes nothing, so it is left out of a draft when it is proposed and left alone when the draft is accepted:
// writing its placeholder again would send a built (even signed-off) tile back to not built.
function sameTile(cur, t, moduleId) {
  const norm = x => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  return !!cur && cur.kind === 'tile' && cur.module === moduleId && JSON.stringify(cur.args || []) === JSON.stringify(t.args || [])
    && ['label', 'spec', 'units', 'timing'].every(k => norm(cur[k]) === norm(t[k])) && (cur.format || 'number') === (t.format || 'number')
    && JSON.stringify((cur.assumed || []).map(norm)) === JSON.stringify((t.assumed || []).map(norm));
}

// `states` are the carried-forward states the draft's tiles need: [{name, from, initial, label, format}]. A state
// takes next month's value from its `from` tile, which must be a tile in the draft or in the model already.
function validateTileDraft(graph, moduleId, items, states = [], remove = [], { layoutOnly = false } = {}) {
  const problems = [];
  const warnings = [];
  const q = graph.quantities;
  const names = new Set();
  const stateNames = new Set();
  for (const st of states || []) {
    const n = st.name;
    if (!SNAKE.test(n || '')) { problems.push(`'${n}' is not a snake_case name for a state.`); continue; }
    if (stateNames.has(n)) problems.push(`State ${n} appears twice in the draft.`);
    stateNames.add(n);
    if (q[n]) problems.push(`${n} already exists as a ${q[n].kind}; names are unique across the model.`);
    if ((items || []).some(it => it.name === n)) problems.push(`${n} is proposed both as a tile and as a state.`);
    if (!st.label || !String(st.label).trim()) problems.push(`State ${n} needs a plain-English label.`);
    if (!FORMATS.includes(st.format)) problems.push(`State ${n} has format '${st.format}'; use one of ${FORMATS.join(', ')}.`);
    if (typeof st.initial !== 'number' || !Number.isFinite(st.initial)) problems.push(`State ${n} needs a number for its value in month 1 (initial).`);
    const from = st.from;
    const fromTile = (items || []).some(it => it.name === from) || (q[from] && q[from].kind === 'tile');
    if (!fromTile) problems.push(`State ${n} takes its value from '${from}', which is not a tile in the model or in this draft. Propose that tile in the same draft.`);
  }
  // a draft may also only set the module's sections and checks (layoutOnly): then it needs no tiles
  if ((!Array.isArray(items) || !items.length) && !(remove || []).length && !layoutOnly) problems.push('The draft has no tiles.');
  // Tiles to delete: each is a tile of this module that nothing left in the model reads, directly or as the source
  // of a carried-forward state.
  const gone = new Set((remove || []).map(r => (typeof r === 'string' ? r : r && r.name)));
  for (const n of gone) {
    const e = q[n];
    if (!e || e.kind !== 'tile') { problems.push(`${n} is not a tile in the model, so it cannot be removed.`); continue; }
    if (e.module !== moduleId) { problems.push(`${n} belongs to module ${e.module}, not ${moduleId}.`); continue; }
    if ((items || []).some(it => it.name === n)) problems.push(`${n} is both proposed and removed in this draft.`);
    const readers = (e.used_by || []).filter(u => !gone.has(u));
    const proposedReaders = (items || []).filter(it => (it.args || []).includes(n)).map(it => it.name);
    const all = [...new Set([...readers, ...proposedReaders])];
    if (all.length) problems.push(`${n} cannot be removed: ${all.join(', ')} still read${all.length === 1 ? 's' : ''} it. Change ${all.length === 1 ? 'that tile' : 'those tiles'} first.`);
    const fed = Object.entries(q).filter(([, x]) => x.kind === 'state' && x.from === n).map(([name]) => name);
    if (fed.length) problems.push(`${n} cannot be removed: the carried-forward state ${fed.join(', ')} takes its value from it.`);
  }
  for (const it of items || []) {
    const n = it.name;
    if (!SNAKE.test(n || '')) { problems.push(`'${n}' is not a snake_case name.`); continue; }
    if (names.has(n)) problems.push(`${n} appears twice in the draft.`);
    names.add(n);
    const existing = q[n];
    if (existing && !(existing.kind === 'tile' && existing.module === moduleId)) {
      problems.push(existing.kind === 'tile'
        ? `${n} already exists as a tile in module ${existing.module}; names are unique across the model.`
        : `${n} already exists as a ${existing.kind}; names are unique across the model.`);
    }
    if (!it.label || !String(it.label).trim()) problems.push(`${n} needs a plain-English label.`);
    if (!it.spec || !String(it.spec).trim()) problems.push(`${n} needs a one-line spec.`);
    else for (const pr of descriptionProblems(`"""x.\n\n${it.spec}\n\nUnits: x\n"""`)) problems.push(`${n}: ${pr.replace('The description in the docstring', 'the spec')}`);
    if (!FORMATS.includes(it.format)) problems.push(`${n} has format '${it.format}'; use one of ${FORMATS.join(', ')}.`);
    if (it.format === 'rate' && !/_(pa|pm)$/.test(n)) warnings.push(`${n} is a rate; its name should end _pa or _pm.`);
    if (/end of month/i.test(it.timing || '') && !/_eop$/.test(n)) warnings.push(`${n} is an end-of-month quantity; its name should end _eop.`);
    if (/(beginning|start) of month/i.test(it.timing || '') && !/_bop$/.test(n)) warnings.push(`${n} is a beginning-of-month quantity; its name should end _bop.`);
    const args = it.args || [];
    if (new Set(args).size !== args.length) problems.push(`${n} lists an argument twice.`);
    if (!args.length) problems.push(`${n} has no arguments; every tile reads at least one quantity.`);
  }
  for (const it of items || []) {
    for (const a of it.args || []) {
      if (a === it.name) problems.push(`${it.name} cannot read itself; carry it forward with a state instead.`);
      else if (!q[a] && !names.has(a) && !stateNames.has(a)) {
        problems.push(`Argument '${a}' of ${it.name} is not a quantity in the model and is not proposed in this draft. ` +
          `If it is last month's value of a tile (a carried-forward state such as ${/_bop$/.test(a) ? a : 'units_bop'}), add it to this same draft in \`states\`: {name, from: the tile it takes next month's value from, initial: its value in month 1, label, format}, and call propose_structure again. ` +
          'If it is a new parameter, input or tile in another module, propose it as a draft (propose_params, propose_inputs or propose_cases); do not invent it.');
      }
    }
  }
  if (!problems.length) {
    const deps = {};
    for (const [n, e] of Object.entries(q)) if (e.kind === 'tile') deps[n] = (e.args || []).filter(a => q[a] && q[a].kind === 'tile');
    for (const it of items) deps[it.name] = (it.args || []).filter(a => names.has(a) || (q[a] && q[a].kind === 'tile'));
    if (hasCycle(deps)) problems.push('The draft creates a loop between tiles; carry one of them forward with a state instead.');
  }
  return { problems, warnings };
}

// ---------------------------------------------------------------- module layout: sections and reconciliations

// Problems with a reconciliation expression: only + - * /, parentheses, numbers and names in `known`.
function expressionProblems(expr, known) {
  const s = String(expr == null ? '' : expr);
  if (!s.trim()) return ['it has no expression'];
  const bad = s.replace(/[A-Za-z0-9_.+\-*/()\s]/g, '');
  if (bad) return [`it uses ${[...new Set(bad)].map(c => `'${c}'`).join(', ')}; only + - * /, parentheses, numbers and quantity names are allowed`];
  const toks = s.match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|\.\d+|[-+*/()]|\S/g) || [];
  const problems = [];
  // sum := term (('+'|'-') term)* ; term := factor (('*'|'/') factor)* ; factor := ('+'|'-') factor | number | name | '(' sum ')'
  let i = 0, names = 0;
  const peek = () => toks[i];
  function factor() {
    const t = toks[i];
    if (t === '+' || t === '-') { i++; return factor(); }
    if (t === '(') { i++; sum(); if (toks[i] !== ')') throw new Error('a parenthesis is not closed'); i++; return; }
    if (t === undefined) throw new Error('it ends where a quantity or number is expected');
    if (/^[A-Za-z_]/.test(t)) {
      names++;
      if (!known.has(t)) problems.push(`'${t}' is not a quantity in the model or in this draft`);
      i++; return;
    }
    if (/^(\d|\.\d)/.test(t)) { i++; return; }
    throw new Error(`'${t}' is out of place`);
  }
  function term() { factor(); while (peek() === '*' || peek() === '/') { i++; factor(); } }
  function sum() { term(); while (peek() === '+' || peek() === '-') { i++; term(); } }
  try {
    sum();
    if (i < toks.length) throw new Error(`'${toks[i]}' is out of place`);
  } catch (e) { return [e.message]; }
  if (!names) problems.push('it names no quantity');
  return problems;
}

/**
 * Sections and reconciliation checks of a tiles draft, for module `moduleId`. `sections`: [{title, tiles}] or
 * undefined (not given); `checks`: [{name, label, expression}] or undefined. With `rules` on (when the agent proposes
 * the draft) the house standards of app/standards/building-spreadsheets.md are enforced as well:
 *   - a module that will have more than three tiles is laid out in sections covering every tile;
 *   - a draft with carried-forward states gives a reconciliation check for each (naming the state and its tile).
 * Returns {problems, warnings}.
 */
function validateLayout(graph, moduleId, items = [], states = [], remove = [], sections, checks, { rules = false } = {}) {
  const problems = [];
  const warnings = [];
  const q = graph.quantities;
  const mod = (graph.modules || []).find(m => m.id === moduleId) || { tiles: [] };
  const gone = new Set((remove || []).map(r => (typeof r === 'string' ? r : r && r.name)));
  const itemNames = (items || []).map(i => i && i.name).filter(Boolean);
  const tilesAfter = [...new Set([...(mod.tiles || []).filter(t => !gone.has(t)), ...itemNames])];
  const inModule = new Set(tilesAfter);

  if (sections !== undefined && sections !== null) {
    if (!Array.isArray(sections)) problems.push('sections must be a list of {title, tiles}.');
    else {
      const seen = new Map();
      const titles = new Set();
      sections.forEach((s, k) => {
        const title = s && typeof s.title === 'string' ? s.title.trim() : '';
        const label = title ? `Section '${title}'` : `Section ${k + 1}`;
        if (!title) problems.push(`${label} needs a title that says what the block does (for example "Rates in the period").`);
        else if (titles.has(title.toLowerCase())) problems.push(`Two sections are called '${title}'.`);
        titles.add(title.toLowerCase());
        const tiles = s && Array.isArray(s.tiles) ? s.tiles : [];
        if (!tiles.length) problems.push(`${label} has no tiles.`);
        for (const t of tiles) {
          if (!inModule.has(t)) problems.push(gone.has(t) ? `${label} lists ${t}, which this draft removes.` : `${label} lists ${t}, which is not a tile of ${moduleId} or in this draft.`);
          else if (seen.has(t)) problems.push(`${t} is in two sections ('${seen.get(t)}' and '${title || k + 1}'); a tile belongs to one section.`);
          else seen.set(t, title || String(k + 1));
        }
      });
      const left = tilesAfter.filter(t => !seen.has(t));
      if (left.length && sections.length) {
        (rules ? problems : warnings).push(`The sections leave out ${left.join(', ')}; every tile of ${moduleId} belongs to a section${rules ? '' : ' (they will show after the last section, untitled)'}.`);
      }
    }
  }

  if (checks !== undefined && checks !== null) {
    if (!Array.isArray(checks)) problems.push('checks must be a list of {name, label, expression}.');
    else {
      const known = new Set([...Object.keys(q).filter(n => !gone.has(n)), ...itemNames, ...(states || []).map(s => s && s.name).filter(Boolean)]);
      const names = new Set();
      for (const c of checks) {
        const n = c && c.name;
        if (!SNAKE.test(n || '')) { problems.push(`'${n}' is not a snake_case name for a reconciliation check.`); continue; }
        if (names.has(n)) problems.push(`The check ${n} appears twice in the draft.`);
        names.add(n);
        if (!c.label || !String(c.label).trim()) problems.push(`The check ${n} needs a plain-English label (for example "Units roll-forward reconciles").`);
        for (const p of expressionProblems(c.expression, known)) problems.push(`The check ${n}: ${p}.`);
      }
    }
  }

  // a tile that goes must not be left in one of the module's current checks (a draft that gives checks replaces them)
  if (gone.size && !Array.isArray(checks)) {
    for (const c of Array.isArray(mod.checks) ? mod.checks : []) {
      const uses = (String(c.expression || '').match(/[A-Za-z_]\w*/g) || []).filter(n => gone.has(n));
      if (uses.length) problems.push(`The reconciliation check ${c.name} uses ${[...new Set(uses)].join(', ')}, which this draft removes. Give the module's checks again in \`checks\` (with propose_structure), without it.`);
    }
  }

  if (rules && (items || []).length) {
    const given = Array.isArray(sections) && sections.length;
    if (tilesAfter.length > 3 && !given) {
      const titled = (mod.sections || []).filter(s => s && s.title);
      const covered = new Set(titled.flatMap(s => s.tiles || []));
      if (!titled.length || tilesAfter.some(t => !covered.has(t))) {
        problems.push(`${moduleId} will have ${tilesAfter.length} tiles, so the house standard asks for it to be laid out in named sections that read top to bottom as the calculation does (typically the rates or factors applying in the period, then the roll-forward or the cashflows, then results). Give \`sections\` in this draft: [{title, tiles}] covering every tile (${tilesAfter.join(', ')})` +
          (titled.length ? `; the module's current sections are ${titled.map(s => `'${s.title}' (${(s.tiles || []).join(', ')})`).join(', ')}, so repeat them with the new tiles placed.` : '.'));
      }
    }
    for (const st of mod.timing === 'backward' ? [] : states || []) {
      if (!st || !st.name) continue;
      const uses = c => { const toks = new Set(String((c && c.expression) || '').match(/[A-Za-z_]\w*/g) || []); return toks.has(st.name) && toks.has(st.from); };
      if (!Array.isArray(checks) || !checks.length) {
        problems.push(`The carried-forward state ${st.name} makes a roll-forward, so the house standard asks for a reconciliation check with it: give \`checks\` in this draft, for example {name: "${st.name.replace(/_bop$/, '')}_reconcile", label: "${String(st.label || st.name).replace(/^Opening /i, '')} roll-forward reconciles", expression: "${st.name} + <movements in> - <movements out> - ${st.from}"} (opening plus movements minus closing is zero).`);
        break;
      }
      if (!checks.some(uses)) problems.push(`No reconciliation check uses both the opening value ${st.name} and the closing value ${st.from}; add one: opening plus movements minus closing is zero.`);
    }
  }
  return { problems, warnings };
}

function layoutSummary(sections, checks) {
  const parts = [];
  if (Array.isArray(sections) && sections.length) parts.push(`in ${count(sections.length, 'section')}`);
  if (Array.isArray(checks) && checks.length) parts.push(`with ${count(checks.length, 'reconciliation check')}`);
  return parts.join(' ');
}

function tileDraftSummary(graph, items) {
  const q = graph.quantities;
  const added = items.filter(i => !q[i.name]);
  const changed = items.filter(i => q[i.name]);
  const rerouted = changed.filter(i => JSON.stringify(i.args) !== JSON.stringify(q[i.name].args));
  const respec = changed.length - rerouted.length;
  let links = 0;
  for (const i of rerouted) {
    const old = new Set(q[i.name].args);
    const now = new Set(i.args);
    links += Math.max([...now].filter(a => !old.has(a)).length, [...old].filter(a => !now.has(a)).length);
  }
  const parts = [];
  if (added.length) parts.push(`adds ${count(added.length, 'tile')}`);
  if (links) parts.push(`reroutes ${count(links, 'link')}`);
  if (respec) parts.push(`respecifies ${count(respec, 'tile')}`);
  return parts.join(', ') || 'changes nothing';
}

// ---------------------------------------------------------------- module drafts (model level)

function validateModuleDraft(graph, items) {
  const problems = [];
  const warnings = [];
  const existing = new Set(graph.modules.map(m => m.id));
  const ids = new Set();
  if (!Array.isArray(items) || !items.length) problems.push('The draft has no modules.');
  for (const it of items || []) {
    if (!SNAKE.test(it.id || '')) { problems.push(`'${it.id}' is not a snake_case module id.`); continue; }
    if (ids.has(it.id)) problems.push(`${it.id} appears twice in the draft.`);
    ids.add(it.id);
    if (!existing.has(it.id) && graph.quantities[it.id]) problems.push(`${it.id} is already the name of a quantity; pick another module id.`);
    if (!graph.layers.includes(it.layer)) problems.push(`${it.id} has layer '${it.layer}'; use one of ${graph.layers.join(', ')}.`);
    if (!it.title || !String(it.title).trim()) problems.push(`${it.id} needs a title.`);
    if (!existing.has(it.id) && !(it.purpose || '').trim()) problems.push(`${it.id} needs a one-line purpose.`);
    if (it.timing !== undefined && !['step', 'backward', 'summary'].includes(it.timing)) problems.push(`${it.id} has timing '${it.timing}'; use step (each month), backward (each month from the last to the first) or summary (once, after the projection).`);
    const was = graph.modules.find(m => m.id === it.id);
    if (was && it.timing !== undefined && (was.timing || 'step') !== it.timing) problems.push(`${it.id} already exists with timing ${was.timing || 'step'}; a module's timing is set when it is created.`);
  }
  const all = new Set([...existing, ...ids]);
  for (const it of items || []) {
    for (const f of it.feeds || []) {
      if (f === it.id) problems.push(`${it.id} cannot feed itself.`);
      else if (!all.has(f)) problems.push(`${it.id} feeds '${f}', which is neither an existing nor a proposed module.`);
    }
  }
  if (!problems.length) {
    const feeds = {};
    for (const m of graph.modules) feeds[m.id] = [...m.feeds];
    for (const it of items) feeds[it.id] = [...(it.feeds || [])];
    if (hasCycle(feeds)) problems.push('The links form a loop between modules; modules must run in one direction.');
    const order = graph.layers;
    const layerOf = id => (items.find(i => i.id === id) || graph.modules.find(m => m.id === id) || {}).layer;
    for (const it of items) {
      for (const f of it.feeds || []) {
        if (order.indexOf(layerOf(f)) < order.indexOf(it.layer)) warnings.push(`${it.id} (${it.layer}) feeds ${f} in an earlier layer (${layerOf(f)}).`);
      }
    }
  }
  return { problems, warnings };
}

function moduleDraftSummary(graph, items) {
  const existing = Object.fromEntries(graph.modules.map(m => [m.id, m]));
  const added = items.filter(i => !existing[i.id]);
  let links = 0;
  for (const i of items) {
    const old = new Set(existing[i.id] ? existing[i.id].feeds : []);
    const now = new Set(i.feeds || []);
    if (existing[i.id]) links += [...now].filter(f => !old.has(f)).length + [...old].filter(f => !now.has(f)).length;
    else links += now.size;
  }
  const parts = [];
  if (added.length) parts.push(`adds ${count(added.length, 'module')}`);
  if (links) parts.push(`${added.length ? 'with' : 'reroutes'} ${count(links, 'link')}`);
  return parts.join(' ') || 'changes nothing';
}

module.exports = {
  count, downstream, signoffImpact, sameTile, validateTileDraft, tileDraftSummary, validateModuleDraft, moduleDraftSummary, hasCycle,
  validateLayout, layoutSummary, expressionProblems,
};
