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
  const key = rest.findIndex(l => /^(Units|Timing|Format|Assumed|Status|Undefined)\s*:/.test(l));
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

// Where the function at `source` ({line, code} from `tilekit graph`) stands in `lines`: its first line's index.
function locateFunction(lines, source) {
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
  return { start, length: old.length };
}

// Replace the function at `source` ({line, code} from `tilekit graph`) in `fileText` with `newCode`.
function spliceFunction(fileText, source, newCode) {
  const lines = String(fileText).replace(/\r\n?/g, '\n').split('\n');
  const { start, length } = locateFunction(lines, source);
  return [...lines.slice(0, start), ...normaliseCode(newCode).split('\n'), ...lines.slice(start + length)].join('\n');
}

// Cut the function at `source` out of `fileText`. Blank lines are tidied only where it stood: the blank lines above
// and below it become one gap (the larger of the two), or none when it was the last thing in the file. Every other
// line of the file, blank lines inside another function's docstring included, is left exactly as it is.
function removeFunction(fileText, source) {
  const lines = String(fileText).replace(/\r\n?/g, '\n').split('\n');
  const { start, length } = locateFunction(lines, source);
  let a = start;
  while (a > 0 && !lines[a - 1].trim()) a--;
  let b = start + length;
  while (b < lines.length && !lines[b].trim()) b++;
  const gap = b >= lines.length ? (a > 0 ? [''] : []) : a === 0 ? [] : Array(Math.max(start - a, b - start - length)).fill('');
  return [...lines.slice(0, a), ...gap, ...lines.slice(b)].join('\n');
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

// ---- strict readers for the few TOML values the layout tables hold. Each returns {value} when the text is exactly
// one such value followed by nothing but spaces and an optional `# comment`, and null when it is anything else (a
// multi-line string, an inline table, a date ...). Nothing here guesses.

const restIsComment = s => /^\s*(#.*)?$/.test(s);

// One string starting at s[i]: a basic string ("...", with escapes) or a literal string ('...', taken as written).
// Returns {value, end} or null. Multi-line strings (""" and ''') are not read.
function readTomlString(s, i) {
  const q = s[i];
  if (q === "'") {
    if (s.startsWith("'''", i)) return null;
    const j = s.indexOf("'", i + 1);
    if (j < 0 || s.slice(i + 1, j).includes('\n')) return null;
    return { value: s.slice(i + 1, j), end: j + 1 };
  }
  if (q !== '"' || s.startsWith('"""', i)) return null;
  let j = i + 1;
  while (j < s.length && s[j] !== '"') {
    if (s[j] === '\n') return null;
    j += s[j] === '\\' ? 2 : 1;
  }
  if (j >= s.length) return null;
  const body = s.slice(i + 1, j);
  // TOML's escapes are JSON's (without \/) plus \e and \UXXXXXXXX; anything JSON cannot read is not guessed at
  if (/\\[^btnfr"\\u]/.test(body.replace(/\\\\/g, ''))) return null;
  try { return { value: JSON.parse(`"${body}"`), end: j + 1 }; } catch { return null; }
}

function tomlStringValue(raw) {
  const s = String(raw).replace(/^\s+/, '');
  const r = readTomlString(s, 0);
  return r && restIsComment(s.slice(r.end)) ? { value: r.value } : null;
}

// An array of strings, which may run over several lines and hold comments and a trailing comma. Returns {value},
// 'open' when the text ends before the closing bracket (the caller adds the next line), or null.
function tomlStringArray(raw) {
  const s = String(raw);
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] !== '#') return;
      while (i < s.length && s[i] !== '\n') i++;
    }
  };
  skip();
  if (s[i] !== '[') return null;
  i++;
  const value = [];
  for (;;) {
    skip();
    if (i >= s.length) return 'open';
    if (s[i] === ']') { i++; break; }
    const r = readTomlString(s, i);
    if (!r) return null;
    value.push(r.value);
    i = r.end;
    skip();
    if (i >= s.length) return 'open';
    if (s[i] === ',') { i++; continue; }
    if (s[i] === ']') { i++; break; }
    return null;
  }
  const lineEnd = s.indexOf('\n', i);
  return lineEnd < 0 && restIsComment(s.slice(i)) ? { value } : null;
}

