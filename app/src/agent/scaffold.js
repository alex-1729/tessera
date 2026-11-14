'use strict';
// Model-level scaffolding drafts beyond tiles: parameters (params.py), inputs (inputs.py, tilekit.toml,
// assumption tables) and cases (cases/*.json). Validation is pure; applying snapshots every file it
// touches, runs check, graph and trace, and restores the snapshot if the model no longer works.
const fs = require('fs');
const path = require('path');
const src = require('./source');
const { count } = require('./validate');

const { FORMATS, SNAKE } = src;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CASE_ID = /^[a-z0-9][a-z0-9_]*$/;
const PY_KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
const RESERVED = new Set(['np', 'tk', 'month', 'months', 'params', 'model_points', 'n_pol', 'shape', 'series']);

const read = f => fs.readFileSync(f, 'utf8');
const finite = x => typeof x === 'number' && Number.isFinite(x);

// ---------------------------------------------------------------- where things live

function tomlFile(modelDir) { return path.join(modelDir, 'tilekit.toml'); }

function refFile(modelDir, ref) {
  // "pkg.params:Params" -> src/pkg/params.py
  const mod = String(ref || '').split(':')[0];
  const base = fs.existsSync(path.join(modelDir, 'src')) ? path.join(modelDir, 'src') : modelDir;
  return path.join(base, ...mod.split('.')) + '.py';
}

function tomlRef(toml, key) {
  const m = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'));
  return m ? m[1] : null;
}

function paramsFile(modelDir) { return refFile(modelDir, tomlRef(read(tomlFile(modelDir)), 'params')); }
function inputsFile(modelDir) { return refFile(modelDir, tomlRef(read(tomlFile(modelDir)), 'inputs')); }

function caseFiles(modelDir) {
  const dir = path.join(modelDir, 'cases');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort(); } catch { /* none */ }
  return names.map(n => ({ id: n.slice(0, -5), file: path.join(dir, n), doc: JSON.parse(read(path.join(dir, n))) }));
}

// Model-point fields: the keys of the existing cases' model points.
function modelPointFields(modelDir) {
  const set = new Set();
  for (const c of caseFiles(modelDir)) for (const k of Object.keys(c.doc.model_point || {})) set.add(k);
  return [...set];
}

function nameProblems(graph, name, what, allowKind) {
  if (!SNAKE.test(name || '')) return [`'${name}' is not a snake_case ${what} name.`];
  if (PY_KEYWORDS.has(name) || RESERVED.has(name)) return [`'${name}' is a reserved word; pick another ${what} name.`];
  const q = graph.quantities[name];
  if (q && q.kind !== allowKind) return [`${name} already exists as a ${q.kind}; names are unique across the model.`];
  const clash = Object.keys(graph.quantities).find(n => n !== name && n.toLowerCase() === name.toLowerCase());
  if (clash) return [`${name} differs from ${clash} only by case; Excel names ignore case.`];
  return [];
}

// ---------------------------------------------------------------- parameters

