// The agent log: a plain text log and a one-line input at the bottom of the left panel in every view.
// The container elements are created once and reused by every view; views call mount(scope) when they render,
// app.js calls unmount() when the route changes. The conversation is per scope (tile, module, model).
// scope: {level: 'model' | 'module' | 'tile', id}
import { h, fmtNumber } from './util.js';

const agentApi = () => (window.api && window.api.agent) || null;

export const logEl = h('div', { class: 'agentlog-log', id: 'agentlog-log', hidden: true });
export const inputEl = h('input', { type: 'text', class: 'agentlog-input', id: 'agentlog-input', autocomplete: 'off', maxlength: 8000 });
const stopEl = h('button', { type: 'button', id: 'agentlog-stop', class: 'agent-stop', hidden: true, onclick: () => stop() }, 'Stop');
const workingEl = h('div', { class: 'alog-line alog-working', id: 'agentlog-working' }, h('span', { class: 'alog-lab' }), h('span', { class: 'alog-txt grey' }, 'Working…'));
export const section = h('section', { class: 'agentlog', id: 'agentlog', hidden: !agentApi() },
  h('h3', { class: 'sec' }, 'Agent log'), logEl, h('div', { class: 'agentlog-row' }, inputEl, stopEl));

const PLACEHOLDER = {
  tile: 'Cap the charge at 1.00 unit a month',
  module: 'Add a surrender charge that falls to zero over five years',
  model: 'Add a module for surrender values after cashflows',
};

let current = null, currentKey = null, token = 0, loading = null;
let busy = false, building = false;
let hooks = { afterTurn: async () => {}, onBusy: () => {}, draftsChanged: async () => {} };
let subscribed = false;

const keyOf = s => (s.level === 'model' ? 'model' : s.level + ':' + s.id);
const sameScope = ev => !!current && !!ev.scope && keyOf(ev.scope) === currentKey;

// app.js supplies: afterTurn() refreshes graph and status after a turn or a draft; onBusy() re-renders the views.
export function configure(h2) { hooks = { ...hooks, ...h2 }; }
export const isBusy = () => busy;
export const currentScope = () => current;

export function mount(scope) {
  if (!agentApi()) { section.hidden = true; return; }
  section.hidden = false;
  inputEl.placeholder = PLACEHOLDER[scope.level] || '';
  if (!subscribed) { subscribed = true; agentApi().onEvent(onEvent); void refreshBusy(); }
  const key = keyOf(scope);
  if (currentKey === key) { current = scope; return; }
  current = scope; currentKey = key;
  load(scope, key);
}

export function unmount() {
  current = null; currentKey = null; token++;
  logEl.replaceChildren(); logEl.hidden = true;
}

// Views are rebuilt on every render; keep the typed text, focus and scroll position of the log.
export function saveView() {
  return { focus: document.activeElement === inputEl, top: logEl.scrollTop, bottom: logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 8 };
}
export function restoreView(v) {
  if (!v) return;
  logEl.scrollTop = v.bottom ? logEl.scrollHeight : v.top;
  if (v.focus && !inputEl.disabled) inputEl.focus();
}

// ---------------------------------------------------------------- rendering

function line(label, text, cls, ev) {
  const e = h('div', { class: 'alog-line ' + (cls || ''), ...(ev && ev.at ? { title: new Date(ev.at).toLocaleString() } : {}) },
    h('span', { class: 'alog-lab' }, label), h('span', { class: 'alog-txt' }, text));
  return e;
}

function append(node) {
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  logEl.hidden = false;
  logEl.append(node);
  paintWorking();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  section.scrollIntoView({ block: 'nearest' });
}

function paintWorking() {
  if (busy) { logEl.hidden = false; logEl.append(workingEl); logEl.scrollTop = logEl.scrollHeight; }
  else workingEl.remove();
  inputEl.disabled = busy;
  stopEl.hidden = !busy;
}

const lower = t => (/^The agent is not signed in/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1));
export const couldNot = text => 'Could not: ' + lower(String(text).replace(/^Could not:\s*/i, ''));

