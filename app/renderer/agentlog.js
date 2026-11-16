// The right bar: Claude Code in a terminal (terminal.js) and, above it, the cards that need the reviewer's own click:
// sign-off requests, re-confirm requests, push requests and what-if drafts. The conversation is Claude Code's own; the
// app has no chat of its own. Other drafts are approved in the centre pane (the Draft to approve tab, draftview.js).
// Views call mount(scope) when they render: the selection is what the next message typed in the pane is about.
// scope: {level: 'model' | 'module' | 'tile', id}
import { h, fmtNumber, plainFormula } from './util.js';
import { formDialog } from './dialog.js';
import * as terminal from './terminal.js';

const agentApi = () => (window.api && window.api.agent) || null;
// Claude Code runs in the pane whenever the open model has a real agent. It does not in fixtures mode, or when a test
// passes a stand-in agent: the pane then shows the cards (if any) and one line saying so.
const RUNS = terminal.available();

export const logEl = h('div', { class: 'agentlog-log', id: 'agentlog-log' });
// Above the terminal: Claude Code's own commands for a new conversation and for the earlier ones.
const termTop = h('div', { class: 'agentlog-top', id: 'term-top' },
  h('button', { type: 'button', class: 'linkbtn', id: 'termnew', title: 'Types /clear', onclick: () => terminal.type('/clear', true) }, 'New conversation'),
  h('button', { type: 'button', class: 'linkbtn', id: 'termresume', onclick: () => conversationsDialog() }, 'Conversations…'));
const noneEl = h('p', { class: 'grey', id: 'termnone' }, 'Claude Code is not running in this mode.');
// A card stays while it waits for a click; a few seconds after it is settled (applied, discarded, signed, declined) it goes.
const going = new WeakSet();
new MutationObserver(() => {
  for (const l of logEl.querySelectorAll('.alog-line')) {
    if (going.has(l) || l.querySelector('button[data-act]')) continue;
    going.add(l); setTimeout(() => l.remove(), 4000);
  }
}).observe(logEl, { childList: true, subtree: true });
export const section = h('section', { class: 'agentlog', id: 'agentlog' }, logEl, ...(RUNS ? [termTop, terminal.el] : [noneEl]));

// What in the pane needs the reviewer: a sign-off or push card, or a what-if draft, with its buttons still showing.
// Shown on the right strip when the bar is collapsed.
export function attention() {
  if (logEl.querySelector('.alog-card button[data-act]')) return 'confirm';
  if (logEl.querySelector('.alog-draft button[data-act]')) return 'draft';
  return null;
}
export function onLogChange(fn) { new MutationObserver(fn).observe(logEl, { childList: true, subtree: true }); }

let current = null, loading = null, loaded = false;
let busy = false;
let hooks = { afterTurn: async () => {}, onBusy: () => {}, draftsChanged: async () => {}, reviewer: async () => '' };
let subscribed = false;

// app.js supplies: afterTurn() refreshes graph and status after a turn or a draft; onBusy() re-renders the views;
// reviewer() is the prefilled name on a sign-off card; queueMark() and queueAdvance() move on in the review queue.
export function configure(h2) { hooks = { ...hooks, ...h2 }; }
export const isBusy = () => busy;
// What the agent is working on right now ({level, id}), or null: the selection its running turn was sent with.
let busyScope = null;
export const workingOn = () => (busy ? busyScope : null);
export const currentScope = () => current;
// Whether there is a Claude Code to type into (the buttons that ask the agent for something need one).
export const canType = () => RUNS;

export function mount(scope) {
  current = scope;
  if (RUNS) { void window.api.term.select(scope).catch(() => {}); queueMicrotask(() => terminal.show()); }
  if (!agentApi()) return;
  if (!subscribed) { subscribed = true; agentApi().onEvent(onEvent); void refreshBusy(); }
  if (!loaded) { loaded = true; load(); }
}

// Views are rebuilt on every render; keep the scroll position of the cards.
export function saveView() {
  return { top: logEl.scrollTop, bottom: logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 8 };
}
export function restoreView(v) {
  if (!v) return;
  logEl.scrollTop = v.bottom ? logEl.scrollHeight : v.top;
}
// Type text at Claude Code's prompt without sending it.
export function prefill(text) { if (RUNS) terminal.type(text, false); }

