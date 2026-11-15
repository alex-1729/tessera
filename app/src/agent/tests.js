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

module.exports = { caseChecks, caseCheckProblems, validateTests, acceptTestsDraft, testRel };
