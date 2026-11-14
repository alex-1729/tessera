'use strict';
// Live end-to-end test against the real tilekit commands and the real model, on a temporary COPY of model/.
// Run from app/: ./node_modules/.bin/electron test/live.js
process.env.APP_NO_AUTOSTART = '1';
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const REAL_MODEL = path.resolve(__dirname, '../../model');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tilekit-live-'));
const copy = path.join(tmp, 'model');
process.env.APP_TILEKIT_PROJECT = REAL_MODEL;

const summary = { checks: [], shots: [], errors: [] };
let ctl = null, finished = false;
const hard = setTimeout(() => { summary.errors.push('hard timeout'); finish(2); }, 12 * 60 * 1000);

function finish(code) {
  if (finished) return; finished = true;
  clearTimeout(hard);
  summary.passed = summary.checks.filter(c => c.ok).length;
  summary.failed = summary.checks.filter(c => !c.ok).length;
  try { ctl && ctl.shutdown(); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(JSON.stringify(summary, null, 1));
  app.exit(summary.failed || code ? (code || 1) : 0);
}
const check = (name, ok, detail) => { summary.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); };

function copyModel() {
  const skip = /(^|\/)(\.venv|__pycache__|real-data|\.pytest_cache)(\/|$)/;
  fs.cpSync(REAL_MODEL, copy, { recursive: true, filter: src => !skip.test(path.relative(REAL_MODEL, src).split(path.sep).join('/')) });
  fs.rmSync(path.join(copy, 'review'), { recursive: true, force: true });   // start with nothing built
  fs.mkdirSync(path.join(copy, 'review'));
}

function listFiles(dir) {   // path -> mtime, for "nothing was written here"
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.statSync(p).mtimeMs;
  } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

