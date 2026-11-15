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

// `states` are the carried-forward states the draft's tiles need: [{name, from, initial, label, format}]. A state
// takes next month's value from its `from` tile, which must be a tile in the draft or in the model already.
function validateTileDraft(graph, moduleId, items, states = []) {
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
  if (!Array.isArray(items) || !items.length) problems.push('The draft has no tiles.');
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
          'If it is a new parameter, input or tile in another module, ask the user to add it (add_input_request); do not invent it.');
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
  count, downstream, signoffImpact, validateTileDraft, tileDraftSummary, validateModuleDraft, moduleDraftSummary, hasCycle,
};
