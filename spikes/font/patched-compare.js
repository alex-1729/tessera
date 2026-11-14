// Page script for run.cjs against the patched build: one row per font/style, same text, 14 pt;
// then autofit an Open Sans column and a Calibri column at 11 pt and report their widths.
const g = window.gridcraft;
const T = 'Units after allocation 1,234.5678';
const ex = (c, p) => g.execute(c, p);
const rows = [
  ['Open Sans', 'Open Sans', false, false],
  ['Open Sans bold', 'Open Sans', true, false],
  ['Open Sans italic', 'Open Sans', false, true],
  ['Open Sans bold italic', 'Open Sans', true, true],
  ['open sans (lower case) bold', 'open sans', true, false],
  ['Calibri', 'Calibri', false, false],
  ['Calibri bold', 'Calibri', true, false],
  ['(default)', null, false, false],
];
await ex('range.setValues', { range: `A1:B${rows.length}`, values: rows.map(r => [r[0], T]) });
for (let i = 0; i < rows.length; i++) {
  const [, name, b, it] = rows[i];
  const cell = `B${i + 1}`;
  if (name) await ex('home.fontName', { range: cell, name });
  if (b) await ex('home.bold', { range: cell, on: true });
  if (it) await ex('home.italic', { range: cell, on: true });
}
await ex('home.fontSize', { range: `A1:B${rows.length}`, size: 14 });
await ex('home.columnWidth', { cols: 'A:A', width: 200 });
await ex('home.columnWidth', { cols: 'B:B', width: 420 });
// Autofit: D = Open Sans, E = Calibri, F = Open Sans bold, G = default, at 11 pt.
await ex('range.setValues', { range: 'D12:G12', values: [[T, T, T, T]] });
await ex('home.fontName', { range: 'D12', name: 'Open Sans' });
await ex('home.fontName', { range: 'E12', name: 'Calibri' });
await ex('home.fontName', { range: 'F12', name: 'Open Sans' });
await ex('home.bold', { range: 'F12', on: true });
await ex('home.autofitColumnWidth', { cols: 'D:G' });
const doc = await g.docInspect();
await new Promise(r => setTimeout(r, 1500));
const saved = await ex('file.saveBytes', { format: 'xlsx' });
return { savedBase64: saved && saved.base64, docSheet: JSON.stringify(doc.sheets || doc).slice(0, 3000) };
