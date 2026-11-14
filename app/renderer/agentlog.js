// The chat: the right bar. ONE conversation per model: the log shows every exchange, newest at the bottom, with a thin
// divider naming the selection (a tile, a module, the model) whenever it changes between messages. The input is pinned
// at the bottom. Every message is sent with the current selection as its scope. Views call mount(scope) when they render.
// scope: {level: 'model' | 'module' | 'tile', id}
import { h, fmtNumber, plainFormula } from './util.js';

const agentApi = () => (window.api && window.api.agent) || null;

export const logEl = h('div', { class: 'agentlog-log', id: 'agentlog-log' });
export const inputEl = h('textarea', { class: 'agentlog-input', id: 'agentlog-input', rows: 2, autocomplete: 'off', maxlength: 8000, 'aria-label': 'Message to the agent' });
const stopEl = h('button', { type: 'button', id: 'agentlog-stop', class: 'agent-stop', hidden: true, onclick: () => stop() }, 'Stop');
const workingEl = h('div', { class: 'alog-line alog-working', id: 'agentlog-working' }, h('span', { class: 'alog-lab' }), h('span', { class: 'alog-txt grey' }, 'Working…'));
const startersEl = h('div', { class: 'starters', id: 'starters' });
const noneEl = h('div', { id: 'chatnone', hidden: true }, 'The agent is not available in this mode.');
export const section = h('section', { class: 'agentlog', id: 'agentlog', hidden: !agentApi() },
  logEl, h('div', { class: 'agentlog-bottom' }, startersEl, h('div', { class: 'agentlog-row' }, inputEl, stopEl)));
export const unavailable = noneEl;

// What in the conversation needs the reviewer: a sign-off card or a draft with its buttons still showing, or a
// question nobody has answered. Shown on the right strip when the chat is collapsed.
export function attention() {
  if (!agentApi()) return null;
  if (logEl.querySelector('.alog-card button[data-act]')) return 'confirm';
  if (logEl.querySelector('.alog-draft button[data-act]')) return 'draft';
  // a question waits while nothing from the reviewer comes after it (the agent may add lines of its own after asking)
  const lines = [...logEl.querySelectorAll('.alog-line:not(.alog-working)')];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].classList.contains('alog-question')) return 'question';
    if (lines[i].querySelector('.alog-lab').textContent === 'You') return null;
  }
  return null;
}
export function onLogChange(fn) { new MutationObserver(fn).observe(logEl, { childList: true, subtree: true }); }

const PLACEHOLDER = {
  tile: 'Cap the charge at 1.00 unit a month',
  module: 'Add a surrender charge that falls to zero over five years',
  model: 'Add a module for surrender values after cashflows',
};
const STARTERS = {
  tile: ['What does this tile do?', 'Why does it change in month 37?', 'Sign this off'],
  module: ['Build the tiles that are not built', 'What is left to review here?'],
  model: ['What is left to review?', 'Add a module'],
};

let current = null, loading = null, loaded = false;
let busy = false, building = false;
let hooks = { afterTurn: async () => {}, onBusy: () => {}, draftsChanged: async () => {}, titleOf: s => (s.level === 'model' ? 'Model' : s.id), reviewer: async () => '' };
let subscribed = false;
let lastKey = null;          // selection of the last message drawn, for the dividers
let shown = 0;               // events drawn

const keyOf = s => (s && s.level !== 'model' ? s.level + ':' + s.id : 'model');

// app.js supplies: afterTurn() refreshes graph and status after a turn or a draft; onBusy() re-renders the views;
// titleOf(scope) names a selection for a divider; reviewer() is the prefilled name on a sign-off card.
export function configure(h2) { hooks = { ...hooks, ...h2 }; }
export const isBusy = () => busy;
export const currentScope = () => current;

function paintStarters() {
  const empty = shown === 0 && !loading;
  startersEl.hidden = !empty;
  if (!empty || !current) { startersEl.replaceChildren(); return; }
  startersEl.replaceChildren(...(STARTERS[current.level] || []).map(t =>
    h('a', { href: '#', 'data-starter': t, onclick: e => { e.preventDefault(); inputEl.value = t; autosize(); inputEl.focus(); } }, t)));
}

