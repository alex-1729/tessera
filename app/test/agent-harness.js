'use strict';
// Headless harness for the modelling agent (plain node, no Electron).
//   node test/agent-harness.js            offline checks, then live scenarios (uses the Claude Code login)
//   node test/agent-harness.js --offline  offline checks only (no model calls)
//   node test/agent-harness.js --only 1,3 live scenarios 1 and 3 (after the offline checks)
// Every check runs on a fresh temporary copy of model/; the real model directory is never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { findUv } = require('../src/tilekit');
const { createAgentService } = require('../src/agent');
const { createHandlers } = require('../src/agent/tools');
const src = require('../src/agent/source');
const val = require('../src/agent/validate');
const edits = require('../src/agent/edits');

const REPO = path.resolve(__dirname, '..', '..');
const REAL_MODEL = path.join(REPO, 'model');
const TILEKIT = path.join(REPO, 'tilekit');     // the app's own copy of the tooling
const GRIDCRAFT = path.join(REPO, 'vendor', 'gridcraft', 'cli', 'gridcraft-cli');
const OFFLINE = process.argv.includes('--offline');
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(',').map(Number)) : null;
const SCENARIO_TIMEOUT_MS = 8 * 60 * 1000;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-harness-'));

// ---------------------------------------------------------------- helpers

const SKIP = new Set(['.venv', '.pytest_cache', '__pycache__', 'real-data', '.git']);
let copies = 0;
function copyModel() {
  const dir = path.join(TMP_ROOT, `model-${++copies}`);
  fs.cpSync(REAL_MODEL, dir, { recursive: true, filter: s => !SKIP.has(path.basename(s)) });
  return dir;
}

// tilekit for a temporary copy: the app's own tilekit project supplies the Python environment.
function runnerFor(modelDir) {
  const uv = findUv();
  return function run(command, args = []) {
    const argv = ['run', '--frozen', '--project', TILEKIT, 'tilekit', command, '--model', modelDir, ...args];
    return new Promise((resolve, reject) => {
      const child = spawn(uv, argv, { cwd: REPO, env: { ...process.env, GRIDCRAFT_CLI: GRIDCRAFT }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', reject);
      child.on('close', code => {
        let doc; try { doc = JSON.parse(out); } catch { doc = undefined; }
        if (doc && doc.error) return reject(new Error(doc.error.message || 'tilekit failed'));
        if (code !== 0 || doc === undefined) return reject(new Error(`tilekit ${command} failed (${code}): ${err.trim().split('\n').slice(-3).join(' ')}`));
        resolve(doc);
      });
    });
  };
}

function pytestFor(modelDir) {
  const uv = findUv();
  return rel => new Promise(resolve => {
    const child = spawn(uv, ['run', '--frozen', '--project', TILEKIT, 'python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', rel],
      { cwd: modelDir, env: { ...process.env, PYTHONPATH: path.join(modelDir, 'src') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ passed: code === 0, output: out.trim().split('\n').slice(-30).join('\n') }));
  });
}

function hashTree(dir) {
  const h = crypto.createHash('sha256');
  const walk = d => {
    for (const n of fs.readdirSync(d).sort()) {
      if (n === '__pycache__') continue;
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else h.update(path.relative(dir, p) + '\0').update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

function env(modelDir, confirmAnswer = false) {
  const events = [];
  const confirms = [];
  const tilekit = runnerFor(modelDir);
  const service = createAgentService({
    modelDir, repoRoot: REPO, tilekit, emit: e => events.push(e),
    confirm: async req => { confirms.push(req); return confirmAnswer; },
    runPytest: pytestFor(modelDir),
    ...(process.env.AGENT_DEBUG ? { debug: d => process.stderr.write('debug ' + JSON.stringify(d).slice(0, 500) + '\n') } : {}),
  });
  return { modelDir, events, confirms, tilekit, service };
}

// The unit projection laid out in two named sections, with units_net_change in the second (house standard).
const UNIT_SECTIONS = [{ title: 'Units allocated in the month', tiles: ['units_allocated', 'units_after_alloc'] },
  { title: 'Charge and closing units', tiles: ['units_amc', 'units_eop', 'units_net_change'] }];
const unitsFile = dir => path.join(dir, 'src', 'unit_linked', 'liability', 'units.py');
const lines = events => events.filter(e => e.type !== 'done' || e.text).map(e => `${e.type}: ${e.text}`);
const fnCode = (graph, name) => graph.quantities[name] && graph.quantities[name].source.code;

const NO_CAP = `def units_amc(units_after_alloc, amc_pm):
    """AMC units.

    Monthly management charge deducted in units: units after allocation times
    the monthly rate.

    Units: units per policy
    Timing: during month, after allocation
    Format: units
    Assumed: the charge is on units after the same month's allocation
    """
    return units_after_alloc * amc_pm`;

const NO_CAP_TEST = `"""units_amc without the cap, worked by hand for the base case months 1 to 3."""

import pytest

from unit_linked.liability.units import units_amc


def test_units_amc_no_cap():
    """Units after allocation * 0.000625.

    Case: base, month 1

    Month 1: 194.0 * 0.000625            = 0.12125
    Month 2: 387.091577026107 * 0.000625 = 0.241932235641317
    Round numbers: 12,000 * 0.002        = 24 (no cap any more: 20,000 * 0.002 = 40)
    """
    assert units_amc(194.0, 0.000625) == pytest.approx(0.12125, rel=0, abs=1e-9)
    assert units_amc(387.091577026107, 0.000625) == pytest.approx(0.241932235641317, rel=0, abs=1e-9)
    assert units_amc(12000.0, 0.002) == pytest.approx(24.0, rel=0, abs=1e-9)
    assert units_amc(20000.0, 0.002) == pytest.approx(40.0, rel=0, abs=1e-9)
`;

// ---------------------------------------------------------------- offline checks (no model calls)

async function offline() {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, pass: !!ok, ...(ok ? {} : { detail }) });
  const guard = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, String(e && e.stack || e)); } };

  await guard('source splice and code validation', async () => {
    const dir = copyModel();
    const tk = runnerFor(dir);
    const g = await tk('graph');
    const text = fs.readFileSync(unitsFile(dir), 'utf8');
    const out = src.spliceFunction(text, g.quantities.units_amc.source, NO_CAP);
    fs.writeFileSync(unitsFile(dir), out);
    const g2 = await tk('graph');
    check('splice replaces only units_amc', ['units_allocated', 'units_after_alloc', 'units_eop'].every(n => fnCode(g, n) === fnCode(g2, n)) && fnCode(g2, 'units_amc') === NO_CAP);
    check('code validation rejects a second function', src.tileCodeProblems('units_amc', NO_CAP + '\n\ndef other(x):\n    return x').length > 0);
    check('code validation rejects a wrong name', src.tileCodeProblems('units_eop', NO_CAP).length > 0);
    check('code validation accepts one function', src.tileCodeProblems('units_amc', NO_CAP).length === 0);
    const multi = 'def units_amc(\n    units_after_alloc,\n    amc_pm,\n):\n    """AMC units.\n\n    Format: units\n    """\n    return units_after_alloc * amc_pm';
    check('code validation accepts a multi-line signature', src.tileCodeProblems('units_amc', multi).length === 0, src.tileCodeProblems('units_amc', multi));
  });

  await guard('draft validation', async () => {
    const g = await runnerFor(REAL_MODEL)('graph'); // read-only
    const bad = val.validateTileDraft(g, 'unit_projection', [
      { name: 'offer_price', label: 'Offer price', args: ['unit_price', 'bid_offer_spread'], units: 'currency per unit', timing: 'during month', format: 'units', spec: 'Unit price times one plus the spread.' },
    ]);
    check('unknown argument is reported', bad.problems.some(p => /bid_offer_spread/.test(p)), bad);
    const good = [
      { name: 'offer_price', label: 'Offer price', args: ['unit_price', 'allocation_rate'], units: 'currency per unit', timing: 'during month', format: 'units', spec: 'x' },
      { name: 'units_allocated', label: 'Units allocated', args: ['premium', 'allocation_rate', 'offer_price'], units: 'units per policy', timing: 'during month', format: 'units', spec: 'y' },
    ];
    const ok = val.validateTileDraft(g, 'unit_projection', good);
    check('valid tile draft passes', ok.problems.length === 0, ok);
    check('tile draft summary', val.tileDraftSummary(g, good) === 'adds one tile, reroutes one link', val.tileDraftSummary(g, good));
    const dup = val.validateTileDraft(g, 'unit_projection', [{ ...good[0], name: 'premium' }]);
    check('name clash with an input is reported', dup.problems.some(p => /already exists/.test(p)), dup);
    const loop = val.validateTileDraft(g, 'unit_projection', [{ ...good[0], name: 'aa_x', args: ['bb_x'] }, { ...good[0], name: 'bb_x', args: ['aa_x'] }]);
    check('tile loop is reported', loop.problems.some(p => /loop/.test(p)), loop);
    const mods = val.validateModuleDraft(g, [{ id: 'fund_charges', title: 'Fund charges', layer: 'Liability', purpose: 'Charges and fund value.', feeds: ['new_results'] },
      { id: 'new_results', title: 'New results', layer: 'Results', purpose: 'Profit signature.', feeds: [] }]);
    check('valid module draft passes', mods.problems.length === 0, mods);
    check('module draft summary', /adds two modules/.test(val.moduleDraftSummary(g, [{ id: 'fund_charges', title: 'C', layer: 'Liability', purpose: 'p', feeds: ['new_results'] }, { id: 'new_results', title: 'P', layer: 'Results', purpose: 'p', feeds: [] }])));
    const badLayer = val.validateModuleDraft(g, [{ id: 'x_y', title: 'X', layer: 'Nowhere', purpose: 'p', feeds: ['nope'] }]);
    check('bad layer and feed are reported', badLayer.problems.length === 2, badLayer);
  });

  await guard('handlers: scope refusal, write_tile, what_if, sign-off confirm, drafts', async () => {
    const dir = copyModel();
    const e = env(dir, false);
    const svc = { modelDir: dir, tilekit: e.tilekit, confirm: async r => { e.confirms.push(r); return false; }, runPytest: pytestFor(dir),
      emitEvent: (scope, ev) => e.events.push({ scope, ...ev }), saveDraftEvent: d => { require('../src/agent/store').saveDraft(dir, d); e.events.push({ type: 'draft', text: d.summary, draft: d }); } };
    const turn = scope => ({ scope, batchModule: null, approved: new Set(), writes: [], drafts: [] });

    const t1 = turn({ level: 'tile', id: 'units_amc' });
    const h = createHandlers(svc, t1);
    const refused = await h.write_tile({ name: 'units_eop', code: 'def units_eop(a):\n    """x."""\n    return a', test_code: '' });
    check('write_tile refuses a tile outside the selection', refused.isError && /outside the selection/.test(refused.text), refused);
    const mod = createHandlers(svc, turn({ level: 'module', id: 'unit_projection' }));
    const r2 = await mod.write_tile({ name: 'units_amc', code: NO_CAP, test_code: '' });
    check('write_tile refuses at module level', r2.isError, r2);
    // from a tile, tiles are proposed for its own module only (the draft still needs the user's Accept)
    const pt = await h.propose_structure({ summary: 'x', module: 'cashflows', tiles: [] });
    check('propose_structure from a tile refuses a module that is not its own', pt.isError && /its own module \(unit_projection\) only/.test(pt.text), pt);

    const sel = await h.get_selection();
    const selDoc = JSON.parse(sel.text);
    check('get_selection has trace values for inputs and output', selDoc.trace && selDoc.trace.series.units_amc.length === 12 && selDoc.trace.series.units_after_alloc, Object.keys(selDoc));
    const tr = await h.read_trace({ case: 'high_charge', quantities: ['units_amc', 'units_after_alloc', 'amc_cap_units'], from_month: 100, to_month: 103 });
    check('read_trace returns rows', /^100\t/m.test(tr.text) && /amc_cap_units=25/.test(tr.text), tr.text);

    const before = fs.readFileSync(unitsFile(dir), 'utf8');
    const g0 = await e.tilekit('graph');
    const w = await h.write_tile({ name: 'units_amc', code: NO_CAP, test_code: NO_CAP_TEST });
    const g1 = await e.tilekit('graph');
    check('write_tile writes the tile and only the tile', !w.isError && fnCode(g1, 'units_amc') === NO_CAP &&
      ['units_allocated', 'units_after_alloc', 'units_eop'].every(n => fnCode(g0, n) === fnCode(g1, n)), w.text);
    check('write_tile rebuilds with zero differences and the test passes', /differences are zero in (\d+) of \1 cases/.test(e.events.map(x => x.text).join('\n')) && /Hand-calculation test passes/.test(w.text), w.text);
    check('write_tile writes the test file', fs.existsSync(path.join(dir, 'tests', 'tiles', 'test_units_amc.py')));

    const literal = NO_CAP.replace('units_after_alloc * amc_pm', 'units_after_alloc * amc_pm * 1.5');
    const afterGood = fs.readFileSync(unitsFile(dir), 'utf8');
    const w2 = await h.write_tile({ name: 'units_amc', code: literal, test_code: NO_CAP_TEST });
    check('rule violation restores the previous code', w2.isError && /literals/.test(w2.text) && fs.readFileSync(unitsFile(dir), 'utf8') === afterGood, w2.text);
    const w3 = await h.write_tile({ name: 'units_amc', code: NO_CAP.replace('amc_pm):', 'amc_pmx):'), test_code: NO_CAP_TEST });
    check('unresolved argument restores the previous code', w3.isError && fs.readFileSync(unitsFile(dir), 'utf8') === afterGood, w3.text);
    check('previous file differed from the edited one', before !== afterGood);

    const he = createHandlers(svc, turn({ level: 'tile', id: 'units_eop' }));
    const treeBefore = hashTree(path.join(dir, 'src'));
    const wi = await he.what_if({ name: 'units_eop', code: 'def units_eop(units_after_alloc, units_amc):\n    """Closing units.\n\n    Format: units\n    """\n    return units_after_alloc - units_amc - 1' });
    check('what_if leaves the model unchanged and returns numbers', !wi.isError && hashTree(path.join(dir, 'src')) === treeBefore && /month 120/.test(wi.text), wi.text);
    const wd = e.events.filter(x => x.type === 'draft').pop();
    check('what_if saves a draft', wd && wd.draft.kind === 'what_if', wd);
    const wp = await he.what_if({ params: { amc_pm: 0.001 } });
    check('parameter what_if works', !wp.isError && /largest change/.test(wp.text), wp.text);

    // Sign-off: sign units_allocated off, then try to change it with the human declining.
    let signed = null;
    await e.tilekit('test', ['--file', 'tests/tiles/test_units_allocated.py']);   // a tile's sign-off needs its test to have passed since the last change
    try { signed = await e.tilekit('signoff', ['--tile', 'units_allocated', '--reviewer', 'Harness']); } catch (err) { signed = { error: err.message }; }
    if (signed && signed.signed_off) {
      const ha = createHandlers(svc, turn({ level: 'tile', id: 'units_allocated' }));
      const fileBefore = fs.readFileSync(unitsFile(dir), 'utf8');
      const code = fnCode(g1, 'units_allocated').replace('return premium * allocation_rate / unit_price', 'return np.maximum(premium * allocation_rate / unit_price, 0)');
      const n = e.confirms.length;
      const wa = await ha.write_tile({ name: 'units_allocated', code, test_code: '' });
      check('signed-off tile: confirm is called and declining changes nothing', e.confirms.length === n + 1 && /un-ticks `units_allocated`/.test(e.confirms[n].message) &&
        !wa.isError && /declined/.test(wa.text) && fs.readFileSync(unitsFile(dir), 'utf8') === fileBefore, { confirm: e.confirms[n], text: wa.text });
    } else check('signed-off tile (direct)', false, signed);

    // Module-level draft and accept.
    const mh = createHandlers(svc, turn({ level: 'module', id: 'unit_projection' }));
    const netTile = { name: 'units_net_change', label: 'Change in units', args: ['units_eop', 'units_bop'], units: 'units per policy', timing: 'end of month', format: 'units', spec: 'Closing units less opening units.' };
    // house standard: a module of more than three tiles is laid out in named sections covering every tile
    const noSec = await mh.propose_structure({ summary: 'Adds net units.', tiles: [netTile] });
    check('a tiles draft for a module of more than three tiles needs sections covering every tile', noSec.isError && /named sections/.test(noSec.text) && /units_net_change/.test(noSec.text), noSec.text);
    const pd = await mh.propose_structure({ summary: 'Adds net units.', tiles: [netTile], sections: UNIT_SECTIONS });
    const draftEv = e.events.filter(x => x.type === 'draft').pop();
    check('propose_structure saves a draft and leaves the module file alone', !pd.isError && draftEv.draft.kind === 'tiles' && fs.readFileSync(unitsFile(dir), 'utf8') === afterGood, pd.text);
    check('propose_structure warns about naming', /_eop/.test(pd.text), pd.text);
    const svcFull = createAgentService({ modelDir: dir, repoRoot: REPO, tilekit: e.tilekit, emit: x => e.events.push(x), confirm: async () => false, runPytest: pytestFor(dir) });
    const acc = await svcFull.acceptDraft(draftEv.draft.id);
    const st = await e.tilekit('status');
    check('acceptDraft appends a not-built skeleton and the model still loads', acc.accepted && st.tiles.units_net_change && st.tiles.units_net_change.state === 'not_built' && /Status: not built/.test(fs.readFileSync(unitsFile(dir), 'utf8')), { acc, state: st.tiles.units_net_change });
    const chk = await e.tilekit('check');
    check('the skeleton passes the rule check', !(chk.violations || []).some(x => x.tile === 'units_net_change' && x.severity === 'error'), chk.violations.filter(x => x.tile === 'units_net_change'));
    check('drafts() lists it as accepted', svcFull.drafts().some(d => d.id === draftEv.draft.id && d.status === 'accepted'));

    // Model-level draft and accept.
    const mdl = createHandlers(svc, turn({ level: 'model', id: 'model' }));
    const md = await mdl.propose_structure({ summary: 'Adds charges.', modules: [{ id: 'charges', title: 'Charges', layer: 'Liability', purpose: 'Charges taken from the fund in money.', feeds: [] }] });
    const mdEv = e.events.filter(x => x.type === 'draft').pop();
    const acc2 = !md.isError && await svcFull.acceptDraft(mdEv.draft.id);
    const g3 = await e.tilekit('graph');
    check('model-level draft adds a module to tilekit.toml and a module file', acc2 && acc2.accepted && g3.modules.some(m => m.id === 'charges') &&
      fs.existsSync(path.join(dir, 'src', 'unit_linked', 'liability', 'charges.py')), { md: md.text, acc2 });
    const disc = await mdl.propose_structure({ summary: 'x', modules: [{ id: 'new_results', title: 'New results', layer: 'Results', purpose: 'Profit.', feeds: [] }] });
    const dEv = e.events.filter(x => x.type === 'draft').pop();
    svcFull.discardDraft(dEv.draft.id);
    check('discardDraft marks it discarded', !disc.isError && svcFull.drafts().find(d => d.id === dEv.draft.id).status === 'discarded');

    // Logs.
    const logOk = fs.existsSync(path.join(dir, 'review', 'model', 'log.jsonl'));
    check('events are appended to the scope log', logOk);
  });

  await guard('one conversation, sign-off requests, scaffolding drafts, overview, rebuild', async () => {
    await chatChecks(check);
  });

  await guard('tilekit init and scaffolding a fresh model', async () => {
    await freshModelChecks(check);
  });

  await guard('the design stage', () => designChecks(check));

  await guard('read guard', async () => {
    const dir = copyModel();
    const g = require('../src/agent').readGuard(dir);
    const denied = r => !!(r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny');
    check('read guard allows a model file', !denied(await g({ tool_name: 'Read', tool_input: { file_path: path.join(dir, 'tilekit.toml') } })));
    check('read guard allows a relative path', !denied(await g({ tool_name: 'Read', tool_input: { file_path: 'src/unit_linked/params.py' } })));
    check('read guard denies /etc/passwd', denied(await g({ tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } })));
    check('read guard denies ../ escapes', denied(await g({ tool_name: 'Read', tool_input: { file_path: '../../x' } })));
    check('read guard denies Grep outside', denied(await g({ tool_name: 'Grep', tool_input: { pattern: 'x', path: os.homedir() } })));
    check('read guard denies Glob with ..', denied(await g({ tool_name: 'Glob', tool_input: { pattern: '../**/*.py' } })));
  });
  await guard('git: status, commit, push requests', () => gitChecks(check));
  await guard('module layout, standing rules and module tests', () => layoutChecks(check));
  await guard('drafts accepted later, layout sign-offs, toml splicing and tile removal', () => draftFaultChecks(check));
  return results;
}

