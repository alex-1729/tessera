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
// The fixtures are copied to a temporary folder and given the model's source files, tests and tilekit.toml, so that the
// Code and Test segments have something to read and nothing in fixtures/ is ever written.
const fixturesCopy = (() => {
  const src = path.resolve(process.env.APP_FIXTURES), dst = path.join(require('os').tmpdir(), 'tessera-smoke-' + process.pid, path.basename(src));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  const graph = JSON.parse(fs.readFileSync(path.join(src, 'graph.json'), 'utf8'));
  const byFile = {};
  for (const [name, q] of Object.entries(graph.quantities)) {
    if (q.kind !== 'tile' || !q.source) continue;
    (byFile[q.source.file] = byFile[q.source.file] || []).push(q.source.code);
    fs.mkdirSync(path.join(dst, 'tests/tiles'), { recursive: true });
    fs.writeFileSync(path.join(dst, 'tests/tiles', `test_${name}.py`), `# test for ${name}\nimport numpy as np\n\n\ndef test_${name}_runs():\n    assert True  # fixture test\n`);
  }
  for (const [f, codes] of Object.entries(byFile)) { fs.mkdirSync(path.dirname(path.join(dst, f)), { recursive: true }); fs.writeFileSync(path.join(dst, f), '# module file\nimport numpy as np\n\n\n' + codes.join('\n\n\n') + '\n'); }
  fs.writeFileSync(path.join(dst, 'tilekit.toml'), '[model]\nname = "Fixture model"  # comment\n');
  return dst;
})();
process.env.APP_FIXTURES = fixturesCopy;
const SFX = FULL ? '-full' : '';
const summary = { checks: [], shots: [], errors: [] };
let backup = null;
const hard = setTimeout(() => { summary.errors.push('hard timeout'); finish(2); }, 480000);
let ctl = null, finished = false;