export function mount(scope) {
  if (!agentApi()) { section.hidden = true; noneEl.hidden = false; return; }
  section.hidden = false; noneEl.hidden = true;
  inputEl.placeholder = PLACEHOLDER[scope.level] || '';
  current = scope;
  if (!subscribed) { subscribed = true; agentApi().onEvent(onEvent); void refreshBusy(); }
  if (!loaded) { loaded = true; load(); }
  paintStarters();
}

// Views are rebuilt on every render; keep the focus and scroll position of the log.
export function saveView() {
  return { focus: document.activeElement === inputEl, top: logEl.scrollTop, bottom: logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 8 };
}
export function restoreView(v) {
  if (!v) return;
  logEl.scrollTop = v.bottom ? logEl.scrollHeight : v.top;
  if (v.focus && !inputEl.disabled) inputEl.focus();
}
export function prefill(text) { inputEl.value = text; autosize(); }

// The input grows from two rows to about six.
function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight + 2, 9.6 * 13 * 1.0 + 24) + 'px';
}

// ---------------------------------------------------------------- rendering

function line(label, text, cls, ev) {
  const e = h('div', { class: 'alog-line ' + (cls || ''), ...(ev && ev.at ? { title: new Date(ev.at).toLocaleString() } : {}) },
    h('span', { class: 'alog-lab' }, label), h('span', { class: 'alog-txt' }, text));
  return e;
}

