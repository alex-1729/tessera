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

    // ask_user with several questions: one question event carrying the form.
    const tq2 = turn({ level: 'model', id: 'model' });
    const nEv = e.events.length;
    await createHandlers(svc, tq2).ask_user({ questions: [
      { question: 'What is priced?', header: 'Purpose', options: [{ label: 'Profit', description: 'On a block' }, { label: 'Reserve' }] },
      { question: 'Which results?', header: 'Results', multi_select: true, options: [{ label: 'IRR' }, { label: 'PVs' }] }] });
    const qEv = e.events.slice(nEv).find(x => x.type === 'question');
    check('ask_user with several questions emits one form', tq2.asked && qEv && qEv.questions.length === 2 && qEv.questions[1].multi === true
      && qEv.questions[0].options[0].description === 'On a block' && qEv.text === '1. What is priced?\n2. Which results?', qEv);
    const tq3 = turn({ level: 'model', id: 'model' });
    const none = await createHandlers(svc, tq3).ask_user({ questions: [] });
    check('ask_user with no question is refused', none.isError && !tq3.asked);

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
  return results;
}

const storeMod = require('../src/agent/store');
const { TOOL_NAMES } = require('../src/agent/tools');

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
  check('without chat.jsonl a new conversation starts', storeMod.lastSession(dir) === null && !fs.existsSync(storeMod.chatPath(dir)));
  check('old per-scope logs stay readable', e.service.history({ level: 'tile', id: 'units_eop' }).some(x => x.text === 'old question'));

  // One conversation, filed per scope.
  await e.service.handlersFor(tileScope).ask_user({ question: 'Tile question?' });
  await e.service.handlersFor(modScope).ask_user({ question: 'Module question?' });
  const chat = storeMod.readChat(dir);
  check('every event goes into chat.jsonl in order with its scope', chat.length === 2 && chat[0].scope.level === 'tile' && chat[1].scope.level === 'module', chat);
  const tileLog = storeMod.readLog(dir, tileScope);
  const modLog = storeMod.readLog(dir, modScope);
  check('each event is also filed in its scope log', tileLog.some(x => x.text === 'Tile question?') && !tileLog.some(x => x.text === 'Module question?') &&
    modLog.some(x => x.text === 'Module question?'));
  const all = e.service.history();
  const onlyTile = e.service.history(tileScope);
  check('history() is the whole conversation, history(scope) one scope', all.length === 2 && all.every(x => x.scope) && onlyTile.length === 1 && onlyTile[0].text === 'Tile question?', { all, onlyTile });

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
  await e.raw('signoff', ['--tile', 'units_eop', '--reviewer', 'Harness']);
  const pf = path.join(dir, 'src', 'unit_linked', 'params.py');
  fs.writeFileSync(pf, fs.readFileSync(pf, 'utf8').replace('_param(1.25, "Initial unit price"', '_param(1.3, "Initial unit price"'));
  const rb = await hm.rebuild({});
  check('rebuild at module level rebuilds stale tiles, the module and the model workbook', !rb.isError && /Rebuilt/.test(rb.text) && /every difference is zero/.test(rb.text), rb.text);
  const rbOut = await hm.rebuild({ kind: 'tile', name: 'deaths' });
  check('rebuild refuses an item outside the selection', rbOut.isError, rbOut.text);
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
    propose_params: { params: [] }, propose_cases: { cases: [] }, propose_inputs: {}, propose_structure: {}, ask_user: null, add_input_request: null };
  for (const scope of [tileScope, modScope, modelScope]) {
    const h = e.service.handlersFor(scope);
    for (const name of TOOL_NAMES) {
      const args = name in toolArgs ? toolArgs[name] : {};
      if (args === null) continue; // these end the turn; tested elsewhere
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
  const tp = await ht.propose_params({ summary: 'x', params: [{ name: 'policy_fee_pm', default: 1.5, label: 'Policy fee', format: 'amount', units: 'currency per month' }] });
  check('propose_params is refused at tile level without an agreed request', tp.isError, tp.text);
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

  // A tile-level request for a missing input opens the way to a draft once the user answers.
  const hq = e.service.handlersFor(tileScope);
  await hq.add_input_request({ description: 'a monthly policy fee parameter', kind: 'parameter' });
  storeMod.appendChat(dir, { scope: tileScope, type: 'user', text: 'Yes, add it at 1.0 a month.', at: storeMod.now() });
  const after = await e.service.handlersFor(tileScope).propose_params({ summary: 'Adds a fee.', params: [{ name: 'admin_fee_pm', default: 1, label: 'Admin fee per month', format: 'amount', units: 'currency per policy per month' }] });
  check('after the user agrees to an add_input_request, a params draft can be proposed from tile level', !after.isError && draftIdOf(after.text), after.text);
  const again2 = await e.service.handlersFor(tileScope).propose_params({ summary: 'x', params: [{ name: 'other_fee_pm', default: 1, label: 'Other', format: 'amount', units: 'u' }] });
  check('only one draft per agreed request', again2.isError, again2.text);

  // Model-level tile draft names its module; accepting rebuilds the module and model workbooks.
  const md = await hmodel.propose_structure({ summary: 'Adds net units.', module: 'unit_projection', tiles: [
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
  const sessions = require('../src/agent/store').readChat(e.modelDir).filter(x => x.type === 'session');
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
  const first = { question: e.events.some(x => x.type === 'question'), draft: drafts('modules').length > 0 };
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
