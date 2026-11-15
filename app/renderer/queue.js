// The review queue: one list of everything that still needs the reviewer, upstream first, with its count in the top bar.
// The list itself comes from `tilekit queue` (S.queue); nothing about review state is decided here. The queue only
// navigates, and offers the existing rebuild and re-confirm for tiles whose values alone changed. It never signs off.
import { h } from './util.js';
import { formDialog } from './dialog.js';

const $ = id => document.getElementById(id);
const MAC = /Mac/.test(navigator.platform || '');
const keyName = k => (MAC ? '⌘' : 'Ctrl+') + k;

export const itemKey = i => i.level === 'model' ? 'model' : i.level + '/' + i.id;
export const itemHref = i => i.level === 'model' ? '#/model' : `#/${i.level}/${encodeURIComponent(i.id)}`;
const routeKey = r => r.view === 'model' || !r.id ? 'model' : r.view + '/' + r.id;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// o = {S, api, route(), busy(), reviewer() -> Promise<string>, refresh() -> Promise (reload and repaint), fail(message)}
export function createQueue(o) {
  let open = false;
  let cursor = 0;      // the place in the queue last visited, for Next and Previous from a view that is not in the queue

  const items = () => (o.S.queue && o.S.queue.items) || [];
  const here = () => { const k = routeKey(o.route()); return items().findIndex(i => itemKey(i) === k); };
  // Where Next (+1) and Previous (-1) lead: the neighbour of the item on show, or the place last visited.
  function target(dir) {
    const list = items(), at = here();
    const to = at >= 0 ? at + dir : Math.min(cursor, list.length - 1) + (dir < 0 ? -1 : 0);
    return to >= 0 && to < list.length ? list[to] : null;
  }
  function go(item) { if (item) location.hash = itemHref(item); }
  function step(dir) { if (!o.busy()) go(target(dir)); }

  function setOpen(on) {
    open = on;
    $('queue').hidden = !open;
    $('queuebtn').setAttribute('aria-expanded', String(open));
    if (open) paintList();
  }

  function row(item, current) {
    const name = item.level === 'tile' ? item.id : item.level === 'module' ? 'Module sheet' : 'Whole model';
    return h('a', { href: itemHref(item), class: 'qitem' + (current ? ' cur' : ''), 'data-key': itemKey(item), ...(current ? { 'aria-current': 'true' } : {}),
      onclick: () => setOpen(false) },
    h('span', { class: 'qname' }, h('b', {}, name), item.level === 'tile' && item.label ? h('i', {}, item.label) : null),
    h('span', { class: 'qwhy' }, item.reason));
  }

  function paintList() {
    const list = items(), q = o.S.queue, at = here();
    const body = [h('div', { class: 'qhead' }, h('h2', {}, 'Review queue'),
      h('button', { type: 'button', class: 'linkbtn keep', id: 'queueclose', onclick: () => setOpen(false) }, 'Close'))];
    if (!q) body.push(h('p', { class: 'grey', id: 'queuenone' }, 'The review queue could not be read.'));
    else if (!list.length) body.push(h('p', { id: 'queuenone' }, 'Nothing needs review. Every tile, every module and the model are signed off.'));
    else {
      body.push(h('p', { class: 'grey', id: 'queuesum' }, `${plural(list.length, 'item')} to review, upstream first. Signing off in this order avoids reviewing anything twice.`));
      const n = q.counts.reconfirm || 0;
      if (n) body.push(h('div', { id: 'queuebulk' },
        h('span', {}, `${plural(n, 'tile')} changed in values only, not in formula.`),
        h('button', { type: 'button', id: 'queuereconfirm', disabled: o.busy(), onclick: () => bulk() }, `Rebuild and re-confirm (${n})`)));
      let group = null;
      const rows = h('div', { id: 'queuelist' });
      list.forEach((item, i) => {
        const title = item.level === 'model' ? 'Model' : (item.module_title || item.module);
        if (title !== group) { group = title; rows.append(h('h3', { class: 'qmod' }, title)); }
        rows.append(row(item, i === at));
      });
      body.push(rows);
    }
    $('queue').replaceChildren(...body);
    const cur = $('queue').querySelector('.qitem.cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  // The top bar: the count, Previous and Next, and the place of the view on show in the queue.
  function paint() {
    const list = items(), at = here();
    if (at >= 0) cursor = at;
    $('queuecount').textContent = o.S.queue ? String(list.length) : '';
    $('queuebtn').title = o.S.queue ? (list.length ? `${plural(list.length, 'item')} to review` : 'Nothing needs review') : '';
    $('queuepos').textContent = at >= 0 ? `${at + 1} of ${list.length}` : '';
    $('queueprev').disabled = !target(-1) || o.busy();
    $('queuenext').disabled = !target(1) || o.busy();
    if (open) paintList();
  }

  // ---- sign-off: the queue records nothing; after the reviewer's own sign-off it only moves on.
  // mark() before the sign-off remembers what followed the item on show; advance(mark) after it goes to the first
  // of those still in the queue (or back to the first item left, or stays when nothing is left).
  function mark() {
    const list = items(), at = here();
    return { key: routeKey(o.route()), after: at >= 0 ? list.slice(at + 1).map(itemKey) : [] };
  }
  function advance(m) {
    if (!m || !o.S.queue || routeKey(o.route()) !== m.key) return;       // the reviewer has already gone somewhere else
    const list = items();
    if (list.some(i => itemKey(i) === m.key)) return;       // still in the queue (for example the sign-off was refused)
    const next = list.find(i => m.after.includes(itemKey(i))) || list[0];
    if (!next) { o.S.notice = 'Signed off. Nothing else needs review.'; return; }
    go(next);
  }

  // ---- the bulk action: rebuild the out-of-date workbooks of tiles with values-only drift, run the model's tests
  // when a listed tile's test has not been run on the changed model, then `tilekit reconfirm`.
  // `reconfirm` itself re-signs only tiles whose formula is unchanged, whose check rows pass and whose own test
  // passes, and lists the rest.
  async function bulk() {
    const listed = items().filter(i => i.level === 'tile' && i.reconfirm);
    if (!listed.length || o.busy()) return;
    const names = listed.map(i => i.id);
    let did = false;
    await formDialog({
      title: 'Rebuild and re-confirm',
      intro: [`${plural(names.length, 'tile')} went stale because upstream values changed; their own formulas did not. Their workbooks are rebuilt first and the model's tests are run. A tile is re-confirmed only if its formula is still the one signed off, every check row passes and its own test passes; the others stay in the queue.`],
      sections: [h('div', { id: 'bulktiles' }, listed.map(i => h('div', { class: 'row' }, h('span', {}, i.id), h('span', { class: 'r' }, i.module_title || i.module))))],
      fields: [{ id: 'reviewer', label: 'Reviewed by', value: await o.reviewer() }],
      confirm: 'Rebuild and re-confirm',
      submit: async (v, say) => {
        const stale = listed.filter(i => i.reconfirm === 'after_rebuild');
        for (const i of stale) { say(`Rebuilding ${i.id}…`); await o.api.tk('build', ['--tile', i.id]); }
        // a re-confirmation is a new sign-off: each tile's test must have passed on the model as it is now
        const waiting = ((await o.api.tk('queue')).items || []).some(i => i.level === 'tile' && names.includes(i.id) && i.reconfirm === 'after_tests');
        if (waiting) { say('Running the tests…'); await o.api.tk('test'); }
        // Re-confirm only what was listed: if anything else has become eligible meanwhile, stop and show the new list.
        const now = ((await o.api.tk('queue')).items || []).filter(i => i.level === 'tile' && i.reconfirm === 'ready').map(i => i.id);
        const extra = now.filter(t => !names.includes(t));
        did = stale.length > 0 || waiting;
        if (extra.length) return [`The model changed meanwhile (${extra.join(', ')}). Nothing was re-confirmed; close this and start again.`];
        if (!now.length) return { result: ['Nothing could be re-confirmed. The tiles stay in the queue for a full review.'] };
        const res = await o.api.tk('reconfirm', ['--reviewer', v.reviewer]);
        did = true;
        const done = res.reconfirmed || [], skipped = res.skipped || [];
        return { result: [`Re-confirmed ${plural(done.length, 'tile')} as ${v.reviewer}${done.length ? ': ' + done.join(', ') : ''}.`,
          ...skipped.map(s => `Not re-confirmed: ${s.name || s.tile} (${s.reason}).`)] };
      },
    });
    if (did) await o.refresh();
  }

  $('queuebtn').addEventListener('click', () => setOpen(!open));
  $('queueprev').addEventListener('click', () => step(-1));
  $('queuenext').addEventListener('click', () => step(1));
  $('queueprev').title = `Previous item in the review queue (${keyName('K')})`;
  $('queuenext').title = `Next item in the review queue (${keyName('J')})`;
  document.addEventListener('mousedown', e => { if (open && !e.target.closest('#queue, #queuebtn, #overlay')) setOpen(false); });
  // Cmd/Ctrl+J next, Cmd/Ctrl+K previous, Cmd/Ctrl+Shift+J the list (the Review menu has the same items)
  const onKey = e => {
    if (e.key === 'Escape' && open && !$('overlay')) { setOpen(false); return; }
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'j' && k !== 'k') return;
    if (document.body.classList.contains('launching') || $('overlay')) return;
    e.preventDefault();
    if (k === 'j' && e.shiftKey) setOpen(!open);
    else if (!e.shiftKey) step(k === 'j' ? 1 : -1);
  };

  return { paint, mark, advance, step, toggle: () => setOpen(!open), close: () => setOpen(false), isOpen: () => open, onKey, bulk, target };
}