function append(node) {
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  logEl.append(node);
  paintWorking();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

function paintWorking() {
  if (busy) { logEl.append(workingEl); logEl.scrollTop = logEl.scrollHeight; }
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

// What a draft would add or change, as a short plain list: name, label, default or formula where there is one.
function draftItems(d) {
  const items = d.items || [];
  const one = it => {
    if (typeof it === 'string') return it;
    const name = it.id && it.name && it.id !== it.name ? it.id : (it.name || it.id || it.table || it.title || '');
    const bits = [name, it.name && it.name !== name ? it.name : '', it.type && it.type !== name ? it.type : '', it.label && it.label !== name ? it.label : '', it.title && it.title !== name && it.title !== it.label ? it.title : '',
      it.default !== undefined && it.default !== null ? 'default ' + it.default : '', it.formula ? it.formula : (it.expression || '')].filter(Boolean);
    return bits.join(', ');
  };
  const rows = items.map(it => one(it)).filter(Boolean);
  if (!rows.length) return [];
  const head = { tiles: 'Tiles to add', modules: 'Modules to add', params: 'Parameters to add', inputs: 'Inputs to add', cases: 'Cases to add' }[d.kind] || 'Changes';
  return [h('div', { class: 'draftlist' }, h('div', { class: 'cardsec' }, head + (d.module ? ` (in ${d.module})` : '')), ...rows.map(r => h('div', { class: 'draftitem' }, r)))];
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
  const slow = ['params', 'inputs', 'cases'].includes(d.kind);   // these rebuild stale workbooks: about ten seconds
  const yes = h('button', { type: 'button', class: 'small', 'data-act': 'accept', onclick: async () => {
    yes.disabled = no.disabled = true; errors.replaceChildren();
    if (slow) done.textContent = 'Working…';
    try {
      const r = await agentApi().acceptDraft(d.id);
      if (r && r.accepted) { setDone(applyWord); await hooks.afterTurn(); return; }
    } catch (e) { errors.replaceChildren(h('div', { class: 'grey' }, couldNot(e.message))); }
    done.textContent = '';
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
  if (!isWhatIf) body.push(...draftItems(d));
  if (!isWhatIf && (d.warnings || []).length) body.push(...d.warnings.map(w => h('div', { class: 'grey' }, w)));
  if (status === 'accepted') body.push(h('div', { class: 'alog-done' }, applyWord));
  else if (status === 'discarded') body.push(h('div', { class: 'alog-done' }, 'Discarded.'));
  else if (status === 'proposed') body.push(buttons, done, errors);
  const e = line('Agent', '', 'alog-draft', ev);
  e.querySelector('.alog-txt').append(...body);
  e.dataset.draft = d.id || '';
  return e;
}

// The sign-off the agent asks for, as a plain bordered card. Only this button records a sign-off made through the chat.
// status: 'proposed' (live buttons), or how it ended: 'signed', 'declined', 'expired', 'superseded', 'closed'.
function signoffCard(ev, status, info = {}) {
  const r = ev.request || {};
  const reconfirm = r.kind === 'reconfirm';
  const done = h('div', { class: 'alog-done' });
  const buttons = h('div', { class: 'alog-btns' });
  const errors = h('div', {});
  const settled = word => { buttons.remove(); done.textContent = word; };
  const assumed = reconfirm ? [] : (r.assumed || []);
  const boxes = assumed.map(() => h('input', { type: 'checkbox', class: 'assume' }));
  const blockers = r.blockers || [];
  const reviewer = h('input', { type: 'text', 'data-f': 'reviewer', autocomplete: 'off', value: '' });
  const comment = h('input', { type: 'text', 'data-f': 'comment', autocomplete: 'off' });
  const reason = r.values_only ? h('textarea', { 'data-f': 'reason', rows: 2 }) : null;
  hooks.reviewer().then(n => { if (!reviewer.value) { reviewer.value = n || ''; refresh(); } }).catch(() => {});
  const yes = h('button', { type: 'button', class: 'small', 'data-act': 'signoff', disabled: true, onclick: async () => {
    yes.disabled = no.disabled = true; errors.replaceChildren();
    const who = reviewer.value.trim();
    try {
      const res = await agentApi().confirmSignoff(r.id, { reviewer: who, comment: comment.value.trim(), valuesOnlyReason: reason ? reason.value.trim() : undefined });
      if (res && res.signed === false) {
        errors.replaceChildren(h('div', { class: 'grey' }, res.error || 'Not signed.'));
        if (res.request && res.request.status && res.request.status !== 'pending') settled(res.request.status === 'expired' ? 'Expired.' : 'Not signed.');
        else { refresh(); no.disabled = false; }
        await hooks.afterTurn(); return;
      }
      settled(`${reconfirm ? 'Re-confirmed' : 'Signed off'} by ${who}.`); await hooks.afterTurn(); return;
    } catch (e) { errors.replaceChildren(h('div', { class: 'grey' }, couldNot(e.message))); }
    refresh(); no.disabled = false;
  } }, reconfirm ? 'Re-confirm' : 'Sign off');
  const no = h('button', { type: 'button', class: 'small', 'data-act': 'decline', onclick: async () => {
    yes.disabled = no.disabled = true; errors.replaceChildren();
    try { await agentApi().declineSignoff(r.id); settled('Not signed.'); await hooks.afterTurn(); return; }
    catch (e) { errors.replaceChildren(h('div', { class: 'grey' }, couldNot(e.message))); }
    refresh(); no.disabled = false;
  } }, 'Not now');
  function refresh() {
    yes.disabled = !!blockers.length || !boxes.every(b => b.checked) || !reviewer.value.trim() || (!!reason && !reason.value.trim()) || (reconfirm && !(r.tiles || []).length);
    yes.title = blockers.length ? blockers[0] : '';
  }
  [...boxes, reviewer, ...(reason ? [reason] : [])].forEach(b => b.addEventListener(b.type === 'checkbox' ? 'change' : 'input', refresh));
  buttons.append(yes, no);
  const checks = (r.checks || []).map(c => typeof c === 'string' ? c : `${c.name || c.id || ''} ${c.pass === false ? 'fails' : (c.pass ? 'passes' : '')}`.trim());
  const card = h('div', { class: 'alog-card', 'data-request': r.id || '', 'data-kind': r.kind || '', 'data-name': r.name || '' },
    h('div', { class: 'cardtitle' }, reconfirm ? `Re-confirm values-only tiles${r.module ? ' in ' + r.module : ''}` : (r.label ? `${r.label}, ${r.name}` : (r.name || r.kind || ''))),
    ...(r.spec && !reconfirm ? [h('p', { class: 'spec' }, r.spec)] : []),
    ...(r.formula ? [h('div', { class: 'formula' }, plainFormula(r.formula))] : []),
    ...(reconfirm ? [h('div', { class: 'cardsec' }, 'Tiles that would be renewed'), ...((r.tiles || []).length ? r.tiles.map(t => h('div', { class: 'row' }, h('span', {}, typeof t === 'string' ? t : t.name), h('span', { class: 'r' }, typeof t === 'string' ? '' : (t.label || '')))) : [h('p', { class: 'grey' }, 'None.')]),
      ...((r.skipped || []).length ? [h('div', { class: 'cardsec' }, 'Not renewed'), ...r.skipped.map(k => h('p', {}, `${k.name}: ${k.reason}`))] : [])] : []),
    ...(assumed.length ? [h('div', { class: 'cardsec' }, 'Assumptions to confirm'), ...assumed.map((a, i) => h('label', { class: 'ck' }, boxes[i], h('span', {}, a)))] : []),
    ...((r.cases || []).length ? [h('div', { class: 'cardsec' }, 'Cases'), ...r.cases.map(c => h('div', { class: 'row' }, h('span', {}, c.name || c.id), h('span', { class: 'r' }, c.pass ? 'agrees' : 'differs')))] : []),
    ...(checks.length ? [h('div', { class: 'cardsec' }, 'Checks'), ...checks.map(c => h('p', {}, c))] : []),
    ...(blockers.length ? [h('div', { class: 'cardsec' }, 'Cannot be signed off'), ...blockers.map(b => h('p', { class: 'blocker' }, b))] : []));
  if (status === 'proposed') {
    card.append(h('label', { class: 'fld' }, 'Reviewer', reviewer), h('label', { class: 'fld' }, 'Comment', comment),
      ...(reason ? [h('label', { class: 'fld' }, 'Reason (required: this tile cannot be written as a formula)', reason)] : []), buttons, done, errors);
    refresh();
  } else card.append(done);
  const who = info.reviewer || ev.reviewer;
  if (status === 'signed') done.textContent = `${reconfirm ? 'Re-confirmed' : 'Signed off'}${who ? ' by ' + who : ''}.`;
  else if (status === 'declined' || status === 'closed') done.textContent = 'Not signed.';
  else if (status === 'expired') done.textContent = 'Expired: the model changed after this was asked.';
  else if (status === 'superseded') done.textContent = 'Superseded by a newer request.';
  const e = line('Agent', '', 'alog-signoff', ev);
  e.querySelector('.alog-txt').append(h('div', {}, ev.text || ''), card);
  e.dataset.request = r.id || '';
  e.dataset.kind = r.kind || ''; e.dataset.name = r.name || '';
  e._settle = word => { if (e.querySelector('button[data-act]')) { buttons.remove(); done.textContent = word; } };
  return e;
}

function divider(scope) {
  return h('div', { class: 'alog-divider', 'data-scope': keyOf(scope) }, hooks.titleOf(scope));
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
    case 'signoff_request': return signoffCard(ev, draftStatus || 'proposed');
    case 'error': return line('', couldNot(ev.text), 'alog-error', ev);
    case 'done': return ev.text ? line('', ev.text, 'alog-action', ev) : null;
    default: return null;
  }
}

// A divider goes in front of a message that was sent about a different selection than the one before it.
function withDivider(ev, node) {
  if (!node) return [];
  if (ev.type === 'user' && ev.scope && keyOf(ev.scope) !== lastKey) { lastKey = keyOf(ev.scope); return [divider(ev.scope), node]; }
  return [node];
}

// ---------------------------------------------------------------- loading and events

// The whole conversation of the model. A backend that only knows one conversation per selection is asked for the
// selection's own history instead.
async function readHistory(scope) {
  const api = agentApi();
  try { return await api.history(); } catch { return api.history(scope); }
}

async function load() {
  logEl.replaceChildren(); lastKey = null; shown = 0;
  const queued = [];
  loading = { queued };
  let hist = [], drafts = [], reqs = [];
  try {
    [hist, drafts, reqs] = await Promise.all([readHistory(current), agentApi().drafts().catch(() => []), agentApi().requests ? agentApi().requests().catch(() => []) : []]);
  } catch (e) { hist = [{ type: 'error', text: e.message }]; }
  loading = null;
  const status = new Map((drafts || []).map(d => [d.id, d.status]));
  const reqById = new Map((reqs || []).map(q => [q.id, q]));
  const reqWord = { pending: 'proposed', confirmed: 'signed', declined: 'declined', expired: 'expired', superseded: 'superseded' };
  const seen = new Set();
  const sig = ev => [ev.type, ev.at, ev.text, ev.draft && ev.draft.id, ev.request && ev.request.id].join('|');
  // Only the last question can still be answered, and only if nothing was said since.
  let lastUser = -1, lastQ = -1, lastReq = -1;
  hist.forEach((ev, i) => { if (ev.type === 'user') lastUser = i; if (ev.type === 'question') lastQ = i; if (ev.type === 'signoff_request') lastReq = i; });
  const frag = [];
  hist.forEach((ev, i) => {
    seen.add(sig(ev));
    let st;
    if (ev.type === 'draft') st = status.get(ev.draft && ev.draft.id) || 'gone';
    else if (ev.type === 'signoff_request') {
      // the outcome comes from the request files, not from the log: a confirmed, declined, expired or superseded request has no live buttons
      const q = reqById.get(ev.request && ev.request.id);
      st = q ? (reqWord[q.status] || 'closed') : ((i === lastReq && lastReq > lastUser) ? 'proposed' : 'closed');
      if (q) { ev = { ...ev, request: { ...ev.request, ...q }, reviewer: q.reviewer }; }
    }
    const node = render(ev, st);
    if (node && ev.type === 'question' && !(i === lastQ && lastQ > lastUser)) node.querySelectorAll('.alog-opts').forEach(n => n.remove());
    if (node) shown++;
    frag.push(...withDivider(ev, node));
  });
  logEl.append(...frag);
  for (const ev of queued) if (!seen.has(sig(ev))) { const n = render(ev); if (n) { shown++; logEl.append(...withDivider(ev, n)); } }
  paintWorking();
  paintStarters();
  logEl.scrollTop = logEl.scrollHeight;
}

function onEvent(ev) {
  if (ev.type === 'signoff_request' && ev.request) {
    for (const old of logEl.querySelectorAll('.alog-signoff')) {
      if (old.dataset.kind === ev.request.kind && old.dataset.name === ev.request.name && old.dataset.request !== ev.request.id && old._settle) old._settle('Superseded by a newer request.');
    }
  }
  if (loading) loading.queued.push(ev);
  else { const n = render(ev); if (n) { shown++; startersEl.hidden = true; append(withDividerFrag(ev, n)); } }
  if (ev.type === 'user') { busy = true; paintWorking(); hooks.onBusy(); }
  else if (ev.type === 'draft') hooks.draftsChanged();
  else if (ev.type === 'done') { void refreshBusy().then(() => hooks.afterTurn()); }
}
function withDividerFrag(ev, node) {
  const nodes = withDivider(ev, node);
  if (nodes.length === 1) return nodes[0];
  const f = document.createDocumentFragment(); f.append(...nodes); return f;
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
  catch (e) { append(line('', couldNot(e.message), 'alog-error')); }
  await refreshBusy();
  return true;
}

export async function buildModule(id) {
  if (busy) return;
  building = true; setBusy(true);
  try { await agentApi().buildModule(id); }
  catch (e) { append(line('', couldNot(e.message), 'alog-error')); }
  building = false;
  await refreshBusy();
  await hooks.afterTurn();
}

async function stop() {
  try {
    await agentApi().interrupt();
  } catch (e) { append(line('', couldNot(e.message), 'alog-error')); }
}

// Enter sends; Shift+Enter makes a new line.
inputEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text || busy) return;
  inputEl.value = ''; autosize();
  void send(text);
});
inputEl.addEventListener('input', autosize);
