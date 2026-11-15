// The chat: the right bar. ONE conversation per model: the log shows every exchange, newest at the bottom, with a thin
// divider naming the selection (a tile, a module, the model) whenever it changes between messages. The input is pinned
// at the bottom. Every message is sent with the current selection as its scope. Views call mount(scope) when they render.
// scope: {level: 'model' | 'module' | 'tile', id}
import { h, fmtNumber, plainFormula } from './util.js';
import { markdown } from './markdown.js';
import { formDialog } from './dialog.js';
import * as terminal from './terminal.js';

const agentApi = () => (window.api && window.api.agent) || null;

export const logEl = h('div', { class: 'agentlog-log', id: 'agentlog-log' });
export const inputEl = h('textarea', { class: 'agentlog-input', id: 'agentlog-input', rows: 2, autocomplete: 'off', maxlength: 8000, 'aria-label': 'Message to the agent' });
const stopEl = h('button', { type: 'button', id: 'agentlog-stop', class: 'agent-stop', hidden: true, onclick: () => stop() }, 'Stop');
const workingEl = h('div', { class: 'alog-line alog-working', id: 'agentlog-working' }, h('span', { class: 'alog-lab' }), h('span', { class: 'alog-txt grey' }, 'Working…'));
const startersEl = h('div', { class: 'starters', id: 'starters' });
const noneEl = h('div', { id: 'chatnone', hidden: true }, 'The agent is not available in this mode.');
// New conversation and the list of earlier ones; shown when the agent keeps conversations.
const newEl = h('button', { type: 'button', class: 'linkbtn', id: 'chatnew', onclick: () => newConversation() }, 'New conversation');
const listEl = h('button', { type: 'button', class: 'linkbtn', id: 'chatlist', onclick: () => conversationsDialog() }, 'Conversations…');
const topEl = h('div', { class: 'agentlog-top', id: 'agentlog-top', hidden: true }, newEl, listEl);
// With Claude Code in the pane (terminal mode) the conversation is in the terminal; the log above it holds only the
// cards that need a click (drafts, sign-off and push requests), and the app's own input is not shown.
const TERM = terminal.available();
// Above the terminal: Claude Code's own commands for a new conversation and for the earlier ones.
const termTop = h('div', { class: 'agentlog-top', id: 'term-top' },
  h('button', { type: 'button', class: 'linkbtn', id: 'termnew', title: 'Types /clear', onclick: () => terminal.type('/clear', true) }, 'New conversation'),
  h('button', { type: 'button', class: 'linkbtn', id: 'termresume', onclick: () => conversationsDialog() }, 'Conversations…'));
// A card stays while it waits for a click; a few seconds after it is settled (applied, discarded, signed, declined) it goes.
if (TERM) new MutationObserver(() => setTimeout(() => {
  for (const l of logEl.querySelectorAll('.alog-line')) if (!l.querySelector('button[data-act]')) l.remove();
}, 4000)).observe(logEl, { childList: true, subtree: true });
export const section = h('section', { class: 'agentlog' + (TERM ? ' termmode' : ''), id: 'agentlog', hidden: !agentApi() },
  topEl, logEl, TERM ? termTop : null, TERM ? terminal.el : null, h('div', { class: 'agentlog-bottom' }, startersEl, h('div', { class: 'agentlog-row' }, inputEl, stopEl)));
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
// What the agent is working on right now ({level, id}), or null: the selection its running turn was sent with.
let busyScope = null;
export const workingOn = () => (busy ? busyScope : null);
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
  if (TERM) { void window.api.term.select(scope).catch(() => {}); queueMicrotask(() => terminal.show()); }
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
export function prefill(text) { if (TERM) { terminal.type(text, false); return; } inputEl.value = text; autosize(); }

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

// What was said is drawn as a speech bubble: the reviewer's on the right, the agent's on the left.
function bubble(e) { e.querySelector('.alog-txt').classList.add('alog-bubble'); return e; }

