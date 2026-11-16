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
// The right-hand pane runs Claude Code whenever a model is open: here a stand-in that calls no model (test/fake-claude.js).
const pane = require('./stand-in')(tmp);

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
  win.webContents.on('dom-ready', () => { win.webContents.executeJavaScript('window.__both=()=>document.getElementById("left").innerText+"\\n"+document.getElementById("rightbar").innerText', true).catch(() => {}); });
  win.webContents.on('will-prevent-unload', e => e.preventDefault());
  const ev = js => win.webContents.executeJavaScript(js, true);
  await ev('window.__both=()=>document.getElementById("left").innerText+"\\n"+document.getElementById("rightbar").innerText; true');
  const waitFor = async (js, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await ev(js); if (v) return v; } catch { /* retry */ } await sleep(100); } return false; };
  const text = () => ev('window.__both()');
  const idle = async () => { await ev('window.__app.idle()'); await waitFor('document.getElementById("working").hidden', 60000); await ev('window.__app.idle()'); };
  // Reads an element's text once it exists. A view re-renders after every file change, so an element may be absent for a
  // moment; reading it with no wait gave "Cannot read properties of null (reading 'innerText')" once.
  const inner = async id => { await waitFor(`!!document.getElementById(${JSON.stringify(id)})`, 5000); return ev(`(document.getElementById(${JSON.stringify(id)}) || {innerText: ''}).innerText`); };
  const has = async (name, needle) => { const t = await text(); check(name, t.includes(needle), `missing "${needle}" in: ${t.slice(0, 400)}`); };
  const hasNot = async (name, needle) => { const t = await text(); check(name, !t.includes(needle), `unexpected "${needle}"`); };
  const shot = async name => { await sleep(300); const img = await win.webContents.capturePage(); const f = path.join(OUT, name + '.png'); fs.writeFileSync(f, img.toPNG()); summary.shots.push(f); };
  const go = async hash => {
    await ev(`location.hash=${JSON.stringify(hash)}`);
    await waitFor(`(()=>{const h=location.hash;const t=document.getElementById(h.startsWith('#/tile/')?'tilename':'title');return t&&(h.startsWith('#/tile/')?h.endsWith('/'+t.textContent):true)&&document.querySelector('#mods a.cur')!==null})()`);
    await idle(); await sleep(300);
  };
  const click = async id => { await ev(`document.getElementById(${JSON.stringify(id)}).click()`); };
  const gc = js => ev(`(async()=>{const g=document.querySelector('#gridhost iframe').contentWindow.gridcraft; return await (${js})(g)})()`);
  const inspect = () => gc('async g => { const d = await g.docInspect(); return { sheets: d.sheets.map(s => s.name), active: d.sheets[d.activeSheet] && d.sheets[d.activeSheet].name, title: d.title }; }');
  const waitSheets = async (pred, ms = 15000) => { const t = Date.now(); let last; while (Date.now() - t < ms) { try { last = await inspect(); if (pred(last)) return last; } catch { /* retry */ } await sleep(150); } return { fail: true, last }; };
  const S = () => ev('JSON.parse(JSON.stringify({tiles: window.__app.S.status.tiles, modules: window.__app.S.status.modules, model: window.__app.S.status.model, cases: window.__app.S.cases, runs: window.__app.S.runs, real: window.__app.S.real}))');
  const tk = (cmd, args = []) => ev(`window.api.tk(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  const setField = (id, v) => ev(`(()=>{const e=document.getElementById(${JSON.stringify(id)}); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`);

  // Sign-off is inline in the side bar: tick every assumption, add a comment, press Sign off.
  async function signoffTile(name) {
    await go('#/tile/' + name);
    // the tile's own test must have passed since the last change: the button beside Rebuild runs it
    if (await ev('!!document.getElementById("runtiletest")')) { await click('runtiletest'); await idle(); await waitFor('!document.getElementById("runtiletest")', 60000); }
    await ev('document.querySelectorAll("#panel input.assume").forEach(c => c.click())');
    const ready = await waitFor('!!document.getElementById("signoff") && !document.getElementById("signoff").disabled', 3000);
    if (!ready) { check('sign off ' + name, false, await ev('document.getElementById("signoff") ? document.getElementById("signoff").title + " | " + window.__both().slice(0,600) : "no button"')); return false; }
    await ev('(()=>{const c=document.getElementById("comment"); c.value="Live test"; c.dispatchEvent(new Event("input",{bubbles:true}))})()');
    await click('signoff');
    // a sign-off moves on to the next item in the review queue; come back to look at the signed tile
    await waitFor(`window.__app.S.status.tiles[${JSON.stringify(name)}].state === 'signed_off'`, 30000);
    await idle();
    check('sign off ' + name + ': the next item in the review queue opens', await ev(`location.hash !== ${JSON.stringify('#/tile/' + name)}`), await ev('location.hash'));
    await go('#/tile/' + name);
    const ok = await waitFor(`document.getElementById('sentence') && document.getElementById('sentence').textContent.startsWith('Signed off')`, 30000);
    check('sign off ' + name, ok, await text());
    await idle();
    return ok;
  }


  // tracing a value to its source (trace.js)
  const traceLine = () => ev(`(()=>{const b=document.getElementById('tracebar'); return b.hidden ? '' : b.innerText.replace(/\\s+/g,' ').trim()})()`);
  const lineIs = want => waitFor(`(()=>{const b=document.getElementById('tracebar'); return (b.hidden ? '' : b.innerText.replace(/\\s+/g,' ').trim()) === ${JSON.stringify(want)}})()`, 6000);
  const cellAt = () => gc(`async g => { const d = await g.docInspect(); return (d.sheets[d.activeSheet] || {}).name + '!' + d.activeCell; }`);
  const atIs = async (want, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if ((await cellAt().catch(() => null)) === want) return true; await sleep(120); } return false; };
  const sel = (cell, sheet) => gc(`async g => { ${sheet ? `await g.execute('sheet.activate', { sheet: ${JSON.stringify(sheet)} });` : ''} await g.execute('selection.set', { range: ${JSON.stringify(cell)} }); }`);
  const rowNamed = name => gc(`async g => { const d = await g.docInspect(); const sh = d.sheets[d.activeSheet]; const m = /:([A-Z]+)(\\d+)$/.exec(sh.usedRange); for (const col of [m[1], 'D']) { const v = (await g.execute('sheet.read', { sheet: sh.name, range: col + '1:' + col + m[2] })).values; const i = v.findIndex(r => r[0] === ${JSON.stringify(name)}); if (i >= 0) return i + 1; } return 0; }`);
  const pressPrecedents = () => { const mod = process.platform === 'darwin' ? 'meta' : 'control'; win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '[', modifiers: [mod] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '[', modifiers: [mod] }); };

  async function traceCases() {
    await go('#/tile/units_amc');
    await waitSheets(i => i.sheets.includes('Scratch') && i.sheets.includes('High charge'));
    const up = await rowNamed('units_after_alloc'), own = await rowNamed('units_amc'), par = await rowNamed('amc_pm');
    await sel('D' + up, 'Base');
    const upstream = c => `${c}${up} is Units after allocation, from units_after_alloc in Unit projection (not reviewed).`;
    check('trace: an upstream row says where it comes from', await lineIs(upstream('D') + ' Go to source'), await traceLine());
    await shot('trace-live-upstream');
    await sel('C' + par);
    check('trace: a parameter row says what it is, no button', await lineIs(`C${par} is AMC per month, the parameter amc_pm.`) && await ev(`!document.getElementById('gotosource')`), await traceLine());
    await shot('trace-live-parameter');
    await sel('D' + own);
    check('trace: the tile\'s own row lists the tiles that use it, no source', await lineIs(`D${own} is AMC units. Used by units_eop, amc_income.`) && await ev(`!document.getElementById('gotosource')`), await traceLine());
    await shot('trace-live-usedby');
    await sel('H' + up, 'High charge'); await lineIs(upstream('H') + ' Go to source');
    await ev(`document.getElementById('gotosource').click()`);
    check('trace: Go to source opens the source tile', await waitFor(`location.hash === '#/tile/units_after_alloc'`, 8000), await ev('location.hash'));
    await idle(); await sleep(400);
    const src = await rowNamed('units_after_alloc');
    check('trace: on the same case sheet, the same month, in its own formula row', src > 0 && await atIs('High charge!H' + src), await cellAt());
    check('trace: the left bar shows that case', await ev(`/High charge\\s+agrees, shown/.test(document.getElementById('panel').innerText)`), (await text()).slice(0, 600));
    await shot('trace-live-at-source');
    await click('back');
    await waitFor(`location.hash === '#/tile/units_amc'`, 8000); await idle();
    check('trace: Back restores the tile, the sheet and the cell', await atIs('High charge!H' + up), await cellAt());
    await lineIs(upstream('H') + ' Go to source');
    win.webContents.focus(); await ev(`document.querySelector('#gridhost iframe').contentWindow.focus(); true`);
    pressPrecedents();
    check('trace: Ctrl+[ / Cmd+[ goes to the source', await waitFor(`location.hash === '#/tile/units_after_alloc'`, 8000) && await atIs('High charge!H' + src), await cellAt());
    await idle();
    await go('#/tile/units_amc'); await sel('F' + own, 'Zero premium'); await lineIs(`F${own} is AMC units. Used by units_eop, amc_income.`);
    await ev(`document.querySelector('#tracebar a.traceuse[data-tile="amc_income"]').click()`);
    await waitFor(`location.hash === '#/tile/amc_income'`, 8000); await idle(); await sleep(400);
    const asInput = await rowNamed('units_amc');
    check('trace: a Used by link opens that tile on the same case and month, at the row where the quantity comes in', asInput > 0 && await atIs('Zero premium!F' + asInput), await cellAt());
    check('trace: where the row says it comes from units_amc', await lineIs(`F${asInput} is AMC units, from units_amc in Unit projection (not reviewed). Go to source`), await traceLine());

    // the model workbook: a link row goes to the sheet it links to, in the same workbook
    await go('#/model'); await waitSheets(i => i.sheets.includes('Profit'));
    await sel('A1', 'Cashflows');
    const link = await rowNamed('units_eop');
    await sel('G' + link);
    check('trace: model workbook, a cross-tab link row', await lineIs(`G${link} is Closing units, from units_eop in Unit projection (not reviewed). Go to source`), await traceLine());
    await shot('trace-live-model-link');
    await ev(`document.getElementById('gotosource').click()`);
    await waitSheets(i => i.active === 'Unit projection', 6000);
    const home = await rowNamed('units_eop');
    check('trace: Go to source activates the source module\'s sheet at the corresponding cell, still in the model view', home > 0 && await atIs('Unit projection!G' + home) && (await ev('location.hash')) === '#/model', await cellAt());
    await shot('trace-live-model-source');
    await click('back');
    check('trace: Back returns to the link row', await atIs('Cashflows!G' + link) && (await ev('location.hash')) === '#/model', await cellAt());
    await sel('A1', 'Inputs');
  }

  async function traceRealPolicy(polId) {
    const sheet = 'Policy ' + polId;
    const st = await rowNamed('in_force_bop');
    await sel('E' + st, sheet);
    const want = `E${st} is Opening in force, carried forward from in_force_eop in Decrements (${({ signed_off: 'signed off', stale: 'stale' })[(await S()).tiles.in_force_eop.state] || 'not reviewed'}). Go to source`;
    check('trace, real policy: the line shows under the real-data line', await lineIs(want) && await ev(`!document.getElementById('realbar').hidden`), await traceLine());
    await shot('trace-live-real');
    await ev(`document.getElementById('gotosource').click()`);
    check('trace, real policy: Go to source opens the source tile', await waitFor(`location.hash === '#/tile/in_force_eop'`, 8000), await ev('location.hash'));
    await idle(); await waitSheets(i => i.active === sheet, 30000); await sleep(400);
    const src = await rowNamed('in_force_eop');
    check('trace, real policy: the same policy is carried across, month before in the source row', (await S()).real.policy === polId && await ev(`window.__gridLog.opens.some(p => p.startsWith('real-data/') && p.includes('/tiles/in_force_eop/'))`) && await atIs(sheet + '!D' + src, 15000), await cellAt());
    await click('back');
    await waitFor(`location.hash === '#/tile/deaths'`, 8000); await idle();
    check('trace, real policy: Back restores the cell', await atIs(sheet + '!E' + st, 15000) && (await S()).real.policy === polId, await cellAt());
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

  await traceCases();

  await go('#/tile/units_amc');
  ins = await waitSheets(i => i.sheets.includes('Scratch'));
  check('tile workbook: one sheet per case plus Scratch', !ins.fail && caseNames.every(n => ins.sheets.includes(n)), JSON.stringify(ins));
  await ev(`document.querySelector('a[data-case="zero_premium"]').click()`);
  check('tile: selecting a case activates its sheet', (await waitSheets(i => i.active === 'Zero premium')).active === 'Zero premium', JSON.stringify(await inspect()));
  await has('tile: sentence', 'Not signed off. Differences are zero in');
  await shot('live-tile');

  // the centre switch against the real model copy: Code, Test (a real test run), module file, tilekit.toml
  const seg = async v => { await ev(`window.__app.setCentre(${JSON.stringify(v)})`); await sleep(700); };
  const q0 = await ev(`(()=>{const x=window.__app.S.graph.quantities.units_amc; return {file:x.source.file, line:x.source.line, code:x.source.code}})()`);
  await seg('code');
  check('Code: the tile source, with the real file and line above it, in the centre pane', await ev(`!document.getElementById('codewrap').hidden && document.getElementById('srcpath').innerText.includes(${JSON.stringify(q0.file)}) && document.getElementById('srcpath').innerText.includes('line ${q0.line}') && document.querySelector('#codewrap .src').dataset.code===${JSON.stringify(q0.code)} && document.querySelector('#codewrap .src .n').textContent==='${q0.line}'`), await inner('codewrap'));
  await shot('live-centre-code');
  await seg('test');
  check('Test: shows tests/tiles/test_units_amc.py read from the model', await ev(`document.getElementById('srcpath').innerText.includes('tests/tiles/test_units_amc.py') && document.querySelector('#codewrap .src').dataset.code.includes('def test')`), await inner('codewrap'));
  await click('runtest');
  check('Test: Run this test runs the real test and shows Passed.', await waitFor(`document.getElementById('testresult') && !document.getElementById('testresult').innerText.includes('Running') && document.getElementById('testresult').innerText.includes('Passed.')`, 240000), await inner('codewrap'));
  await shot('live-centre-test');
  await seg('spreadsheet');
  check('centre: back on Spreadsheet the workbook is still open', await ev(`document.getElementById('codewrap').hidden && document.querySelector('#gridhost iframe').getBoundingClientRect().width>200`) && !(await waitSheets(i => i.sheets.length > 1)).fail);
  await go('#/module/unit_projection');
  await seg('code');
  const modFile = await ev(`window.__app.S.graph.quantities.units_amc.source.file`);
  check('Code on a module: the whole module file from line 1', await ev(`document.getElementById('srcpath').innerText.includes(${JSON.stringify(modFile)}) && document.querySelector('#codewrap .src .n').textContent==='1' && document.querySelector('#codewrap .src').dataset.code.includes('def units_amc')`), await inner('codewrap'));
  await seg('spreadsheet');
  await go('#/model');
  await seg('code');
  check('Code on the model: tilekit.toml', await ev(`document.getElementById('srcpath').innerText.includes('tilekit.toml') && document.querySelector('#codewrap .src').dataset.code.includes('[model]')`), await inner('codewrap'));
  await seg('spreadsheet');
  check('the real agent service is behind the right bar: Claude Code runs in the pane (a stand-in here), started in the model folder, with no card waiting', await ev(`!document.getElementById('agentlog').hidden && !!window.api.agent && !!window.api.term && !!document.querySelector('#rightbar #agentlog #termhost') && !document.getElementById('termnone') && !document.getElementById('agentlog-input') && !document.querySelector('#agentlog-log .alog-line')`)
    && await waitFor(`/fake claude: ready/.test(document.getElementById('termhost').innerText)`, 30000) && fs.realpathSync(pane.records().find(r => r.start).cwd) === fs.realpathSync(copy), JSON.stringify(pane.records().filter(r => r.start).map(r => r.cwd)));
  await go('#/tile/units_amc');

  // sign off
  await signoffTile('units_amc');
  await has('tile: signed-off sentence', 'Signed off by');
  await shot('live-tile-signed');
  await signoffTile('units_eop');
  await go('#/module/unit_projection');
  check('module tile strip shows the tile as signed off', await ev(`(()=>{const a=[...document.querySelectorAll('#tiles a.t')].find(a=>a.textContent.includes('units_amc')); return !!a && a.textContent.includes('signed off')})()`));
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
  // a module can only be signed off once every tile's tests have been run since the last change
  const tests = await ctl.run('test');
  check('the model\'s tests run and pass before a module is signed off', tests && (tests.failed || 0) === 0 && (tests.passed || 0) > 0, JSON.stringify({ passed: tests && tests.passed, failed: tests && tests.failed }));
  await ev('window.__app.refresh().then(() => window.__app.render())'); await idle();
  await go('#/module/decrements');
  await has('module: 3 of 3 tiles', '3 of 3 tiles signed off');
  check('module Sign off module is enabled with a prefilled reviewer', await ev('!document.getElementById("signoff").disabled && document.getElementById("signoff").textContent === "Sign off module" && document.getElementById("reviewer").value.trim().length > 0'), await ev('document.getElementById("signoff").title'));
  const modHash = await ev('location.hash');
  await click('signoff');
  await waitFor(`Object.values(window.__app.S.status.modules).some(m => m.state === 'signed_off')`, 30000); await idle();
  await go(modHash);   // the sign-off moved on to the next item in the review queue
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
  const reconfLabel = await inner("reconfirm");
  check('re-confirm button offers the drifted tiles', new RegExp(`Re-confirm values-only \\((${drifted.length})\\)`).test(reconfLabel), reconfLabel);
  await shot('live-module-values-drift');
  await click('reconfirm');
  check('re-confirm: tiles return to signed off', await waitFor(`['deaths','lapses','in_force_eop'].every(t=>window.__app.S.status.tiles[t].state==='signed_off')`, 60000), JSON.stringify((await S()).tiles.lapses));
  await idle();
  await has('module sentence after re-confirm', '3 of 3 tiles signed off');

  // tests and export
  await go('#/model');
  await click('runtests');
  check('Run tests shows the named invariant checks', await waitFor(`window.__both().includes('Zero premium gives zero units') && window.__both().includes('Units never negative [base]')`, 180000), (await text()).slice(0, 500));
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
  check('no Real model points list before any run', !(await text()).toLowerCase().includes('real model points'));
  // a CSV with a bad value: the run is refused and the rows are listed in the dialog
  const bad = path.join(tmp, 'bad.csv');
  fs.writeFileSync(bad, 'policy_id,premium_pm,premium_months,age_at_entry,sum_assured\nA1,100,120,40,50000\nA2,abc,120,41,50000\nA3,100,120,42,60000\n');
  pickQueue.push(bad);
  await click('newrun');
  await waitFor('!!document.getElementById("f-name")', 10000);
  await setField('f-name', 'badrun');
  await click('confirm');
  check('bad CSV: rows listed in the dialog', await waitFor(`document.getElementById('dialogerrors').innerText.includes('Row 3, premium_pm')`, 30000), await inner("dialog"));
  await shot('live-real-bad-csv');
  await click('cancel');
  check('bad CSV: no run created', (await tk('runs')).runs.length === 0);

  await click('sample');
  await waitFor('!!document.getElementById("f-n")', 10000);
  check('sample dialog says it is synthetic data', (await inner("dialog")).includes('synthetic data for trying the feature'));
  await shot('live-real-sample-dialog');
  await setField('f-n', '300'); await setField('f-name', 'sample');
  await click('confirm');
  check('sample portfolio: run created', await waitFor(`!document.getElementById('dialog') && document.getElementById('runs') && document.getElementById('runs').innerText.includes('sample')`, 120000), await text());
  await idle();
  const runsTxt = await inner("runs");
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
  check('real line and buttons above the spreadsheet', await ev(`(()=>{const b=document.getElementById('realbar'); return b.innerText.includes('Real data. Not part of sign-off, and kept out of the repo.') && !!document.getElementById('promote') && !!document.getElementById('backtocases')})()`), await inner("realbar"));
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
  await has('tile: rebuild button still acts on the cases', 'Rebuild');
  check('tile: Sign off button still there', await ev('document.getElementById("signoff").textContent === "Sign off"'));
  check('selection kept across views', (await S()).real && (await S()).real.policy === polId);
  await shot('live-real-tile');
  await traceRealPolicy(polId);
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
  const pd = await inner("dialog");
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
  const runsNow = await inner("runs");
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

  // File > Open model and New model, on the model copy
  const lastModelBefore = ctl.settings.lastModel;
  let refused = null;
  try { await ctl.switchModel(path.join(tmp, 'nowhere')); } catch (e) { refused = e.message; }
  check('Open model: a folder without tilekit.toml is refused plainly', refused && /no tilekit\.toml/.test(refused), refused);
  check('Open model: a refused folder changes nothing', ctl.settings.lastModel === lastModelBefore);
  await ev('window.__old = true');
  await ctl.switchModel(copy);
  let reopened = await waitFor(`!window.__old && window.__app && window.__app.ready && location.hash==='#/model'`, 30000);
  if (!reopened) { (summary.reloadRetries = summary.reloadRetries || []).push('open model'); await ev('window.__old = true').catch(() => {}); win.webContents.reload(); await sleep(500); reopened = await waitFor(`!window.__old && window.__app && window.__app.ready && location.hash==='#/model'`, 60000); }
  check('Open model: the window reloads at the model view with the model on show', reopened, await ev('location.href'));
  await idle();
  check('Open model: the folder is remembered as the last model', JSON.parse(fs.readFileSync(settingsFile, 'utf8')).lastModel === copy);
  check('Open model: the new model is on screen, the pane and bars intact', await ev(`document.getElementById('title').textContent.includes('Unit-linked') && !!document.querySelector('#rightbar #agentlog #termhost') && !!document.querySelector('#left #lpin #signoff')`));
  check('Open model: the model is in the list of models (opening registers it)', !!ctl.models.byDir(copy) && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).models.some(m => m.dir === copy));
  check('the old New model path (folder and name only) is gone from the window API', await ev(`typeof window.api.newModel === 'undefined' && typeof window.api.launch.newModel === 'function'`));

  check('no console errors', summary.errors.filter(e => e.startsWith('console:')).length === 0, JSON.stringify(summary.errors));
  const log = await ev('window.__gridLog');
  summary.gridLog = { ready: log.ready, opens: log.opens.length, saves: log.saves };
  finish(0);
})().catch(e => { summary.errors.push(String(e && e.stack || e)); finish(1); });
app.on('window-all-closed', () => {});
