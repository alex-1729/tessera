'use strict';
// Sign-off requests. The agent can only PREPARE a sign-off (prepareSignoff / prepareReconfirm build a request
// that the window shows with a button). Recording one (performRequest) runs `tilekit signoff` / `reconfirm`
// and is reachable only from the service's confirmSignoff, which the window calls on the reviewer's click.
// The tools never receive the unguarded tilekit runner, so they cannot run either command.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { count } = require('./validate');

const VALUES_ONLY_BLOCKER = 'This tile cannot be written as an Excel formula. Sign-off needs a values-only acknowledgement.';

function entryOf(status, kind, name) {
  if (kind === 'tile') return status.tiles[name] || null;
  if (kind === 'module') return status.modules[name] || null;
  return status.model || null;
}

// The stored workbook's stamp (from its sidecar), with the content digest, or null when unbuilt.
function storedStamp(modelDir, entry) {
  if (!entry || !entry.workbook) return null;
  const sidecar = path.join(modelDir, entry.workbook.replace(/\.xlsx$/, '.json'));
  try {
    const doc = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    return doc.stamp ? { stamp: doc.stamp, digest: doc.content_digest || null } : null;
  } catch { return null; }
}

const sameStamp = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

function caseList(entry, cases) {
  const names = Object.fromEntries((cases || []).map(c => [c.id, c.name]));
  return Object.entries((entry && entry.case_results) || {}).map(([id, r]) => ({ id, name: names[id] || id, pass: r.pass }));
}

/**
 * The request for signing off one item. target = {kind: 'tile'|'module'|'model', name}.
 * Returns the request (not saved) or throws when the item does not exist.
 */
async function prepareSignoff(tk, modelDir, scope, target) {
  const [graph, status, casesDoc] = await Promise.all([tk('graph'), tk('status'), tk('cases')]);
  const { kind } = target;
  let name = target.name;
  let label, spec = null, formula = null, assumed = [], checks = null;
  if (kind === 'tile') {
    const q = graph.quantities[name];
    if (!q || q.kind !== 'tile') throw new Error(`${name} is not a tile in the model.`);
    label = q.label; spec = q.spec; formula = (status.tiles[name] || {}).formula || q.formula; assumed = q.assumed || [];
  } else if (kind === 'module') {
    const m = graph.modules.find(x => x.id === name);
    if (!m) throw new Error(`${name} is not a module in the model.`);
    label = m.title;
    assumed = m.tiles.flatMap(t => (graph.quantities[t].assumed || []).map(a => `${t}: ${a}`));
    spec = `${m.tiles.length} tiles: ${m.tiles.join(', ')}.`;
  } else if (kind === 'model') {
    name = graph.model.name;
    label = graph.model.name;
    assumed = graph.order.flatMap(t => (graph.quantities[t].assumed || []).map(a => `${t}: ${a}`));
  } else throw new Error(`Cannot sign off a ${kind}.`);
  const entry = entryOf(status, kind, name);
  if (!entry) throw new Error(kind === 'module' ? `Module ${name} has no tiles to sign off.` : `${name} has no review status.`);
  if (entry.checks) checks = entry.checks.map(c => ({ name: c.name, pass: !!c.pass }));
  const valuesOnly = kind === 'tile' && !!entry.values_only;
  return {
    id: store.newRequestId(), kind, name, label, spec, formula, assumed,
    cases: kind === 'tile' ? caseList(entry, casesDoc.cases) : [],
    ...(checks ? { checks } : {}),
    blockers: (entry.blockers || []).filter(b => !(valuesOnly && b === VALUES_ONLY_BLOCKER)),
    values_only: valuesOnly,
    state: entry.state,
    stamp: storedStamp(modelDir, entry),
    workbook_current: !!entry.workbook_current,
    scope, at: store.now(), status: 'pending',
  };
}

// Tiles `tilekit reconfirm` would renew (the same test it applies), and the others with values drift.
function reconfirmable(status, graph, moduleId) {
  const names = graph.order.filter(n => !moduleId || graph.quantities[n].module === moduleId);
  const tiles = [], skipped = [];
  for (const n of names) {
    const e = status.tiles[n];
    if (!e || e.state !== 'stale' || e.drift !== 'values' || !e.signed_off) continue;
    if (e.formula !== e.signed_formula) skipped.push({ name: n, reason: 'the formula has changed since sign-off; review it again' });
    else if (e.values_only) skipped.push({ name: n, reason: 'values-only tile; sign it off again on its own' });
    else if (!e.workbook_current) skipped.push({ name: n, reason: 'workbook needs a rebuild' });
    // `reconfirm_blockers` is the tooling's own list for a re-confirmation (a test unchanged since sign-off need not be run again)
    else if (e.reconfirm_blockers ? e.reconfirm_blockers.length : !e.can_sign_off) skipped.push({ name: n, reason: (e.reconfirm_blockers || e.blockers || []).join(' ') });
    else tiles.push(n);
  }
  return { tiles, skipped };
}

