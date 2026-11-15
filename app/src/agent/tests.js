'use strict';
// Extra hand-calculation tests for a built tile, proposed by the agent as a draft and added to the tile's test file
// only when the reviewer accepts. Also the rule that every tile's test file has one check on a case of the model,
// marked `Case: <id>, month <n>` in that test's docstring, so the hand figure can be set beside the spreadsheet's.
const fs = require('fs');
const path = require('path');

const CASE_LINE = /^\s*Case:\s*([A-Za-z0-9_]+)\s*,\s*month\s+(\d+)\s*$/m;
const testRel = name => `tests/tiles/test_${name}.py`;

// {case, month} of every `Case: id, month n` line in a test file.
function caseChecks(text) {
  return [...String(text || '').matchAll(new RegExp(CASE_LINE.source, 'gm'))].map(m => ({ case: m[1], month: Number(m[2]) }));
}

// What is wrong with a tile's whole test file as far as the case check goes ([] when fine).
function caseCheckProblems(text, caseIds, months) {
  const found = caseChecks(text);
  const good = found.filter(c => caseIds.includes(c.case) && c.month >= 1 && (!months || c.month <= months));
  if (good.length) return [];
  const eg = caseIds.includes('base') ? 'base' : (caseIds[0] || 'base');
  return [`The test file needs at least one check taken from a case of the model, so the hand figure can be compared with the spreadsheet. In that test's docstring, after the first line, add a line \`Case: ${eg}, month 1\` (a case id from: ${caseIds.join(', ') || 'none yet'}; any month), work the figure by hand from that case's inputs for that month, and assert the tile's value for those inputs.`];
}

