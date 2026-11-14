'use strict';
// Run from app/: APP_FIXTURES=fixtures ./node_modules/.bin/electron test/smoke.js
process.env.APP_NO_AUTOSTART = '1';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
if (!process.env.APP_FIXTURES) { console.error('Set APP_FIXTURES=fixtures'); app.exit(2); }

const FULL = /full/.test(path.basename(process.env.APP_FIXTURES || ''));
const SFX = FULL ? '-full' : '';
const summary = { checks: [], shots: [], errors: [] };
let backup = null;
const hard = setTimeout(() => { summary.errors.push('hard timeout'); finish(2); }, 90000);
let ctl = null, finished = false;

function finish(code) {
  if (finished) return; finished = true;
  clearTimeout(hard);
  if (backup) { try { fs.writeFileSync(backup.path, backup.bytes); } catch { /* ignore */ } }
  summary.passed = summary.checks.filter(c => c.ok).length;
  summary.failed = summary.checks.filter(c => !c.ok).length;
  console.log(JSON.stringify(summary, null, 1));
  try { ctl && ctl.shutdown(); } catch { /* ignore */ }
  app.exit(summary.failed || code ? (code || 1) : 0);
}
const check = (name, ok, detail) => { summary.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); };

(async () => {
  const settingsFile = path.join(require('os').tmpdir(), 'tilekit-smoke-settings-' + process.pid + '.json');
  ctl = await require('../src/main').start({ show: true, settingsFile });
  const win = ctl.win;
  win.webContents.on('console-message', (...a) => { const m = a[0] && a[0].message !== undefined ? a[0] : { level: a[1], message: a[2] }; if (m.level === 'error' || m.level === 3) summary.errors.push('console: ' + String(m.message).slice(0, 300)); });
  win.webContents.on('console-message', (...a) => { const m = a[0] && a[0].message !== undefined ? a[0] : { level: a[1], message: a[2] }; if (m.level === 'error' || m.level === 3) summary.errors.push('console: ' + String(m.message).slice(0, 300)); });
  const ev = js => win.webContents.executeJavaScript(js, true);
  const waitFor = async (js, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await ev(js); if (v) return v; } catch { /* retry */ } await sleep(100); } return false; };
  const text = () => ev('document.getElementById("left").innerText');
  const has = async (name, needle) => { const t = await text(); check(name, t.includes(needle), `missing "${needle}" in: ${t.slice(0, 300)}`); };
  // section labels are set in capitals by the style sheet, so headings are compared without regard to case
  const hasH = async (name, needle) => { const t = (await text()).toLowerCase(); check(name, t.includes(needle.toLowerCase()), `missing heading "${needle}" in: ${t.slice(0, 300)}`); };
  const shot = async name => { const img = await win.webContents.capturePage(); const f = path.join(OUT, name + '.png'); fs.writeFileSync(f, img.toPNG()); summary.shots.push(f); };
  const go = async hash => { await ev(`location.hash=${JSON.stringify(hash)}`); await waitFor(`(()=>{const h=location.hash;const t=document.getElementById(h.startsWith('#/tile/')?'tilename':'title');return t&&(h.startsWith('#/tile/')?h.endsWith('/'+t.textContent):true)&&document.querySelector('#mods a.cur')!==null})()`); await ev('window.__app.idle()'); await sleep(200); };
  const gc = js => ev(`(async()=>{const g=document.querySelector('#gridhost iframe').contentWindow.gridcraft; return await (${js})(g)})()`);
  const sheets = () => gc('async g => (await g.docInspect()).sheets.map(s => s.name)');

  async function fullSet() {
    const lt = () => ev('document.getElementById("left").innerText');
    const hasF = async (name, needle) => { const x = await lt(); check(name, x.includes(needle), `missing "${needle}" in: ${x.slice(0, 400)}`); };
    const hasFH = async (name, needle) => { const x = (await lt()).toLowerCase(); check(name, x.includes(needle.toLowerCase()), `missing heading "${needle}" in: ${x.slice(0, 400)}`); };
    const notF = async (name, needle) => { const x = (await lt()).toLowerCase(); check(name, !x.includes(needle.toLowerCase()), `unexpected "${needle}"`); };
    const svgBoxes = () => ev(`(()=>{const svg=document.querySelector('svg.map');return [...svg.querySelectorAll('rect')].map(r=>({x:+r.getAttribute('x'),y:+r.getAttribute('y'),w:+r.getAttribute('width'),h:+r.getAttribute('height')}))})()`);
    // every route polyline segment must stay out of every box (except at its own end points)
    const crossing = async () => ev(`(()=>{
      const svg=document.querySelector('svg.map');
      const boxes=[...svg.querySelectorAll('rect')].map(r=>({x:+r.getAttribute('x'),y:+r.getAttribute('y'),w:+r.getAttribute('width'),h:+r.getAttribute('height')}));
      let bad=0, n=0;
      for (const p of svg.querySelectorAll('path[marker-end]')) {
        const d=p.getAttribute('d'); if (p.getAttribute('stroke-dasharray')) continue; n++;
        const pts=d.slice(1).split(' L').map(s=>s.split(',').map(Number));
        for (let i=0;i+1<pts.length;i++) {
          const [x1,y1]=pts[i],[x2,y2]=pts[i+1];
          for (const b of boxes) {
            // sample along the segment, ignoring the 2px right at the segment ends
            for (let k=1;k<40;k++) { const f=k/40, x=x1+(x2-x1)*f, y=y1+(y2-y1)*f;
              if (x>b.x+1 && x<b.x+b.w-1 && y>b.y+1 && y<b.y+b.h-1) { bad++; break; } }
          }
        }
      }
      return {bad, n};
    })()`);
    const overlaps = async () => { const b = await svgBoxes(); let o = 0; for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) { const p = b[i], q = b[j]; if (p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h) o++; } return o; };

    await go('#/model');
    await hasF('full model: bands', 'Inputs'); await hasF('full model: Results band', 'Results'); await hasF('full model: Treaty band', 'Treaty');
    await hasF('full model: modules', 'Quota share'); await hasF('full model: legend', 'Outline: thin = signed off');
    let c = await crossing(); check('full model map: no arrow through a box', c.bad === 0 && c.n >= 5, JSON.stringify(c));
    check('full model map: no overlapping boxes', (await overlaps()) === 0);
    check('full model map fits the panel', await ev(`document.querySelector('svg.map').getBoundingClientRect().width <= document.getElementById('left').clientWidth`));
    check('full model map is not scrolled sideways, not shrunk', await ev(`(()=>{const w=document.querySelector('.mapwrap'), v=document.querySelector('svg.map'); return w.scrollWidth<=w.clientWidth+1 && v.getBoundingClientRect().width >= v.viewBox.baseVal.width-1})()`));
    await hasF('full model: run tests button', 'Run tests');
    await hasF('full model: stale check wording', 'not run since last change');
    await ev('document.getElementById("runtests").click()');
    check('run tests refreshes the checks', await waitFor(`!document.getElementById('left').innerText.includes('not run since last change')`));
    await hasF('full model: sentence', '0 of 5 modules signed off');
    await shot('model-full');

    await go('#/module/cashflows');
    c = await crossing(); check('full cashflows map: no arrow through a box', c.bad === 0 && c.n >= 8, JSON.stringify(c));
    check('full cashflows map: no overlapping boxes', (await overlaps()) === 0);
    check('full cashflows map: parameters grouped', await ev(`[...document.querySelectorAll('svg.map text')].filter(t=>t.textContent==='Parameters').length >= 1`));
    check('full cashflows map: params are listed once per group, not boxed', await ev(`[...document.querySelectorAll('svg.map text')].filter(t=>t.textContent==='parameter').length===0`));
    check('full cashflows map: fits the panel', await ev(`document.querySelector('svg.map').getBoundingClientRect().width <= document.getElementById('left').clientWidth`));
    check('full cashflows map: not scrolled sideways, not shrunk', await ev(`(()=>{const w=document.querySelector('.mapwrap'), v=document.querySelector('svg.map'); return w.scrollWidth<=w.clientWidth+1 && v.getBoundingClientRect().width >= v.viewBox.baseVal.width-1})()`));
    check('full cashflows: workbook out of date line', await ev(`!document.getElementById('stalebar').hidden && document.getElementById('stalebar').innerText.includes('This workbook is out of date. Rebuild to see current numbers.')`));
    await shot('module-full');
    await go('#/module/decrements');
    c = await crossing(); check('full decrements map: no arrow through a box', c.bad === 0, JSON.stringify(c));
    check('full decrements: next period link', await ev(`document.querySelector('svg.map').textContent.includes('next period')`));
    await shot('module-decrements-full');
    await go('#/module/profit');
    c = await crossing(); check('full profit map: no arrow through a box', c.bad === 0 && c.n >= 6, JSON.stringify(c));
    await shot('module-profit-full');

    // tile views
    await go('#/tile/allocation_margin');
    await hasF('stale formula sentence', "Stale: this tile's formula changed since sign-off.");
    await hasFH('changed since sign-off section', 'Changed since sign-off');
    check('was and now formulas', await ev(`document.querySelector('.was').textContent==='=premium*(1-allocation_rate)'`) && await ev(`document.querySelector('.now').textContent.includes('in_force_eop')`));
    await shot('tile-formula-drift-full');
    check('blocked by can_sign_off: Sign off disabled, first blocker is its title, blocker listed in Checks', await ev(`(()=>{const b=document.getElementById('signoff'); return b.disabled && b.title.includes('formula changed since sign-off') && document.getElementById('left').innerText.includes('formula changed since sign-off') && !document.getElementById('dialog')})()`));
    await go('#/tile/amc_income');
    await hasF('stale values sentence', 'Stale: upstream values changed since sign-off.');
    check('out of date bar on stale workbook', await ev(`!document.getElementById('stalebar').hidden`));
    check('old workbook still shown', await ev(`document.querySelector('#gridhost iframe').style.visibility==='visible' && document.getElementById('nogrid').hidden`));
    check('no Changed section without drift', await ev(`!document.getElementById('changed') && [...document.querySelectorAll('#panel h3.sec')].every(h => h.textContent !== 'Changed since sign-off')`));
    await shot('tile-stale-full');
    await go('#/tile/premium_income');
    await hasF('new case sentence', 'Signed off. New case to review: High charge.');
    await go('#/tile/irr_pm');
    await hasF('values only sentence', 'Values only: this tile cannot be written as an Excel formula.');
    check('no formula shown for values-only tile', await ev(`!document.querySelector('.formula')`));
    await go('#/tile/in_force_eop');
    check('failing difference blocks sign-off with its sentence', await ev(`(()=>{const b=document.getElementById('signoff'); return b.disabled && b.title.includes('0.0021') && document.getElementById('left').innerText.includes('0.0021')})()`));
    await go('#/tile/sum_at_risk'); await hasF('uncovered branch blocker visible in checks', 'Branch not covered');
    check('sidebar sections of a tile, in order', await ev(`(()=>{const t=[...document.querySelectorAll('#panel h3.sec')].map(h=>h.textContent); const want=['Spec','Formula reviewed','Assumptions to confirm','Cases agreed to Python','Relies on','Feeds into','Checks','Code']; let i=-1; return want.every(w=>{const j=t.indexOf(w); const ok=j>i; i=j; return ok})})()`));
    await go('#/tile/gross_profit');
    await shot('tile-full');
    await go('#/tile/maintenance_expense');
    await hasF('unbuilt tile', 'No workbook yet'); check('unbuilt tile offers Build', await ev(`!!document.getElementById('build')`));
    await go('#/module/quota_share'); await shot('module-quota-full');
    c = await crossing(); check('full quota map: no arrow through a box', c.bad === 0, JSON.stringify(c));

    // long code does not widen the panel
    await go('#/tile/gross_profit');
    check('left panel does not scroll sideways', await ev(`(()=>{const l=document.getElementById('left');return l.scrollWidth<=l.clientWidth+1})()`));

    // scroll position survives a status refresh
    await go('#/module/cashflows');
    await ev('document.getElementById("left").scrollTop = 150');
    const scrollBefore = await ev('document.getElementById("left").scrollTop');
    await ev('window.__app.refresh().then(()=>window.__app.render())'); await ev('window.__app.idle()'); await sleep(200);
    check('left scroll kept across refresh', (await ev('document.getElementById("left").scrollTop')) === scrollBefore && scrollBefore > 0, scrollBefore + ' vs ' + await ev('document.getElementById("left").scrollTop'));

    // agent log mount point
    check('agent log region exists, hidden without window.api.agent', await ev(`(()=>{const s=document.getElementById('agentlog');return !!s && s.hidden && !!s.querySelector('#agentlog-log') && !!s.querySelector('#agentlog-input') && s.querySelector('h3').textContent==='Agent log' && s.parentElement.id==='panel'})()`));
    for (const hh of ['#/model', '#/module/profit', '#/tile/deaths']) { await go(hh); check('agent log present in ' + hh, await ev(`!!document.querySelector('#panel > #agentlog')`)); }

    // settings: ribbon and formula bar, remembered
    check('ribbon collapsed by default', await gc(`async g => (await g.uiInspect()).ui.ribbonCollapsed === true`));
    const s0 = await ev('window.__app.settings()');
    check('settings default: ribbon off, formula bar on', s0.showRibbon === false && s0.showFormulaBar === true, JSON.stringify(s0));
    ctl.setSetting('showRibbon', true); ctl.setSetting('showFormulaBar', false);
    await sleep(900);
    check('settings reach the window', await ev('window.__app.settings().showRibbon === true && window.__app.settings().showFormulaBar === false'));
    check('ribbon expanded when shown', await gc(`async g => (await g.uiInspect()).ui.ribbonCollapsed === false`));
    await shot('settings-ribbon-on-full');
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check('settings written to the JSON file', saved.showRibbon === true && saved.showFormulaBar === false, JSON.stringify(saved));
    ctl.setSetting('showRibbon', false); ctl.setSetting('showFormulaBar', true);
    await sleep(600);
    check('ribbon collapsed when hidden', await gc(`async g => (await g.uiInspect()).ui.ribbonCollapsed === true`));
    const menu = require('electron').Menu.getApplicationMenu().items.find(i => i.label === 'View').submenu.items.map(i => i.label);
    check('View menu has the two items', menu.includes('Show ribbon') && menu.includes('Show formula bar'), JSON.stringify(menu));
    try { fs.unlinkSync(settingsFile); } catch { /* ignore */ }
    const log = await ev('window.__gridLog');
    summary.gridLog = { ready: log.ready, opens: log.opens.length, saves: log.saves };
  }

  check('app ready', await waitFor('window.__app && window.__app.ready', 20000));
  check('gridcraft:ready', await waitFor('window.__gridLog.ready >= 1', 20000), 'no ready');

  if (FULL) { await fullSet(); return finish(0); }

  // model
  await go('#/model');
  await has('model: name', 'Unit-linked pricing');
  await has('model: sentence', 'Not signed off. 0 of 1 modules signed off.');
  await has('model: layer band', 'Liability');
  await has('model: module box', 'Unit projection');
  await hasH('model: checks', 'Model checks');
  const opened = await waitFor('window.__gridLog.opens.length >= 1');
  check('workbook opened', opened);
  const sh = await sheets();
  check('docInspect lists sheets', Array.isArray(sh) && sh.length > 0, JSON.stringify(sh));
  await shot('model' + SFX);

  // module
  await go('#/module/unit_projection');
  await has('module: title', 'Unit projection');
  await has('module: sentence', 'Not signed off. 2 of 4 tiles signed off, 1 stale.');
  await has('module: rebuild button', 'Rebuild stale (1)');
  await has('module: reconfirm button', 'Re-confirm values-only (1)');
  await has('module: checks', 'Sheet agrees with Python');
  check('module: map has tiles and next period', await ev(`(()=>{const t=document.querySelector('svg.map').textContent;return ['units_allocated','units_eop','units_bop','allocation_rate','next period','carried forward'].every(x=>t.includes(x))})()`));
  check('module: tile boxes are links', await ev(`document.querySelectorAll('svg.map a').length >= 4`));
  await shot('module');

  // tile
  await ev(`document.querySelector('svg.map a[href="#/tile/units_amc"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);
  await waitFor(`document.getElementById('tilename') && document.getElementById('tilename').textContent==='units_amc'`); await ev('window.__app.idle()'); await sleep(200);
  check('click tile box opens tile view', (await ev('location.hash')) === '#/tile/units_amc');
  await has('tile: name', 'units_amc');
  await has('tile: sentence', 'Not signed off. Differences are zero in 3 of 3 cases.');
  await has('tile: units and timing line', 'Units per policy. End of month.');
  check('tile: input and parameter names are not links', await ev(`[...document.querySelectorAll('#left a')].every(a => !['amc_pm','amc_cap_units'].includes(a.textContent))`));
  await has('tile: formula plain', 'MIN(units_after_alloc*amc_pm,amc_cap_units)');
  check('tile: no braces in formula', !(await ev('document.querySelector(".formula").textContent')).includes('{'));
  await hasH('tile: assumptions heading', 'Assumptions to confirm');
  await has('tile: assumption text', "The charge is on units after the same month's allocation");
  await has('tile: input status', 'parameter');
  await hasH('tile: feeds into', 'Feeds into');
  await hasH('tile: relies on', 'Relies on');
  await hasH('tile: formula reviewed', 'Formula reviewed');
  await hasH('tile: cases agreed to Python', 'Cases agreed to Python');
  await has('tile: reference', 'UP-3');
  await has('tile: case names', 'Zero premium');
  check('tile: case ids are not shown', !(await text()).includes('zero_premium'));
  await has('tile: checks', 'All checks pass.');
  await has('tile: code', 'def units_amc');
  await sleep(500);

  // sign-off, inline in the side bar
  const dlg = await text();
  check('side bar lists assumption, cases, relies on, reviewer', dlg.includes("The charge is on units after the same month's allocation") && dlg.includes('Base') && dlg.includes('units_after_alloc') && dlg.includes('Reviewed by') && dlg.includes('Prepared by'), dlg);
  check('no sign-off dialog exists', await ev('!document.getElementById("dialog") && !document.getElementById("confirm")'));
  check('reviewer is prefilled', await ev('document.getElementById("reviewer").value.trim().length > 0'));
  check('Sign off disabled until the assumption is ticked', await ev('document.getElementById("signoff").disabled'));
  check('the case lines say agrees', await ev(`[...document.querySelectorAll('a[data-case]')].every(a => /agrees/.test(a.parentElement.innerText))`));
  await shot('tile');
  await go('#/model'); await go('#/tile/units_amc');
  check('Sign off still disabled after leaving and returning', await ev('document.getElementById("signoff").disabled'));
  await has('tile: still not signed off', 'Not signed off.');

  // sign-off for real (fixture); the tick survives a refresh
  await ev('document.querySelector("#panel input.assume").click()');
  check('Sign off enabled after ticking', !(await ev('document.getElementById("signoff").disabled')));
  await ev('window.__app.refresh().then(()=>window.__app.render())'); await ev('window.__app.idle()'); await sleep(200);
  check('tick and Sign off survive a refresh', await ev('document.querySelector("#panel input.assume").checked && !document.getElementById("signoff").disabled'));
  await ev('document.getElementById("reviewer").value=""; document.getElementById("reviewer").dispatchEvent(new Event("input",{bubbles:true}))');
  check('Sign off disabled without a reviewer name', await ev('document.getElementById("signoff").disabled'));
  await ev('document.getElementById("reviewer").value="Smoke Reviewer"; document.getElementById("reviewer").dispatchEvent(new Event("input",{bubbles:true}))');
  await ev('document.getElementById("comment").value="Smoke test"; document.getElementById("comment").dispatchEvent(new Event("input",{bubbles:true}))');
  await shot('tile-ready-to-sign');
  await ev('document.getElementById("signoff").click()');
  check('sentence changes after sign-off', await waitFor(`document.getElementById('sentence') && document.getElementById('sentence').textContent.startsWith('Signed off by')`));
  check('signed sheet shows the recorded reviewer and date, no fields', await waitFor(`(()=>{const r=document.getElementById('reviewedby'); return !!r && r.innerText.includes('Smoke Reviewer') && /\\d{4}-\\d{2}-\\d{2}/.test(r.innerText) && !document.getElementById('reviewer') && document.getElementById('signoff').disabled})()`), await text());
  await shot('tile-signed');

  // a stale tile cannot be signed off: the blocker is the button's title and is listed under Checks
  await go('#/tile/units_eop');
  await has('stale tile sentence', 'Stale: upstream values changed since sign-off.');
  check('blocked: Sign off disabled with the first blocker as title, listed in Checks', await ev(`(()=>{const b=document.getElementById('signoff'); return b.disabled && b.title.includes('stale because upstream values changed') && document.getElementById('left').innerText.includes('stale because upstream values changed')})()`));

  // module re-confirm then module sign-off
  await go('#/module/unit_projection');
  await has('module sentence after tile sign-off', '3 of 4 tiles signed off, 1 stale.');
  await ev('document.getElementById("reconfirm").click()');
  check('reconfirm works', await waitFor(`document.getElementById('sentence').textContent.includes('4 of 4 tiles signed off')`));

  // edits persist: change a cell, wait for the autosave, check the file, restore it afterwards
  const wbPath = path.join(ctl.cfg.modelDir, 'review/tiles/units_amc/workbook.xlsx');
  backup = { path: wbPath, bytes: fs.readFileSync(wbPath) };
  await go('#/tile/units_amc');
  const savesBefore = await ev('window.__gridLog.saves');
  // an edit on a generated sheet is never written back
  await gc(`async g => g.execute('cell.set', { cell: 'T2', input: 'not saved' })`);
  await sleep(3500);
  check('edit on a generated sheet is not saved', (await ev('window.__gridLog.saves')) === savesBefore && fs.readFileSync(wbPath).equals(backup.bytes));
  check('line says changes outside Scratch are not saved', await waitFor(`document.getElementById('sheetbar').innerText.includes('Changes outside the Scratch sheet are not saved.')`, 5000), await ev('document.getElementById("sheetbar").innerText'));
  await go('#/model'); await go('#/tile/units_amc');
  // the fixture workbooks have no Scratch sheet, so make one
  await gc(`async g => { await g.execute('home.insertSheet', {}); await g.execute('sheet.rename', { name: 'Scratch' }); }`);
  await ev(`(async () => { const g = document.querySelector('#gridhost iframe').contentWindow.gridcraft; const r = await g.execute('file.saveBytes', { format: 'xlsx' }); const bin = atob(r.base64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); await window.api.writeWorkbook('review/tiles/units_amc/workbook.xlsx', u); await window.__app.grid.reload(); })()`);
  await gc(`async g => g.execute('sheet.activate', { sheet: 'Scratch' })`);
  await gc(`async g => g.execute('cell.set', { cell: 'T2', input: 'scratch note' })`);
  check('autosave wrote the workbook', await waitFor(`window.__gridLog.saves > ${savesBefore}`, 9000), JSON.stringify(await ev('window.__gridLog')));
  check('saved file changed on disk', !fs.readFileSync(wbPath).equals(backup.bytes));
  fs.writeFileSync(wbPath, backup.bytes); backup = null;

  // back to model
  await go('#/model');
  await has('model sentence shows module state', 'Not signed off.');
  const log = await ev('window.__gridLog');
  summary.gridLog = { ready: log.ready, opens: log.opens.length, saves: log.saves, dirtyEvents: log.dirty.length };
  finish(0);
})().catch(e => { summary.errors.push(String(e && e.stack || e)); finish(1); });
app.on('window-all-closed', () => {});