// The key numbers of a what-if, as plain lines: the largest changes by quantity.
export function whatIfLines(result) {
  const best = new Map();
  for (const [cid, qs] of Object.entries((result && result.cases) || {})) {
    for (const [qn, r] of Object.entries(qs)) {
      if (!r || !r.maxAbs) continue;
      const cur = best.get(qn);
      if (!cur || r.maxAbs > cur.r.maxAbs) best.set(qn, { cid, r });
    }
  }
  const rows = [...best.entries()].sort((a, b) => (b[1].r.maxRel || 0) - (a[1].r.maxRel || 0)).slice(0, 3);
  if (!rows.length) return ['No value changes in any case.'];
  return rows.map(([qn, { cid, r }]) => {
    const at = r.at && r.at[r.at.length - 1];
    if (!at) return `${qn}, case ${cid}: largest change ${fmtNumber(r.maxAbs)}.`;
    return r.summary
      ? `${qn}, case ${cid}: ${fmtNumber(at.before)} to ${fmtNumber(at.after)}.`
      : `${qn}, case ${cid}, month ${at.month}: ${fmtNumber(at.before)} to ${fmtNumber(at.after)}.`;
  });
}

function draftLine(ev, status) {
  const d = ev.draft || {};
  const isWhatIf = d.kind === 'what_if';
  const applyWord = isWhatIf ? 'Applied.' : 'Accepted.';
  const done = h('div', { class: 'alog-done' });
  const buttons = h('div', { class: 'alog-btns' });
  const errors = h('div', {});
  const setDone = word => { buttons.remove(); done.textContent = word; };
  const canApply = !isWhatIf || !!(d.items && d.items[0] && d.items[0].code);
  const yes = h('button', { type: 'button', class: 'small', 'data-act': 'accept', onclick: async () => {
    yes.disabled = no.disabled = true; errors.replaceChildren();
    try {
      const r = await agentApi().acceptDraft(d.id);
      if (r && r.accepted) { setDone(applyWord); await hooks.afterTurn(); return; }
    } catch (e) { errors.replaceChildren(h('div', { class: 'grey' }, couldNot(e.message))); }
    yes.disabled = no.disabled = false;
    await hooks.afterTurn();
  } }, isWhatIf ? 'Apply draft' : 'Accept');
  const no = h('button', { type: 'button', class: 'small', 'data-act': 'discard', onclick: async () => {
    yes.disabled = no.disabled = true; errors.replaceChildren();
    try { await agentApi().discardDraft(d.id); setDone('Discarded.'); await hooks.afterTurn(); return; }
    catch (e) { errors.replaceChildren(h('div', { class: 'grey' }, couldNot(e.message))); }
    yes.disabled = no.disabled = false;
  } }, 'Discard');
  buttons.append(...(canApply ? [yes] : []), no);
  const body = [h('div', {}, ev.text)];
  if (isWhatIf && d.result) body.push(...whatIfLines(d.result).map(t => h('div', { class: 'alog-num' }, t)));
  if (!isWhatIf && (d.warnings || []).length) body.push(...d.warnings.map(w => h('div', { class: 'grey' }, w)));
  if (status === 'accepted') body.push(h('div', { class: 'alog-done' }, applyWord));
  else if (status === 'discarded') body.push(h('div', { class: 'alog-done' }, 'Discarded.'));
  else if (status === 'proposed') body.push(buttons, done, errors);
  const e = line('Agent', '', 'alog-draft', ev);
  e.querySelector('.alog-txt').append(...body);
  e.dataset.draft = d.id || '';
  return e;
}

