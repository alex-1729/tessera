// Tracing a value back to where it comes from, without any link between Excel files.
//
// In the Spreadsheet view, when the selected cell is in a row that holds a quantity, one plain line above the
// spreadsheet says what the row is:
//   - another tile's output, or a carried-forward state (the dark green rows): where it comes from, the source
//     tile's review state in words, and a "Go to source" button (Ctrl+[ or Cmd+[, Excel's "go to precedents");
//   - a parameter or an input series (the bold blue rows): what it is, no button;
//   - the row a tile is calculated in: which tiles use it, each a link to where it appears as an input there.
// "Go to source" opens the source tile on the same case (or real policy) and selects the same month in its own
// formula row. In the model workbook, where the row is a live link to another sheet, it goes to that sheet instead.
// Each place visited is remembered on its history entry, so Back and Forward return to the cell that was selected.
//
// The grid has no selection-change event; onInspect is fed by the grid's own poll of docInspect().
import { h } from './util.js';
import * as L from './logic.js';
import { colLetter, parseCell, rowMap, rowOf } from './sheetmap.js';

const SCRATCH = 'Scratch';
const INPUTS = 'Inputs';
const FIRST_MONTH = 3;   // column C
// A module's sheet in the model workbook is named after its title, as tilekit's sheet_name() writes it.
const sheetTitle = t => String(t || '').replace(/[[\]:*?/\\]/g, ' ').trim().replace(/^'+|'+$/g, '').slice(0, 31);

// The selected cell of a docInspect() result, as 'D9' (the first cell of a range).
export function selectedCell(ins) {
  if (!ins) return null;
  if (typeof ins.activeCell === 'string') return ins.activeCell;
  return typeof ins.selection === 'string' ? ins.selection : null;
}

// Tiles that read `name`: directly, or a month later through a carried-forward state.
export function usedBy(S, name) {
  const qs = S.graph.quantities, out = [];
  const isTile = n => qs[n] && qs[n].kind === 'tile';
  for (const t of (qs[name] && qs[name].used_by) || []) if (isTile(t)) out.push({ tile: t, as: name, shift: 0 });
  for (const [sn, s] of Object.entries(qs)) {
    if (s.kind !== 'state' || s.from !== name) continue;
    for (const t of s.used_by || []) if (isTile(t)) out.push({ tile: t, as: sn, shift: 1 });
  }
  return out;
}

// What the line says about one selected cell. Pure: S is the app state, view is {view, id} of the route, sheet the
// active sheet's name, at {col, row}, map the sheet's row map. Returns null when there is nothing to say.
export function describe(S, view, sheet, at, map) {
  const name = map && map.rows[at.row];
  const q = name && L.q(S, name);
  if (!q) return null;
  const timeRow = map.timeRows.has(at.row);
  if (at.col < FIRST_MONTH || (timeRow ? at.col >= map.lastCol : at.col !== FIRST_MONTH)) return null;
  const cell = colLetter(at.col) + at.row;
  const label = map.labels[at.row] || q.label || name;
  const sheetModule = view.view === 'model' ? S.graph.modules.find(m => sheetTitle(m.title) === sheet) : null;
  const ownModule = view.view === 'module' ? view.id : sheetModule ? sheetModule.id : null;
  const own = q.kind === 'tile' && (view.view === 'tile' ? name === view.id : q.module === ownModule);
  const key = [view.view, view.id, sheet, cell, name].join('|');

  if (own) {
    return { key, cell, name, text: `${cell} is ${label}.`, users: usedBy(S, name), col: at.col, timeRow };
  }
  if (q.kind === 'param') return { key, cell, name, text: `${cell} is ${label}, the parameter ${name}.` };
  if (q.kind === 'input') {
    if (view.view === 'model' && sheet !== INPUTS) {
      return { key, cell, name, text: `${cell} is ${label}, the input ${name}, from the ${INPUTS} sheet.`,
        go: { within: INPUTS, name, col: at.col } };
    }
    return { key, cell, name, text: `${cell} is ${label}, the input ${name}.` };
  }
  if (q.kind !== 'tile' && q.kind !== 'state') return null;
  const carried = q.kind === 'state';
  const src = carried ? q.from : name;
  const sq = L.q(S, src);
  if (!sq || sq.kind !== 'tile') return null;
  if (carried && timeRow && at.col === FIRST_MONTH) return { key, cell, name, text: `${cell} is ${label}, the starting value of ${name}.` };
  const mod = L.moduleOf(S, sq.module);
  const status = L.stateWord((L.tileStatus(S, src) || {}).state);
  const text = `${cell} is ${label}, ${carried ? 'carried forward from' : 'from'} ${src} in ${mod ? mod.title : sq.module} (${status}).`;
  // a carried-forward value is the source tile's value of the month before
  const go = { tile: src, name: src, col: carried && timeRow ? at.col - 1 : at.col };
  if (view.view === 'model') go.within = mod ? sheetTitle(mod.title) : null;
  else if (view.view === 'module' && sq.module === view.id) go.within = sheet;
  return { key, cell, name, text, go };
}

