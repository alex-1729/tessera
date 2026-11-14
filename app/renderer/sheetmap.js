// Which quantity each row of a generated sheet holds. A sheet says so itself: the code name of a row is written in
// maroon in the column after the last month (time rows) or in column D (parameters and single-cell rows), and the
// plain-English label is in column B. Shared by the typed-formula line (specline.js) and the trace line (trace.js).

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const colLetter = n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
export const colNumber = l => [...l].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);

// 'D9' -> {col: 4, row: 9}; null for anything else (a range is read by its first cell).
export function parseCell(ref) {
  const m = /^\$?([A-Z]+)\$?(\d+)/.exec(String(ref || ''));
  return m ? { col: colNumber(m[1]), row: +m[2] } : null;
}

// read(range, sheet) -> rows of values. Returns null when the sheet has no named rows to speak of, otherwise
// {rows: {row number: code name}, labels: {row number: label}, timeRows: Set of rows whose values run across the
//  months, lastCol: number of the name column, lastRow, monthRow: the "Month" header row or 0}.
export async function rowMap(read, sheet, usedRange) {
  const m = /^[A-Z]+\d+:([A-Z]+)(\d+)$/.exec(usedRange || '');
  if (!m) return null;
  const lastCol = colNumber(m[1]), lastRow = +m[2];
  if (lastCol < 4) return null;
  const nameCol = colLetter(lastCol);
  const [names, params, labelCol] = await Promise.all([
    lastCol >= 5 ? read(`${nameCol}1:${nameCol}${lastRow}`, sheet) : Promise.resolve([]),
    read(`D1:D${lastRow}`, sheet), read(`B1:B${lastRow}`, sheet)]);
  const rows = {}, labels = {}, timeRows = new Set();
  let monthRow = 0;
  const isName = v => typeof v === 'string' && IDENT.test(v);
  params.forEach((r, i) => { if (isName(r[0])) rows[i + 1] = r[0]; });
  names.forEach((r, i) => { if (isName(r[0])) { rows[i + 1] = r[0]; timeRows.add(i + 1); } });
  labelCol.forEach((r, i) => {
    if (typeof r[0] !== 'string') return;
    labels[i + 1] = r[0];
    if (r[0] === 'Month' && !monthRow && lastCol >= 5) monthRow = i + 1;
  });
  return { rows, labels, timeRows, lastCol, lastRow, monthRow };
}

// The row that holds `name` on a mapped sheet (0 when it is not there).
export function rowOf(map, name) {
  if (!map) return 0;
  for (const [row, n] of Object.entries(map.rows)) if (n === name) return +row;
  return 0;
}