function append(node) {
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  logEl.append(node);
  paintWorking();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

function paintWorking() {
  if (TERM) { workingEl.remove(); return; }
  if (busy) { logEl.append(workingEl); logEl.scrollTop = logEl.scrollHeight; }
  else workingEl.remove();
  inputEl.disabled = busy;
  newEl.disabled = busy || shown === 0; listEl.disabled = busy;
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

// A default shown the way the workbook will show it: percentages as percentages, amounts with two decimals.
function draftValue(v, format) {
  if (typeof v !== 'number') return v === undefined || v === null ? '' : String(v);
  if (format === 'percent' || format === 'rate' || format === 'irr') return (v * 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + '%';
  if (format === 'amount') return v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (format === 'integer') return v.toLocaleString('en-GB', { maximumFractionDigits: 0 });
  return fmtNumber(v);
}

// What a draft would add or change, as a small table: what it is called in words, its name in the code, and its
// default, layer or units where it has one. A line of purpose or formula goes under the row it belongs to.
function draftItems(d) {
  const items = d.items || [];
  const rows = [];
  for (const it of items) {
    if (typeof it === 'string') { rows.push(h('tr', { class: 'draftitem' }, h('td', { colspan: '3' }, it))); continue; }
    const name = it.id && it.name && it.id !== it.name ? it.id : (it.name || it.id || it.table || '');
    const words = it.label || it.title || (it.id && it.name && it.id !== it.name ? it.name : '') || it.purpose || '';
    const value = it.default !== undefined && it.default !== null ? draftValue(it.default, it.format)
      : it.example !== undefined && it.example !== null ? draftValue(it.example, it.format) : '';
    const aside = value !== '' ? h('td', { class: 'dval' }, value) : h('td', { class: 'dside' }, it.layer || it.units || (it.columns ? `${it.columns.length} columns` : '') || it.type || '');
    if (!name && !words) continue;
    rows.push(h('tr', { class: 'draftitem' }, h('td', { class: 'dwords' }, words || name), h('td', { class: 'dname' }, words ? name : ''), aside));
    const more = it.formula || it.expression || (it.label || it.title ? it.purpose : '') || it.spec || it.description || '';
    if (more) rows.push(h('tr', { class: 'draftmore' }, h('td', { colspan: '3' }, String(more))));
  }
  if (!rows.length) return [];
  const head = { tiles: 'Tiles to add', modules: 'Modules to add', params: 'Parameters to add', inputs: 'Inputs to add', cases: 'Cases to add', module_test: 'Module test' }[d.kind] || 'Changes';
  return [h('div', { class: 'draftlist' }, h('div', { class: 'cardsec' }, head + (d.module ? ` (in ${d.module})` : '')), h('table', { class: 'drafttable' }, h('tbody', {}, rows)))];
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
  const lead = isWhatIf ? ev.text : String(ev.text || '').replace(/^Draft:\s*/i, '').replace(/\s*\([^)]*\)\s*(?=\.?$)/, '').replace(/^./, c => c.toUpperCase());
  const body = [h('div', { class: 'draftlead' }, lead)];
  if (isWhatIf && d.result) body.push(...whatIfLines(d.result).map(t => h('div', { class: 'alog-num' }, t)));
  if (!isWhatIf) body.push(...draftItems(d));
  if (!isWhatIf && (d.warnings || []).length) body.push(...d.warnings.map(w => h('div', { class: 'grey' }, w)));
  if (status === 'accepted') body.push(h('div', { class: 'alog-done' }, applyWord));
  else if (status === 'discarded') body.push(h('div', { class: 'alog-done' }, 'Discarded.'));
  else if (status === 'proposed') body.push(buttons, done, errors);
  const e = line('Agent', '', 'alog-draft', ev);
  e.querySelector('.alog-txt').append(h('div', { class: 'draftcard' }, body));
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
  const e = line('Agent', '', 'alog-signoff', ev);
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
  const e = line('Agent', '', 'alog-signoff alog-push', ev);
  e.querySelector('.alog-txt').append(h('div', {}, ev.text || ''), card);
  e.dataset.request = r.id || ''; e.dataset.kind = 'push'; e.dataset.name = 'push';
  e._settle = word => { if (e.querySelector('button[data-act]')) { buttons.remove(); done.textContent = word; } };
  return e;
}

// Questions from the agent as one form: each with its header, the suggested answers (one, or several when the
// question allows it) and a box for an answer of the reviewer's own. Send answers is live once every question has
// an answer. The form goes when it is answered or when the reviewer types a reply instead; the questions stay as text.
let qcardN = 0;
function questionCard(ev) {
  const qs = ev.questions;
  const group = 'q' + (++qcardN);
  const send1 = h('button', { type: 'button', class: 'small', disabled: true }, qs.length === 1 ? 'Send answer' : 'Send answers');
  const parts = qs.map((q, i) => {
    const boxes = (q.options || []).map(o => {
      const box = h('input', { type: q.multi ? 'checkbox' : 'radio', name: `${group}-${i}`, value: o.label });
      return { box, row: h('label', { class: 'qopt' }, box, h('span', {}, h('span', { class: 'qlabel' }, o.label), o.description ? h('span', { class: 'grey' }, ' ' + o.description) : null)) };
    });
    const other = h('input', { type: 'text', class: 'qother', autocomplete: 'off', maxlength: 2000, placeholder: boxes.length ? 'Other' : 'Your answer', 'aria-label': 'Another answer' });
    // typing an answer of your own replaces a single choice; with several allowed it is added to them
    other.addEventListener('input', () => { if (!q.multi && other.value.trim()) boxes.forEach(b => { b.box.checked = false; }); paint(); });
    other.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (!send1.disabled) send1.click(); } });
    boxes.forEach(b => b.box.addEventListener('change', () => { if (!q.multi && b.box.checked) other.value = ''; paint(); }));
    const answer = () => [...boxes.filter(b => b.box.checked).map(b => b.box.value), other.value.trim()].filter(Boolean).join(', ');
    return { q, answer, node: h('div', { class: 'qblock' }, h('div', { class: 'cardsec' }, q.header || `Question ${i + 1}`), h('div', { class: 'qtext' }, q.question), boxes.map(b => b.row), other) };
  });
  function paint() { send1.disabled = busy || parts.some(p => !p.answer()); }
  send1.addEventListener('click', () => {
    if (parts.some(p => !p.answer())) return;
    const text = parts.length === 1 ? parts[0].answer() : parts.map((p, i) => `${p.q.header || `Question ${i + 1}`}: ${p.answer()}`).join('\n');
    void send(text);
  });
  const e = line('Agent', '', 'alog-question', ev);
  e.querySelector('.alog-txt').append(h('div', { class: 'alog-qtext alog-bubble' }, markdown(ev.text || '')),
    h('div', { class: 'alog-opts alog-card qcard' }, parts.map(p => p.node), h('div', { class: 'alog-btns' }, send1)));
  return e;
}