// ---------------------------------------------------------------- rendering

function line(text, cls, ev) {
  return h('div', { class: 'alog-line ' + (cls || ''), ...(ev && ev.at ? { title: new Date(ev.at).toLocaleString() } : {}) }, h('span', { class: 'alog-txt' }, text));
}

function append(node) {
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  logEl.append(node);
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
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

// A what-if draft: what it would change, with Apply draft (code changes only) and Discard.
function draftLine(ev, status) {
  const d = ev.draft || {};
  const done = h('div', { class: 'alog-done' });
  const buttons = h('div', { class: 'alog-btns' });
  const errors = h('div', {});
  const setDone = word => { buttons.remove(); done.textContent = word; };
  const canApply = !!(d.items && d.items[0] && d.items[0].code);
  const yes = h('button', { type: 'button', class: 'small', 'data-act': 'accept', onclick: async () => {
    yes.disabled = no.disabled = true; errors.replaceChildren();
    try {
      const r = await agentApi().acceptDraft(d.id);
      if (r && r.accepted) { setDone('Applied.'); await hooks.afterTurn(); return; }
    } catch (e) { errors.replaceChildren(h('div', { class: 'grey' }, couldNot(e.message))); }
    yes.disabled = no.disabled = false;
    await hooks.afterTurn();
  } }, 'Apply draft');
  const no = h('button', { type: 'button', class: 'small', 'data-act': 'discard', onclick: async () => {
    yes.disabled = no.disabled = true; errors.replaceChildren();
    try { await agentApi().discardDraft(d.id); setDone('Discarded.'); await hooks.afterTurn(); return; }
    catch (e) { errors.replaceChildren(h('div', { class: 'grey' }, couldNot(e.message))); }
    yes.disabled = no.disabled = false;
  } }, 'Discard');
  buttons.append(...(canApply ? [yes] : []), no);
  const body = [h('div', { class: 'draftlead' }, ev.text)];
  if (d.result) body.push(...whatIfLines(d.result).map(t => h('div', { class: 'alog-num' }, t)));
  if (status === 'proposed') body.push(buttons, done, errors);
  const e = line('', 'alog-draft', ev);
  e.querySelector('.alog-txt').append(h('div', { class: 'draftcard' }, body));
  e.dataset.draft = d.id || '';
  return e;
}

// The sign-off the agent asks for, as a plain bordered card. Only this button records a sign-off the agent asked for.
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
    const mark = !reconfirm && hooks.queueMark ? hooks.queueMark() : null;
    try {
      const res = await agentApi().confirmSignoff(r.id, { reviewer: who, comment: comment.value.trim(), valuesOnlyReason: reason ? reason.value.trim() : undefined });
      if (res && res.signed === false) {
        errors.replaceChildren(h('div', { class: 'grey' }, res.error || 'Not signed.'));
        if (res.request && res.request.status && res.request.status !== 'pending') settled(res.request.status === 'expired' ? 'Expired.' : 'Not signed.');
        else { refresh(); no.disabled = false; }
        await hooks.afterTurn(); return;
      }
      settled(`${reconfirm ? 'Re-confirmed' : 'Signed off'} by ${who}.`); await hooks.afterTurn();
      if (mark) hooks.queueAdvance(mark);   // the item on show was signed off: on to the next in the review queue
      return;
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
  const e = line('', 'alog-signoff', ev);
  e.querySelector('.alog-txt').append(h('div', {}, ev.text || ''), card);
  e.dataset.request = r.id || '';
  e.dataset.kind = r.kind || ''; e.dataset.name = r.name || '';
  e._settle = word => { if (e.querySelector('button[data-act]')) { buttons.remove(); done.textContent = word; } };
  return e;
}

// The push the agent asks for: a plain card with the commits that would go. Only the Push button pushes.
// status: 'proposed' (live buttons), or how it ended: 'pushed', 'declined', 'expired', 'superseded', 'closed'.
function pushCard(ev, status) {
  const r = ev.request || {};
  const done = h('div', { class: 'alog-done' });
  const buttons = h('div', { class: 'alog-btns' });
  const errors = h('div', {});
  const settled = word => { buttons.remove(); done.textContent = word; };
  const yes = h('button', { type: 'button', class: 'small', 'data-act': 'push', onclick: async () => {
    yes.disabled = no.disabled = true; errors.replaceChildren(); done.textContent = 'Working…';
    try {
      const res = await agentApi().confirmPush(r.id);
      if (res && res.pushed === false) {
        done.textContent = '';
        errors.replaceChildren(h('div', { class: 'grey' }, res.error || 'Not pushed.'));
        if (res.request && res.request.status && res.request.status !== 'pending') settled(res.request.status === 'expired' ? 'Expired.' : 'Not pushed.');
        else { yes.disabled = no.disabled = false; }
        await hooks.afterTurn(); return;
      }
      settled((res && res.text) || 'Pushed.'); await hooks.afterTurn(); return;
    } catch (e) { done.textContent = ''; errors.replaceChildren(h('div', { class: 'grey' }, couldNot(e.message))); }
    yes.disabled = no.disabled = false;
  } }, 'Push');
  const no = h('button', { type: 'button', class: 'small', 'data-act': 'decline-push', onclick: async () => {
    yes.disabled = no.disabled = true; errors.replaceChildren();
    try { await agentApi().declinePush(r.id); settled('Not pushed.'); await hooks.afterTurn(); return; }
    catch (e) { errors.replaceChildren(h('div', { class: 'grey' }, couldNot(e.message))); }
    yes.disabled = no.disabled = false;
  } }, 'Not now');
  buttons.append(yes, no);
  const commits = r.commits || [];
  const card = h('div', { class: 'alog-card pushcard', 'data-request': r.id || '', 'data-kind': 'push' },
    h('div', { class: 'cardtitle' }, `Push ${r.branch || ''} to GitHub`),
    h('div', { class: 'row' }, h('span', {}, 'Remote'), h('span', { class: 'r' }, r.remote || '')),
    h('div', { class: 'cardsec' }, `${commits.length} commit${commits.length === 1 ? '' : 's'} not on GitHub yet`),
    ...commits.map(c => h('div', { class: 'row' }, h('span', {}, c.subject), h('span', { class: 'r mono' }, c.hash))));
  if (status === 'proposed') card.append(buttons, done, errors); else card.append(done);
  if (status === 'pushed' || status === 'signed') done.textContent = 'Pushed.';
  else if (status === 'declined' || status === 'closed') done.textContent = 'Not pushed.';
  else if (status === 'expired') done.textContent = 'Expired: the branch or remote changed after this was asked.';
  else if (status === 'superseded') done.textContent = 'Superseded by a newer request.';
  const e = line('', 'alog-signoff alog-push', ev);
  e.querySelector('.alog-txt').append(h('div', {}, ev.text || ''), card);
  e.dataset.request = r.id || ''; e.dataset.kind = 'push'; e.dataset.name = 'push';
  e._settle = word => { if (e.querySelector('button[data-act]')) { buttons.remove(); done.textContent = word; } };
  return e;
}

// Only what needs the reviewer's own click is drawn here. Every other draft is approved in the centre pane.
function render(ev, status) {
  if (ev.type === 'draft') return ev.draft && ev.draft.kind === 'what_if' ? draftLine(ev, status || 'proposed') : null;
  if (ev.type === 'signoff_request') return signoffCard(ev, status || 'proposed');
  if (ev.type === 'push_request') return pushCard(ev, status || 'proposed');
  return null;
}

// ---------------------------------------------------------------- loading and events

// When the window opens (or reloads): what still waits for a click, read from the request and draft files, oldest first.
const idOf = ev => (ev.request && ev.request.id) || (ev.draft && ev.draft.id) || '';
async function load() {
  logEl.replaceChildren();
  const queued = [];
  loading = { queued };
  const api = agentApi();
  const [drafts, reqs] = await Promise.all([api.drafts().catch(() => []), api.requests().catch(() => [])]);
  loading = null;
  const waiting = [
    ...(reqs || []).filter(q => q.status === 'pending').map(q => ({ type: q.kind === 'push' ? 'push_request' : 'signoff_request', scope: q.scope, at: q.at, text: q.text || '', request: q })),
    ...(drafts || []).filter(d => d.status === 'proposed' && d.kind === 'what_if').map(d => ({ type: 'draft', scope: d.scope, at: d.at, text: d.summary || '', draft: d })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const seen = new Set(waiting.map(idOf));
  for (const ev of [...waiting, ...queued.filter(q => !seen.has(idOf(q)))]) { const n = render(ev); if (n) logEl.append(n); }
  logEl.scrollTop = logEl.scrollHeight;
}

function onEvent(ev) {
  if (ev.type === 'navigate') { if (typeof ev.route === 'string' && /^#\/(tile|module)\/[\w%]+$/.test(ev.route)) location.hash = ev.route; return; }
  if ((ev.type === 'signoff_request' || ev.type === 'push_request') && ev.request) {
    for (const old of logEl.querySelectorAll('.alog-signoff')) {
      if (old.dataset.kind === ev.request.kind && old.dataset.name === ev.request.name && old.dataset.request !== ev.request.id && old._settle) old._settle('Superseded by a newer request.');
    }
  }
  if (loading) loading.queued.push(ev);
  else { const n = render(ev); if (n) append(n); }
  if (ev.type === 'user' || ev.type === 'turn_start') { busy = true; busyScope = ev.scope || null; hooks.onBusy(); }
  else if (ev.type === 'draft') hooks.draftsChanged();
  else if (ev.type === 'done') { void refreshBusy().then(() => hooks.afterTurn()); }
}

async function refreshBusy() {
  let now = false;
  try { now = (await agentApi().status()).busy.length > 0; } catch { now = busy; }
  if (now === busy) return;
  busy = now; if (!now) busyScope = null; hooks.onBusy();
}

// ---------------------------------------------------------------- conversations (Claude Code's own saved ones)

const chatDate = c => (c.last || c.started ? new Date(c.last || c.started).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

async function conversationsDialog() {
  let chats = [];
  const listNode = h('div', { id: 'chats', class: 'chats' });
  const say = h('p', { class: 'warn', id: 'chatserror' });
  const read = async () => { try { chats = await window.api.term.sessions(); } catch { chats = []; } };
  const act = async fn => {
    say.textContent = '';
    try { await fn(); } catch (e) { say.textContent = e.message; }
    await read();
    paint();
  };
  function paint() {
    const rows = chats.map(c => {
      const buttons = h('span', { class: 'chatacts' });
      const normal = () => buttons.replaceChildren(
        c.current ? h('span', { class: 'grey' }, 'on show') : h('button', { type: 'button', class: 'linkbtn', 'data-act': 'open', onclick: async () => { await act(() => window.api.term.openSession(c.id)); document.getElementById('confirm').click(); } }, 'Open'),
        h('button', { type: 'button', class: 'linkbtn', 'data-act': 'delete', onclick: () => buttons.replaceChildren(
          h('button', { type: 'button', class: 'linkbtn warn', 'data-act': 'reallydelete', onclick: () => act(() => window.api.term.deleteSession(c.id)) }, 'Delete for good'),
          h('button', { type: 'button', class: 'linkbtn', 'data-act': 'keep', onclick: normal }, 'Keep')) }, 'Delete'));
      normal();
      return h('div', { class: 'chatrow', 'data-id': c.id },
        h('div', { class: 'chattitle' }, c.title),
        h('div', { class: 'chatmeta' }, h('span', { class: 'grey' }, [chatDate(c), `${c.messages} message${c.messages === 1 ? '' : 's'}`].filter(Boolean).join(', ')), buttons));
    });
    listNode.replaceChildren(...(rows.length ? rows : [h('p', { class: 'grey' }, 'No conversations yet.')]));
  }
  await read();
  paint();
  await formDialog({
    title: 'Conversations', confirm: 'Done', fields: [],
    intro: ['Open starts Claude Code again on that conversation. Deleting removes a conversation for good, here and in Claude Code\'s own /resume list. Sign-offs, drafts and the record of changes kept with each tile and module are not touched.'],
    sections: [listNode, say],
    submit: async () => null });
}

// ---------------------------------------------------------------- actions: they type into Claude Code in the pane

export function send(text) {
  if (!RUNS || !current || !text || !String(text).trim() || busy) return false;
  terminal.type(text, true);
  return true;
}

export function buildModule(id) {
  if (!RUNS || busy) return;
  terminal.type(`Build the tiles of module ${id} that are not built yet.`, true);
}