function validateParams(graph, items) {
  const problems = [];
  const warnings = [];
  const seen = new Set();
  if (!Array.isArray(items) || !items.length) problems.push('The draft has no parameters.');
  for (const it of items || []) {
    const n = it.name;
    const bad = nameProblems(graph, n, 'parameter', 'param');
    if (bad.length) { problems.push(...bad); continue; }
    if (seen.has(n)) problems.push(`${n} appears twice in the draft.`);
    seen.add(n);
    if (!finite(it.default)) problems.push(`${n} needs a finite number as its default.`);
    if (!it.label || !String(it.label).trim()) problems.push(`${n} needs a plain-English label.`);
    if (!FORMATS.includes(it.format)) problems.push(`${n} has format '${it.format}'; use one of ${FORMATS.join(', ')}.`);
    if (it.format === 'integer' && finite(it.default) && !Number.isInteger(it.default)) problems.push(`${n} has format integer but a default that is not a whole number.`);
    if (typeof it.units !== 'string' || !it.units.trim()) problems.push(`${n} needs units (for example "proportion per year").`);
    if (it.format === 'rate' && !/_(pa|pm)$/.test(n)) warnings.push(`${n} is a rate; its name should end _pa or _pm.`);
    if (/["\\\n]/.test(`${it.label}${it.units}`)) problems.push(`${n}: the label and units must be plain text without quotes or backslashes.`);
  }
  return { problems, warnings };
}

function paramsSummary(graph, items) {
  const added = items.filter(i => !graph.quantities[i.name]);
  const changed = items.filter(i => graph.quantities[i.name]);
  const parts = [];
  if (added.length) parts.push(`adds ${count(added.length, 'parameter')} (${added.map(i => i.name).join(', ')})`);
  if (changed.length) parts.push(`changes ${count(changed.length, 'parameter')} (${changed.map(i => i.name).join(', ')})`);
  return parts.join(', ') || 'changes nothing';
}

function pyNumber(v, integer) {
  if (integer) return String(Math.trunc(v));
  const s = String(v);
  return /[.eE]/.test(s) ? s : s + '.0';
}

function paramLine(text, it) {
  const integer = it.format === 'integer' && Number.isInteger(it.default);
  const type = integer ? 'int' : 'float';
  const value = pyNumber(it.default, integer);
  const q = s => JSON.stringify(String(s).trim());
  if (/^def _param\(/m.test(text)) return `    ${it.name}: ${type} = _param(${value}, ${q(it.label)}, ${q(it.format)}, ${q(it.units)})`;
  return `    ${it.name}: ${type} = field(default=${value}, metadata={"label": ${q(it.label)}, "format": ${q(it.format)}, "units": ${q(it.units)}})`;
}

// The Params class body: [{name, start, end}] line ranges (end exclusive), and where the body ends.
function paramsLayout(lines) {
  const cls = lines.findIndex(l => /^class Params\b/.test(l));
  if (cls < 0) throw new Error('params.py has no `class Params`; edit it by hand.');
  let end = lines.length;
  for (let i = cls + 1; i < lines.length; i++) {
    if (lines[i].trim() && !/^\s/.test(lines[i])) { end = i; break; }
  }
  while (end > cls + 1 && !lines[end - 1].trim()) end--;
  const fields = [];
  for (let i = cls + 1; i < end; i++) {
    const m = lines[i].match(/^ {4}([A-Za-z_]\w*)\s*:/);
    if (m) {
      if (fields.length) fields[fields.length - 1].end = i;
      fields.push({ name: m[1], start: i, end });
    }
  }
  for (const f of fields) while (f.end > f.start + 1 && !lines[f.end - 1].trim()) f.end--;
  return { cls, end, fields };
}

function editParams(text, items) {
  let lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  for (const it of items) {
    const layout = paramsLayout(lines);
    const f = layout.fields.find(x => x.name === it.name);
    const line = paramLine(text, it);
    if (f) lines = [...lines.slice(0, f.start), line, ...lines.slice(f.end)];
    else {
      const body = lines.slice(layout.cls + 1, layout.end);
      const onlyPass = body.every(l => !l.trim() || /^\s+(pass|"""[^"]*"""|\.\.\.)\s*$/.test(l)) && body.some(l => /^\s+pass\s*$/.test(l));
      if (onlyPass) lines = [...lines.slice(0, layout.cls + 1), line, ...lines.slice(layout.end)];
      else lines = [...lines.slice(0, layout.end), line, ...lines.slice(layout.end)];
    }
  }
  return lines.join('\n').replace(/\n*$/, '\n');
}

// ---------------------------------------------------------------- inputs

function validateInputs(graph, modelDir, draft) {
  const problems = [];
  const warnings = [];
  const fields = draft.model_point_fields || [];
  const inputs = draft.inputs || [];
  const tables = draft.tables || [];
  if (!fields.length && !inputs.length && !tables.length) problems.push('The draft adds nothing.');
  const existingFields = new Set(modelPointFields(modelDir));
  const newFields = new Set();
  const seen = new Set();
  const once = n => { if (seen.has(n)) problems.push(`${n} appears twice in the draft.`); seen.add(n); };
  for (const f of fields) {
    if (!SNAKE.test(f.name || '') || PY_KEYWORDS.has(f.name) || RESERVED.has(f.name)) { problems.push(`'${f.name}' is not a usable model-point field name.`); continue; }
    if (existingFields.has(f.name)) { problems.push(`${f.name} is already a model-point field.`); continue; }
    const q = graph.quantities[f.name];
    if (q && q.kind !== 'input') problems.push(`${f.name} already exists as a ${q.kind}.`);
    once('field:' + f.name);
    newFields.add(f.name);
    if (!finite(f.example)) problems.push(`Model-point field ${f.name} needs an example value (a number) for the existing cases.`);
    if (!f.label || !String(f.label).trim()) problems.push(`Model-point field ${f.name} needs a label.`);
  }
  const tableNames = new Set((graph.tables || []).map(t => t.name));
  for (const t of tables) {
    if (!SNAKE.test(t.name || '')) { problems.push(`'${t.name}' is not a snake_case table name.`); continue; }
    if (tableNames.has(t.name)) problems.push(`There is already a table ${t.name}.`);
    once('table:' + t.name);
    const cols = t.columns || [];
    if (cols.length < 2 || !cols.every(c => IDENT.test(c)) || new Set(cols).size !== cols.length) problems.push(`Table ${t.name} needs at least two distinct column names (identifiers); the first is the key.`);
    const rows = t.rows || [];
    if (!rows.length) problems.push(`Table ${t.name} has no rows.`);
    if (!rows.every(r => Array.isArray(r) && r.length === cols.length && r.every(finite))) problems.push(`Every row of table ${t.name} needs ${cols.length} finite numbers.`);
    else if (new Set(rows.map(r => r[0])).size !== rows.length) problems.push(`The key column of table ${t.name} repeats a value.`);
    for (const [c, fmt] of Object.entries(t.formats || {})) {
      if (!cols.includes(c) || !FORMATS.includes(fmt)) problems.push(`Table ${t.name}: format '${c}' = '${fmt}' needs a column of the table and one of ${FORMATS.join(', ')}.`);
    }
    if (!t.label || !String(t.label).trim()) problems.push(`Table ${t.name} needs a label.`);
  }
  for (const it of inputs) {
    const n = it.name;
    const bad = nameProblems(graph, n, 'input', 'none');
    if (bad.length) { problems.push(...bad); continue; }
    once(n);
    if (!it.label || !String(it.label).trim()) problems.push(`${n} needs a plain-English label.`);
    if (!FORMATS.includes(it.format)) problems.push(`${n} has format '${it.format}'; use one of ${FORMATS.join(', ')}.`);
    if (!it.description || !String(it.description).trim()) problems.push(`${n} needs a plain-words description of how it is computed.`);
    const code = it.python ? src.normaliseCode(it.python) : '';
    if (!code) {
      if (!newFields.has(n) && !existingFields.has(n)) problems.push(`${n} needs the Python that computes it (assigning ${n} = ...), unless it is a model-point field used as it is.`);
    } else {
      if (!new RegExp(`^${n}\\s*=`, 'm').test(code)) problems.push(`The Python for ${n} must assign ${n} = ... at its top level.`);
      if (/^\s*(import|from|def|class|return|global|nonlocal)\b/m.test(code)) problems.push(`The Python for ${n} must be plain assignments (no import, def, class or return).`);
      if (/\bopen\(|\beval\(|\bexec\(|__import__|\bsubprocess\b|\bos\./.test(code)) problems.push(`The Python for ${n} may only compute arrays (no file or system calls; tables are read with the module's own helpers).`);
    }
    if (it.excel !== undefined && it.excel !== null && it.excel !== '') {
      if (typeof it.excel !== 'string' || !it.excel.startsWith('=')) problems.push(`The excel template of ${n} must start with '='.`);
      else if (/\{\s*\}/.test(it.excel)) problems.push(`The excel template of ${n} has an empty {}.`);
    }
    if (it.format === 'rate' && !/_(pa|pm)$/.test(n)) warnings.push(`${n} is a rate; its name should end _pa or _pm.`);
  }
  return { problems, warnings };
}

function inputsSummary(draft) {
  const parts = [];
  const f = draft.model_point_fields || [], i = draft.inputs || [], t = draft.tables || [];
  if (f.length) parts.push(`adds ${count(f.length, 'model-point field')} (${f.map(x => x.name).join(', ')})`);
  if (i.length) parts.push(`${count(i.length, 'input series', 'input series')} (${i.map(x => x.name).join(', ')})`);
  if (t.length) parts.push(`${count(t.length, 'table')} (${t.map(x => x.name).join(', ')})`);
  if (parts.length > 1 && !/^adds/.test(parts[0])) parts[0] = 'adds ' + parts[0];
  else if (parts.length === 1 && !/^adds/.test(parts[0])) parts[0] = 'adds ' + parts[0];
  return parts.join(', ');
}

function inputsItems(draft) {
  return [
    ...(draft.model_point_fields || []).map(f => ({ type: 'model_point', name: f.name, label: f.label, format: f.format || 'number', example: f.example })),
    ...(draft.tables || []).map(t => ({ type: 'table', name: t.name, label: t.label, file: t.file || `assumptions/${t.name}.csv`, columns: t.columns, rows: t.rows, formats: t.formats || {} })),
    ...(draft.inputs || []).map(i => ({ type: 'input', name: i.name, label: i.label, format: i.format, description: i.description,
      python: i.python ? src.normaliseCode(i.python) : null, excel: i.excel || null })),
  ];
}

const indent = (code, n) => code.split('\n').map(l => (l.trim() ? ' '.repeat(n) + l : '')).join('\n');

function editInputs(text, items) {
  let lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const def = lines.findIndex(l => /^def build_inputs\(/.test(l));
  if (def < 0) throw new Error('inputs.py has no `def build_inputs(`; edit it by hand.');
  const seriesAt = lines.findIndex((l, i) => i > def && /^ {4}series = \{\s*$/.test(l));
  if (seriesAt < 0) throw new Error('build_inputs does not collect its series in a `series = {` dict; edit inputs.py by hand.');
  let closeAt = lines.findIndex((l, i) => i > seriesAt && /^ {4}\}\s*$/.test(l));
  if (closeAt < 0) throw new Error('Cannot find the end of the `series` dict in inputs.py.');

  const fields = items.filter(i => i.type === 'model_point');
  const inputs = items.filter(i => i.type === 'input');
  const fieldLines = fields.map(f => `    ${f.name} = np.asarray(model_points[${JSON.stringify(f.name)}], dtype=np.float64)`);
  const codeLines = inputs.filter(i => i.python).flatMap(i => [...indent(i.python, 4).split('\n'), '']);
  const dictLines = inputs.map(i => `        ${JSON.stringify(i.name)}: ${i.name},`);

  // dict entries, then the code before the dict, then the fields (after the fields anchor, or with the code)
  lines.splice(closeAt, 0, ...dictLines);
  const anchor = lines.findIndex((l, i) => i > def && /^ {4}# model-point fields\s*$/.test(l));
  if (codeLines.length) lines.splice(seriesAt, 0, ...codeLines);
  if (fieldLines.length) {
    if (anchor >= 0 && anchor < seriesAt) lines.splice(anchor + 1, 0, ...fieldLines);
    else {
      const lastField = lines.reduce((acc, l, i) => (i > def && /= np\.asarray\(model_points\[/.test(l) ? i : acc), -1);
      if (lastField >= 0) lines.splice(lastField + 1, 0, ...fieldLines);
      else {
        const s = lines.findIndex((l, i) => i > def && /^ {4}series = \{\s*$/.test(l));
        lines.splice(s, 0, ...fieldLines, '');
      }
    }
  }

  // describe each new series and field in the build_inputs docstring
  const docOpen = lines.findIndex((l, i) => i > def && /^\s+("""|''')/.test(l));
  if (docOpen >= 0) {
    const q = lines[docOpen].trim().slice(0, 3);
    const rest = lines[docOpen].trim().slice(3);
    let docClose = rest.includes(q) ? docOpen : lines.findIndex((l, i) => i > docOpen && l.includes(q));
    if (docClose > docOpen && lines[docClose].trim() === q) {
      const desc = [
        ...fields.map(f => `model point ${f.name}: ${String(f.label).trim().replace(/\.$/, '')}.`),
        ...inputs.map(i => `${i.name}: ${String(i.description).trim().replace(/\.$/, '')}.`),
      ].map(d => d.replace(/"""|'''/g, ''));
      const wrapped = desc.flatMap(d => src.wrap(d, 100, '    '));
      if (wrapped.length) lines.splice(docClose, 0, ...wrapped);
    }
  }
  return lines.join('\n').replace(/\n*$/, '\n');
}

function tomlInputBlock(i) {
  const q = s => JSON.stringify(String(s));
  return ['', `[input.${i.name}]`, `label = ${q(i.label)}`, `format = ${q(i.format)}`, ...(i.excel ? [`excel = ${q(i.excel)}`] : [])];
}

function tomlTableBlock(t) {
  const q = s => JSON.stringify(String(s));
  const fm = Object.entries(t.formats || {});
  return ['', `[table.${t.name}]`, `file = ${q(t.file)}`, `label = ${q(t.label)}`,
    ...(fm.length ? [`formats = { ${fm.map(([c, f]) => `${c} = ${q(f)}`).join(', ')} }`] : [])];
}

function editToml(text, items) {
  const add = [
    ...items.filter(i => i.type === 'table').flatMap(tomlTableBlock),
    ...items.filter(i => i.type === 'input').flatMap(tomlInputBlock),
  ];
  return String(text).replace(/\s+$/, '') + '\n' + add.join('\n') + '\n';
}

function tableCsv(t) {
  return [t.columns.join(','), ...t.rows.map(r => r.map(v => String(v)).join(','))].join('\n') + '\n';
}

// ---------------------------------------------------------------- cases

function validateCases(graph, modelDir, items) {
  const problems = [];
  const warnings = [];
  const fields = modelPointFields(modelDir);
  const existing = new Set(caseFiles(modelDir).map(c => c.id));
  const seen = new Set();
  if (!Array.isArray(items) || !items.length) problems.push('The draft has no cases.');
  for (const c of items || []) {
    if (!CASE_ID.test(c.id || '')) { problems.push(`'${c.id}' is not a usable case id (lower case, digits and underscores).`); continue; }
    if (seen.has(c.id)) problems.push(`${c.id} appears twice in the draft.`);
    seen.add(c.id);
    if (existing.has(c.id)) warnings.push(`Case ${c.id} exists; the draft replaces it.`);
    if (!c.name || !String(c.name).trim()) problems.push(`Case ${c.id} needs a name.`);
    if (!c.purpose || !String(c.purpose).trim()) problems.push(`Case ${c.id} needs a purpose (what it tests, for example which branch it takes).`);
    const mp = c.model_point || {};
    if (typeof mp !== 'object' || Array.isArray(mp)) { problems.push(`Case ${c.id}: model_point must be an object.`); continue; }
    const missing = fields.filter(f => !(f in mp));
    const extra = Object.keys(mp).filter(f => !fields.includes(f));
    if (missing.length) problems.push(`Case ${c.id} is missing model-point fields: ${missing.join(', ')}.`);
    if (extra.length && fields.length) problems.push(`Case ${c.id} has fields the model does not have: ${extra.join(', ')}. Add them as inputs first.`);
    for (const [k, v] of Object.entries(mp)) if (!finite(v)) problems.push(`Case ${c.id}: ${k} must be a finite number.`);
    for (const [k, v] of Object.entries(c.params || {})) {
      if (!graph.quantities[k] || graph.quantities[k].kind !== 'param') problems.push(`Case ${c.id} overrides '${k}', which is not a parameter.`);
      else if (!finite(v)) problems.push(`Case ${c.id}: the override of ${k} must be a finite number.`);
    }
    if (c.months !== undefined && c.months !== null && !(Number.isInteger(c.months) && c.months > 0 && c.months <= 1200)) problems.push(`Case ${c.id}: months must be a whole number from 1 to 1200.`);
  }
  return { problems, warnings };
}

function casesSummary(modelDir, items) {
  const existing = new Set(caseFiles(modelDir).map(c => c.id));
  const added = items.filter(c => !existing.has(c.id));
  const changed = items.filter(c => existing.has(c.id));
  const parts = [];
  if (added.length) parts.push(`adds ${count(added.length, 'case')} (${added.map(c => c.id).join(', ')})`);
  if (changed.length) parts.push(`replaces ${count(changed.length, 'case')} (${changed.map(c => c.id).join(', ')})`);
  return parts.join(', ');
}

function caseDoc(c) {
  return { id: c.id, name: String(c.name).trim(), purpose: String(c.purpose).trim(), model_point: c.model_point || {}, params: c.params || {},
    ...(c.months ? { months: c.months } : {}) };
}

// ---------------------------------------------------------------- apply with restore

// writes: [{file, text|null}] (null removes). Returns a restore function.
function writeAll(writes) {
  const before = writes.map(w => ({ file: w.file, text: fs.existsSync(w.file) ? read(w.file) : null }));
  const made = [];
  for (const w of writes) {
    let d = path.dirname(w.file);
    const missing = [];
    while (!fs.existsSync(d)) { missing.push(d); d = path.dirname(d); }
    fs.mkdirSync(path.dirname(w.file), { recursive: true });
    made.push(...missing);
    if (w.text === null) fs.rmSync(w.file, { force: true }); else fs.writeFileSync(w.file, w.text);
  }
  return () => {
    for (const b of before.reverse()) {
      if (b.text === null) fs.rmSync(b.file, { force: true }); else fs.writeFileSync(b.file, b.text);
    }
    for (const d of made.sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(d); } catch { /* not empty */ } }
  };
}

// The edits a draft makes: [{file, text}].
function draftWrites(ctx, draft) {
  const dir = ctx.modelDir;
  if (draft.kind === 'params') {
    const file = paramsFile(dir);
    return [{ file, text: editParams(read(file), draft.items) }];
  }
  if (draft.kind === 'inputs') {
    const writes = [];
    const file = inputsFile(dir);
    writes.push({ file, text: editInputs(read(file), draft.items) });
    writes.push({ file: tomlFile(dir), text: editToml(read(tomlFile(dir)), draft.items) });
    for (const t of draft.items.filter(i => i.type === 'table')) {
      const rel = path.posix.normalize(t.file);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Table file ${t.file} must be inside the model directory.`);
      writes.push({ file: path.join(dir, rel), text: tableCsv(t) });
    }
    const fields = draft.items.filter(i => i.type === 'model_point');
    if (fields.length) {
      for (const c of caseFiles(dir)) {
        const mp = { ...(c.doc.model_point || {}) };
        for (const f of fields) if (!(f.name in mp)) mp[f.name] = f.example;
        writes.push({ file: c.file, text: JSON.stringify({ ...c.doc, model_point: mp }, null, 2) + '\n' });
      }
    }
    return writes;
  }
  if (draft.kind === 'cases') {
    return draft.items.map(c => ({ file: path.join(dir, 'cases', `${c.id}.json`), text: JSON.stringify(caseDoc(c), null, 2) + '\n' }));
  }
  throw new Error(`Unknown draft kind ${draft.kind}.`);
}

/**
 * Apply a params / inputs / cases draft. Returns {accepted, actions}. On failure every file is restored
 * and accepted is false with the reason in actions.
 */
async function acceptScaffoldDraft(ctx, draft) {
  const tk = ctx.tilekit;
  const graph = await tk('graph');
  let check;
  if (draft.kind === 'params') check = validateParams(graph, draft.items);
  else if (draft.kind === 'inputs') check = validateInputs(graph, ctx.modelDir, draftFromItems(draft.items));
  else check = validateCases(graph, ctx.modelDir, draft.items);
  if (check.problems.length) return { accepted: false, actions: ['The draft no longer fits the model: ' + check.problems.join(' ')] };

  const status = await tk('status');
  const signed = Object.values(status.tiles).filter(t => t.state === 'signed_off').length +
    Object.values(status.modules).filter(m => m.state === 'signed_off').length + (status.model.state === 'signed_off' ? 1 : 0);
  if (signed) {
    const ok = await ctx.confirm({ title: 'Accept draft?',
      message: `This changes ${draft.kind === 'cases' ? 'the cases' : draft.kind === 'params' ? 'parameters' : 'the inputs'}, so ${count(signed, 'sign-off')} will need re-confirming. Accept the draft anyway?`,
      detail: 'Only values change; tiles whose checks still pass can be re-confirmed in bulk.' });
    if (!ok) return { accepted: false, actions: ['Did not accept the draft: the sign-offs were kept.'] };
  }

  const errorsBefore = ((await tk('check')).counts || {}).error || 0;
  const restore = writeAll(draftWrites(ctx, draft));
  try {
    const chk = await tk('check');
    await tk('graph');
    const errs = (chk.counts || {}).error || 0;
    if (errs > errorsBefore) {
      const first = (chk.violations || []).find(v => v.severity === 'error');
      throw new Error(`the rule check now reports ${count(errs, 'error')}${first ? ` (${first.tile}, ${first.rule}: ${first.message})` : ''}`);
    }
    const ids = draft.kind === 'cases' ? draft.items.map(c => c.id) : (await tk('cases')).cases.map(c => c.id);
    for (const id of ids) await tk('trace', ['--case', id]);
  } catch (e) {
    restore();
    return { accepted: false, actions: [`The draft was not applied: ${String(e.message).replace(/\.$/, '')}. The previous files were restored.`] };
  }
  const line = draft.kind === 'params' ? `Updated params.py: ${paramsSummary(graph, draft.items)}.`
    : draft.kind === 'inputs' ? `Updated the inputs: ${inputsSummary(draftFromItems(draft.items))}.`
      : `Wrote ${count(draft.items.length, 'case')}: ${draft.items.map(c => c.id).join(', ')}.`;
  return { accepted: true, actions: [line + ' The rule check, graph and every case run.'] };
}

function draftFromItems(items) {
  return {
    model_point_fields: items.filter(i => i.type === 'model_point').map(f => ({ ...f })),
    tables: items.filter(i => i.type === 'table'),
    inputs: items.filter(i => i.type === 'input').map(i => ({ ...i, python: i.python || '' })),
  };
}

module.exports = {
  validateParams, paramsSummary, editParams, validateInputs, inputsSummary, inputsItems, editInputs, editToml,
  validateCases, casesSummary, acceptScaffoldDraft, modelPointFields, paramsFile, inputsFile, draftFromItems,
};
