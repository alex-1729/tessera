const g = window.gridcraft;
const T = 'Units after allocation 1,234.5678';
const ex = (c, p) => g.execute(c, p);
const fonts = [null, 'Calibri', 'Arial', 'Open Sans', 'Times New Roman', 'Ubuntu'];
// Rows 1-6 regular, rows 7-8 bold for a visual comparison.
const rows = [];
fonts.forEach(f => rows.push([f || '(default)', T]));
rows.push(['Open Sans bold', T], ['Calibri bold', T]);
await ex('range.setValues', { range: 'A1:B8', values: rows });
for (let i = 0; i < fonts.length; i++) if (fonts[i]) await ex('home.fontName', { range: `B${i + 1}`, name: fonts[i] });
await ex('home.fontName', { range: 'B7', name: 'Open Sans' });
await ex('home.fontName', { range: 'B8', name: 'Calibri' });
await ex('home.bold', { range: 'B7:B8', on: true });
await ex('home.fontSize', { range: 'A1:B8', size: 14 });
await ex('home.columnWidth', { cols: 'A:A', width: 150 });
await ex('home.columnWidth', { cols: 'B:B', width: 420 });
// Autofit test: same text at 11 pt, one font per column D..I in row 12.
const cols = ['D', 'E', 'F', 'G', 'H', 'I'];
await ex('range.setValues', { range: 'D12:I12', values: [cols.map(() => T)] });
for (let i = 0; i < cols.length; i++) if (fonts[i]) await ex('home.fontName', { range: `${cols[i]}12`, name: fonts[i] });
await ex('home.autofitColumnWidth', { cols: 'D:I' });
const out = {};
for (let i = 0; i < cols.length; i++) {
  const c = await g.request('cell.get', { cell: `${cols[i]}12` });
  out[cols[i]] = { font: fonts[i] || 'default', style_font: JSON.stringify(c.style && c.style.font) };
}
const doc = await g.docInspect();
out.docKeys = Object.keys(doc);
out.docSheet = JSON.stringify(doc.sheets || doc).slice(0, 1500);
await new Promise(r => setTimeout(r, 1500));
return out;
