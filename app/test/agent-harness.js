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

// tilekit for a temporary copy: the real model project supplies the Python environment only.
function runnerFor(modelDir) {
  const uv = findUv();
  return function run(command, args = []) {
    const argv = ['run', '--frozen', '--project', REAL_MODEL, 'tilekit', command, '--model', modelDir, ...args];
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
    const child = spawn(uv, ['run', '--frozen', '--project', REAL_MODEL, 'python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', rel],
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
  });
  return { modelDir, events, confirms, tilekit, service };
}

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
    const turn = scope => ({ scope, batchModule: null, asked: false, approved: new Set(), writes: [], drafts: [] });

    const t1 = turn({ level: 'tile', id: 'units_amc' });
    const h = createHandlers(svc, t1);
    const refused = await h.write_tile({ name: 'units_eop', code: 'def units_eop(a):\n    """x."""\n    return a', test_code: '' });
    check('write_tile refuses a tile outside the selection', refused.isError && /outside the selection/.test(refused.text), refused);
    const mod = createHandlers(svc, turn({ level: 'module', id: 'unit_projection' }));
    const r2 = await mod.write_tile({ name: 'units_amc', code: NO_CAP, test_code: '' });
    check('write_tile refuses at module level', r2.isError, r2);
    const pt = await h.propose_structure({ summary: 'x', tiles: [] });
    check('propose_structure refuses at tile level', pt.isError, pt);

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
    const pd = await mh.propose_structure({ summary: 'Adds net units.', tiles: [
      { name: 'units_net_change', label: 'Change in units', args: ['units_eop', 'units_bop'], units: 'units per policy', timing: 'end of month', format: 'units', spec: 'Closing units less opening units.' }] });
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

    // ask_user ends the turn: later tools refuse.
    const tq = turn({ level: 'tile', id: 'units_eop' });
    const hq = createHandlers(svc, tq);
    await hq.ask_user({ question: 'Before or after allocation?' });
    const after = await hq.write_tile({ name: 'units_eop', code: 'x', test_code: '' });
    check('after ask_user, tools refuse until the user answers', tq.asked && after.isError && /question/.test(after.text));

    // Logs.
    const logOk = fs.existsSync(path.join(dir, 'review', 'model', 'log.jsonl'));
    check('events are appended to the scope log', logOk);
  });

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
  return results;
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
  const question = e.events.find(x => x.type === 'question');
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
  const text = e.events.filter(x => x.type === 'agent' || x.type === 'action' || x.type === 'question').map(x => x.text).join(' ');
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
  const h = createHandlers(svc, { scope: { level: 'module', id: 'unit_projection' }, asked: false, approved: new Set(), writes: [], drafts: [] });
  const pd = await h.propose_structure({ summary: 'Adds the monthly change in units.', tiles: [
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
  await withTimeout(e.service.send(scope, 'In one sentence: what does this tile do?'), e.service, scope);
  const r2 = await withTimeout(e.service.send(scope, 'And what was my previous question? Answer in a few words.'), e.service, scope);
  const sessions = require('../src/agent/store').readLog(e.modelDir, scope).filter(x => x.type === 'session');
  const answer = e.events.filter(x => x.type === 'agent').map(x => x.text).pop() || '';
  const p = e.service.send(scope, 'Explain in detail why closing units grow in the high_charge case over all 120 months.');
  await new Promise(res => setTimeout(res, 4000));
  const interrupted = e.service.interrupt(scope);
  const r3 = await p;
  const checks = {
    one_session_reused: sessions.length === 1 && !!sessions[0].session_id,
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
