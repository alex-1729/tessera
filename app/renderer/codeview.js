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

// What changed, as one listing at full width: unchanged lines once, a removed line struck with a minus and a red
// tint, an added line with a plus and a green tint. `#srcwas` and `#srcnow` keep the two whole texts for anything
// that wants to compare them.
export function diffBlock(before, after, firstLine) {
  const a = String(before).replace(/\n$/, '').split('\n'), b = String(after).replace(/\n$/, '').split('\n');
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const was = [...sourceBlock(before, firstLine).children], now = [...sourceBlock(after, firstLine).children];
  const rows = [];
  const mark = (node, cls, sign) => { node.classList.add(cls); node.prepend(h('span', { class: 'sign' }, sign)); return node; };
  let i = 0, j = 0, removed = 0, added = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { rows.push(mark(now[j], 'same', '')); i++; j++; }
    // the old line first, then what replaced it
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) { rows.push(mark(was[i], 'del', '\u2212')); i++; removed++; }
    else { rows.push(mark(now[j], 'add', '+')); j++; added++; }
  }
  const word = (k, one) => `${k} line${k === 1 ? '' : 's'} ${one}`;
  return h('div', { class: 'srcpair', id: 'srcpair' },
    h('p', { class: 'srclab' }, `Changed since you last looked: ${[added ? word(added, 'added') : '', removed ? word(removed, 'removed') : ''].filter(Boolean).join(', ') || 'no lines differ'}`),
    h('div', { class: 'src diff', id: 'srcdiff' }, rows),
    h('div', { id: 'srcwas', hidden: true }, h('div', { class: 'src', 'data-code': before })),
    h('div', { id: 'srcnow', hidden: true }, h('div', { class: 'src', 'data-code': after })));
}

