'use strict';
// Source-text operations on model files: replace one tile function, build tile skeletons,
// append to a module file, add a [[module]] block to tilekit.toml. Pure string functions.

const FORMATS = ['amount', 'units', 'percent', 'rate', 'irr', 'number', 'small', 'integer'];
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

// Strip surrounding blank lines and a common indent; normalise line endings and tabs.
function normaliseCode(code) {
  let lines = String(code).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indents = lines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  if (cut) lines = lines.map(l => l.slice(cut));
  return lines.map(l => l.replace(/\s+$/, '')).join('\n');
}

// The description paragraph of a tile's docstring (between the label and the first key line), or '' if there is none.
function tileDescription(code) {
  const m = /("""|''')([\s\S]*?)\1/.exec(code);
  if (!m) return '';
  const lines = m[2].split('\n').map(l => l.trim());
  const rest = lines.slice(1);
  const key = rest.findIndex(l => /^(Units|Timing|Format|Assumed|Status)\s*:/.test(l));
  return (key < 0 ? rest : rest.slice(0, key)).join(' ').replace(/\s+/g, ' ').trim();
}

// House standard (app/standards/writing-tiles.md): the description is one or two plain sentences and never restates
// the formula. Returns the problems, for the tile-writing tool to send back.
function descriptionProblems(code) {
  const d = tileDescription(code);
  if (!d) return [];
  const problems = [];
  const sentences = d.split(/(?<=[.!?])\s+(?=[A-Z(])/).filter(s => s.trim());
  if (sentences.length > 2) problems.push(`The description in the docstring has ${sentences.length} sentences; the house standard is one, or two when the tile has branches or a boundary. Say what the quantity is and stop.`);
  const symbols = [/\*\*|\^/, /\b\w+\s*\([^)]*\)\s*[-+*/]/, /[=<>]=?\s*[\w(]/, /\b(np|tk)\.\w+/, /\(\s*1\s*[-+]\s*\w+/, /\b\w+_\w+\s*[-+*/]\s*\w+_\w+/];
  if (symbols.some(re => re.test(d))) problems.push('The description in the docstring restates the formula. Describe the quantity in words only; the return line and the spreadsheet show the formula, and a convention belongs in an Assumed: line.');
  return problems;
}

// Problems with a replacement for tile `name`: it must be exactly one top-level `def name(...)`.
function tileCodeProblems(name, code) {
  const problems = [];
  const lines = code.split('\n');
  const first = lines[0] || '';
  if (!new RegExp(`^def ${name}\\(`).test(first)) {
    problems.push(`The code must start with \`def ${name}(\` (one function, no decorators or imports).`);
  }
  let inSignature = !/\)\s*(->[^:]*)?:\s*$/.test(first);
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s/.test(l)) {
      if (inSignature && /\)\s*(->[^:]*)?:\s*$/.test(l)) inSignature = false;
      continue;
    }
    if (inSignature && /^\)\s*(->[^:]*)?:\s*$/.test(l)) { inSignature = false; continue; }
    problems.push(`Line ${i + 1} is outside the function (\`${l.trim().slice(0, 40)}\`); send only the one function.`);
    break;
  }
  if (/^\s*Status:\s*not built/im.test(code)) {
    problems.push('Remove the `Status: not built` line from the docstring now that the tile is implemented.');
  }
  if (!/"""|'''/.test(code)) problems.push('The function needs its docstring (label, spec, Units, Timing, Format, Assumed lines).');
  problems.push(...descriptionProblems(code));
  return problems;
}

// The body of a tile function as code only: no def line, docstring or comments.
function tileBody(code) {
  const text = String(code).replace(/("""|''')[\s\S]*?\1/, '');
  return text.split('\n').filter(l => /^\s/.test(l)).map(l => l.replace(/#.*$/, '')).join('\n');
}

// House standard (app/standards/building-spreadsheets.md): one step per tile. Choosing a value and converting it are
// two tiles. Deliberately narrow, so it never refuses an ordinary tile: it catches a body that chooses with np.where
// AND converts a rate in the same formula, where converting means raising to a power whose exponent divides or names
// a period (`** (1 / months_per_year)`, `** months_per_year`, `** (1/12)`), or np.exp together with np.log (the
// continuous form of the same conversion). np.minimum, np.maximum and np.clip are not counted as choosing (caps and
// floors are one step), and a power such as `x ** 2` is not counted as converting.
function chooseConvertProblems(code) {
  const body = tileBody(code);
  if (!/\bnp\.where\s*\(/.test(body)) return [];
  const powers = [...body.matchAll(/\*\*\s*(\([^()]*(?:\([^()]*\)[^()]*)*\)|[\w.]+)/g)].map(m => m[1]);
  const periodPower = powers.some(e => /\//.test(e) || /month|year|period|per_|_per\b|freq/i.test(e));
  const expLog = /\bnp\.exp\s*\(/.test(body) && /\bnp\.log\s*\(/.test(body);
  if (!periodPower && !expLog) return [];
  return ['This tile both chooses a value (np.where) and converts a rate (' + (periodPower ? 'a power over a period, such as ** (1 / months_per_year)' : 'np.exp with np.log') +
    ') in one formula. The house standard is one step per tile: split it into two tiles, one that chooses the rate that applies (for example the annual rate in force this month) and one that converts it (the monthly rate), and propose the second tile with propose_structure before writing it.'];
}

// Replace the function at `source` ({line, code} from `tilekit graph`) in `fileText` with `newCode`.
function spliceFunction(fileText, source, newCode) {
  const text = String(fileText).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const old = String(source.code).split('\n');
  const matchesAt = start => {
    for (let k = 0; k < old.length; k++) {
      const actual = lines[start + k];
      if (actual === undefined) return false;
      if (k < old.length - 1 ? actual !== old[k] : !actual.startsWith(old[k])) return false;
    }
    return true;
  };
  let start = source.line - 1;
  if (!matchesAt(start)) {
    const candidates = [];
    for (let i = 0; i < lines.length; i++) if (lines[i] === old[0] && matchesAt(i)) candidates.push(i);
    if (candidates.length !== 1) throw new Error('The function in the file does not match the model graph; reload and try again.');
    start = candidates[0];
  }
  const out = [...lines.slice(0, start), ...normaliseCode(newCode).split('\n'), ...lines.slice(start + old.length)];
  return out.join('\n');
}

function wrap(text, width, indent) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const out = [];
  let line = '';
  for (const w of words) {
    if (line && (indent + line + ' ' + w).length > width) { out.push(indent + line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) out.push(indent + line);
  return out;
}

function docstringLines(item, extra = []) {
  const ind = '    ';
  const label = String(item.label || item.name).trim().replace(/\.$/, '');
  const lines = [`${ind}"""${label}.`, ''];
  for (const para of String(item.spec || '').split(/\n\s*\n/)) {
    if (para.trim()) lines.push(...wrap(para, 79, ind), '');
  }
  if (item.units) lines.push(`${ind}Units: ${item.units}`);
  if (item.timing) lines.push(`${ind}Timing: ${item.timing}`);
  lines.push(`${ind}Format: ${item.format || 'number'}`);
  for (const a of item.assumed || []) lines.push(`${ind}Assumed: ${String(a).trim()}`);
  lines.push(...extra.map(e => ind + e));
  lines.push(`${ind}"""`);
  return lines;
}

// A tile that has a spec but no implementation: returns NaN shaped like its first argument.
function skeleton(item, previousExpression) {
  const args = item.args || [];
  const lines = [`def ${item.name}(${args.join(', ')}):`, ...docstringLines(item, ['Status: not built'])];
  if (previousExpression) lines.push(`    # Previous: return ${previousExpression.replace(/\s+/g, ' ')}`);
  lines.push(args.length ? `    return np.nan * ${args[0]}` : '    return np.nan');
  return lines.join('\n');
}

function ensureNumpyImport(fileText) {
  if (/^import numpy as np\s*$/m.test(fileText)) return fileText;
  // after the module docstring, if there is one
  const m = fileText.match(/^\s*("""|''')/);
  if (!m) return 'import numpy as np\n\n' + fileText;
  const close = fileText.indexOf(m[1], m[0].length);
  if (close < 0) return fileText;
  const eol = fileText.indexOf('\n', close);
  const head = eol < 0 ? fileText : fileText.slice(0, eol);
  const rest = eol < 0 ? '' : fileText.slice(eol);
  return head + '\n\nimport numpy as np' + rest;
}

function appendFunctions(fileText, codes) {
  let text = ensureNumpyImport(String(fileText).replace(/\s+$/, ''));
  for (const c of codes) text += '\n\n\n' + c;
  return text + '\n';
}

// ---------------------------------------------------------------- tilekit.toml

// A TOML basic string's value ("..." with JSON-style escapes), or null.
function tomlStr(v) {
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(String(v).trim());
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

// [[module]] blocks: [{id, python, title, layer, start, end, sections, checks}] with line ranges, from a small line
// scanner. A `[[module.section]]` or `[[module.check]]` table (or any other `module.` sub-table) belongs to the
// `[[module]]` above it, so it stays inside that block's range; each is listed with its own range
// ({start, end, title, tiles} / {start, end, name, label, expression, tolerance}). `end` is the line of the next
// table header that is not the module's (or the number of lines).
function tomlModules(tomlText) {
  const lines = tomlText.split('\n');
  const blocks = [];
  let cur = null, sub = null, arrayKey = null, arrayText = '';
  const close = i => { if (sub) { sub.end = i; sub = null; } };
  lines.forEach((l, i) => {
    const t = l.trim();
    if (arrayKey) {            // a value written over several lines: `tiles = [` ... `]`
      arrayText += ' ' + t.replace(/#.*$/, '');
      if (/\]\s*$/.test(arrayText)) { sub[arrayKey] = [...arrayText.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => tomlStr(`"${x[1]}"`)); arrayKey = null; }
      return;
    }
    const head = /^\[\[?\s*([^\]]+?)\s*\]\]?/.exec(t);
    if (head) {
      close(i);
      const name = head[1];
      if (t.startsWith('[[') && name === 'module') {
        if (cur) cur.end = i;
        cur = { start: i, end: lines.length, sections: [], checks: [] };
        blocks.push(cur);
      } else if (cur && name.startsWith('module.')) {
        sub = { start: i, end: lines.length, kind: name.slice(7) };
        if (sub.kind === 'section') { sub.title = null; sub.tiles = []; cur.sections.push(sub); }
        else if (sub.kind === 'check') cur.checks.push(sub);
      } else if (cur) { cur.end = i; cur = null; }
      return;
    }
    if (!cur) return;
    if (!sub) {
      const m = t.match(/^(id|python|layer|title)\s*=\s*"([^"]*)"/);
      if (m) cur[m[1]] = m[2];
      return;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*=\s*(.*)$/.exec(t);
    if (!kv) return;
    const [, key, raw] = kv;
    if (key === 'tiles') {
      if (/^\[/.test(raw) && !/\]\s*(#.*)?$/.test(raw)) { arrayKey = 'tiles'; arrayText = raw.replace(/#.*$/, ''); return; }
      sub.tiles = [...raw.replace(/#[^"]*$/, '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => tomlStr(`"${x[1]}"`));
    } else if (['title', 'name', 'label', 'expression'].includes(key)) sub[key] = tomlStr(raw);
    else if (key === 'tolerance') { const n = Number(raw.replace(/#.*$/, '').trim()); if (Number.isFinite(n)) sub.tolerance = n; }
  });
  close(lines.length);
  if (cur) cur.end = Math.max(cur.end, cur.start + 1);
  return blocks;
}

// The `[[module.section]]` and `[[module.check]]` tables written for a module, in the format tilekit reads.
function layoutLines({ sections, checks } = {}) {
  const out = [];
  for (const s of sections || []) {
    out.push('', '[[module.section]]');
    if (s.title !== null && s.title !== undefined && String(s.title).trim()) out.push(`title = ${tomlString(String(s.title).trim())}`);
    out.push(`tiles = [${(s.tiles || []).map(tomlString).join(', ')}]`);
  }
  for (const c of checks || []) {
    out.push('', '[[module.check]]', `name = ${tomlString(c.name)}`, `label = ${tomlString(String(c.label).trim())}`,
      `expression = ${tomlString(String(c.expression).replace(/\s+/g, ' ').trim())}`);
    if (typeof c.tolerance === 'number' && Number.isFinite(c.tolerance)) out.push(`tolerance = ${c.tolerance}`);
  }
  return out;
}

// Replace module `moduleId`'s sections (when `sections` is given) and/or checks (when `checks` is given) in the
// toml text; the other one is kept as it is. The new tables go at the end of the module's block, after its own keys,
// so TOML attaches them to that module. Throws if the module has no [[module]] block.
function setModuleLayout(tomlText, moduleId, { sections, checks } = {}) {
  const text = String(tomlText).replace(/\r\n?/g, '\n');
  const block = tomlModules(text).find(b => b.id === moduleId);
  if (!block) throw new Error(`tilekit.toml has no [[module]] block for ${moduleId}.`);
  const lines = text.split('\n');
  const loose = l => !l.trim() || l.trim().startsWith('#');
  // a sub-table runs to the next header; its trailing blank and comment lines belong to whatever comes next
  const subs = [...block.sections, ...block.checks].map(s => { let e = s.end; while (e > s.start + 1 && loose(lines[e - 1])) e--; return [s.start, e]; });
  const inSub = i => subs.some(([a, b]) => i >= a && i < b);
  // what is kept of the module's sections or checks is written again, so the order is always sections then checks
  const keep = {
    sections: sections || block.sections.map(s => ({ title: s.title, tiles: s.tiles })),
    checks: checks || block.checks.map(c => ({ name: c.name, label: c.label, expression: c.expression, ...(c.tolerance !== undefined ? { tolerance: c.tolerance } : {}) })),
  };
  // the module's own header and keys end before its first sub-table (a comment just above that stays there), or, with
  // none, before the block's trailing blank and comment lines (which belong to whatever follows)
  let at = subs.length ? Math.min(...subs.map(r => r[0])) : block.end;
  while (at > block.start + 1 && (subs.length ? !lines[at - 1].trim() : loose(lines[at - 1]))) at--;
  // comments that sat among the old sub-tables or after the block are kept, after the new tables
  const comments = lines.slice(at, block.end).filter((l, k) => !inSub(at + k) && l.trim());
  const after = lines.slice(block.end);
  const out = [...lines.slice(0, at), ...layoutLines(keep), ...(comments.length ? ['', ...comments] : []), ...(after.length ? ['', ...after] : [])];
  return out.join('\n').replace(/\n*$/, '\n');
}

// Take tiles out of a module's sections (when they are deleted), dropping a section left empty. Returns the text
// unchanged when the module has no sections.
function dropTilesFromSections(tomlText, moduleId, names) {
  const block = tomlModules(String(tomlText)).find(b => b.id === moduleId);
  if (!block || !block.sections.length) return tomlText;
  const gone = new Set(names);
  if (!block.sections.some(s => s.tiles.some(t => gone.has(t)))) return tomlText;
  const sections = block.sections.map(s => ({ title: s.title, tiles: s.tiles.filter(t => !gone.has(t)) })).filter(s => s.tiles.length);
  return setModuleLayout(tomlText, moduleId, { sections });
}

function tomlPackage(tomlText) {
  const m = tomlText.match(/^\s*package\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

const tomlString = s => JSON.stringify(String(s));

function insertModuleToml(tomlText, mod) {
  const lines = tomlText.replace(/\s+$/, '').split('\n');
  const blocks = tomlModules(tomlText);
  const block = ['[[module]]', `id = ${tomlString(mod.id)}`, `title = ${tomlString(mod.title)}`,
    `layer = ${tomlString(mod.layer)}`, `python = ${tomlString(mod.python)}`];
  if (mod.purpose) block.push(`purpose = ${tomlString(mod.purpose)}`);
  if (mod.feeds && mod.feeds.length) block.push(`feeds = [${mod.feeds.map(tomlString).join(', ')}]`);
  let at;
  if (blocks.length) {
    at = Math.min(blocks[blocks.length - 1].end, lines.length);
    while (at > 0 && !lines[at - 1].trim()) at--;
    lines.splice(at, 0, '', ...block);
  } else {
    lines.push('', ...block);
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  FORMATS, SNAKE, normaliseCode, tileCodeProblems, tileDescription, descriptionProblems, spliceFunction, skeleton, appendFunctions,
  ensureNumpyImport, tomlModules, tomlPackage, insertModuleToml, wrap, setModuleLayout, dropTilesFromSections, layoutLines,
  chooseConvertProblems, tileBody,
};
