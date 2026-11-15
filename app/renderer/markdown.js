// Markdown for the agent's replies, drawn as DOM nodes (never as HTML text, so nothing in a reply can become markup).
// Covers what the agent writes: paragraphs, headings, bullet and numbered lists (nested by indent), fenced code,
// tables, rules, and inline bold, italic, code and links. A link shows its text and address as plain text: nothing
// in the chat is clickable. Anything not recognised stays as the text it was.
import { h } from './util.js';

// ---------------------------------------------------------------- inline

const INLINE = /(`+)([\s\S]+?)\1|\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*|__([^\s_](?:[\s\S]*?[^\s_])?)__|\*([^\s*](?:[^*]*?[^\s*])?)\*|(?<![A-Za-z0-9])_([^\s_](?:[^_]*?[^\s_])?)_(?![A-Za-z0-9])|\[([^\]\n]+)\]\(([^)\s]+)\)|\\([\\`*_{}[\]()#+\-.!|>~])/g;

export function inline(text) {
  const out = [];
  let last = 0, m;
  const re = new RegExp(INLINE.source, 'g');   // its own position: inline() calls itself for bold and italic
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] !== undefined) out.push(h('code', {}, m[2].trim() || m[2]));
    else if (m[3] !== undefined || m[4] !== undefined) out.push(h('strong', {}, inline(m[3] !== undefined ? m[3] : m[4])));
    else if (m[5] !== undefined || m[6] !== undefined) out.push(h('em', {}, inline(m[5] !== undefined ? m[5] : m[6])));
    else if (m[7] !== undefined) out.push(...inline(m[7]), m[8] === m[7] ? '' : ` (${m[8]})`);
    else out.push(m[9]);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------------------------------------------------------------- blocks

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));

// lines[i] starts a list: read it (and anything nested under its items) and return [node, next index]
function list(lines, i) {
  const first = ITEM.exec(lines[i]);
  const indent = first[1].length, ordered = /\d/.test(first[2]);
  const node = h(ordered ? 'ol' : 'ul', ordered && parseInt(first[2], 10) !== 1 ? { start: String(parseInt(first[2], 10)) } : {});
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length < indent || (m[1].length === indent && /\d/.test(m[2]) !== ordered)) break;
    if (m[1].length > indent + 1) {            // deeper than this list: it belongs to the last item
      const [sub, next] = list(lines, i);
      (node.lastChild || node.appendChild(h('li', {}))).append(sub); i = next; continue;
    }
    const text = [m[3]];
    i++;
    // a wrapped line of the same item: indented text that is not itself an item; a blank line between items is skipped
    while (i < lines.length && lines[i].trim() && !ITEM.test(lines[i]) && /^\s+/.test(lines[i]) && !FENCE.test(lines[i])) text.push(lines[i++].trim());
    node.append(h('li', {}, inline(text.join(' '))));
    let j = i; while (j < lines.length && !lines[j].trim()) j++;
    if (j > i && j < lines.length && ITEM.test(lines[j]) && ITEM.exec(lines[j])[1].length >= indent) i = j;
  }
  return [node, i];
}

// The reply as a list of block nodes.
export function blocks(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const f = FENCE.exec(line);
    if (f) {
      const body = [];
      i++;
      while (i < lines.length && !(FENCE.test(lines[i]) && lines[i].trim().startsWith(f[1][0].repeat(3)))) body.push(lines[i++]);
      i++;
      out.push(h('pre', { class: 'code' }, body.join('\n')));
      continue;
    }
    const hd = HEADING.exec(line);
    if (hd) { out.push(h('div', { class: 'md-h' }, inline(hd[2]))); i++; continue; }
    if (RULE.test(line)) { out.push(h('hr', {})); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line);
      const right = cells(lines[i + 1]).map(c => /-:$/.test(c));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      const tr = (tag, row) => h('tr', {}, head.map((_, k) => h(tag, right[k] ? { class: 'r' } : {}, inline(row[k] || ''))));
      out.push(h('table', { class: 'md-table' }, h('thead', {}, tr('th', head)), h('tbody', {}, rows.map(r => tr('td', r)))));
      continue;
    }
    if (ITEM.test(line)) { const [node, next] = list(lines, i); out.push(node); i = next; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(h('blockquote', {}, blocks(body.join('\n'))));
      continue;
    }
    // a paragraph: up to a blank line or the start of another kind of block; its line breaks are kept
    const para = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !RULE.test(lines[i])
      && !(para.length && ITEM.test(lines[i]))) para.push(lines[i++].trim());
    const kids = [];
    para.forEach((p, k) => { if (k) kids.push(h('br', {})); kids.push(...inline(p)); });
    out.push(h('p', {}, kids));
  }
  return out;
}

export function markdown(text) { return h('div', { class: 'md' }, blocks(text)); }