function render(ev, draftStatus) {
  switch (ev.type) {
    case 'user':
      logEl.querySelectorAll('.alog-opts').forEach(n => n.remove());
      return line('You', ev.text, '', ev);
    case 'agent': return line('Agent', ev.text, '', ev);
    case 'action': return line('', ev.text, 'alog-action', ev);
    case 'question': {
      const e = line('Agent', ev.text, 'alog-question', ev);
      if ((ev.options || []).length) {
        e.querySelector('.alog-txt').append(h('div', { class: 'alog-opts' }, ev.options.map(o =>
          h('button', { type: 'button', class: 'small', onclick: () => send(String(o)) }, o))));
      }
      return e;
    }
    case 'draft': return draftLine(ev, draftStatus || 'proposed');
    case 'error': return line('', couldNot(ev.text), 'alog-error', ev);
    case 'done': return ev.text ? line('', ev.text, 'alog-action', ev) : null;
    default: return null;
  }
}

// ---------------------------------------------------------------- loading and events

async function load(scope, key) {
  const my = ++token;
  logEl.replaceChildren(); logEl.hidden = true;
  const queued = [];
  loading = { key, queued };
  let hist = [], drafts = [];
  try {
    [hist, drafts] = await Promise.all([agentApi().history(scope), agentApi().drafts().catch(() => [])]);
  } catch (e) { hist = [{ type: 'error', text: e.message }]; }
  if (my !== token) return;
  loading = null;
  const status = new Map((drafts || []).map(d => [d.id, d.status]));
  const seen = new Set();
  const sig = ev => [ev.type, ev.at, ev.text, ev.draft && ev.draft.id].join('|');
  // Only the last question can still be answered, and only if nothing was said since.
  let lastUser = -1, lastQ = -1;
  hist.forEach((ev, i) => { if (ev.type === 'user') lastUser = i; if (ev.type === 'question') lastQ = i; });
  const frag = [];
  hist.forEach((ev, i) => {
    seen.add(sig(ev));
    const node = render(ev, ev.type === 'draft' ? (status.get(ev.draft && ev.draft.id) || 'gone') : undefined);
    if (node && ev.type === 'question' && !(i === lastQ && lastQ > lastUser)) node.querySelectorAll('.alog-opts').forEach(n => n.remove());
    if (node) frag.push(node);
  });
  logEl.append(...frag);
  if (frag.length) logEl.hidden = false;
  for (const ev of queued) if (!seen.has(sig(ev))) { const n = render(ev); if (n) logEl.append(n); }
  paintWorking();
  logEl.scrollTop = logEl.scrollHeight;
}

function onEvent(ev) {
  if (loading && ev.scope && keyOf(ev.scope) === loading.key) loading.queued.push(ev);
  else if (sameScope(ev)) { const n = render(ev); if (n) append(n); }
  if (ev.type === 'user') { busy = true; paintWorking(); hooks.onBusy(); }
  else if (ev.type === 'draft') hooks.draftsChanged();
  else if (ev.type === 'done') { void refreshBusy().then(() => hooks.afterTurn()); }
}

async function refreshBusy() {
  let now = building;
  try { now = now || (await agentApi().status()).busy.length > 0; } catch { /* keep */ }
  setBusy(now);
}
function setBusy(now) {
  if (now === busy) { paintWorking(); return; }
  busy = now; paintWorking(); hooks.onBusy();
}

// ---------------------------------------------------------------- actions

export async function send(text, extra) {
  const scope = current;
  if (!scope || !text || !String(text).trim() || busy) return false;
  setBusy(true);
  try { await agentApi().send(scope, String(text), extra); }
  catch (e) { if (sameScope({ scope })) append(line('', couldNot(e.message), 'alog-error')); }
  await refreshBusy();
  return true;
}

export async function buildModule(id) {
  if (busy) return;
  building = true; setBusy(true);
  try { await agentApi().buildModule(id); }
  catch (e) { if (current && current.level === 'module' && current.id === id) append(line('', couldNot(e.message), 'alog-error')); }
  building = false;
  await refreshBusy();
  await hooks.afterTurn();
}

async function stop() {
  try {
    const st = await agentApi().status();
    for (const b of st.busy) await agentApi().interrupt(b.scope);
  } catch (e) { append(line('', couldNot(e.message), 'alog-error')); }
}

inputEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text || busy) return;
  inputEl.value = '';
  void send(text);
});
