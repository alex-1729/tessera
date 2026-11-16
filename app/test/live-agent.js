'use strict';
// Live test of the agent: real model calls (a handful of turns, a few cents each), real tilekit, on a temporary
// COPY of model/ (the real model directory is only the Python project). Each message goes to the agent through the
// UI-less call window.api.agent.send(scope, text): the same service, prompt and tools as Claude Code in the pane, run
// with the Agent SDK. The pane itself holds a stand-in (test/fake-claude.js), so no second Claude Code is started.
// What the agent raises is checked where the reviewer sees it: cards above the terminal, drafts in the centre.
// Run from app/:
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
const pane = require('./stand-in')(tmp);
process.env.APP_ALLOW_LOCAL_REMOTE = '1';      // a local bare repository stands in for GitHub (the real dialog takes only GitHub links)
process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_NOSYSTEM = '1';
Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' });
const { execFileSync } = require('child_process');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

const started = Date.now();
const summary = { checks: [], shots: [], errors: [], turns: [], confirms: [] };
let ctl = null, finished = false;
const hard = setTimeout(() => { summary.errors.push('hard timeout (9 minutes)'); finish(2); }, 9 * 60 * 1000);

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
  const freshDir = path.join(tmp, 'fresh-model');
  ctl = await require('../src/main').start({ show: true, settingsFile, modelDir: copy, pickFolder: async () => freshDir });
  const win = ctl.win;
  win.webContents.on('console-message', (...a) => { const m = a[0] && a[0].message !== undefined ? a[0] : { level: a[1], message: a[2] }; if (m.level === 'error' || m.level === 3) summary.errors.push('console: ' + String(m.message).slice(0, 300)); });
  win.webContents.on('dom-ready', () => { win.webContents.executeJavaScript('window.__both=()=>document.getElementById("left").innerText+"\\n"+document.getElementById("rightbar").innerText', true).catch(() => {}); });
  // a workbook with unsaved edits asks "Leave site?" on reload; a test reloads on purpose, so let it through
  win.webContents.on('will-prevent-unload', e => e.preventDefault());
  const ev = js => win.webContents.executeJavaScript(js, true);
  await ev('window.__both=()=>document.getElementById("left").innerText+"\\n"+document.getElementById("rightbar").innerText; true');
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
  // what the agent did, as the events the app received (each is also a line in an audit trail, review/.../log.jsonl)
  const events = () => ev('window.__ev.map(e => ({ type: e.type, text: e.text || "", scope: e.scope, extra: e.extra }))');
  const logText = async () => (await events()).filter(e => e.type !== 'turn_start').map(e => `${e.type}: ${e.text}`).join('\n').slice(-3000);
  const scopeNow = () => ev('(()=>{const r=window.__app.route(); return r.view==="tile" ? {level:"tile",id:r.id} : r.view==="module" ? {level:"module",id:r.id} : {level:"model",id:"model"}})()');
  const doneCount = () => ev('window.__ev.filter(e => e.type === "done").length');
  const gc = js => ev(`(async()=>{const g=document.querySelector('#gridhost iframe').contentWindow.gridcraft; return await (${js})(g)})()`);

  // One turn: send the message about what the window shows (the UI-less call), wait for the turn to end.
  async function say(label, text, ms = 150000, extra) {
    const before = await doneCount();
    const t0 = Date.now();
    const scope = await scopeNow();
    await ev(`void window.api.agent.send(${JSON.stringify(scope)}, ${JSON.stringify(text)}${extra ? ', ' + JSON.stringify(extra) : ''}).catch(e => window.__ev.push({ type: 'error', text: String(e && e.message || e) })); true`);
    const ok = await waitFor(`window.__ev.filter(e => e.type === "done").length > ${before}`, ms);
    await idle();
    const done = await ev('window.__ev.filter(e => e.type === "done").slice(-1)[0]');
    summary.turns.push({ label, seconds: Math.round((Date.now() - t0) / 1000), cost_usd: done && done.cost_usd, num_turns: done && done.num_turns });
    check(label + ': turn finished', ok, await logText());
    return ok;
  }

  check('app ready', await waitFor('window.__app && window.__app.ready', 30000));
  check('agent api exposed', await ev('!!(window.api && window.api.agent)'));
  await ev('window.__ev = []; window.api.agent.onEvent(e => window.__ev.push(e)); true');
  check('the pane is in the right bar, with the stand-in for Claude Code in it and no input box of the app\'s own', await ev('!document.getElementById("agentlog").hidden && !!document.querySelector("#rightbar #termhost") && !document.getElementById("agentlog-input")'));

  const srcHash0 = hashTree('src', 'tests', 'cases');

  // ------------------------------------------------------------ 1. a tile edit by typing
  await go('#/tile/units_amc');
  const toggleSide = async (id, want) => { await ev(`document.getElementById(${JSON.stringify(id)}).click()`); await sleep(300); };
  const stripWord = () => ev(`document.getElementById('rightstrip').innerText.replace(/\\s+/g,' ').trim()`);
  const q0 = (await S()).graph.q.units_amc;
  const ok1 = await say('turn 1', 'Remove the cap: the charge is units after allocation times the monthly rate.');
  const l1 = await events();
  const notSigned = l1.find(l => l.type === 'error' && /not signed in/i.test(l.text));
  if (notSigned) {
    summary.skipped = 'The agent is not signed in on this machine: ' + notSigned.text;
    console.error('NOT RUN: ' + summary.skipped);
    await shot('live-agent-not-signed-in');
    check('not signed in: the single sentence is reported once', l1.filter(l => /not signed in/i.test(l.text)).length === 1, JSON.stringify(l1));
    return finish(3);
  }
  check('turn 1: the events are the user\'s message with its selection, at least one action and a reply from the agent', l1.some(l => l.type === 'user' && l.text.startsWith('Remove the cap') && l.scope && l.scope.level === 'tile' && l.scope.id === 'units_amc') && l1.some(l => l.type === 'action') && l1.some(l => l.type === 'agent'), JSON.stringify(l1));
  check('turn 1: nothing of the exchange is drawn in the pane (the conversation is Claude Code\'s, not the app\'s)', await ev(`!document.querySelector('#agentlog-log .alog-line')`));
  let s1 = await S();
  const q1 = s1.graph.q.units_amc;
  await ev(`window.__app.setCentre('code')`); await sleep(500);
  check('turn 1: the tile code and formula changed in the view (the Code segment shows the new source)', q1.source.code !== q0.source.code && q1.formula !== q0.formula && !q1.source.code.includes('amc_cap_units') && (await ev('(document.querySelector("#srcnow .src") || document.querySelector("#codewrap .src")).dataset.code')) === q1.source.code, `${q0.formula} -> ${q1.formula}`);
  check('turn 1: the Code segment shows Was and Now for the tile the agent changed', await ev(`!!document.getElementById('srcpair') && document.querySelector('#srcwas .src').dataset.code.includes('amc_cap_units') && !document.querySelector('#srcnow .src').dataset.code.includes('amc_cap_units')`), await ev(`document.getElementById('codewrap').innerText.slice(0,300)`));
  await shot('live-agent-code-was-now');
  await ev(`window.__app.setCentre('spreadsheet')`);
  check('turn 1: status sentence is not "signed off"', !(await ev('document.getElementById("sentence").textContent')).startsWith('Signed off'));
  await shot('live-agent-tile');

  // ------------------------------------------------------------ 2. a what-if, then Discard
  await go('#/tile/units_eop');
  const hashBeforeWhatIf = hashTree('src', 'tests', 'cases');
  await say('turn 2', 'What if the closing units deducted the AMC units a second time (opening units plus units allocated, less units_amc twice)? Run a what-if on this tile with that code and show me the effect. Do not change anything.');
  const l2 = await events();
  const draftLine = await ev(`(()=>{const d=document.querySelector('#agentlog-log .alog-draft'); return d ? {text: d.innerText, nums: d.querySelectorAll('.alog-num').length, buttons: [...d.querySelectorAll('button')].map(b => b.textContent)} : null})()`);
  check('turn 2: a draft line with numbers', draftLine && draftLine.nums >= 1, JSON.stringify(l2));
  check('turn 2: what-if buttons are Apply draft and Discard', draftLine && draftLine.buttons.join('|') === 'Apply draft|Discard', JSON.stringify(draftLine));
  await shot('live-agent-whatif');
  await toggleSide('hideright');
  check('turn 2: with the chat collapsed, the strip says "draft" while the draft waits', (await stripWord()) === 'Chat draft', await stripWord());
  await toggleSide('rightstrip');
  check('turn 2: nothing written before a choice', hashTree('src', 'tests', 'cases') === hashBeforeWhatIf);
  if (draftLine) {
    await ev(`document.querySelector('#agentlog-log .alog-draft button[data-act="discard"]').click()`);
    check('turn 2: Discard replaces the buttons with "Discarded."', await waitFor(`(()=>{const d=document.querySelector('#agentlog-log .alog-draft'); return d && !d.querySelector('button') && d.innerText.includes('Discarded.')})()`, 10000));
    await idle();
    check('turn 2: Discard leaves the files unchanged', hashTree('src', 'tests', 'cases') === hashBeforeWhatIf);
  }

  // ------------------------------------------------------------ 3. a module draft (or a question), then Accept
  await go('#/module/unit_projection');
  const hash3 = hashTree('src', 'tests', 'cases');
  const draftsNow = async () => ((await S()).drafts || []).filter(d => d.kind !== 'what_if').length;
  const agentSaid = async () => (await events()).filter(e => e.type === 'agent').length;
  const dBefore = await draftsNow(), aBefore = await agentSaid();
  await say('turn 3', 'Add a tile for a surrender charge in units: a starting percentage of the units after allocation, falling to zero over five years. The starting percentage is a new parameter.');
  let hasDraft = (await draftsNow()) > dBefore;
  const hasQuestion = !hasDraft && (await agentSaid()) > aBefore;      // with no question form here, the agent asks in words
  check('turn 3: a draft appears, or the agent asks in words', hasDraft || hasQuestion, await logText());
  check('turn 3: nothing is written before accepting', hashTree('src', 'tests', 'cases') === hash3);
  if (!hasDraft) {
    await shot('live-agent-question');
    await say('turn 3b', 'No new parameter. Propose the tile as a draft now with propose_structure: name surrender_charge_units, arguments units_after_alloc and amc_pm only, spec: units after allocation times the monthly rate, as a placeholder until the real rate is agreed.');
    hasDraft = (await draftsNow()) > dBefore;
    check('turn 3b: a draft appears', hasDraft, await logText());
    check('turn 3b: nothing is written before accepting', hashTree('src', 'tests', 'cases') === hash3);
  }
  if (hasDraft) {
    check('the draft opens in the centre (Draft to approve) with Accept draft and Discard, and is not a card in the bar', await waitFor(`!document.getElementById('seg-draft').hidden && !!document.getElementById('draftview')`, 15000) && await ev(`[...document.querySelectorAll('[data-dv]')].map(b => b.textContent).join('|')`) === 'Accept draft|Discard' && await ev(`!document.querySelector('#agentlog-log .alog-draft')`));
    check('proposed tiles are drawn on the tile strip, dotted and labelled "proposed"', await waitFor(`[...document.querySelectorAll('#tiles .t.notbuilt')].some(t => t.innerText.includes('proposed'))`, 10000));
    check('proposed boxes on the strip are not links, and the left bar has no map', await ev(`[...document.querySelectorAll('#tiles .t')].filter(t => t.innerText.includes('proposed')).every(t => t.tagName !== 'A') && !document.querySelector('#panel svg.map')`));
    await shot('live-agent-module-draft');
    // (the agent may have proposed a parameter draft as well as the tiles draft: accept each in turn, oldest first)
    for (let i = 0; i < 3 && (await draftsNow()) > 0; i++) {
      const left = await draftsNow();
      await ev(`document.querySelector('[data-dv="accept"]').click()`);
      await waitFor(`window.__app.S.drafts.filter(d => d.kind !== 'what_if').length < ${left} || !!(document.getElementById('dv-error') || { textContent: '' }).textContent`, 120000);
      await idle();
    }
    check('Accept draft applies the draft and the Draft to approve tab goes', (await draftsNow()) === 0 && await ev(`document.getElementById('seg-draft').hidden`), await ev(`(document.getElementById('dv-error') || { textContent: '' }).textContent`) + ' | ' + await logText());
    await idle();
    check('accepted: files written', hashTree('src', 'tests', 'cases') !== hash3);
    check('accepted: a not-built tile is on the strip, dotted, labelled "not built"', await waitFor(`[...document.querySelectorAll('#tiles a.t.notbuilt')].some(t => t.innerText.includes('not built'))`, 30000), await ev('document.getElementById("left").innerText.slice(0,600)'));
    check('accepted: Build not-built tiles button', await waitFor(`!!document.getElementById('buildnotbuilt') && /^Build not-built tiles \\(\\d+\\)$/.test(document.getElementById('buildnotbuilt').textContent)`, 20000), await ev('window.__both().slice(0,900)'));
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
  } else check('turn 4: tile could be signed off', false, await ev('document.getElementById("signoff").title + " | " + window.__both().slice(0, 500)'));
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
    return { sheet: sh.name, row: r, formula: f, names };
  }`);
  check('turn 5: found the formula row', row && row.row > 0 && String(row.formula).startsWith('='), JSON.stringify(row));
  const typed = '=MAX(0,' + String(row.formula).slice(1) + ')';
  const hash5 = hashTree('review/tiles/units_eop');
  await gc(`async g => g.execute('cell.set', { cell: 'C${row.row}', input: ${JSON.stringify(typed)} })`);
  check('turn 5: the line "You changed the formula in C<row>." appears with both buttons', await waitFor(`(()=>{const b=document.getElementById('sheetbar'); return !b.hidden && b.innerText.startsWith('You changed the formula in C${row.row}. ') && !!document.getElementById('usespec') && !!document.getElementById('undospec')})()`, 10000), await ev('document.getElementById("sheetbar").innerText'));
  await shot('live-agent-formula-line');
  await sleep(3500);
  check('turn 5: the typed formula was not saved to the workbook', hashTree('review/tiles/units_eop') === hash5);
  // In the app "Use it as the spec" types its request into Claude Code. Here the typed formula goes to the agent with
  // the UI-less call, carrying what the line knows: the formula, its cell, the case on show and the sheet's row map.
  await click('undospec');
  check('turn 5: Undo puts the sheet back and the line above it goes', await waitFor('document.getElementById("sheetbar").hidden', 20000));
  const rows5 = Object.fromEntries(row.names.map((n, i) => [String(i + 1), n]).filter(([, n]) => typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)));
  const case5 = await ev(`(window.__app.S.cases.find(c => (c.name || c.id) === ${JSON.stringify(row.sheet)}) || {}).id || null`);
  const ok5 = await say('turn 5', 'Use the typed formula as the spec.', 150000, { formula: typed, cell: 'C' + row.row, rows: rows5, ...(case5 ? { case: case5 } : {}) });
  const userEv = await ev('window.__ev.filter(e => e.type === "user" && e.text === "Use the typed formula as the spec.").slice(-1)[0]');
  check('turn 5: the turn ran', ok5, await logText());
  check('turn 5: the event carries the formula, cell, case and row map', userEv && userEv.extra && userEv.extra.formula === typed && userEv.extra.cell === 'C' + row.row && !!userEv.extra.case && userEv.extra.rows && Object.values(userEv.extra.rows).includes('units_eop'), JSON.stringify(userEv));
  await shot('live-agent-formula-turn');

  // ------------------------------------------------------------ 5b. a sign-off the agent asks for: the card above the terminal, and only its button records it
  await go('#/tile/deaths');
  const stD = (await S()).tiles.deaths;
  if (stD.state !== 'signed_off' && (stD.workbook_current === false || ['stale', 'unbuilt'].includes(stD.state))) { await click('rebuild'); await sleep(500); await idle(); }
  const hashSo = hashTree('src', 'tests', 'cases');
  await say('chat sign-off', "I'm happy with this tile, sign it off.");
  const cardUp = await waitFor(`!!document.querySelector('#agentlog-log .alog-card button[data-act="signoff"]')`, 20000);
  check('chat sign-off: a sign-off card appears above the terminal', cardUp && await ev(`(()=>{const c=[...document.querySelectorAll('#agentlog-log .alog-card')].pop().getBoundingClientRect(), t=document.getElementById('termhost').getBoundingClientRect(); return c.bottom<=t.top+1})()`), await logText());
  if (cardUp) {
    const info = await ev(`(()=>{const c=[...document.querySelectorAll('#agentlog-log .alog-card')].pop(); return {text:c.innerText, boxes:c.querySelectorAll('input.assume').length, disabled:c.querySelector('button[data-act=signoff]').disabled, title:c.querySelector('button[data-act=signoff]').title, buttons:[...c.querySelectorAll('button')].map(b=>b.textContent).join('|'), reviewer:c.querySelector('[data-f=reviewer]').value}})()`);
    check('chat sign-off: the card shows the tile, its formula, assumptions and cases, and the buttons Sign off / Not now', /deaths/.test(info.text) && info.buttons === 'Sign off|Not now' && /agrees|differs/.test(info.text), info.text);
    check('chat sign-off: the status in the left bar is unchanged while the card waits (the model cannot sign off)', !(await ev('document.getElementById("sentence").textContent')).startsWith('Signed off') && (await S()).tiles.deaths.state !== 'signed_off');
    await toggleSide('hideright');
    check('chat sign-off: with the chat collapsed, the strip says "confirm"', (await stripWord()) === 'Chat confirm', await stripWord());
    await toggleSide('rightstrip');
    await shot('live-agent-signoff-card');
    await ev(`(()=>{const c=[...document.querySelectorAll('#agentlog-log .alog-card')].pop(); c.querySelectorAll('input.assume').forEach(b=>b.click()); const m=c.querySelector('[data-f=comment]'); m.value='Signed from the chat'; m.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const enabled = await ev(`(()=>{const c=[...document.querySelectorAll('#agentlog-log .alog-card')].pop(); return !c.querySelector('button[data-act=signoff]').disabled})()`);
    check('chat sign-off: Sign off is enabled once every assumption is ticked (no blockers)', enabled, info.title + ' | ' + info.text);
    if (enabled) {
      await ev(`[...document.querySelectorAll('#agentlog-log .alog-card')].pop().querySelector('button[data-act=signoff]').click()`);
      check('chat sign-off: the card says "Signed off by NAME."', await waitFor(`[...document.querySelectorAll('#agentlog-log .alog-card')].pop().innerText.includes('Signed off by ')`, 90000), await logText());
      await idle();
      check('chat sign-off: the tile is signed off, the left bar sentence and the strip follow', await waitFor(`window.__app.S.status.tiles.deaths.state === 'signed_off'`, 20000) && await waitFor(`document.getElementById('sentence').textContent.startsWith('Signed off')`, 20000) && await waitFor(`[...document.querySelectorAll('#tiles a.t')].some(a => a.textContent.includes('deaths') && a.textContent.includes('signed off'))`, 20000));
      check('chat sign-off: only the button recorded it (the source files are untouched)', hashTree('src', 'tests', 'cases') === hashSo);
      await shot('live-agent-signed-from-chat');
    }
  }

  // ------------------------------------------------------------ 6. the record: each turn is in the audit trail of its selection
  const trail = rel => { try { return fs.readFileSync(path.join(copy, 'review', rel, 'log.jsonl'), 'utf8'); } catch { return ''; } };
  check('each turn is filed in the audit trail of what was selected (review/.../log.jsonl)', trail('tiles/units_amc').includes('Remove the cap') && trail('modules/unit_projection').includes('surrender charge') && trail('tiles/deaths').includes('sign it off'), JSON.stringify([trail('tiles/units_amc').length, trail('modules/unit_projection').length, trail('tiles/deaths').length]));
  check('the app keeps no transcript of its own: no review/model/chat.jsonl and no review/model/chats', !fs.existsSync(path.join(copy, 'review/model/chat.jsonl')) && !fs.existsSync(path.join(copy, 'review/model/chats')));

  // ------------------------------------------------------------ 6b. "Commit this": the chat commits locally and never pushes
  await go('#/model');
  git(copy, 'init', '-b', 'main'); git(copy, 'add', '-A'); git(copy, 'commit', '-m', 'Baseline');
  fs.writeFileSync(path.join(copy, 'notes.txt'), 'Reviewer notes from the AMC cap discussion.\n');
  const headBefore = git(copy, 'rev-parse', 'HEAD');
  const okCommit = await say('commit', 'Commit this.');
  const headAfter = git(copy, 'rev-parse', 'HEAD');
  const subject = git(copy, 'log', '-1', '--format=%s');
  check('commit this: the model committed (one new commit that holds notes.txt, with a plain message) and the working tree is clean', okCommit && headAfter !== headBefore && git(copy, 'log', '--format=%H', headBefore + '..HEAD').split('\n').length === 1 && git(copy, 'show', '--name-only', '--format=', 'HEAD').split('\n').includes('notes.txt') && subject.length > 3 && subject.length < 200 && !/[*`#]/.test(subject) && git(copy, 'status', '--porcelain') === '', `${subject} | ${git(copy, 'status', '--porcelain')}`);
  check('commit this: no push was offered and no chat log or real data went into the commit', await ev(`!document.querySelector('.pushcard')`) && !(await ev('window.__ev.some(e => e.type === "push_request")')) && git(copy, 'ls-files').split('\n').every(f => !/(^|\/)(log|chat)\.jsonl$/.test(f)));
  summary.commit_message = subject;
  await shot('live-agent-commit');

  // ------------------------------------------------------------ 7. File > New model on a temporary folder, then the first chat reply
  await go('#/model');
  await ev('window.__old = true');
  ctl.win.webContents.send('menu', 'newModel');
  check('new model: the dialog opens', await waitFor(`!!document.getElementById('f-folder') && !!document.getElementById('pickfolder')`, 5000));
  await ev(`document.getElementById('pickfolder').click()`);
  await waitFor(`document.getElementById('f-folder').value.length>3`, 5000);
  const freshRemote = path.join(tmp, 'fresh-remote.git'); fs.mkdirSync(freshRemote); git(freshRemote, 'init', '--bare', '-b', 'main');
  await ev(`(()=>{for (const [id, v] of [['f-name', 'Fresh model'], ['f-github', ${JSON.stringify(freshRemote)}]]) { const n=document.getElementById(id); n.value=v; n.dispatchEvent(new Event('input',{bubbles:true})) }})()`);
  await ev(`document.getElementById('confirm').click()`).catch(() => {});
  const opened = await waitFor(`!window.__old && window.__app && window.__app.ready`, 90000);
  check('new model: tilekit init created the folder and the window reopened on it', opened && fs.existsSync(path.join(freshDir, 'tilekit.toml')) && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).lastModel === freshDir, opened ? 'files: ' + (fs.existsSync(freshDir) ? fs.readdirSync(freshDir).join(',') : 'none') : await ev('document.getElementById("dialog") ? document.getElementById("dialog").innerText : document.body.innerText.slice(0, 300)'));
  if (opened) {
    await idle();
    await ev('window.__ev = []; window.api.agent.onEvent(e => window.__ev.push(e)); true');
    const PRE = 'Scaffold this model with me. Ask me what you need to know.';
    check('new model: the model view shows the new model with an empty map message, no second row of tabs', await waitFor(`document.getElementById('title') && document.getElementById('title').textContent.includes('Fresh model') && !!document.getElementById('nomodules') && document.getElementById('tiles').hidden`, 30000), await ev('document.getElementById("left").innerText.slice(0, 400)'));
    check('new model: the scaffolding request is typed at Claude Code\'s prompt (the stand-in) and not sent, and no card waits', await waitFor(`document.getElementById('termhost').innerText.replace(/\\s+/g, '').includes(${JSON.stringify(PRE.replace(/\s+/g, ''))})`, 30000) && !pane.records().some(r => r.command) && await ev(`!document.querySelector('#agentlog-log .alog-line')`), await ev(`document.getElementById('termhost').innerText.slice(0, 300)`));
    await shot('live-agent-new-model');
    const okS = await say('scaffold', PRE);
    const ln = await events();
    check('new model: one scaffolding message gets a reply (the agent asks its questions in words) and no error', okS && ln.some(l => l.type === 'user' && l.text === PRE) && ln.some(l => l.type === 'agent') && !ln.some(l => l.type === 'error'), JSON.stringify(ln));
    await shot('live-agent-new-model-reply');
  }

  summary.agent_status = await ev('window.api.agent.status()');
  summary.total_cost_usd = summary.agent_status && summary.agent_status.cost_usd;
  summary.unchanged_outside_agent_edits = hashTree('src', 'tests', 'cases') !== srcHash0;
  finish(0);
})().catch(e => { summary.errors.push(String(e && e.stack || e)); finish(1); });
