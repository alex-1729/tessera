// The centre pane's Code and Test segments: read-only source with line numbers, in monospace.
// Colouring is deliberately plain: comments slate, strings terracotta, keywords bold navy. No library.
import { h } from './util.js';
import * as L from './logic.js';

const KEYWORDS = new Set(['def', 'return', 'if', 'else', 'elif', 'for', 'in', 'import', 'from', 'as', 'class', 'not', 'and', 'or', 'is',
  'None', 'True', 'False', 'lambda', 'with', 'while', 'try', 'except', 'raise', 'pass', 'assert']);

// One line of source as nodes. `st.tri` carries an open triple-quoted string from one line to the next.
function tokens(line, st, py) {
  const out = [];
  let plain = '';
  const flush = () => { if (plain) { out.push(plain); plain = ''; } };
  const span = (cls, text) => { flush(); out.push(h('span', { class: cls }, text)); };
  let i = 0;
  while (i < line.length) {
    if (st.tri) {
      const j = line.indexOf(st.tri, i);
      if (j < 0) { span('s', line.slice(i)); return out; }
      span('s', line.slice(i, j + 3)); i = j + 3; st.tri = null; continue;
    }
    const ch = line[i];
    if (ch === '#') { span('c', line.slice(i)); return out; }
    if (ch === '"' || ch === "'") {
      const tri = ch.repeat(3);
      if (py && line.startsWith(tri, i)) {
        const j = line.indexOf(tri, i + 3);
        if (j < 0) { span('s', line.slice(i)); st.tri = tri; return out; }
        span('s', line.slice(i, j + 3)); i = j + 3; continue;
      }
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      span('s', line.slice(i, j + 1)); i = j + 1; continue;
    }
    if (py && /[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++;
      const w = line.slice(i, j);
      if (KEYWORDS.has(w)) span('k', w); else plain += w;
      i = j; continue;
    }
    plain += ch; i++;
  }
  flush();
  return out;
}

// The source as numbered lines. `data-code` holds the text, for anything that wants to compare it.
export function sourceBlock(code, firstLine, py = true) {
  const st = { tri: null };
  const lines = String(code).replace(/\n$/, '').split('\n');
  return h('div', { class: 'src', 'data-code': code },
    lines.map((l, i) => h('div', { class: 'l' }, h('span', { class: 'n' }, String(firstLine + i)), h('span', { class: 't' }, ...tokens(l, st, py)))));
}

const isPy = f => /\.py$/.test(f);
const testRuns = new Map();      // test file -> {running, passed, text}

// Draws the Code or Test segment into `host`. info = {seg, level, id, S, api, changed: Map tile -> {code, line}, busy(), repaint()}
export async function paintSource(host, info) {
  const { seg, level, id, S, api } = info;
  const key = [seg, level, id].join('|');
  const keep = host.dataset.key === key ? [host.scrollTop, host.scrollLeft] : [0, 0];
  const nodes = [];
  const path = (file, line) => h('p', { class: 'srcpath', id: 'srcpath' }, file + (line ? `, line ${line}` : ''));
  const fail = (file, e) => h('p', { class: 'grey', id: 'srcnone' }, `Could not read ${file}: ${e && e.message || e}`);
  const readFile = async file => { try { return { text: await api.readModelFile(file) }; } catch (e) { return { err: e }; } };
  let file = null;

  if (seg === 'code' && level === 'tile') {
    const x = L.q(S, id), src = (x && x.source) || {};
    const st = L.tileStatus(S, id) || {};
    const was = info.changed.get(id);
    const drift = st.state === 'stale' && st.drift === 'formula';
    nodes.push(path(src.file || '', src.line));
    if (was && was.code !== src.code && (drift || st.state !== 'signed_off')) {
      nodes.push(h('div', { class: 'srcpair', id: 'srcpair' },
        h('div', { id: 'srcwas' }, h('p', { class: 'srclab' }, 'Was'), sourceBlock(was.code, was.line || src.line || 1)),
        h('div', { id: 'srcnow' }, h('p', { class: 'srclab' }, 'Now'), sourceBlock(src.code || '', src.line || 1))));
    } else nodes.push(sourceBlock(src.code || '', src.line || 1));
  } else if (seg === 'code') {
    if (level === 'module') {
      const mod = L.moduleOf(S, id);
      const first = mod && mod.tiles.map(t => L.q(S, t)).find(q => q && q.source && q.source.file);
      file = first ? first.source.file : null;
    } else file = 'tilekit.toml';
    if (!file) nodes.push(h('p', { class: 'grey', id: 'srcnone' }, 'This module has no source file yet.'));
    else {
      const r = await readFile(file);
      nodes.push(path(file));
      nodes.push(r.err ? fail(file, r.err) : sourceBlock(r.text, 1, isPy(file)));
    }
  } else if (seg === 'test') {
    file = `tests/tiles/test_${id}.py`;
    const r = await readFile(file);
    const run = testRuns.get(file);
    const btn = h('button', { type: 'button', id: 'runtest', disabled: !!((run && run.running) || r.err || info.busy()), onclick: async () => {
      testRuns.set(file, { running: true });
      await paintSource(host, info);
      try {
        const res = await api.tk('test', ['--file', file]);
        const text = [res && res.output, res && res.stdout, res && res.report].filter(x => typeof x === 'string' && x.trim()).join('\n');
        testRuns.set(file, { passed: !(res && (res.passed === false || res.failed > 0 || res.ok === false)), text });
      } catch (e) { testRuns.set(file, { passed: false, text: String(e && e.message || e) }); }
      await info.repaint();
    } }, 'Run this test');
    nodes.push(path(file), h('div', { class: 'testbar' }, btn));
    if (run) nodes.push(h('div', { class: 'testrun', id: 'testresult' },
      h('strong', {}, run.running ? 'Running…' : run.passed ? 'Passed.' : 'Failed.'), ...(run.text ? [h('pre', {}, run.text)] : [])));
    nodes.push(r.err ? h('p', { class: 'grey', id: 'srcnone' }, 'There is no test file for this tile.') : sourceBlock(r.text, 1, true));
  }
  host.dataset.key = key;
  host.replaceChildren(...nodes);
  host.scrollTop = keep[0]; host.scrollLeft = keep[1];
}
