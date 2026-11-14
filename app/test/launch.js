'use strict';
// The launch page, New model, Add existing folder, git, the real-data folder and switching models.
// Real tilekit, a real agent service (no model calls), and LOCAL bare git repositories standing in for GitHub.
// Run from app/: ./node_modules/.bin/electron test/launch.js
process.env.APP_NO_AUTOSTART = '1';
process.env.APP_ALLOW_LOCAL_REMOTE = '1';        // the real dialog accepts only GitHub links
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const REPO = path.resolve(__dirname, '../..');
const REAL_MODEL = path.join(REPO, 'model');
const cacheBeforeFile = path.join(REAL_MODEL, 'review', '.cache', 'content.json');
const cacheBefore = (() => { try { const st = fs.statSync(cacheBeforeFile); return st.size + ':' + st.mtimeMs; } catch { return 'absent'; } })();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-launch-')));
// git for the tests: no user or system configuration, a fixed identity
process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_NOSYSTEM = '1';
Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const uv = require('../src/tilekit').findUv();

// ---- the GitHub command-line tool for the tests: test/fake-gh.js behind a wrapper script, never the real `gh`
const ghDir = path.join(tmp, 'fake-gh');
fs.mkdirSync(path.join(ghDir, 'repos'), { recursive: true });
const ghState = s => fs.writeFileSync(path.join(ghDir, 'state.json'), JSON.stringify({ signedIn: true, login: 'ada-test', orgs: ['acme-actuarial', 'north-re'], ...s }));
ghState({});
const ghBin = path.join(ghDir, 'gh');
fs.writeFileSync(ghBin, `#!/bin/sh\nFAKE_GH_DIR='${ghDir}' ELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${path.join(__dirname, 'fake-gh.js')}' "$@"\n`, { mode: 0o755 });
process.env.APP_GH_BIN = ghBin;
const ghCalls = () => { try { return fs.readFileSync(path.join(ghDir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).args); } catch { return []; } };
const ghCreates = () => ghCalls().filter(c => c[0] === 'repo' && c[1] === 'create');
const ghRepo = full => path.join(ghDir, 'repos', full + '.git');

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
const check = (name, ok, detail) => { summary.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); };

// ---- the "GitHub" side: bare repositories in the temporary folder
const bare = name => { const d = path.join(tmp, 'remotes', name + '.git'); fs.mkdirSync(d, { recursive: true }); git(d, 'init', '--bare', '-b', 'main'); return d; };
function seedRemote(bareDir, files) {            // put one commit with `files` into a bare repository
  const w = path.join(tmp, 'seed-' + path.basename(bareDir));
  fs.mkdirSync(w, { recursive: true });
  git(w, 'init', '-b', 'main');
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(w, f)), { recursive: true }); fs.writeFileSync(path.join(w, f), text); }
  git(w, 'add', '-A'); git(w, 'commit', '-m', 'Seed');
  git(w, 'push', bareDir, 'main');
}
const remoteLog = (bareDir, branch = 'main') => { try { return git(bareDir, 'log', branch, '--format=%s').split('\n').filter(Boolean); } catch { return []; } };

function copyExample(dst) {
  const skip = /(^|\/)(\.venv|__pycache__|real-data|\.pytest_cache)(\/|$)/;
  fs.cpSync(REAL_MODEL, dst, { recursive: true, filter: src => !skip.test(path.relative(REAL_MODEL, src).split(path.sep).join('/')) });
}

