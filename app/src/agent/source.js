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
  return problems;
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

// [[module]] blocks: [{id, python, start, end}] with line ranges, from a small line scanner.
function tomlModules(tomlText) {
  const lines = tomlText.split('\n');
  const blocks = [];
  let cur = null;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (/^\[\[?[^\]]+\]\]?/.test(t)) {
      if (cur) { cur.end = i; cur = null; }
      if (t.startsWith('[[module]]')) { cur = { start: i, end: lines.length }; blocks.push(cur); }
      return;
    }
    if (cur) {
      const m = t.match(/^(id|python|layer|title)\s*=\s*"([^"]*)"/);
      if (m) cur[m[1]] = m[2];
    }
  });
  return blocks;
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
    at = blocks[blocks.length - 1].end;
    while (at > 0 && !lines[at - 1].trim()) at--;
    lines.splice(at, 0, '', ...block);
  } else {
    lines.push('', ...block);
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  FORMATS, SNAKE, normaliseCode, tileCodeProblems, spliceFunction, skeleton, appendFunctions,
  ensureNumpyImport, tomlModules, tomlPackage, insertModuleToml, wrap,
};
