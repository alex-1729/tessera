// The GridCraft iframe: created once, reused for every view.
import { checksum, b64ToBytes, sleep } from './util.js';

const SAVE_QUIET_MS = 1500;

const SCRATCH = 'Scratch';
const POLL_MS = 700;

// onEdit(info) runs when the user has changed the open workbook (and again on each poll while it stays changed).
// onInspect(ins) is given each poll's docInspect() result (null when no workbook is open): the grid has no
// selection-change event, so whoever follows the selection shares this poll.
// Saving policy: the stored workbook is written back only when the active sheet is Scratch; edits on generated
// sheets are never written (the Python side detects stored workbooks that were changed outside a build).
export function createGrid(host, { author, onError, onEdit, onInspect }) {
  let wanted = { showRibbon: false, showFormulaBar: true };
  let ribbonCollapsed = false;   // GridCraft starts with the ribbon open; view.collapseRibbon toggles
  const frame = document.createElement('iframe');
  frame.title = 'Workbook';
  frame.allow = 'fullscreen; clipboard-read; clipboard-write';
  frame.src = '/gridcraft/?host=parent&chrome=none&author=' + encodeURIComponent(author || '');
  host.append(frame);

  const log = window.__gridLog = { ready: 0, opens: [], dirty: [], saves: 0, failed: [] };
  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });
  let cur = null;           // {path, sum}: the workbook open in the grid
  let dirty = false;
  let opening = false;
  let saveTimer = null;
  let activated = '';
  let pollTimer = null;
  let outside = false;      // an edit was seen while a generated sheet was active; nothing is saved until the workbook is reloaded

  const gc = () => frame.contentWindow.gridcraft;

  window.addEventListener('message', e => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data || {};
    if (d.type === 'gridcraft:ready') { log.ready++; readyResolve(d); setTimeout(() => applyView(), 300); startPoll(); }
    else if (d.type === 'gridcraft:dirty') {
      log.dirty.push(!!d.dirty);
      if (opening) return;
      dirty = !!d.dirty;
      if (dirty) void noteEdit(true); else clearTimeout(saveTimer);
    } else if (d.type === 'gridcraft:failed') { log.failed.push(d.error); onError('The spreadsheet failed to start: ' + d.error); }
  });

  let viewChain = Promise.resolve();
  function applyView() { viewChain = viewChain.then(applyViewNow); return viewChain; }
  async function applyViewNow() {
    try {
      if (!log.ready) return;
      const wantCollapsed = !wanted.showRibbon;
      ribbonCollapsed = !!(await gc().uiInspect()).ui.ribbonCollapsed;
      if (wantCollapsed !== ribbonCollapsed) { await gc().execute('view.collapseRibbon', {}); ribbonCollapsed = wantCollapsed; }
      await gc().execute('view.formulaBar', { on: !!wanted.showFormulaBar });
    } catch { /* the grid may not be ready yet */ }
  }

  async function activeSheetName() {
    try { const d = await gc().docInspect(); const sh = d.sheets[d.activeSheet]; return sh ? sh.name : ''; } catch { return ''; }
  }

  // Called when the grid reports changes. `first` is true for the dirty event itself.
  async function noteEdit(first) {
    if (!cur) return;
    const sheet = await activeSheetName();
    if (first && sheet && sheet !== SCRATCH) outside = true;
    if (sheet === SCRATCH && !outside && !saveTimer) scheduleSave();
    if (onEdit) { try { await onEdit({ sheet, outside }); } catch { /* the line is advisory */ } }
  }
  // The grid sends no event when a reopened workbook becomes dirty again, so ask it regularly while a workbook is open.
  let polling = false;
  async function poll() {
    if (polling || opening) return;
    if (!cur) { if (onInspect) void onInspect(null); return; }
    polling = true;
    try {
      const ins = await gc().docInspect();
      if (!cur || opening) return;
      if (onInspect) void onInspect(ins);
      if (ins.dirty && !dirty) { dirty = true; await noteEdit(true); }
      else if (ins.dirty) await noteEdit(false);
      else if (dirty) { dirty = false; clearTimeout(saveTimer); saveTimer = null; }
    } catch { /* the grid may be busy */ } finally { polling = false; }
  }
  function startPoll() { if (!pollTimer) pollTimer = setInterval(poll, POLL_MS); }
  function stopPoll() { clearInterval(pollTimer); pollTimer = null; }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveNow().catch(e => onError('Could not save the workbook: ' + e.message)); }, SAVE_QUIET_MS);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    if (!cur) return;
    const target = cur;
    if (outside || (await activeSheetName()) !== SCRATCH) return;   // only Scratch edits are written
    const r = await gc().execute('file.saveBytes', { format: 'xlsx' });
    const bytes = b64ToBytes(r.base64);
    const sum = checksum(bytes);
    if (sum !== target.sum) {
      target.sum = sum; // set first so the app does not reload its own save
      await window.api.writeWorkbook(target.path, bytes);
      log.saves++;
    }
    // If the grid still says it has changes, keep watching for more edits.
    try { const ins = await gc().docInspect(); if (ins.dirty && cur === target) scheduleSave(); else dirty = false; } catch { /* ignore */ }
  }

  async function flush() {
    if (cur && (dirty || saveTimer)) await saveNow();
    clearTimeout(saveTimer); saveTimer = null;
  }

  async function sheetNames() {
    try { return (await gc().docInspect()).sheets.map(s => s.name); } catch { return []; }
  }
  const titleNow = async () => { try { return (await gc().docInspect()).title; } catch { return ''; } };
  let nonce = 0;
  // A distinct file name per open lets us see (through docInspect().title) when the new workbook has loaded.
  function openName(path) {
    const parts = path.replace(/\.xlsx$/i, '').split('/');
    const stem = parts.pop(), dir = parts.pop() || 'workbook';
    return (stem === 'workbook' ? dir : `${dir}-${stem.replace(/^workbook-/, '')}`) + (nonce++ % 2 ? ' (2)' : '') + '.xlsx';
  }

  async function openBytes(path, bytes, sum) {
    opening = true;
    try {
      const before = await titleNow();
      const name = openName(path);
      const copy = bytes.slice().buffer;
      frame.contentWindow.postMessage({ type: 'gridcraft:open', name, bytes: copy }, location.origin);
      log.opens.push(path);
      const t0 = Date.now();
      for (;;) {
        await sleep(40);
        if ((await titleNow()) !== before || Date.now() - t0 > 4000) break;
      }
      await sleep(60);
      cur = { path, sum };
      dirty = false; outside = false; clearTimeout(saveTimer); saveTimer = null;
      activated = '';
      await applyView();
    } finally { opening = false; }
  }

  async function activate(candidates) {
    const key = cur.path + '|' + candidates.join(',');
    if (!candidates.length || key === activated) return;
    activated = key;
    const names = await sheetNames();
    const pick = candidates.find(c => names.includes(c));
    if (pick) { try { await gc().execute('sheet.activate', { sheet: pick }); } catch { /* sheet vanished */ } }
  }

  let queue = Promise.resolve();   // show, hide and reload run one at a time
  const serial = fn => { const r = queue.catch(() => {}).then(fn); queue = r; return r; };

  return {
    frame,
    ready,
    // Show a workbook (path relative to the model dir) and make one of the candidate sheets active.
    show: (path, candidates = []) => serial(async () => {
      await ready;
      frame.style.visibility = 'visible';
      const bytes = await window.api.readWorkbook(path);
      const sum = checksum(bytes);
      if (!cur || cur.path !== path) { await flush(); await openBytes(path, bytes, sum); }
      else if (cur.sum !== sum && !dirty) await openBytes(path, bytes, sum);
      await activate(candidates);
    }),
    // Read the stored workbook again, discarding what is in the grid (Undo).
    reload: () => serial(async () => {
      if (!cur) return;
      const path = cur.path, sheet = await activeSheetName();
      const bytes = await window.api.readWorkbook(path);
      await openBytes(path, bytes, checksum(bytes));
      if (sheet) { try { await gc().execute('sheet.activate', { sheet }); } catch { /* the sheet is gone */ } }
    }),
    async activeSheet() { return activeSheetName(); },
    gc: () => gc(),
    get dirty() { return dirty; },
    get outside() { return outside; },
    hide: () => serial(async () => {
      await ready;
      await flush();
      cur = null; activated = ''; dirty = false; outside = false;
      frame.style.visibility = 'hidden';
    }),
    flush,
    applySettings(s) { wanted = { ...wanted, ...s }; return applyView(); },
    forceActivate(candidates) { activated = ''; return cur ? activate(candidates) : Promise.resolve(); },
    get current() { return cur && cur.path; },
  };
}
