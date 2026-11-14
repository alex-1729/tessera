// Derived facts about the model and its review state. No DOM here.
import { fmtDate, fmtNumber } from './util.js';

export const TOL = 5e-5; // differences are shown to 4 dp

export const q = (S, name) => S.graph && S.graph.quantities[name];
export const tileStatus = (S, name) => S.status && S.status.tiles[name];
export const moduleOf = (S, id) => S.graph.modules.find(m => m.id === id);

export const caseName = (S, id) => { const c = S.cases.find(x => x.id === id); return (c && c.name) || id; };
const countOf = (v, fallback) => Array.isArray(v) ? v.length : typeof v === 'number' ? v : fallback();
const list = xs => xs.join(', ');

export const isNotBuilt = st => !!st && st.state === 'not_built';
export const notBuiltTiles = (S, tiles) => tiles.filter(t => isNotBuilt(tileStatus(S, t)));

export function stateWord(state) {
  if (state === 'not_built') return 'not built';
  if (state === 'signed_off') return 'signed off';
  if (state === 'stale') return 'stale';
  return 'not reviewed';
}
export function mapWord(state) {
  if (state === 'not_built') return 'not built';
  if (state === 'signed_off') return 'signed off';
  if (state === 'stale') return 'stale';
  if (state === 'unbuilt') return 'not built';
  return 'not signed off';
}

export function argWord(S, name) {
  const x = q(S, name);
  if (!x) return 'unknown';
  if (x.kind === 'tile') return stateWord((tileStatus(S, name) || {}).state);
  if (x.kind === 'param') return 'parameter';
  if (x.kind === 'state') return 'carried forward';
  return 'input';
}

const nonNewCases = (S, name) => {
  const st = tileStatus(S, name) || {};
  return S.cases.filter(c => !(st.new_cases || []).includes(c.id));
};

// Optional status.tiles[x].case_results = {caseId: {max_abs_difference, pass}}; otherwise inferred from checks_pass.
export const isValuesOnly = st => !!st && (st.values_only === true || st.translatable === false);
export function caseResult(S, name, c) {
  const st = tileStatus(S, name) || {};
  if (isValuesOnly(st) && !(st.new_cases || []).includes(c.id)) return 'values only';
  if ((st.new_cases || []).includes(c.id)) return 'new';
  const r = st.case_results && st.case_results[c.id];
  if (r) return r.pass === false || Math.abs(r.max_abs_difference || 0) >= TOL ? 'fails' : 'passes';
  return st.checks_pass === false && Math.abs(st.max_abs_difference || 0) >= TOL ? 'fails' : 'passes';
}

function differenceSentence(S, name) {
  const st = tileStatus(S, name) || {};
  if (isValuesOnly(st) || st.checks_pass === null) return '';
  const cs = nonNewCases(S, name);
  const n = cs.length;
  if (n === 0) return '';
  const zero = cs.filter(c => caseResult(S, name, c) === 'passes').length;
  if (zero === n && Math.abs(st.max_abs_difference || 0) < TOL) return ` Differences are zero in ${n} of ${n} cases.`;
  if (st.case_results) return ` Differences are zero in ${zero} of ${n} cases.`;
  return ` The largest difference is ${fmtNumber(st.max_abs_difference || 0)}.`;
}

export function tileSentence(S, name) {
  const st = tileStatus(S, name);
  if (!st) return '';
  let s;
  const news = st.new_cases || [];
  if (st.state === 'not_built') return 'Not built yet. Describe how it should work in the agent log below.';
  if (st.state === 'signed_off') {
    const so = st.signed_off || {};
    s = news.length
      ? `Signed off. New ${news.length > 1 ? 'cases' : 'case'} to review: ${list(news.map(c => caseName(S, c)))}.`
      : `Signed off by ${so.reviewer || 'unknown'} on ${fmtDate(so.at)}.`;
  } else if (st.state === 'stale') {
    if (st.drift === 'formula') s = "Stale: this tile's formula changed since sign-off.";
    else if (st.drift === 'values') s = 'Stale: upstream values changed since sign-off.';
    else s = 'Stale.';
  } else if (st.state === 'unbuilt') s = 'Not signed off. No workbook yet.';
  else s = 'Not signed off.' + differenceSentence(S, name);
  if (isValuesOnly(st)) s += ' Values only: this tile cannot be written as an Excel formula.';
  return s;
}

export function moduleSentence(S, id) {
  const m = S.status.modules[id];
  if (m.state === 'signed_off') {
    const so = m.signed_off;
    return so ? `Signed off by ${so.reviewer} on ${fmtDate(so.at)}.` : 'Signed off.';
  }
  const lead = m.state === 'stale' ? 'Stale: a tile changed since sign-off.' : 'Not signed off.';
  const unbuilt = countOf(m.unbuilt, () => moduleOf(S, id).tiles.filter(t => (tileStatus(S, t) || {}).state === 'unbuilt').length);
  const notBuilt = notBuiltTiles(S, moduleOf(S, id).tiles).length;
  return `${lead} ${m.tiles_signed_off} of ${m.tiles_total} tiles signed off` +
    (m.stale ? `, ${m.stale} stale` : '') + (unbuilt ? `, ${unbuilt} without a workbook` : '') + (notBuilt ? `, ${notBuilt} not built` : '') + '.';
}

