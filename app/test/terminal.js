'use strict';
// Test of Claude Code in the right-hand pane (the only chat the app has), without calling a model.
// The app is started with a stand-in for the Claude Code program (test/fake-claude.js), which starts
// the app's real bridge (src/agent/cli-bridge.js) as its MCP server and runs the app's real hooks. So this covers:
// what Claude Code is started with, the bridge and its token, the tool list, the selection line and the note after a
// restart, tool calls, a draft raised from the terminal and approved in the centre pane (one accept that fails, one
// that works), the cards above the terminal (a sign-off request and a what-if: shown, back after a reload, gone a few
// seconds after they are settled), the buttons that type into Claude Code, and the Conversations list (list, open,
// delete). It also checks that the app's old built-in chat is gone.
// On a temporary COPY of model/. Run from app/: ./node_modules/.bin/electron test/terminal.js
process.env.APP_NO_AUTOSTART = '1';
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const REAL_MODEL = path.resolve(__dirname, '../../model');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-terminal-'));
const copy = path.join(tmp, 'model');
const seen = path.join(tmp, 'fake-claude.jsonl');          // what the stand-in saw, one JSON object per line
const standIn = path.join(tmp, 'claude');

// The stand-in, started the way the app starts Claude Code: a program on disk. It runs under Electron's own Node.
fs.writeFileSync(standIn, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${path.join(__dirname, 'fake-claude.js')}' "$@"\n`, { mode: 0o755 });
process.env.APP_CLAUDE_BIN = standIn;
process.env.FAKE_CLAUDE_OUT = seen;
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude-config');   // Claude Code's saved conversations, for this test only
// Switches an app started from inside another Claude Code session would inherit; the pane must not pass them on.
process.env.CLAUDECODE = '1';
process.env.CLAUDE_CODE_ENTRYPOINT = 'terminal-test';
process.env.CLAUDE_AGENT_SDK_VERSION = '0.0.0-test';

const summary = { checks: [], shots: [], errors: [] };
let ctl = null, finished = false;
const hard = setTimeout(() => { summary.errors.push('hard timeout'); finish(2); }, 10 * 60 * 1000);

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
const check = (name, ok, detail) => { summary.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail: typeof detail === 'string' ? detail.slice(0, 600) : detail }) }); };