// ---------------------------------------------------------------- module sheets: sections, reconciliations, module tests

// TOML parsed by Python's tomllib (in the tooling's environment), to prove what tilekit will read.
function parseToml(text) {
  const { execFileSync } = require('child_process');
  const out = execFileSync(findUv(), ['run', '--frozen', '--project', TILEKIT, 'python', '-c', 'import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'],
    { input: text, cwd: REPO, encoding: 'utf8' });
  return JSON.parse(out);
}

const SMALL_TOML = `[model]
name = "T"
package = "p"

[[module]]
id = "a"
title = "Module A"
layer = "L"
python = "p.a"

# a comment above the sections
[[module.section]]
title = "First block"
tiles = ["t1", "t2"]

[[module.section]]
title = "Second block"
tiles = [
  "t3",
  "t4",
]

[[module.check]]   # zero when right
name = "t_reconcile"
label = "T reconciles"
expression = "t1 - t2"

[[module]]
id = "b"
title = "Module B"
layer = "L"
python = "p.b"

# ---- states

[state.t1_bop]
from = "t4"
initial = 0.0
`;

const MODULE_TEST = `"""Unit projection walked by hand for month 1 of the base case.

Base case: premium 250 a month, allocation rate 97%, unit price 1.25 in month 1, AMC 0.0625% a month capped at 25 units.
"""

import pytest

from unit_linked.liability.units import units_after_alloc, units_allocated, units_amc, units_eop

TOL = dict(rel=0, abs=1e-9)


def test_unit_projection_month_1():
    """Month 1 of the base case, tile by tile.

    Case: base, month 1
    Allocated 250 * 0.97 / 1.25 = 194.0; after allocation 0 + 194.0 = 194.0;
    AMC 194.0 * 0.000625 = 0.12125; closing 194.0 - 0.12125 = 193.87875
    """
    assert units_allocated(250.0, 0.97, 1.25) == pytest.approx(194.0, **TOL)
    assert units_after_alloc(0.0, 194.0) == pytest.approx(194.0, **TOL)
    assert units_amc(194.0, 0.000625, 25.0) == pytest.approx(0.12125, **TOL)
    assert units_eop(194.0, 0.12125) == pytest.approx(193.87875, **TOL)
`;