(async () => {
  // model A: a copy of the example in its own repository, with a local bare remote it is already pushed to
  const A = path.join(tmp, 'models', 'unit-linked');
  copyExample(A);
  const remoteA = bare('unit-linked');
  git(A, 'init', '-b', 'main'); git(A, 'remote', 'add', 'origin', remoteA); git(A, 'add', '-A'); git(A, 'commit', '-m', 'Start'); git(A, 'push', '-u', 'origin', 'main');
  check('setup: the model .gitignore keeps chat logs and real data out of the repo', /real-data\//.test(fs.readFileSync(path.join(A, '.gitignore'), 'utf8')) && git(A, 'ls-files').split('\n').every(f => !/log\.jsonl$|chat\.jsonl$/.test(f)));

  const picks = [];
  const settingsFile = path.join(tmp, 'settings.json');
  ctl = await require('../src/main').start({ show: true, settingsFile, pickFolder: async () => picks.shift() || null });
  const win = ctl.win;
  const onConsole = (...a) => { const m = a[0] && a[0].message !== undefined ? a[0] : { level: a[1], message: a[2] }; if (m.level === 'error' || m.level === 3) summary.errors.push('console: ' + String(m.message).slice(0, 300)); };
  win.webContents.on('console-message', onConsole);
  win.webContents.on('will-prevent-unload', e => e.preventDefault());
  const ev = js => win.webContents.executeJavaScript(js, true);
  const waitFor = async (js, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await ev(js); if (v) return v; } catch { /* retry */ } await sleep(100); } return false; };
  const shot = async name => { await sleep(400); const img = await win.webContents.capturePage(); const f = path.join(OUT, name + '.png'); fs.writeFileSync(f, img.toPNG()); summary.shots.push(f); };
  const idle = async () => { await ev('window.__app.idle()'); await waitFor('document.getElementById("working").hidden', 60000); await ev('window.__app.idle()'); };
  const onLaunch = () => waitFor(`window.__app && window.__app.ready && location.hash==='#/launch' && !!document.getElementById('newmodel')`, 30000);
  const onModel = async name => { const ok = await waitFor(`window.__app && window.__app.ready && location.hash==='#/model' && document.getElementById('title') && document.getElementById('title').textContent.includes(${JSON.stringify(name)})`, 90000); if (ok) await idle(); return ok; };
  const tiles = () => ev(`[...document.querySelectorAll('.mtile[data-id]')].map(t => ({ id: t.dataset.id, name: t.querySelector('.mname').textContent, dir: t.querySelector('.mdir').textContent, link: t.querySelector('.mlink').textContent, git: t.querySelector('.mgit').textContent, review: t.querySelector('.mreview').textContent, opened: t.querySelector('.mopened').textContent }))`);
  const tileOf = async name => (await tiles()).find(t => t.name === name);
  const waitTile = async (name, pred, ms = 90000) => { const t0 = Date.now(); let t; while (Date.now() - t0 < ms) { t = await tileOf(name).catch(() => null); if (t && pred(t)) return t; await sleep(200); } return t || null; };
  const setVal = (id, v) => ev(`(()=>{const n=document.getElementById(${JSON.stringify(id)}); n.value=${JSON.stringify(v)}; n.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const dialogText = () => ev(`document.getElementById('dialog') ? document.getElementById('dialog').innerText : ''`);
  const cancel = async () => { await ev(`document.getElementById('cancel') && document.getElementById('cancel').click()`); await waitFor(`!document.getElementById('dialog')`, 5000); };
  const clickBtn = (name, act) => ev(`[...document.querySelectorAll('.mtile[data-id]')].find(t => t.querySelector('.mname').textContent===${JSON.stringify(name)}).closest('.mcell').querySelector('button[data-act=${act}]').click()`);
  const settingsOnDisk = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const chatLines = () => ev(`[...document.querySelectorAll('#agentlog-log .alog-line:not(.alog-working)')].map(l => l.querySelector('.alog-txt').innerText)`);

  // The example model's status cache may already exist (the real app writes it once the model has been opened).
  // What matters is that the launch page neither creates nor changes it.
  const cacheState = () => { const f = path.join(REAL_MODEL, 'review', '.cache', 'content.json'); try { const st = fs.statSync(f); return st.size + ':' + st.mtimeMs; } catch { return 'absent'; } };
  // ------------------------------------------------------------ 1. start: the launch page, with the example model on the first launch
  check('start with no model: the window is on #/launch and no model is open', await onLaunch() && ctl.cfg.modelDir === null);
  check('launch: top bar has the logo and Tessera and no module or tile rows', await ev(`!!document.querySelector('#topbar #logo') && document.getElementById('brand').textContent==='Tessera' && getComputedStyle(document.getElementById('mods')).display==='none' && getComputedStyle(document.getElementById('tiles')).display==='none' && getComputedStyle(document.getElementById('modelname')).display==='none'`));
  let ts = await tiles();
  check('first launch with an empty list adds the example model, named from its tilekit.toml, with no GitHub link', ts.length === 1 && ts[0].name === 'Unit-linked pricing' && ts[0].dir === REAL_MODEL && /no GitHub link/.test(ts[0].link), JSON.stringify(ts));
  const ex = await waitTile('Unit-linked pricing', t => /tiles signed off|could not read/.test(t.review) && !/Checking/.test(t.git));
  check('the example tile fills in its review progress in words', ex && /^\d+ of 26 tiles signed off/.test(ex.review), JSON.stringify(ex));
  check('the example model lives inside this repository, so the tile says it has no repository of its own', ex && /not a git repository of its own/.test(ex.git), JSON.stringify(ex));
  check('the example model has not been opened or written to by the launch page', cacheState() === cacheBefore && ctl.cfg.modelDir === null);
  check('a new tile is dashed and last, with Add existing folder… beside it', await ev(`(()=>{const c=[...document.querySelectorAll('#models .mcell')]; const last=c[c.length-1]; return !!last.querySelector('#newmodel') && getComputedStyle(last.querySelector('#newmodel')).borderStyle.includes('dashed') && !!last.querySelector('#addfolder')})()`));
  check('the example is in the settings file list', settingsOnDisk().models.length === 1 && settingsOnDisk().models[0].dir === REAL_MODEL);

  // remove it (the folder stays), via the plain confirmation
  await clickBtn('Unit-linked pricing', 'remove');
  check('Remove from list: the confirmation says the folder is not deleted', await waitFor(`!!document.getElementById('dialog')`, 5000) && /not deleted/.test(await dialogText()), await dialogText());
  await cancel();
  check('Remove from list: Cancel keeps the tile', (await tiles()).length === 1);
  await clickBtn('Unit-linked pricing', 'remove');
  await waitFor(`!!document.getElementById('confirm')`, 5000);
  await ev(`document.getElementById('confirm').click()`);
  check('Remove from list: the tile and the list entry go, the folder stays', await waitFor(`document.querySelectorAll('.mtile[data-id]').length===0`, 8000) && settingsOnDisk().models.length === 0 && fs.existsSync(path.join(REAL_MODEL, 'tilekit.toml')));

  // ------------------------------------------------------------ 2. Add existing folder
  const notModel = path.join(tmp, 'models', 'plain-folder'); fs.mkdirSync(notModel, { recursive: true });
  picks.push(notModel);
  await ev(`document.getElementById('addfolder').click()`);
  check('Add existing folder: a folder without tilekit.toml is refused plainly', await waitFor(`/no tilekit\\.toml/.test(document.getElementById('launchmsg').innerText)`, 8000), await ev(`document.getElementById('launchmsg').innerText`));
  picks.push(A);
  await ev(`document.getElementById('addfolder').click()`);
  const a1 = await waitTile('Unit-linked pricing', t => /tiles signed off/.test(t.review) && !/Checking/.test(t.git));
  check('Add existing folder: the model is registered with its name and its GitHub link from `git remote get-url origin`', a1 && a1.dir === A && a1.link === remoteA, JSON.stringify(a1));
  check('git state on the tile: branch and "clean"', a1 && a1.git === 'main: clean', a1 && a1.git);
  check('review progress on the tile', a1 && /^\d+ of 26 tiles signed off(, \d+ stale)?$/.test(a1.review), a1 && a1.review);
  check('"last opened" says not opened yet', a1 && /Not opened yet/.test(a1.opened), a1 && a1.opened);
  picks.push(A);
  await ev(`document.getElementById('addfolder').click()`);
  check('Add existing folder: the same folder twice gives one tile', await waitFor(`/already in the list/.test(document.getElementById('launchmsg').innerText)`, 8000) && (await tiles()).length === 1);

  // link validation (the same check the dialog uses)
  const accepted = [];
  for (const l of ['https://github.com/octo/repo', 'https://github.com/octo/repo.git', 'git@github.com:octo/repo.git', 'https://gitlab.com/octo/repo', 'http://github.com/octo/repo', 'https://github.com/octo', 'octo/repo', '']) accepted.push((await ev(`window.api.launch.checkLink(${JSON.stringify(l)})`)).ok);
  check('links: the three GitHub shapes are accepted, other shapes refused', JSON.stringify(accepted) === JSON.stringify([true, true, true, false, false, false, false, false]), JSON.stringify(accepted));

  // ------------------------------------------------------------ 3. New model, empty repository
  const remoteEmpty = bare('empty-one');
  const newParent = path.join(tmp, 'models'); // not empty: the model goes in a subfolder named from the name
  picks.push(newParent);
  await ev(`document.getElementById('newmodel').click()`);
  await waitFor(`!!document.getElementById('f-name')`, 5000);
  check('New model: three fields (name, local folder with Choose…, GitHub link), Create disabled', await ev(`!!document.getElementById('f-folder') && !!document.getElementById('pickfolder') && !!document.getElementById('f-github') && document.getElementById('confirm').disabled`));
  await ev(`document.getElementById('pickfolder').click()`);
  check('New model: Choose… fills the folder', await waitFor(`document.getElementById('f-folder').value===${JSON.stringify(newParent)}`, 5000));
  await setVal('f-name', 'Empty one'); await setVal('f-github', 'https://example.org/x/y');
  await shot('launch-new-model-dialog');
  await ev(`document.getElementById('confirm').click()`);
  check('New model: a link that is not a GitHub link is refused plainly, nothing is created', await waitFor(`/not a GitHub link/.test(document.getElementById('dialogerrors').innerText)`, 8000) && !fs.existsSync(path.join(newParent, 'empty-one')));
  await setVal('f-github', path.join(tmp, 'remotes', 'nowhere.git'));
  await ev(`document.getElementById('confirm').click()`);
  check('New model: a repository that does not exist is reported plainly and nothing is left behind', await waitFor(`/not found|could not/i.test(document.getElementById('dialogerrors').innerText)`, 20000) && !fs.existsSync(path.join(newParent, 'empty-one')), await dialogText());
  await setVal('f-github', remoteEmpty);
  await ev(`window.__old = true`);
  await ev(`document.getElementById('confirm').click()`).catch(() => {});
  check('New model (empty repository): the model is created and opened', await waitFor(`!window.__old && window.__app && window.__app.ready && location.hash==='#/model'`, 120000), await dialogText().catch(() => ''));
  await onModel('Empty one');
  const B = path.join(newParent, 'empty-one');
  check('New model (empty repository): created in a new subfolder named from the model name, with tilekit.toml and .gitignore', fs.existsSync(path.join(B, 'tilekit.toml')) && /real-data\//.test(fs.readFileSync(path.join(B, '.gitignore'), 'utf8')));
  check('New model (empty repository): git init on main, origin is the link, one local commit "Start Empty one"', git(B, 'branch', '--show-current') === 'main' && git(B, 'remote', 'get-url', 'origin') === remoteEmpty && git(B, 'log', '--format=%s') === 'Start Empty one');
  check('New model (empty repository): nothing was pushed', remoteLog(remoteEmpty).length === 0);
  check('New model (empty repository): the chat input holds the scaffolding request, the conversation is empty', await ev(`document.getElementById('agentlog-input').value`) === 'Scaffold this model with me. Ask me what you need to know.' && (await chatLines()).length === 0);
  check('New model (empty repository): registered in the list with its GitHub link', settingsOnDisk().models.some(m => m.dir === B && m.github === remoteEmpty && m.name === 'Empty one'));
  check('the header shows the model name as a link back to the launch page', await ev(`document.getElementById('modelname').textContent==='Empty one' && document.getElementById('modelname').getAttribute('href')==='#/launch'`));

  // the tooling runs from the app's own environment against a fresh init model
  const T = {};
  for (const c of ['graph', 'status', 'build', 'test']) { try { T[c] = await ctl.run(c); } catch (e) { T[c] = { error: e.message }; } }
  check('tooling from the app environment on a fresh `tilekit init` model: graph, status, build', T.graph.model && T.graph.model.name === 'Empty one' && T.status.model && T.build.built && !T.build.error, JSON.stringify([T.graph.error, T.status.error, T.build.error]));
  check('tooling from the app environment: `test` runs the new model\'s pytest (its package is found through <model>/src)', T.test.passed >= 1 && T.test.failed === 0, JSON.stringify(T.test).slice(0, 300));
  const { defaultPytest } = require('../src/agent');
  const pt = await defaultPytest({ modelDir: B, project: path.join(REPO, 'tilekit') })('tests/test_model.py');
  check('the agent\'s own pytest runs from the app environment on the fresh model', pt.passed, pt.output);

  // ------------------------------------------------------------ 4. header link, tiles, switching between models
  await ev(`document.getElementById('modelname').click()`);
  check('the model name in the top bar goes back to the launch page', await onLaunch());
  ts = await tiles();
  check('launch: the new model is a tile too (two tiles), "last opened" is a date', ts.length === 2 && /Last opened \d{4}-\d{2}-\d{2}/.test((await tileOf('Empty one')).opened), JSON.stringify(ts));
  const tb = await waitTile('Empty one', t => /no tiles yet/.test(t.review) && /commit/.test(t.git));
  check('tile for an empty model: "no tiles yet" and "1 commit not pushed" (no upstream yet)', tb && /no tiles yet/.test(tb.review) && /^main: (\d+ files changed, )?1 commit not pushed$/.test(tb.git), JSON.stringify(tb));

  // New model: non-empty repository that is a model
  const remoteFull = bare('seeded');
  execFileSync(uv, ['run', '--project', path.join(REPO, 'tilekit'), 'tilekit', 'init', '--model', path.join(tmp, 'seedmodel'), '--name', 'Seeded model'], { encoding: 'utf8', env: { ...process.env } });
  fs.rmSync(path.join(tmp, 'seedmodel', '.venv'), { recursive: true, force: true });
  seedRemote(remoteFull, Object.fromEntries(['tilekit.toml', 'pyproject.toml', 'cases/base.json', 'src/seeded_model/params.py', 'src/seeded_model/inputs.py', 'src/seeded_model/__init__.py'].map(f => [f, fs.readFileSync(path.join(tmp, 'seedmodel', f), 'utf8')])));
  const remoteOther = bare('not-a-model'); seedRemote(remoteOther, { 'README.md': 'hello\n' });
  const parent2 = path.join(tmp, 'clones'); fs.mkdirSync(parent2);
  picks.push(parent2);
  await ev(`document.getElementById('newmodel').click()`);
  await waitFor(`!!document.getElementById('f-name')`, 5000);
  await ev(`document.getElementById('pickfolder').click()`);
  await setVal('f-name', 'Some other'); await setVal('f-github', remoteOther);
  await ev(`document.getElementById('confirm').click()`);
  check('New model (non-empty repository without tilekit.toml): says it is not a Tessera model and where the clone is', await waitFor(`/not a Tessera model \\(no tilekit\\.toml\\)/.test(document.getElementById('dialogerrors').innerText)`, 60000) && (await dialogText()).includes(path.join(parent2)), await dialogText());
  check('New model: that clone is left in place and the model is not registered', fs.existsSync(path.join(parent2, 'README.md')) && !settingsOnDisk().models.some(m => m.dir === parent2));
  await setVal('f-github', remoteFull); await setVal('f-name', 'Seeded model');
  await ev(`window.__old = true`);
  await ev(`document.getElementById('confirm').click()`).catch(() => {});
  // the folder chosen is no longer empty (it holds the earlier clone): the model goes in a subfolder
  const opened = await waitFor(`!window.__old && window.__app && window.__app.ready && location.hash==='#/model'`, 120000);
  check('New model (non-empty repository with tilekit.toml): cloned, registered and opened', opened && await onModel('Seeded model'), await dialogText().catch(() => ''));
  const C = path.join(parent2, 'seeded-model');
  check('New model (non-empty repository): the clone is in the subfolder and has the remote as origin', fs.existsSync(path.join(C, '.git')) && git(C, 'remote', 'get-url', 'origin') === remoteFull);
  check('New model (non-empty repository): the chat is not prefilled (no scaffolding)', await ev(`document.getElementById('agentlog-input').value`) === '');

  // ------------------------------------------------------------ 5. switching re-points everything, including the conversation
  await ev(`location.hash='#/launch'`); await onLaunch();
  check('three tiles now', (await tiles()).length === 3);
  await shot('launch-three-models');
  await ev(`document.querySelector('.mtile[data-id="${(await tileOf('Unit-linked pricing')).id}"]').click()`);
  check('clicking a tile opens that model (model A)', await onModel('Unit-linked pricing') && ctl.cfg.modelDir === A);
  await ctl.agent.handlersFor({ level: 'model', id: 'model' }).ask_user({ question: 'Question in model A?' });
  check('model A: its conversation shows its own question', await waitFor(`document.getElementById('agentlog-log').innerText.includes('Question in model A?')`, 8000));
  check('model A: the tooling points at A (status has 26 tiles) and the watcher/agent are A\'s', (await ctl.run('status')).counts.tiles.total === 26 && fs.existsSync(path.join(A, 'review/model/chat.jsonl')));
  await ev(`location.hash='#/launch'`); await onLaunch();
  await ev(`document.querySelector('.mtile[data-id="${(await tileOf('Seeded model')).id}"]').click()`);
  check('switch to the seeded model: the window reloads on it', await onModel('Seeded model') && ctl.cfg.modelDir === C);
  check('switch: the chat shows no conversation of model A', !(await chatLines()).some(l => /Question in model A/.test(l)), JSON.stringify(await chatLines()));
  check('switch: the tooling runner now points at the seeded model', (await ctl.run('graph')).model.name === 'Seeded model');
  await ctl.agent.handlersFor({ level: 'model', id: 'model' }).ask_user({ question: 'Question in the seeded model?' });
  await ev(`location.hash='#/launch'`); await onLaunch();
  await ev(`document.querySelector('.mtile[data-id="${(await tileOf('Unit-linked pricing')).id}"]').click()`);
  await onModel('Unit-linked pricing');
  await waitFor(`document.getElementById('agentlog-log').innerText.includes('Question in model A?')`, 8000);
  const lA = await chatLines();
  check('back on A: only A\'s conversation is shown', lA.some(l => /Question in model A/.test(l)) && !lA.some(l => /seeded model/.test(l)), JSON.stringify(lA));
  check('the seeded model\'s conversation is in its own folder and stays out of git', fs.existsSync(path.join(C, 'review/model/chat.jsonl')) && git(C, 'status', '--porcelain').split('\n').every(l => !/chat\.jsonl|log\.jsonl/.test(l)));

  // ------------------------------------------------------------ 6. real-data folder per model
  const RD = path.join(tmp, 'real-data-A');
  ctl.win.webContents.send('menu', 'modelSettings');
  check('File > Model settings…: the dialog shows the model name (display only), the GitHub link and the real-data folder', await waitFor(`!!document.getElementById('f-realDataDir') && document.getElementById('settingsname')`, 5000) && (await ev(`document.getElementById('settingsname').textContent`)) === 'Unit-linked pricing' && !!(await ev(`document.getElementById('usedefault')`)));
  await shot('launch-settings-dialog');
  picks.push(RD);
  await ev(`document.getElementById('pickrealdata').click()`);
  check('Settings: Choose… fills the real-data folder', await waitFor(`document.getElementById('f-realDataDir').value===${JSON.stringify(RD)}`, 5000));
  await setVal('f-github', 'https://example.com/nope');
  await ev(`document.getElementById('confirm').click()`);
  check('Settings: an invalid GitHub link is refused plainly', await waitFor(`/not a GitHub link/.test(document.getElementById('dialogerrors').innerText)`, 5000));
  await setVal('f-github', remoteA);
  await ev(`document.getElementById('confirm').click()`);
  check('Settings: saved for that model in the app settings', await waitFor(`!document.getElementById('dialog')`, 8000) && settingsOnDisk().models.find(m => m.dir === A).realDataDir === RD);
  await ev(`window.api.tk('sample-portfolio', ['--out', 'real-data/pf.csv', '--policies', '20'])`);
  const runDoc = await ev(`window.api.tk('run', ['--model-points', 'real-data/pf.csv', '--name', 'pf'])`);
  check('real data: the portfolio and the run are stored in the chosen folder', fs.existsSync(path.join(RD, 'pf.csv')) && fs.existsSync(path.join(RD, 'runs', 'pf', 'run.json')) && runDoc.policies === 20);
  check('real data: nothing is written under the model\'s own real-data', !fs.existsSync(path.join(A, 'real-data')));
  const st = await ev(`window.api.tk('status')`);
  check('real data: status and runs read the chosen folder', st.runs.count === 1 && (await ev(`window.api.tk('runs')`)).runs[0].name === 'pf');
  const pol = await ev(`window.api.tk('policies', ['--run', 'pf', '--limit', '3'])`);
  const pid = pol.policies[0].id;
  const built = await ev(`window.api.tk('build', ['--run', 'pf', '--policy', ${JSON.stringify(pid)}, '--whole-model'])`);
  const wbPath = built.built[0].workbook;
  check('real data: the policy workbook is built in the chosen folder and its path comes back absolute', path.isAbsolute(wbPath) && wbPath.startsWith(RD + path.sep) && fs.existsSync(wbPath) && !fs.existsSync(path.join(A, 'real-data')), wbPath);
  await ev(`window.__app.grid.show(${JSON.stringify(wbPath)}, [])`);
  check('real data: the policy workbook opens in the spreadsheet from the chosen folder', await waitFor(`window.__app.grid.current===${JSON.stringify(wbPath)}`, 20000));
  const bytes = await ev(`window.api.readWorkbook(${JSON.stringify(wbPath)}).then(b => b.length)`);
  const bad = await ev(`window.api.readWorkbook(${JSON.stringify(path.join(tmp, 'settings.xlsx'))}).then(() => 'read', e => e.message)`);
  const bad2 = await ev(`window.api.readWorkbook(${JSON.stringify(RD + '/../x.xlsx')}).then(() => 'read', e => e.message)`);
  check('workbook read/write: the real-data folder is allowed, other absolute paths are refused', bytes > 1000 && /not allowed/.test(bad) && /not allowed/.test(bad2), JSON.stringify([bytes, bad, bad2]));
  const w2 = await ev(`window.api.writeWorkbook(${JSON.stringify(path.join(A, 'real-data', 'x.xlsx'))}, new Uint8Array([1])).then(() => 'written', e => e.message)`);
  check('the model\'s own real-data folder is not allowed once another is chosen', /not allowed/.test(w2) && !fs.existsSync(path.join(A, 'real-data')), w2);
  check('another model keeps its own settings: no real-data folder chosen and none created', settingsOnDisk().models.find(m => m.dir === B).realDataDir === '' && !fs.existsSync(path.join(B, 'real-data')));
  // back to the default
  ctl.win.webContents.send('menu', 'modelSettings');
  await waitFor(`!!document.getElementById('usedefault')`, 5000);
  await ev(`document.getElementById('usedefault').click()`);
  await ev(`document.getElementById('confirm').click()`);
  check('Settings: Use the default clears the folder', await waitFor(`!document.getElementById('dialog')`, 8000) && settingsOnDisk().models.find(m => m.dir === A).realDataDir === '');
  check('real data: with the default again the stored run is no longer listed (it lives in the chosen folder)', (await ev(`window.api.tk('runs')`)).runs.length === 0);

  // ------------------------------------------------------------ 7. Commit and push through the dialog, against the local bare remote
  fs.appendFileSync(path.join(A, 'cases', 'base.json'), '\n');
  fs.writeFileSync(path.join(A, 'notes.txt'), 'review notes\n');
  fs.mkdirSync(path.join(A, 'real-data'), { recursive: true }); fs.writeFileSync(path.join(A, 'real-data', 'secret.csv'), 'x\n');
  await ev(`location.hash='#/launch'`); await onLaunch();
  const dirty = await waitTile('Unit-linked pricing', t => /files changed/.test(t.git));
  check('git state on the tile: "2 files changed" (real-data is ignored)', dirty && dirty.git === 'main: 2 files changed', dirty && dirty.git);
  await clickBtn('Unit-linked pricing', 'commit');
  check('Commit dialog: lists the changed files with their state, message field, push ticked', await waitFor(`!!document.getElementById('changedfiles')`, 8000) && /modified\s+cases\/base\.json/.test(await ev(`document.getElementById('changedfiles').innerText`)) && /new\s+notes\.txt/.test(await ev(`document.getElementById('changedfiles').innerText`)) && !(await ev(`document.getElementById('f-message').placeholder === ''`)) && await ev(`document.getElementById('pushafter').checked`), await dialogText());
  check('Commit dialog: placeholder is the example and Commit is disabled until there is a message', await ev(`document.getElementById('f-message').placeholder`) === 'Sign off the unit projection tiles' && await ev(`document.getElementById('confirm').disabled`));
  await setVal('f-message', 'Add review notes');
  await shot('launch-commit-dialog');
  await ev(`document.getElementById('confirm').click()`);
  check('Commit dialog: the outcome is in words', await waitFor(`/Committed 2 files\\./.test(document.getElementById('dialog').innerText) && /Pushed to origin\\/main\\./.test(document.getElementById('dialog').innerText)`, 30000), await dialogText());
  check('Commit and push: the commit is in the remote repository', remoteLog(remoteA)[0] === 'Add review notes', JSON.stringify(remoteLog(remoteA)));
  check('Commit and push: real-data was not committed', !git(A, 'ls-files').includes('real-data'));
  await cancel();
  check('the tile follows: clean again', !!(await waitTile('Unit-linked pricing', t => t.git === 'main: clean', 30000)));
  // a commit with the push unticked leaves it as "1 commit not pushed"
  fs.appendFileSync(path.join(A, 'notes.txt'), 'more\n');
  await clickBtn('Unit-linked pricing', 'commit');
  await waitFor(`!!document.getElementById('f-message')`, 8000);
  await ev(`document.getElementById('pushafter').click()`);
  await setVal('f-message', 'More notes');
  await ev(`document.getElementById('confirm').click()`);
  check('Commit without pushing says so only about the commit', await waitFor(`/Committed 1 file\\./.test(document.getElementById('dialog').innerText) && !/Pushed/.test(document.getElementById('dialog').innerText)`, 20000));
  await cancel();
  const unp = await waitTile('Unit-linked pricing', t => /not pushed/.test(t.git), 30000);
  check('the tile says "1 commit not pushed"', unp && unp.git === 'main: 1 commit not pushed', unp && unp.git);

  // ------------------------------------------------------------ 8. the push card from the chat (the real service, no model call)
  await ev(`document.querySelector('.mtile[data-id="${(await tileOf('Unit-linked pricing')).id}"]').click()`);
  await onModel('Unit-linked pricing');
  const modelScope = { level: 'model', id: 'model' };
  const hh = ctl.agent.handlersFor(modelScope);
  const rp = await hh.request_push();
  check('request_push: the push card appears in the chat with the commit that would go, Push and Not now', !rp.isError && await waitFor(`!!document.querySelector('#agentlog-log .pushcard button[data-act=push]') && !!document.querySelector('#agentlog-log .pushcard button[data-act=decline-push]') && document.querySelector('#agentlog-log .pushcard').innerText.includes('More notes')`, 10000), JSON.stringify(rp));
  check('request_push: nothing is pushed by asking', !remoteLog(remoteA).includes('More notes'));
  await shot('launch-push-card');
  await ev(`document.querySelector('#agentlog-log .pushcard button[data-act=push]').click()`);
  check('the Push button pushes: the commit is in the remote and the card says so', await waitFor(`/Pushed to origin\\/main/.test(document.querySelector('#agentlog-log .pushcard').innerText) && !document.querySelector('#agentlog-log .pushcard button')`, 30000) && remoteLog(remoteA)[0] === 'More notes', JSON.stringify(remoteLog(remoteA)));
  // a card declined with Not now
  fs.appendFileSync(path.join(A, 'notes.txt'), 'third\n');
  const cm = await hh.commit({ message: 'Third notes line' });
  check('the chat commit tool commits locally and says nothing was pushed', !cm.isError && /Committed 1 file/.test(cm.text) && /Nothing was pushed/.test(cm.text) && !remoteLog(remoteA).includes('Third notes line'), cm.text);
  await hh.request_push();
  await waitFor(`document.querySelectorAll('#agentlog-log .pushcard').length===2`, 8000);
  await ev(`document.querySelectorAll('#agentlog-log .pushcard')[1].querySelector('button[data-act=decline-push]').click()`);
  check('Not now: nothing is pushed and the card says Not pushed', await waitFor(`/Not pushed/.test(document.querySelectorAll('#agentlog-log .pushcard')[1].innerText)`, 8000) && !remoteLog(remoteA).includes('Third notes line'));
  check('File > Commit and push… is enabled for the open model', require('electron').Menu.getApplicationMenu().getMenuItemById('commitPush').enabled === true);
  ctl.win.webContents.send('menu', 'commit');
  check('File > Commit and push… opens the dialog for the open model (the unpushed commit can be pushed)', await waitFor(`!!document.getElementById('nochanges') && document.getElementById('confirm').textContent==='Push'`, 8000), await dialogText());
  await ev(`document.getElementById('confirm').click()`);
  check('pushing with nothing to commit pushes the commits', await waitFor(`/Pushed to origin\\/main/.test(document.getElementById('dialog').innerText)`, 30000) && remoteLog(remoteA)[0] === 'Third notes line');
  await cancel();

  // ------------------------------------------------------------ 9. Remove from list, and the guards
  await ev(`location.hash='#/launch'`); await onLaunch();
  await clickBtn('Seeded model', 'remove');
  await waitFor(`!!document.getElementById('confirm')`, 5000);
  await ev(`document.getElementById('confirm').click()`);
  check('Remove from list: the model is gone from the list and its folder is still there', await waitFor(`document.querySelectorAll('.mtile[data-id]').length===2`, 8000) && fs.existsSync(path.join(C, 'tilekit.toml')) && !settingsOnDisk().models.some(m => m.dir === C));
  const unknown = await ev(`window.api.launch.commitInfo('mdeadbeef00').then(() => 'ok', e => e.message)`);
  check('git calls on a folder that is not in the list are refused', /not in the list/.test(unknown), unknown);
  const git2 = require('../src/git');
  const notOwn = path.join(A, 'cases');
  check('git.js: a folder inside a bigger repository is not treated as a repository of its own (commit refused)', (await git2.status(notOwn)).isRepo === false && await git2.commit(notOwn, 'x').then(() => false, e => /not a git repository of its own/.test(e.message)));
  check('git.js: the GitHub link opens only for https://github.com links', git2.webUrl('https://github.com/a/b.git') === 'https://github.com/a/b' && git2.webUrl('git@github.com:a/b.git') === 'https://github.com/a/b' && git2.webUrl(remoteA) === null);

  // ------------------------------------------------------------ 10. New model with a NEW GitHub repository (the fake `gh`)
  const openNew = async () => { await ev(`document.getElementById('newmodel').click()`); await waitFor(`!!document.getElementById('r-create')`, 5000); };
  const ghReady = () => waitFor(`!document.getElementById('r-create').disabled`, 10000);
  const pick = async dir => { picks.push(dir); await ev(`document.getElementById('pickfolder').click()`); await waitFor(`document.getElementById('f-folder').value===${JSON.stringify(dir)}`, 5000); };
  const choose = id => ev(`document.getElementById(${JSON.stringify(id)}).click()`);
  const errText = () => ev(`document.getElementById('dialogerrors').innerText`);
  const visible = id => ev(`(()=>{const n=document.getElementById(${JSON.stringify(id)}); return !!n && n.getClientRects().length>0})()`);
  const apiNew = v => ev(`window.api.launch.newModel(${JSON.stringify(v)}).then(() => 'created', e => e.message)`);

  await openNew();
  check('New model: the repository is a choice of two radio options, "Use an existing repository" selected, the link field shown, the button reads Create', await ev(`document.getElementById('r-existing').type==='radio' && document.getElementById('r-existing').checked && !document.getElementById('r-create').checked && document.getElementById('confirm').textContent==='Create'`) && await visible('f-github') && !(await visible('r-name')) && /Use an existing repository/.test(await dialogText()) && /Create a new repository on GitHub/.test(await dialogText()));
  check('create option: offered once `gh` answers, with the signed-in account first and then the organisations', await ghReady() && JSON.stringify(await ev(`[...document.getElementById('r-owner').options].map(o => o.value)`)) === JSON.stringify(['ada-test', 'acme-actuarial', 'north-re']), await dialogText());
  const createdDir = path.join(tmp, 'created');
  await pick(createdDir);
  await setVal('f-name', 'Term assurance 2026'); await setVal('f-github', 'https://github.com/ada-test/term-assurance');
  await shot('launch-create-existing');
  await setVal('f-github', '');
  await choose('r-create');
  check('create option: the fields appear (owner, name, visibility, description) and the link field goes', await visible('r-owner') && await visible('r-name') && await visible('r-private') && await visible('r-public') && await visible('r-desc') && !(await visible('f-github')));
  check('create option: the repository name is prefilled as a lower-case slug of the model name, the description too, Private is the default', await ev(`document.getElementById('r-name').value`) === 'term-assurance-2026' && await ev(`document.getElementById('r-desc').value`) === 'Tessera model: Term assurance 2026' && await ev(`document.getElementById('r-private').checked && !document.getElementById('r-public').checked`));
  check('create option: one plain line says exactly what will happen', await waitFor(`document.getElementById('r-says').innerText==='Creates ada-test/term-assurance-2026 on GitHub as a private repository. Nothing is pushed to it until you choose to push.'`, 5000), await ev(`document.getElementById('r-says').innerText`));
  check('create option: the button reads "Create repository and model" and is enabled', await ev(`document.getElementById('confirm').textContent==='Create repository and model' && !document.getElementById('confirm').disabled`));
  await shot('launch-create-new');
  check('opening and filling the dialog created nothing', ghCreates().length === 0 && !fs.existsSync(createdDir));

  // an invalid name is refused in the dialog (and by the main process, whatever the window sends)
  await setVal('r-name', 'bad name/x');
  check('create option: an invalid repository name is refused in the dialog (a plain line, the button disabled, no statement)', await waitFor(`!document.getElementById('r-nameerror').hidden && /letters, digits, dashes/.test(document.getElementById('r-nameerror').innerText) && document.getElementById('confirm').disabled`, 5000) && !(await visible('r-says')), await dialogText());
  const refused = [];
  for (const c of [{ owner: 'ada-test', name: 'bad name', visibility: 'private', description: '' }, { owner: 'ada-test', name: 'x.git', visibility: 'private', description: '' }, { owner: 'ada-test', name: 'ok', visibility: 'internal', description: '' },
    { owner: '-x; rm', name: 'ok', visibility: 'private', description: '' }, { owner: 'ada-test', name: 'ok', visibility: 'private', description: 'two\nlines' }, { owner: 'ada-test', name: 'ok', visibility: 'private', description: 'x'.repeat(351) },
    { owner: 'someone-else', name: 'ok', visibility: 'private', description: '' }]) refused.push(await apiNew({ name: 'X', folder: createdDir, create: c }));
  check('main process: invalid name, visibility, owner or description, and an owner that is not the account or its organisations, are all refused with nothing created', refused.every(r => r !== 'created') && /not that account or one of its organisations/.test(refused[6]) && ghCreates().length === 0 && !fs.existsSync(createdDir), JSON.stringify(refused));

  // a name that already exists
  fs.mkdirSync(ghRepo('ada-test/taken'), { recursive: true });
  await setVal('r-name', 'taken');
  await waitFor(`!document.getElementById('confirm').disabled`, 5000);
  await ev(`document.getElementById('confirm').click()`);
  check('create option: a name that already exists is refused plainly, with no `repo create` and no local folder', await waitFor(`/ada-test\\/taken already exists on GitHub\\. Nothing was created/.test(document.getElementById('dialogerrors').innerText)`, 20000) && ghCreates().length === 0 && !fs.existsSync(createdDir), await dialogText());

  // create a private repository
  await setVal('r-name', 'term-assurance-2026');
  await waitFor(`!document.getElementById('confirm').disabled`, 5000);
  await ev(`window.__old = true`);
  await ev(`document.getElementById('confirm').click()`).catch(() => {});
  const sawProgress = await waitFor(`/tilekit init/.test(document.getElementById('dialogprogress') ? document.getElementById('dialogprogress').innerText : '')`, 30000);
  if (sawProgress) { const img = await win.webContents.capturePage(); const f = path.join(OUT, 'launch-create-progress.png'); fs.writeFileSync(f, img.toPNG()); summary.shots.push(f); }
  const progressText = sawProgress ? await ev(`document.getElementById('dialogprogress') ? document.getElementById('dialogprogress').innerText : ''`).catch(() => '') : '';
  check('create: each step is reported in words while it runs', /Checking that ada-test\/term-assurance-2026 is free on GitHub…/.test(progressText) && /Creating the private repository ada-test\/term-assurance-2026 on GitHub…/.test(progressText) && /Created ada-test\/term-assurance-2026\. It is empty\./.test(progressText), progressText);
  check('create (private): the model is created and opened', await waitFor(`!window.__old && window.__app && window.__app.ready && location.hash==='#/model'`, 120000) && await onModel('Term assurance 2026'), await dialogText().catch(() => ''));
  const mk = ghCreates();
  check('create (private): exactly one `repo create`, with the owner, name, --private and the description, and no --source, --push or --clone', mk.length === 1 && JSON.stringify(mk[0]) === JSON.stringify(['repo', 'create', 'ada-test/term-assurance-2026', '--private', '--description', 'Tessera model: Term assurance 2026']), JSON.stringify(mk));
  const newBare = ghRepo('ada-test/term-assurance-2026');
  check('create (private): the model exists locally on main with one commit "Start Term assurance 2026" and origin is the new repository', fs.existsSync(path.join(createdDir, 'tilekit.toml')) && git(createdDir, 'branch', '--show-current') === 'main' && git(createdDir, 'remote', 'get-url', 'origin') === newBare && git(createdDir, 'log', '--format=%s') === 'Start Term assurance 2026');
  check('create (private): nothing was pushed (the new repository has no commits)', fs.existsSync(path.join(newBare, 'HEAD')) && remoteLog(newBare).length === 0 && git(newBare, 'for-each-ref') === '');
  check('create (private): the chat input holds the scaffolding request', await ev(`document.getElementById('agentlog-input').value`) === 'Scaffold this model with me. Ask me what you need to know.');
  check('create (private): registered in the list with the new repository as its link', settingsOnDisk().models.some(m => m.dir === createdDir && m.github === newBare && m.name === 'Term assurance 2026'));

  // public, owned by an organisation
  await ev(`location.hash='#/launch'`); await onLaunch();
  await openNew(); await ghReady();
  const publicDir = path.join(tmp, 'created-public');
  await pick(publicDir);
  await setVal('f-name', 'Public one');
  await choose('r-create');
  await ev(`(()=>{const o=document.getElementById('r-owner'); o.value='acme-actuarial'; o.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await choose('r-public');
  check('create (public): the line follows the owner and the visibility', await waitFor(`document.getElementById('r-says').innerText==='Creates acme-actuarial/public-one on GitHub as a public repository. Nothing is pushed to it until you choose to push.'`, 5000), await ev(`document.getElementById('r-says').innerText`));
  await ev(`window.__old = true`);
  await ev(`document.getElementById('confirm').click()`).catch(() => {});
  check('create (public): the model is created and opened', await waitFor(`!window.__old && window.__app && window.__app.ready && location.hash==='#/model'`, 120000) && await onModel('Public one'), await dialogText().catch(() => ''));
  check('create (public): one more `repo create`, with --public and the organisation as owner', ghCreates().length === 2 && JSON.stringify(ghCreates()[1]) === JSON.stringify(['repo', 'create', 'acme-actuarial/public-one', '--public', '--description', 'Tessera model: Public one']) && git(publicDir, 'remote', 'get-url', 'origin') === ghRepo('acme-actuarial/public-one') && remoteLog(ghRepo('acme-actuarial/public-one')).length === 0, JSON.stringify(ghCreates()));

  // a failure after the repository was created: git cannot start the local repository (a broken git configuration)
  await ev(`location.hash='#/launch'`); await onLaunch();
  await openNew(); await ghReady();
  const failDir = path.join(tmp, 'created-failing');
  await pick(failDir);
  await setVal('f-name', 'Failing one');
  await choose('r-create');
  await waitFor(`!document.getElementById('confirm').disabled`, 5000);
  const brokenConfig = path.join(tmp, 'broken.gitconfig'); fs.writeFileSync(brokenConfig, '[broken\n');
  process.env.GIT_CONFIG_GLOBAL = brokenConfig;
  await ev(`document.getElementById('confirm').click()`);
  const failed = await waitFor(`/was created on GitHub/.test(document.getElementById('dialogerrors').innerText)`, 60000);
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  const failText = await errText();
  check('failure after creation: says the repository was created and is empty, what failed, and to retry with "Use an existing repository" and its link', failed && failText.includes('The repository ada-test/failing-one was created on GitHub and is empty') && /git could not start the local repository/.test(failText) && failText.includes('choose "Use an existing repository" and give its link: ' + ghRepo('ada-test/failing-one')), failText);
  check('failure after creation: no local folder is left, the repository is not deleted, the model is not registered', !fs.existsSync(failDir) && fs.existsSync(path.join(ghRepo('ada-test/failing-one'), 'HEAD')) && !settingsOnDisk().models.some(m => m.dir === failDir) && ghCreates().length === 3);
  check('failure after creation: the dialog is back on "Use an existing repository" with the new repository\'s link, so the next press cannot create another', await ev(`document.getElementById('r-existing').checked && document.getElementById('confirm').textContent==='Create'`) && await ev(`document.getElementById('f-github').value`) === ghRepo('ada-test/failing-one'));
  await shot('launch-create-failure');
  check('failure after creation: nothing is retried without the button', (await sleep(1500), ghCreates().length === 3));
  await cancel();

  // `gh` signed out: the option is there but disabled, with the reason; the existing-repository option still works
  ghState({ signedIn: false });
  await openNew();
  check('gh signed out: the create option is visible but disabled, with the plain line saying why and what to do', await waitFor(`/You are not signed in to GitHub in the command-line tool\\. Run \`gh auth login\` in a terminal\\./.test(document.getElementById('r-note').innerText)`, 10000) && await ev(`document.getElementById('r-create').disabled && document.getElementById('r-existing').checked`) && await visible('r-create') && !(await visible('r-name')), await dialogText());
  await choose('r-create');
  check('gh signed out: clicking the disabled option changes nothing', await ev(`document.getElementById('r-existing').checked && document.getElementById('confirm').textContent==='Create'`));
  const so = await apiNew({ name: 'X', folder: path.join(tmp, 'nope'), create: { owner: 'ada-test', name: 'nope', visibility: 'private', description: '' } });
  check('gh signed out: the main process refuses to create as well', /not signed in to GitHub/.test(so) && ghCreates().length === 3 && !fs.existsSync(path.join(tmp, 'nope')), so);
  await cancel();
  ghState({});

  // `gh` missing
  process.env.APP_GH_BIN = path.join(tmp, 'no-such-gh');
  await openNew();
  check('gh missing: the create option is visible but disabled, with "The GitHub command-line tool is not installed."', await waitFor(`document.getElementById('r-note').innerText==='The GitHub command-line tool is not installed.'`, 10000) && await ev(`document.getElementById('r-create').disabled`) && await visible('r-create'), await dialogText());
  const remoteTwo = bare('empty-two');
  const twoDir = path.join(tmp, 'existing-two');
  await pick(twoDir);
  await setVal('f-name', 'Existing two'); await setVal('f-github', remoteTwo);
  await shot('launch-create-unavailable');
  await ev(`window.__old = true`);
  await ev(`document.getElementById('confirm').click()`).catch(() => {});
  check('gh missing: the existing-repository option still works (model created from the link and opened)', await waitFor(`!window.__old && window.__app && window.__app.ready && location.hash==='#/model'`, 120000) && await onModel('Existing two') && git(twoDir, 'remote', 'get-url', 'origin') === remoteTwo && remoteLog(remoteTwo).length === 0, await dialogText().catch(() => ''));
  await ev(`location.hash='#/launch'`); await onLaunch();

  // under test the real `gh` is never used: without APP_GH_BIN the create path fails loudly and the probe finds nothing
  delete process.env.APP_GH_BIN;
  const gh2 = require('../src/github');
  const loud = await gh2.createRepo({ owner: 'ada-test', name: 'never', visibility: 'private', description: '' }).then(() => 'created', e => e.message);
  check('under test with APP_GH_BIN unset: no `gh` is found, and creating fails loudly', gh2.findGh() === null && (await gh2.account()).reason === 'missing' && /APP_GH_BIN is not set/.test(loud), loud);
  process.env.APP_GH_BIN = ghBin;
  const kinds = ghCalls().map(c => c.slice(0, 2).join(' '));
  check('the fake `gh` saw only the expected commands, and three `repo create` in all (one per button press)', kinds.every(k => ['auth status', 'api user', 'api user/orgs', 'repo view', 'repo create'].includes(k)) && ghCreates().length === 3 && ghCalls().every(c => !c.some(x => /^--(source|push|clone|remote)/.test(x))), JSON.stringify([...new Set(kinds)]));
  check('no console errors', summary.errors.filter(e => e.startsWith('console:')).length === 0, JSON.stringify(summary.errors));
  finish(0);
})().catch(e => { summary.errors.push(String(e && e.stack || e)); finish(1); });
app.on('window-all-closed', () => {});