// In terminal mode a draft is approved in the centre pane (the Draft to approve tab), so the bar keeps only the
// cards that need the reviewer's own click: sign-off and push requests. What-if drafts stay here.
const CARDS = new Set(['draft', 'signoff_request', 'push_request']);
const inCentre = ev => TERM && ev.type === 'draft' && ev.draft && ev.draft.kind !== 'what_if';

function divider(scope) {
  return h('div', { class: 'alog-divider', 'data-scope': keyOf(scope) }, hooks.titleOf(scope));
}

function render(ev, draftStatus) {
  if (TERM && (!CARDS.has(ev.type) || inCentre(ev))) return null;
  switch (ev.type) {
    case 'user':
      logEl.querySelectorAll('.alog-opts').forEach(n => n.remove());
      return bubble(line('You', ev.text, 'alog-you', ev));
    case 'agent': return bubble(line('Agent', markdown(ev.text), 'alog-agent', ev));
    case 'action': return line('', ev.text, 'alog-action', ev);
    case 'question': {
      if ((ev.questions || []).length) return questionCard(ev);
      const e = bubble(line('Agent', markdown(ev.text), 'alog-question alog-agent', ev));
      if ((ev.options || []).length) {
        e.querySelector('.alog-txt').append(h('div', { class: 'alog-opts' }, ev.options.map(o =>
          h('button', { type: 'button', class: 'small', onclick: () => send(String(o)) }, o))));
      }
      return e;
    }
    case 'draft': return draftLine(ev, draftStatus || 'proposed');
    case 'signoff_request': return signoffCard(ev, draftStatus || 'proposed');
    case 'push_request': return pushCard(ev, draftStatus || 'proposed');
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
  hist.forEach((ev, i) => { if (ev.type === 'user') lastUser = i; if (ev.type === 'question') lastQ = i; if (ev.type === 'signoff_request' || ev.type === 'push_request') lastReq = i; });
  const frag = [];
  hist.forEach((ev, i) => {
    seen.add(sig(ev));
    let st;
    if (ev.type === 'draft') st = status.get(ev.draft && ev.draft.id) || 'gone';
    else if (ev.type === 'signoff_request' || ev.type === 'push_request') {
      // the outcome comes from the request files, not from the log: a confirmed, declined, expired or superseded request has no live buttons
      const q = reqById.get(ev.request && ev.request.id);
      st = q ? (reqWord[q.status] || 'closed') : ((i === lastReq && lastReq > lastUser) ? 'proposed' : 'closed');
      if (q) { ev = { ...ev, request: { ...ev.request, ...q }, reviewer: q.reviewer }; }
    }
    if (TERM && st !== 'proposed') return;
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
  void readChats();
}

function onEvent(ev) {
  if (ev.type === 'navigate') { if (typeof ev.route === 'string' && /^#\/(tile|module)\/[\w%]+$/.test(ev.route)) location.hash = ev.route; return; }
  if ((ev.type === 'signoff_request' || ev.type === 'push_request') && ev.request) {
    for (const old of logEl.querySelectorAll('.alog-signoff')) {
      if (old.dataset.kind === ev.request.kind && old.dataset.name === ev.request.name && old.dataset.request !== ev.request.id && old._settle) old._settle('Superseded by a newer request.');
    }
  }
  if (loading) loading.queued.push(ev);
  else { const n = render(ev); if (n) { shown++; startersEl.hidden = true; append(withDividerFrag(ev, n)); } }
  if (ev.type === 'user' || ev.type === 'turn_start') { busy = true; busyScope = ev.scope || null; paintWorking(); hooks.onBusy(); }
  else if (ev.type === 'draft') hooks.draftsChanged();
  else if (ev.type === 'done') { void refreshBusy().then(() => { void readChats(); return hooks.afterTurn(); }); }
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
  busy = now; if (!now) busyScope = null; paintWorking(); hooks.onBusy();
}

// ---------------------------------------------------------------- conversations

let chats = null;            // [{id, current, title, started, last, messages}], or null when the agent keeps only one
// Where conversations come from: Claude Code's own saved ones in terminal mode, the app's otherwise.
const chatSource = () => (TERM
  ? { list: () => window.api.term.sessions(), open: id => window.api.term.openSession(id), remove: id => window.api.term.deleteSession(id) }
  : { list: () => agentApi().conversations(), open: id => agentApi().openConversation(id), remove: id => agentApi().deleteConversation(id) });

async function readChats() {
  try { chats = TERM || agentApi().conversations ? await chatSource().list() : null; } catch { chats = null; }
  topEl.hidden = !chats || TERM;
  if (chats) listEl.textContent = `Conversations (${chats.length})…`;
  newEl.disabled = busy || shown === 0; listEl.disabled = busy;
  return chats;
}

// The conversation on show is kept with the earlier ones and the chat starts empty.
async function newConversation() {
  if (busy || shown === 0) return;
  try { await agentApi().newConversation(); } catch (e) { append(line('', couldNot(e.message), 'alog-error')); return; }
  await load();
  inputEl.focus();
}

const chatDate = c => (c.last || c.started ? new Date(c.last || c.started).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

async function conversationsDialog() {
  if (busy && !TERM) return;
  const listNode = h('div', { id: 'chats', class: 'chats' });
  const say = h('p', { class: 'warn', id: 'chatserror' });
  const act = async (fn, reloadChat) => {
    say.textContent = '';
    try { await fn(); } catch (e) { say.textContent = e.message; }
    if (reloadChat) await load();
    await readChats();
    paint();
  };
  function paint() {
    const rows = (chats || []).map(c => {
      const buttons = h('span', { class: 'chatacts' });
      const normal = () => buttons.replaceChildren(
        c.current ? h('span', { class: 'grey' }, 'on show') : h('button', { type: 'button', class: 'linkbtn', 'data-act': 'open', onclick: async () => { await act(() => chatSource().open(c.id), true); document.getElementById('confirm').click(); } }, 'Open'),
        h('button', { type: 'button', class: 'linkbtn', 'data-act': 'delete', onclick: () => buttons.replaceChildren(
          h('button', { type: 'button', class: 'linkbtn warn', 'data-act': 'reallydelete', onclick: () => act(() => chatSource().remove(c.id), c.current) }, 'Delete for good'),
          h('button', { type: 'button', class: 'linkbtn', 'data-act': 'keep', onclick: normal }, 'Keep')) }, 'Delete'));
      normal();
      return h('div', { class: 'chatrow', 'data-id': c.id },
        h('div', { class: 'chattitle' }, c.title),
        h('div', { class: 'chatmeta' }, h('span', { class: 'grey' }, [chatDate(c), `${c.messages} message${c.messages === 1 ? '' : 's'}`].filter(Boolean).join(', ')), buttons));
    });
    listNode.replaceChildren(...(rows.length ? rows : [h('p', { class: 'grey' }, 'No conversations yet.')]));
  }
  await readChats();
  paint();
  await formDialog({
    title: 'Conversations', confirm: 'Done', fields: [],
    intro: [TERM ? 'Open starts Claude Code again on that conversation. Deleting removes a conversation for good, here and in Claude Code\'s own /resume list. Sign-offs, drafts and the record of changes kept with each tile and module are not touched.'
      : 'Deleting removes a conversation from this list for good. Sign-offs, drafts and the record of changes kept with each tile and module are not touched.'],
    sections: [listNode, say],
    submit: async () => null });
}

// ---------------------------------------------------------------- actions

export async function send(text, extra) {
  const scope = current;
  if (!scope || !text || !String(text).trim() || busy) return false;
  if (TERM) { terminal.type(text, true); return true; }
  setBusy(true);
  try { await agentApi().send(scope, String(text), extra); }
  catch (e) { append(line('', couldNot(e.message), 'alog-error')); }
  await refreshBusy();
  return true;
}

export async function buildModule(id) {
  if (busy) return;
  if (TERM) { terminal.type(`Build the tiles of module ${id} that are not built yet.`, true); return; }
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
