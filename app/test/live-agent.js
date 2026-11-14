'use strict';
// Live test of the agent log: real model calls (a handful of turns, a few cents each), real tilekit, on a temporary
// COPY of model/ (the real model directory is only the Python project). Run from app/:
//   ./node_modules/.bin/electron test/live-agent.js
// If the Claude login is missing, the test says so and exits with code 3 instead of failing obscurely.
process.env.APP_NO_AUTOSTART = '1';
const { app, dialog } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const REAL_MODEL = path.resolve(__dirname, '../../model');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-live-'));
const copy = path.join(tmp, 'model');
process.env.APP_TILEKIT_PROJECT = REAL_MODEL;

const started = Date.now();
const summary = { checks: [], shots: [], errors: [], turns: [], confirms: [] };
let ctl = null, finished = false;
const hard = setTimeout(() => { summary.errors.push('hard timeout (6 minutes)'); finish(2); }, 6 * 60 * 1000);

function finish(code) {
  if (finished) return; finished = true;
  clearTimeout(hard);
  summary.passed = summary.checks.filter(c => c.ok).length;
  summary.failed = summary.checks.filter(c => !c.ok).length;
  summary.seconds = Math.round((Date.now() - started) / 1000);
  try { ctl && ctl.shutdown(); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(JSON.stringify(summary, null, 1));
  app.exit(code || (summary.failed ? 1 : 0));
}
const check = (name, ok, detail) => { summary.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail: String(detail).slice(0, 500) }) }); };

function copyModel() {
  const skip = /(^|\/)(\.venv|__pycache__|real-data|\.pytest_cache)(\/|$)/;
  fs.cpSync(REAL_MODEL, copy, { recursive: true, filter: src => !skip.test(path.relative(REAL_MODEL, src).split(path.sep).join('/')) });
  for (const d of ['modules', 'tiles', 'model']) {   // start without conversations or drafts
    const base = path.join(copy, 'review', d);
    if (!fs.existsSync(base)) continue;
    for (const f of fs.readdirSync(base, { recursive: true })) if (String(f).endsWith('log.jsonl')) fs.rmSync(path.join(base, String(f)));
  }
  fs.rmSync(path.join(copy, 'review', 'drafts'), { recursive: true, force: true });
}

function hashTree(...dirs) {
  const h = crypto.createHash('sha256');
  const walk = d => {
    if (!fs.existsSync(d)) return;
    for (const n of fs.readdirSync(d).sort()) {
      if (n === '__pycache__') continue;
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p); else h.update(path.relative(copy, p) + '\0').update(fs.readFileSync(p));
    }
  };
  dirs.forEach(d => walk(path.join(copy, d)));
  h.update(fs.readFileSync(path.join(copy, 'tilekit.toml')));
  return h.digest('hex');
}