// ctx: {bar, grid, S(): app state, route(): {view, id, key}, covered(): bool (another line has the bar, or the
//       spreadsheet is not in front), idle(): Promise (the view has rendered), caseSheet(): the case or policy sheet a
//       tile workbook should show when coming from the model view, setCase(routeKey, sheetName)}
export function createTrace(ctx) {
  const { bar, grid } = ctx;
  let shown = null, paintedKey = null;
  let moving = false;      // a jump is in progress; the poll leaves the line alone
  let seq = 0;
  const maps = new Map();  // workbook open count | sheet -> Promise of its row map

  const gc = () => grid.gc();
  const read = (range, sheet) => gc().execute('sheet.read', { range, sheet, formulas: true }).then(r => r.values);
  const opens = () => (window.__gridLog ? window.__gridLog.opens.length : 0);
  function mapOf(sheet, usedRange) {
    const key = `${opens()}|${grid.current}|${sheet}|${usedRange}`;
    if (!maps.has(key)) {
      if (maps.size > 60) maps.clear();
      maps.set(key, rowMap(read, sheet, usedRange).catch(() => null));
    }
    return maps.get(key);
  }

  function paint() {
    const s = ctx.covered() ? null : shown;
    const key = s ? s.key + '|' + s.text + '|' + moving : null;
    if (key === paintedKey) return;
    paintedKey = key;
    bar.replaceChildren();
    bar.hidden = !s;
    if (!s) return;
    bar.append(s.text);
    if (s.users && s.users.length) {
      bar.append(' Used by ');
      s.users.forEach((u, i) => {
        if (i) bar.append(', ');
        bar.append(h('a', { href: '#/tile/' + encodeURIComponent(u.tile), class: 'traceuse', 'data-tile': u.tile,
          onclick: e => { e.preventDefault(); void follow(s, u); } }, u.tile));
        if (u.shift) bar.append(' (next month)');
      });
      bar.append('.');
    }
    if (s.go) bar.append(' ', h('button', { type: 'button', id: 'gotosource', disabled: moving, title: 'Ctrl+[', onclick: () => void goToSource() }, 'Go to source'));
  }
  function set(next) { shown = next; paint(); }

  // Fed by the grid's poll (null when no workbook is open).
  async function onInspect(ins) {
    if (moving) return;
    const mine = ++seq;
    let next = null;
    try {
      const S = ctx.S();
      const sh = ins && ins.sheets && ins.sheets[ins.activeSheet];
      const at = sh && sh.name !== SCRATCH && S.graph && S.status && grid.current && !ctx.covered() ? parseCell(selectedCell(ins)) : null;
      if (at) next = describe(S, ctx.route(), sh.name, at, await mapOf(sh.name, sh.usedRange));
    } catch { next = null; }
    if (mine === seq && !moving) set(next);
  }
  async function refresh() { try { await onInspect(await gc().docInspect()); } catch { /* the grid is busy */ } }

  async function where() {
    const d = await gc().docInspect();
    const sh = d.sheets[d.activeSheet];
    return { sheets: d.sheets, sheet: sh && sh.name, cell: selectedCell(d) };
  }
  async function select(sheet, cell) {
    const d = await gc().docInspect();
    if (!d.sheets.some(s => s.name === sheet)) return false;
    if ((d.sheets[d.activeSheet] || {}).name !== sheet) await gc().execute('sheet.activate', { sheet });
    await gc().execute('selection.set', { range: cell });
    return true;
  }
  // Select `name`'s row on a sheet of the open workbook (the wanted sheet, else the one in front), in column `col`
  // (the same month) when the row has it, the first month otherwise.
  async function place(wanted, name, col) {
    const d = await gc().docInspect();
    const sh = d.sheets.find(s => s.name === wanted) || d.sheets[d.activeSheet];
    if (!sh || sh.name === SCRATCH) return null;
    const map = await mapOf(sh.name, sh.usedRange);
    const row = rowOf(map, name);
    if (!row) return null;
    const ok = map.timeRows.has(row) && col >= FIRST_MONTH && col < map.lastCol;
    const cell = colLetter(ok ? col : FIRST_MONTH) + row;
    return (await select(sh.name, cell)) ? { sheet: sh.name, cell } : null;
  }

  // Each history entry remembers the cell that was selected there.
  const remember = at => { try { history.replaceState({ ...(history.state || {}), trace: at }, ''); } catch { /* no history */ } };
  const hashChanged = () => new Promise(r => { const t = setTimeout(r, 3000); window.addEventListener('hashchange', () => { clearTimeout(t); r(); }, { once: true }); });

  async function jump(target) {
    if (moving) return;
    moving = true; paint();
    try {
      const from = await where();
      if (from.sheet && from.cell) remember({ sheet: from.sheet, cell: from.cell });
      let landed = null;
      if (target.within) {
        history.pushState({}, '', location.hash);
        landed = await place(target.within, target.name, target.col);
      } else {
        const r = ctx.route();
        const sheet = r.view === 'model' ? ctx.caseSheet() : from.sheet;
        const hash = '#/tile/' + encodeURIComponent(target.tile);
        if (sheet) ctx.setCase('tile/' + target.tile, sheet);
        if (location.hash !== hash) { const changed = hashChanged(); location.hash = hash; await changed; }
        await ctx.idle();
        landed = await place(sheet, target.name, target.col);
      }
      if (landed) remember(landed);
    } catch { /* the line is advisory */ } finally { moving = false; shown = null; paintedKey = null; paint(); await refresh(); }
  }
  function goToSource() { return shown && shown.go ? jump(shown.go) : Promise.resolve(); }
  // A "Used by" link: the using tile, at the row where this quantity comes in (a month later through a state).
  function follow(s, u) { return jump({ tile: u.tile, name: u.as, col: s.timeRow ? s.col + u.shift : FIRST_MONTH }); }

  window.addEventListener('popstate', async e => {
    const at = e.state && e.state.trace;
    if (!at || moving) return;
    moving = true;
    try {
      await new Promise(r => setTimeout(r, 30));   // a hashchange, when there is one, starts its render first
      await ctx.idle();
      await select(at.sheet, at.cell);
    } catch { /* the workbook may have gone */ } finally { moving = false; shown = null; paintedKey = null; paint(); await refresh(); }
  });

  // Ctrl+[ / Cmd+[ wherever the focus is: in the window or inside the spreadsheet's frame.
  const onKey = e => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || (e.key !== '[' && e.code !== 'BracketLeft')) return;
    if (!shown || !shown.go || ctx.covered()) return;
    e.preventDefault(); e.stopPropagation();
    void goToSource();
  };
  window.addEventListener('keydown', onKey, true);
  grid.ready.then(() => { try { grid.frame.contentWindow.addEventListener('keydown', onKey, true); } catch { /* no frame */ } });

  // The other lines above the spreadsheet come first: when one of them appears, this one goes at once.
  const watch = new MutationObserver(() => paint());
  for (const el of ctx.watch || []) watch.observe(el, { attributes: true, attributeFilter: ['hidden'] });

  const api = { onInspect, refresh, goToSource, select, where, get shown() { return shown; }, get moving() { return moving; } };
  window.__trace = api;
  return api;
}