function names(text) {
  return [...String(text || '').matchAll(/^def (test_\w+)\s*\(/gm)].map(m => m[1]);
}

// items: [{name, code, kind}]. `existing` is the tile's current test file.
function validateTests(tile, items, existing) {
  const problems = [];
  if (!existing) problems.push(`${tile} has no test file yet; build the tile first (write_tile writes the tile and its first test).`);
  if (!Array.isArray(items) || !items.length) problems.push('The draft has no tests.');
  const have = new Set(names(existing));
  const seen = new Set();
  for (const it of items || []) {
    const n = it.name || '';
    const code = String(it.code || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    if (!/^test_[a-z0-9_]+$/.test(n)) { problems.push(`'${n}' is not a test name (test_ then lower case, digits and underscores).`); continue; }
    if (seen.has(n)) problems.push(`${n} appears twice in the draft.`);
    seen.add(n);
    if (have.has(n)) problems.push(`${n} is already in the test file; choose a new name (existing tests are not replaced here).`);
    if (!new RegExp(`^def ${n}\\(\\s*\\)\\s*:`).test(code)) problems.push(`The code of ${n} must start with \`def ${n}():\`.`);
    if (code.split('\n').slice(1).some(l => l.trim() && !/^\s/.test(l))) problems.push(`${n}: send only the one function (a line is outside it).`);
    if (/^\s*(import|from)\s/m.test(code.split('\n').slice(1).join('\n'))) problems.push(`${n}: no imports inside a test; the file already imports pytest and the tile.`);
    if (!/("""|''')[\s\S]*?\1/.test(code)) problems.push(`${n} needs a docstring: a first line saying what is checked, then the working by hand.`);
    if (!/^\s+assert\s/m.test(code)) problems.push(`${n} has no assert.`);
    if (!new RegExp(`\\b${tile}\\s*\\(`).test(code)) problems.push(`${n} does not call ${tile}.`);
  }
  return { problems, warnings: [] };
}

// Add the draft's tests to the file and run it. If any check fails the file is put back as it was: a hand
// calculation that disagrees with the tile is something to look into, not something to save quietly.
async function acceptTestsDraft(ctx, draft) {
  const tile = draft.tile;
  const rel = testRel(tile);
  const file = path.join(ctx.modelDir, rel);
  let before = null;
  try { before = fs.readFileSync(file, 'utf8'); } catch { /* no file */ }
  const check = validateTests(tile, draft.items, before);
  if (check.problems.length) return { accepted: false, actions: ['The draft no longer fits: ' + check.problems.join(' ')] };
  const added = draft.items.map(it => String(it.code).replace(/\r\n?/g, '\n').replace(/\s+$/, '')).join('\n\n\n');
  fs.writeFileSync(file, before.replace(/\s+$/, '') + '\n\n\n' + added + '\n');
  if (ctx.runPytest) {
    const r = await ctx.runPytest(rel);
    if (!r.passed) {
      fs.writeFileSync(file, before);
      const failed = [...String(r.output || '').matchAll(/^(?:FAILED \S+::|_{3,} )(\w+)/gm)].map(m => m[1]);
      const which = [...new Set(failed)].filter(n => draft.items.some(i => i.name === n));
      return { accepted: false, actions: [`The tests were not added: ${which.length ? which.join(', ') : 'the test file'} did not agree with ${tile}. Either the hand calculation or the tile is wrong; nothing was changed. ${String(r.output || '').split('\n').filter(l => /^E\s/.test(l)).slice(0, 4).join(' ')}`.trim()] };
    }
  }
  return { accepted: true, actions: [`Added ${draft.items.length} test${draft.items.length === 1 ? '' : 's'} to ${rel}: ${draft.items.map(i => i.name).join(', ')}. Every check agrees.`] };
}

// ---------------------------------------------------------------- the module's own test

const moduleTestRel = id => `tests/modules/test_${id}.py`;
const testNames = text => names(text);

// The functions of a test file: [{name, code}] for each top-level `def test_...`.
function testFunctions(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^def (test_\w+)\s*\(/.exec(lines[i]);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
    out.push({ name: m[1], code: lines.slice(i, end).join('\n').replace(/\s+$/, '') });
    i = end - 1;
  }
  return out;
}

// One test function of a module test: a docstring and an assert, and it uses a tile of the module.
function moduleFunctionProblems(fn, tiles) {
  const problems = [];
  const n = fn.name;
  if (!/("""|''')[\s\S]*?\1/.test(fn.code)) problems.push(`${n} needs a docstring: a first line saying what is checked, then the working by hand.`);
  if (!/^\s+assert\s/m.test(fn.code)) problems.push(`${n} has no assert.`);
  if (!tiles.some(t => new RegExp(`\\b${t}\\b`).test(fn.code))) problems.push(`${n} does not use any tile of the module (${tiles.join(', ')}).`);
  return problems;
}

/**
 * A module test draft for module `mod` ({id, tiles}). With no file yet (`existing` null) `code` is the whole file;
 * otherwise `items` ([{name, code}]) are functions to add. Returns {problems, warnings}.
 */
function validateModuleTest(mod, { code, items, existing, caseIds = [], months } = {}) {
  const problems = [];
  const tiles = mod.tiles || [];
  if (!tiles.length) problems.push(`${mod.id} has no tiles yet, so there is nothing for a module test to walk through.`);
  if (existing === null || existing === undefined) {
    if ((items || []).length && !code) problems.push(`${mod.id} has no module test yet: give the whole file in \`code\`, not \`tests\`.`);
    if (!code || !String(code).trim()) { if (!(items || []).length) problems.push('Give the whole test file in `code`.'); return { problems, warnings: [] }; }
    const text = String(code).replace(/\r\n?/g, '\n');
    if (!/^\s*("""|''')/.test(text)) problems.push('Start the file with a module docstring stating the case and the figures the test uses.');
    const imports = text.split('\n').filter(l => /^(import|from)\s/.test(l));
    for (const l of imports) {
      if (!/^import pytest\s*$|^import numpy as np\s*$|^from __future__ import|^from tilekit[\w.]* import|^from [a-z_][\w.]* import [\w, ()]+$/.test(l.trim())) problems.push(`The import \`${l.trim()}\` is not allowed; import pytest, numpy as np, the module's tiles and tilekit only.`);
    }
    const fns = testFunctions(text);
    if (!fns.length) problems.push('The file has no test functions (def test_...():).');
    const seen = new Set();
    for (const fn of fns) {
      if (seen.has(fn.name)) problems.push(`${fn.name} appears twice.`);
      seen.add(fn.name);
      problems.push(...moduleFunctionProblems(fn, tiles));
    }
    problems.push(...caseCheckProblems(text, caseIds, months).map(p => p.replace('The test file needs', 'The module test needs')));
    return { problems, warnings: [] };
  }
  if (code && String(code).trim()) problems.push(`${moduleTestRel(mod.id)} exists: give the functions to add in \`tests\`, not a whole file in \`code\`.`);
  if (!Array.isArray(items) || !items.length) { if (!code) problems.push('The draft has no tests.'); return { problems, warnings: [] }; }
  const have = new Set(names(existing));
  const seen = new Set();
  for (const it of items) {
    const n = it.name || '';
    const c = String(it.code || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    if (!/^test_[a-z0-9_]+$/.test(n)) { problems.push(`'${n}' is not a test name (test_ then lower case, digits and underscores).`); continue; }
    if (seen.has(n)) problems.push(`${n} appears twice in the draft.`);
    seen.add(n);
    if (have.has(n)) problems.push(`${n} is already in the module test; choose a new name.`);
    // a module test may take the model's pytest fixtures (model, named_case, ...)
    if (!new RegExp(`^def ${n}\\(\\s*([a-z_]\\w*(\\s*,\\s*[a-z_]\\w*)*)?\\s*\\)\\s*:`).test(c)) problems.push(`The code of ${n} must start with \`def ${n}():\` (fixture arguments such as model are allowed).`);
    if (c.split('\n').slice(1).some(l => l.trim() && !/^\s/.test(l))) problems.push(`${n}: send only the one function (a line is outside it).`);
    if (/^\s*(import|from)\s/m.test(c.split('\n').slice(1).join('\n'))) problems.push(`${n}: no imports inside a test; use only what the file already imports.`);
    problems.push(...moduleFunctionProblems({ name: n, code: c }, tiles));
  }
  return { problems, warnings: [] };
}

// Write the module test (or add to it) and run it. A check that fails puts the file back as it was.
async function acceptModuleTestDraft(ctx, draft, mod, { caseIds = [], months } = {}) {
  const rel = moduleTestRel(draft.module);
  const file = path.join(ctx.modelDir, rel);
  let before = null;
  try { before = fs.readFileSync(file, 'utf8'); } catch { /* no file yet */ }
  const whole = typeof draft.code === 'string';
  if (whole && before !== null) return { accepted: false, actions: [`The draft no longer fits: ${rel} was written meanwhile. Ask the agent to propose the tests to add to it.`] };
  if (!whole && before === null) return { accepted: false, actions: [`The draft no longer fits: ${rel} does not exist any more.`] };
  const check = validateModuleTest(mod, whole ? { code: draft.code, existing: null, caseIds, months } : { items: draft.items, existing: before });
  if (check.problems.length) return { accepted: false, actions: ['The draft no longer fits: ' + check.problems.join(' ')] };
  const text = whole ? draft.code.replace(/\s+$/, '') + '\n'
    : before.replace(/\s+$/, '') + '\n\n\n' + draft.items.map(it => String(it.code).replace(/\r\n?/g, '\n').replace(/\s+$/, '')).join('\n\n\n') + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const putBack = () => { if (before === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before); };
  const n = whole ? testNames(text).length : draft.items.length;
  if (ctx.runPytest) {
    const r = await ctx.runPytest(rel);
    if (!r.passed) {
      putBack();
      const failed = [...new Set([...String(r.output || '').matchAll(/^(?:FAILED \S+::|_{3,} )(\w+)/gm)].map(m => m[1]))];
      return { accepted: false, actions: [`The module test was not saved: ${failed.length ? failed.join(', ') : 'the test file'} did not agree with the tiles of ${draft.module}. Either the hand calculation or a tile is wrong; nothing was changed. ${String(r.output || '').split('\n').filter(l => /^E\s/.test(l)).slice(0, 4).join(' ')}`.trim()] };
    }
    return { accepted: true, actions: [whole ? `Wrote ${rel} (${n} test${n === 1 ? '' : 's'}) and ran it: every check agrees.` : `Added ${n} test${n === 1 ? '' : 's'} to ${rel} and ran it: every check agrees.`] };
  }
  return { accepted: true, actions: [whole ? `Wrote ${rel} (${n} test${n === 1 ? '' : 's'}); it was not run.` : `Added ${n} test${n === 1 ? '' : 's'} to ${rel}; it was not run.`] };
}

module.exports = { caseChecks, caseCheckProblems, validateTests, acceptTestsDraft, testRel, moduleTestRel, testNames, testFunctions, validateModuleTest, acceptModuleTestDraft };