(async () => {
  copyModel();
  const confirms = [];
  let confirmAnswer = 0;     // 0 = "Change it", 1 = "Cancel"
  dialog.showMessageBox = async (...a) => {
    const opts = a.find(x => x && typeof x === 'object' && !x.webContents) || {};
    confirms.push({ title: opts.title, message: opts.message, buttons: opts.buttons, defaultId: opts.defaultId, cancelId: opts.cancelId });
    return { response: confirmAnswer, checkboxChecked: false };
  };
  const settingsFile = path.join(tmp, 'settings.json');
  ctl = await require('../src/main').start({ show: true, settingsFile, modelDir: copy });
  const win = ctl.win;
  win.webContents.on('console-message', (...a) => { const m = a[0] && a[0].message !== undefined ? a[0] : { level: a[1], message: a[2] }; if (m.level === 'error' || m.level === 3) summary.errors.push('console: ' + String(m.message).slice(0, 300)); });
  const ev = js => win.webContents.executeJavaScript(js, true);
  const waitFor = async (js, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await ev(js); if (v) return v; } catch { /* retry */ } await sleep(100); } return false; };
  const idle = async () => { await ev('window.__app.idle()'); await waitFor('document.getElementById("working").hidden', 90000); await ev('window.__app.idle()'); };
  const shot = async name => { await sleep(300); const img = await win.webContents.capturePage(); const f = path.join(OUT, name + '.png'); fs.writeFileSync(f, img.toPNG()); summary.shots.push(f); };
  const go = async hash => {
    await ev(`location.hash=${JSON.stringify(hash)}`);
    await waitFor(`(()=>{const h=location.hash;const t=document.getElementById(h.startsWith('#/tile/')?'tilename':'title');return t&&(h.startsWith('#/tile/')?h.endsWith('/'+t.textContent):true)&&document.querySelector('#mods a.cur')!==null})()`);
    await idle(); await sleep(300);
  };
  const click = id => ev(`document.getElementById(${JSON.stringify(id)}).click()`);
  const S = () => ev('JSON.parse(JSON.stringify({tiles: window.__app.S.status.tiles, modules: window.__app.S.status.modules, graph: {q: window.__app.S.graph.quantities, modules: window.__app.S.graph.modules}, drafts: window.__app.S.drafts}))');
  const logText = () => ev('document.getElementById("agentlog-log").innerText');
  const lines = () => ev(`[...document.querySelectorAll('#agentlog-log .alog-line:not(.alog-working)')].map(l => ({ lab: l.querySelector('.alog-lab').textContent, txt: l.querySelector('.alog-txt').innerText, cls: l.className }))`);
  const doneCount = () => ev('window.__ev.filter(e => e.type === "done").length');
  const gc = js => ev(`(async()=>{const g=document.querySelector('#gridhost iframe').contentWindow.gridcraft; return await (${js})(g)})()`);

  // One turn: type into the agent input, press Enter, wait for the turn to end.
  async function say(label, text, ms = 150000) {
    const before = await doneCount();
    const t0 = Date.now();
    await ev(`(()=>{const i=document.getElementById('agentlog-input'); i.value=${JSON.stringify(text)}; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
    check(label + ': input is disabled and Working… shows while the turn runs', await waitFor(`document.getElementById('agentlog-input').disabled && !document.getElementById('agentlog-stop').hidden && document.getElementById('agentlog-log').innerText.includes('Working…')`, 5000), await logText());
    const ok = await waitFor(`window.__ev.filter(e => e.type === "done").length > ${before}`, ms);
    await waitFor(`!document.getElementById('agentlog-input').disabled`, 20000);
    await idle();
    const done = await ev('window.__ev.filter(e => e.type === "done").slice(-1)[0]');
    summary.turns.push({ label, seconds: Math.round((Date.now() - t0) / 1000), cost_usd: done && done.cost_usd, num_turns: done && done.num_turns });
    check(label + ': turn finished', ok, await logText());
    return ok;
  }

  check('app ready', await waitFor('window.__app && window.__app.ready', 30000));
  check('agent api exposed', await ev('!!(window.api && window.api.agent)'));
  await ev('window.__ev = []; window.api.agent.onEvent(e => window.__ev.push(e)); true');
  check('agent log section visible', await ev('!document.getElementById("agentlog").hidden'));

  const srcHash0 = hashTree('src', 'tests', 'cases');

  // ------------------------------------------------------------ 1. a tile edit by typing
  await go('#/tile/units_amc');
  check('tile placeholder is a real example', await ev('document.getElementById("agentlog-input").placeholder') === 'Cap the charge at 1.00 unit a month');
  check('agent log is at the bottom of the left panel', await ev(`(()=>{const l=document.getElementById('left');const s=document.getElementById('agentlog');return l.contains(s) && s.getBoundingClientRect().top > 0})()`));
  const q0 = (await S()).graph.q.units_amc;
  const ok1 = await say('turn 1', 'Remove the cap: the charge is units after allocation times the monthly rate.');
  const l1 = await lines();
  const notSigned = l1.find(l => /not signed in/i.test(l.txt));
  if (notSigned) {
    summary.skipped = 'The agent is not signed in on this machine: ' + notSigned.txt;
    console.error('NOT RUN: ' + summary.skipped);
    await shot('live-agent-not-signed-in');
    check('not signed in: the single sentence is shown and the input stays enabled', await ev('!document.getElementById("agentlog-input").disabled') && l1.filter(l => /not signed in/i.test(l.txt)).length === 1, JSON.stringify(l1));
    return finish(3);
  }
  check('turn 1: log has a You line', l1.some(l => l.lab === 'You' && l.txt.startsWith('Remove the cap')), JSON.stringify(l1));
  check('turn 1: log has an action line (blank label, grey)', l1.some(l => l.lab === '' && /alog-action/.test(l.cls)), JSON.stringify(l1));
  check('turn 1: log has an Agent line', l1.some(l => l.lab === 'Agent'), JSON.stringify(l1));
  let s1 = await S();
  const q1 = s1.graph.q.units_amc;
  check('turn 1: the tile code and formula changed in the view', q1.source.code !== q0.source.code && q1.formula !== q0.formula && !q1.source.code.includes('amc_cap_units') && (await ev('document.querySelector("pre.code").textContent')) === q1.source.code, `${q0.formula} -> ${q1.formula}`);
  check('turn 1: status sentence is not "signed off"', !(await ev('document.getElementById("sentence").textContent')).startsWith('Signed off'));
  await shot('live-agent-tile');

  // ------------------------------------------------------------ 2. a what-if, then Discard
  await go('#/tile/units_eop');
  const hashBeforeWhatIf = hashTree('src', 'tests', 'cases');
  await say('turn 2', 'What if the closing units deducted the AMC units a second time (opening units plus units allocated, less units_amc twice)? Run a what-if on this tile with that code and show me the effect. Do not change anything.');
  const l2 = await lines();
  const draftLine = await ev(`(()=>{const d=document.querySelector('#agentlog-log .alog-draft'); return d ? {text: d.innerText, nums: d.querySelectorAll('.alog-num').length, buttons: [...d.querySelectorAll('button')].map(b => b.textContent)} : null})()`);
  check('turn 2: a draft line with numbers', draftLine && draftLine.nums >= 1, JSON.stringify(l2));
  check('turn 2: what-if buttons are Apply draft and Discard', draftLine && draftLine.buttons.join('|') === 'Apply draft|Discard', JSON.stringify(draftLine));
  await shot('live-agent-whatif');
  check('turn 2: nothing written before a choice', hashTree('src', 'tests', 'cases') === hashBeforeWhatIf);
  if (draftLine) {
    await ev(`document.querySelector('#agentlog-log .alog-draft button[data-act="discard"]').click()`);
    check('turn 2: Discard replaces the buttons with "Discarded."', await waitFor(`(()=>{const d=document.querySelector('#agentlog-log .alog-draft'); return d && !d.querySelector('button') && d.innerText.includes('Discarded.')})()`, 10000));
    await idle();
    check('turn 2: Discard leaves the files unchanged', hashTree('src', 'tests', 'cases') === hashBeforeWhatIf);
  }

  // ------------------------------------------------------------ 3. a module draft (or a question), then Accept
  await go('#/module/unit_projection');
  check('module placeholder is a real example', await ev('document.getElementById("agentlog-input").placeholder') === 'Add a surrender charge that falls to zero over five years');
  const hash3 = hashTree('src', 'tests', 'cases');
  await say('turn 3', 'Add a tile for a surrender charge in units: a starting percentage of the units after allocation, falling to zero over five years. The starting percentage is a new parameter.');
  let hasDraft = await ev(`!!document.querySelector('#agentlog-log .alog-draft button[data-act="accept"]')`);
  let hasQuestion = await ev(`!!document.querySelector('#agentlog-log .alog-question')`);
  check('turn 3: a question or a draft appears', hasDraft || hasQuestion, await logText());
  check('turn 3: nothing is written before accepting', hashTree('src', 'tests', 'cases') === hash3);
  if (!hasDraft) {
    await shot('live-agent-question');
    await say('turn 3b', 'No new parameter. Propose the tile as a draft now with propose_structure: name surrender_charge_units, arguments units_after_alloc and amc_pm only, spec: units after allocation times the monthly rate, as a placeholder until the real rate is agreed.');
    hasDraft = await ev(`!!document.querySelector('#agentlog-log .alog-draft button[data-act="accept"]')`);
    check('turn 3b: a draft appears', hasDraft, await logText());
    check('turn 3b: nothing is written before accepting', hashTree('src', 'tests', 'cases') === hash3);
  }
  if (hasDraft) {
    check('structure draft buttons are Accept and Discard', await ev(`[...[...document.querySelectorAll('#agentlog-log .alog-draft')].pop().querySelectorAll('button')].map(b => b.textContent).join('|')`) === 'Accept|Discard');
    check('proposed tiles are drawn as dotted boxes on the map', await waitFor(`(()=>{const svg=document.querySelector('svg.map'); return !!svg && [...svg.querySelectorAll('text')].some(t => t.textContent === 'proposed') && !!svg.querySelector('rect[stroke-dasharray="1.5 3"]')})()`, 10000));
    check('proposed boxes are not links', await ev(`[...document.querySelectorAll('svg.map a')].every(a => !a.textContent.includes('proposed'))`));
    await shot('live-agent-module-draft');
    await ev(`document.querySelector('#agentlog-log .alog-draft button[data-act="accept"]').click()`);
    check('Accept replaces the buttons with "Accepted."', await waitFor(`[...document.querySelectorAll('#agentlog-log .alog-draft')].some(d => !d.querySelector('button') && d.innerText.includes('Accepted.'))`, 60000), await logText());
    await idle();
    check('accepted: files written', hashTree('src', 'tests', 'cases') !== hash3);
    check('accepted: a not-built tile is on the map, dotted, labelled "not built"', await waitFor(`(()=>{const svg=document.querySelector('svg.map'); return [...svg.querySelectorAll('text')].some(t => t.textContent === 'not built')})()`, 30000), await ev('document.getElementById("left").innerText.slice(0,600)'));
    check('accepted: Build not-built tiles button', await waitFor(`!!document.getElementById('buildnotbuilt') && /^Build not-built tiles \\(\\d+\\)$/.test(document.getElementById('buildnotbuilt').textContent)`, 20000), await ev('document.getElementById("left").innerText.slice(0,900)'));
    check('accepted: module sentence counts not built tiles', (await ev('document.getElementById("sentence").textContent')).includes('not built'), await ev('document.getElementById("sentence").textContent'));
    const nb = Object.entries((await S()).tiles).filter(([, t]) => t.state === 'not_built').map(([k]) => k);
    check('accepted: status has a not_built tile', nb.length >= 1, JSON.stringify(nb));
    await shot('live-agent-module-accepted');
    if (nb.length) {
      await go('#/tile/' + nb[0]);
      check('not-built tile sentence', (await ev('document.getElementById("sentence").textContent')) === 'Not built yet. Describe how it should work in the agent log below.', await ev('document.getElementById("sentence").textContent'));
      check('not-built tile has no workbook', await ev('!document.getElementById("nogrid").hidden'));
      await shot('live-agent-not-built-tile');
    }
  }

  // ------------------------------------------------------------ 4. a signed-off tile: the native confirm, declined
  const st4 = (await S()).tiles;
  const t4 = ['units_allocated', 'units_after_alloc'].find(t => st4[t] && st4[t].state !== 'signed_off' && st4[t].can_sign_off !== false) || 'units_allocated';
  await go('#/tile/' + t4);
  if (st4[t4] && ['stale', 'unbuilt'].includes(st4[t4].state)) { await click('rebuild'); await sleep(500); await idle(); }
  await ev('document.querySelectorAll("#panel input.assume").forEach(c => c.click())');
  if (await waitFor('!!document.getElementById("signoff") && !document.getElementById("signoff").disabled', 5000)) {
    await ev('(()=>{const c=document.getElementById("comment"); c.value="Agent test"; c.dispatchEvent(new Event("input",{bubbles:true}))})()');
    await click('signoff');
    await waitFor(`document.getElementById('sentence').textContent.startsWith('Signed off')`, 60000);
    await idle();
  } else check('turn 4: tile could be signed off', false, await ev('document.getElementById("signoff").title + " | " + document.getElementById("left").innerText.slice(0, 500)'));
  check('turn 4: the tile is signed off', (await S()).tiles[t4].state === 'signed_off');
  const hash4 = hashTree('src', 'tests', 'cases');
  confirmAnswer = 1; confirms.length = 0;
  await say('turn 4', t4 === 'units_allocated'
    ? 'Change this tile to ignore the allocation rate: units allocated is the premium divided by the unit price. Make the change now.'
    : 'Change this tile: subtract one unit from the result. Make the change now.');
  summary.confirms = confirms.slice();
  check('turn 4: the native confirm was requested', confirms.length >= 1, `${await logText()}`);
  check('turn 4: the confirm has the buttons Change it / Cancel, defaulting to Cancel', confirms[0] && confirms[0].buttons.join('|') === 'Change it|Cancel' && confirms[0].defaultId === 1 && confirms[0].cancelId === 1, JSON.stringify(confirms[0]));
  check('turn 4: the file is unchanged after declining', hashTree('src', 'tests', 'cases') === hash4);
  check('turn 4: the tile is still signed off', (await S()).tiles[t4].state === 'signed_off');
  await shot('live-agent-declined');
  confirmAnswer = 0;

  // ------------------------------------------------------------ 5. a typed formula as the spec
  await go('#/tile/units_eop');
  await waitFor(`window.__gridLog.opens.length > 0`, 20000);
  await sleep(2500);   // the specline reads the formula rows of every sheet once the workbook is open
  const row = await gc(`async g => {
    const d = await g.docInspect(); const sh = d.sheets[d.activeSheet]; const m = /:([A-Z]+)(\\d+)$/.exec(sh.usedRange);
    const col = [...m[1]].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);
    const letter = n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
    const names = (await g.execute('sheet.read', { range: letter(col) + '1:' + letter(col) + m[2] })).values.map(r => r[0]);
    const r = names.indexOf('units_eop') + 1;
    const f = (await g.execute('sheet.read', { range: 'C' + r, formulas: true })).values[0][0];
    return { sheet: sh.name, row: r, formula: f };
  }`);
  check('turn 5: found the formula row', row && row.row > 0 && String(row.formula).startsWith('='), JSON.stringify(row));
  const typed = '=MAX(0,' + String(row.formula).slice(1) + ')';
  const hash5 = hashTree('review/tiles/units_eop');
  await gc(`async g => g.execute('cell.set', { cell: 'C${row.row}', input: ${JSON.stringify(typed)} })`);
  check('turn 5: the line "You changed the formula in C<row>." appears with both buttons', await waitFor(`(()=>{const b=document.getElementById('sheetbar'); return !b.hidden && b.innerText.startsWith('You changed the formula in C${row.row}. ') && !!document.getElementById('usespec') && !!document.getElementById('undospec')})()`, 10000), await ev('document.getElementById("sheetbar").innerText'));
  await shot('live-agent-formula-line');
  await sleep(3500);
  check('turn 5: the typed formula was not saved to the workbook', hashTree('review/tiles/units_eop') === hash5);
  const before5 = await doneCount();
  await click('usespec');
  const ok5 = await waitFor(`window.__ev.filter(e => e.type === "done").length > ${before5}`, 150000);
  await idle();
  const userEv = await ev('window.__ev.filter(e => e.type === "user" && e.text === "Use the typed formula as the spec.").slice(-1)[0]');
  const done5 = await ev('window.__ev.filter(e => e.type === "done").slice(-1)[0]');
  summary.turns.push({ label: 'turn 5', cost_usd: done5 && done5.cost_usd, num_turns: done5 && done5.num_turns });
  check('turn 5: the turn ran', ok5, await logText());
  check('turn 5: the event carries the formula, cell, case and row map', userEv && userEv.extra && userEv.extra.formula === typed && userEv.extra.cell === 'C' + row.row && !!userEv.extra.case && userEv.extra.rows && Object.values(userEv.extra.rows).includes('units_eop'), JSON.stringify(userEv));
  check('turn 5: "Use the typed formula as the spec." is in the log', (await logText()).includes('Use the typed formula as the spec.'));
  check('turn 5: the line above the sheet is gone', await ev('document.getElementById("sheetbar").hidden'));
  await shot('live-agent-formula-turn');

  // ------------------------------------------------------------ 6. history survives a view change
  const hist = await lines();
  await go('#/model');
  check('model view has an empty log and the model placeholder', (await lines()).length === 0 && await ev('document.getElementById("agentlog-input").placeholder') === 'Add a module for surrender values after cashflows', JSON.stringify(await lines()));
  await go('#/tile/units_eop');
  await sleep(500);
  const hist2 = await lines();
  check('history survives a view change', hist2.length === hist.length && hist2.length >= 4 && hist2.some(l => l.lab === 'You'), `${hist.length} vs ${hist2.length}`);
  await go('#/tile/units_amc');
  check('the other tile shows its own conversation', (await lines()).some(l => l.txt.startsWith('Remove the cap')));
  await shot('live-agent-history');

  summary.agent_status = await ev('window.api.agent.status()');
  summary.total_cost_usd = summary.agent_status && summary.agent_status.cost_usd;
  summary.unchanged_outside_agent_edits = hashTree('src', 'tests', 'cases') !== srcHash0;
  finish(0);
})().catch(e => { summary.errors.push(String(e && e.stack || e)); finish(1); });