(async () => {
  copyModel();
  const pickQueue = [];
  const settingsFile = path.join(tmp, 'settings.json');
  ctl = await require('../src/main').start({ show: true, settingsFile, modelDir: copy, pickCsv: async () => pickQueue.shift() || null });
  const win = ctl.win;
  win.webContents.on('console-message', (...a) => { const m = a[0] && a[0].message !== undefined ? a[0] : { level: a[1], message: a[2] }; if (m.level === 'error' || m.level === 3) summary.errors.push('console: ' + String(m.message).slice(0, 300)); });
  const ev = js => win.webContents.executeJavaScript(js, true);
  const waitFor = async (js, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await ev(js); if (v) return v; } catch { /* retry */ } await sleep(100); } return false; };
  const text = () => ev('document.getElementById("left").innerText');
  const idle = async () => { await ev('window.__app.idle()'); await waitFor('document.getElementById("working").hidden', 60000); await ev('window.__app.idle()'); };
  const has = async (name, needle) => { const t = await text(); check(name, t.includes(needle), `missing "${needle}" in: ${t.slice(0, 400)}`); };
  const hasNot = async (name, needle) => { const t = await text(); check(name, !t.includes(needle), `unexpected "${needle}"`); };
  const shot = async name => { await sleep(300); const img = await win.webContents.capturePage(); const f = path.join(OUT, name + '.png'); fs.writeFileSync(f, img.toPNG()); summary.shots.push(f); };
  const go = async hash => {
    await ev(`location.hash=${JSON.stringify(hash)}`);
    await waitFor(`(()=>{const h=location.hash;const t=document.getElementById(h.startsWith('#/tile/')?'tilename':'title');return t&&(h.startsWith('#/tile/')?h.endsWith('/'+t.textContent):true)&&document.getElementById('crumbs').textContent.length>0})()`);
    await idle(); await sleep(300);
  };
  const click = async id => { await ev(`document.getElementById(${JSON.stringify(id)}).click()`); };
  const gc = js => ev(`(async()=>{const g=document.querySelector('#gridhost iframe').contentWindow.gridcraft; return await (${js})(g)})()`);
  const inspect = () => gc('async g => { const d = await g.docInspect(); return { sheets: d.sheets.map(s => s.name), active: d.sheets[d.activeSheet] && d.sheets[d.activeSheet].name, title: d.title }; }');
  const waitSheets = async (pred, ms = 15000) => { const t = Date.now(); let last; while (Date.now() - t < ms) { try { last = await inspect(); if (pred(last)) return last; } catch { /* retry */ } await sleep(150); } return { fail: true, last }; };
  const S = () => ev('JSON.parse(JSON.stringify({tiles: window.__app.S.status.tiles, modules: window.__app.S.status.modules, model: window.__app.S.status.model, cases: window.__app.S.cases, runs: window.__app.S.runs, real: window.__app.S.real}))');
  const tk = (cmd, args = []) => ev(`window.api.tk(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  const setField = (id, v) => ev(`(()=>{const e=document.getElementById(${JSON.stringify(id)}); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`);

  async function signoffTile(name) {
    await go('#/tile/' + name);
    await click('signoff');
    const opened = await waitFor('!!document.getElementById("dialog")');
    const canConfirm = await ev('!!document.getElementById("confirm")');
    if (!opened || !canConfirm) { check('sign off ' + name, false, await ev('document.body.innerText.slice(0,600)')); await click('cancel').catch(() => {}); return false; }
    await ev('document.querySelectorAll("#dialog input[type=checkbox]").forEach(c => c.click())');
    await ev('document.getElementById("comment").value = "Live test"');
    const enabled = await waitFor('!document.getElementById("confirm").disabled', 3000);
    await click('confirm');
    const ok = enabled && await waitFor(`document.getElementById('sentence') && document.getElementById('sentence').textContent.startsWith('Signed off')`, 30000);
    check('sign off ' + name, ok, await text());
    await idle();
    return ok;
  }

  const unitsFile = path.join(copy, 'src/unit_linked/liability/units.py');
  const paramsFile = path.join(copy, 'src/unit_linked/params.py');
  const unitsOrig = fs.readFileSync(unitsFile, 'utf8');
  const paramsOrig = fs.readFileSync(paramsFile, 'utf8');

  check('app ready', await waitFor('window.__app && window.__app.ready', 30000));
  check('gridcraft:ready', await waitFor('window.__gridLog.ready >= 1', 30000));

  // ------------------------------------------------------------ Part 1: the synthetic review flow
  await go('#/model');
  await has('model: name', 'Unit-linked pricing');
  await has('model: nothing built yet', 'Rebuild stale (32)');
  check('model: no workbook before the first build', await ev('!document.getElementById("nogrid").hidden && document.getElementById("nogrid").innerText.includes("No workbook yet")'));
  await shot('live-model-unbuilt');
  await click('rebuild');
  check('model: Rebuild stale builds tiles, modules and model', await waitFor(`document.getElementById('rebuild') && document.getElementById('rebuild').innerText==='Rebuild stale (0)'`, 120000), await text());
  await idle();
  check('model: workbook shown after build', await waitFor('window.__gridLog.opens.length >= 1', 20000));
  let st = await S();
  check('every tile built, none unbuilt', Object.values(st.tiles).every(t => t.state === 'built') && Object.keys(st.tiles).length >= 20, JSON.stringify(Object.values(st.tiles).map(t => t.state)));
  const caseNames = st.cases.map(c => c.name);
  let ins = await waitSheets(i => i.sheets.includes('Profit'));
  check('model workbook sheets: Inputs, modules in order, Scratch', !ins.fail && ins.sheets[0] === 'Inputs' && ['Unit projection', 'Decrements', 'Cashflows', 'Quota share', 'Profit'].every(n => ins.sheets.includes(n)), JSON.stringify(ins));
  await has('model: sentence', 'Not signed off. 0 of 5 modules signed off');
  await has('model: checks listed', 'Workbook agrees with Python');
  // selecting a case on the model view builds and shows that case's model workbook
  await ev(`document.querySelector('a[data-case="high_charge"]').click()`);
  check('model: selecting High charge opens workbook-high_charge.xlsx', await waitFor(`window.__gridLog.opens.some(p => p.endsWith('workbook-high_charge.xlsx'))`, 60000), await ev('JSON.stringify(window.__gridLog.opens)'));
  await idle();
  await ev(`document.querySelector('a[data-case="${st.cases[0].id}"]').click()`); await idle();
  await shot('live-model');

  await go('#/module/decrements');
  ins = await waitSheets(i => i.sheets.length > 1 && i.sheets.includes('Scratch'));
  check('module workbook: one sheet per case plus Scratch', !ins.fail && caseNames.every(n => ins.sheets.includes(n)) && ins.sheets.includes('Scratch'), JSON.stringify(ins));
  await ev(`document.querySelector('a[data-case="high_charge"]').click()`);
  check('module: selecting a case activates its sheet', (await waitSheets(i => i.active === 'High charge')).active === 'High charge', JSON.stringify(await inspect()));
  await shot('live-module');

  await go('#/tile/units_amc');
  ins = await waitSheets(i => i.sheets.includes('Scratch'));
  check('tile workbook: one sheet per case plus Scratch', !ins.fail && caseNames.every(n => ins.sheets.includes(n)), JSON.stringify(ins));
  await ev(`document.querySelector('a[data-case="zero_premium"]').click()`);
  check('tile: selecting a case activates its sheet', (await waitSheets(i => i.active === 'Zero premium')).active === 'Zero premium', JSON.stringify(await inspect()));
  await has('tile: sentence', 'Not signed off. Differences are zero in');
  await shot('live-tile');

  // sign off
  await signoffTile('units_amc');
  await has('tile: signed-off sentence', 'Signed off by');
  await shot('live-tile-signed');
  await signoffTile('units_eop');
  await go('#/module/unit_projection');
  check('module map shows the tile as signed off', await ev(`(()=>{const a=[...document.querySelectorAll('svg.map a')].find(a=>a.textContent.includes('units_amc')); return !!a && a.textContent.includes('signed off')})()`));
  await has('module: sentence counts sign-offs', '2 of 4 tiles signed off');

  // edit the tile's Python on disk; the watcher alone must bring the change into the window
  await go('#/tile/units_amc');
  const loadsBefore = await ev('window.__gridLog.opens.length');
  fs.writeFileSync(unitsFile, unitsOrig
    .replace('def units_amc(units_after_alloc, amc_pm, amc_cap_units):', 'def units_amc(units_after_alloc, amc_pm, amc_cap_units, allocation_rate):')
    .replace('return np.minimum(units_after_alloc * amc_pm, amc_cap_units)', 'return np.minimum(units_after_alloc * amc_pm * allocation_rate, amc_cap_units)'));
  check('edit on disk: tile becomes stale with formula drift', await waitFor(`document.getElementById('sentence').textContent.includes("Stale: this tile's formula changed since sign-off.")`, 30000), await text());
  check('edit on disk: workbook is out of date line', await waitFor(`!document.getElementById('stalebar').hidden && document.getElementById('stalebar').innerText.includes('This workbook is out of date')`, 10000));
  await shot('live-tile-stale');
  await go('#/tile/units_eop');
  await has('downstream signed tile shows values drift', 'Stale: upstream values changed since sign-off.');
  await go('#/tile/units_amc');
  await click('rebuild');
  check('rebuild: Was and Now formulas appear', await waitFor(`!!document.getElementById('changed') && document.querySelector('.was') && document.querySelector('.was').textContent.includes('MIN(units_after_alloc*amc_pm,amc_cap_units)') && document.querySelector('.now').textContent.includes('allocation_rate')`, 60000), await text());
  await idle();
  check('rebuild: out of date line gone', await ev('document.getElementById("stalebar").hidden'));
  check('rebuild: new workbook loaded in the grid', await ev('window.__gridLog.opens.length') > loadsBefore);
  st = await S();
  check('rebuild: workbook current, still stale by drift', st.tiles.units_amc.workbook_current === true && st.tiles.units_amc.drift === 'formula' && st.tiles.units_amc.state === 'stale', JSON.stringify(st.tiles.units_amc));
  await shot('live-tile-rebuilt');

  // revert, rebuild, sign off a small module and the module
  fs.writeFileSync(unitsFile, unitsOrig);
  await waitFor(`document.getElementById('sentence').textContent.startsWith('Signed off') || !document.getElementById('stalebar').hidden`, 30000);
  await idle();
  await go('#/module/unit_projection');
  await click('rebuild');
  check('revert then Rebuild stale', await waitFor(`document.getElementById('rebuild').innerText==='Rebuild stale (0)'`, 60000), await text());
  await idle();
  st = await S();
  check('after revert and rebuild every unit_projection workbook is current', ['units_allocated', 'units_after_alloc', 'units_amc', 'units_eop'].every(t => st.tiles[t].workbook_current === true) && st.modules.unit_projection.workbook_current === true, JSON.stringify(Object.fromEntries(['units_amc', 'units_eop'].map(t => [t, [st.tiles[t].state, st.tiles[t].workbook_current]]))));
  for (const t of ['deaths', 'lapses', 'in_force_eop']) await signoffTile(t);
  await go('#/module/decrements');
  await has('module: 3 of 3 tiles', '3 of 3 tiles signed off');
  await click('signoff');
  await waitFor('!!document.getElementById("dialog")');
  check('module sign-off dialog can be confirmed', await ev('!!document.getElementById("confirm")'), await ev('document.getElementById("dialog").innerText'));
  await click('confirm');
  check('module sentence after sign-off', await waitFor(`document.getElementById('sentence').textContent.startsWith('Signed off by')`, 30000), await text());
  await idle();
  await shot('live-module-signed');
  await go('#/model');
  await has('model: one module signed off', '1 of 5 modules signed off');

  // values-only drift from a parameter default
  fs.writeFileSync(paramsFile, paramsOrig.replace('_param(0.06,', '_param(0.07,'));
  await go('#/module/decrements');
  check('param change: decrements tiles show stale values drift', await waitFor(`(()=>{const s=window.__app.S.status.tiles; return ['deaths','lapses','in_force_eop'].some(t=>s[t].state==='stale' && s[t].drift==='values')})()`, 30000), JSON.stringify((await S()).tiles.lapses));
  await has('module: sentence stale', 'Stale');
  await click('rebuild');
  await waitFor(`document.getElementById('rebuild').innerText==='Rebuild stale (0)'`, 60000); await idle();
  st = await S();
  const drifted = ['deaths', 'lapses', 'in_force_eop'].filter(t => st.tiles[t].state === 'stale' && st.tiles[t].drift === 'values');
  check('after rebuild: values-only drift remains and checks pass', drifted.length > 0 && drifted.every(t => st.tiles[t].checks_pass !== false), JSON.stringify(drifted.map(t => st.tiles[t])));
  const reconfLabel = await ev('document.getElementById("reconfirm").innerText');
  check('re-confirm button offers the drifted tiles', new RegExp(`Re-confirm values-only \\((${drifted.length})\\)`).test(reconfLabel), reconfLabel);
  await shot('live-module-values-drift');
  await click('reconfirm');
  check('re-confirm: tiles return to signed off', await waitFor(`['deaths','lapses','in_force_eop'].every(t=>window.__app.S.status.tiles[t].state==='signed_off')`, 60000), JSON.stringify((await S()).tiles.lapses));
  await idle();
  await has('module sentence after re-confirm', '3 of 3 tiles signed off');

  // tests and export
  await go('#/model');
  await click('runtests');
  check('Run tests shows the named invariant checks', await waitFor(`document.getElementById('left').innerText.includes('Zero premium gives zero units') && document.getElementById('left').innerText.includes('Units never negative [base]')`, 180000), (await text()).slice(0, 500));
  await idle();
  await has('Run tests: model tests line', 'Model tests pass');
  await shot('live-checks');
  const xl = path.join(tmp, 'export.xlsx');
  await tk('export', ['--out', xl]);
  const xb = fs.readFileSync(xl);
  const zipEntries = xb.toString('latin1');
  check('export is a valid xlsx', xb.length > 5000 && xb.slice(0, 2).toString() === 'PK' && zipEntries.includes('xl/workbook.xml') && zipEntries.includes('[Content_Types].xml'), String(xb.length));

  // ------------------------------------------------------------ Part 2: real model points
  await go('#/model');
  await has('Runs section: none yet', 'No runs yet.');
  check('no Real model points list before any run', !(await text()).includes('Real model points'));
  // a CSV with a bad value: the run is refused and the rows are listed in the dialog
  const bad = path.join(tmp, 'bad.csv');
  fs.writeFileSync(bad, 'policy_id,premium_pm,premium_months,age_at_entry,sum_assured\nA1,100,120,40,50000\nA2,abc,120,41,50000\nA3,100,120,42,60000\n');
  pickQueue.push(bad);
  await click('newrun');
  await waitFor('!!document.getElementById("f-name")', 10000);
  await setField('f-name', 'badrun');
  await click('confirm');
  check('bad CSV: rows listed in the dialog', await waitFor(`document.getElementById('dialogerrors').innerText.includes('Row 3, premium_pm')`, 30000), await ev('document.getElementById("dialog").innerText'));
  await shot('live-real-bad-csv');
  await click('cancel');
  check('bad CSV: no run created', (await tk('runs')).runs.length === 0);

  await click('sample');
  await waitFor('!!document.getElementById("f-n")', 10000);
  check('sample dialog says it is synthetic data', (await ev('document.getElementById("dialog").innerText')).includes('synthetic data for trying the feature'));
  await shot('live-real-sample-dialog');
  await setField('f-n', '300'); await setField('f-name', 'sample');
  await click('confirm');
  check('sample portfolio: run created', await waitFor(`!document.getElementById('dialog') && document.getElementById('runs') && document.getElementById('runs').innerText.includes('sample')`, 120000), await text());
  await idle();
  const runsTxt = await ev('document.getElementById("runs").innerText');
  check('Runs table: name, policies, date, current', runsTxt.includes('sample') && runsTxt.includes('300') && runsTxt.includes('current') && /\d{4}-\d{2}-\d{2}/.test(runsTxt), runsTxt);
  check('sample CSV is under real-data/ in the model copy', fs.existsSync(path.join(copy, 'real-data/sample.csv')));
  // a second run from a picked CSV
  pickQueue.push(path.join(copy, 'real-data/sample.csv'));
  await click('newrun');
  await waitFor('!!document.getElementById("f-name")', 10000);
  check('new run dialog offers the file name as the run name', await ev('document.getElementById("f-name").value') === 'sample' && await ev('document.getElementById("f-idcol").value') === 'policy_id');
  await setField('f-name', 'second');
  await click('confirm');
  check('second run created', await waitFor(`!document.getElementById('dialog') && document.getElementById('runs').innerText.includes('second')`, 60000));
  await idle();
  check('run selector appears with two runs', await ev(`!!document.getElementById('prun') && document.getElementById('prun').options.length===2`));
  await setField('prun', 'sample'); await idle();
  await waitFor(`document.getElementById('pagecount') && document.getElementById('pagecount').textContent.includes('of 300')`, 20000);
  await shot('live-real-list');

  // list: 15 per page, sort, flag, search, paging
  const rows = () => ev(`[...document.querySelectorAll('#policylist a[data-policy]')].map(a => a.dataset.policy)`);
  check('policy list: 15 rows, "1 to 15 of 300"', (await rows()).length === 15 && (await ev('document.getElementById("pagecount").textContent')) === '1 to 15 of 300', await ev('document.getElementById("pagecount").textContent'));
  const sortOpts = await ev(`[...document.getElementById('psort').options].map(o => o.value)`);
  check('sort options include model point fields and headline keys', ['sum_assured', 'age_at_entry', 'pv_net_profit', 'profit_margin'].every(k => sortOpts.includes(k)), JSON.stringify(sortOpts));
  await setField('psort', 'pv_net_profit'); await setField('pdir', 'desc');
  const wantTop = (await tk('policies', ['--run', 'sample', '--sort', 'pv_net_profit', '--desc', '--limit', '3'])).policies.map(p => p.id);
  check('sorted descending by pv_net_profit', await waitFor(`document.querySelector('#policylist a[data-policy]') && document.querySelector('#policylist a[data-policy]').dataset.policy===${JSON.stringify(wantTop[0])}`, 20000), JSON.stringify([wantTop, await rows()]));
  check('rows show the id and the sorted-by value', await ev(`(()=>{const r=document.querySelector('#policylist .row'); return r.children.length===2 && /\\d/.test(r.children[1].textContent)})()`));
  await setField('pflag', 'nan');
  const nanTotal = (await tk('policies', ['--run', 'sample', '--flag', 'nan', '--limit', '1'])).total;
  check('flag filter: has missing values', await waitFor(`document.getElementById('pagecount').textContent.endsWith('of ${nanTotal}')`, 20000), await ev('document.getElementById("pagecount").textContent'));
  await setField('pflag', '');
  await setField('psearch', 'P000138');
  check('search by policy id', await waitFor(`document.getElementById('pagecount').textContent.endsWith('of 1') && document.querySelector('#policylist a[data-policy]').dataset.policy==='P000138'`, 20000), await ev('document.getElementById("pagecount").textContent'));
  await setField('psearch', ''); await setField('psort', 'index'); await setField('pdir', 'asc');
  await waitFor(`document.getElementById('pagecount').textContent==='1 to 15 of 300'`, 20000);
  await click('nextpage');
  check('Next page', await waitFor(`document.getElementById('pagecount').textContent==='16 to 30 of 300' && document.getElementById('prevpage').disabled===false`, 20000), await ev('document.getElementById("pagecount").textContent'));
  await click('prevpage'); await waitFor(`document.getElementById('pagecount').textContent==='1 to 15 of 300'`, 20000);
  await idle();

  // open one policy at model, module and tile level
  const reviewBefore = listFiles(path.join(copy, 'review'));
  await setField('psort', 'sum_assured'); await setField('pdir', 'desc');
  await waitFor(`document.getElementById('pagecount').textContent==='1 to 15 of 300'`, 20000); await idle();
  const topPolicy = (await rows())[0];
  const polId = topPolicy;
  await ev(`document.querySelector('#policylist a[data-policy="${polId}"]').click()`);
  check('model: real policy workbook opens', await waitFor(`window.__app.S.real && !!window.__app.S.real.policy && document.getElementById('realbar').hidden===false && window.__gridLog.opens.some(p=>p.startsWith('real-data/') && p.includes('${polId}') && p.includes('/model/'))`, 60000), JSON.stringify(await ev('window.__gridLog.opens')));
  await idle();
  check('real line and buttons above the spreadsheet', await ev(`(()=>{const b=document.getElementById('realbar'); return b.innerText.includes('Real data. Not part of sign-off, and kept out of the repo.') && !!document.getElementById('promote') && !!document.getElementById('backtocases')})()`), await ev('document.getElementById("realbar").innerText'));
  await has('model: sentence names the policy and run', `Showing real data: policy ${polId}, run sample.`);
  check('model: stale bar hidden while showing real data', await ev('document.getElementById("stalebar").hidden'));
  ins = await waitSheets(i => i.sheets.includes('Profit'));
  check('model-level real workbook is the model layout', !ins.fail && ins.sheets.includes('Inputs') && ins.sheets.includes('Profit'), JSON.stringify(ins));
  await shot('live-real-model');

  await go('#/module/decrements');
  ins = await waitSheets(i => i.sheets.includes('Policy ' + polId));
  check('module: sheet is named Policy <ID>', !ins.fail && ins.active === 'Policy ' + polId, JSON.stringify(ins));
  check('module: real line visible', await ev(`document.getElementById('realbar').hidden===false && document.getElementById('realbar').innerText.includes('Real data. Not part of sign-off')`));
  await has('module: sentence names the policy', `Showing real data: policy ${polId}, run sample.`);
  check('module: workbook path is under real-data/', await ev(`window.__gridLog.opens.some(p=>p.startsWith('real-data/runs/sample/policies/${polId}/modules/decrements/'))`));
  await shot('live-real-module');

  await go('#/tile/deaths');
  ins = await waitSheets(i => i.sheets.includes('Policy ' + polId));
  check('tile: sheet is named Policy <ID>', !ins.fail && ins.active === 'Policy ' + polId, JSON.stringify(ins));
  check('tile: real line visible', await ev(`document.getElementById('realbar').hidden===false`));
  await has('tile: sign-off and rebuild buttons still act on the cases', 'Sign off…');
  check('selection kept across views', (await S()).real && (await S()).real.policy === polId);
  await shot('live-real-tile');
  // an edit to a real-data workbook is saved under real-data/ and nothing is written under review/
  const savesBefore = await ev('window.__gridLog.saves');
  await gc(`async g => g.execute('sheet.activate', { sheet: 'Scratch' })`);
  await gc(`async g => g.execute('cell.set', { cell: 'T2', input: 'scratch note' })`);
  check('autosave of a real-data workbook (Scratch sheet)', await waitFor(`window.__gridLog.saves > ${savesBefore}`, 9000));
  const reviewAfter = listFiles(path.join(copy, 'review'));
  check('nothing under review/ was written for the real policy', JSON.stringify(reviewAfter) === JSON.stringify(reviewBefore), 'review listing changed');
  const realFiles = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else realFiles.push(p); } })(path.join(copy, 'real-data'));
  check('real workbooks are all under real-data/', realFiles.some(f => f.endsWith(`${polId}/tiles/deaths/workbook.xlsx`)));

  // Back to cases
  await click('backtocases');
  check('Back to cases returns to the case workbook', await waitFor(`document.getElementById('realbar').hidden && !window.__app.S.real`, 20000));
  await idle();
  await hasNot('no real-data sentence after Back to cases', 'Showing real data');
  ins = await waitSheets(i => i.sheets.includes('Scratch') && i.sheets.length > 2);
  check('cases workbook is back in the grid', !ins.fail && caseNames.every(n => ins.sheets.includes(n)), JSON.stringify(ins));

  // promote
  await go('#/model');
  await ev(`document.querySelector('#policylist a[data-policy="${polId}"]').click()`);
  await waitFor(`document.getElementById('realbar').hidden===false`, 30000); await idle();
  const mpRaw = (await tk('policies', ['--run', 'sample', '--search', polId, '--limit', '1'])).policies[0].model_point;
  await click('promote');
  await waitFor('!!document.getElementById("f-id")', 10000);
  const pd = await ev('document.getElementById("dialog").innerText');
  check('promote dialog shows the values and the rounding note', Object.keys(mpRaw).every(k => pd.includes(k)) && pd.includes('three significant figures'), pd);
  await shot('live-real-promote');
  await setField('f-id', 'live_promoted'); await setField('f-name', 'Live promoted'); await setField('f-purpose', 'Made by the live test');
  await click('confirm');
  check('promote: dialog closes and returns to cases', await waitFor(`!document.getElementById('dialog') && !window.__app.S.real && document.getElementById('realbar').hidden`, 120000), await ev('document.body.innerText.slice(0,500)'));
  await idle();
  check('promote: case file written', fs.existsSync(path.join(copy, 'cases/live_promoted.json')));
  await has('promote: new case is listed', 'Live promoted');
  await has('promote: plain notice', 'Case Live promoted created.');
  const mpCase = JSON.parse(fs.readFileSync(path.join(copy, 'cases/live_promoted.json'), 'utf8')).model_point;
  check('promoted case has rounded model point values', Object.keys(mpRaw).every(k => k in mpCase && Math.abs(mpCase[k] - mpRaw[k]) <= Math.abs(mpRaw[k]) * 0.006 + 1e-9), JSON.stringify([mpRaw, mpCase]));
  await shot('live-real-promoted');
  const runsNow = await ev('document.getElementById("runs").innerText');
  check('Runs table: model changed since this run', runsNow.includes('model changed since this run'), runsNow);
  await go('#/tile/deaths');
  // a new case makes sign-offs stale until a rebuild; after it they return with the case listed as new
  await click('rebuild'); await sleep(500); await idle();
  await waitFor(`document.getElementById('sentence').textContent.startsWith('Signed off')`, 60000);
  await has('signed-off tile shows the new case', 'New case to review: Live promoted');
  await go('#/module/decrements');
  const ms = (await S()).modules.decrements;
  check('module status lists the new case', Array.isArray(ms.new_cases) ? ms.new_cases.includes('live_promoted') : true, JSON.stringify(ms.new_cases));
  await shot('live-real-promoted-tile');

  check('no console errors', summary.errors.filter(e => e.startsWith('console:')).length === 0, JSON.stringify(summary.errors));
  const log = await ev('window.__gridLog');
  summary.gridLog = { ready: log.ready, opens: log.opens.length, saves: log.saves };
  finish(0);
})().catch(e => { summary.errors.push(String(e && e.stack || e)); finish(1); });
app.on('window-all-closed', () => {});