async function prepareReconfirm(tk, modelDir, scope, moduleId) {
  const [graph, status] = await Promise.all([tk('graph'), tk('status')]);
  if (moduleId && !graph.modules.some(m => m.id === moduleId)) throw new Error(`${moduleId} is not a module in the model.`);
  const { tiles, skipped } = reconfirmable(status, graph, moduleId);
  const stamps = Object.fromEntries(tiles.map(t => [t, storedStamp(modelDir, status.tiles[t])]));
  return {
    id: store.newRequestId(), kind: 'reconfirm', name: moduleId || graph.model.name,
    label: moduleId ? `Re-confirm values-only changes in ${moduleId}` : 'Re-confirm values-only changes in the model',
    spec: null, formula: null, assumed: [], cases: [],
    tiles: tiles.map(t => ({ name: t, label: graph.quantities[t].label })), skipped,
    blockers: tiles.length ? [] : ['No tile has values-only changes that can be re-confirmed.'],
    values_only: false, module: moduleId || null, stamp: stamps,
    scope, at: store.now(), status: 'pending',
  };
}

function requestSentence(req) {
  if (req.kind === 'reconfirm') {
    return req.tiles.length
      ? `Re-confirm ${count(req.tiles.length, 'tile')} whose values changed but whose formulas did not: ${req.tiles.map(t => t.name).join(', ')}. Confirm with the button.`
      : `Nothing to re-confirm${req.skipped.length ? `; ${req.skipped.map(s => `${s.name} (${s.reason})`).join(', ')}` : ''}.`;
  }
  const what = req.kind === 'model' ? 'the model' : `${req.kind} ${req.name}${req.label && req.label !== req.name ? ` (${req.label})` : ''}`;
  if (req.blockers.length) return `Sign off ${what}? It cannot be signed off yet: ${req.blockers.join(' ')}`;
  return `Sign off ${what}? Confirm with the button${req.values_only ? ' and give the values-only reason' : ''}.`;
}

/**
 * Record the sign-off a pending request describes. `tk` is the unguarded tilekit runner.
 * Returns {ok, text, result} or {ok: false, error, expired}.
 */
async function performRequest(tk, modelDir, req, { reviewer, comment, valuesOnlyReason } = {}) {
  if (req.status !== 'pending') return { ok: false, error: `This sign-off request is already ${req.status}.` };
  const status = await tk('status');
  const who = String(reviewer || '').trim() || status.reviewer_default;
  if (!who) return { ok: false, error: 'A reviewer name is needed.' };
  if (req.kind === 'reconfirm') {
    const graph = await tk('graph');
    const now = reconfirmable(status, graph, req.module);
    const listed = req.tiles.map(t => t.name);
    const changed = listed.filter(t => !now.tiles.includes(t) || !sameStamp(req.stamp[t], storedStamp(modelDir, status.tiles[t])));
    const added = now.tiles.filter(t => !listed.includes(t));
    if (changed.length || added.length) {
      return { ok: false, expired: true, error: `The model changed since the request was made (${[...changed, ...added].join(', ')}). Ask for a new re-confirmation.` };
    }
    if (!listed.length) return { ok: false, expired: true, error: 'There is nothing to re-confirm.' };
    const args = ['--reviewer', who, ...(req.module ? ['--module', req.module] : []), ...(comment ? ['--comment', String(comment)] : [])];
    const result = await tk('reconfirm', args);
    const done = result.reconfirmed || [];
    return { ok: true, result, reviewer: who,
      text: `Re-confirmed ${count(done.length, 'tile')} as ${who}${done.length ? ': ' + done.join(', ') : ''}.` };
  }
  const entry = entryOf(status, req.kind, req.name);
  if (!entry) return { ok: false, expired: true, error: `${req.name} no longer exists in the model.` };
  const stampNow = storedStamp(modelDir, entry);
  if (!sameStamp(req.stamp, stampNow) || (req.workbook_current && !entry.workbook_current)) {
    return { ok: false, expired: true, error: `${req.kind === 'model' ? 'The model' : req.name} changed since the sign-off request was made. Ask for a new request and review it again.` };
  }
  const valuesOnly = req.kind === 'tile' && !!entry.values_only;
  const blockers = (entry.blockers || []).filter(b => !(valuesOnly && b === VALUES_ONLY_BLOCKER));
  if (blockers.length) return { ok: false, expired: true, error: `${req.kind === 'model' ? 'The model' : req.name} cannot be signed off: ${blockers.join(' ')}` };
  if (valuesOnly && !String(valuesOnlyReason || '').trim()) return { ok: false, error: `${req.name} cannot be written as an Excel formula; a values-only reason is needed to sign it off.` };
  const target = req.kind === 'tile' ? ['--tile', req.name] : req.kind === 'module' ? ['--module', req.name] : ['--whole-model'];
  const args = [...target, '--reviewer', who, ...(comment ? ['--comment', String(comment)] : []),
    ...(valuesOnly ? ['--values-only', String(valuesOnlyReason).trim()] : [])];
  const result = await tk('signoff', args);
  return { ok: true, result, reviewer: who, text: `Signed off ${req.kind === 'model' ? 'the model' : req.name} as ${who}.` };
}

module.exports = { prepareSignoff, prepareReconfirm, performRequest, requestSentence, reconfirmable, storedStamp, VALUES_ONLY_BLOCKER };