export function modelSentence(S) {
  const m = S.status.model;
  if (m.state === 'signed_off') {
    const so = m.signed_off;
    return so ? `Signed off by ${so.reviewer} on ${fmtDate(so.at)}.` : 'Signed off.';
  }
  const stale = S.graph.modules.filter(x => S.status.modules[x.id].state === 'stale').length;
  const lead = m.state === 'stale' ? 'Stale: a module changed since sign-off.' : 'Not signed off.';
  const unbuilt = countOf(m.unbuilt, () => 0);
  return `${lead} ${m.modules_signed_off} of ${m.modules_total} modules signed off` + (stale ? `, ${stale} stale` : '') + (unbuilt ? `, ${unbuilt} not built` : '') + '.';
}

export const workbookOutOfDate = st => !!st && st.workbook_current === false;
export const checkWord = c => c.stale ? 'not run since last change' : (c.pass ? 'passes' : 'fails');

export function moduleMapWord(S, mod) {
  const m = S.status.modules[mod.id];
  if (m.state === 'signed_off') return 'signed off';
  if (m.state === 'stale') return 'stale';
  return `${m.tiles_signed_off} of ${m.tiles_total} tiles`;
}

// Check summary for a tile: list of plain sentences; empty list means all pass.
export function tileCheckLines(S, name) {
  const st = tileStatus(S, name) || {};
  const lines = [];
  for (const v of st.rule_violations || []) {
    lines.push('Rule violation: ' + (typeof v === 'string' ? v : [v.rule, v.message].filter(Boolean).join(': ') + (v.line ? ` (line ${v.line})` : '')));
  }
  if (Math.abs(st.max_abs_difference || 0) >= TOL) lines.push(`Largest difference: ${fmtNumber(st.max_abs_difference)}. It must be zero to 4 decimal places.`);
  for (const b of st.uncovered_branches || []) lines.push('Branch not covered by any case: ' + (typeof b === 'string' ? b : JSON.stringify(b)));
  if (!lines.length && st.checks_pass === false) lines.push('Checks do not pass.');
  return lines;
}

// Prefer the Python side's verdict (can_sign_off / blockers); derive only when it is absent.
export const verdict = st => (st && typeof st.can_sign_off === 'boolean') ? { known: true, ok: st.can_sign_off, blockers: st.blockers || [] } : { known: false };

export function tileBlockers(S, name) {
  const st = tileStatus(S, name) || {};
  const v = verdict(st);
  if (v.known) return v.ok ? [] : (v.blockers.length ? v.blockers : ['Cannot be signed off.']);
  const out = [];
  if (st.state === 'unbuilt') out.push('There is no workbook yet. Build it first.');
  if (st.state === 'stale') out.push(st.drift === 'values'
    ? 'This tile is stale because upstream values changed. Rebuild it, or re-confirm values-only changes from the module view.'
    : 'This tile is stale. Rebuild it and review it again.');
  out.push(...tileCheckLines(S, name));
  return out;
}

export function upstreamUnsigned(S, name) {
  return (q(S, name).args || []).filter(a => q(S, a) && q(S, a).kind === 'tile' && (tileStatus(S, a) || {}).state !== 'signed_off');
}

export function moduleBlockers(S, id) {
  const v = verdict(S.status.modules[id]);
  if (v.known) return v.ok ? [] : (v.blockers.length ? v.blockers : ['Cannot be signed off.']);
  const out = [];
  for (const t of moduleOf(S, id).tiles) {
    const s = (tileStatus(S, t) || {}).state;
    if (s === 'stale') out.push(`Tile ${t} is stale.`);
    else if (s !== 'signed_off') out.push(`Tile ${t} is not signed off.`);
  }
  return out;
}

export function modelBlockers(S) {
  const v = verdict(S.status.model);
  if (v.known) return v.ok ? [] : (v.blockers.length ? v.blockers : ['Cannot be signed off.']);
  return S.graph.modules.filter(m => S.status.modules[m.id].state !== 'signed_off')
    .map(m => `Module ${m.title} is ${S.status.modules[m.id].state === 'stale' ? 'stale' : 'not signed off'}.`);
}

export const needsRebuild = (S, tiles) => tiles.filter(t => { const s = tileStatus(S, t) || {}; return ['stale', 'unbuilt'].includes(s.state) || s.workbook_current === false; });
export const canReconfirm = (S, tiles) => tiles.filter(t => {
  const s = tileStatus(S, t) || {};
  return s.state === 'stale' && s.drift === 'values' && s.checks_pass !== false;
});

// A workbook (module or model) that is not built, or that no longer matches the Python.
export const workbookStale = st => !!st && (st.state === 'unbuilt' || st.workbook_current === false);