// A hand-calculation test file as the reviewer reads it: for each `def test_...` its name in words, the first line
// of its docstring, the rest of the docstring (the working) and its assert lines written as plain checks.
// `.intro` is the file's own docstring.
export function testCases(text) {
  const lines = String(text).split('\n');
  const out = [];
  const doc = (from) => {            // a triple-quoted string starting at or after `from`: [text, index after it]
    let i = from;
    while (i < lines.length && !lines[i].trim()) i++;
    const m = i < lines.length && /^\s*[rRuU]?("""|''')/.exec(lines[i]);
    if (!m) return ['', from];
    const q = m[1];
    let body = lines[i].slice(lines[i].indexOf(q) + 3);
    if (body.includes(q)) return [body.slice(0, body.indexOf(q)), i + 1];
    const got = [body];
    for (i++; i < lines.length; i++) {
      if (lines[i].includes(q)) { got.push(lines[i].slice(0, lines[i].indexOf(q))); return [got.join('\n'), i + 1]; }
      got.push(lines[i]);
    }
    return [got.join('\n'), i];
  };
  // the first line of a docstring sits after the quotes, so the indent is taken from the lines after it
  const dedent = t => { const ls = t.replace(/\s+$/, '').split('\n'); const rest = ls.slice(1).filter(l => l.trim()); const pad = rest.length ? Math.min(...rest.map(l => l.match(/^ */)[0].length)) : 0; return [ls[0].trimStart(), ...ls.slice(1).map(l => l.slice(pad))].join('\n'); };
  out.intro = dedent(doc(0)[0]).trim().replace(/\s*\n\s*/g, ' ');
  for (let i = 0; i < lines.length; i++) {
    const m = /^def (test_\w+)\s*\(/.exec(lines[i]);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
    let j = i + 1;
    while (j < end && !/:\s*$/.test(lines[j - 1])) j++;          // a signature that runs over several lines
    const [d, after] = doc(j);
    const parts = dedent(d).split('\n');
    const lead = (parts[0] || '').trim();
    const marker = /^\s*Case:\s*([A-Za-z0-9_]+)\s*,\s*month\s+(\d+)\s*$/m.exec(parts.slice(1).join('\n'));
    const working = parts.slice(1).filter(l => !/^\s*Case:\s*[A-Za-z0-9_]+\s*,\s*month\s+\d+\s*$/.test(l)).join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
    // the statements after the docstring, joined where a statement runs over lines
    const body = lines.slice(after, end).filter(l => l.trim() && !l.trim().startsWith('#'));
    const base = body.length ? Math.min(...body.map(l => l.match(/^ */)[0].length)) : 0;
    const checks = [];
    for (const l of body) { if (l.match(/^ */)[0].length === base || !checks.length) checks.push(l.trim()); else checks[checks.length - 1] += ' ' + l.trim(); }
    const plain = k => k.replace(/^assert\s+/, '').replace(/\s*==\s*pytest\.approx\(\s*([^,()]+(?:\([^()]*\))?)\s*(?:,[^)]*?abs\s*=\s*([^,)\s]+))?[^)]*\)/, (_m, v, tol) => `  =  ${v.trim()}${tol ? `   (to within ${tol})` : ''}`);
    const name = m[1];
    const exp = /==\s*(?:pytest\.approx\(\s*)?(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/.exec(checks[0] || '');
    const tolm = /abs\s*=\s*(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/.exec(checks[0] || '');
    out.push({ caseCheck: marker ? { case: marker[1], month: Number(marker[2]) } : null, expected: exp ? Number(exp[1]) : undefined, tolerance: tolm ? Number(tolm[1]) : undefined, name, title: name.replace(/^test_/, '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()), lead, working, checks: checks.map(plain) });
    i = end - 1;
  }
  return out;
}

// For a test taken from a case of the model: the hand figure, the Python value and the spreadsheet for that case and
// month, side by side. The spreadsheet is the tile's stored workbook, which compares Excel with Python in every month
// of every case; it counts only while that workbook is up to date.
async function threeWay(c, id, st, api, traces) {
  const k = c.caseCheck;
  if (!k) return null;
  if (!traces.has(k.case)) traces.set(k.case, api.tk('trace', ['--case', k.case]).catch(() => null));
  const tr = await traces.get(k.case);
  const series = tr && tr.series && tr.series[id];
  const py = Array.isArray(series) ? series[k.month - 1] : undefined;
  const hand = c.expected;
  const tol = c.tolerance || 1e-9;
  const num = x => (typeof x === 'number' && Number.isFinite(x) ? String(Number(x.toPrecision(12))) : 'not available');
  const handOk = typeof hand === 'number' && typeof py === 'number' && Math.abs(hand - py) <= Math.max(tol, 1e-12);
  const cr = (st.case_results || {})[k.case];
  const sheet = st.workbook_current === false ? { word: 'workbook out of date', ok: false }
    : !cr ? { word: 'no workbook for this case', ok: false }
      : cr.pass ? { word: `agrees with Python (largest difference ${num(cr.max_abs_difference || 0)})`, ok: true } : { word: `differs from Python by up to ${num(cr.max_abs_difference)}`, ok: false };
  const all = handOk && sheet.ok;
  return h('div', { class: 'threeway', 'data-agrees': String(all) },
    h('div', { class: 'srclab' }, `Same figure three ways: case ${k.case}, month ${k.month}`),
    h('table', {}, h('tbody', {},
      h('tr', {}, h('td', {}, 'Worked by hand'), h('td', { class: 'mono r' }, num(hand)), h('td', {})),
      h('tr', {}, h('td', {}, 'Python'), h('td', { class: 'mono r' }, num(py)), h('td', { class: handOk ? 'ok' : 'bad' }, typeof py !== 'number' ? 'no value for this month' : handOk ? 'agrees with the hand figure' : 'differs from the hand figure')),
      h('tr', {}, h('td', {}, 'Spreadsheet'), h('td', { class: 'mono r' }, sheet.ok && typeof py === 'number' ? num(py) : ''), h('td', { class: sheet.ok ? 'ok' : 'bad' }, sheet.word)))),
    h('div', { class: 'threeword ' + (all ? 'ok' : 'bad') }, all ? 'All three agree.' : 'Not all three agree yet.'));
}

// The kinds of test a reviewer can ask the agent to propose (the same list is in app/standards/writing-tiles.md).
export const TEST_KINDS = [
  ['boundary', 'Boundary values', 'zero, one, the first and last month, the month a term ends'],
  ['branches', 'Each branch', 'one check on each side of every condition'],
  ['direction', 'Direction', 'raising an input moves the result the expected way'],
  ['reconciliation', 'Reconciliation', 'the parts add up to the whole'],
  ['known', 'A known figure', 'a value from a pricing sheet or a published table (give it below)'],
];

function moreTests(id, info) {
  const boxes = TEST_KINDS.map(([key, title, what]) => {
    const box = h('input', { type: 'checkbox', value: key });
    return { key, title, what, box, row: h('label', { class: 'ck mt-kind' }, box, h('span', {}, h('b', {}, title), h('span', { class: 'grey' }, '  ' + what))) };
  });
  const extra = h('textarea', { id: 'mt-extra', rows: 2, maxlength: 1500, placeholder: 'Anything else to test, or the known figure and where it is from' });
  const go = h('button', { type: 'button', id: 'mt-go', disabled: true }, 'Ask the agent to propose these');
  const paint = () => { go.disabled = info.busy() || (!boxes.some(b => b.box.checked) && !extra.value.trim()); };
  boxes.forEach(b => b.box.addEventListener('change', paint));
  extra.addEventListener('input', paint);
  go.addEventListener('click', () => { go.disabled = true; info.askTests(id, boxes.filter(b => b.box.checked).map(b => `${b.title} (${b.what})`), extra.value.trim()); });
  return h('section', { class: 'moretests', id: 'moretests' },
    h('div', { class: 'testname' }, 'More tests'),
    h('p', { class: 'grey' }, 'Choose the kinds you want. The agent proposes them as a draft for you to accept; nothing is added to the test file until then.'),
    boxes.map(b => b.row), extra, h('div', { class: 'mt-btns' }, go));
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
    if (L.isNotBuilt(st)) {
      // Nothing to read yet: the file holds only a placeholder so the model loads. Say what is planned, in words.
      const assumed = x.assumed || [];
      nodes.push(h('div', { class: 'notbuilt', id: 'srcnotbuilt' },
        h('div', { class: 'nb-title' }, 'Not built yet'),
        h('p', {}, info.build ? 'There is no code for this tile yet.' : 'There is no code for this tile yet. Select it and ask the agent to build it.'),
        // asks the agent, in the chat, to write this tile and its test; what it writes still needs your review
        info.build ? h('p', {}, h('button', { type: 'button', class: 'primary', id: 'buildtile', disabled: info.busy(), onclick: e => { e.target.disabled = true; info.build(id); } }, 'Build this tile'),
          h('span', { class: 'grey nb-hint' }, info.busy() ? 'The agent is busy.' : 'The agent writes the code and its hand-calculation test.')) : null,
        h('table', { class: 'nb-plan' }, h('tbody', {},
          [['Will be', x.label || id], ['Reads', (x.args || []).join(', ')], ['Units', x.units || ''], ['Timing', x.timing || ''], ...assumed.map(a => ['Assumed', a])]
            .filter(r => r[1]).map(r => h('tr', {}, h('td', { class: 'grey' }, r[0]), h('td', { class: r[0] === 'Reads' ? 'mono' : '' }, r[1]))))),
        h('details', { class: 'testfile' }, h('summary', {}, 'The placeholder in the file'), sourceBlock(src.code || '', src.line || 1))));
    } else if (was && was.code !== src.code && (drift || st.state !== 'signed_off')) {
      // A tile built for the first time has nothing worth comparing: its old code was only the not-built stub.
      if (/^\s*Status:\s*not built/im.test(was.code)) nodes.push(h('p', { class: 'srclab', id: 'srcnew' }, 'Newly built'), sourceBlock(src.code || '', src.line || 1));
      else nodes.push(diffBlock(was.code, src.code || '', src.line || 1));
      // "Acknowledge" only clears the highlighting: it records nothing and is not a sign-off
      const ack = h('button', { type: 'button', class: 'small', id: 'srcack', title: 'Clears the highlighting. This is not a sign-off.', onclick: () => { info.changed.delete(id); void info.repaint(); } }, 'Acknowledge changes');
      const lab = nodes[nodes.length - 1].querySelector('.srclab') || nodes[nodes.length - 2];
      if (lab) lab.append(' ', ack);
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
    // The reviewer reads the hand calculations, not pytest: one block per test with its working and what it checks.
    // The result line sits beside the Run button; pytest's own output shows only when something failed, and the
    // file itself is one click away at the bottom.
    const cases = r.err ? [] : testCases(r.text);
    const failed = run && !run.running && !run.passed ? new Set([...String(run.text || '').matchAll(/^(?:FAILED \S+::|_{3,} )(\w+)/gm)].map(m => m[1])) : new Set();
    const ran = run && !run.running;
    const resultWord = !run ? '' : run.running ? 'Running…' : run.passed ? `Passed. ${cases.length ? `${cases.length} of ${cases.length} checks agree.` : ''}`
      : `Failed.${failed.size && cases.length ? ` ${failed.size} of ${cases.length} checks do not agree.` : ''}`;
    nodes.push(path(file), h('div', { class: 'testbar' }, btn,
      run ? h('span', { class: 'testword ' + (run.running ? 'grey' : run.passed ? 'ok' : 'bad'), id: 'testresult' }, h('strong', {}, resultWord)) : h('span', { class: 'grey' }, 'Not run in this session.')));
    if (ran && !run.passed && run.text) nodes.push(h('pre', { class: 'testout', id: 'testout' }, run.text));
    if (r.err) nodes.push(h('p', { class: 'grey', id: 'srcnone' }, 'There is no test file for this tile.'));
    else {
      if (cases.intro) nodes.push(h('p', { class: 'testintro' }, cases.intro));
      const traces = new Map();
      const tileSt = L.tileStatus(S, id) || {};
      for (const c of cases) {
        const three = await threeWay(c, id, tileSt, api, traces);
        const state = !ran ? '' : failed.has(c.name) ? 'does not agree' : (run.passed || failed.size) ? 'agrees' : '';
        nodes.push(h('section', { class: 'testcase', 'data-test': c.name },
          h('div', { class: 'testhead' }, h('span', { class: 'testname' }, c.title), state ? h('span', { class: 'teststate ' + (state === 'agrees' ? 'ok' : 'bad') }, state) : null),
          c.lead ? h('p', { class: 'testlead' }, c.lead) : null,
          c.working ? h('div', { class: 'testwork' }, h('div', { class: 'srclab' }, 'Worked by hand'), h('pre', {}, c.working)) : null,
          c.checks.length ? h('div', { class: 'testchecks' }, h('div', { class: 'srclab' }, 'Checked against the tile'), c.checks.map(k => h('pre', { class: 'testcheck' }, k))) : null,
          three));
      }
      if (!cases.some(c => c.caseCheck)) nodes.push(h('p', { class: 'warn', id: 'nocasecheck' }, 'No test here is taken from a case of the model, so the hand figures are not yet set beside the spreadsheet. Ask the agent to add one.'));
      if (info.askTests) nodes.push(moreTests(id, info));
      nodes.push(h('details', { class: 'testfile', id: 'testfile' }, h('summary', {}, 'The test file'), sourceBlock(r.text, 1, true)));
    }
  }
  host.dataset.key = key;
  host.replaceChildren(...nodes);
  host.scrollTop = keep[0]; host.scrollLeft = keep[1];
}
