'use strict';
// Live test of the review queue against the real tilekit commands, on a temporary COPY of model/ (with its stored
// workbooks, so nothing needs building first). Run from app/: ./node_modules/.bin/electron test/queue.js
process.env.APP_NO_AUTOSTART = '1';
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const REAL_MODEL = path.resolve(__dirname, '../../model');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-queue-'));
const copy = path.join(tmp, 'model');

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

(async () => {
  const skip = /(^|\/)(\.venv|__pycache__|real-data|\.pytest_cache)(\/|$)/;
  fs.cpSync(REAL_MODEL, copy, { recursive: true, filter: src => !skip.test(path.relative(REAL_MODEL, src).split(path.sep).join('/')) });
  for (const f of fs.readdirSync(path.join(copy, 'review'), { recursive: true })) if (/signoff\.json$|expected\.json$/.test(f)) fs.rmSync(path.join(copy, 'review', f));

  ctl = await require('../src/main').start({ show: true, settingsFile: path.join(tmp, 'settings.json'), modelDir: copy });
  const win = ctl.win;
  win.webContents.on('console-message', (...a) => { const m = a[0] && a[0].message !== undefined ? a[0] : { level: a[1], message: a[2] }; if (m.level === 'error' || m.level === 3) summary.errors.push('console: ' + String(m.message).slice(0, 300)); });
  win.webContents.on('will-prevent-unload', e => e.preventDefault());
  const ev = js => win.webContents.executeJavaScript(js, true);
  const waitFor = async (js, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await ev(js); if (v) return v; } catch { /* retry */ } await sleep(100); } return false; };
  const idle = async () => { await ev('window.__app.idle()'); await waitFor('document.getElementById("working").hidden', 120000); await ev('window.__app.idle()'); };
  const shot = async name => { await sleep(300); const img = await win.webContents.capturePage(); const f = path.join(OUT, name + '.png'); fs.writeFileSync(f, img.toPNG()); summary.shots.push(f); };
  const hash = () => ev('location.hash');
  const atHash = async (h, ms = 15000) => { const ok = await waitFor(`location.hash===${JSON.stringify(h)}`, ms); await idle(); return ok; };
  const go = async h => { await ev(`location.hash=${JSON.stringify(h)}`); await idle(); await sleep(200); };
  const click = id => ev(`document.getElementById(${JSON.stringify(id)}).click()`);
  const txt = id => ev(`(document.getElementById(${JSON.stringify(id)}) || {textContent: ''}).textContent`);
  const tk = (cmd, args = []) => ev(`window.api.tk(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  const reload = async () => { await ev('window.__app.refresh().then(() => window.__app.render())'); await idle(); };
  const queue = () => ev('JSON.parse(JSON.stringify(window.__app.S.queue))');
  const key = async (k, mods) => { win.webContents.focus(); for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: k, modifiers: mods }); await sleep(250); };
  const MOD = process.platform === 'darwin' ? 'meta' : 'control';
  const read = rel => fs.readFileSync(path.join(copy, rel), 'utf8');

  await waitFor('window.__app && window.__app.ready', 60000);
  await idle();

  // ---- the count in the top bar, on every view
  let q = await queue();
  const order = q.items.map(i => (i.level === 'model' ? 'model' : i.level + '/' + i.id));
  check('queue: 26 tiles, 5 modules and the model wait at the start', q.counts.total === 32 && q.counts.tiles === 26 && q.counts.modules === 5 && q.counts.model === 1, JSON.stringify(q.counts));
  check('queue: upstream first (unit projection tiles, then its module sheet, model last)',
    order.slice(0, 5).join() === 'tile/units_allocated,tile/units_after_alloc,tile/units_amc,tile/units_eop,module/unit_projection' && order[31] === 'model', order.join());
  for (const h of ['#/model', '#/module/decrements', '#/tile/units_amc']) {
    await go(h);
    check(`badge: the count shows on ${h}`, await txt('queuecount') === '32' && await ev('document.getElementById("queuebtn").offsetWidth > 0'), await txt('queuecount'));
  }
  await go('#/launch');
  check('badge: hidden on the list of models', await ev('document.getElementById("queuebtn").offsetWidth === 0'));
  await go('#/model');

  // ---- the list
  check('list: closed until asked for', await ev('document.getElementById("queue").hidden'));
  await click('queuebtn');
  check('list: opens from the top bar', await ev('!document.getElementById("queue").hidden && document.querySelectorAll("#queue .qitem").length === 32'));
  check('list: each item names the module, the tile and the reason in words', await ev(`(() => {
    const first = document.querySelector('#queue .qitem'), mod = document.querySelector('#queue .qmod');
    return mod.textContent === 'Unit projection' && first.querySelector('b').textContent === 'units_allocated' && /Not signed off yet\\./.test(first.querySelector('.qwhy').textContent);
  })()`), await ev('document.getElementById("queue").innerText.slice(0, 300)'));
  await shot('queue-list');
  await ev(`document.querySelector('#queue .qitem[data-key="tile/units_amc"]').click()`);
  check('list: choosing an item opens that tile and closes the list', await atHash('#/tile/units_amc') && await ev('document.getElementById("queue").hidden') && await txt('tilename') === 'units_amc', await hash());
  check('position: the place in the queue shows beside the buttons', await txt('queuepos') === '3 of 32', await txt('queuepos'));

  // ---- next and previous: buttons and keys
  await click('queuenext');
  check('Next button: on to the next item', await atHash('#/tile/units_eop'), await hash());
  await click('queueprev'); await atHash('#/tile/units_amc');
  await click('queueprev');
  check('Previous button: back up the queue', await atHash('#/tile/units_after_alloc'), await hash());
  await key('J', [MOD]);
  check('Cmd/Ctrl+J: next item', await atHash('#/tile/units_amc', 5000), await hash());
  await key('K', [MOD]);
  check('Cmd/Ctrl+K: previous item', await atHash('#/tile/units_after_alloc', 5000), await hash());
  await key('J', [MOD, 'shift']);
  check('Cmd/Ctrl+Shift+J: shows the list', await waitFor('!document.getElementById("queue").hidden', 3000));
  check('list: the item on show is marked', await ev(`(document.querySelector('#queue .qitem.cur') || {dataset: {}}).dataset.key === 'tile/units_after_alloc'`));
  await key('Escape', []);
  check('Escape closes the list', await waitFor('document.getElementById("queue").hidden', 3000));
  await go('#/tile/units_allocated');
  check('Previous is off at the first item, Next at the last', await ev('document.getElementById("queueprev").disabled && !document.getElementById("queuenext").disabled'));

  // ---- a sign-off moves on; the queue itself has no way to sign
  await click('queuebtn');
  check('the queue has no sign-off button of its own', await ev(`[...document.querySelectorAll('#queue button, #queuenav button')].every(b => ['queuebtn', 'queueprev', 'queuenext', 'queueclose', 'queuereconfirm'].includes(b.id))`));
  await click('queuebtn');
  await ev('document.querySelectorAll("#panel input.assume").forEach(c => c.click())');
  await waitFor('!document.getElementById("signoff").disabled', 5000);
  await click('signoff');
  check('after a sign-off the next item opens by itself', await atHash('#/tile/units_after_alloc', 60000), await hash());
  q = await queue();
  check('after a sign-off the count goes down by one', q.counts.total === 31 && await txt('queuecount') === '31' && await txt('queuepos') === '1 of 31', `${q.counts.total} ${await txt('queuepos')}`);
  check('the sign-off was recorded by the signature block, with the reviewer named', JSON.parse(read('review/tiles/units_allocated/signoff.json')).reviewer.length > 0);

  // ---- make tiles stale: a formula change upstream, so the tiles after it change in values only
  for (const t of ['units_after_alloc', 'units_amc', 'units_eop']) await tk('signoff', ['--tile', t, '--reviewer', 'Set-up']);
  const src = path.join(copy, 'src/unit_linked/liability/units.py');
  fs.writeFileSync(src, fs.readFileSync(src, 'utf8').replace('return premium * allocation_rate / unit_price', 'return allocation_rate * premium / unit_price'));
  await sleep(500); await reload();
  q = await queue();
  const kind = id => (q.items.find(i => i.level === 'tile' && i.id === id) || {}).kind;
  check('stale: the edited tile needs a full review', kind('units_allocated') === 'formula_drift', kind('units_allocated'));
  check('stale: the tiles after it changed in values only and can be re-confirmed after a rebuild',
    ['units_after_alloc', 'units_amc', 'units_eop'].every(t => kind(t) === 'values_drift' && q.items.find(i => i.id === t).reconfirm === 'after_rebuild') && q.counts.reconfirm === 3, JSON.stringify(q.counts));
  await go('#/tile/units_allocated');
  await click('queuebtn');
  check('list: says in words which is which', await ev(`(() => { const w = k => document.querySelector('#queue .qitem[data-key="' + k + '"] .qwhy').textContent;
    return /full review/.test(w('tile/units_allocated')) && /rebuild and re-confirm/.test(w('tile/units_amc')); })()`));
  check('bulk: offered from the queue with its count', await txt('queuereconfirm') === 'Rebuild and re-confirm (3)', await txt('queuereconfirm'));
  await shot('queue-stale');
  const formulaSigned = read('review/tiles/units_allocated/signoff.json');
  await click('queuereconfirm');
  await waitFor('!!document.getElementById("dialog")', 5000);
  check('bulk: asks first, listing the three tiles and the reviewer', await ev(`document.querySelectorAll('#bulktiles .row').length === 3 && !/units_allocated\\b/.test(document.getElementById('bulktiles').innerText) && document.getElementById('f-reviewer').value.length > 0`));
  check('bulk: nothing is recorded until the reviewer presses the button', JSON.parse(read('review/tiles/units_amc/signoff.json')).reviewer === 'Set-up');
  await shot('queue-bulk-dialog');
  await ev(`(() => { const i = document.getElementById('f-reviewer'); i.value = 'Queue Reviewer'; i.dispatchEvent(new Event('input')); })()`);
  await click('confirm');
  const done = await waitFor(`(document.querySelector('#dialog .okline') || {textContent: ''}).textContent`, 180000);
  check('bulk: rebuilds and re-confirms the three tiles', /Re-confirmed 3 tiles as Queue Reviewer: units_after_alloc, units_amc, units_eop\./.test(done), done);
  await click('cancel'); await idle();
  for (const t of ['units_after_alloc', 'units_amc', 'units_eop']) {
    const so = JSON.parse(read(`review/tiles/${t}/signoff.json`));
    check(`bulk: ${t} re-confirmed in the reviewer's name`, so.reviewer === 'Queue Reviewer' && so.comment === 'Values-only re-confirmation', JSON.stringify(so).slice(0, 200));
  }
  check('bulk: the tile whose formula changed is left alone', read('review/tiles/units_allocated/signoff.json') === formulaSigned);
  q = await queue();
  check('bulk: only the formula change stays in the queue for that module', kind('units_allocated') === 'formula_drift' && !['units_after_alloc', 'units_amc', 'units_eop'].some(t => kind(t)) && q.counts.reconfirm === 0, JSON.stringify(q.counts));
  check('bulk: the offer goes away when nothing is left for it', await ev('!document.getElementById("queuereconfirm")'));

  // ---- a failing check row keeps a tile out of the bulk action
  await tk('build', ['--tile', 'units_allocated']);
  await tk('signoff', ['--tile', 'units_allocated', '--reviewer', 'Set-up']);
  fs.writeFileSync(src, fs.readFileSync(src, 'utf8').replace('return allocation_rate * premium / unit_price', 'return premium * allocation_rate / unit_price'));
  await sleep(300);
  await tk('build', ['--tile', 'units_amc']);
  const side = path.join(copy, 'review/tiles/units_amc/workbook.json');
  const doc = JSON.parse(fs.readFileSync(side, 'utf8'));
  doc.checks_pass = false; for (const c of Object.values(doc.cases)) { c.checks_pass = false; break; }
  fs.writeFileSync(side, JSON.stringify(doc));
  await reload();
  q = await queue();
  check('check rows: a tile whose difference check fails is not offered for re-confirmation', (q.items.find(i => i.id === 'units_amc') || {}).reconfirm === null && q.counts.reconfirm === 2, JSON.stringify(q.items.find(i => i.id === 'units_amc')));
  const amcBefore = read('review/tiles/units_amc/signoff.json');
  await click('queuebtn'); await click('queuereconfirm');
  await waitFor('!!document.getElementById("dialog")', 5000);
  check('check rows: the dialog lists only the two that qualify', await ev(`document.querySelectorAll('#bulktiles .row').length === 2 && !/units_amc/.test(document.getElementById('bulktiles').innerText)`));
  await click('confirm');
  await waitFor(`(document.querySelector('#dialog .okline') || {textContent: ''}).textContent`, 180000);
  await click('cancel'); await idle();
  check('check rows: the failing tile keeps its old sign-off and stays in the queue', read('review/tiles/units_amc/signoff.json') === amcBefore && (await queue()).items.some(i => i.id === 'units_amc'));

  // ---- an empty queue
  await tk('build', ['--tile', 'units_amc', '--force']);   // undo the tampered check row
  await tk('build');
  let st = await tk('status');
  for (const [t, e] of Object.entries(st.tiles)) if (e.state !== 'signed_off') await tk('signoff', ['--tile', t, '--reviewer', 'Set-up']);
  for (const m of Object.keys(st.modules)) await tk('signoff', ['--module', m, '--reviewer', 'Set-up']);
  await reload(); await go('#/model');
  q = await queue();
  check('nearly empty: only the model is left', q.counts.total === 1 && q.items[0].level === 'model' && await txt('queuepos') === '1 of 1', JSON.stringify(q.items.map(i => i.id)));
  const blockers = (await tk('status')).model.blockers;
  if (blockers.length) { await tk('test'); await reload(); }
  await waitFor('!document.getElementById("signoff").disabled', 5000);
  await click('signoff'); await idle();
  q = await queue();
  check('empty: nothing is left after the model is signed off', q.counts.total === 0, JSON.stringify({ items: q.items, blockers: (await tk('status')).model.blockers }));
  check('empty: the count shows 0 and Next and Previous are off', await txt('queuecount') === '0' && await ev('document.getElementById("queuenext").disabled && document.getElementById("queueprev").disabled'));
  await click('queuebtn');
  check('empty: the list says plainly that nothing needs review', /^Nothing needs review\./.test(await txt('queuenone')), await txt('queuenone'));
  await shot('queue-empty');

  check('no console errors', summary.errors.filter(e => e.startsWith('console:')).length === 0, JSON.stringify(summary.errors));
  finish(0);
})().catch(e => { summary.errors.push(String(e && e.stack || e)); finish(1); });
app.on('window-all-closed', () => {});