function finish(code) {
  if (finished) return; finished = true;
  clearTimeout(hard);
  try { fs.rmSync(path.dirname(fixturesCopy), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(require('os').tmpdir(), 'tilekit-smoke-settings-' + process.pid + '.json')); } catch { /* ignore */ }
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
  ctl = await require('../src/main').start({ show: true, settingsFile, agentStub: require('./agent-stub'), pickFolder: async () => path.join(require('os').tmpdir(), 'tessera-newmodel-' + process.pid) });
  const win = ctl.win;
  win.webContents.on('console-message', (...a) => { const m = a[0] && a[0].message !== undefined ? a[0] : { level: a[1], message: a[2] }; if (m.level === 'error' || m.level === 3) summary.errors.push('console: ' + String(m.message).slice(0, 300)); });
  win.webContents.on('console-message', (...a) => { const m = a[0] && a[0].message !== undefined ? a[0] : { level: a[1], message: a[2] }; if (m.level === 'error' || m.level === 3) summary.errors.push('console: ' + String(m.message).slice(0, 300)); });
  win.webContents.on('dom-ready', () => { win.webContents.executeJavaScript('window.__both=()=>document.getElementById("left").innerText+"\\n"+document.getElementById("rightbar").innerText', true).catch(() => {}); });
  // a workbook with unsaved edits asks "Leave site?" on reload; a test reloads on purpose, so let it through
  win.webContents.on('will-prevent-unload', e => e.preventDefault());
  const ev = js => win.webContents.executeJavaScript(js, true);
  await ev('window.__both=()=>document.getElementById("left").innerText+"\\n"+document.getElementById("rightbar").innerText; true');
  const waitFor = async (js, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await ev(js); if (v) return v; } catch { /* retry */ } await sleep(100); } return false; };
  const text = () => ev('window.__both()');
  const has = async (name, needle) => { const t = await text(); check(name, t.includes(needle), `missing "${needle}" in: ${t.slice(0, 300)}`); };
  // section labels are set in capitals by the style sheet, so headings are compared without regard to case
  const hasH = async (name, needle) => { const t = (await text()).toLowerCase(); check(name, t.includes(needle.toLowerCase()), `missing heading "${needle}" in: ${t.slice(0, 300)}`); };
  const shot = async name => { const img = await win.webContents.capturePage(); const f = path.join(OUT, name + '.png'); fs.writeFileSync(f, img.toPNG()); summary.shots.push(f); };
  const go = async hash => { await ev(`location.hash=${JSON.stringify(hash)}`); await waitFor(`(()=>{const h=location.hash;const t=document.getElementById(h.startsWith('#/tile/')?'tilename':'title');return t&&(h.startsWith('#/tile/')?h.endsWith('/'+t.textContent):true)&&document.querySelector('#mods a.cur')!==null})()`); await ev('window.__app.idle()'); await sleep(200); };
  const gc = js => ev(`(async()=>{const g=document.querySelector('#gridhost iframe').contentWindow.gridcraft; return await (${js})(g)})()`);
  const sheets = () => gc('async g => (await g.docInspect()).sheets.map(s => s.name)');


  // ---------------------------------------------------------------- the bars, the centre switch and the chat
  const rect = id => ev(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,r:r.right,b:r.bottom}})()`);
  const gridW = () => ev(`document.querySelector('#gridhost iframe').getBoundingClientRect().width`);
  const menuItem = id => require('electron').Menu.getApplicationMenu().getMenuItemById(id);
  const saved = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const stripText = id => ev(`document.getElementById(${JSON.stringify(id)}).innerText.replace(/\\s+/g,' ').trim()`);
  const settle = async () => { await ev('window.__app.idle()'); await sleep(400); };
  const reloadWin = async () => { const t0 = Date.now(); await ev('window.__app.grid.reload().then(() => true, () => true)').catch(() => {});   // drop any unsaved edit in the grid first: a reload with one pending can leave the next start waiting
    await ev('window.__old = true'); win.webContents.reload(); await sleep(500); let ok = await waitFor('!window.__old && window.__app && window.__app.ready', 25000);
    // (A reload used to hang now and then: a covered window drew no frames. Fixed in main.js and grid.js, and covered
    // by coveredSet below, so there is no retry here: a slow reload should fail the run.)
    (summary.reloads = summary.reloads || []).push(Date.now() - t0 + (ok ? '' : ' FAILED ' + (await ev('[location.href, !!window.__old, !!(window.__app&&window.__app.ready), innerWidth].join(" ")').catch(e => String(e))))); check('reload: app ready', ok); await ev('window.__both=()=>document.getElementById("left").innerText+"\\n"+document.getElementById("rightbar").innerText; true'); await ev('window.__app.idle()'); await sleep(500); };

  async function blockedStrip(blockedTile) {
    await go('#/tile/' + blockedTile); await settle();
    check('blocked tile: Sign off is disabled', await ev(`document.getElementById('signoff').disabled`));
    check('bars open: the strips are not shown at all', await ev(`getComputedStyle(document.getElementById('rightstrip')).display==='none' && getComputedStyle(document.getElementById('leftstrip')).display==='none'`));
    await ev(`document.getElementById('hideleft').click()`); await settle();
    check('collapsed left strip says "blocked" beneath the name', await ev(`(()=>{const n=document.querySelector('#leftstrip .nm').getBoundingClientRect(), a=document.getElementById('leftattn'); const r=a.getBoundingClientRect(); return !a.hidden && a.textContent==='blocked' && r.top>=n.bottom-1 && r.width>0})()`) && (await stripText('leftstrip')) === 'Tile blocked', await stripText('leftstrip'));
    await shot('layout-left-blocked' + SFX);
  }

  async function layoutSet(tileName, blockedTile, okTile) {
    win.setSize(1500, 950); await sleep(500);
    summary.windowInner = await ev('[window.innerWidth, window.innerHeight]');

    await go('#/tile/' + tileName);
    await settle();
    // both bars open: widths, and the spreadsheet fills what is left
    const L0 = await rect('left'), R0 = await rect('rightbar'), G0 = await rect('gridwrap');
    check('bars: left about 340px, right (chat) about 380px', Math.abs(L0.w - 340) <= 2 && Math.abs(R0.w - 380) <= 2, JSON.stringify([L0.w, R0.w]));
    check('bars: spreadsheet lies between the bars and fills the rest', Math.abs(G0.x - L0.r) <= 1 && Math.abs(G0.r - R0.x) <= 1, JSON.stringify([L0, G0, R0]));
    check('bars: the bar above the spreadsheet spans the spreadsheet only', await ev(`(()=>{const c=document.getElementById('cbar').getBoundingClientRect(), g=document.getElementById('gridwrap').getBoundingClientRect(); return Math.abs(c.x-g.x)<1 && Math.abs(c.right-g.right)<1 && c.bottom<=g.top+1})()`));
    const grid0 = await gridW();
    check('bars: spreadsheet iframe is as wide as its box', Math.abs(grid0 - G0.w) <= 1, grid0 + ' vs ' + G0.w);
    await shot('layout-both-open' + SFX);

    // where the sections are: the tile and its review on the left, only the chat on the right
    const heads = sel => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(h=>h.firstElementChild&&h.firstElementChild.tagName==='BUTTON'?h.firstElementChild.firstChild.textContent:h.textContent)`);
    const lh = await heads('#panel h3.sec');
    const order = ['Spec', 'Formula reviewed', 'Relies on', 'Feeds into', 'Assumptions to confirm', 'Cases agreed to Python', 'Checks'];
    let at = -1;
    check('left bar sections of a tile, in order: Spec, Formula reviewed, Relies on, Feeds into, Assumptions, Cases, Checks', order.every(w => { const j = lh.indexOf(w); const ok = j > at; at = j; return ok; }) && !lh.includes('Code'), JSON.stringify(lh));
    check('the signature block and buttons are pinned at the bottom of the left bar', await ev(`!!document.querySelector('#left #lpin table.sig') && !!document.querySelector('#left #lpin #signoff') && !!document.querySelector('#left #lpin #rebuild') && Math.abs(document.getElementById('lpin').getBoundingClientRect().bottom-document.getElementById('left').getBoundingClientRect().bottom)<=1`));
    check('right bar holds only the chat', await ev(`(()=>{const r=document.getElementById('rightbar'); return !!r.querySelector('#agentlog') && !r.querySelector('table.sig, #signoff, h3.sec, #panel') && !document.querySelector('#left #agentlog')})()`));

    // Feeds into: closed by default, plain-word toggle, remembered across views, reloads
    const sec = key => ev(`(()=>{const b=document.querySelector('button.sectog[data-sec=${JSON.stringify(key)}]'), body=document.querySelector('.secbody[data-sec=${JSON.stringify(key)}]'); return {word:b.lastChild.textContent, open:!body.hidden, vis:body.getBoundingClientRect().height>0, label:b.firstChild.textContent, exp:b.getAttribute('aria-expanded')}})()`);
    let f0 = await sec('feeds');
    check('Feeds into is collapsed by default and its toggle says "show"', !f0.open && !f0.vis && f0.word === 'show' && f0.exp === 'false' && f0.label === 'Feeds into', JSON.stringify(f0));
    check('there is no Code section in the left bar', await ev(`!document.querySelector('button.sectog[data-sec="code"]') && !document.querySelector('#left pre.code')`));
    await ev(`document.querySelector('button.sectog[data-sec="feeds"]').click()`); await sleep(300);
    f0 = await sec('feeds');
    check('clicking the Feeds into heading opens it and the toggle says "hide"', f0.open && f0.vis && f0.word === 'hide' && f0.exp === 'true', JSON.stringify(f0));
    check('open state written to the settings file', (saved().sections || {}).feeds === true, JSON.stringify(saved()));
    await go('#/model'); await go('#/tile/' + tileName); await settle();
    check('Feeds into stays open when the view is left and entered again', (await sec('feeds')).open);
    await reloadWin(); await go('#/tile/' + tileName); await settle();
    check('Feeds into stays open after a reload', (await sec('feeds')).open);
    await ev(`document.querySelector('button.sectog[data-sec="feeds"]').click()`); await sleep(300);
    check('closing Feeds into is remembered too', !(await sec('feeds')).open && (saved().sections || {}).feeds === false);

    // collapse and expand the right bar (the chat) by its control
    await ev(`document.getElementById('hideright').click()`); await settle();
    let R1 = await rect('rightbar'), G1 = await rect('gridwrap');
    check('right bar collapses to a ~26px strip', Math.abs(R1.w - 26) <= 2 && await ev(`document.getElementById('rightbar').classList.contains('collapsed')`), JSON.stringify(R1));
    check('spreadsheet takes the freed width at once', Math.abs((G1.w - G0.w) - (R0.w - R1.w)) <= 2 && Math.abs((await gridW()) - G1.w) <= 1, `${G0.w} -> ${G1.w}`);
    check('right strip is named Chat, buff, vertical, with a rule on the spreadsheet side', await ev(`(()=>{const b=document.getElementById('rightstrip'), cs=getComputedStyle(b), bar=getComputedStyle(document.getElementById('rightbar')); return b.innerText.trim().startsWith('Chat') && getComputedStyle(b.firstElementChild).writingMode.startsWith('vertical') && cs.backgroundColor==='rgb(233, 225, 209)' && bar.borderLeftWidth==='1px'})()`));
    check('collapsed right bar shows none of its content', await ev(`document.getElementById('agentlog').getBoundingClientRect().height===0`));
    check('menu item "Show right bar" follows (unchecked), accelerator CmdOrCtrl+Shift+] (CmdOrCtrl+[ and ] trace precedents)', menuItem('showRightBar').checked === false && menuItem('showRightBar').accelerator === 'CmdOrCtrl+Shift+]' && menuItem('showRightBar').label === 'Show right bar');
    check('collapse written to the settings file', saved().showRightBar === false, JSON.stringify(saved()));
    await ev(`document.getElementById('rightstrip').click()`); await settle();
    check('clicking the strip expands the bar and the spreadsheet narrows again', Math.abs((await rect('rightbar')).w - R0.w) <= 2 && Math.abs((await gridW()) - grid0) <= 1 && menuItem('showRightBar').checked === true, `${await gridW()} vs ${grid0}`);

    // the left bar, by its control
    await ev(`document.getElementById('hideleft').click()`); await settle();
    const L1 = await rect('left'), G2 = await rect('gridwrap');
    check('left bar collapses to a ~26px strip named Tile', Math.abs(L1.w - 26) <= 2 && (await stripText('leftstrip')).startsWith('Tile') && Math.abs((G2.w - G0.w) - (L0.w - L1.w)) <= 2 && Math.abs((await gridW()) - G2.w) <= 1, JSON.stringify([L1, G2.w]));
    check('menu item "Show left bar" follows, accelerator CmdOrCtrl+Shift+[', menuItem('showLeftBar').checked === false && menuItem('showLeftBar').accelerator === 'CmdOrCtrl+Shift+[' && saved().showLeftBar === false);
    await shot('layout-left-collapsed' + SFX);
    await ev(`document.getElementById('leftstrip').click()`); await settle();
    check('left strip expands the bar', Math.abs((await rect('left')).w - L0.w) <= 2 && Math.abs((await gridW()) - grid0) <= 1 && menuItem('showLeftBar').checked === true);
    await ev(`document.getElementById('hideright').click()`); await settle();
    await shot('layout-right-collapsed' + SFX);
    await ev(`document.getElementById('rightstrip').click()`); await settle();

    // by the View menu setting, kept in sync, and remembered across a reload
    menuItem('showRightBar').click(); await settle();     // the same path as choosing it in the menu
    check('menu: unchecking "Show right bar" collapses it, spreadsheet widens', await ev(`document.getElementById('rightbar').classList.contains('collapsed')`) && Math.abs((await gridW()) - G1.w) <= 1 && saved().showRightBar === false);
    menuItem('showLeftBar').click(); await settle();
    check('menu: unchecking "Show left bar" collapses it too', await ev(`document.getElementById('left').classList.contains('collapsed')`) && saved().showLeftBar === false);
    const both = await gridW();
    check('both collapsed: spreadsheet is the whole width less two strips', Math.abs(both - (G0.w + (L0.w - 26) + (R0.w - 26))) <= 3, `${both}`);
    await shot('layout-both-collapsed' + SFX);
    await reloadWin();
    check('both bars still collapsed after a reload', await ev(`document.getElementById('left').classList.contains('collapsed') && document.getElementById('rightbar').classList.contains('collapsed')`) && menuItem('showLeftBar').checked === false && menuItem('showRightBar').checked === false);
    check('spreadsheet still fills the window after the reload', Math.abs((await gridW()) - both) <= 3, `${await gridW()} vs ${both}`);
    menuItem('showLeftBar').click(); menuItem('showRightBar').click(); await settle();
    check('menu: checking both brings both bars back', Math.abs((await rect('left')).w - 340) <= 2 && Math.abs((await rect('rightbar')).w - 380) <= 2 && Math.abs((await gridW()) - grid0) <= 1);
    await reloadWin();
    check('both bars still open after another reload', await ev(`!document.getElementById('left').classList.contains('collapsed') && !document.getElementById('rightbar').classList.contains('collapsed')`) && saved().showLeftBar === true && saved().showRightBar === true);

    // "blocked" on the collapsed left strip
    if (blockedTile) await blockedStrip(blockedTile);
    else { await ev(`document.getElementById('hideleft').click()`); await settle(); }
    await go('#/tile/' + okTile); await settle();
    check('a tile that is not blocked shows no word on the collapsed strip', await ev(`document.getElementById('leftattn').hidden`) && (await stripText('leftstrip')) === 'Tile', await stripText('leftstrip'));
    // the left strip names the view
    await go('#/model'); await settle();
    check('left strip is named after the view: Model', (await stripText('leftstrip')).startsWith('Model'));
    await go('#/module/' + await ev(`window.__app.S.graph.modules[0].id`)); await settle();
    check('left strip on a module view starts with Module', (await stripText('leftstrip')).startsWith('Module'));
    // "Working…" and errors show above the spreadsheet when the left bar is collapsed
    await ev(`window.__app.S.actionError='Something went wrong.'; window.__app.render()`); await settle();
    check('error line shows above the spreadsheet when the left bar is collapsed', await ev(`(()=>{const e=document.getElementById('error'), g=document.getElementById('cbar'); const r=e.getBoundingClientRect(); return !e.hidden && e.closest('#centermsgs') && r.height>0 && r.bottom<=g.getBoundingClientRect().top+1 && r.left>=document.getElementById('center').getBoundingClientRect().left-1})()`));
    await ev(`document.getElementById('leftstrip').click()`); await settle();
    check('error line moves to the top of the left bar when it is open', await ev(`(()=>{const e=document.getElementById('error'); const r=e.getBoundingClientRect(); return !e.hidden && !!e.closest('#left') && r.height>0})()`));
    await ev(`window.__app.S.actionError=null; window.__app.render()`); await settle();

    // pinned areas stay visible while the bars' content scrolls (short window so that the left bar has something to scroll)
    await go('#/tile/' + tileName); await settle();
    win.setSize(1500, 470); await sleep(600);
    await ev(`document.querySelector('button.sectog[data-sec="feeds"]').click()`); await sleep(300);
    const sc = await ev(`(()=>{const p=document.getElementById('panel'); p.scrollTop=p.scrollHeight; return {max:p.scrollHeight-p.clientHeight, p:p.scrollTop}})()`);
    check('left content scrolls when long, in its own area', sc.max > 0 && sc.p > 0, JSON.stringify(sc));
    const pin = await ev(`(()=>{const so=document.getElementById('signoff').getBoundingClientRect(), pin=document.getElementById('lpin').getBoundingClientRect(), bar=document.getElementById('left').getBoundingClientRect(), tab=document.querySelector('#lpin table.sig').getBoundingClientRect(), pn=document.getElementById('panel').getBoundingClientRect(); return {so:[so.top,so.bottom], pinBottom:pin.bottom, barBottom:bar.bottom, tab:[tab.top,tab.bottom], pnBottom:pn.bottom, winH:innerHeight}})()`);
    check('Sign off and the signature block stay in view at the bottom of the left bar', pin.so[1] <= pin.winH && Math.abs(pin.barBottom - pin.pinBottom) <= 1 && pin.tab[0] >= 0 && pin.pnBottom <= pin.tab[0] + 1, JSON.stringify(pin));
    await ev('window.__app.refresh().then(()=>window.__app.render())'); await ev('window.__app.idle()'); await sleep(300);
    check('scroll position is kept across a refresh', await ev(`Math.abs(document.getElementById('panel').scrollTop-${sc.p})<=1`), await ev(`document.getElementById('panel').scrollTop`) + ' vs ' + sc.p);
    check('the pinned signature block did not move across the refresh', Math.abs(await ev(`document.getElementById('signoff').getBoundingClientRect().top`) - pin.so[0]) <= 1);
    await ev(`document.getElementById('panel').scrollTop=0`); await sleep(100);
    check('the signature block does not move when the left content scrolls', Math.abs(await ev(`document.getElementById('signoff').getBoundingClientRect().top`) - pin.so[0]) <= 1);
    // chat: the input stays at the very bottom of the right bar and the log scrolls on its own
    if (await ev('!!window.api.agent')) {
      for (let i = 0; i < 14; i++) ctl.agent.inject({ type: 'agent', scope: { level: 'tile', id: tileName }, text: 'Filler line ' + i + ' to make the log long enough to scroll in a short window.' });
      await sleep(400);
      const cs = await ev(`(()=>{const l=document.getElementById('agentlog-log'); l.scrollTop=0; const i=document.getElementById('agentlog-input').getBoundingClientRect(), bar=document.getElementById('rightbar').getBoundingClientRect(); return {scrolls:l.scrollHeight>l.clientHeight, inputBottom:i.bottom, barBottom:bar.bottom, inputTop:i.top, logBottom:l.getBoundingClientRect().bottom, h:innerHeight}})()`);
      check('chat: the log scrolls on its own while the input stays pinned at the bottom of the bar', cs.scrolls && cs.inputBottom <= cs.barBottom + 1 && cs.inputBottom >= cs.barBottom - 40 && cs.logBottom <= cs.inputTop + 1 && cs.inputBottom <= cs.h, JSON.stringify(cs));
      await shot('layout-short-window' + SFX);
      ctl.agent.log.length = 0; await ev('window.__app.render()');
    } else await shot('layout-short-window' + SFX);
    await ev(`document.querySelector('button.sectog[data-sec="feeds"]').click()`);
    win.setSize(1500, 950); await sleep(600);

    // narrow window: the right bar starts collapsed unless the reviewer has chosen
    ctl.setSetting('showRightBar', undefined); await sleep(300);
    check('settings file has no right-bar choice now', !('showRightBar' in saved()), JSON.stringify(saved()));
    win.setSize(1000, 800); await sleep(600);
    await reloadWin(); await settle();
    check('narrow window (<1200px) with no choice: right bar starts collapsed, left open', await ev(`innerWidth<1200 && document.getElementById('rightbar').classList.contains('collapsed') && !document.getElementById('left').classList.contains('collapsed')`), await ev('innerWidth'));
    check('narrow start does not write a choice and the menu item follows the screen', !('showRightBar' in saved()) && menuItem('showRightBar').checked === false);
    await shot('layout-narrow' + SFX);
    await ev(`document.getElementById('rightstrip').click()`); await settle();
    check('opening it at a narrow width is a choice and is remembered', saved().showRightBar === true);
    await reloadWin(); await settle();
    check('explicit choice beats the narrow default after a reload', await ev(`!document.getElementById('rightbar').classList.contains('collapsed')`));
    win.setSize(1500, 950); await sleep(600);
    await reloadWin(); await settle();
  }

  // The centre switch: Spreadsheet, Code, Test.
  async function centreSet(tileName, otherTile) {
    const segSel = () => ev(`[...document.querySelectorAll('button.seg')].filter(b=>b.getAttribute('aria-selected')==='true').map(b=>b.dataset.seg)`);
    const codeShown = () => ev(`(()=>{const w=document.getElementById('codewrap'); return !w.hidden && w.getBoundingClientRect().height>0})()`);
    await go('#/tile/' + tileName); await settle();
    check('centre: three segments, square, in order Spreadsheet, Code, Test', await ev(`(()=>{const b=[...document.querySelectorAll('#seg button.seg')].filter(x=>!x.hidden); const cs=getComputedStyle(document.getElementById('seg')); return b.map(x=>x.textContent).join('|')==='Spreadsheet|Code|Test' && cs.borderTopLeftRadius==='0px' && cs.borderTopWidth==='1px'})()`));
    check('centre: the switch is first in the bar above the spreadsheet, left-aligned', await ev(`(()=>{const s=document.getElementById('seg').getBoundingClientRect(), c=document.getElementById('cbar').getBoundingClientRect(); return Math.abs(s.left-c.left-14)<=2 && document.getElementById('cbar').firstElementChild.id==='seg'})()`));
    check('centre: Spreadsheet is selected by default and the code pane is closed', (await segSel()).join() === 'spreadsheet' && !(await codeShown()));
    check('centre: selected segment is navy with sand text', await ev(`(()=>{const b=document.getElementById('seg-spreadsheet'), cs=getComputedStyle(b); return cs.backgroundColor==='rgb(20, 33, 61)' && cs.color==='rgb(244, 239, 230)'})()`));
    await ev(`document.querySelector('#gridhost iframe').__mark = 'alive'; true`);
    const opens0 = await ev('window.__gridLog.opens.length'), gw0 = await gridW();
    const q = await ev(`(()=>{const x=window.__app.S.graph.quantities[${JSON.stringify(tileName)}]; return {file:x.source.file, line:x.source.line, code:x.source.code}})()`);

    await ev(`document.getElementById('seg-code').click()`); await sleep(500);
    check('centre: Code shows the tile source with its file and line above it', (await codeShown()) && (await segSel()).join() === 'code' && await ev(`document.getElementById('srcpath').innerText.includes(${JSON.stringify(q.file)}) && document.getElementById('srcpath').innerText.includes('line ${q.line}') && document.querySelector('#codewrap .src').dataset.code===${JSON.stringify(q.code)}`));
    check('centre: line numbers start at the real line in the file', await ev(`document.querySelector('#codewrap .src .l .n').textContent==='${q.line}' && document.querySelectorAll('#codewrap .src .l').length===${q.code.replace(/\n$/, '').split('\n').length}`));
    check('centre: code is monospace, read-only, selectable, full width', await ev(`(()=>{const s=document.querySelector('#codewrap .src'), cs=getComputedStyle(s); return cs.fontFamily.includes('mono') || cs.fontFamily.includes('Menlo') || cs.fontFamily.includes('Consolas'); })() && !document.querySelector('#codewrap textarea, #codewrap input, #codewrap [contenteditable]') && getComputedStyle(document.querySelector('#codewrap .src .t')).userSelect!=='none' && Math.abs(document.getElementById('codewrap').getBoundingClientRect().width-document.getElementById('stage').getBoundingClientRect().width)<=1`));
    check('centre: the spreadsheet iframe is kept (hidden behind), not destroyed or reloaded', await ev(`document.querySelector('#gridhost iframe').__mark==='alive' && window.__gridLog.opens.length===${opens0}`));
    await shot('centre-code' + SFX);
    await ev(`document.getElementById('seg-test').click()`); await sleep(500);
    check('centre: Test shows the tile test file and a Run this test button', (await segSel()).join() === 'test' && await ev(`document.getElementById('srcpath').innerText.includes('tests/tiles/test_${tileName}.py') && document.querySelector('#codewrap .src').dataset.code.includes('def test_') && !!document.getElementById('runtest')`));
    await ev(`document.getElementById('runtest').click()`);
    check('centre: Run this test shows Passed.', await waitFor(`document.getElementById('testresult') && document.getElementById('testresult').innerText.includes('Passed.')`, 10000), await ev(`document.getElementById('codewrap').innerText.slice(0,300)`));
    await shot('centre-test' + SFX);
    await ev(`document.getElementById('seg-spreadsheet').click()`); await sleep(400);
    check('centre: back on Spreadsheet the same iframe is there at the same size, instantly', (await segSel()).join() === 'spreadsheet' && !(await codeShown()) && await ev(`document.querySelector('#gridhost iframe').__mark==='alive' && window.__gridLog.opens.length===${opens0}`) && Math.abs((await gridW()) - gw0) <= 1);
    check('centre: the grid is still usable after the round trip', await gc(`async g => (await g.docInspect()).sheets.length > 0`));

    // shortcuts: keys in the page and the View menu items
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'2',metaKey:true,bubbles:true}))`); await sleep(300);
    check('centre: Cmd+2 selects Code', (await segSel()).join() === 'code' && await codeShown());
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'3',ctrlKey:true,bubbles:true}))`); await sleep(300);
    check('centre: Ctrl+3 selects Test', (await segSel()).join() === 'test');
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'1',metaKey:true,bubbles:true}))`); await sleep(300);
    check('centre: Cmd+1 selects Spreadsheet', (await segSel()).join() === 'spreadsheet');
    check('centre: View menu has Spreadsheet, Code, Test with CmdOrCtrl+1, 2, 3', menuItem('centreSpreadsheet').accelerator === 'CmdOrCtrl+1' && menuItem('centreCode').accelerator === 'CmdOrCtrl+2' && menuItem('centreTest').accelerator === 'CmdOrCtrl+3');
    menuItem('centreCode').click(); await sleep(400);
    check('centre: the menu item Code selects Code', (await segSel()).join() === 'code');

    // remembered per level
    await go('#/module/' + await ev(`window.__app.S.graph.modules[0].id`)); await settle();
    check('centre: a module has no Test segment and starts on Spreadsheet (per-level choice)', await ev(`document.getElementById('seg-test').hidden`) && (await segSel()).join() === 'spreadsheet' && !(await codeShown()));
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'3',metaKey:true,bubbles:true}))`); await sleep(200);
    check('centre: Cmd+3 does nothing on a module', (await segSel()).join() === 'spreadsheet');
    await ev(`document.getElementById('seg-code').click()`); await sleep(500);
    const modFile = await ev(`(()=>{const m=window.__app.S.graph.modules[0]; return window.__app.S.graph.quantities[m.tiles[0]].source.file})()`);
    check('centre: module Code shows the whole module file', await ev(`document.getElementById('srcpath').innerText.includes(${JSON.stringify(modFile)}) && document.querySelector('#codewrap .src').dataset.code.includes('# module file') && document.querySelector('#codewrap .src .l .n').textContent==='1'`), await ev(`document.getElementById('codewrap').innerText.slice(0,200)`));
    await shot('centre-module-code' + SFX);
    await go('#/model'); await settle();
    check('centre: model level starts on Spreadsheet and has no Test', await ev(`document.getElementById('seg-test').hidden`) && (await segSel()).join() === 'spreadsheet');
    await ev(`document.getElementById('seg-code').click()`); await sleep(500);
    check('centre: model Code shows tilekit.toml', await ev(`document.getElementById('srcpath').innerText.includes('tilekit.toml') && document.querySelector('#codewrap .src').dataset.code.includes('[model]')`), await ev(`document.getElementById('codewrap').innerText.slice(0,200)`));
    await ev(`document.getElementById('seg-spreadsheet').click()`); await sleep(300);
    await go('#/tile/' + tileName); await settle();
    check('centre: the tile level still shows Code (remembered per level)', (await segSel()).join() === 'code' && await codeShown());
    check('centre: choices written to the settings file', JSON.stringify(saved().centre) === JSON.stringify({ tile: 'code', module: 'code', model: 'spreadsheet' }), JSON.stringify(saved().centre));
    await reloadWin(); await go('#/tile/' + tileName); await settle();
    check('centre: the choice survives a reload', (await segSel()).join() === 'code' && await codeShown());

    // Was and Now: the source changed since it was last shown, on a tile that is not signed off
    await go('#/tile/' + otherTile); await settle();
    await ev(`document.getElementById('seg-code').click()`); await sleep(400);
    check('centre: no Was/Now while the source is unchanged', await ev(`!document.getElementById('srcpair')`));
    await ev(`Object.assign(window.__app.S.status.tiles[${JSON.stringify(otherTile)}], {state:'stale', drift:'formula', signed_formula:'=old'}); window.__app.render()`); await settle();
    const orig = await ev(`window.__app.S.graph.quantities[${JSON.stringify(otherTile)}].source.code`);
    await ev(`window.__app.S.graph.quantities[${JSON.stringify(otherTile)}].source.code += '\\n    # edited by the agent'; window.__app.render()`); await settle();
    check('centre: a changed tile shows one listing with the added line marked, and keeps both texts', await ev(`!!document.getElementById('srcpair') && document.querySelector('#srcwas .src').dataset.code===${JSON.stringify(orig)} && document.querySelector('#srcnow .src').dataset.code.includes('# edited by the agent') && document.querySelectorAll('#srcdiff .l.add').length===1 && document.querySelector('#srcdiff .l.add .t').textContent.includes('# edited by the agent') && document.querySelectorAll('#srcdiff .l.del').length===0 && /1 line added/.test(document.querySelector('#srcpair .srclab').textContent)`));
    await ev(`document.getElementById('srcack').click()`); await settle();
    check('centre: Acknowledge changes clears the highlighting and records nothing', await ev(`!document.getElementById('srcpair') && !!document.querySelector('#codewrap .src')`));
    await shot('centre-was-now' + SFX);
    await ev(`document.getElementById('seg-spreadsheet').click()`); await sleep(300);
    await ev(`document.getElementById('seg-spreadsheet').click()`);
  }

  // The rest of the chat contract: reconfirm cards, request outcomes after a reload, refusals, draft kinds, questions with
  // a request, interrupt, and File > New model. Driven by the stub (the real backend is covered by live-agent.js).
  async function chatMore(tileName) {
    const stub = ctl.agent;
    const scope = { level: 'tile', id: tileName };
    const cardText = id => ev(`(()=>{const c=document.querySelector('.alog-card[data-request="${id}"]'); return c ? c.innerText : null})()`);
    const hasBtn = id => ev(`!!document.querySelector('.alog-card[data-request="${id}"] button[data-act]')`);
    await go('#/tile/' + tileName); await settle();
    check('chat: window.api.agent has requests(), interrupt() without a scope, confirmSignoff and declineSignoff', await ev(`typeof window.api.agent.requests==='function' && window.api.agent.interrupt.length===0 && typeof window.api.agent.confirmSignoff==='function' && typeof window.api.agent.declineSignoff==='function'`));
    await ev(`window.api.agent.interrupt()`);
    check('chat: interrupt takes no scope', stub.calls.interrupt === 1);

    // a reconfirm card: the tiles that would be renewed, what is skipped and why, no assumption boxes
    stub.inject({ type: 'signoff_request', scope: { level: 'module', id: 'm' }, text: 'Two tiles can be renewed.', request: { id: 'req-rc', kind: 'reconfirm', name: 'unit_projection', module: 'unit_projection', label: 'Unit projection', spec: '', formula: '', assumed: ['ignored'], cases: [], blockers: [], values_only: false, tiles: [{ name: 'deaths', label: 'Deaths' }, { name: 'lapses', label: 'Lapses' }], skipped: [{ name: 'irr_pm', reason: 'values-only tile; sign it off again on its own' }], status: 'pending' } });
    await waitFor(`!!document.querySelector('.alog-card[data-request="req-rc"]')`, 5000);
    await waitFor(`document.querySelector('.alog-card[data-request="req-rc"] [data-f=reviewer]').value.length>0`, 5000);
    const rc = (await cardText('req-rc')).toLowerCase();
    check('chat: a reconfirm card lists the tiles to renew and those skipped with reasons, and has no assumption boxes', rc.includes('tiles that would be renewed') && rc.includes('deaths') && rc.includes('lapses') && rc.includes('not renewed') && rc.includes('irr_pm: values-only tile') && await ev(`!document.querySelector('.alog-card[data-request="req-rc"] input.assume')`), rc);
    check('chat: its button is "Re-confirm" and is enabled once there is a reviewer name', await ev(`(()=>{const b=document.querySelector('.alog-card[data-request="req-rc"] button[data-act=signoff]'); return b.textContent==='Re-confirm' && !b.disabled})()`));
    await ev(`document.querySelector('.alog-card[data-request="req-rc"] button[data-act=signoff]').click()`);
    check('chat: re-confirming calls confirmSignoff and says "Re-confirmed by NAME."', await waitFor(`document.querySelector('.alog-card[data-request="req-rc"]').innerText.includes('Re-confirmed by ')`, 5000) && stub.calls.confirm.some(c => c.id === 'req-rc'));

    // a newer request for the same thing supersedes an older pending card at once
    const rq = (id, extra = {}) => ({ type: 'signoff_request', scope, text: 'Ready.', request: { id, kind: 'tile', name: tileName, label: 'Gross profit', spec: 's', formula: '=a', assumed: ['One'], cases: [{ id: 'base', name: 'Base', pass: true }], blockers: [], values_only: false, status: 'pending', ...extra } });
    stub.inject(rq('req-s1')); await waitFor(`!!document.querySelector('.alog-card[data-request="req-s1"]')`, 5000);
    stub.reqStatus['req-s1'] = 'superseded';
    stub.inject(rq('req-s2')); await waitFor(`!!document.querySelector('.alog-card[data-request="req-s2"]')`, 5000);
    check('chat: a newer request supersedes the older card: no buttons, says so', await waitFor(`document.querySelector('.alog-card[data-request="req-s1"]').innerText.includes('Superseded') && !document.querySelector('.alog-card[data-request="req-s1"] button')`, 5000) && await hasBtn('req-s2'));
    // an expired request, and one the backend refuses
    stub.reqStatus['req-exp'] = 'expired'; stub.inject(rq('req-exp'));
    stub.inject(rq('req-ref', { name: 'other_tile' })); await waitFor(`!!document.querySelector('.alog-card[data-request="req-ref"]')`, 5000);
    stub.refuse = 'Not signed: the model changed after this was asked.';
    await ev(`(()=>{const c=document.querySelector('.alog-card[data-request="req-ref"]'); c.querySelector('input.assume').click()})()`);
    await waitFor(`document.querySelector('.alog-card[data-request="req-ref"] [data-f=reviewer]').value.length>0`, 5000);
    await ev(`document.querySelector('.alog-card[data-request="req-ref"] button[data-act=signoff]').click()`);
    check('chat: a refused sign-off shows the reason in the card and leaves it pending', await waitFor(`document.querySelector('.alog-card[data-request="req-ref"]').innerText.includes('the model changed after this was asked')`, 5000) && await hasBtn('req-ref'), await cardText('req-ref'));
    stub.refuse = null;
    await ev(`document.querySelector('.alog-card[data-request="req-ref"] button[data-act=decline]').click()`);
    await waitFor(`!document.querySelector('.alog-card[data-request="req-ref"] button')`, 5000);

    // draft kinds: a plain list of what would be added, and "Working…" while a slow accept runs
    stub.inject({ type: 'draft', scope, text: 'A parameter and an input.', draft: { id: 'dr-params', kind: 'params', items: [{ name: 'surrender_rate', label: 'Surrender rate', default: 0.05 }], warnings: [] } });
    await waitFor(`!!document.querySelector('[data-draft="dr-params"]')`, 5000);
    check('chat: a params draft shows the label, name and default of the parameter in a table above Accept and Discard', await ev(`(()=>{const d=document.querySelector('[data-draft="dr-params"]'); return d.querySelector('.cardsec').textContent==='Parameters to add' && [...d.querySelectorAll('.draftitem td')].map(x=>x.textContent).join('|')==='Surrender rate|surrender_rate|0.05' && d.querySelector('.draftitem .dval') && [...d.querySelectorAll('button')].map(b=>b.textContent).join('|')==='Accept|Discard' && d.querySelector('.cardsec').compareDocumentPosition(d.querySelector('button'))&4})()`));
    await ev(`document.querySelector('[data-draft="dr-params"] button[data-act=accept]').click()`);
    check('chat: accepting a params draft shows "Working…" in the chat while it runs', await waitFor(`document.querySelector('[data-draft="dr-params"] .alog-done').innerText==='Working…'`, 600));
    check('chat: and then "Accepted."', await waitFor(`document.querySelector('[data-draft="dr-params"]').innerText.includes('Accepted.') && !document.querySelector('[data-draft="dr-params"] button')`, 8000));
    stub.inject({ type: 'draft', scope, text: 'Two tiles.', draft: { id: 'dr-tiles', kind: 'tiles', module: 'unit_projection', items: [{ name: 'surrender_charge', label: 'Surrender charge', formula: '=a*b' }, { name: 'second_tile', label: 'Second' }] } });
    stub.inject({ type: 'draft', scope, text: 'An input.', draft: { id: 'dr-inputs', kind: 'inputs', items: [{ type: 'model_point', name: 'sum_assured', label: 'Sum assured' }, { type: 'table', name: 'mortality' }] } });
    stub.inject({ type: 'draft', scope, text: 'A case.', draft: { id: 'dr-cases', kind: 'cases', items: [{ id: 'young', name: 'Young policyholder' }] } });
    await waitFor(`!!document.querySelector('[data-draft="dr-cases"]')`, 5000);
    check('chat: tiles, inputs and cases drafts are tables too', await ev(`(()=>{const t=d=>document.querySelector('[data-draft="'+d+'"]').innerText.toLowerCase(); return t('dr-tiles').includes('tiles to add (in unit_projection)') && /surrender charge\\s+surrender_charge/.test(t('dr-tiles')) && t('dr-tiles').includes('=a*b') && t('dr-inputs').includes('inputs to add') && /sum assured\\s+sum_assured\\s+model_point/.test(t('dr-inputs')) && /mortality\\s+table/.test(t('dr-inputs')) && /young policyholder\\s+young/.test(t('dr-cases'))})()`));
    for (const d of ['dr-tiles', 'dr-inputs', 'dr-cases']) await ev(`document.querySelector('[data-draft="${d}"] button[data-act=discard]').click()`);
    await waitFor(`!document.querySelector('#agentlog-log .alog-draft button')`, 5000);

    // a question that carries a request is an ordinary question
    stub.inject({ type: 'question', scope, text: 'I need a surrender rate. What should it be?', request: { kind: 'parameter', description: 'The annual surrender rate' } });
    await waitFor(`document.querySelector('#agentlog-log .alog-question:last-child, #agentlog-log .alog-line:last-child.alog-question')`, 5000);
    check('chat: a question with a request is drawn as a normal question and counts as waiting', await ev(`[...document.querySelectorAll('#agentlog-log .alog-question')].pop().innerText.includes('I need a surrender rate')`));

    // after a reload every card shows its outcome (from requests()), pending ones keep their buttons
    await reloadWin(); await settle();
    const o = id => cardText(id);
    check('chat: after a reload the cards show what became of them, rebuilt from the request files', (await o('req-one')).includes('Signed off by ') && !(await hasBtn('req-one')) && (await o('req-two')).includes('Not signed.') && !(await hasBtn('req-two')) && (await o('req-exp')).includes('Expired') && !(await hasBtn('req-exp')) && (await o('req-s1')).includes('Superseded') && !(await hasBtn('req-s1')) && (await o('req-rc')).includes('Re-confirmed by ') && await hasBtn('req-s2'), JSON.stringify(await ev(`[...document.querySelectorAll('.alog-card')].map(c=>c.dataset.request+': '+c.innerText.slice(-60).replace(/\\s+/g,' '))`)));
    await ev(`document.querySelector('.alog-card[data-request="req-s2"] button[data-act=decline]').click()`);
    await waitFor(`!document.querySelector('.alog-card button')`, 5000);
  }

  // File > New model: the dialog (name, local folder with Choose…, GitHub link); a bad link is refused plainly, before anything runs.
  async function newModelSet() {
    await go('#/model'); await settle();
    ctl.win.webContents.send('menu', 'newModel');
    check('New model: the dialog opens with a name, a local folder with Choose…, and a GitHub link', await waitFor(`!!document.getElementById('f-name') && !!document.getElementById('f-folder') && !!document.getElementById('pickfolder') && !!document.getElementById('f-github') && document.getElementById('dialog').innerText.includes('New model')`, 5000));
    check('New model: Create is disabled until all three are filled', await ev(`document.getElementById('confirm').disabled`));
    await ev(`document.getElementById('pickfolder').click()`);
    check('New model: Choose… fills the local folder', await waitFor(`document.getElementById('f-folder').value.length>3`, 5000));
    await ev(`(()=>{for (const [id,v] of [['f-name','Fresh model'],['f-github','https://example.com/not/github']]) { const n=document.getElementById(id); n.value=v; n.dispatchEvent(new Event('input',{bubbles:true})) }})()`);
    check('New model: Create is enabled', await ev(`!document.getElementById('confirm').disabled`));
    await ev(`document.getElementById('confirm').click()`);
    check('New model: a link that is not a GitHub link is refused plainly and the dialog stays open', await waitFor(`document.getElementById('dialogerrors') && /not a GitHub link/.test(document.getElementById('dialogerrors').innerText) && !!document.getElementById('dialog')`, 10000), await ev(`document.getElementById('dialog').innerText`));
    check('New model: no chat prefill is left behind after a failure', await ev(`sessionStorage.getItem('tessera.prefill')===null && document.getElementById('agentlog-input').value===''`));
    await shot('new-model-dialog' + SFX);
    await ev(`document.getElementById('cancel').click()`);
    check('New model: Cancel closes it', await waitFor(`!document.getElementById('dialog')`, 3000));
    check('Header: the model name and the logo are links back to the launch page', await ev(`document.getElementById('modelname').getAttribute('href')==='#/launch' && document.getElementById('home').getAttribute('href')==='#/launch'`));
  }

  // A model with no modules yet.
  async function emptyModelSet() {
    await go('#/model'); await settle();
    await ev(`(()=>{const a=window.__app; a.S.graph={...a.S.graph, modules:[], quantities:{}, order:[], edges:[]}; a.S.status={...a.S.status, tiles:{}, modules:{}}; a.S.cases=[]; a.render()})()`); await settle();
    check('empty model: "No modules yet. Use the chat to scaffold the model." replaces the map', await ev(`document.getElementById('nomodules') && document.getElementById('nomodules').innerText==='No modules yet. Use the chat to scaffold the model.' && !document.querySelector('#panel svg.map')`));
    check('empty model: row 2 (the tile strip) is hidden and only the Model tab is there', await ev(`document.getElementById('tiles').hidden && document.querySelectorAll('#mods a').length===1`));
    check('empty model: the chat starters and the page itself are intact', await ev(`!document.getElementById('error').hidden===false && !!document.getElementById('agentlog-input')`));
    await shot('empty-model' + SFX);
    await ev(`window.__app.refresh().then(()=>window.__app.render())`); await settle();
    check('empty model: refreshing restores the real model', await ev(`window.__app.S.graph.modules.length>0 && !document.getElementById('nomodules')`));
  }

  // The chat bar, driven by the test agent stub.
  async function chatSet(tileName, moduleId, moduleTitle) {
    const stub = ctl.agent;
    const lines = () => ev(`[...document.querySelectorAll('#agentlog-log .alog-line:not(.alog-working)')].map(l => ({ lab: l.querySelector('.alog-lab').textContent, txt: l.querySelector('.alog-txt').innerText }))`);
    const dividers = () => ev(`[...document.querySelectorAll('#agentlog-log .alog-divider')].map(d => d.textContent)`);
    const say = async text => { const before = stub.calls.send.length; await ev(`(()=>{const i=document.getElementById('agentlog-input'); i.value=${JSON.stringify(text)}; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`); await waitFor(`!document.getElementById('agentlog-input').disabled && document.getElementById('agentlog-log').innerText.includes(${JSON.stringify('Answer to: ' + text)}) || ${JSON.stringify(/question|draft/.test(text))}`, 8000); await waitFor(`!document.getElementById('agentlog-input').disabled`, 8000); return stub.calls.send.length - before; };
    stub.log.length = 0; stub.calls.send.length = 0;
    await go('#/tile/' + tileName); await settle(); await ev('window.__app.render()'); await settle();
    check('chat: the input is a multi-line textarea, two rows, in the right bar', await ev(`(()=>{const i=document.getElementById('agentlog-input'); return i.tagName==='TEXTAREA' && i.rows===2 && !!i.closest('#rightbar')})()`));
    check('chat: tile placeholder is a real example', await ev('document.getElementById("agentlog-input").placeholder') === 'Cap the charge at 1.00 unit a month');
    check('chat: empty conversation shows the tile starters as links above the input', await ev(`(()=>{const s=document.getElementById('starters'); const i=document.getElementById('agentlog-input'); return !s.hidden && [...s.querySelectorAll('a')].map(a=>a.textContent).join('|')==='What does this tile do?|Why does it change in month 37?|Sign this off' && s.getBoundingClientRect().bottom<=i.getBoundingClientRect().top+1})()`));
    await ev(`document.querySelector('#starters a').click()`);
    check('chat: clicking a starter fills the input and does not send', await ev(`document.getElementById('agentlog-input').value==='What does this tile do?'`) && stub.calls.send.length === 0);
    await ev(`(()=>{const i=document.getElementById('agentlog-input'); i.value='first line'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}));})()`); await sleep(200);
    check('chat: Shift+Enter does not send', stub.calls.send.length === 0);
    check('chat: the input grows with several lines, to a limit', await (async () => { await ev(`(()=>{const i=document.getElementById('agentlog-input'); i.value=Array(12).fill('line').join('\\n'); i.dispatchEvent(new Event('input',{bubbles:true}))})()`); const h2 = await ev(`document.getElementById('agentlog-input').getBoundingClientRect().height`); await ev(`(()=>{const i=document.getElementById('agentlog-input'); i.value='x'; i.dispatchEvent(new Event('input',{bubbles:true}))})()`); const h1 = await ev(`document.getElementById('agentlog-input').getBoundingClientRect().height`); return h2 > h1 && h2 <= 200; })());
    let n = await say('hello about the tile');
    check('chat: Enter sends with the current selection as the scope', n === 1 && stub.calls.send[0].scope.level === 'tile' && stub.calls.send[0].scope.id === tileName, JSON.stringify(stub.calls.send));
    const l1 = await lines();
    check('chat: You and Agent lines with a label column, no starters once there is a conversation', l1.some(l => l.lab === 'You' && l.txt === 'hello about the tile') && l1.some(l => l.lab === 'Agent') && await ev(`document.getElementById('starters').hidden`), JSON.stringify(l1));
    check('chat: a divider names the tile before its first message', (await dividers()).join('|') === tileName, JSON.stringify(await dividers()));
    // other selections: dividers name them; same selection again adds none
    await go('#/module/' + moduleId); await settle();
    check('chat: module placeholder', await ev('document.getElementById("agentlog-input").placeholder') === 'Add a surrender charge that falls to zero over five years');
    check('chat: the whole conversation stays on screen when the selection changes (no new divider until a message is sent)', (await lines()).length === l1.length && (await dividers()).length === 1);
    await say('hello about the module');
    check('chat: a divider names the module by its title when a message is sent there', (await dividers()).join('|') === `${tileName}|${moduleTitle}`, JSON.stringify(await dividers()));
    await go('#/model'); await settle();
    await say('hello about the model'); await say('and again about the model');
    check('chat: a divider names the model, and a second message there adds none', (await dividers()).join('|') === `${tileName}|${moduleTitle}|Model`, JSON.stringify(await dividers()));
    check('chat: scopes sent are tile, module and model', stub.calls.send.map(c => c.scope.level).join() === 'tile,module,model,model');
    const all = await lines();
    check('chat: every exchange is in one log, in order', all.filter(l => l.lab === 'You').map(l => l.txt).join('|') === 'hello about the tile|hello about the module|hello about the model|and again about the model', JSON.stringify(all));
    await shot('chat-conversation' + SFX);
    await reloadWin(); await settle();
    check('chat: after a reload the whole conversation and its three dividers are back (history with no scope)', (await dividers()).join('|') === `${tileName}|${moduleTitle}|Model` && (await lines()).length === all.length, JSON.stringify(await dividers()));
    stub.onlyScoped = true;
    await reloadWin(); await settle();
    check('chat: a backend that only answers history(scope) still works (fallback)', (await lines()).length > 0 && (await lines()).every(l => !/Invalid scope/.test(l.txt)) && (await dividers()).length === 1, JSON.stringify([await lines(), await dividers()]));
    stub.onlyScoped = false;
    await reloadWin(); await settle();

    // starters per level
    stub.log.length = 0; await reloadWin(); await settle();
    const starters = async () => ev(`[...document.querySelectorAll('#starters a')].map(a=>a.textContent).join('|')`);
    check('chat: model starters', (await starters()) === 'What is left to review?|Add a module', await starters());
    await go('#/module/' + moduleId); await settle();
    check('chat: module starters', (await starters()) === 'Build the tiles that are not built|What is left to review here?', await starters());

    // sign-off card
    await go('#/tile/' + tileName); await settle();
    const scope = { level: 'tile', id: tileName };
    const req = (id, extra = {}) => ({ type: 'signoff_request', scope, text: 'This is ready for your review.', request: { id, kind: 'tile', name: tileName, label: 'Gross profit', spec: 'Allocation margin less expenses.', formula: '=a+b', assumed: ['The charge is monthly', 'Rates are annual'], cases: [{ id: 'base', name: 'Base', pass: true }, { id: 'high', name: 'High charge', pass: false }], blockers: [], values_only: false, ...extra } });
    stub.inject(req('req-one'));
    await waitFor(`!!document.querySelector('.alog-card[data-request="req-one"]')`, 5000);
    const card = () => ev(`(()=>{const c=document.querySelector('.alog-card[data-request="req-one"]'); const cs=getComputedStyle(c); return {border:cs.borderTopWidth, radius:cs.borderTopLeftRadius, title:c.querySelector('.cardtitle').textContent, formula:c.querySelector('.formula').textContent, boxes:c.querySelectorAll('input.assume').length, cases:[...c.querySelectorAll('.row')].map(r=>r.innerText.replace(/\\s+/g,' ')), reviewer:c.querySelector('[data-f=reviewer]').value, hasComment:!!c.querySelector('[data-f=comment]'), reason:!!c.querySelector('[data-f=reason]'), signDisabled:c.querySelector('button[data-act=signoff]').disabled, buttons:[...c.querySelectorAll('button')].map(b=>b.textContent).join('|')}})()`);
    let c1 = await card();
    check('chat: sign-off card is a plain bordered card with label and code name, formula, two tick boxes', c1.border === '1px' && c1.radius === '0px' && c1.title === `Gross profit, ${tileName}` && c1.formula === '=a+b' && c1.boxes === 2, JSON.stringify(c1));
    check('chat: the card lists cases as agrees / differs, a prefilled reviewer, a comment field, no reason field', c1.cases.join('|') === 'Base agrees|High charge differs' && c1.reviewer.trim().length > 0 && c1.hasComment && !c1.reason, JSON.stringify(c1));
    check('chat: Sign off is disabled until every assumption is ticked; buttons are Sign off and Not now', c1.signDisabled && c1.buttons === 'Sign off|Not now', JSON.stringify(c1));
    await shot('chat-signoff-card' + SFX);
    await ev(`document.querySelector('.alog-card[data-request="req-one"] input.assume').click()`);
    check('chat: still disabled with one of two ticked', (await card()).signDisabled);
    await ev(`document.querySelectorAll('.alog-card[data-request="req-one"] input.assume')[1].click()`);
    check('chat: enabled once every assumption is ticked and there are no blockers', !(await card()).signDisabled);
    // the card is pending: the collapsed chat strip says so
    await ev(`document.getElementById('hideright').click()`); await settle();
    check('chat: collapsed right strip says "confirm" while a sign-off card waits', (await stripText('rightstrip')) === 'Chat confirm', await stripText('rightstrip'));
    await shot('chat-strip-confirm' + SFX);
    await ev(`document.getElementById('rightstrip').click()`); await settle();
    await ev(`(()=>{const c=document.querySelector('.alog-card[data-request="req-one"]'); const m=c.querySelector('[data-f=comment]'); m.value='Looks right'; m.dispatchEvent(new Event('input',{bubbles:true})); c.querySelector('button[data-act=signoff]').click()})()`);
    check('chat: Sign off calls confirmSignoff with reviewer and comment, then says "Signed off by NAME."', await waitFor(`document.querySelector('.alog-card[data-request="req-one"]').innerText.includes('Signed off by ')`, 5000) && stub.calls.confirm.length === 1 && stub.calls.confirm[0].id === 'req-one' && stub.calls.confirm[0].comment === 'Looks right' && stub.calls.confirm[0].reviewer === c1.reviewer.trim() && !(await ev(`!!document.querySelector('.alog-card[data-request="req-one"] button')`)), JSON.stringify(stub.calls.confirm));
    check('chat: nothing is pending any more, so the strip shows no word', await ev(`!document.querySelector('.alog-card button[data-act]')`));
    // blockers
    stub.inject(req('req-two', { blockers: ['Case High charge differs from Python.'] }));
    await waitFor(`!!document.querySelector('.alog-card[data-request="req-two"]')`, 5000);
    await ev(`document.querySelectorAll('.alog-card[data-request="req-two"] input.assume').forEach(b=>b.click())`);
    check('chat: with a blocker Sign off stays disabled when every box is ticked, the blocker is listed and is its title', await ev(`(()=>{const c=document.querySelector('.alog-card[data-request="req-two"]'); const b=c.querySelector('button[data-act=signoff]'); return b.disabled && b.title.includes('High charge differs') && c.innerText.includes('Case High charge differs from Python.')})()`));
    await ev(`document.querySelector('.alog-card[data-request="req-two"] button[data-act=decline]').click()`);
    check('chat: Not now calls declineSignoff and says "Not signed."', await waitFor(`document.querySelector('.alog-card[data-request="req-two"]').innerText.includes('Not signed.') && !document.querySelector('.alog-card[data-request="req-two"] button')`, 5000) && stub.calls.decline.join() === 'req-two');
    // values-only needs a reason
    stub.inject(req('req-three', { values_only: true, assumed: [] }));
    await waitFor(`!!document.querySelector('.alog-card[data-request="req-three"]')`, 5000);
    check('chat: a values-only request has a required reason field and Sign off waits for it', await ev(`(()=>{const c=document.querySelector('.alog-card[data-request="req-three"]'); const b=c.querySelector('button[data-act=signoff]'); const r=c.querySelector('[data-f=reason]'); if(!r||!b.disabled) return false; r.value='Tests cover it'; r.dispatchEvent(new Event('input',{bubbles:true})); return !b.disabled})()`));
    await ev(`document.querySelector('.alog-card[data-request="req-three"] button[data-act=decline]').click()`); await waitFor(`!document.querySelector('.alog-card button[data-act]')`, 5000);

    // a question with options, and a draft: the collapsed strip names each
    stub.inject({ type: 'question', scope, text: 'Which case should I use?', options: ['Base', 'High charge'] });
    await waitFor(`!!document.querySelector('#agentlog-log .alog-question .alog-opts button')`, 5000);
    check('chat: a question shows its options as small buttons', await ev(`[...document.querySelectorAll('#agentlog-log .alog-question:last-of-type .alog-opts button, #agentlog-log .alog-opts button')].map(b=>b.textContent).join('|')==='Base|High charge' && document.querySelector('.alog-opts button').classList.contains('small')`));
    await ev(`document.getElementById('hideright').click()`); await settle();
    check('chat: collapsed right strip says "question"', (await stripText('rightstrip')) === 'Chat question', await stripText('rightstrip'));
    await ev(`document.getElementById('rightstrip').click()`); await settle();
    const nb = stub.calls.send.length;
    await ev(`document.querySelector('.alog-opts button').click()`);
    check('chat: clicking an option sends it as the answer', await waitFor(`!document.getElementById('agentlog-input').disabled`, 8000) && stub.calls.send.length === nb + 1 && stub.calls.send[nb].text === 'Base');
    check('chat: once answered the options are gone and the strip is quiet', await ev(`!document.querySelector('.alog-opts')`));
    // markdown in an agent reply is drawn as structure, never as markup
    stub.inject({ type: 'agent', scope, text: '## Plan\n\nUse the **monthly** rate, not `annual_rate`.\n\n1. First step\n2. Second step\n   - a nested point\n\n| Month | Units |\n|---|---:|\n| 1 | 10.5 |\n\n```python\nx = a * b  # **not bold**\n```\n\n<img src=x onerror=alert(1)> 2 * 3 * 4 and snake_case_name stay as typed.' });
    await waitFor(`!!document.querySelector('#agentlog-log .md table')`, 5000);
    check('chat: an agent reply shows markdown as headings, bold, code, lists and a table', await ev(`(()=>{const m=[...document.querySelectorAll('#agentlog-log .md')].pop(); const t=q=>[...m.querySelectorAll(q)].map(x=>x.textContent).join('|');
      return t('.md-h')==='Plan' && t('strong')==='monthly' && t('p code')==='annual_rate' && m.querySelectorAll('ol > li').length===2 && t('ol ul li')==='a nested point'
        && t('th')==='Month|Units' && t('td')==='1|10.5' && m.querySelector('td.r').textContent==='10.5' && m.querySelector('pre').textContent==='x = a * b  # **not bold**'})()`));
    check('chat: markup and stray symbols in a reply stay as plain text', await ev(`(()=>{const m=[...document.querySelectorAll('#agentlog-log .md')].pop(); const p=[...m.querySelectorAll('p')].pop();
      return !m.querySelector('img') && !p.querySelector('em,strong') && p.textContent==='<img src=x onerror=alert(1)> 2 * 3 * 4 and snake_case_name stay as typed.'})()`));
    await ev(`(()=>{const l=document.getElementById('agentlog-log'); l.scrollTop=l.scrollHeight})()`); await settle();
    await shot('chat-markdown');
    // several questions at once: one form, suggested answers, a box for another answer, one Send
    stub.inject({ type: 'question', scope, text: '1. What is being priced?\n2. Which results?', questions: [
      { question: 'What is being priced?', header: 'Purpose', options: [{ label: 'Profit', description: 'Profit on a block of policies' }, { label: 'Reserve' }] },
      { question: 'Which results?', header: 'Results', multi: true, options: [{ label: 'IRR' }, { label: 'Present values' }] }] });
    await waitFor(`!!document.querySelector('#agentlog-log .qcard')`, 5000);
    check('chat: several questions show as one form with headers, choices and a box for another answer', await ev(`(()=>{const c=document.querySelector('.qcard'); return [...c.querySelectorAll('.cardsec')].map(x=>x.textContent).join('|')==='Purpose|Results' && c.querySelectorAll('input[type=radio]').length===2 && c.querySelectorAll('input[type=checkbox]').length===2 && c.querySelectorAll('.qother').length===2 && getComputedStyle(document.querySelector('.alog-qtext')).display==='none' && c.querySelector('.alog-btns button').disabled})()`));
    await ev(`(()=>{const c=document.querySelector('.qcard'); const fire=(el,t)=>el.dispatchEvent(new Event(t,{bubbles:true})); const r=c.querySelector('input[type=radio]'); r.checked=true; fire(r,'change'); return 1})()`);
    await shot('chat-question-form');
    check('chat: Send answers waits until every question has an answer', await ev(`document.querySelector('.qcard .alog-btns button').disabled`));
    await ev(`(()=>{const c=document.querySelector('.qcard'); const fire=(el,t)=>el.dispatchEvent(new Event(t,{bubbles:true})); const k=c.querySelector('input[type=checkbox]'); k.checked=true; fire(k,'change'); const o=c.querySelectorAll('.qother')[1]; o.value='Reserves'; fire(o,'input'); return 1})()`);
    const nq = stub.calls.send.length;
    await ev(`document.querySelector('.qcard .alog-btns button').click()`);
    check('chat: the answers go as one message, a line per question', await waitFor(`!document.getElementById('agentlog-input').disabled`, 8000) && stub.calls.send.length === nq + 1 && stub.calls.send[nq].text === 'Purpose: Profit\nResults: IRR, Reserves', stub.calls.send[nq] && stub.calls.send[nq].text);
    check('chat: once answered the form is gone and the questions stay as text', await ev(`!document.querySelector('.qcard') && [...document.querySelectorAll('.alog-qtext')].pop().querySelectorAll('ol > li').length===2 && [...document.querySelectorAll('.alog-qtext li')].pop().textContent==='Which results?' && getComputedStyle([...document.querySelectorAll('.alog-qtext')].pop()).display!=='none'`));
    // conversations: start a new one, find the earlier one in the list, open it again, delete one
    const linesNow = () => ev(`document.querySelectorAll('#agentlog-log .alog-line:not(.alog-working)').length`);
    const before = await linesNow();
    check('chat: New conversation and Conversations are offered above the chat', await waitFor(`!document.getElementById('agentlog-top').hidden && /^Conversations \\(1\\)…$/.test(document.getElementById('chatlist').textContent) && !document.getElementById('chatnew').disabled`, 5000), await ev(`document.getElementById('chatlist').textContent`));
    await ev(`document.getElementById('chatnew').click()`);
    check('chat: New conversation empties the chat and keeps the old one in the list', await waitFor(`document.querySelectorAll('#agentlog-log .alog-line:not(.alog-working)').length===0 && document.getElementById('chatnew').disabled`, 5000) && stub.conversations().length === 1 && !stub.conversations()[0].current);
    await say('second conversation');
    await waitFor(`/\\(2\\)/.test(document.getElementById('chatlist').textContent)`, 5000);
    await ev(`document.getElementById('chatlist').click()`);
    await waitFor(`document.querySelectorAll('#chats .chatrow').length===2`, 5000);
    await shot('chat-conversations');
    check('chat: the list shows the conversation on show first, then the earlier one with Open and Delete', await ev(`(()=>{const r=[...document.querySelectorAll('#chats .chatrow')]; return r[0].dataset.id==='current' && /on show/.test(r[0].innerText) && r[0].querySelector('.chattitle').textContent==='second conversation' && !!r[1].querySelector('[data-act=open]') && !!r[1].querySelector('[data-act=delete]')})()`));
    await ev(`document.querySelector('#chats .chatrow[data-id=current] [data-act=delete]').click()`);
    check('chat: Delete asks once more before anything goes', await ev(`!!document.querySelector('#chats [data-act=reallydelete]') && !!document.querySelector('#chats [data-act=keep]')`) && stub.conversations().length === 2);
    await ev(`document.querySelector('#chats [data-act=reallydelete]').click()`);
    check('chat: deleting the conversation on show empties the chat and the list drops it', await waitFor(`document.querySelectorAll('#chats .chatrow').length===1 && document.querySelectorAll('#agentlog-log .alog-line:not(.alog-working)').length===0`, 5000) && stub.conversations().length === 1);
    await ev(`document.querySelector('#chats [data-act=open]').click()`);
    check('chat: Open brings the earlier conversation back and closes the list', await waitFor(`!document.getElementById('dialog') && document.querySelectorAll('#agentlog-log .alog-line:not(.alog-working)').length===${before}`, 8000) && stub.conversations().length === 1 && stub.conversations()[0].current, await linesNow());
    await say('give me a draft');
    check('chat: a draft shows Apply draft and Discard', await ev(`[...document.querySelectorAll('#agentlog-log .alog-draft button')].map(b=>b.textContent).join('|')==='Apply draft|Discard'`));
    await ev(`document.getElementById('hideright').click()`); await settle();
    check('chat: collapsed right strip says "draft"', (await stripText('rightstrip')) === 'Chat draft', await stripText('rightstrip'));
    await ev(`document.getElementById('rightstrip').click()`); await settle();
    await ev(`document.querySelector('#agentlog-log .alog-draft button[data-act=discard]').click()`);
    check('chat: Discard replaces the buttons with "Discarded."', await waitFor(`(()=>{const d=document.querySelector('#agentlog-log .alog-draft'); return d && !d.querySelector('button') && d.innerText.includes('Discarded.')})()`, 5000) && stub.calls.discard.length === 1);
    await ev(`document.getElementById('hideright').click()`); await settle();
    check('chat: nothing waiting: the collapsed strip says only Chat', (await stripText('rightstrip')) === 'Chat', await stripText('rightstrip'));
    await ev(`document.getElementById('rightstrip').click()`); await settle();
    await shot('chat-after' + SFX);
  }

  async function fullSet() {
    const lt = () => ev('window.__both()');
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
    check('full model map fits the panel', await ev(`document.querySelector('svg.map').getBoundingClientRect().width <= document.getElementById('panel').clientWidth - 31`));
    check('full model map is not scrolled sideways, not shrunk', await ev(`(()=>{const w=document.querySelector('.mapwrap'), v=document.querySelector('svg.map'); return w.scrollWidth<=w.clientWidth+1 && v.getBoundingClientRect().width >= v.viewBox.baseVal.width-1})()`));
    await hasF('full model: run tests button', 'Run tests');
    await hasF('full model: stale check wording', 'not run since last change');
    await ev('document.getElementById("runtests").click()');
    check('run tests refreshes the checks', await waitFor(`!window.__both().includes('not run since last change')`));
    await hasF('full model: sentence', '0 of 5 modules signed off');
    await shot('model-full');

    await go('#/module/cashflows');
    check('module view: no tile map in the left bar; reference, title, status, then Module checks, Cases', await ev(`(()=>{const t=[...document.querySelectorAll('#panel h3.sec')].map(h=>h.textContent); return !document.querySelector('#panel svg.map, #panel .mapwrap, #panel .legend') && !t.includes('Tiles') && t.join('|')==='Module checks|Cases' && document.querySelector('#panel .ref') && document.getElementById('title') && document.getElementById('sentence') && !!document.querySelector('#lpin #signoff')})()`), await ev(`[...document.querySelectorAll('#panel h3.sec')].map(h=>h.textContent).join('|')`));
    check('module view: the tile strip shows the flow, with parameters-free tile boxes as links', await ev(`document.querySelectorAll('#tiles a.t').length >= 5 && document.querySelector('#tiles').innerText.includes('allocation_margin')`));
    check('full cashflows: workbook out of date line', await ev(`!document.getElementById('stalebar').hidden && document.getElementById('stalebar').innerText.includes('This workbook is out of date. Rebuild to see current numbers.')`));
    await shot('module-full');
    await go('#/module/decrements');
    check('full decrements: the strip links on to the next module', await ev(`!!document.querySelector('#tiles a.t.next') && document.querySelector('#tiles a.t.next').innerText.includes('next module')`));
    await shot('module-decrements-full');
    await go('#/module/profit');
    await shot('module-profit-full');

    // tile views
    await go('#/tile/allocation_margin');
    await hasF('stale formula sentence', "Stale: this tile's formula changed since sign-off.");
    await hasFH('changed since sign-off section', 'Changed since sign-off');
    check('was and now formulas', await ev(`document.querySelector('.was').textContent==='=premium*(1-allocation_rate)'`) && await ev(`document.querySelector('.now').textContent.includes('in_force_eop')`));
    await shot('tile-formula-drift-full');
    check('blocked by can_sign_off: Sign off disabled, first blocker is its title, blocker listed in Checks', await ev(`(()=>{const b=document.getElementById('signoff'); return b.disabled && b.title.includes('formula changed since sign-off') && document.getElementById('panel').innerText.includes('formula changed since sign-off') && !document.getElementById('dialog')})()`));
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
    check('failing difference blocks sign-off with its sentence', await ev(`(()=>{const b=document.getElementById('signoff'); return b.disabled && b.title.includes('0.0021') && document.getElementById('panel').innerText.includes('0.0021')})()`));
    await go('#/tile/sum_at_risk'); await hasF('uncovered branch blocker visible in checks', 'Branch not covered');
    check('left bar sections of a tile, in order (Code is not one of them)', await ev(`(()=>{const t=[...document.querySelectorAll('#panel h3.sec')].map(h=>h.firstElementChild?h.firstElementChild.firstChild.textContent:h.textContent); const want=['Spec','Formula reviewed','Relies on','Feeds into','Assumptions to confirm','Cases agreed to Python','Checks']; let i=-1; return want.every(w=>{const j=t.indexOf(w); const ok=j>i; i=j; return ok}) && !t.includes('Code') && !!document.querySelector('#lpin table.sig') && !!document.querySelector('#lpin #signoff') && !!document.querySelector('#lpin #rebuild')})()`));
    await go('#/tile/gross_profit');
    await shot('tile-full');
    await go('#/tile/maintenance_expense');
    await hasF('unbuilt tile', 'No workbook yet'); check('unbuilt tile offers Build', await ev(`!!document.getElementById('build')`));
    await go('#/module/quota_share'); await shot('module-quota-full');

    // long code does not widen the panel
    await go('#/tile/gross_profit');
    await ev(`document.querySelector('button.sectog[data-sec="feeds"]').click()`);
    check('long lines do not widen either bar, and the Code pane scrolls instead', await ev(`['left','panel','rightbar'].every(id=>{const l=document.getElementById(id);return l.scrollWidth<=l.clientWidth+1})`));
    await ev(`document.querySelector('button.sectog[data-sec="feeds"]').click()`);

    // (scroll positions across a refresh are checked in layoutSet, in a window short enough for the left bar to scroll)

    // agent log mount point
    check('chat region exists in the right bar: log, textarea input, starters', await ev(`(()=>{const s=document.getElementById('agentlog');return !!s && !s.hidden && !!s.querySelector('#agentlog-log') && s.querySelector('#agentlog-input').tagName==='TEXTAREA' && !!s.querySelector('#starters') && s.parentElement.id==='rightbar'})()`));
    for (const hh of ['#/model', '#/module/profit', '#/tile/deaths']) { await go(hh); check('chat present in ' + hh, await ev(`!!document.querySelector('#rightbar > #agentlog')`)); }

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
    const log = await ev('window.__gridLog');
    summary.gridLog = { ready: log.ready, opens: log.opens.length, saves: log.saves };
  }


  // ---------------------------------------------------------------- tracing a value back to its source (trace.js)
  // The stored workbooks of the example model (house style, dark green upstream rows) stand in for the fixture ones.
  async function traceSet() {
    const REVIEW = path.resolve(__dirname, '../../model/review');
    const overlay = ['tiles/units_allocated', 'tiles/units_after_alloc', 'tiles/units_amc', 'tiles/units_eop', 'modules/unit_projection', 'model']
      .concat(FULL ? ['tiles/amc_income', 'tiles/fund_value_eop'] : []);
    for (const rel of overlay) {
      const from = path.join(REVIEW, rel, 'workbook.xlsx');
      if (!fs.existsSync(from)) { check('trace: stored workbook to test with: ' + rel, false, from); return; }
      fs.mkdirSync(path.join(fixturesCopy, 'review', rel), { recursive: true });
      fs.copyFileSync(from, path.join(fixturesCopy, 'review', rel, 'workbook.xlsx'));
    }
    win.setSize(1500, 950); await sleep(400);
    const line = () => ev(`(()=>{const b=document.getElementById('tracebar'); return b.hidden ? '' : b.innerText.replace(/\\s+/g,' ').trim()})()`);
    const at = () => gc(`async g => { const d = await g.docInspect(); return (d.sheets[d.activeSheet] || {}).name + '!' + d.activeCell; }`);
    const sel = async (cell, sheet) => { await gc(`async g => { ${sheet ? `await g.execute('sheet.activate', { sheet: ${JSON.stringify(sheet)} });` : ''} await g.execute('selection.set', { range: ${JSON.stringify(cell)} }); }`); };
    const lineIs = async (want, ms = 5000) => { const ok = await waitFor(`(()=>{const b=document.getElementById('tracebar'); return (b.hidden ? '' : b.innerText.replace(/\\s+/g,' ').trim()) === ${JSON.stringify(want)}})()`, ms); return ok ? true : false; };
    const atIs = async (want, ms = 8000) => { const t = Date.now(); let got; while (Date.now() - t < ms) { got = await at().catch(() => null); if (got === want) return true; await sleep(120); } return false; };
    // the row that holds a quantity on the sheet in front (its code name is in the last used column, or in D)
    const rowNamed = name => gc(`async g => { const d = await g.docInspect(); const sh = d.sheets[d.activeSheet]; const m = /:([A-Z]+)(\\d+)$/.exec(sh.usedRange); for (const col of [m[1], 'D']) { const v = (await g.execute('sheet.read', { sheet: sh.name, range: col + '1:' + col + m[2] })).values; const i = v.findIndex(r => r[0] === ${JSON.stringify(name)}); if (i >= 0) return i + 1; } return 0; }`);
    const word = async t => ({ signed_off: 'signed off', stale: 'stale', not_built: 'not built' })[await ev(`window.__app.S.status.tiles[${JSON.stringify(t)}].state`)] || 'not reviewed';
    const settleGrid = async () => { await ev('window.__app.idle()'); await sleep(500); };

    // a tile sheet: an upstream row, a parameter row, the grey rows and the tile's own row
    await go('#/model'); await go('#/tile/units_amc'); await ev(`window.__app.setCentre('spreadsheet')`); await settleGrid();
    const shs = await sheets();
    check('trace: the stored workbook is in the grid (case sheets)', ['Base', 'High charge', 'Zero premium', 'Scratch'].every(n => shs.includes(n)), JSON.stringify(shs));
    await sel('B2');
    check('trace: no line for a cell that is not in a quantity row', await lineIs(''), await line());
    await sel('D9');
    const upstream = `D9 is Units after allocation, from units_after_alloc in Unit projection (${await word('units_after_alloc')}).`;
    check('trace: an upstream row says where it comes from, with the source tile\'s review state in words', await lineIs(upstream + ' Go to source'), await line());
    check('trace: the line is in the bar above the spreadsheet, a plain button, nothing else showing', await ev(`(()=>{const b=document.getElementById('tracebar'), g=document.getElementById('gotosource'); return b.parentElement.id==='lines' && !!g && g.tagName==='BUTTON' && document.getElementById('sheetbar').hidden && document.getElementById('stalebar').hidden && b.getBoundingClientRect().bottom <= document.getElementById('gridwrap').getBoundingClientRect().top + 1})()`));
    await shot('trace-upstream' + SFX);
    await sel('C5');
    check('trace: a parameter row says what it is, without a button', await lineIs('C5 is AMC per month, the parameter amc_pm.') && !(await ev(`!!document.getElementById('gotosource')`)), await line());
    await shot('trace-parameter' + SFX);
    await sel('D13');
    check('trace: nothing for the grey Python row', await lineIs(''), await line());
    await sel('D11');
    const users = FULL ? 'units_eop, amc_income' : 'units_eop';
    check('trace: the tile\'s own row has no source line; it lists the tiles that use it, as links', await lineIs(`D11 is AMC units. Used by ${users}.`) && !(await ev(`!!document.getElementById('gotosource')`)) && await ev(`[...document.querySelectorAll('#tracebar a.traceuse')].map(a => a.dataset.tile).join(',') === ${JSON.stringify(users.replace(/, /g, ','))}`), await line());
    await shot('trace-usedby' + SFX);

    // Go to source: the source tile, the same case sheet, the same month in its own formula row; Back returns
    await sel('F9', 'High charge');
    check('trace: the line follows the selection on another case sheet', await lineIs(upstream.replace('D9', 'F9') + ' Go to source'), await line());
    await ev(`document.getElementById('gotosource').click()`);
    check('trace: Go to source opens the source tile', await waitFor(`location.hash === '#/tile/units_after_alloc' && document.getElementById('tilename') && document.getElementById('tilename').textContent === 'units_after_alloc'`), await ev('location.hash'));
    await settleGrid();
    const srcRow = await rowNamed('units_after_alloc');
    check('trace: it lands on the same case sheet, same month, in the source tile\'s own formula row', srcRow > 0 && await atIs('High charge!F' + srcRow), `${await at()} want High charge!F${srcRow}`);
    check('trace: the source tile shows the same case in the left bar', await ev(`window.__app.route().key === 'tile/units_after_alloc' && (document.getElementById('panel').innerText.match(/High charge/g) || []).length > 0`));
    check('trace: on the source tile its own row lists its users', await lineIs(`F${srcRow} is Units after allocation. Used by units_amc, units_eop.`), await line());
    await shot('trace-at-source' + SFX);
    const stateRow = await rowNamed('units_bop');
    await sel('E' + stateRow);
    check('trace: a carried-forward row names the tile it is carried forward from', await lineIs(`E${stateRow} is Opening units, carried forward from units_eop in Unit projection (${await word('units_eop')}). Go to source`), await line());
    await shot('trace-carried-forward' + SFX);
    await sel('C' + stateRow);
    check('trace: its first month is the starting value, with no source', await lineIs(`C${stateRow} is Opening units, the starting value of units_bop.`), await line());
    await sel('F' + srcRow);
    await ev(`document.getElementById('back').click()`);
    check('trace: Back returns to the tile the reviewer was on', await waitFor(`location.hash === '#/tile/units_amc'`), await ev('location.hash'));
    await settleGrid();
    check('trace: Back restores the sheet and the cell that were selected', await atIs('High charge!F9'), await at());
    check('trace: and the line shows again', await lineIs(upstream.replace('D9', 'F9') + ' Go to source'), await line());
    await ev(`document.getElementById('forward').click()`); await waitFor(`location.hash === '#/tile/units_after_alloc'`); await settleGrid();
    check('trace: Forward goes to the source cell again', await atIs('High charge!F' + srcRow), await at());
    await ev(`document.getElementById('back').click()`); await waitFor(`location.hash === '#/tile/units_amc'`); await settleGrid();

    // the keyboard: Ctrl+[ (Cmd+[ on macOS), Excel's "go to precedents", with the focus in the spreadsheet
    await atIs('High charge!F9'); await lineIs(upstream.replace('D9', 'F9') + ' Go to source');
    await sel('K9'); await lineIs(upstream.replace('D9', 'K9') + ' Go to source');
    win.webContents.focus(); await ev(`document.querySelector('#gridhost iframe').contentWindow.focus(); true`);
    const mod = process.platform === 'darwin' ? 'meta' : 'control';
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '[', modifiers: [mod] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '[', modifiers: [mod] });
    check('trace: Ctrl+[ / Cmd+[ goes to the source', await waitFor(`location.hash === '#/tile/units_after_alloc'`, 6000), await ev('location.hash'));
    await settleGrid();
    check('trace: the shortcut lands on the same month too', await atIs('High charge!K' + srcRow), await at());
    check('trace: the bars did not move (their accelerators are now with Shift)', await ev(`!document.getElementById('left').classList.contains('collapsed') && !document.getElementById('rightbar').classList.contains('collapsed')`) && menuItem('showLeftBar').accelerator === 'CmdOrCtrl+Shift+[' && menuItem('showRightBar').accelerator === 'CmdOrCtrl+Shift+]');
    await sel('C' + stateRow); await lineIs(`C${stateRow} is Opening units, the starting value of units_bop.`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '[', modifiers: [mod] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '[', modifiers: [mod] });
    await sleep(700);
    check('trace: the shortcut does nothing when the line offers no source', (await ev('location.hash')) === '#/tile/units_after_alloc' && (await at()) === 'High charge!C' + stateRow, await at());

    // the reverse direction: a "Used by" link opens that tile where this quantity comes in
    await go('#/tile/units_amc'); await settleGrid();
    await sel('G11', 'Zero premium');
    await lineIs(`G11 is AMC units. Used by ${users}.`);
    await ev(`document.querySelector('#tracebar a.traceuse[data-tile="units_eop"]').click()`);
    check('trace: a Used by link opens that tile', await waitFor(`location.hash === '#/tile/units_eop'`), await ev('location.hash'));
    await settleGrid();
    const inRow = await rowNamed('units_amc');
    check('trace: on the same case and month, in the row where the quantity is an input', inRow > 0 && await atIs('Zero premium!G' + inRow), `${await at()} want Zero premium!G${inRow}`);
    check('trace: and that row says where it comes from', await lineIs(`G${inRow} is AMC units, from units_amc in Unit projection (${await word('units_amc')}). Go to source`), await line());
    // through a carried-forward state the user reads the value a month later
    await go('#/tile/units_eop'); await settleGrid();
    const eopRow = await rowNamed('units_eop');
    await sel('G' + eopRow, 'Base');
    const eopUsers = FULL ? 'fund_value_eop, units_after_alloc (next month)' : 'units_after_alloc (next month)';
    check('trace: a tile carried forward lists its next-month user', await lineIs(`G${eopRow} is Closing units. Used by ${eopUsers}.`), await line());
    await ev(`document.querySelector('#tracebar a.traceuse[data-tile="units_after_alloc"]').click()`);
    await waitFor(`location.hash === '#/tile/units_after_alloc'`); await settleGrid();
    check('trace: and the link lands on the state row, one month on', await atIs('Base!H' + stateRow), await at());

    // only one line at a time: the other lines come first
    await go('#/tile/units_amc'); await settleGrid();
    await sel('D9', 'Base'); await lineIs(upstream + ' Go to source');
    await gc(`async g => g.execute('cell.set', { cell: 'T2', input: 'not saved' })`);
    check('trace: the "changes are not saved" line takes the place of the trace line', await waitFor(`!document.getElementById('sheetbar').hidden && document.getElementById('tracebar').hidden`, 5000), await line());
    await go('#/model'); await go('#/tile/units_amc'); await settleGrid();   // leaving the tile drops the unsaved edit and its line
    await sel('D9', 'Base');
    check('trace: and it comes back when that line has gone', await waitFor(`document.getElementById('sheetbar').hidden`, 5000) && await lineIs(upstream + ' Go to source'), await line());
    await ev(`window.__app.setCentre('code')`); await sleep(300);
    check('trace: no line while the Code pane is in front', await ev(`document.getElementById('tracebar').hidden`));
    await ev(`window.__app.setCentre('spreadsheet')`); await sleep(300);
    if (FULL) {
      await sel('G11'); await lineIs(`G11 is AMC units. Used by ${users}.`);
      await ev(`document.querySelector('#tracebar a.traceuse[data-tile="amc_income"]').click()`);
      await waitFor(`location.hash === '#/tile/amc_income'`); await settleGrid();
      const r = await rowNamed('units_amc');
      check('trace: a link to a tile whose workbook is out of date still lands on the cell', r > 0 && await atIs('Base!G' + r), await at());
      check('trace: but there the "out of date" line has the bar, not the trace line', await ev(`!document.getElementById('stalebar').hidden && document.getElementById('tracebar').hidden`));
    }

    // a module sheet: a carried-forward row whose source is on the same sheet goes there without leaving the view
    await go('#/module/unit_projection'); await ev(`window.__app.setCentre('spreadsheet')`); await settleGrid();   // an earlier set may have left Code in front at this level
    const mState = await rowNamed('units_bop'), mEop = await rowNamed('units_eop'), mPrem = await rowNamed('premium');
    await sel('E' + mPrem, 'Base');
    check('trace: an input series row on a module sheet says what it is, without a button', await lineIs(`E${mPrem} is Premium, the input premium.`) && !(await ev(`!!document.getElementById('gotosource')`)), await line());
    await sel('E' + mState);
    check('trace: module sheet, carried-forward row', await lineIs(`E${mState} is Opening units, carried forward from units_eop in Unit projection (${await word('units_eop')}). Go to source`), await line());
    await ev(`document.getElementById('gotosource').click()`);
    check('trace: its source is the month before, on the same sheet; the view does not change', await atIs('Base!D' + mEop) && (await ev('location.hash')) === '#/module/unit_projection', await at());
    await ev(`document.getElementById('back').click()`);
    check('trace: Back returns to the cell on the module sheet', await atIs('Base!E' + mState) && (await ev('location.hash')) === '#/module/unit_projection', await at());

    // the model workbook: a green link row goes to the sheet it links to, inside the same workbook
    await go('#/model'); await ev(`window.__app.setCentre('spreadsheet')`); await settleGrid();   // an earlier set may have left Code in front at this level
    check('trace: the model workbook has its sheets', (await sheets()).includes('Inputs') && (await sheets()).includes('Unit projection'), JSON.stringify(await sheets()));
    await sel('A1', 'Unit projection');
    const linkRow = await rowNamed('premium');
    await sel('E' + linkRow);
    check('trace: model workbook, a link row to Inputs', await lineIs(`E${linkRow} is Premium, the input premium, from the Inputs sheet. Go to source`), await line());
    await shot('trace-model-link' + SFX);
    await ev(`document.getElementById('gotosource').click()`);
    await waitFor(`(async()=>{const d=await document.querySelector('#gridhost iframe').contentWindow.gridcraft.docInspect(); return d.sheets[d.activeSheet].name==='Inputs'})()`, 5000);
    const inputsRow = await rowNamed('premium');
    check('trace: Go to source activates the Inputs sheet of the same workbook at the same month, without leaving the model view', inputsRow > 0 && await atIs('Inputs!E' + inputsRow) && (await ev('location.hash')) === '#/model', await at());
    check('trace: on Inputs the row is a true input', await lineIs(`E${inputsRow} is Premium, the input premium.`), await line());
    await shot('trace-model-inputs' + SFX);
    await ev(`document.getElementById('back').click()`);
    check('trace: Back returns to the link row on the module sheet', await atIs('Unit projection!E' + linkRow) && (await ev('location.hash')) === '#/model', await at());
    const ownRow = await rowNamed('units_amc');
    await sel('E' + ownRow);
    check('trace: a module\'s own row on the model workbook lists its users', await lineIs(`E${ownRow} is AMC units. Used by ${users}.`), await line());
    if (FULL) {
      await sel('A1', 'Cashflows');
      const cRow = await rowNamed('units_eop');
      await sel('F' + cRow);
      check('trace: model workbook, a link row to another module', await lineIs(`F${cRow} is Closing units, from units_eop in Unit projection (${await word('units_eop')}). Go to source`), await line());
      await shot('trace-model-cross-tab' + SFX);
      await ev(`document.getElementById('gotosource').click()`);
      await waitFor(`(async()=>{const d=await document.querySelector('#gridhost iframe').contentWindow.gridcraft.docInspect(); return d.sheets[d.activeSheet].name==='Unit projection'})()`, 5000);
      const homeRow = await rowNamed('units_eop');
      check('trace: Go to source activates the source module\'s sheet at the corresponding cell', homeRow > 0 && await atIs('Unit projection!F' + homeRow) && (await ev('location.hash')) === '#/model', await at());
      await ev(`document.getElementById('back').click()`);
      check('trace: Back returns to the Cashflows sheet', await atIs('Cashflows!F' + cRow), await at());
      await sel('E' + ownRow, 'Unit projection'); await lineIs(`E${ownRow} is AMC units. Used by ${users}.`);
      await ev(`document.querySelector('#tracebar a.traceuse[data-tile="units_eop"]').click()`);
      await waitFor(`location.hash === '#/tile/units_eop'`); await settleGrid();
      check('trace: a Used by link from the model workbook opens the tile on the model\'s case', await atIs('Base!E' + await rowNamed('units_amc')), await at());
    }
    await go('#/model');
  }

  check('app ready', await waitFor('window.__app && window.__app.ready', 20000));
  check('gridcraft:ready', await waitFor('window.__gridLog.ready >= 1', 20000), 'no ready');

  // A reload while the window is covered by another window, or minimised, must not leave the app waiting on the
  // spreadsheet. (The spreadsheet only answers when a frame is drawn, and a freshly loaded page in a covered or
  // minimised window draws none: that was the cause of the reload that sometimes hung.)
  async function coveredSet(tileName) {
    const { BrowserWindow } = require('electron');
    await go('#/tile/' + tileName); await settle();
    const b = win.getBounds();
    const cover = new BrowserWindow({ x: b.x, y: b.y, width: b.width, height: b.height, title: 'cover' });
    await cover.loadURL('data:text/html,<body>cover');
    cover.focus(); await sleep(1500);
    await ev('window.__old = true'); win.webContents.reload(); await sleep(400);
    check('a reload while the window is covered still becomes ready', await waitFor('!window.__old && window.__app && window.__app.ready', 10000));
    cover.destroy(); win.focus(); await sleep(600);
    await waitFor('window.__app && window.__app.ready', 20000);
    win.minimize(); await sleep(1200);
    await ev('window.__old = true'); win.webContents.reload(); await sleep(3000);
    check('a reload while minimised waits rather than timing out on the spreadsheet', await ev('!window.__old && !!window.__gridLog && window.__gridLog.failed.length === 0'));
    win.restore(); win.focus();
    check('and finishes once the window is restored, with the workbook open', await waitFor('!window.__old && window.__app && window.__app.ready && window.__gridLog.opens.length >= 1', 10000));
    await settle();
  }

  if (process.env.SMOKE_ONLY === 'trace') { await traceSet(); return finish(0); }   // for working on one set
  if (FULL) { await fullSet(); await layoutSet('gross_profit', 'allocation_margin', 'fund_value_eop'); await centreSet('gross_profit', 'allocation_margin'); await chatSet('gross_profit', 'cashflows', 'Cashflows'); await chatMore('gross_profit'); await traceSet(); await newModelSet(); await emptyModelSet(); await coveredSet('gross_profit'); return finish(0); }

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
  check('module: the tile strip has the tiles and the inputs', await ev(`(()=>{const t=document.getElementById('tiles').innerText;return ['units_allocated','units_eop','units_amc','inputs'].every(x=>t.includes(x))})()`));
  check('module: tile boxes on the strip are links, and the left bar has no map', await ev(`document.querySelectorAll('#tiles a.t[href^="#/tile/"]').length >= 4 && !document.querySelector('#panel svg.map')`));
  await shot('module');

  // tile
  await ev(`document.querySelector('#tiles a.t[href="#/tile/units_amc"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);
  await waitFor(`document.getElementById('tilename') && document.getElementById('tilename').textContent==='units_amc'`); await ev('window.__app.idle()'); await sleep(200);
  check('click tile box on the strip opens tile view', (await ev('location.hash')) === '#/tile/units_amc');
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
  const signedHash = await ev('location.hash');
  await ev('document.getElementById("signoff").click()');
  // a sign-off moves on to the next item in the review queue; come back to look at the signed tile
  check('after sign-off the next item in the review queue opens', await waitFor(`location.hash !== ${JSON.stringify(signedHash)} && (window.__app.S.queue.items || []).some(i => location.hash === '#/' + i.level + '/' + encodeURIComponent(i.id))`), await ev('location.hash'));
  check('the signed tile has left the review queue', await ev(`!(window.__app.S.queue.items || []).some(i => '#/' + i.level + '/' + encodeURIComponent(i.id) === ${JSON.stringify(signedHash)})`));
  await go(signedHash); await settle();
  check('sentence changes after sign-off', await waitFor(`document.getElementById('sentence') && document.getElementById('sentence').textContent.startsWith('Signed off by')`));
  check('signed sheet shows the recorded reviewer and date, no fields', await waitFor(`(()=>{const r=document.getElementById('reviewedby'); return !!r && r.innerText.includes('Smoke Reviewer') && /\\d{4}-\\d{2}-\\d{2}/.test(r.innerText) && !document.getElementById('reviewer') && document.getElementById('signoff').disabled})()`), await text());
  await shot('tile-signed');

  // a stale tile cannot be signed off: the blocker is the button's title and is listed under Checks
  await go('#/tile/units_eop');
  await has('stale tile sentence', 'Stale: upstream values changed since sign-off.');
  check('blocked: Sign off disabled with the first blocker as title, listed in Checks', await ev(`(()=>{const b=document.getElementById('signoff'); return b.disabled && b.title.includes('stale because upstream values changed') && document.getElementById('panel').innerText.includes('stale because upstream values changed')})()`));

  await blockedStrip('units_eop');
  await ev(`document.getElementById('leftstrip').click()`); await settle();

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

  await layoutSet('units_amc', null, 'units_amc');
  await centreSet('units_amc', 'units_eop');
  await chatSet('units_amc', 'unit_projection', 'Unit projection');
  await chatMore('units_amc');
  await traceSet();
  await newModelSet();
  await emptyModelSet();

  // back to model
  await go('#/model');
  await has('model sentence shows module state', 'Not signed off.');
  const log = await ev('window.__gridLog');
  summary.gridLog = { ready: log.ready, opens: log.opens.length, saves: log.saves, dirtyEvents: log.dirty.length };
  await coveredSet('units_amc');
  finish(0);
})().catch(e => { summary.errors.push(String(e && e.stack || e)); finish(1); });
app.on('window-all-closed', () => {});
