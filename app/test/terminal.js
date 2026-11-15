'use strict';
// Test of Claude Code in the chat pane (the terminal mode the app normally runs in), without calling a model.
// The app is started with the pane on and a stand-in for the Claude Code program (test/fake-claude.js), which starts
// the app's real bridge (src/agent/cli-bridge.js) as its MCP server and runs the app's real hooks. So this covers:
// what Claude Code is started with, the bridge and its token, the tool list, the selection line and the note after a
// restart, tool calls, a draft raised from the terminal and approved in the centre pane (one accept that fails, one
// that works), and the Conversations list (list, open, delete).
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

  ctl = await require('../src/main').start({ show: true, terminal: true, settingsFile: path.join(tmp, 'settings.json'), modelDir: copy });
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
  check('the window is in terminal mode', await ev('!!(window.api && window.api.term)'));
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
  check('the tools that only the app\'s own chat can show are left out', !names.includes('ask_user') && !names.includes('add_input_request'), names.join(', '));
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
  check('a hidden tool cannot be called', r && r.isError && /There is no tool ask_user/.test(r.text), JSON.stringify(r).slice(0, 300));

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

  // ------------------------------------------------------------ 6. conversations: list, open, delete
  let list = await termApi('sessions()');
  check('Conversations lists Claude Code\'s saved conversations for this model, newest first', list.ok && list.ok.length === 2 && list.ok[0].id === NEW && list.ok[0].title === 'Build the tile units_eop' && list.ok[1].title === 'Lay out the decrements tiles' && list.ok[1].messages === 2, JSON.stringify(list));
  const startsBefore = starts().length;
  list = await termApi(`openSession(${JSON.stringify(OLD)})`);
  const reopened = await waitRecord(() => starts()[startsBefore], 30000);
  check('Open restarts Claude Code on that conversation', !!reopened && argAfter(reopened.argv, '--resume') === OLD, JSON.stringify(reopened && reopened.argv.slice(0, 3)));
  check('the opened conversation is marked as the one in the pane', list.ok && list.ok.find(c => c.id === OLD).current === true && !list.ok.find(c => c.id === NEW).current, JSON.stringify(list));
  await waitRecord(rs => rs.filter(x => x.initialized).length >= 2, 30000);
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
