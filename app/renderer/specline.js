// A typed formula as the spec. In the tile view, when the user changes a cell in the tile's own formula row of a
// generated sheet, one plain line above the spreadsheet offers to use it as the spec (an agent turn) or undo it.
// The "generated" formula is what the stored workbook had when it was opened: read once per sheet, then compared.
// Edits elsewhere on a generated sheet are not saved; the same line says so.
import { h } from './util.js';

const SCRATCH = 'Scratch';
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const colLetter = n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
export const colNumber = l => [...l].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);

// ctx: {bar, grid, enabled(): bool (an agent exists), tile(): name | null, caseId(sheetName): id | null, canSend(): bool, send(text, extra): Promise}
export function createSpecLine(ctx) {
  const { bar, grid } = ctx;
  let base = null;           // {opens, tile, sheets: Map name -> {row, cells}}
  let shown = null;          // what the line currently offers
  let working = false;

  const read = (range, sheet) => grid.gc().execute('sheet.read', { range, sheet, formulas: true }).then(r => r.values);

  // Where the tile's formula row is on one sheet, and the row map. Returns null when the sheet has no such row.
  async function locate(sheet, usedRange, tile) {
    const m = /^[A-Z]+\d+:([A-Z]+)(\d+)$/.exec(usedRange || '');
    if (!m) return null;
    const lastCol = colNumber(m[1]), lastRow = +m[2];
    if (lastCol < 5) return null;
    const nameCol = colLetter(lastCol);
    const [names, params] = await Promise.all([read(`${nameCol}1:${nameCol}${lastRow}`, sheet), read(`D1:D${lastRow}`, sheet)]);
    const rows = {};
    params.forEach((r, i) => { if (typeof r[0] === 'string' && IDENT.test(r[0])) rows[i + 1] = r[0]; });
    let row = 0;
    names.forEach((r, i) => { if (typeof r[0] === 'string' && IDENT.test(r[0])) { rows[i + 1] = r[0]; if (r[0] === tile) row = i + 1; } });
    if (!row) return null;
    const cells = (await read(`C${row}:${colLetter(lastCol - 1)}${row}`, sheet))[0];
    return { row, rows, cells };
  }

  async function sheetList() {
    const d = await grid.gc().docInspect();
    return { sheets: d.sheets, active: d.sheets[d.activeSheet] && d.sheets[d.activeSheet].name };
  }

  // Remember the formula row of every generated sheet of the workbook just opened (when it has no edits yet).
  async function capture() {
    const tile = ctx.tile();
    if (!tile || grid.dirty) return;
    const opens = window.__gridLog.opens.length;
    if (base && base.opens === opens && base.tile === tile) return;
    try {
      const { sheets } = await sheetList();
      const map = new Map();
      for (const sh of sheets) {
        if (sh.name === SCRATCH) continue;
        const loc = await locate(sh.name, sh.usedRange, tile);
        if (loc) map.set(sh.name, loc);
      }
      if (!grid.dirty) base = { opens, tile, sheets: map };
    } catch { base = null; }
  }

  function paint() {
    bar.replaceChildren();
    bar.hidden = !shown;
    if (!shown) return;
    if (shown.kind === 'outside') { bar.textContent = 'Changes outside the Scratch sheet are not saved.'; return; }
    const busy = working || !ctx.canSend();
    bar.append(`You changed the formula in ${shown.cell}. `,
      h('button', { type: 'button', id: 'usespec', class: 'agent-stop', disabled: busy, onclick: useIt }, 'Use it as the spec'),
      h('button', { type: 'button', id: 'undospec', class: 'agent-stop', disabled: working, onclick: undo }, 'Undo'));
  }

  function set(next) {
    const same = (shown && next && shown.kind === next.kind && shown.cell === next.cell && shown.formula === next.formula) || (!shown && !next);
    shown = next;
    if (!same) paint();
  }

  // Called by the grid when the workbook has changes (and again on each poll while it has).
  async function onEdit(info) {
    const tile = ctx.tile();
    if (!tile || working) return;
    if (info.sheet === SCRATCH || !info.sheet) return set(null);
    if (!ctx.enabled() || !base || !base.sheets.has(info.sheet)) return set(info.outside || grid.dirty ? { kind: 'outside' } : null);
    const was = base.sheets.get(info.sheet);
    const { sheets } = await sheetList();
    const sh = sheets.find(s => s.name === info.sheet);
    const now = sh && await locate(info.sheet, sh.usedRange, tile);
    if (!now) return set({ kind: 'outside' });
    for (let i = 0; i < was.cells.length; i++) {
      if (now.row === was.row && (was.cells[i] ?? null) !== (now.cells[i] ?? null)) {
        const cell = colLetter(3 + i) + now.row;
        return set({ kind: 'formula', cell, formula: now.cells[i] == null ? '' : String(now.cells[i]), sheet: info.sheet, rows: now.rows });
      }
    }
    set({ kind: 'outside' });
  }

  async function useIt() {
    const s = shown;
    if (!s || s.kind !== 'formula' || !ctx.canSend()) return;
    working = true; paint();
    const extra = { formula: s.formula, cell: s.cell, rows: s.rows };
    const cid = ctx.caseId(s.sheet);
    if (cid) extra.case = cid;
    shown = null; paint();
    // `working` stays on until the workbook has been read again: the grid still holds the typed formula until then,
    // and the poll would offer the line a second time.
    try { await ctx.send('Use the typed formula as the spec.', extra); await grid.reload(); } finally { working = false; }
    shown = null; paint();
    base = null;
    await capture();
  }

  async function undo() {
    working = true; paint();
    try { await grid.reload(); } finally { working = false; }
    shown = null; paint();
    base = null;
    await capture();
  }

  return {
    onEdit, capture, repaint: paint,
    clear() { base = null; shown = null; paint(); },
    get shown() { return shown; },
  };
}