// A decimal number: an integer or float, with TOML's underscores between digits (1_000). Not inf, nan, hex or dates.
function tomlNumberValue(raw) {
  const m = /^\s*([+-]?\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?(?:[eE][+-]?\d+(?:_\d+)*)?)\s*(#.*)?$/.exec(String(raw));
  if (!m) return null;
  const n = Number(m[1].replace(/_/g, ''));
  return Number.isFinite(n) ? { value: n } : null;
}

const SUB_KEYS = { section: ['title', 'tiles'], check: ['name', 'label', 'expression', 'tolerance'] };

// [[module]] blocks: [{id, python, title, layer, start, end, sections, checks, subs}] with line ranges, from a small
// line scanner. A `[[module.section]]` or `[[module.check]]` table (or any other `module.` sub-table) belongs to the
// `[[module]]` above it, so it stays inside that block's range; each is listed with its own range
// ({start, end, title, tiles} / {start, end, name, label, expression, tolerance}). `end` is the line of the next
// table header that is not the module's (or the number of lines). A value that is not read with certainty is left
// out and named in the table's `unread` list (so is a key this app does not write): such a table can be kept where
// it stands, untouched, but must never be written again from what was read.
function tomlModules(tomlText) {
  const lines = String(tomlText).split('\n');
  const blocks = [];
  let cur = null, sub = null, open = null;
  const close = i => { if (sub) { sub.end = i; sub = null; } };
  const setTiles = (text, target) => {
    const r = tomlStringArray(text);
    if (r === 'open') return false;
    if (r) target.tiles = r.value; else target.unread.push('tiles');
    return true;
  };
  lines.forEach((l, i) => {
    const t = l.trim();
    if (open) {            // a value written over several lines: `tiles = [` ... `]`
      open.text += '\n' + t;
      if (setTiles(open.text, open.sub)) open = null;
      return;
    }
    const head = /^\[\[?\s*([^\]]+?)\s*\]\]?/.exec(t);
    if (head) {
      close(i);
      const name = head[1];
      if (t.startsWith('[[') && name === 'module') {
        if (cur) cur.end = i;
        cur = { start: i, end: lines.length, sections: [], checks: [], subs: [] };
        blocks.push(cur);
      } else if (cur && name.startsWith('module.')) {
        sub = { start: i, end: lines.length, kind: name.slice(7), unread: [] };
        cur.subs.push(sub);
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
    if (!t || t.startsWith('#')) return;
    const kv = /^([A-Za-z_][\w-]*)\s*=\s*(.*)$/.exec(t);
    if (!kv) { sub.unread.push(t.slice(0, 30)); return; }
    const [, key, raw] = kv;
    if (!(SUB_KEYS[sub.kind] || []).includes(key)) { sub.unread.push(key); return; }
    if (key === 'tiles') {
      if (!setTiles(raw, sub)) open = { sub, text: raw };
    } else {
      const r = key === 'tolerance' ? tomlNumberValue(raw) : tomlStringValue(raw);
      if (r) sub[key] = r.value; else sub.unread.push(key);
    }
  });
  if (open) open.sub.unread.push('tiles');   // the array never closed
  close(lines.length);
  if (cur) cur.end = Math.max(cur.end, cur.start + 1);
  return blocks;
}

// One `[[module.section]]` or `[[module.check]]` table, in the format tilekit reads (no blank line around it).
function sectionTable(s) {
  const out = ['[[module.section]]'];
  if (s.title !== null && s.title !== undefined && String(s.title).trim()) out.push(`title = ${tomlString(String(s.title).trim())}`);
  out.push(`tiles = [${(s.tiles || []).map(tomlString).join(', ')}]`);
  return out;
}

function checkTable(c) {
  const out = ['[[module.check]]', `name = ${tomlString(c.name)}`, `label = ${tomlString(String(c.label).trim())}`,
    `expression = ${tomlString(String(c.expression).replace(/\s+/g, ' ').trim())}`];
  if (typeof c.tolerance === 'number' && Number.isFinite(c.tolerance)) out.push(`tolerance = ${c.tolerance}`);
  return out;
}

// The `[[module.section]]` and `[[module.check]]` tables written for a module, each after a blank line.
function layoutLines({ sections, checks } = {}) {
  const out = [];
  for (const s of sections || []) out.push('', ...sectionTable(s));
  for (const c of checks || []) out.push('', ...checkTable(c));
  return out;
}

const looseLine = l => !l.trim() || l.trim().startsWith('#');

// A sub-table runs to the next header; its trailing blank and comment lines belong to whatever comes next.
function subRange(lines, s) {
  let e = s.end;
  while (e > s.start + 1 && looseLine(lines[e - 1])) e--;
  return [s.start, e];
}

// Cut the line ranges `cuts` ([a, b), in order) out of `lines` and put `tables` (arrays of lines) in at line `at`.
// Every line outside the cuts is kept exactly as it is, in its place. Blank lines are managed only where something
// was put in or taken out: one blank line between tables and around the new ones, none doubled where a table went.
function spliceTables(lines, cuts, at, tables, cr = '') {
  const cut = i => cuts.some(([a, b]) => i >= a && i < b);
  const out = [];
  const blank = l => l !== undefined && !l.trim();
  let afterCut = false;
  for (let i = 0; i <= lines.length; i++) {
    if (i === at && tables.length) {
      const prev = out[out.length - 1];
      if (prev !== undefined && prev.trim() && !prev.trim().startsWith('#')) out.push(cr);
      tables.forEach((t, k) => { if (k) out.push(cr); out.push(...t.map(x => x + cr)); });
      let next = i;
      while (next < lines.length && cut(next)) next++;
      // the last element of a file that ends with a newline is '', which is not a line to keep clear of
      if (next < lines.length && lines[next].trim()) out.push(cr);
      afterCut = false;
    }
    if (i === lines.length) break;
    if (cut(i)) { afterCut = true; continue; }
    // a blank line left behind by a table that went, right after another blank line (or at the very top), goes too
    if (afterCut && blank(lines[i]) && i < lines.length - 1 && (out.length === 0 || blank(out[out.length - 1]))) continue;
    afterCut = false;
    out.push(lines[i]);
  }
  return out;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sectionShape = s => ({ title: s.title !== null && s.title !== undefined && String(s.title).trim() ? String(s.title).trim() : null, tiles: (s.tiles || []).map(String) });
const checkShape = c => ({ name: String(c.name), label: String(c.label).trim(), expression: String(c.expression).replace(/\s+/g, ' ').trim(),
  ...(typeof c.tolerance === 'number' && Number.isFinite(c.tolerance) ? { tolerance: c.tolerance } : {}) });

// Replace all of module `moduleId`'s tables of one kind ('section' or 'check') with `items`. Only those tables are
// cut out and written; every other line of the file, the module's other tables included, stays byte for byte.
function replaceKind(text, moduleId, kind, items) {
  const lines = text.split('\n');
  const cr = lines.length > 1 && lines[0].endsWith('\r') ? '\r' : '';
  const block = tomlModules(text).find(b => b.id === moduleId);
  if (!block) throw new Error(`tilekit.toml has no [[module]] block for ${moduleId}.`);
  const old = kind === 'section' ? block.sections : block.checks;
  const cuts = old.map(s => subRange(lines, s));
  // the end of the module's block, before the blank and comment lines that belong to whatever follows
  let blockEnd = block.end;
  while (blockEnd > block.start + 1 && looseLine(lines[blockEnd - 1])) blockEnd--;
  let at;
  if (old.length) at = old[0].start;                  // where the first one stood
  else if (kind === 'section' && block.checks.length) {
    // sections go before the checks, above a comment that sits on the first check
    at = block.checks[0].start;
    while (at > block.start + 1 && lines[at - 1].trim().startsWith('#')) at--;
  } else at = blockEnd;                               // after everything the module has
  const out = spliceTables(lines, cuts, at, items.map(kind === 'section' ? sectionTable : checkTable), cr).join('\n');
  return out.endsWith('\n') ? out : out + '\n';
}

const kindText = (text, block, kind) => {
  const lines = text.split('\n');
  return (kind === 'section' ? block.sections : block.checks).map(s => lines.slice(...subRange(lines, s)).join('\n'));
};

// What was written is read back before it is returned: the kind that was replaced must read as exactly what was
// asked for, and the other kind must be the same text as before.
function verifyLayout(before, after, moduleId, { sections, checks }) {
  const b0 = tomlModules(before).find(b => b.id === moduleId);
  const b1 = tomlModules(after).find(b => b.id === moduleId);
  const bad = what => new Error(`tilekit.toml was not changed: the ${what} of ${moduleId} would not read back as written.`);
  if (!b1) throw bad('layout');
  const read = (subs, shape) => subs.some(s => s.unread.length) ? null : subs.map(shape);
  if (sections) { if (!sameJson(read(b1.sections, sectionShape), sections.map(sectionShape))) throw bad('sections'); }
  else if (!sameJson(kindText(before, b0, 'section'), kindText(after, b1, 'section'))) throw bad('sections');
  if (checks) { if (!sameJson(read(b1.checks, checkShape), checks.map(checkShape))) throw bad('reconciliation checks'); }
  else if (!sameJson(kindText(before, b0, 'check'), kindText(after, b1, 'check'))) throw bad('reconciliation checks');
  return after;
}

// Replace module `moduleId`'s sections (when `sections` is given) and/or checks (when `checks` is given) in the
// toml text. Only the tables of the kind being replaced are cut out and written again, where the first of them
// stood (new sections go before the checks, new checks after everything else the module has); the kind that is not
// replaced, and every other line of the file, is left byte for byte. Throws if the module has no [[module]] block.
function setModuleLayout(tomlText, moduleId, { sections, checks } = {}) {
  const before = String(tomlText);
  let text = before;
  if (sections) text = replaceKind(text, moduleId, 'section', sections);
  if (checks) text = replaceKind(text, moduleId, 'check', checks);
  return verifyLayout(before, text, moduleId, { sections, checks });
}

// Take tiles out of a module's sections (when they are deleted), dropping a section left empty. Only the sections
// that hold one of the tiles are written again; the others, the checks and the rest of the file are left byte for
// byte. Returns the text unchanged when no section holds one. Throws, with a plain reason, when the module has a
// section that cannot be read with certainty: nothing is written from a guess.
function dropTilesFromSections(tomlText, moduleId, names) {
  const text = String(tomlText);
  const block = tomlModules(text).find(b => b.id === moduleId);
  if (!block || !block.sections.length) return tomlText;
  const gone = new Set(names);
  // an unread section might hold one of the tiles; whether it does cannot be told, so the edit is refused
  const unread = block.sections.find(s => s.unread.length);
  if (unread) {
    throw new Error(`a section of ${moduleId} in tilekit.toml (line ${unread.start + 1}) has ${unread.unread.map(k => `\`${k}\``).join(', ')} written in a way this app cannot read with certainty, so it cannot take ${[...gone].join(', ')} out of the sections. Correct that section in tilekit.toml, or give the module's sections afresh in the draft.`);
  }
  const hit = block.sections.filter(s => s.tiles.some(t => gone.has(t)));
  if (!hit.length) return tomlText;
  const lines = text.split('\n');
  const cr = lines.length > 1 && lines[0].endsWith('\r') ? '\r' : '';
  let out = lines;
  // from the last to the first, so the line numbers of those still to do stay right
  for (const s of [...hit].reverse()) {
    const left = s.tiles.filter(t => !gone.has(t));
    const range = subRange(lines, s);
    out = spliceTables(out, [range], range[0], left.length ? [sectionTable({ title: s.title, tiles: left })] : [], cr);
  }
  const after = out.join('\n');
  return after.endsWith('\n') ? after : after + '\n';
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
  FORMATS, SNAKE, normaliseCode, tileCodeProblems, tileDescription, descriptionProblems, spliceFunction, removeFunction, skeleton, appendFunctions,
  ensureNumpyImport, tomlModules, tomlPackage, insertModuleToml, wrap, setModuleLayout, dropTilesFromSections, layoutLines,
  chooseConvertProblems, tileBody,
};