async function layoutChecks(check) {
  const testsMod = require('../src/agent/tests');
  // ---- the line-based toml helpers see sub-tables as part of their [[module]]
  const blocks = src.tomlModules(SMALL_TOML);
  check('tomlModules keeps [[module.section]] and [[module.check]] inside their module, without taking their keys as the module\'s',
    blocks.length === 2 && blocks[0].title === 'Module A' && blocks[0].sections.length === 2 && blocks[0].sections[1].tiles.join() === 't3,t4' &&
    blocks[0].checks.length === 1 && blocks[0].checks[0].expression === 't1 - t2' && blocks[1].start > blocks[0].checks[0].start, blocks);
  const laid = src.setModuleLayout(SMALL_TOML, 'a', { sections: [{ title: 'Rates in the period', tiles: ['t1'] }, { title: 'Roll-forward', tiles: ['t2', 't3', 't4'] }] });
  const p1 = parseToml(laid);
  check('setModuleLayout replaces the sections, keeps the checks, and TOML still attaches both to the module',
    p1.module.length === 2 && p1.module[0].section.map(x => x.title).join('|') === 'Rates in the period|Roll-forward' && p1.module[0].check[0].name === 't_reconcile' &&
    !p1.module[1].section && p1.state.t1_bop.from === 't4' && /# a comment above the sections\n\n?\[\[module\.section\]\]\ntitle = "Rates in the period"/.test(laid), laid);
  const checked = src.setModuleLayout(laid, 'b', { checks: [{ name: 'b_zero', label: 'B is zero', expression: 't1 * 2 - (t2 + t2)' }] });
  const p2 = parseToml(checked);
  check('setModuleLayout adds checks to a module that had none, leaving the other module alone',
    p2.module[1].check.length === 1 && p2.module[1].check[0].expression === 't1 * 2 - (t2 + t2)' && p2.module[0].section.length === 2 && p2.module[0].check.length === 1, checked);
  const added = src.insertModuleToml(SMALL_TOML, { id: 'c', title: 'C', layer: 'L', python: 'p.c' });
  const p3 = parseToml(added);
  check('insertModuleToml puts a new module after the last module\'s sub-tables, so they stay with their module',
    p3.module.map(m => m.id).join() === 'a,b,c' && p3.module[0].section.length === 2 && !p3.module[2].section, added);
  const withChecks = src.setModuleLayout(SMALL_TOML, 'b', { checks: [{ name: 'k', label: 'K', expression: 't1' }] });
  const appended = require('../src/agent/scaffold').editToml(withChecks, [{ type: 'input', name: 'extra', label: 'Extra', format: 'amount' }]);
  const p4 = parseToml(appended);
  check('editToml appends inputs after a [[module.check]] without moving the check', p4.module[1].check[0].name === 'k' && p4.input.extra.label === 'Extra', appended);
  const dropped = src.dropTilesFromSections(SMALL_TOML, 'a', ['t1', 't2']);
  check('dropTilesFromSections takes deleted tiles out and drops an emptied section', src.tomlModules(dropped)[0].sections.map(x => `${x.title}:${x.tiles.join('+')}`).join() === 'Second block:t3+t4', dropped);

  // ---- reconciliation expressions and the layout rules
  const known = new Set(['units_bop', 'units_eop', 'units_amc']);
  check('a reconciliation expression may use + - * /, parentheses, numbers and quantity names only',
    val.expressionProblems('units_bop - (units_amc * 2) / 1.5 - units_eop', known).length === 0 && /'\*' is out of place/.test(val.expressionProblems('units_bop ** 2', known)[0]) &&
    /out of place/.test(val.expressionProblems('np.abs(units_bop)', known).join(' ')) && val.expressionProblems('units_bop - nope', known).some(x => /'nope' is not a quantity/.test(x)) &&
    /not closed/.test(val.expressionProblems('(units_bop - units_eop', known)[0]) && /names no quantity/.test(val.expressionProblems('1 + 2', known)[0]) &&
    /uses '='/.test(val.expressionProblems('units_bop == units_eop', known)[0]), [val.expressionProblems('np.abs(units_bop)', known), val.expressionProblems('units_bop == units_eop', known)]);
  const dir = copyModel();
  const tk = runnerFor(dir);
  const g = await tk('graph');
  const items = [{ name: 'units_net_change', label: 'Change in units', args: ['units_eop', 'units_bop'], units: 'u', timing: 'during month', format: 'units', spec: 'Closing units less opening units.' }];
  const L1 = val.validateLayout(g, 'unit_projection', items, [], [], [{ title: 'A', tiles: ['units_allocated', 'units_amc'] }, { title: 'B', tiles: ['units_amc', 'deaths', 'nope'] }], undefined, { rules: true });
  check('sections: a tile in two sections, a tile of another module and an unknown name are each reported, and leaving tiles out is a problem',
    L1.problems.some(x => /units_amc is in two sections/.test(x)) && L1.problems.some(x => /deaths, which is not a tile of unit_projection/.test(x)) &&
    L1.problems.some(x => /nope/.test(x)) && L1.problems.some(x => /leave out .*units_net_change/.test(x)), L1.problems);
  const states = [{ name: 'net_bop', from: 'units_net_change', initial: 0, label: 'Opening net', format: 'units' }];
  const L2 = val.validateLayout(g, 'unit_projection', items, states, [], UNIT_SECTIONS, undefined, { rules: true });
  check('a tiles draft with a carried-forward state must give a reconciliation check', L2.problems.some(x => /net_bop makes a roll-forward/.test(x)), L2.problems);
  const L3 = val.validateLayout(g, 'unit_projection', items, states, [], UNIT_SECTIONS, [{ name: 'other', label: 'Other', expression: 'units_bop - units_eop' }], { rules: true });
  check('the check must use both the opening state and its closing tile', L3.problems.some(x => /both the opening value net_bop and the closing value units_net_change/.test(x)), L3.problems);
  const L4 = val.validateLayout(g, 'unit_projection', items, states, [], UNIT_SECTIONS, [{ name: 'net_reconcile', label: 'Net reconciles', expression: 'net_bop + units_net_change - units_net_change' }, { name: 'Bad Name', label: '', expression: 'x' }], { rules: true });
  check('a good check passes; a bad name is reported', !L4.problems.some(x => /net_reconcile/.test(x)) && L4.problems.some(x => /Bad Name/.test(x)), L4.problems);
  const L5 = val.validateLayout(g, 'unit_projection', items, [], [], undefined, undefined, { rules: false });
  check('on accept the standing rules are not re-applied (an older draft still fits)', L5.problems.length === 0, L5.problems);

  // ---- one step per tile
  const both = `def lapse_rate_pm(policy_year, lapse_rate_year1_pa, lapse_rate_later_pa, months_per_year):
    """Monthly lapse rate.

    The lapse rate for the policy year, as a monthly rate.

    Units: per month
    Timing: during month
    Format: rate
    """
    return 1 - (1 - np.where(policy_year == 1, lapse_rate_year1_pa, lapse_rate_later_pa)) ** (1 / months_per_year)`;
  check('one step per tile: choosing with np.where and converting with a power over a period is caught',
    src.chooseConvertProblems(both).length === 1 && /split it into two tiles/.test(src.chooseConvertProblems(both)[0]));
  check('one step per tile is narrow: a choice alone, a conversion alone, a square inside a choice and a cap with a power pass',
    !src.chooseConvertProblems('def f(a, b):\n    return np.where(a > 1, a, b)').length &&
    !src.chooseConvertProblems('def f(q, months_per_year):\n    return 1 - (1 - q) ** (1 / months_per_year)').length &&
    !src.chooseConvertProblems('def f(a, b):\n    return np.where(a > 1, a ** 2, b)').length &&
    !src.chooseConvertProblems('def f(a, b, m):\n    return np.minimum(a, b) ** (1 / m)').length &&
    src.chooseConvertProblems('def f(a, b, r):\n    return np.where(a > 1, np.exp(np.log(1 + r) / 12), b)').length === 1);
  const events = [];
  const svc = { modelDir: dir, tilekit: tk, confirm: async () => false, runPytest: pytestFor(dir), emitEvent: (scope, ev) => events.push({ scope, ...ev }),
    saveDraftEvent: d => { require('../src/agent/store').saveDraft(dir, d); events.push({ type: 'draft', draft: d }); } };
  const turn = scope => ({ scope, batchModule: null, approved: new Set(), writes: [], drafts: [] });
  const ht = createHandlers(svc, turn({ level: 'tile', id: 'units_amc' }));
  const unitsBefore = fs.readFileSync(unitsFile(dir), 'utf8');
  const two = await ht.write_tile({ name: 'units_amc', code: both.replace(/lapse_rate_pm/g, 'units_amc'), test_code: '' });
  check('write_tile refuses a tile that chooses and converts, and writes nothing', two.isError && /two tiles/.test(two.text) && fs.readFileSync(unitsFile(dir), 'utf8') === unitsBefore, two.text);

  // ---- a tiles draft with sections and a reconciliation check, accepted into tilekit.toml
  const hm = createHandlers(svc, turn({ level: 'module', id: 'unit_projection' }));
  const recon = [{ name: 'units_reconcile', label: 'Units roll-forward reconciles', expression: 'units_bop + units_allocated - units_amc - units_eop' },
    { name: 'net_change_agrees', label: 'Net change agrees', expression: 'units_net_change - (units_eop - units_bop)' }];
  const pd = await hm.propose_structure({ summary: 'Adds net units.', tiles: items, sections: UNIT_SECTIONS, checks: recon });
  const draft = (events.filter(x => x.type === 'draft').pop() || {}).draft || {};
  check('a tiles draft carries its sections and checks, and the summary says so', !pd.isError && draft.sections && draft.sections.length === 2 && draft.checks.length === 2 &&
    /in two sections with two reconciliation checks/.test(draft.summary), pd.text);
  const bad = await hm.propose_structure({ summary: 'x', tiles: items, sections: UNIT_SECTIONS, checks: [{ name: 'c1', label: 'C', expression: 'units_bop - np.abs(units_eop)' }] });
  check('a check expression with a function call is refused', bad.isError && /c1/.test(bad.text), bad.text);
  const tomlBefore = fs.readFileSync(path.join(dir, 'tilekit.toml'), 'utf8');
  // the model does not load afterwards: both the module file and tilekit.toml are put back
  let graphs = 0;
  const failing = (cmd, args) => (cmd === 'graph' && ++graphs === 2 ? Promise.reject(new Error('simulated load failure')) : tk(cmd, args));
  let threw = null;
  try { await edits.acceptTileDraft({ ...svc, tilekit: failing }, draft); } catch (err) { threw = err.message; }
  check('if the model does not load after a tiles draft, the module file and tilekit.toml are both restored',
    /would not load/.test(threw || '') && fs.readFileSync(unitsFile(dir), 'utf8') === unitsBefore && fs.readFileSync(path.join(dir, 'tilekit.toml'), 'utf8') === tomlBefore, threw);
  const acc = await edits.acceptTileDraft({ ...svc, confirm: async () => true }, draft);
  const toml = fs.readFileSync(path.join(dir, 'tilekit.toml'), 'utf8');
  const block = src.tomlModules(toml).find(b => b.id === 'unit_projection');
  const g2 = await tk('graph');
  const gm = g2.modules.find(m => m.id === 'unit_projection');
  check('accepting writes the sections and checks under the module in tilekit.toml and the model loads',
    acc.accepted && block.sections.map(x => x.tiles.join('+')).join('|') === 'units_allocated+units_after_alloc|units_amc+units_eop+units_net_change' &&
    block.checks.map(c => c.name).join() === 'units_reconcile,net_change_agrees' && !!g2.quantities.units_net_change &&
    acc.actions.some(a => /Laid out unit_projection in two sections/.test(a)) && acc.actions.some(a => /two reconciliation checks/.test(a)), { actions: acc.actions, block });
  check('the tooling reads the same sections and checks back (when it reports them)', !Array.isArray(gm.sections) ||
    (gm.sections.filter(x => x.title).map(x => x.title).join('|') === UNIT_SECTIONS.map(x => x.title).join('|') && (gm.checks || []).length === 2), { sections: gm.sections, checks: gm.checks });
  const parsed = parseToml(toml);
  check('tilekit.toml stays valid TOML with one set of sections for the module', parsed.module.find(m => m.id === 'unit_projection').section.length === 2, null);
  // removing a tile that a check uses needs the checks given again; then it is also taken out of the module's sections
  const rm0 = await hm.remove_tiles({ tiles: ['units_net_change'] });
  check('removing a tile that a reconciliation check uses is refused until the checks are given without it', !Array.isArray(gm.checks) || (rm0.isError && /net_change_agrees uses units_net_change/.test(rm0.text)), rm0.text);
  const rm = await hm.propose_structure({ summary: 'Removes net units.', remove: ['units_net_change'], checks: [recon[0]] });
  const rmDraft = (events.filter(x => x.type === 'draft').pop() || {}).draft || {};
  // the removed tile's record is kept: a stand-in sign-off, log and test go in first, and must come out in the archive
  const rmReview = path.join(dir, 'review', 'tiles', 'units_net_change');
  const rmTest = path.join(dir, 'tests', 'tiles', 'test_units_net_change.py');
  const rmArchive = path.join(dir, 'review', 'removed');
  const standIn = { 'signoff.json': JSON.stringify({ reviewer: 'A Reviewer', at: '2026-11-14T10:00:00Z', comment: 'stand-in' }, null, 2) + '\n',
    'log.jsonl': '{"type":"action","text":"Built units_net_change."}\n{"type":"signoff","reviewer":"A Reviewer"}\n' };
  const standInTest = 'def test_units_net_change_by_hand():\n    """110.0 - 100.0 = 10.0"""\n    assert 110.0 - 100.0 == 10.0\n';
  fs.mkdirSync(rmReview, { recursive: true });
  for (const [n, t] of Object.entries(standIn)) fs.writeFileSync(path.join(rmReview, n), t);
  fs.mkdirSync(path.dirname(rmTest), { recursive: true });
  fs.writeFileSync(rmTest, standInTest);
  const rmUnitsBefore = fs.readFileSync(unitsFile(dir), 'utf8');
  const rmTomlBefore = fs.readFileSync(path.join(dir, 'tilekit.toml'), 'utf8');
  const recordInPlace = () => !fs.existsSync(rmArchive) && fs.readFileSync(rmTest, 'utf8') === standInTest &&
    Object.entries(standIn).every(([n, t]) => fs.readFileSync(path.join(rmReview, n), 'utf8') === t) &&
    fs.readFileSync(unitsFile(dir), 'utf8') === rmUnitsBefore && fs.readFileSync(path.join(dir, 'tilekit.toml'), 'utf8') === rmTomlBefore;
  if (!rm.isError) {
    // the model does not load without the tile: nothing has been archived at that point
    let rmGraphs = 0, rmThrew = null;
    const rmFailing = (cmd, args) => (cmd === 'graph' && ++rmGraphs === 2 ? Promise.reject(new Error('simulated load failure')) : tk(cmd, args));
    try { await edits.acceptTileDraft({ ...svc, tilekit: rmFailing, confirm: async () => true }, rmDraft); } catch (err) { rmThrew = err.message; }
    check('a removal put back because the model would not load leaves no archive: the review folder, test, module file and tilekit.toml are as they were',
      /would not load/.test(rmThrew || '') && recordInPlace(), rmThrew);
    // the archive itself fails part-way (removed.json cannot be written over a folder of that name): all of it is undone
    fs.mkdirSync(path.join(rmReview, 'removed.json'));
    let rmThrew2 = null;
    try { await edits.acceptTileDraft({ ...svc, confirm: async () => true }, rmDraft); } catch (err) { rmThrew2 = err.message; }
    fs.rmSync(path.join(rmReview, 'removed.json'), { recursive: true, force: true });
    check('a removal whose archive fails part-way is undone: the folder and test are moved back, the archive is gone and nothing was changed',
      /could not be kept/.test(rmThrew2 || '') && /nothing was changed/.test(rmThrew2 || '') && recordInPlace(), rmThrew2);
  }
  const rmAcc = !rm.isError ? await edits.acceptTileDraft({ ...svc, confirm: async () => true }, rmDraft) : { accepted: false };
  const rmKept = fs.existsSync(rmArchive) ? fs.readdirSync(rmArchive).filter(n => /^units_net_change-\d{8}T\d{6}Z$/.test(n)) : [];
  const rmDir = path.join(rmArchive, rmKept[0] || 'none');
  let rmNote = {};
  try { rmNote = JSON.parse(fs.readFileSync(path.join(rmDir, 'removed.json'), 'utf8')); } catch { /* reported by the check */ }
  const keptText = n => { try { return fs.readFileSync(path.join(rmDir, n), 'utf8'); } catch { return null; } };
  check('accepting a removal takes the tile out of the module file, review/tiles and tests/tiles',
    rmAcc.accepted && !/def units_net_change\(/.test(fs.readFileSync(unitsFile(dir), 'utf8')) && !fs.existsSync(rmReview) && !fs.existsSync(rmTest) &&
    !(await tk('graph')).quantities.units_net_change, rmAcc.actions);
  check('the removed tile\'s record is kept under review/removed/<tile>-<time>/: sign-off and log byte for byte, and its test',
    rmKept.length === 1 && keptText('signoff.json') === standIn['signoff.json'] && keptText('log.jsonl') === standIn['log.jsonl'] &&
    keptText('test_units_net_change.py') === standInTest, { rmKept, files: fs.existsSync(rmDir) ? fs.readdirSync(rmDir) : null });
  check('removed.json names the tile, module, draft and time, says it was signed off and by whom, and holds the code as it was',
    rmNote.tile === 'units_net_change' && rmNote.module === 'unit_projection' && rmNote.draft === rmDraft.id && !!rmDraft.id &&
    /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(rmNote.removed_at || '') && rmNote.was_signed_off === true &&
    rmNote.signed_off && rmNote.signed_off.reviewer === 'A Reviewer' && rmNote.signed_off.at === '2026-11-14T10:00:00Z' &&
    /def units_net_change\(/.test(rmNote.code || ''), rmNote);
  check('the action says the record was kept and where, and the tooling does not see the archive as a tile',
    (rmAcc.actions || []).some(a => /Removed one tile from unit_projection: units_net_change\. Its code, test, sign-off record, log and stored workbook were kept under review\/removed\/\./.test(a)) &&
    !Object.keys((await tk('status')).tiles).some(n => /units_net_change/.test(n)), rmAcc.actions);
  const afterRm = src.tomlModules(fs.readFileSync(path.join(dir, 'tilekit.toml'), 'utf8')).find(b => b.id === 'unit_projection');
  check('removing a tile takes it out of the module\'s sections', rmAcc.accepted && !afterRm.sections.some(x => x.tiles.includes('units_net_change')), { rm: rm.text, sections: afterRm.sections });

  // ---- the module's own test
  const rel = testsMod.moduleTestRel('unit_projection');
  fs.rmSync(path.join(dir, rel), { force: true });
  const hModel = createHandlers(svc, turn({ level: 'model', id: 'model' }));
  const noMod = await hModel.propose_module_test({ summary: 'x', code: MODULE_TEST });
  check('at model level the module test needs a module', noMod.isError && /Name the module/.test(noMod.text), noMod.text);
  const hOther = createHandlers(svc, turn({ level: 'tile', id: 'deaths' }));
  const out = await hOther.propose_module_test({ summary: 'x', module: 'unit_projection', code: MODULE_TEST });
  check('the module test is refused from a tile of another module', out.isError && /proposed with that module/.test(out.text), out.text);
  const asTests = await hm.propose_module_test({ summary: 'x', tests: [{ name: 'test_a', code: 'def test_a():\n    """A."""\n    assert units_eop(1.0, 0.0) == 1.0' }] });
  check('with no module test yet, the whole file is asked for', asTests.isError && /whole file/.test(asTests.text), asTests.text);
  const noCase = await hm.propose_module_test({ summary: 'x', code: MODULE_TEST.replace('    Case: base, month 1\n', '') });
  check('a module test must name the case it walks (Case: id, month n)', noCase.isError && /Case: base, month 1/.test(noCase.text), noCase.text);
  const ht2 = createHandlers(svc, turn({ level: 'tile', id: 'units_amc' }));
  const pm = await ht2.propose_module_test({ summary: 'Walks month 1 of the base case.', code: MODULE_TEST });
  const mtDraft = (events.filter(x => x.type === 'draft').pop() || {}).draft || {};
  check('propose_module_test from a tile of the module saves a draft and writes nothing', !pm.isError && mtDraft.kind === 'module_test' && mtDraft.module === 'unit_projection' &&
    mtDraft.file === rel && !fs.existsSync(path.join(dir, rel)), pm.text);
  const caseIds = (await tk('cases')).cases.map(c => c.id);
  const mtAcc = await testsMod.acceptModuleTestDraft(svc, mtDraft, g.modules.find(m => m.id === 'unit_projection'), { caseIds });
  check('accepting the module test writes it and runs it: every check agrees', mtAcc.accepted && fs.readFileSync(path.join(dir, rel), 'utf8') === MODULE_TEST && /every check agrees/.test(mtAcc.actions[0]), mtAcc.actions);
  const pm2 = await hm.propose_module_test({ summary: 'A wrong figure.', tests: [{ name: 'test_wrong_closing', code: 'def test_wrong_closing():\n    """A closing figure worked wrongly.\n\n    194.0 - 0.12125 = 193.9 (wrong on purpose)\n    """\n    assert units_eop(194.0, 0.12125) == pytest.approx(193.9, **TOL)' }] });
  const mt2 = (events.filter(x => x.type === 'draft').pop() || {}).draft || {};
  const mtAcc2 = !pm2.isError ? await testsMod.acceptModuleTestDraft(svc, mt2, g.modules.find(m => m.id === 'unit_projection'), { caseIds }) : { accepted: true, actions: [pm2.text] };
  check('a module test that does not agree with the tiles is not saved, and says which test', !pm2.isError && !mtAcc2.accepted && /test_wrong_closing/.test(mtAcc2.actions[0]) &&
    fs.readFileSync(path.join(dir, rel), 'utf8') === MODULE_TEST, mtAcc2.actions);

  // ---- the terminal's tool list
  const { createAgentService } = require('../src/agent');
  const svcCli = createAgentService({ modelDir: dir, repoRoot: REPO, tilekit: tk, runPytest: null });
  const tools = await svcCli.cliTools();
  const ps = tools.find(t => t.name === 'propose_structure');
  const pmt = tools.find(t => t.name === 'propose_module_test');
  check('the terminal gets propose_module_test, and propose_structure takes sections and checks', !!pmt && /tests\/modules\/test_<module>\.py/.test(pmt.description) &&
    !!(ps && ps.inputSchema.properties.sections && ps.inputSchema.properties.checks), tools.map(t => t.name));
  const prompt = require('../src/agent/prompt').systemPrompt({ modelDir: dir });
  check('the standing rules reach the agent: the standards file and the layout step in the prompt', /One step per tile/.test(prompt) && /Named sections/.test(prompt) &&
    /A reconciliation for every roll-forward/.test(prompt) && /lay out the module sheet: sections/.test(prompt) && /propose_module_test/.test(prompt));
}

const storeMod = require('../src/agent/store');
const { TOOL_NAMES } = require('../src/agent/tools');

// ---------------------------------------------------------------- drafts accepted later, layout sign-offs, toml splicing, removal

const NET_TILE = { name: 'units_net_change', label: 'Change in units', args: ['units_eop', 'units_bop'], units: 'units per policy', timing: 'end of month', format: 'units', spec: 'Closing units less opening units.' };
const netCode = spec => `def units_net_change(units_eop, units_bop):
    """Change in units.

    ${spec}

    Units: units per policy
    Timing: end of month
    Format: units
    """
    return units_eop - units_bop`;
const NET_TEST = `"""units_net_change worked by hand."""

import pytest

from unit_linked.liability.units import units_net_change


def test_units_net_change_by_hand():
    """Closing units less opening units.

    Case: base, month 1

    Month 1: 193.87875 - 0.0 = 193.87875
    Round numbers: 110.0 - 100.0 = 10.0
    """
    assert units_net_change(193.87875, 0.0) == pytest.approx(193.87875, rel=0, abs=1e-9)
    assert units_net_change(110.0, 100.0) == pytest.approx(10.0, rel=0, abs=1e-9)
`;

// tilekit.toml content that is unusual but valid: a single-quoted label, a tolerance with an underscore, and a
// comment with a quoted word after a tiles array.
const ODD_CHECK = `[[module.check]]           # must be zero in every month of every case, in Excel and in Python
name = "units_reconcile"
label = 'Units roll-forward reconciles'
expression = "units_bop + units_allocated - units_amc - units_eop"
tolerance = 1_000`;
const ODD_SECTIONS = `[[module.section]]
title = "Units allocated in the month"
tiles = ["units_allocated", "units_after_alloc"]

[[module.section]]
title = 'Charge and closing units'
tiles = ["units_amc", "units_eop"]   # was "units_bonus" before the cap`;

function oddToml(text) {
  const a = text.indexOf('[[module.section]]');
  const b = text.indexOf('[[module]]', a);
  if (a < 0 || b < 0) throw new Error('the model\'s tilekit.toml is not laid out as the harness expects');
  return text.slice(0, a) + ODD_SECTIONS + '\n\n' + ODD_CHECK + '\n\n' + text.slice(b);
}

async function draftFaultChecks(check) {
  const turn = scope => ({ scope, batchModule: null, approved: new Set(), writes: [], drafts: [] });
  const modScope = { level: 'module', id: 'unit_projection' };
  const ctxFor = (dir, answer) => {
    const drafts = [], confirms = [];
    const svc = { modelDir: dir, tilekit: runnerFor(dir), confirm: async r => { confirms.push(r); return answer; }, runPytest: pytestFor(dir),
      emitEvent: () => {}, saveDraftEvent: d => { storeMod.saveDraft(dir, d); drafts.push(d); } };
    return { svc, drafts, confirms, tk: svc.tilekit, hm: createHandlers(svc, turn(modScope)) };
  };
  const tomlOf = dir => fs.readFileSync(path.join(dir, 'tilekit.toml'), 'utf8');
  const filesOf = dir => hashTree(path.join(dir, 'src')) + crypto.createHash('sha256').update(tomlOf(dir)).digest('hex');
  const attempt = async fn => { try { return { result: await fn() }; } catch (err) { return { error: err.message }; } };

  // ---- G: a draft accepted after the model moved on
  {
    const dir = copyModel();
    const { svc, drafts, hm, tk } = ctxFor(dir, true);
    const sections5 = UNIT_SECTIONS;
    const p1 = await hm.propose_structure({ summary: 'Adds net units.', tiles: [NET_TILE], sections: sections5 });
    const p2 = await hm.propose_structure({ summary: 'Adds net units, again.', tiles: [NET_TILE], sections: sections5 });
    const [d1, d2] = drafts;
    check('G: a tiles draft records which tiles were new and which were changes when it was proposed', !p1.isError && !p2.isError && !!d2 &&
      JSON.stringify(d1.new_tiles) === '["units_net_change"]' && JSON.stringify(d1.changed_tiles) === '[]', { p1: p1.text, d1 });
    const a1 = await edits.acceptTileDraft(svc, d1);
    const built = await edits.applyTileCode(svc, { name: 'units_net_change', code: netCode(NET_TILE.spec), testCode: NET_TEST });
    const gBuilt = await tk('graph');
    check('G: the first draft is accepted and the tile is then built', a1.accepted && built.ok && gBuilt.quantities.units_net_change.status !== 'not_built' &&
      !/Status: not built/.test(fnCode(gBuilt, 'units_net_change')), { a1, built: built.text });
    const before = filesOf(dir);
    const r2 = await attempt(() => edits.acceptTileDraft(svc, d2));
    check('G: the second draft, which added the same tile, is refused once the tile is in the model: no placeholder goes over the built tile and no file changes',
      /no longer fits the model/.test(r2.error || '') && /units_net_change was new when this draft was proposed and has been added to the model since/.test(r2.error || '') &&
      filesOf(dir) === before && fnCode(await tk('graph'), 'units_net_change') === fnCode(gBuilt, 'units_net_change'), r2);
    const old = { ...d2, items: [{ ...NET_TILE, spec: 'Closing units less opening units, as a movement.' }] };
    delete old.new_tiles; delete old.changed_tiles;
    const r3 = await attempt(() => edits.acceptTileDraft(svc, old));
    check('G: a draft saved before the record was kept never puts a placeholder over a built tile', /no longer fits the model/.test(r3.error || '') &&
      /saved before the app recorded which of its tiles were new, and units_net_change is built now/.test(r3.error || '') && filesOf(dir) === before, r3);
    // a draft that changes the tile; the tile is then written to be exactly what the draft says; accepting leaves it alone
    const spec2 = 'Closing units less opening units, for the month.';
    const p3 = await hm.propose_structure({ summary: 'Respecifies net units.', tiles: [{ ...NET_TILE, spec: spec2 }], sections: sections5 });
    const d3 = drafts[2];
    const rewritten = await edits.applyTileCode(svc, { name: 'units_net_change', code: netCode(spec2), testCode: null });
    const before3 = filesOf(dir);
    const a3 = d3 ? await attempt(() => edits.acceptTileDraft(svc, d3)) : { error: p3.text };
    const g3 = await tk('graph');
    check('G: a changed tile that already is what the draft says is left alone and stays built',
      !p3.isError && JSON.stringify(d3.changed_tiles) === '["units_net_change"]' && rewritten.ok && a3.result && a3.result.accepted &&
      a3.result.actions.some(x => x === 'Left units_net_change as it is: it already is what the draft says.') && !a3.result.actions.some(x => /Respecified/.test(x)) &&
      filesOf(dir) === before3 && g3.quantities.units_net_change.status !== 'not_built', { p3: p3.text, rewritten: rewritten.text, a3 });

    // ---- I (through a draft): a section this app cannot read with certainty is not rewritten from a guess
    fs.writeFileSync(path.join(dir, 'tilekit.toml'), tomlOf(dir).replace('title = "Charge and closing units"', 'title = """Charge and closing units"""'));
    const pr = await hm.propose_structure({ summary: 'Removes net units.', remove: ['units_net_change'] });
    const dr = drafts[3];
    const beforeR = filesOf(dir);
    const rr = dr ? await attempt(() => edits.acceptTileDraft(svc, dr)) : { error: pr.text };
    check('I: removing a tile from sections that cannot be read with certainty is refused with the reason, and nothing changes',
      !pr.isError && /The draft was not applied: a section of unit_projection in tilekit\.toml \(line \d+\) has `title` written in a way this app cannot read with certainty/.test(rr.error || '') &&
      /Nothing was changed\.$/.test(rr.error || '') && filesOf(dir) === beforeR && !fs.existsSync(path.join(dir, 'review', 'removed')), { pr: pr.text, rr });
  }

  // ---- I: tilekit.toml is spliced, not rewritten
  {
    const dir = copyModel();
    const tk = runnerFor(dir);
    const odd = oddToml(tomlOf(dir));
    const modOf = g => g.modules.find(m => m.id === 'unit_projection');
    fs.writeFileSync(path.join(dir, 'tilekit.toml'), odd);
    const g0 = modOf(await tk('graph'));
    check('I: the unusual tilekit.toml is valid: the tooling reads the quoted label, the 1_000 tolerance and four tiles in two sections',
      g0.checks[0].label === 'Units roll-forward reconciles' && g0.checks[0].tolerance === 1000 && g0.sections.map(s => s.tiles.join('+')).join('|') === 'units_allocated+units_after_alloc|units_amc+units_eop', g0);
    const read = src.tomlModules(odd).find(b => b.id === 'unit_projection');
    check('I: the scanner reads a single-quoted string, a number with an underscore, and ignores a quoted word in a comment after an array',
      read.checks[0].label === 'Units roll-forward reconciles' && read.checks[0].tolerance === 1000 && read.sections[1].title === 'Charge and closing units' &&
      read.sections[1].tiles.join() === 'units_amc,units_eop' && read.subs.every(s => s.unread.length === 0), read);
    // sections replaced: the check table is not written again
    const newSections = [{ title: 'Allocation', tiles: ['units_allocated', 'units_after_alloc'] }, { title: 'Charge', tiles: ['units_amc'] }, { title: 'Closing units', tiles: ['units_eop'] }];
    const s1 = src.setModuleLayout(odd, 'unit_projection', { sections: newSections });
    fs.writeFileSync(path.join(dir, 'tilekit.toml'), s1);
    const g1 = modOf(await tk('graph'));
    const sectionsBack = JSON.stringify(g1.sections.map(s => ({ title: s.title, tiles: s.tiles }))) === JSON.stringify(newSections);
    const outside = (text, a, b) => text.slice(0, text.indexOf(a)) + '<<>>' + text.slice(text.indexOf(b) + b.length);
    check('I: replacing only the sections leaves a single-quoted label as written (not "null"), and the tooling reads the label and the new sections back',
      s1.includes(ODD_CHECK) && !/"null"/.test(s1) && g1.checks.length === 1 && g1.checks[0].label === 'Units roll-forward reconciles' && sectionsBack, s1);
    check('I: replacing only the sections keeps `tolerance = 1_000`, and the tooling still reads 1000',
      s1.includes('\ntolerance = 1_000\n') && g1.checks[0].tolerance === 1000 && g1.checks[0].expression === g0.checks[0].expression, { s1, checks: g1.checks });
    check('I: replacing only the sections leaves every line outside the section tables byte for byte',
      outside(s1, '[[module.section]]', 'tiles = ["units_eop"]') === outside(odd, '[[module.section]]', 'before the cap'), s1);
    // checks replaced: the section tables are not written again
    const newChecks = [{ name: 'units_roll', label: 'Units roll forward', expression: 'units_bop + units_allocated - units_amc - units_eop' }];
    const s2 = src.setModuleLayout(odd, 'unit_projection', { checks: newChecks });
    fs.writeFileSync(path.join(dir, 'tilekit.toml'), s2);
    const g2 = modOf(await attempt(() => tk('graph')).then(r => r.result || { modules: [{ id: 'unit_projection', error: r.error, sections: [], checks: [] }] }));
    check('I: replacing only the checks leaves the sections byte for byte: a quoted word in a comment after `tiles = [...]` does not become a tile, and the tooling reads the same four tiles and the new check',
      s2.includes(ODD_SECTIONS) && !/"units_bonus"\]/.test(s2) && g2.sections.map(s => s.tiles.join('+')).join('|') === 'units_allocated+units_after_alloc|units_amc+units_eop' &&
      g2.sections[1].title === 'Charge and closing units' && JSON.stringify(g2.checks.map(c => ({ name: c.name, label: c.label, expression: c.expression }))) === JSON.stringify(newChecks) &&
      outside(s2, '[[module.check]]', newChecks[0].expression + '"') === outside(odd, '[[module.check]]', 'tolerance = 1_000'), { s2, g2 });
    // taking a tile out of the sections writes only the section that held it
    const s3 = src.dropTilesFromSections(odd, 'unit_projection', ['units_after_alloc']);
    check('I: taking a tile out of the sections writes only the section that held it; the other section and the check stay byte for byte',
      s3.includes('tiles = ["units_allocated"]\n') && s3.includes(ODD_SECTIONS.slice(ODD_SECTIONS.indexOf('[[module.section]]', 5))) && s3.includes(ODD_CHECK) &&
      parseToml(s3).module[0].section.map(s => s.tiles.join('+')).join('|') === 'units_allocated|units_amc+units_eop', s3);
    const unreadable = odd.replace('tiles = ["units_allocated", "units_after_alloc"]', 'tiles = ["units_allocated", "units_after_alloc", { also = "x" }]');
    const r4 = await attempt(async () => src.dropTilesFromSections(unreadable, 'unit_projection', ['units_eop']));
    check('I: a value that does not parse is refused in plain words, not guessed at', /has `tiles` written in a way this app cannot read with certainty/.test(r4.error || '') &&
      src.setModuleLayout(unreadable, 'unit_projection', { checks: newChecks }).includes('{ also = "x" }]'), r4);
  }

  // ---- H and J need sign-offs: sign the whole model off once, then work on copies of that
  const signedBase = copyModel();
  {
    const tk = runnerFor(signedBase);
    const g = await tk('graph');
    await tk('test');   // a tile's sign-off needs its test to have passed since the last change
    for (const t of g.order) await tk('signoff', ['--tile', t, '--reviewer', 'Harness']);
    for (const m of g.modules) await tk('signoff', ['--module', m.id, '--reviewer', 'Harness']);
    await tk('signoff', ['--whole-model', '--reviewer', 'Harness']);
  }
  const signedCopy = () => { const dir = path.join(TMP_ROOT, `model-${++copies}`); fs.cpSync(signedBase, dir, { recursive: true }); return dir; };
  const statesOf = st => ({ module: st.modules.unit_projection.state, model: st.model.state, tiles: ['units_allocated', 'units_after_alloc', 'units_amc', 'units_eop'].map(t => st.tiles[t].state).join() });

  // ---- H: a layout-only draft on a signed-off module asks first
  {
    const dir = signedCopy();
    const { svc, drafts, confirms, hm, tk } = ctxFor(dir, false);
    const st0 = statesOf(await tk('status'));
    check('H: the copy starts with the module, the model and the tiles signed off', st0.module === 'signed_off' && st0.model === 'signed_off' && /^(signed_off,?){4}$/.test(st0.tiles), st0);
    const sameSections = [{ title: 'Units allocated in the month', tiles: ['units_allocated', 'units_after_alloc'] }, { title: 'Charge and closing units', tiles: ['units_amc', 'units_eop'] }];
    const newSections = [{ title: 'Allocation', tiles: ['units_allocated', 'units_after_alloc'] }, { title: 'Charge and closing units', tiles: ['units_amc', 'units_eop'] }];
    await hm.propose_structure({ summary: 'The same sections.', sections: sameSections });
    const p = await hm.propose_structure({ summary: 'Renames a section.', sections: newSections });
    const [dSame, dNew] = drafts;
    const toml0 = tomlOf(dir);
    const aSame = dSame ? await attempt(() => edits.acceptTileDraft(svc, dSame)) : { error: 'no draft' };
    check('H: a layout draft that gives the sections the module already has does not ask and changes no sign-off',
      aSame.result && aSame.result.accepted && confirms.length === 0 && tomlOf(dir) === toml0 && JSON.stringify(statesOf(await tk('status'))) === JSON.stringify(st0), { aSame, confirms });
    const declined = dNew ? await attempt(() => edits.acceptTileDraft(svc, dNew)) : { error: p.text };
    const st1 = statesOf(await tk('status'));
    check('H: a layout-only draft on a signed-off module asks first, naming the module and model sign-offs',
      confirms.length === 1 && confirms[0].message === 'This changes the sections of unit_projection, which are part of what was signed off, so the module sign-off of `unit_projection` and the model sign-off will need to be given again. Accept the draft anyway?', confirms);
    check('H: declining leaves tilekit.toml and every sign-off as they were',
      declined.result && declined.result.accepted === false && declined.result.actions[0] === 'Did not accept the draft: the sign-offs were kept.' && tomlOf(dir) === toml0 &&
      JSON.stringify(st1) === JSON.stringify(st0), { declined, st1 });
    const yes = ctxFor(dir, true);
    const accepted = dNew ? await attempt(() => edits.acceptTileDraft(yes.svc, dNew)) : { error: p.text };
    const st2 = statesOf(await tk('status'));
    check('H: accepting after the question writes the sections; the module and model sign-offs then need giving again and the tile sign-offs are kept',
      accepted.result && accepted.result.accepted && yes.confirms.length === 1 && /title = "Allocation"/.test(tomlOf(dir)) &&
      st2.module !== 'signed_off' && st2.model !== 'signed_off' && st2.tiles === st0.tiles, { accepted, st2 });
    // only the checks, with only the model sign-off left to lose
    const p5 = await yes.hm.propose_structure({ summary: 'Renames the check.', checks: [{ name: 'units_roll', label: 'Units roll forward', expression: 'units_bop + units_allocated - units_amc - units_eop' }] });
    const fakeModel = (cmd, args) => tk(cmd, args).then(r => (cmd === 'status' ? { ...r, model: { ...r.model, state: 'signed_off' } } : r));
    const no = ctxFor(dir, false);
    const toml5 = tomlOf(dir);
    const d5 = yes.drafts[0];
    const a5 = d5 ? await attempt(() => edits.acceptTileDraft({ ...no.svc, tilekit: fakeModel }, d5)) : { error: p5.text };
    check('H: a checks-only draft names only the sign-offs that are there to lose',
      no.confirms.length === 1 && no.confirms[0].message === 'This changes the reconciliation checks of unit_projection, which are part of what was signed off, so the model sign-off will need to be given again. Accept the draft anyway?' &&
      a5.result && a5.result.accepted === false && tomlOf(dir) === toml5, { a5, confirms: no.confirms });
  }

  // ---- J: removing a tile leaves every other tile's text alone
  {
    const synthetic = 'import numpy as np\n\n\ndef a(x):\n    """A.\n\n\n\n    More.\n    """\n    return x\n\n\ndef b(x):\n    return x\n\n\ndef c(x):\n    return x\n';
    const cut = src.removeFunction(synthetic, { line: 14, code: 'def b(x):\n    return x' });
    const cutLast = src.removeFunction(synthetic, { line: 18, code: 'def c(x):\n    return x' });
    check('J: cutting a function out tidies blank lines only where it stood (two between its neighbours, one newline at the end of the file)',
      cut === synthetic.replace('def b(x):\n    return x\n\n\n', '') && cutLast === synthetic.replace('\n\n\ndef c(x):\n    return x\n', '\n'), { cut, cutLast });

    const dir = signedCopy();
    const { svc, drafts, hm, tk } = ctxFor(dir, true);
    // a neighbour whose docstring has three blank lines in a row, signed off as it is
    const uf = unitsFile(dir);
    const marker = '"""Units after allocation.\n';
    fs.writeFileSync(uf, fs.readFileSync(uf, 'utf8').replace(marker, marker + '\n\n'));
    await tk('build', ['--tile', 'units_after_alloc']);
    await tk('test', ['--file', 'tests/tiles/test_units_after_alloc.py']);
    await tk('signoff', ['--tile', 'units_after_alloc', '--reviewer', 'Harness']);
    const stampOf = () => JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'review', 'tiles', 'units_after_alloc', 'signoff.json'), 'utf8')).stamp);
    const pa = await hm.propose_structure({ summary: 'Adds net units.', tiles: [NET_TILE], sections: UNIT_SECTIONS });
    const fileBeforeAdd = fs.readFileSync(uf, 'utf8');
    const added = drafts[0] ? await attempt(() => edits.acceptTileDraft(svc, drafts[0])) : { error: pa.text };
    const g0 = await tk('graph');
    const st0 = await tk('status');
    const stamp0 = stampOf();
    check('J: the neighbour has three blank lines in a row in its docstring and is signed off before the removal',
      added.result && added.result.accepted && /"""Units after allocation\.\n\n\n\n/.test(fnCode(g0, 'units_after_alloc')) && st0.tiles.units_after_alloc.state === 'signed_off' && !!g0.quantities.units_net_change,
      { pa: pa.text, added, state: st0.tiles.units_after_alloc.state });
    const pr = await hm.propose_structure({ summary: 'Removes net units.', remove: ['units_net_change'] });
    const removed = drafts[1] ? await attempt(() => edits.acceptTileDraft(svc, drafts[1])) : { error: pr.text };
    const g1 = await tk('graph');
    const st1 = await tk('status');
    const others = Object.keys(g0.quantities).filter(n => g0.quantities[n].kind === 'tile' && n !== 'units_net_change');
    check('J: after a tile is removed, every other tile\'s source text is byte-identical',
      removed.result && removed.result.accepted && !g1.quantities.units_net_change && others.every(n => fnCode(g1, n) === fnCode(g0, n)) &&
      fs.readFileSync(uf, 'utf8') === fileBeforeAdd, { pr: pr.text, removed, changed: others.filter(n => fnCode(g1, n) !== fnCode(g0, n)) });
    check('J: the neighbour\'s sign-off does not go stale: same state, no drift, same stored stamp',
      st1.tiles.units_after_alloc.state === 'signed_off' && st1.tiles.units_after_alloc.drift === st0.tiles.units_after_alloc.drift && !st1.tiles.units_after_alloc.drift && stampOf() === stamp0,
      { state: st1.tiles.units_after_alloc.state, drift: st1.tiles.units_after_alloc.drift });
  }
}

// A tilekit runner that records every command (to prove the tools never run signoff or reconfirm).
function recording(tk) {
  const calls = [];
  const run = (command, args = []) => { calls.push(command); return tk(command, args); };
  run.calls = calls;
  return run;
}

function serviceFor(dir, { confirmAnswer = true } = {}) {
  const events = [];
  const confirms = [];
  const raw = runnerFor(dir);
  const tilekit = recording(raw);
  const service = createAgentService({ modelDir: dir, repoRoot: REPO, tilekit, emit: e => events.push(e),
    confirm: async req => { confirms.push(req); return confirmAnswer; }, runPytest: null });
  return { dir, events, confirms, tilekit, raw, service };
}

const lastOf = (events, type) => events.filter(x => x.type === type).pop();
const draftIdOf = text => (String(text).match(/draft (d\d{14}-[0-9a-f]{6})/) || [])[1];

async function gitChecks(check) {
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Harness', GIT_AUTHOR_EMAIL: 'h@example.com', GIT_COMMITTER_NAME: 'Harness', GIT_COMMITTER_EMAIL: 'h@example.com' });
  const G = (cwd, ...a) => require('child_process').execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  const remoteLog = bare => { try { return G(bare, 'log', 'main', '--format=%s').split('\n').filter(Boolean); } catch { return []; } };
  const dir = copyModel();
  const e = serviceFor(dir);
  const h = e.service.handlersFor({ level: 'model', id: 'model' });
  // not a repository: nothing to read, commit or push, and nothing is created
  const s0 = await h.git_status(), c0 = await h.commit({ message: 'x' }), p0 = await h.request_push();
  check('git tools on a folder that is not a repository refuse and create nothing', s0.isError && c0.isError && p0.isError && !fs.existsSync(path.join(dir, '.git')), [s0.text, c0.text, p0.text]);
  // a model folder inside a bigger repository is not a repository of its own: never commit the parent's files
  const parent = path.join(TMP_ROOT, `parent-${++copies}`); fs.mkdirSync(parent); G(parent, 'init', '-b', 'main');
  const inner = path.join(parent, 'inner'); fs.cpSync(dir, inner, { recursive: true });
  const ei = serviceFor(inner), ri = await ei.service.handlersFor({ level: 'model', id: 'model' }).commit({ message: 'x' });
  check('commit refuses a model folder that sits inside a bigger repository and commits nothing', ri.isError && /not a git repository of its own/.test(ri.text) && G(parent, 'status', '--porcelain') !== '' && !/./.test((() => { try { return G(parent, 'log', '-1'); } catch { return ''; } })()), ri.text);
  // a repository with a local bare remote
  const bare = path.join(TMP_ROOT, `remote-${copies}.git`); fs.mkdirSync(bare); G(bare, 'init', '--bare', '-b', 'main');
  G(dir, 'init', '-b', 'main'); G(dir, 'remote', 'add', 'origin', bare); G(dir, 'add', '-A'); G(dir, 'commit', '-m', 'Start'); G(dir, 'push', '-u', 'origin', 'main');
  const s1 = await h.git_status();
  check('git_status reads branch, remote and "No changed files"', !s1.isError && /Branch: main/.test(s1.text) && /No changed files/.test(s1.text) && s1.text.includes(bare), s1.text);
  fs.appendFileSync(path.join(dir, 'cases', 'base.json'), '\n'); fs.mkdirSync(path.join(dir, 'real-data'), { recursive: true }); fs.writeFileSync(path.join(dir, 'real-data', 'x.csv'), 'x');
  const s2 = await h.git_status();
  check('git_status lists changed files and respects .gitignore', /Changed files \(1\)/.test(s2.text) && /modified: cases\/base\.json/.test(s2.text) && !/real-data/.test(s2.text), s2.text);
  check('commit needs a message', (await h.commit({})).isError && (await h.commit({ message: '  ' })).isError && G(dir, 'log', '--format=%s').split('\n').length === 1);
  const c1 = await h.commit({ message: 'Touch the base case' });
  check('commit commits locally, returns what was committed and does not push', !c1.isError && /Committed 1 file/.test(c1.text) && /cases\/base\.json/.test(c1.text) && G(dir, 'log', '-1', '--format=%s') === 'Touch the base case' && !remoteLog(bare).includes('Touch the base case') &&
    e.events.some(x => x.type === 'action' && /^Committed 1 file/.test(x.text)), c1.text);
  check('commit with nothing changed is refused', (await h.commit({ message: 'again' })).isError);
  // push requests
  const r1 = await h.request_push();
  const ev1 = lastOf(e.events, 'push_request');
  check('request_push emits a push_request event: branch, remote and the commits not pushed', !r1.isError && ev1 && ev1.request.branch === 'main' && ev1.request.remote === bare && ev1.request.commits.length === 1 && ev1.request.commits[0].subject === 'Touch the base case' && !!ev1.request.commits[0].hash && ev1.scope.level === 'model', ev1);
  check('request_push saves it pending, pushes nothing and tells the model so', storeMod.loadRequest(dir, ev1.request.id).status === 'pending' && !remoteLog(bare).includes('Touch the base case') && /Nothing is pushed/.test(r1.text), r1.text);
  await h.request_push();
  const ev2 = lastOf(e.events, 'push_request').request;
  check('a new push request supersedes the pending one', storeMod.loadRequest(dir, ev1.request.id).status === 'superseded' && ev2.id !== ev1.request.id);
  const dsg = await e.service.confirmSignoff(ev2.id, {}).then(() => 'ran', er => er.message);
  check('a push request cannot be confirmed as a sign-off', /push request/.test(dsg), dsg);
  const d = e.service.declinePush(ev2.id);
  check('declinePush marks it declined, says Not pushed. and pushes nothing', d.declined && storeMod.loadRequest(dir, ev2.id).status === 'declined' && e.events.some(x => x.type === 'action' && x.text === 'Not pushed.') && !remoteLog(bare).includes('Touch the base case'));
  const again = await e.service.confirmPush(ev2.id);
  check('a declined request cannot be confirmed', !again.pushed && /already declined/.test(again.error) && !remoteLog(bare).includes('Touch the base case'), again);
  await h.request_push();
  const ev3 = lastOf(e.events, 'push_request').request;
  const cp = await e.service.confirmPush(ev3.id);
  check('confirmPush pushes the branch: the commit is in the remote, the request is confirmed, the action line says where', cp.pushed && remoteLog(bare)[0] === 'Touch the base case' && storeMod.loadRequest(dir, ev3.id).status === 'confirmed' && e.events.some(x => x.type === 'action' && x.text === 'Pushed to origin/main.'), cp);
  check('a request cannot be confirmed twice', !(await e.service.confirmPush(ev3.id)).pushed);
  check('request_push with nothing to push is refused', (await h.request_push()).isError);
  // the branch changed after the request: refused, expired, nothing pushed
  fs.appendFileSync(path.join(dir, 'cases', 'base.json'), '\n'); await h.commit({ message: 'Second touch' });
  await h.request_push(); const ev4 = lastOf(e.events, 'push_request').request;
  G(dir, 'checkout', '-b', 'other');
  const stale = await e.service.confirmPush(ev4.id);
  check('confirmPush refuses when the branch changed since the request', !stale.pushed && /changed since/.test(stale.error) && storeMod.loadRequest(dir, ev4.id).status === 'expired' && !remoteLog(bare).includes('Second touch'), stale);
  const requests = e.service.requests().filter(r => r.kind === 'push');
  check('requests() lists the push requests with their status', requests.length === 4 && requests.every(r => r.branch && r.status), requests.map(r => r.status));
  const toolSrc = ['tools.js', 'edits.js', 'scaffold.js', 'validate.js', 'source.js', 'prompt.js'].map(f => fs.readFileSync(path.join(__dirname, '..', 'src', 'agent', f), 'utf8')).join('\n');
  check('tool code can reach no push: it names neither git push, confirmPush nor the git module', !/confirmPush|declinePush|git\.push|svc\.git\.push|require\('\.\.\/git'\)|'push', '-u'/.test(toolSrc));
  check('the prompt tells the model to commit only when asked and that a push is the user\'s button', /Commit only when the user asked/.test(require('../src/agent/prompt').systemPrompt()) && /only their click pushes/.test(require('../src/agent/prompt').systemPrompt()));
}

async function chatChecks(check) {
  const dir = copyModel();
  const e = serviceFor(dir);
  const tileScope = { level: 'tile', id: 'units_amc' };
  const modScope = { level: 'module', id: 'unit_projection' };
  const modelScope = { level: 'model', id: 'model' };
  const ht = e.service.handlersFor(tileScope);
  const hm = e.service.handlersFor(modScope);
  const hmodel = e.service.handlersFor(modelScope);

  // Migration: an old per-scope log with a session is readable, but is not resumed.
  storeMod.appendLog(dir, { level: 'tile', id: 'units_eop' }, { type: 'session', session_id: 'old-session', at: storeMod.now() });
  storeMod.appendLog(dir, { level: 'tile', id: 'units_eop' }, { scope: { level: 'tile', id: 'units_eop' }, type: 'user', text: 'old question', at: storeMod.now() });
  check('old per-scope logs stay readable', e.service.history({ level: 'tile', id: 'units_eop' }).some(x => x.text === 'old question'));

  // Every event is filed in the audit trail of its selection, and nowhere else.
  await e.service.handlersFor(tileScope).get_selection();
  await e.service.handlersFor(modScope).get_selection();
  const tileLog = storeMod.readLog(dir, tileScope);
  const modLog = storeMod.readLog(dir, modScope);
  check('each event is also filed in its scope log', tileLog.some(x => /^Read units_amc, its neighbours/.test(x.text)) && !tileLog.some(x => /^Read module unit_projection/.test(x.text)) &&
    modLog.some(x => /^Read module unit_projection/.test(x.text)));
  const onlyTile = e.service.history(tileScope);
  check('history(scope) is one selection\'s audit trail', onlyTile.length === 1 && onlyTile[0].scope.level === 'tile' && /^Read units_amc/.test(onlyTile[0].text), onlyTile);
  check('no transcript is kept: nothing writes review/model/chat.jsonl or review/model/chats', !fs.existsSync(path.join(dir, 'review', 'model', 'chat.jsonl')) && !fs.existsSync(path.join(dir, 'review', 'model', 'chats')) &&
    storeMod.chatPath === undefined && storeMod.listChats === undefined && storeMod.archiveChat === undefined && typeof e.service.conversations === 'undefined' && typeof e.service.newConversation === 'undefined');

  // Reading ranges over the model from any level.
  const other = await ht.get_selection({ module: 'profit' });
  check('get_selection reads another module from tile level', !other.isError && /pv_net_profit/.test(other.text) && /read only/.test(other.text), other.text.slice(0, 200));
  const ov = await ht.model_overview();
  const ovDoc = JSON.parse(ov.text);
  check('model_overview has counts, modules with tile states, and cases', ovDoc.counts.tiles.total === 26 && ovDoc.modules.length === 5 &&
    ovDoc.modules.every(m => m.tiles.every(t => t.state)) && ovDoc.cases.length >= 1 && Array.isArray(ovDoc.model.blockers), Object.keys(ovDoc));

  // Sign-off requests.
  const refused = await ht.request_signoff({ kind: 'tile', name: 'units_eop' });
  check('request_signoff refuses a tile that is not the selection', refused.isError && !fs.existsSync(path.join(dir, 'review', 'requests')), refused.text);
  const r1 = await ht.request_signoff({ kind: 'tile', name: 'units_amc' });
  const ev1 = lastOf(e.events, 'signoff_request');
  const req1 = ev1 && ev1.request;
  check('request_signoff emits a signoff_request event with the request', !r1.isError && req1 && req1.kind === 'tile' && req1.name === 'units_amc' &&
    req1.label === 'AMC units' && /MIN/.test(req1.formula) && req1.assumed.length >= 1 && req1.cases.length >= 5 && req1.cases.every(c => 'pass' in c) &&
    Array.isArray(req1.blockers) && req1.values_only === false && ev1.scope.id === 'units_amc', { ev1, text: r1.text });
  check('the request is saved pending under review/requests', storeMod.loadRequest(dir, req1.id).status === 'pending');
  check('the tool result says it is not signed off', /not signed off/.test(r1.text) && /button/.test(r1.text), r1.text);
  check('nothing is signed off by the request', (await e.raw('status')).tiles.units_amc.state !== 'signed_off');
  const c1 = await e.service.confirmSignoff(req1.id, { reviewer: 'Harness', comment: 'Checked the cap.' });
  const st1 = await e.raw('status');
  check('confirmSignoff records the sign-off', c1.signed && st1.tiles.units_amc.state === 'signed_off' && st1.tiles.units_amc.signed_off.reviewer === 'Harness', c1);
  check('confirmSignoff emits the action line and done', e.events.some(x => x.type === 'action' && x.text === 'Signed off units_amc as Harness.') && e.events[e.events.length - 1].type === 'done');
  check('the request is marked confirmed', storeMod.loadRequest(dir, req1.id).status === 'confirmed');
  const again = await e.service.confirmSignoff(req1.id, { reviewer: 'Harness' });
  check('a request cannot be confirmed twice', !again.signed && /already confirmed/.test(again.error), again);

  // Stamp changed since the request.
  await hm.request_signoff({ kind: 'tile', name: 'units_after_alloc' });
  const req2 = lastOf(e.events, 'signoff_request').request;
  const uf = unitsFile(dir);
  fs.writeFileSync(uf, fs.readFileSync(uf, 'utf8').replace('"""Units after allocation.', '"""Units after allocation.\n\n    Changed after the request.'));
  const c2 = await e.service.confirmSignoff(req2.id, { reviewer: 'Harness' });
  check('confirmSignoff refuses when the item changed since the request', !c2.signed && /changed since/.test(c2.error) &&
    (await e.raw('status')).tiles.units_after_alloc.state !== 'signed_off' && storeMod.loadRequest(dir, req2.id).status === 'expired', c2);

  // Blockers at confirm time.
  await hm.request_signoff({ kind: 'module', name: 'unit_projection' });
  const req3 = lastOf(e.events, 'signoff_request').request;
  check('a request with blockers is still shown, listing them', req3.blockers.length > 0, req3);
  const c3 = await e.service.confirmSignoff(req3.id, { reviewer: 'Harness' });
  check('confirmSignoff refuses while blockers exist', !c3.signed && /cannot be signed off/.test(c3.error) && (await e.raw('status')).modules.unit_projection.state !== 'signed_off', c3);

  // Decline.
  await hmodel.request_signoff({ kind: 'tile', name: 'units_eop' });
  const req4 = lastOf(e.events, 'signoff_request').request;
  const d4 = e.service.declineSignoff(req4.id);
  check('declineSignoff marks it declined and says Not signed.', d4.declined && storeMod.loadRequest(dir, req4.id).status === 'declined' &&
    e.events.some(x => x.type === 'action' && x.text === 'Not signed.') && (await e.raw('status')).tiles.units_eop.state !== 'signed_off');
  const listed = e.service.requests();
  check('requests() lists every request with its status', listed.length === 4 && listed.some(r => r.status === 'declined') && listed.some(r => r.status === 'confirmed'), listed.map(r => r.status));

  // Re-confirmation of values-only drift: restore units.py, sign units_eop off, change a parameter default, rebuild.
  await e.raw('build', ['--tile', 'units_after_alloc']);
  await e.raw('build', ['--tile', 'units_eop']);
  await e.raw('test', ['--file', 'tests/tiles/test_units_eop.py']);   // a tile's sign-off needs its test to have passed since the last change
  await e.raw('signoff', ['--tile', 'units_eop', '--reviewer', 'Harness']);
  const pf = path.join(dir, 'src', 'unit_linked', 'params.py');
  fs.writeFileSync(pf, fs.readFileSync(pf, 'utf8').replace('_param(1.25, "Initial unit price"', '_param(1.3, "Initial unit price"'));
  const rb = await hm.rebuild({});
  check('rebuild at module level rebuilds stale tiles, the module and the model workbook', !rb.isError && /Rebuilt/.test(rb.text) && /every difference is zero/.test(rb.text), rb.text);
  const rbOut = await hm.rebuild({ kind: 'tile', name: 'deaths' });
  check('rebuild refuses an item outside the selection', rbOut.isError, rbOut.text);
  const rrEarly = await hm.request_reconfirm({});
  check('request_reconfirm renews nothing until the tests have been run on the changed model, and says so', !rrEarly.isError && /nothing to re-confirm/.test(rrEarly.text) && /has not been run since the last change/.test(rrEarly.text) && (await e.raw('status')).tiles.units_eop.state === 'stale', rrEarly.text);
  await e.raw('test');   // as the reviewer does with Run tests (the app's bulk re-confirm runs them itself)
  const rr = await hm.request_reconfirm({});
  const req5 = lastOf(e.events, 'signoff_request').request;
  check('request_reconfirm lists the tiles it would renew', !rr.isError && req5.kind === 'reconfirm' && req5.tiles.map(t => t.name).includes('units_amc') && req5.tiles.map(t => t.name).includes('units_eop'), { text: rr.text, req5 });
  check('nothing is re-confirmed by the request', (await e.raw('status')).tiles.units_amc.state === 'stale');
  const c5 = await e.service.confirmSignoff(req5.id, { reviewer: 'Harness' });
  const st5 = await e.raw('status');
  check('confirmSignoff on a re-confirmation runs tilekit reconfirm', c5.signed && /Re-confirmed/.test(c5.text) && st5.tiles.units_amc.state === 'signed_off' && st5.tiles.units_eop.state === 'signed_off', c5);
  const rt = await ht.request_reconfirm({});
  check('request_reconfirm is refused at tile level', rt.isError);

  // No tool can sign off: the tools' tilekit refuses signoff/reconfirm, and no tool name reaches confirmSignoff.
  check('no tool is a sign-off or confirmation', TOOL_NAMES.every(n => !/confirm_?signoff|^signoff|decline|^reconfirm/.test(n)) &&
    TOOL_NAMES.filter(n => /signoff|reconfirm/.test(n)).every(n => n.startsWith('request_')), TOOL_NAMES);
  const callsBefore = e.tilekit.calls.length;
  const statesOf = async () => JSON.stringify(Object.fromEntries(Object.entries((await e.raw('status')).tiles).map(([k, x]) => [k, x.state])));
  const signedBefore = await statesOf();
  const toolArgs = { request_signoff: { kind: 'tile', name: 'units_allocated' }, request_reconfirm: {}, rebuild: { kind: 'tile', name: 'units_amc' },
    read_trace: { case: 'base', quantities: ['units_amc'] }, write_tile: { name: 'units_amc', code: 'x', test_code: '' }, what_if: {},
    propose_params: { params: [] }, propose_cases: { cases: [] }, propose_inputs: {}, propose_structure: {} };
  for (const scope of [tileScope, modScope, modelScope]) {
    const h = e.service.handlersFor(scope);
    for (const name of TOOL_NAMES) {
      const args = name in toolArgs ? toolArgs[name] : {};
      try { await h[name](args); } catch { /* refusals are fine */ }
    }
  }
  const used = e.tilekit.calls.slice(callsBefore);
  check('calling every tool at every level never runs signoff or reconfirm', !used.includes('signoff') && !used.includes('reconfirm') && (await statesOf()) === signedBefore, { used: [...new Set(used)] });
  const toolSrc = ['tools.js', 'edits.js', 'scaffold.js', 'validate.js', 'source.js', 'prompt.js'].map(f => fs.readFileSync(path.join(__dirname, '..', 'src', 'agent', f), 'utf8')).join('\n');
  check('tool code never names the signoff or reconfirm command', !/tk\(\s*'(signoff|reconfirm)'|tilekit\(\s*'(signoff|reconfirm)'|performRequest|confirmSignoff/.test(toolSrc));
  // Superseded: a second request for the same item replaces the first.
  await ht.request_signoff({ kind: 'tile', name: 'units_amc' });
  const s1 = lastOf(e.events, 'signoff_request').request;
  await ht.request_signoff({ kind: 'tile', name: 'units_amc' });
  check('a new request for the same item supersedes the pending one', storeMod.loadRequest(dir, s1.id).status === 'superseded');

  // Scaffolding drafts: parameters.
  const bad = await hmodel.propose_params({ summary: 'x', params: [{ name: 'Bad Name', default: 1, label: 'x', format: 'amount', units: 'u' },
    { name: 'amc_cap_units', default: Infinity, label: '', format: 'nope', units: '' }, { name: 'premium', default: 1, label: 'P', format: 'amount', units: 'u' }] });
  check('propose_params validates names, defaults, formats and clashes', bad.isError && /snake_case/.test(bad.text) && /finite/.test(bad.text) && /format 'nope'/.test(bad.text) && /already exists as a input/.test(bad.text), bad.text);
  const okp = await hmodel.propose_params({ summary: 'Adds a policy fee and raises expenses.', params: [
    { name: 'policy_fee_pm', default: 1.5, label: 'Policy fee per month', format: 'amount', units: 'currency per policy per month' },
    { name: 'expense_pm', default: 2.5, label: 'Maintenance expense per month', format: 'amount', units: 'currency per policy per month' }] });
  const paramsBefore = fs.readFileSync(pf, 'utf8');
  check('a valid params draft is saved and changes nothing yet', !okp.isError && draftIdOf(okp.text) && fs.readFileSync(pf, 'utf8') === paramsBefore, okp.text);
  const ap = await e.service.acceptDraft(draftIdOf(okp.text));
  const gp = await e.raw('graph');
  check('accepting the params draft edits params.py and the model loads', ap.accepted && gp.quantities.policy_fee_pm && gp.quantities.policy_fee_pm.value === 1.5 &&
    gp.quantities.expense_pm.value === 2.5 && gp.quantities.policy_fee_pm.label === 'Policy fee per month', ap);
  check('accepting asks first when sign-offs would need re-confirming', e.confirms.some(c => /re-confirming/.test(c.message)));
  check('accepting rebuilds the stale workbooks and says so', ap.actions.some(a => /^Rebuilt/.test(a)), ap.actions);
  check('the check is still clean after the params draft', ((await e.raw('check')).counts.error) === 0);

  // Inputs: restore on failure, then a valid one.
  const inputsPy = path.join(dir, 'src', 'unit_linked', 'inputs.py');
  const tomlPath = path.join(dir, 'tilekit.toml');
  const [inBefore, tomlBefore] = [fs.readFileSync(inputsPy, 'utf8'), fs.readFileSync(tomlPath, 'utf8')];
  const broken = await hmodel.propose_inputs({ summary: 'Broken.', inputs: [{ name: 'broken_series', label: 'Broken', format: 'amount', description: 'Fails at run time.', python: 'broken_series = month * no_such_name' }] });
  const logic = await hmodel.propose_inputs({ summary: 'Logic.', inputs: [{ name: 'mort_rate_pm2', label: 'Monthly mortality', format: 'rate', description: 'Converted from annual.', python: 'mort_rate_pm2 = -monthly_rate_from_annual(-params.mort_rate_pa, params.months_per_year)' }] });
  check('an input series with model logic in it is refused and pointed to a tile', logic.isError && /model logic, not data/.test(logic.text) && /tile/.test(logic.text), logic.text);
  const ab = await e.service.acceptDraft(draftIdOf(broken.text));
  check('an inputs draft that breaks the model is restored', !ab.accepted && /restored/.test(ab.actions.join(' ')) &&
    fs.readFileSync(inputsPy, 'utf8') === inBefore && fs.readFileSync(tomlPath, 'utf8') === tomlBefore, ab.actions);
  const badIn = await hmodel.propose_inputs({ summary: 'x', inputs: [{ name: 'premium', label: 'P', format: 'amount', description: 'd', python: 'premium = 1' },
    { name: 'no_assign', label: 'N', format: 'amount', description: 'd', python: 'x = 1' }, { name: 'sneaky', label: 'S', format: 'amount', description: 'd', python: 'import os\nsneaky = 1' }] });
  check('propose_inputs validates names and code', badIn.isError && /already exists/.test(badIn.text) && /must assign no_assign/.test(badIn.text) && /plain assignments/.test(badIn.text), badIn.text);
  const goodIn = await hmodel.propose_inputs({ summary: 'Adds a policy term.', model_point_fields: [{ name: 'term_months', label: 'Policy term in months', format: 'integer', example: 120 }],
    inputs: [{ name: 'months_left', label: 'Months left', format: 'integer', description: 'the months left in the policy term after this month',
      python: 'months_left = term_months - month' }],
    tables: [{ name: 'fee_scale', label: 'Fee scale', columns: ['year', 'scale'], rows: [[1, 1.0], [2, 1.1]], formats: { year: 'integer', scale: 'number' } }] });
  const ai = await e.service.acceptDraft(draftIdOf(goodIn.text));
  const gi = await e.raw('graph');
  const tr = await e.raw('trace', ['--case', 'base']);
  check('accepting an inputs draft edits inputs.py, tilekit.toml, cases and adds the table', ai.accepted && gi.quantities.months_left && gi.quantities.months_left.kind === 'input' &&
    gi.tables.some(t => t.name === 'fee_scale') && tr.series.months_left[0] === 119 && JSON.parse(fs.readFileSync(path.join(dir, 'cases', 'base.json'), 'utf8')).model_point.term_months === 120 &&
    /months_left: the months left in the policy term/.test(fs.readFileSync(inputsPy, 'utf8')), { ai, text: goodIn.text });

  // Cases.
  const badCase = await hmodel.propose_cases({ summary: 'x', cases: [{ id: 'short', name: 'Short', purpose: 'p', model_point: { premium_pm: 100 } }] });
  check('propose_cases needs every model-point field', badCase.isError && /missing model-point fields/.test(badCase.text), badCase.text);
  const base = JSON.parse(fs.readFileSync(path.join(dir, 'cases', 'base.json'), 'utf8'));
  const goodCase = await hmodel.propose_cases({ summary: 'A short term.', cases: [{ id: 'short_term', name: 'Short term', purpose: 'Term ends in month 24, so months_left goes below zero.', model_point: { ...base.model_point, term_months: 24 }, params: { policy_fee_pm: 2 } }] });
  const ac = await e.service.acceptDraft(draftIdOf(goodCase.text));
  check('accepting a cases draft writes the case and it runs', ac.accepted && (await e.raw('cases')).cases.some(c => c.id === 'short_term'), { ac, text: goodCase.text });

  // A missing parameter is proposed from whatever is selected: the draft, which the user accepts or discards, is the request.
  const after = await e.service.handlersFor(tileScope).propose_params({ summary: 'Adds a fee.', params: [{ name: 'admin_fee_pm', default: 1, label: 'Admin fee per month', format: 'amount', units: 'currency per policy per month' }] });
  check('a params draft can be proposed from tile level (the draft is the request)', !after.isError && draftIdOf(after.text) && storeMod.loadDraft(dir, draftIdOf(after.text)).scope.level === 'tile' && !/admin_fee_pm/.test(fs.readFileSync(path.join(dir, 'src', 'unit_linked', 'params.py'), 'utf8')), after.text);
  check('the two tools of the old built-in chat do not exist', !TOOL_NAMES.includes('ask_user') && !TOOL_NAMES.includes('add_input_request') && e.service.handlersFor(tileScope).ask_user === undefined && e.service.handlersFor(tileScope).add_input_request === undefined &&
    !/ask_user|add_input_request/.test(require('../src/agent/prompt').systemPrompt({ modelDir: dir }) + JSON.stringify(await e.service.cliTools())), TOOL_NAMES);

  // Model-level tile draft names its module; accepting rebuilds the module and model workbooks.
  const md = await hmodel.propose_structure({ summary: 'Adds net units.', module: 'unit_projection', sections: UNIT_SECTIONS, tiles: [
    { name: 'units_net_change', label: 'Change in units', args: ['units_eop', 'units_bop'], units: 'units per policy', timing: 'during month', format: 'units', spec: 'Closing units less opening units.' }] });
  const am = await e.service.acceptDraft(draftIdOf(md.text));
  check('a tile draft made at model level is accepted into its module, with rebuilds reported', am.accepted &&
    (await e.raw('graph')).quantities.units_net_change.module === 'unit_projection' && am.actions.some(a => /Rebuilt the unit_projection module workbook and the model workbook/.test(a)), am.actions);

  // write_tile reports the module and model rebuild.
  const hw = e.service.handlersFor({ level: 'tile', id: 'units_after_alloc' });
  const gw = await e.raw('graph');
  const code = gw.quantities.units_after_alloc.source.code.replace('Changed after the request.', 'Changed again by write_tile.');
  const w = await hw.write_tile({ name: 'units_after_alloc', code, test_code: '' });
  check('write_tile also rebuilds the module and model workbooks and says whether every difference is zero',
    !w.isError && e.events.some(x => x.type === 'action' && /^Rebuilt the unit_projection module workbook and the model workbook: every difference is zero/.test(x.text)), w.text);
}

async function freshModelChecks(check) {
  const dir = path.join(TMP_ROOT, `fresh-${++copies}`);
  const tk = runnerFor(dir);
  const init = await tk('init', ['--name', 'Level term assurance', '--package', `level_term_${copies}`]);
  check('tilekit init creates the model', /^level_term_/.test(init.package) && fs.existsSync(path.join(dir, 'tilekit.toml')), init);
  const e = serviceFor(dir);
  const h = e.service.handlersFor({ level: 'model', id: 'model' });
  const ov = JSON.parse((await h.model_overview()).text);
  check('model_overview works on an empty model', ov.modules.length === 0 && ov.counts.tiles.total === 0, ov);
  const md = await h.propose_structure({ summary: 'Policy and results blocks.', modules: [
    { id: 'policy', title: 'Policy', layer: 'Liability', purpose: 'In force, premiums and death benefits.', feeds: ['results'] },
    { id: 'results', title: 'Results', layer: 'Results', purpose: 'Present values and profit.', feeds: [] }] });
  const am = await e.service.acceptDraft(draftIdOf(md.text));
  const pd = await h.propose_params({ summary: 'Basis.', params: [
    { name: 'mortality_rate_pa', default: 0.002, label: 'Mortality rate per year', format: 'rate', units: 'proportion per year' },
    { name: 'lapse_rate_pa', default: 0.05, label: 'Lapse rate per year', format: 'percent', units: 'proportion per year' }] });
  const ap = await e.service.acceptDraft(draftIdOf(pd.text));
  const g = await tk('graph');
  const chk = await tk('check');
  check('on a fresh model, accepting a module draft and a params draft leaves a model that passes check', am.accepted && ap.accepted &&
    g.modules.length === 2 && g.quantities.mortality_rate_pa && chk.counts.error === 0, { am: am.actions, ap: ap.actions, chk: chk.counts });
  const ind = await h.propose_inputs({ summary: 'Sum assured and premium.', model_point_fields: [{ name: 'sum_assured', label: 'Sum assured', format: 'amount', example: 100000 }, { name: 'premium_pm', label: 'Monthly premium', format: 'amount', example: 20 }],
    inputs: [{ name: 'sum_assured', label: 'Sum assured', format: 'amount', description: 'the model-point sum assured in every month' },
      { name: 'policy_year', label: 'Policy year', format: 'integer', description: 'the policy year of the month: 1 for months 1 to 12, then 2, and so on',
        python: 'policy_year = np.floor((month - 1) / params.months_per_year) + 1' }] });
  const ai = await e.service.acceptDraft(draftIdOf(ind.text));
  const tr = await tk('trace', ['--case', 'base']);
  check('on a fresh model, an inputs draft with a model-point field and an excel template applies', ai.accepted && tr.series.sum_assured[0] === 100000 &&
    tr.series.policy_year[0] === 1 && tr.series.policy_year[12] === 2, { ai: ai.actions, ind: ind.text });
}

// ---------------------------------------------------------------- the design stage

function miniDesign(layers) {
  const liab = layers.includes('Liability') ? 'Liability' : layers[0], res = layers.includes('Results') ? 'Results' : layers[layers.length - 1];
  return {
    summary: 'A deferred annuity account projected monthly.', order_in_month: ['Premium', 'Interest', 'Deaths'], results: ['pv_net_cashflow'],
    modules: [
      { id: 'account_value', title: 'Account value', layer: liab, purpose: 'What one policy is worth each month.', tiles: [
        { name: 'credited_rate_pa', label: 'Credited rate per year', reads: ['in_term', 'guaranteed_rate_pa', 'renewal_rate_pa'], spec: 'The rate that applies this month.', timing: 'start of month', step: 'choose', measure: 'rate',
          branches: [{ when: 'in the term', case: 'base' }, { when: 'after the term', case: 'long' }], assumed: ['the renewal rate is flat'] },
        { name: 'credited_rate_pm', label: 'Credited rate per month', reads: ['credited_rate_pa', 'months_per_year'], spec: 'The yearly rate as a monthly rate.', timing: 'start of month', step: 'convert', measure: 'rate' },
        { name: 'interest_credited', label: 'Interest credited', reads: ['av_bop', 'credited_rate_pm'], spec: 'A month of interest on the opening value.', timing: 'during month', step: 'apply', measure: 'amount' },
        { name: 'av_eop', label: 'Closing account value', reads: ['av_bop', 'premium', 'interest_credited'], spec: 'The account value at the end of the month.', timing: 'end of month', step: 'combine', measure: 'amount' }],
        states: [{ name: 'av_bop', from: 'av_eop', initial: 0, label: 'Opening account value' }],
        checks: [{ label: 'Account value reconciles', expression: 'av_bop + premium + interest_credited - av_eop' }] },
      { id: 'decrements', title: 'Decrements', layer: liab, purpose: 'Who leaves in the month.', tiles: [
        { name: 'mort_rate_pm', label: 'Mortality rate per month', reads: ['mort_rate_pa', 'months_per_year'], spec: 'The yearly rate as a monthly rate.', timing: 'end of month', step: 'convert', measure: 'rate' },
        { name: 'deaths', label: 'Deaths', reads: ['in_force_bop', 'mort_rate_pm'], spec: 'The share of policies issued that die in the month.', timing: 'end of month', step: 'apply', measure: 'proportion' },
        { name: 'in_force_eop', label: 'Closing in force', reads: ['in_force_bop', 'deaths'], spec: 'The share of policies issued still in force.', timing: 'end of month', step: 'combine', measure: 'proportion' }],
        states: [{ name: 'in_force_bop', from: 'in_force_eop', initial: 1, label: 'Opening in force' }],
        checks: [{ label: 'In force reconciles', expression: 'in_force_bop - deaths - in_force_eop' }] },
      { id: 'cash_flows', title: 'Cash flows', layer: liab, weights: true, purpose: 'What cash moves per policy issued.', tiles: [
        { name: 'premium_received', label: 'Premium received', reads: ['premium', 'in_force_bop'], spec: 'Premium from the policies in force.', timing: 'start of month', step: 'apply', measure: 'weighted' },
        { name: 'death_benefits_paid', label: 'Death benefits paid', reads: ['av_eop', 'deaths'], spec: 'The account value of the policies that die.', timing: 'end of month', step: 'apply', measure: 'weighted' },
        { name: 'net_cashflow', label: 'Net cash flow', reads: ['premium_received', 'death_benefits_paid'], spec: 'Premium less benefits.', timing: 'end of month', step: 'combine', measure: 'weighted' }] },
      { id: 'results', title: 'Results', layer: res, timing: 'summary', purpose: 'What the cash flows are worth today.', tiles: [
        { name: 'pv_net_cashflow', label: 'Present value of net cash flow', reads: ['net_cashflow', 'discount_rate_pa', 'months_per_year'], spec: 'The net cash flow discounted at a flat rate.', step: 'combine', measure: 'other' }] }],
    model_point_fields: [{ name: 'premium', label: 'Premium' }, { name: 'guaranteed_rate_pa', label: 'Guaranteed rate' }],
    inputs: [{ name: 'premium', label: 'Premium', kind: 'field' }, { name: 'guaranteed_rate_pa', label: 'Guaranteed rate', kind: 'field' },
      { name: 'in_term', label: 'In the guarantee term', kind: 'time' }, { name: 'mort_rate_pa', label: 'Mortality rate per year', kind: 'lookup' }],
    params: [{ name: 'months_per_year', label: 'Months in a year' }, { name: 'renewal_rate_pa', label: 'Renewal rate' }, { name: 'discount_rate_pa', label: 'Discount rate' }],
    tables: [{ name: 'mortality', label: 'Mortality table' }],
    cases: [{ id: 'base', name: 'Base', purpose: 'A typical policy inside its term.' }, { id: 'long', name: 'Past the term', purpose: 'Runs beyond the guarantee term.' }],
  };
}

// A design on the standard spine, with a backward reserve.
function spineDesign(layers) {
  const liab = layers.includes('Liability') ? 'Liability' : layers[0], res = layers.includes('Results') ? 'Results' : layers[layers.length - 1];
  const t = (name, label, reads, step, measure, extra = {}) => ({ name, label, reads, spec: `${label} for the month.`, timing: 'end of month', step, measure, ...extra });
  return {
    summary: 'A deferred annuity on the standard spine.', order_in_month: ['Premium', 'Interest', 'Deaths'], results: ['pv_net_cashflow', 'total_net_cashflow', 'reserve_eop'],
    modules: [
      { id: 'decrements', title: 'Decrements', layer: liab, purpose: 'Who leaves in the month.', tiles: [
        t('death_rate_pm', 'Death rate per month', ['mort_rate_pa', 'months_per_year'], 'convert', 'rate'),
        t('death_units', 'Deaths', ['units_bop', 'death_rate_pm'], 'apply', 'proportion'),
        t('units_eop', 'Closing units', ['units_bop', 'death_units'], 'combine', 'proportion')],
        states: [{ name: 'units_bop', from: 'units_eop', initial: 1, label: 'Opening units' }], checks: [{ label: 'Units reconcile', expression: 'units_bop - death_units - units_eop' }] },
      { id: 'policy_values', title: 'Policy values', layer: liab, purpose: 'What one policy is worth each month.', tiles: [
        t('interest_credited', 'Interest credited', ['av_bop', 'guaranteed_rate_pa'], 'apply', 'amount'),
        t('av_eop', 'Closing account value', ['av_bop', 'premium', 'interest_credited'], 'combine', 'amount')],
        states: [{ name: 'av_bop', from: 'av_eop', initial: 0, label: 'Opening account value' }], checks: [{ label: 'Account value reconciles', expression: 'av_bop + premium + interest_credited - av_eop' }] },
      { id: 'per_unit_items', title: 'Per-unit cash items', layer: liab, purpose: 'What each policy pays and receives.', tiles: [
        t('premium_pu', 'Premium per policy', ['premium'], 'apply', 'amount'), t('death_benefit_pu', 'Death benefit per death', ['av_eop'], 'apply', 'amount')] },
      { id: 'cash_flows', title: 'Cash flows', layer: liab, weights: true, purpose: 'What cash moves per policy issued.', tiles: [
        t('premium_cf', 'Premium received', ['premium_pu', 'units_bop'], 'apply', 'weighted'), t('death_benefit_cf', 'Death benefits paid', ['death_benefit_pu', 'death_units'], 'apply', 'weighted'),
        t('net_cashflow', 'Net cash flow', ['premium_cf', 'death_benefit_cf'], 'combine', 'weighted')] },
      { id: 'reserves', title: 'Reserves', layer: liab, timing: 'backward', weights: true, purpose: 'What must be held for the policies in force.', tiles: [
        t('reserve_pu', 'Reserve per policy', ['av_eop', 'reserve_pu_next', 'discount_rate_pa', 'months_per_year'], 'limit', 'amount',
          { branches: [{ when: 'the account value is the greater', case: 'base' }, { when: 'next month\'s reserve discounted is the greater', case: 'long' }] }),
        t('reserve_eop', 'Reserve in total', ['reserve_pu', 'units_eop'], 'apply', 'weighted')],
        states: [{ name: 'reserve_pu_next', from: 'reserve_pu', initial: 0, label: 'Reserve next month' }] },
      { id: 'results', title: 'Results', layer: res, timing: 'summary', purpose: 'What the cash flows are worth today.', tiles: [
        t('pv_net_cashflow', 'Present value of net cash flow', ['net_cashflow', 'discount_rate_pa', 'months_per_year'], 'combine', 'other'),
        t('total_net_cashflow', 'Total net cash flow', ['net_cashflow'], 'combine', 'other')] }],
    model_point_fields: [{ name: 'premium', label: 'Premium' }, { name: 'guaranteed_rate_pa', label: 'Guaranteed rate' }],
    inputs: [{ name: 'premium', label: 'Premium', kind: 'field' }, { name: 'guaranteed_rate_pa', label: 'Guaranteed rate', kind: 'field' }, { name: 'mort_rate_pa', label: 'Mortality rate per year', kind: 'lookup' }],
    params: [{ name: 'months_per_year', label: 'Months in a year' }, { name: 'discount_rate_pa', label: 'Discount rate' }], tables: [{ name: 'mortality', label: 'Mortality table' }],
    cases: [{ id: 'base', name: 'Base', purpose: 'A typical policy.' }, { id: 'long', name: 'Long', purpose: 'A long projection.' }],
  };
}

async function designChecks(check) {
  const design = require('../src/agent/design');
  const dir = path.join(TMP_ROOT, `design-${++copies}`);
  const tk = runnerFor(dir);
  await tk('init', ['--name', 'Deferred annuity', '--package', `deferred_annuity_${copies}`]);
  const g = await tk('graph');
  const fresh = () => JSON.parse(JSON.stringify(miniDesign(g.layers)));
  const run = d => design.validateDesign(g, design.normalise(d), []);
  const has = (r, re) => r.problems.some(p => re.test(p));
  const good = run(fresh());
  check('a sound design passes', good.problems.length === 0, good);
  check('design summary counts modules, functions, carried values, reconciliations and cases',
    design.designSummary(design.normalise(fresh())) === 'designs four modules with 11 functions, two carried values, two reconciliations and two cases', design.designSummary(design.normalise(fresh())));

  let d = fresh(); d.modules[0].tiles[2].reads.push('deaths');
  check('a function may not read from a later module', has(run(d), /later module/), run(d));
  d = fresh(); d.modules[0].tiles.push({ name: 'spare_amount', label: 'Spare', reads: ['av_bop'], spec: 'A spare value.', timing: 'end of month', step: 'apply', measure: 'amount' });
  check('a function nothing reads is refused', has(run(d), /Nothing reads spare_amount/), run(d));
  d = fresh(); d.modules[0].checks = [];
  check('a roll-forward needs a reconciliation', has(run(d), /reconciliation naming both av_bop and av_eop/), run(d));
  d = fresh(); d.modules[0].tiles[0].branches = [];
  check('a choose step lists its branches', has(run(d), /at least two branches/), run(d));
  d = fresh(); d.modules[0].tiles[0].branches[1].case = 'nowhere';
  check('a branch names a real case', has(run(d), /names the case 'nowhere'/), run(d));
  d = fresh(); d.modules[2].weights = false;
  check('amounts are weighted only in the weighting module', has(run(d), /Only a module marked weights: true/), run(d));
  d = fresh(); d.modules[0].tiles[2].reads = ['av_bop', 'credited_rate_pm', 'bonus_rate_pm'];
  check('an unknown name is reported', has(run(d), /reads 'bonus_rate_pm'/), run(d));
  d = fresh(); d.inputs[2].kind = 'formula';
  check('an input is data only', has(run(d), /data only/), run(d));
  d = fresh(); d.modules[0].tiles[2].step = 'tidy';
  check('a function says which one step it does', has(run(d), /which one step/), run(d));
  d = fresh(); d.results = [];
  check('a design names its results', has(run(d), /Name the results/), run(d));
  d = fresh(); d.order_in_month = [];
  check('the order within a month is stated', has(run(d), /order of events within a month/), run(d));
  d = fresh(); d.modules[1].tiles[1].name = 'AV_EOP'.toLowerCase().replace('av', 'Av');
  check('a name that is not snake_case is reported', has(run(d), /not a snake_case name/), run(d));
  d = fresh(); d.modules[0].tiles[2].spec = 'A month of interest, not below the minimum.';
  const lim = run(d);
  check('a limit hidden in another step is a warning', lim.problems.length === 0 && lim.warnings.some(w => /cap or floor is its own function/.test(w)), lim);

  // the spine: the same modules, order and names in every model; departures are warnings, never problems
  const onSpine = () => JSON.parse(JSON.stringify(spineDesign(g.layers)));
  const spine = r => r.warnings.filter(w => /^Departs from the spine/.test(w));
  const sp = run(onSpine());
  check('a design on the spine, with a backward reserve, passes with no spine warning', sp.problems.length === 0 && spine(sp).length === 0, sp);
  const offSpine = spine(good);
  check('a design off the spine still passes, with a warning for each departure', good.problems.length === 0 && offSpine.some(w => /account_value is not one of its modules/.test(w)) &&
    offSpine.some(w => /no per_unit_items module/.test(w)) && offSpine.some(w => /no reserves module/.test(w)) && offSpine.some(w => /carries units_bop forward/.test(w)), offSpine);
  d = onSpine(); d.modules.reverse();
  check('spine modules out of order are flagged', spine(run(d)).some(w => /come in the order decrements, policy_values/.test(w)), spine(run(d)));
  d = onSpine(); d.modules[3].tiles[1].reads = ['death_benefit_pu'];
  check('a cash flow line with no units is flagged unless it says it is weighted by policies issued', spine(run(d)).some(w => /death_benefit_cf reads units_bop/.test(w)), spine(run(d)));
  d.modules[3].tiles[1].assumed = ['Paid whether or not the policy is in force: weighted by policies issued.'];
  check('the certain-period exception is accepted when stated', !spine(run(d)).some(w => /death_benefit_cf reads units_bop/.test(w)), spine(run(d)));
  d = onSpine(); d.modules[3].tiles.push({ ...d.modules[3].tiles[0], name: 'premium_tax', reads: ['premium_cf', 'months_per_year'] }); d.modules[3].tiles[2].reads.push('premium_tax');
  check('anything in cash flows that is not a line or the net is flagged', spine(run(d)).some(w => /premium_tax is in cash_flows but is not/.test(w)), spine(run(d)));
  d = onSpine(); d.modules[2].tiles[1].reads = ['av_eop', 'reserve_pu'];
  check('a forward function cannot read a backward one', has(run(d), /worked out backward afterwards/), run(d));
  d = onSpine(); d.modules[4].timing = 'step';
  check('reserves that do not run backward are flagged', spine(run(d)).some(w => /reserves runs backward, not step/.test(w)), spine(run(d)));
  d = onSpine(); d.modules[5].tiles.push({ ...d.modules[5].tiles[1], name: 'profit_margin', reads: ['net_cashflow', 'discount_rate_pa'] }); d.results.push('profit_margin');
  check('a result that is not a total or present value of a line is flagged', spine(run(d)).some(w => /profit_margin is in results but is not/.test(w)), spine(run(d)));

  // the tool: model level only, a draft, and design.json on accept
  const e = serviceFor(dir);
  const hm = e.service.handlersFor({ level: 'model', id: 'model' });
  const bad = await hm.propose_design({ ...fresh(), results: [] });
  check('propose_design returns the problems and saves nothing', bad.isError && /Name the results/.test(bad.text) && e.service.drafts().length === 0, bad);
  const pd = await hm.propose_design(fresh());
  const id = draftIdOf(pd.text);
  const draft = e.service.drafts().find(x => x.id === id);
  check('propose_design saves a design draft', !!draft && draft.kind === 'design' && draft.design.modules.length === 4 && /designs four modules/.test(draft.summary), pd);
  check('nothing is written before the design is accepted', !fs.existsSync(path.join(dir, 'design.json')) && e.service.design() === null);
  const before = JSON.stringify(await tk('graph'));
  const acc = await e.service.acceptDraft(id);
  const saved = e.service.design();
  check('accepting saves design.json and builds nothing', acc.accepted && saved && saved.version === 1 && saved.modules[0].tiles[0].name === 'credited_rate_pa' &&
    JSON.stringify(await tk('graph')) === before, acc);
  // later drafts say where they depart from it
  const md = await hm.propose_structure({ summary: 'Blocks.', modules: [
    { id: 'account_value', title: 'Account value', layer: saved.modules[0].layer, purpose: 'What one policy is worth each month.', feeds: [] },
    { id: 'bonuses', title: 'Bonuses', layer: saved.modules[0].layer, purpose: 'Bonus additions.', feeds: [] }] });
  const mdraft = e.service.drafts().find(x => x.id === draftIdOf(md.text));
  check('a module that is not in the design is flagged, and one that is in it is not', !!mdraft && mdraft.warnings.length === 1 && /bonuses is not in it/.test(mdraft.warnings[0]) && /Departs from the agreed design/.test(md.text), md);
  check('tile departures: an extra read, a function in the wrong module and one not designed',
    design.tileDepartures(saved, 'account_value', [{ name: 'interest_credited', args: ['av_bop', 'credited_rate_pm', 'premium'] }, { name: 'deaths', args: [] }, { name: 'novel_x', args: [] },
      { name: 'credited_rate_pm', args: ['months_per_year', 'credited_rate_pa'] }]).map(x => x.replace('Departs from the agreed design: ', '')).join('|') ===
    'interest_credited also reads premium.|deaths is in decrements there, not account_value.|novel_x is not in it for account_value.', design.tileDepartures(saved, 'account_value', [{ name: 'interest_credited', args: ['av_bop', 'credited_rate_pm', 'premium'] }]));
  check('with no design there is nothing to depart from', design.tileDepartures(null, 'x', [{ name: 'a', args: [] }]).length === 0 && design.moduleDepartures(null, [{ id: 'a' }]).length === 0);
  // a module's timing travels with a modules draft into tilekit.toml
  const bm = await hm.propose_structure({ summary: 'The reserve block.', modules: [{ id: 'reserves', title: 'Reserves', layer: saved.modules[0].layer, purpose: 'What must be held.', feeds: [], timing: 'backward' }] });
  const bacc = await e.service.acceptDraft(draftIdOf(bm.text));
  const g2 = await tk('graph');
  check('a modules draft can make a backward module', bacc.accepted && (g2.modules.find(m => m.id === 'reserves') || {}).timing === 'backward' &&
    /timing = "backward"/.test(fs.readFileSync(path.join(dir, 'tilekit.toml'), 'utf8')), bacc);
  const badT = await hm.propose_structure({ summary: 'x', modules: [{ id: 'odd_one', title: 'Odd', layer: saved.modules[0].layer, purpose: 'p', feeds: [], timing: 'sideways' }] });
  check('an unknown module timing is refused', badT.isError && /timing 'sideways'/.test(badT.text), badT);
  const refused = await e.service.handlersFor({ level: 'module', id: 'account_value' }).propose_design(fresh());
  check('the design is proposed at model level only', refused.isError && /model level/.test(refused.text), refused);
  const prompt = require('../src/agent/prompt').systemPrompt({ modelDir: dir });
  check('the prompt has the design stage and its standards', /propose_design/.test(prompt) && /House standards for designing a model/.test(prompt) && /One reviewer question per module/.test(prompt) &&
    /## The spine/.test(prompt) && /same spine of modules/.test(prompt) && /backward module a state reads NEXT month/.test(prompt) && prompt.length < 60000);
  check('propose_design is in the tool list given to Claude Code', (await e.service.cliTools()).some(t => t.name === 'propose_design'));
}

// ---------------------------------------------------------------- live scenarios

function withTimeout(promise, svc, scope) {
  let t;
  return Promise.race([promise, new Promise(resolve => { t = setTimeout(() => { svc.interrupt(scope); resolve({ timeout: true }); }, SCENARIO_TIMEOUT_MS); })])
    .finally(() => clearTimeout(t));
}

async function scenario1() {
  const e = env(copyModel());
  const scope = { level: 'tile', id: 'units_amc' };
  const g0 = await e.tilekit('graph');
  const before = fs.readFileSync(unitsFile(e.modelDir), 'utf8');
  const r = await withTimeout(e.service.send(scope, 'Remove the cap: the charge is simply units after allocation times the monthly rate.'), e.service, scope);
  const g1 = await e.tilekit('graph');
  const chk = await e.tilekit('check');
  const st = await e.tilekit('status');
  const after = fs.readFileSync(unitsFile(e.modelDir), 'utf8');
  const res = Object.values(st.tiles.units_amc.case_results || {});
  const checks = {
    function_changed: fnCode(g0, 'units_amc') !== fnCode(g1, 'units_amc') && !/minimum|cap/.test(g1.quantities.units_amc.expression),
    other_functions_unchanged: ['units_allocated', 'units_after_alloc', 'units_eop'].every(n => fnCode(g0, n) === fnCode(g1, n)),
    only_one_function_in_diff: after !== before,
    rule_check_passes: !(chk.violations || []).some(v => v.tile === 'units_amc' && v.severity === 'error'),
    zero_differences_every_case: res.length > 0 && res.every(x => x.pass),
    action_line: e.events.some(x => x.type === 'action' && /^Wrote units_amc/.test(x.text)) && e.events.some(x => x.type === 'action' && /Rebuilt the workbook: differences are zero/.test(x.text)),
    test_written: fs.existsSync(path.join(e.modelDir, 'tests', 'tiles', 'test_units_amc.py')),
  };
  return { checks, r, e, newCode: g1.quantities.units_amc.source.code };
}

async function scenario2() {
  const e = env(copyModel());
  const scope = { level: 'tile', id: 'units_eop' };
  const file = unitsFile(e.modelDir);
  const before = fs.readFileSync(file);
  const srcHash = hashTree(path.join(e.modelDir, 'src'));
  const r = await withTimeout(e.service.send(scope, 'What if closing units also lost a flat one unit a month as a policy fee? Show me the effect on closing units; do not change anything.'), e.service, scope);
  const draft = e.events.find(x => x.type === 'draft' && x.draft.kind === 'what_if');
  const checks = {
    file_byte_identical: Buffer.compare(before, fs.readFileSync(file)) === 0 && hashTree(path.join(e.modelDir, 'src')) === srcHash,
    what_if_draft: !!draft,
    numbers_returned: !!(draft && draft.draft.result && Object.values(draft.draft.result.cases).some(c => Object.values(c).some(q => q.maxAbs > 0))),
  };
  return { checks, r, e };
}

async function scenario3() {
  const e = env(copyModel());
  const scope = { level: 'module', id: 'unit_projection' };
  const file = unitsFile(e.modelDir);
  const before = fs.readFileSync(file, 'utf8');
  const r = await withTimeout(e.service.send(scope, 'Add a bid-offer spread: units are bought at the offer price, which is the unit price times one plus the spread.'), e.service, scope);
  const unchanged = fs.readFileSync(file, 'utf8') === before;
  const draft = e.events.find(x => x.type === 'draft');
  const question = e.events.find(x => x.type === 'agent' && /\?/.test(x.text));   // with no form to show, the agent asks in words
  const checks = { draft_or_question: !!(draft || question), module_file_unchanged_before_accept: unchanged };
  if (draft) {
    const acc = await e.service.acceptDraft(draft.draft.id).catch(err => ({ error: err.message }));
    checks.accept_changes_file = !!acc.accepted && fs.readFileSync(file, 'utf8') !== before;
  }
  return { checks, r, e, outcome: draft ? 'draft' : question ? 'question' : 'neither' };
}

async function scenario4() {
  const e = env(copyModel(), false);
  let signed;
  await e.tilekit('test', ['--file', 'tests/tiles/test_units_allocated.py']);   // a tile's sign-off needs its test to have passed since the last change
  try { signed = await e.tilekit('signoff', ['--tile', 'units_allocated', '--reviewer', 'Harness']); } catch (err) { signed = { error: err.message }; }
  if (!signed.signed_off) {
    if (/not implemented/i.test(signed.error || '')) return { skipped: 'tilekit signoff is not implemented yet', e };
    return { checks: { signoff_recorded: false }, e, detail: signed };
  }
  const scope = { level: 'tile', id: 'units_allocated' };
  const file = unitsFile(e.modelDir);
  const before = fs.readFileSync(file, 'utf8');
  const r = await withTimeout(e.service.send(scope, 'Make sure units allocated can never be negative: take the larger of the formula and zero.'), e.service, scope);
  const checks = {
    confirm_called: e.confirms.length > 0,
    confirm_names_staleness: e.confirms.some(c => /un-ticks `units_allocated`/.test(c.message)),
    file_unchanged_after_decline: fs.readFileSync(file, 'utf8') === before,
    still_signed_off: (await e.tilekit('status')).tiles.units_allocated.state === 'signed_off',
  };
  return { checks, r, e, confirms: e.confirms };
}

async function scenario5() {
  const e = env(copyModel());
  const scope = { level: 'tile', id: 'units_amc' };
  const g0 = await e.tilekit('graph');
  const r = await withTimeout(e.service.send(scope, 'Also change units_eop so closing units can never go below zero.'), e.service, scope);
  const g1 = await e.tilekit('graph');
  const text = e.events.filter(x => x.type === 'agent' || x.type === 'action').map(x => x.text).join(' ');
  const checks = {
    units_eop_unchanged: fnCode(g0, 'units_eop') === fnCode(g1, 'units_eop'),
    refused_or_redirected: /select|outside|only (work|act|change)|selected tile|cannot change|can't change/i.test(text),
  };
  return { checks, r, e };
}


async function scenario6() {
  // Batch build: a module-level draft (made directly, no model call) is accepted, then buildModule implements it.
  const e = env(copyModel());
  const store = require('../src/agent/store');
  const svc = { modelDir: e.modelDir, tilekit: e.tilekit, confirm: async () => false, runPytest: null,
    emitEvent: () => {}, saveDraftEvent: d => store.saveDraft(e.modelDir, d) };
  const h = createHandlers(svc, { scope: { level: 'module', id: 'unit_projection' }, approved: new Set(), writes: [], drafts: [] });
  const pd = await h.propose_structure({ summary: 'Adds the monthly change in units.', sections: [UNIT_SECTIONS[0], { title: UNIT_SECTIONS[1].title, tiles: ['units_amc', 'units_eop', 'units_change'] }], tiles: [
    { name: 'units_change', label: 'Change in units', args: ['units_eop', 'units_bop'], units: 'units per policy', timing: 'end of month', format: 'units',
      spec: 'Closing units less opening units: the net number of units added to the policy this month.' }] });
  const id = (pd.text.match(/draft (d\d{14}-[0-9a-f]{6})/) || [])[1];
  const acc = id ? await e.service.acceptDraft(id) : { accepted: false };
  const r = await withTimeout(e.service.buildModule('unit_projection'), e.service, { level: 'tile', id: 'units_change' });
  const st = await e.tilekit('status');
  const t = st.tiles.units_change || {};
  const checks = {
    skeleton_accepted: !!acc.accepted,
    tile_built: t.state && t.state !== 'not_built',
    zero_differences: Object.values(t.case_results || {}).length > 0 && Object.values(t.case_results).every(x => x.pass),
    summary_line: e.events.some(x => x.scope.level === 'module' && /^Built units_change/.test(x.text)),
  };
  return { checks, r, e, newCode: (await e.tilekit('graph')).quantities.units_change.source.code };
}

async function scenario7() {
  // Resume: a second turn in the same scope continues the conversation; then interrupt a turn.
  const e = env(copyModel());
  const scope = { level: 'tile', id: 'units_amc' };
  const r1 = await withTimeout(e.service.send(scope, 'In one sentence: what does this tile do?'), e.service, scope);
  const r2 = await withTimeout(e.service.send(scope, 'And what was my previous question? Answer in a few words.'), e.service, scope);
  const answer = e.events.filter(x => x.type === 'agent').map(x => x.text).pop() || '';
  const p = e.service.send(scope, 'Explain in detail why closing units grow in the high_charge case over all 120 months.');
  await new Promise(res => setTimeout(res, 4000));
  const interrupted = e.service.interrupt(scope);
  const r3 = await p;
  const checks = {
    one_session_reused: !!r1.session_id && r1.session_id === r2.session_id,
    remembers_previous_question: /tile|what (it|this|the tile) does/i.test(answer),
    interrupt_stops_turn: interrupted && (r3.aborted || e.events.some(x => x.type === 'done' && x.text === 'Stopped.')),
    not_busy_after: e.service.status().busy.length === 0,
  };
  return { checks, r: r2, e };
}

async function scenario8() {
  // Authentication failure is reported as one plain sentence.
  const e = env(copyModel());
  const scope = { level: 'tile', id: 'units_amc' };
  // An empty Claude config directory means no login; the API key, if any, is hidden for this turn.
  const saved = { key: process.env.ANTHROPIC_API_KEY, dir: process.env.CLAUDE_CONFIG_DIR };
  delete process.env.ANTHROPIC_API_KEY;
  process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(TMP_ROOT, 'no-login-'));
  let r;
  try { r = await withTimeout(e.service.send(scope, 'What does this tile do?'), e.service, scope); }
  finally {
    if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.dir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.dir;
  }
  const errs = e.events.filter(x => x.type === 'error').map(x => x.text);
  const checks = {
    one_error_line: errs.length === 1,
    plain_sign_in_sentence: errs[0] === require('../src/agent').NOT_SIGNED_IN,
    status_says_signed_out: e.service.status().signedIn === false,
  };
  return { checks, r, e };
}

async function scenario9() {
  // With a tile selected, a question about another module is answered from the model.
  const e = env(copyModel());
  const scope = { level: 'tile', id: 'units_amc' };
  const g0 = await e.tilekit('graph');
  const users = g0.quantities.discount_factor.used_by;
  const r = await withTimeout(e.service.send(scope, 'Which tiles in the profit module use the discount factor? Just the names.'), e.service, scope);
  const g1 = await e.tilekit('graph');
  const text = e.events.filter(x => x.type === 'agent').map(x => x.text).join(' ');
  const checks = {
    answered: users.every(u => text.includes(u)),
    nothing_changed: g0.order.every(n => fnCode(g0, n) === fnCode(g1, n)),
    no_refusal: !e.events.some(x => x.type === 'action' && /^Refused/.test(x.text)),
  };
  return { checks, r, e };
}

async function scenario10() {
  // "Sign it off" produces a request; only confirmSignoff (the button) records the sign-off.
  const e = env(copyModel());
  const scope = { level: 'tile', id: 'units_amc' };
  const r = await withTimeout(e.service.send(scope, "I'm happy with this tile, sign it off."), e.service, scope);
  const req = e.events.filter(x => x.type === 'signoff_request').pop();
  const before = (await e.tilekit('status')).tiles.units_amc.state;
  const checks = {
    signoff_request_event: !!(req && req.request.kind === 'tile' && req.request.name === 'units_amc'),
    not_signed_before_button: before !== 'signed_off',
  };
  if (req) {
    const c = await e.service.confirmSignoff(req.request.id, { reviewer: 'Harness' });
    checks.signed_after_button = c.signed && (await e.tilekit('status')).tiles.units_amc.state === 'signed_off';
  }
  return { checks, r, e };
}

async function scenario11() {
  // A fresh `tilekit init` model and one scaffolding exchange: questions or a first structure draft; then
  // accepting a module draft and a params draft leaves a model that passes check.
  const dir = path.join(TMP_ROOT, `fresh-${++copies}`);
  await runnerFor(dir)('init', ['--name', 'Level term assurance', '--package', 'level_term']);
  const e = env(dir, true);
  const scope = { level: 'model', id: 'model' };
  const say = text => withTimeout(e.service.send(scope, text), e.service, scope);
  const drafts = kind => e.events.filter(x => x.type === 'draft' && x.draft.kind === kind);
  let r = await say('This is a level term assurance: monthly premiums, a death benefit, mortality and lapse decrements. Scaffold it.');
  const first = { question: e.events.some(x => x.type === 'agent' && /\?/.test(x.text)), draft: drafts('modules').length > 0 };
  const checks = { questions_or_structure_draft: first.question || first.draft };
  if (!drafts('modules').length) {
    r = await say('Pricing, per policy. Level sum assured paid at the end of the month of death. Premiums monthly in advance for the term. ' +
      'Deaths first, then lapses on the survivors. Monthly steps over 120 months. No reinsurance. Results: the profit signature and the present value of profit. ' +
      'Use your judgement for the rest, record it as assumptions, and propose the modules now.');
  }
  const mod = drafts('modules').pop();
  const accept = id => e.service.acceptDraft(id).catch(err => ({ accepted: false, error: err.message }));
  checks.module_draft_accepted = mod ? (await accept(mod.draft.id)).accepted : false;
  if (!drafts('params').length) r = await say('Accepted. Now propose the parameters.');
  const par = drafts('params').pop();
  checks.params_draft_accepted = par ? (await accept(par.draft.id)).accepted : false;
  const chk = await e.tilekit('check');
  const g = await e.tilekit('graph');
  checks.model_passes_check = chk.counts.error === 0 && g.modules.length > 0;
  return { checks, r, e, outcome: `${first.question ? 'question' : 'draft'} first; ${g.modules.length} modules, ${Object.values(g.quantities).filter(q => q.kind === 'param').length} parameters` };
}

// ---------------------------------------------------------------- main

async function main() {
  const summary = { tmp: TMP_ROOT, offline: [], scenarios: [] };
  summary.offline = await offline();
  if (!OFFLINE) {
    const all = [
      [1, 'tile level: remove the AMC cap', scenario1],
      [2, 'what-if on units_eop', scenario2],
      [3, 'module level: bid-offer spread', scenario3],
      [4, 'signed-off tile, human declines', scenario4],
      [5, 'out-of-scope request refused', scenario5],
      [6, 'batch build of one module', scenario6],
      [7, 'resume and interrupt', scenario7],
      [8, 'authentication failure', scenario8],
      [9, 'tile level: question about another module', scenario9],
      [10, 'sign-off through chat needs the button', scenario10],
      [11, 'scaffold a fresh model', scenario11],
    ];
    for (const [n, name, fn] of all) {
      if (ONLY && !ONLY.has(n)) continue;
      const started = Date.now();
      let out;
      try { out = await fn(); } catch (err) { out = { error: String(err && err.stack || err) }; }
      const done = out.e ? out.e.events.filter(x => x.type === 'done') : [];
      const entry = {
        n, name,
        pass: out.skipped ? null : !!(out.checks && Object.values(out.checks).every(Boolean)),
        ...(out.skipped ? { skipped: out.skipped } : {}),
        checks: out.checks, ...(out.outcome ? { outcome: out.outcome } : {}), ...(out.error ? { error: out.error } : {}),
        ...(out.r && out.r.timeout ? { timeout: true } : {}),
        seconds: Math.round((Date.now() - started) / 1000),
        cost_usd: Number(done.reduce((s, x) => s + (x.cost_usd || 0), 0).toFixed(4)),
        agent_seconds: Number((done.reduce((s, x) => s + (x.ms || 0), 0) / 1000).toFixed(1)),
        model_turns: done.reduce((s, x) => s + (x.num_turns || 0), 0),
        log: out.e ? lines(out.e.events) : [],
        ...(out.newCode ? { new_code: out.newCode } : {}),
        ...(out.confirms ? { confirms: out.confirms } : {}),
      };
      summary.scenarios.push(entry);
      process.stderr.write(`scenario ${n}: ${entry.pass === null ? 'skipped' : entry.pass ? 'pass' : 'FAIL'} (${entry.seconds}s, $${entry.cost_usd})\n`);
    }
  }
  summary.offline_passed = summary.offline.filter(c => c.pass).length;
  summary.offline_failed = summary.offline.filter(c => !c.pass).map(c => c.name);
  summary.scenarios_passed = summary.scenarios.filter(s => s.pass).map(s => s.n);
  summary.scenarios_failed = summary.scenarios.filter(s => s.pass === false).map(s => s.n);
  console.log(JSON.stringify(summary, null, 1));
  if (!process.argv.includes('--keep')) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  process.exit(summary.offline_failed.length || summary.scenarios_failed.length ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(2); });