const records = () => { try { return fs.readFileSync(seen, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const waitRecord = async (pick, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { const r = pick(records()); if (r) return r; await sleep(150); } return null; };
const starts = () => records().filter(r => r.start);
const argAfter = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const post = (port, pathname, token) => new Promise(resolve => {
  const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-tessera-token': token } : {}) } },
    res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', () => resolve(0));
  req.end('{}');
});

(async () => {
  const skip = /(^|\/)(\.venv|__pycache__|real-data|\.pytest_cache)(\/|$)/;
  fs.cpSync(REAL_MODEL, copy, { recursive: true, filter: src => !skip.test(path.relative(REAL_MODEL, src).split(path.sep).join('/')) });
  // no sign-offs, so accepting a parameters draft needs no "this will need re-confirming" answer
  for (const f of fs.readdirSync(path.join(copy, 'review'), { recursive: true })) if (/signoff\.json$|expected\.json$/.test(f)) fs.rmSync(path.join(copy, 'review', f));
  const paramsFile = path.join(copy, 'src', 'unit_linked', 'params.py');

  // Two saved conversations for this model folder, as Claude Code keeps them.
  const { sessionsDir } = require('../src/sessions');
  const convDir = sessionsDir(copy);
  fs.mkdirSync(convDir, { recursive: true });
  const OLD = '11111111-1111-4111-8111-111111111111', NEW = '22222222-2222-4222-8222-222222222222';
  const transcript = (first, day) => [
    { type: 'user', message: { role: 'user', content: first }, timestamp: `2026-11-${day}T10:00:00Z` },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }, timestamp: `2026-11-${day}T10:01:00Z` },
  ].map(o => JSON.stringify(o)).join('\n') + '\n';
  fs.writeFileSync(path.join(convDir, OLD + '.jsonl'), transcript('Lay out the decrements tiles', '01'));
  fs.writeFileSync(path.join(convDir, NEW + '.jsonl'), transcript('Build the tile units_eop', '02'));

  ctl = await require('../src/main').start({ show: true, settingsFile: path.join(tmp, 'settings.json'), modelDir: copy });
  const win = ctl.win;
  win.webContents.on('console-message', (...a) => { const m = a[0] && a[0].message !== undefined ? a[0] : { level: a[1], message: a[2] }; if (m.level === 'error' || m.level === 3) summary.errors.push('console: ' + String(m.message).slice(0, 300)); });
  win.webContents.on('will-prevent-unload', e => e.preventDefault());
  const ev = js => win.webContents.executeJavaScript(js, true);
  const waitFor = async (js, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await ev(js); if (v) return v; } catch { /* retry */ } await sleep(100); } return false; };
  const idle = async () => { await ev('window.__app.idle()'); await waitFor('document.getElementById("working").hidden', 120000); await ev('window.__app.idle()'); };
  const shot = async name => { await sleep(300); const img = await win.webContents.capturePage(); const f = path.join(OUT, name + '.png'); fs.writeFileSync(f, img.toPNG()); summary.shots.push(f); };
  const go = async h => { await ev(`location.hash=${JSON.stringify(h)}`); await idle(); await sleep(300); };
  const termApi = (call) => ev(`window.api.term.${call}.then(v => ({ ok: v }), e => ({ error: String(e && e.message || e) }))`);
  // Type a line at the stand-in's prompt, as the user would, and wait for what it saw during that turn.
  let turns = 0;
  const type = async (line, ms = 120000) => {
    const before = records().filter(r => r.command).length;
    await ev(`window.api.term.input(${JSON.stringify(line + '\r')})`);
    turns++;
    return waitRecord(rs => rs.filter(r => r.command)[before], ms);
  };

  await waitFor('window.__app && window.__app.ready', 60000);
  await idle();

  // ------------------------------------------------------------ 1. the pane starts Claude Code, with only what it should have
  check('the pane is Claude Code: the window has the terminal API and the terminal is in the right bar', await ev(`!!(window.api && window.api.term) && !!document.querySelector('#rightbar #agentlog #termhost') && !document.getElementById('termnone')`));
  check('the built-in chat is gone: no input box, no Stop button, no starters, no conversations or history call, no chatMode setting', await ev(`!document.getElementById('agentlog-input') && !document.getElementById('agentlog-stop') && !document.getElementById('starters') && !document.getElementById('chatnew') && !document.getElementById('chatlist') && !document.querySelector('#rightbar .agentlog-bottom') && window.api.agent.conversations===undefined && window.api.agent.newConversation===undefined && window.api.agent.history===undefined`)
    && !('chatMode' in ctl.settings) && !/chatMode/.test(fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')));
  const first = await waitRecord(rs => rs.find(r => r.start), 45000);
  check('the pane starts Claude Code when a model is opened', !!first, JSON.stringify(records()).slice(0, 400));
  if (!first) return finish(1);
  const a = first.argv;
  check('started in the model folder', fs.realpathSync(first.cwd) === fs.realpathSync(copy), first.cwd);
  check('built-in tools are limited to reading files and asking the user', argAfter(a, '--tools') === 'Read,Glob,Grep,AskUserQuestion', argAfter(a, '--tools'));
  check('nothing is allowed without asking beyond those and the app\'s own tools', argAfter(a, '--allowedTools') === 'Read,Glob,Grep,AskUserQuestion,mcp__tiles' && !/Bash|Write|Edit/.test(argAfter(a, '--allowedTools')), argAfter(a, '--allowedTools'));
  check('the user\'s own settings, plugins and MCP servers are not loaded', a.includes('--strict-mcp-config') && argAfter(a, '--setting-sources') === '' && argAfter(a, '--permission-mode') === 'default', JSON.stringify(a.filter(x => x.startsWith('--'))));
  check('the only MCP server is the app\'s bridge, and both hooks are set', first.configOk && (() => {
    const mcp = JSON.parse(argAfter(a, '--mcp-config')), st = JSON.parse(argAfter(a, '--settings'));
    return Object.keys(mcp.mcpServers).join() === 'tiles' && /cli-bridge\.js$/.test(mcp.mcpServers.tiles.args[0]) && mcp.mcpServers.tiles.args[1] === 'mcp'
      && /cli-bridge\.js' hook prompt$/.test(st.hooks.UserPromptSubmit[0].hooks[0].command) && /cli-bridge\.js' hook stop$/.test(st.hooks.Stop[0].hooks[0].command);
  })());
  check('the latest saved conversation is continued', a.includes('--continue') && !a.includes('--resume'), JSON.stringify(a.slice(0, 3)));
  check('the house standards are in the instructions Claude Code is started with', /House standards for writing tiles/.test(argAfter(a, '--append-system-prompt') || ''));
  check('switches inherited from another Claude Code session are not passed on', !first.env.includes('CLAUDECODE') && !first.env.includes('CLAUDE_CODE_ENTRYPOINT') && !first.env.includes('CLAUDE_AGENT_SDK_VERSION')
    && first.env.includes('CLAUDE_CODE_DISABLE_AUTO_MEMORY') && first.env.includes('CLAUDE_CONFIG_DIR'), JSON.stringify(first.env));
  check('the bridge answers the MCP handshake', !!(await waitRecord(rs => rs.find(r => r.initialized && r.server && r.server.name === 'tiles'), 30000)));
  check('what Claude Code prints is drawn in the pane', await waitFor(`/fake claude: ready/.test(document.getElementById('termhost').innerText)`, 15000), await ev(`document.getElementById('termhost').innerText.slice(0, 200)`));

  // ------------------------------------------------------------ 2. the bridge refuses a caller without the token
  const port = Number(first.port);
  check('the bridge refuses a call without the app\'s token', await post(port, '/agent/tools') === 403 && await post(port, '/agent/tools', 'not-the-token') === 403);

  // ------------------------------------------------------------ 3. the tool list, and the note after a restart
  let r = await type('tools');
  const names = r && r.tools ? r.tools.map(t => t.name) : [];
  check('the tools reach Claude Code through the bridge, each with a description and a schema', names.length > 10 && r.tools.every(t => t.described && t.schema), JSON.stringify(r).slice(0, 400));
  check('the list has the tools the terminal flow relies on', ['model_overview', 'get_selection', 'propose_structure', 'propose_params', 'propose_inputs', 'write_tile', 'remove_tiles', 'propose_tests', 'show_in_app', 'request_signoff', 'rebuild'].every(n => names.includes(n)), names.join(', '));
  check('there is one tool list: the two tools of the old built-in chat (ask_user, add_input_request) do not exist', !names.includes('ask_user') && !names.includes('add_input_request') && !/ask_user|add_input_request/.test(argAfter(a, '--append-system-prompt') || '') && /AskUserQuestion/.test(argAfter(a, '--append-system-prompt') || ''), names.join(', '));
  check('the first message after the app starts carries the note that tools may have changed, with the tool names', r && /has been restarted/.test(r.prompt) && /remove_tiles/.test(r.prompt) && !/ask_user/.test(r.prompt), r && r.prompt);
  check('both hooks ran cleanly', r && r.promptCode === 0 && r.stopCode === 0, JSON.stringify(r && [r.promptCode, r.stopCode]));

  // ------------------------------------------------------------ 4. the selection travels with the message; tool calls
  await go('#/tile/units_amc');
  r = await type('call get_selection');
  check('the message carries what is selected in the window', r && /units_amc/.test(r.prompt), r && r.prompt);
  check('the restart note is sent once only', r && !/has been restarted/.test(r.prompt), r && r.prompt);
  check('a tool call returns the selected tile', r && !r.isError && /units_amc/.test(r.text), JSON.stringify(r).slice(0, 400));
  r = await type('call no_such_tool');
  check('a tool that does not exist is refused in words', r && r.isError && /There is no tool no_such_tool/.test(r.text), JSON.stringify(r).slice(0, 300));
  r = await type('call ask_user {"questions":[]}');
  check('a tool of the old built-in chat cannot be called', r && r.isError && /There is no tool ask_user/.test(r.text), JSON.stringify(r).slice(0, 300));

  // ------------------------------------------------------------ 5. a draft from the terminal is approved in the centre pane
  await go('#/model');
  const paramsBefore = fs.readFileSync(paramsFile, 'utf8');
  r = await type('draft terminal_test_loading');
  check('a draft proposed from the terminal is accepted by the tool', r && !r.isError, JSON.stringify(r).slice(0, 500));
  check('the Draft to approve tab appears and opens the draft', await waitFor(`!document.getElementById('seg-draft').hidden && !!document.getElementById('draftview') && /terminal_test_loading/.test(document.getElementById('draftview').innerText)`, 20000),
    await ev(`JSON.stringify([document.getElementById('seg-draft').hidden, !!document.getElementById('draftview')])`));
  check('nothing is written to the model before the draft is accepted', fs.readFileSync(paramsFile, 'utf8') === paramsBefore);
  await shot('terminal-draft');

  // an accept that fails: the model is made unloadable, so the draft cannot be applied
  const broken = paramsBefore + '\nraise RuntimeError("terminal test: the model is made to fail")\n';
  fs.writeFileSync(paramsFile, broken);
  await ev(`document.querySelector('[data-dv="accept"]').click()`);
  const reason = await waitFor(`(document.getElementById('dv-error') || { textContent: '' }).textContent`, 180000);
  check('an accept that fails shows its reason in the view', !!reason && String(reason).length > 10, String(reason));
  check('after a failed accept the draft is still there and the buttons work again', await ev(`!!document.getElementById('draftview') && !document.querySelector('[data-dv="accept"]').disabled`));
  check('a failed accept leaves the model\'s files as they were', fs.readFileSync(paramsFile, 'utf8') === broken);
  await shot('terminal-draft-failed');
  const consoleBefore = summary.errors.filter(e => e.startsWith('console:')).length;   // errors from here on include the broken model's
  fs.writeFileSync(paramsFile, paramsBefore);

  // the same draft accepted once the model loads again
  await ev(`document.querySelector('[data-dv="accept"]').click()`);
  // (the centre goes back to the spreadsheet; the old view may stay in the hidden code pane, so "closed" means not on show)
  const applied = await waitFor(`document.getElementById('seg-draft').hidden && (!document.getElementById('draftview') || document.getElementById('draftview').offsetParent === null)`, 240000);
  check('an accept that works applies the draft and closes the view', applied && /terminal_test_loading/.test(fs.readFileSync(paramsFile, 'utf8')),
    await ev(`JSON.stringify({ view: !!document.getElementById('draftview'), tabHidden: document.getElementById('seg-draft').hidden, error: (document.getElementById('dv-error') || { textContent: '' }).textContent, working: (document.getElementById('dv-working') || { textContent: '' }).textContent, dialog: (document.getElementById('dialog') || { innerText: '' }).innerText.slice(0, 300) })`));
  if (!applied) await shot('terminal-draft-not-applied');
  await idle();

  // ------------------------------------------------------------ 5a. the cards above the terminal: a sign-off request
  const cardsNow = () => ev(`[...document.querySelectorAll('#agentlog-log .alog-line')].map(l => ({ id: l.dataset.request || l.dataset.draft || '', buttons: [...l.querySelectorAll('button[data-act]')].map(b => b.textContent).join('|'), text: l.innerText.replace(/\\s+/g, ' ').slice(0, 200) }))`);
  const stripWord = () => ev(`document.getElementById('rightstrip').innerText.replace(/\\s+/g,' ').trim()`);
  const requestFiles = () => { try { return fs.readdirSync(path.join(copy, 'review', 'requests')).map(n => JSON.parse(fs.readFileSync(path.join(copy, 'review', 'requests', n), 'utf8'))); } catch { return []; } };
  await go('#/tile/units_amc');
  check('with nothing waiting the cards area takes no room above the terminal', await ev(`getComputedStyle(document.getElementById('agentlog-log')).display==='none'`));
  r = await type('call request_signoff {"kind":"tile","name":"units_amc"}');
  check('a sign-off request raised from the terminal is accepted by the tool and signs nothing', r && !r.isError && /only the reviewer's click records a sign-off/.test(r.text) && !fs.existsSync(path.join(copy, 'review/tiles/units_amc/signoff.json')), JSON.stringify(r).slice(0, 400));
  check('its card appears above the terminal with Sign off and Not now', await waitFor(`(()=>{const c=document.querySelector('#agentlog-log .alog-card[data-kind="tile"][data-name="units_amc"]'); if(!c) return false; const t=document.getElementById('termhost').getBoundingClientRect(), k=c.getBoundingClientRect(); return k.height>0 && k.bottom<=t.top+1 && [...c.querySelectorAll('button[data-act]')].map(b=>b.textContent).join('|')==='Sign off|Not now' && c.querySelector('.cardtitle').textContent.endsWith('units_amc')})()`, 15000), JSON.stringify(await cardsNow()));
  await shot('terminal-signoff-card');
  await ev(`document.getElementById('hideright').click()`); await sleep(400);
  check('collapsed, the right strip says "confirm" while the card waits', (await stripWord()) === 'Chat confirm', await stripWord());
  await ev(`document.getElementById('rightstrip').click()`); await sleep(400);
  const reqId = (requestFiles().find(q => q.status === 'pending' && q.name === 'units_amc') || {}).id;
  check('the request is saved as pending in review/requests', !!reqId, JSON.stringify(requestFiles().map(q => [q.id, q.status])));
  // a reload: the card is drawn again from the request file, and the terminal is joined to the same Claude Code
  const startsAtReload = starts().length;
  await ev('window.__old = true'); win.webContents.reload(); await sleep(500);
  await waitFor('!window.__old && window.__app && window.__app.ready', 60000); await idle();
  check('after a reload the waiting card is back with its buttons, read from the request files', await waitFor(`!!document.querySelector('#agentlog-log .alog-card[data-request="${reqId}"] button[data-act=signoff]') && !!document.querySelector('#agentlog-log .alog-card[data-request="${reqId}"] button[data-act=decline]')`, 15000), JSON.stringify(await cardsNow()));
  check('a reload does not start Claude Code again', await waitFor(`!!document.querySelector('#termhost .xterm')`, 15000) && starts().length === startsAtReload, String(starts().length - startsAtReload));
  await ev(`document.querySelector('#agentlog-log .alog-card[data-request="${reqId}"] button[data-act=decline]').click()`);
  check('Not now declines the request: the card says "Not signed." and nothing is signed', await waitFor(`(()=>{const c=document.querySelector('#agentlog-log .alog-card[data-request="${reqId}"]'); return c && c.innerText.includes('Not signed.') && !c.querySelector('button')})()`, 3000)
    && (requestFiles().find(q => q.id === reqId) || {}).status === 'declined' && !fs.existsSync(path.join(copy, 'review/tiles/units_amc/signoff.json')), JSON.stringify(await cardsNow()));
  check('a settled card goes a few seconds later, and the cards area closes', await waitFor(`!document.querySelector('#agentlog-log .alog-line') && getComputedStyle(document.getElementById('agentlog-log')).display==='none'`, 9000), JSON.stringify(await cardsNow()));
  await idle();
  r = await type('call get_selection');
  check('the next message tells Claude Code what the reviewer did with the request', r && /declined the sign-off request for units_amc/.test(r.prompt), r && r.prompt);

  // ------------------------------------------------------------ 5b. a what-if draft is a card above the terminal too
  const filesThen = [paramsFile, path.join(copy, 'tilekit.toml')].map(f => fs.readFileSync(f, 'utf8')).join('\0');
  r = await type('call what_if {"params":{"amc_pm":0.001}}', 240000);
  check('a what-if run from the terminal saves a draft and changes nothing in the model', r && !r.isError && /nothing in the real model changed/.test(r.text) && [paramsFile, path.join(copy, 'tilekit.toml')].map(f => fs.readFileSync(f, 'utf8')).join('\0') === filesThen, JSON.stringify(r).slice(0, 400));
  check('the what-if shows as a card above the terminal, not in the centre: Discard only (a parameter what-if cannot be applied)', await waitFor(`(()=>{const d=document.querySelector('#agentlog-log .alog-draft'); return !!d && /^What if/.test(d.innerText.trim()) && [...d.querySelectorAll('button[data-act]')].map(b=>b.textContent).join('|')==='Discard' && document.getElementById('seg-draft').hidden})()`, 15000), JSON.stringify(await cardsNow()));
  await ev(`document.getElementById('hideright').click()`); await sleep(400);
  check('collapsed, the right strip says "draft" while the what-if waits', (await stripWord()) === 'Chat draft', await stripWord());
  await ev(`document.getElementById('rightstrip').click()`); await sleep(400);
  await shot('terminal-whatif-card');
  await ev(`document.querySelector('#agentlog-log .alog-draft button[data-act=discard]').click()`);
  check('Discard says "Discarded." and the card then goes', await waitFor(`(()=>{const d=document.querySelector('#agentlog-log .alog-draft'); return d && d.innerText.includes('Discarded.') && !d.querySelector('button')})()`, 3000) && await waitFor(`!document.querySelector('#agentlog-log .alog-line')`, 9000), JSON.stringify(await cardsNow()));
  await ev(`document.getElementById('hideright').click()`); await sleep(400);
  check('with nothing waiting the collapsed strip says only Chat', (await stripWord()) === 'Chat', await stripWord());
  await ev(`document.getElementById('rightstrip').click()`); await sleep(400);
  await idle();

  // ------------------------------------------------------------ 5c. the buttons that ask the agent type into Claude Code
  const typedBy = async (clickJs, ms = 30000) => { const before = records().filter(x => x.command).length; await ev(clickJs); return waitRecord(rs => rs.filter(x => x.command)[before], ms); };
  await go('#/module/decrements');
  await ev(`window.__app.setCentre('test')`); await sleep(600);
  check('a module with no module test shows "No module test yet" and a button that asks the agent', await waitFor(`(()=>{const p=document.getElementById('nomoduletest'); return !!p && p.innerText.includes('No module test yet') && !!document.getElementById('askmoduletest')})()`, 10000), await ev(`document.getElementById('codewrap').innerText.slice(0,300)`));
  r = await typedBy(`document.getElementById('askmoduletest').click()`);
  check('the button types its request into Claude Code and sends it, with the module selected', r && /^Propose the module test for decrements with propose_module_test/.test(r.command) && /Selected: module decrements/.test(r.prompt), JSON.stringify(r).slice(0, 400));
  await ev(`window.__app.setCentre('spreadsheet')`); await sleep(300);
  await go('#/tile/units_amc');
  await ev(`window.__app.setCentre('test')`); await sleep(600);
  check('a tile\'s Test view offers "Ask the agent to propose these"', await waitFor(`!!document.getElementById('mt-go')`, 10000));
  r = await typedBy(`(()=>{const s=document.getElementById('moretests'); const b=s.querySelector('input[type=checkbox]'); b.checked=true; b.dispatchEvent(new Event('change',{bubbles:true})); document.getElementById('mt-go').click()})()`);
  check('"Ask the agent to propose these" types a propose_tests request for the tile into Claude Code', r && /^Propose more tests for the tile units_amc with propose_tests\./.test(r.command) && /Selected: tile units_amc/.test(r.prompt), JSON.stringify(r).slice(0, 400));
  await ev(`window.__app.setCentre('spreadsheet')`); await sleep(300);
  r = await typedBy(`document.getElementById('termnew').click()`);
  check('New conversation, above the terminal, types Claude Code\'s own /clear', r && r.command === '/clear', JSON.stringify(r).slice(0, 200));

  // ------------------------------------------------------------ 6. conversations: the dialog, then list, open, delete
  await go('#/model');
  await ev(`document.getElementById('termresume').click()`);
  check('Conversations… opens a list of Claude Code\'s saved conversations, each with its first line, Open and Delete', await waitFor(`(()=>{const r=[...document.querySelectorAll('#chats .chatrow')]; return r.length===2 && r[0].querySelector('.chattitle').textContent==='Build the tile units_eop' && r[1].querySelector('.chattitle').textContent==='Lay out the decrements tiles' && r.every(x=>!!x.querySelector('[data-act=open]') && !!x.querySelector('[data-act=delete]')) && /2 messages/.test(r[1].innerText)})()`, 10000), await ev(`(document.getElementById('dialog')||{innerText:''}).innerText.slice(0,400)`));
  await shot('terminal-conversations');
  await ev(`document.querySelector('#chats .chatrow[data-id="${OLD}"] [data-act=delete]').click()`);
  check('Delete asks once more before anything goes', await ev(`!!document.querySelector('#chats [data-act=reallydelete]') && !!document.querySelector('#chats [data-act=keep]')`) && fs.existsSync(path.join(convDir, OLD + '.jsonl')));
  await ev(`document.querySelector('#chats [data-act=keep]').click()`);
  check('Keep puts Open and Delete back and deletes nothing', await ev(`!document.querySelector('#chats [data-act=reallydelete]') && document.querySelectorAll('#chats [data-act=delete]').length===2`) && fs.existsSync(path.join(convDir, OLD + '.jsonl')));
  await ev(`document.getElementById('confirm').click()`);
  check('Done closes the list', await waitFor(`!document.getElementById('dialog')`, 5000));
  await ev(`document.getElementById('termresume').click()`);
  await waitFor(`document.querySelectorAll('#chats .chatrow').length===2`, 10000);
  const startsAtOpen = starts().length;
  await ev(`document.querySelector('#chats .chatrow[data-id="${OLD}"] [data-act=open]').click()`);
  const openedByList = await waitRecord(() => starts()[startsAtOpen], 30000);
  check('Open in the list starts Claude Code again on that conversation and closes the list', !!openedByList && argAfter(openedByList.argv, '--resume') === OLD && await waitFor(`!document.getElementById('dialog')`, 8000), JSON.stringify(openedByList && openedByList.argv.slice(0, 3)));
  await waitRecord(rs => rs.filter(x => x.initialized).length >= 2, 30000);
  let list = await termApi('sessions()');
  check('Conversations lists Claude Code\'s saved conversations for this model, newest first', list.ok && list.ok.length === 2 && list.ok[0].id === NEW && list.ok[0].title === 'Build the tile units_eop' && list.ok[1].title === 'Lay out the decrements tiles' && list.ok[1].messages === 2, JSON.stringify(list));
  const startsBefore = starts().length;
  list = await termApi(`openSession(${JSON.stringify(OLD)})`);
  const reopened = await waitRecord(() => starts()[startsBefore], 30000);
  check('Open restarts Claude Code on that conversation', !!reopened && argAfter(reopened.argv, '--resume') === OLD, JSON.stringify(reopened && reopened.argv.slice(0, 3)));
  check('the opened conversation is marked as the one in the pane', list.ok && list.ok.find(c => c.id === OLD).current === true && !list.ok.find(c => c.id === NEW).current, JSON.stringify(list));
  await waitRecord(rs => rs.filter(x => x.initialized).length >= 3, 30000);
  r = await type('call model_overview');
  check('the tools work in the reopened conversation', r && r.session === OLD && !r.isError && r.text.length > 50, JSON.stringify(r).slice(0, 300));
  list = await termApi(`deleteSession('../../settings')`);
  check('deleting something that is not a conversation is refused', /Unknown conversation/.test(list.error || ''), JSON.stringify(list));
  list = await termApi(`deleteSession(${JSON.stringify(NEW)})`);
  check('Delete removes that conversation\'s transcript and leaves the other', list.ok && list.ok.length === 1 && list.ok[0].id === OLD && !fs.existsSync(path.join(convDir, NEW + '.jsonl')) && fs.existsSync(path.join(convDir, OLD + '.jsonl')), JSON.stringify(list));
  const startsThen = starts().length;
  list = await termApi(`deleteSession(${JSON.stringify(OLD)})`);
  const fresh = await waitRecord(() => starts()[startsThen], 30000);
  check('deleting the conversation in the pane removes it and starts a new one', list.ok && list.ok.length === 0 && !fs.existsSync(path.join(convDir, OLD + '.jsonl')) && !!fresh && !fresh.argv.includes('--resume') && !fresh.argv.includes('--continue'), JSON.stringify([list, fresh && fresh.argv.slice(0, 3)]));
  check('deleting a conversation leaves the model\'s review record alone', fs.existsSync(path.join(copy, 'review', 'model')) && /terminal_test_loading/.test(fs.readFileSync(paramsFile, 'utf8')));

  check('the stand-in never crashed', !records().some(x => x.crashed || x.failed), JSON.stringify(records().filter(x => x.crashed || x.failed)).slice(0, 400));
  check('no console errors before the model was broken on purpose', consoleBefore === 0, JSON.stringify(summary.errors.slice(0, 5)));
  summary.turns = turns;
  finish(0);
})().catch(e => { summary.errors.push(String(e && e.stack || e)); finish(1); });
app.on('window-all-closed', () => {});
