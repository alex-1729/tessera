'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { startServer } = require('./server');
const { createRunner, COMMANDS } = require('./tilekit');
const { createAgentService, DEFAULT_MODEL, STRONG_MODEL } = require('./agent');

// The app is called Tessera. Keep the settings folder where it already is: its name came from the old app name.
app.setPath('userData', app.getPath('userData'));
app.setName('Tessera');

const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_DIR, '..');
const ALLOWED_DIRS = new Set(['review', 'real-data']);
const WATCH = ['src', 'cases', 'review'];

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function resolveConfig() {
  const fixtures = process.env.APP_FIXTURES ? path.resolve(process.cwd(), process.env.APP_FIXTURES) : null;
  const modelArg = argValue('--model');
  const modelDir = modelArg ? path.resolve(process.cwd(), modelArg) : fixtures || path.resolve(APP_DIR, '../model');
  return { fixtures, modelDir, repoRoot: REPO_ROOT };
}

// Workbook paths are relative to the model dir and limited to review/ and real-data/.
function safeWorkbookPath(modelDir, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel)) throw new Error('Invalid workbook path.');
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  const parts = norm.split('/');
  if (parts.includes('..') || !ALLOWED_DIRS.has(parts[0]) || !/\.xlsx$/i.test(norm)) throw new Error('Workbook path not allowed: ' + rel);
  const full = path.resolve(modelDir, norm);
  if (!full.startsWith(path.resolve(modelDir) + path.sep)) throw new Error('Workbook path not allowed: ' + rel);
  return { full, norm };
}

function gitUserName(dir) {
  return new Promise(resolve => {
    execFile('git', ['config', 'user.name'], { cwd: dir, timeout: 5000 }, (err, out) => {
      const n = !err && String(out).trim();
      resolve(n || os.userInfo().username);
    });
  });
}

// ---- view settings (small JSON file in userData; separate from the rest of main.js)
// showLeftBar / showRightBar: absent until the reviewer chooses (the right bar then starts collapsed in a narrow window).
// sections: which collapsible sections are open, e.g. { code: true }.
// centre: which centre segment each level shows ({tile, module, model}); lastModel: the folder opened last.
const SETTING_DEFAULTS = { showRibbon: false, showFormulaBar: true, showLeftBar: true, sections: {}, centre: {}, agentModel: DEFAULT_MODEL };
function settingsFile(options) { return options.settingsFile || process.env.APP_SETTINGS || path.join(app.getPath('userData'), 'settings.json'); }
function loadSettings(file) {
  try { return { ...SETTING_DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { ...SETTING_DEFAULTS }; }
}
function saveSettings(file, s) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(s, null, 2)); } catch { /* not fatal */ }
}

function buildMenu(settings, onSetting, withAgent, actions = {}) {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ label: 'Tessera', submenu: [
      { role: 'about', label: 'About Tessera' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide', label: 'Hide Tessera' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: 'Quit Tessera' }] }] : []),
    { label: 'File', submenu: [
      { label: 'Open model…', accelerator: 'CmdOrCtrl+O', click: () => actions.openModel && actions.openModel() },
      { label: 'New model…', accelerator: 'CmdOrCtrl+N', click: () => actions.newModel && actions.newModel() },
      ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ...(isMac ? [{ type: 'separator' }, { role: 'close' }] : [])] },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Show ribbon', type: 'checkbox', checked: !!settings.showRibbon, click: i => onSetting('showRibbon', i.checked) },
      { label: 'Show formula bar', type: 'checkbox', checked: !!settings.showFormulaBar, click: i => onSetting('showFormulaBar', i.checked) },
      { type: 'separator' },
      { id: 'centreSpreadsheet', label: 'Spreadsheet', accelerator: 'CmdOrCtrl+1', click: () => actions.centre && actions.centre('spreadsheet') },
      { id: 'centreCode', label: 'Code', accelerator: 'CmdOrCtrl+2', click: () => actions.centre && actions.centre('code') },
      { id: 'centreTest', label: 'Test', accelerator: 'CmdOrCtrl+3', click: () => actions.centre && actions.centre('test') },
      { type: 'separator' },
      { id: 'showLeftBar', label: 'Show left bar', type: 'checkbox', accelerator: 'CmdOrCtrl+Shift+[', checked: settings.showLeftBar !== false, click: i => onSetting('showLeftBar', i.checked) },
      { id: 'showRightBar', label: 'Show right bar', type: 'checkbox', accelerator: 'CmdOrCtrl+Shift+]', checked: settings.showRightBar !== false, click: i => onSetting('showRightBar', i.checked) },
      ...(withAgent ? [{ type: 'separator' }, { label: 'Agent model', submenu: [
        { label: 'Sonnet (faster)', type: 'radio', checked: settings.agentModel !== STRONG_MODEL, click: () => onSetting('agentModel', DEFAULT_MODEL) },
        { label: 'Opus (stronger)', type: 'radio', checked: settings.agentModel === STRONG_MODEL, click: () => onSetting('agentModel', STRONG_MODEL) }] }] : []),
      { type: 'separator' },
      { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
  ]);
}

async function start(options = {}) {
  const sFile = settingsFile(options);
  const settings = loadSettings(sFile);
  const cfg = { ...resolveConfig(), ...options };
  // The model opened last is reopened, unless this launch names one (--model, a test's modelDir) or runs on fixtures.
  if (!options.modelDir && !cfg.fixtures && !argValue('--model') && settings.lastModel && fs.existsSync(path.join(settings.lastModel, 'tilekit.toml'))) cfg.modelDir = settings.lastModel;
  const pickedFiles = new Set();     // CSV files the user chose in the native dialog
  let runner = createRunner({ ...cfg, pickedFiles });
  const run = (...a) => runner(...a);
  const recentWrites = new Map(); // normalised path -> time of our own write
  let win = null, port = 0;

  const wrap = fn => async (_e, ...a) => {
    try { return { ok: true, value: await fn(...a) }; }
    catch (e) { return { ok: false, error: String(e && e.message || e), detail: e && e.detail }; }
  };

  // view settings: IPC and menu wiring
  const setSetting = (k, v) => {
    settings[k] = v; saveSettings(sFile, settings);
    if (k === 'showLeftBar' || k === 'showRightBar') syncBars({ [k === 'showLeftBar' ? 'left' : 'right']: v });
    if (win && !win.isDestroyed()) win.webContents.send('settings', { ...settings });
  };
  // The View menu's two bar items follow what is on screen (the window may have started the right bar collapsed).
  const syncBars = b => {
    const menu = Menu.getApplicationMenu();
    if (!menu) return;
    for (const [k, id] of [['left', 'showLeftBar'], ['right', 'showRightBar']]) {
      const item = menu.getMenuItemById(id);
      if (item && typeof b[k] === 'boolean') item.checked = b[k];
    }
  };
  ipcMain.handle('settings', wrap(() => ({ ...settings })));
  // Settings the window itself changes: the bars and the open sections.
  ipcMain.handle('setSetting', wrap((k, v) => {
    if (k === 'showLeftBar' || k === 'showRightBar') { if (typeof v !== 'boolean') throw new Error('Invalid value.'); }
    else if (k === 'sections') {
      if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.entries(v).every(([n, on]) => /^[a-z]{1,20}$/.test(n) && typeof on === 'boolean')) throw new Error('Invalid value.');
    } else if (k === 'centre') {
      if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.entries(v).every(([n, on]) => ['tile', 'module', 'model'].includes(n) && ['spreadsheet', 'code', 'test'].includes(on))) throw new Error('Invalid value.');
    } else throw new Error('Unknown setting.');
    setSetting(k, v);
    return true;
  }));
  ipcMain.handle('syncBars', wrap(b => { syncBars(b || {}); return true; }));
  const onSettingChosen = (k, v) => { setSetting(k, v); if (k === 'agentModel') changeAgentModel(); };

  ipcMain.handle('tk', wrap((command, args) => {
    if (typeof command !== 'string' || !COMMANDS.has(command) || command === 'init') throw new Error('Unknown command.');
    if (args === undefined) args = [];
    if (!Array.isArray(args) || args.length > 40 || !args.every(x => typeof x === 'string' && x.length < 20000)) throw new Error('Invalid arguments.');
    return run(command, args);
  }));
  ipcMain.handle('readWorkbook', wrap(rel => fs.promises.readFile(safeWorkbookPath(cfg.modelDir, rel).full)));
  ipcMain.handle('writeWorkbook', wrap(async (rel, bytes) => {
    const { full, norm } = safeWorkbookPath(cfg.modelDir, rel);
    if (!(bytes instanceof Uint8Array)) throw new Error('Workbook bytes expected.');
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    recentWrites.set(norm, Date.now());
    await fs.promises.writeFile(full, bytes);
    recentWrites.set(norm, Date.now());
  }));
  ipcMain.handle('reviewer', wrap(() => gitUserName(cfg.modelDir)));
  // Source files for the Code and Test segments: text files under src/, tests/, cases/ and tilekit.toml only.
  ipcMain.handle('readModelFile', wrap(async rel => {
    if (typeof rel !== 'string' || !rel || rel.length > 300 || rel.includes('\0') || path.isAbsolute(rel)) throw new Error('Invalid file path.');
    const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
    const parts = norm.split('/');
    const inside = norm === 'tilekit.toml' || (['src', 'tests', 'cases'].includes(parts[0]) && parts.length > 1);
    if (parts.includes('..') || !inside || !/\.(py|toml|json|txt|md)$/i.test(norm)) throw new Error('File not allowed: ' + rel);
    const full = path.resolve(cfg.modelDir, norm);
    const real = await fs.promises.realpath(full);
    if (!real.startsWith(await fs.promises.realpath(cfg.modelDir) + path.sep)) throw new Error('File not allowed: ' + rel);
    const st = await fs.promises.stat(real);
    if (!st.isFile() || st.size > 400 * 1024) throw new Error('File too large to show: ' + rel);
    return fs.promises.readFile(real, 'utf8');
  }));
  ipcMain.handle('pickFolder', wrap(async () => {
    if (typeof cfg.pickFolder === 'function') return cfg.pickFolder();
    const r = await dialog.showOpenDialog(win, { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  }));
  ipcMain.handle('newModel', wrap(async (dir, name) => {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.length > 500 || dir.includes('\0')) throw new Error('Choose a folder for the model.');
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new Error('Give the model a name.');
    await fs.promises.mkdir(dir, { recursive: true });
    const r = await run('init', ['--name', name.trim()], dir);
    await switchModel(dir);
    return r;
  }));
  ipcMain.handle('pickCsv', wrap(async () => {
    let file = null;
    if (typeof cfg.pickCsv === 'function') file = await cfg.pickCsv();
    else {
      const r = await dialog.showOpenDialog(win, { title: 'Choose model points', properties: ['openFile'], filters: [{ name: 'CSV file', extensions: ['csv'] }] });
      file = r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    }
    if (file) pickedFiles.add(file);
    return file;
  }));
  ipcMain.handle('exportWorkbook', wrap(async () => {
    const r = await dialog.showSaveDialog(win, { title: 'Export workbook', defaultPath: 'model.xlsx', filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
    if (r.canceled || !r.filePath) return null;
    await run('export', ['--out', r.filePath]);
    return r.filePath;
  }));


  // ---- the embedded modelling agent (not in fixture mode)
  const SLUG = /^[A-Za-z0-9_-]{1,80}$/;
  const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  let graphCache = null;
  const graphNow = () => {
    if (!graphCache || Date.now() - graphCache.at > 4000) graphCache = { at: Date.now(), p: run('graph') };
    return graphCache.p.catch(e => { graphCache = null; throw e; });
  };
  const checkScope = async scope => {
    if (!scope || typeof scope !== 'object') throw new Error('Invalid scope.');
    const { level, id } = scope;
    if (level === 'model') return { level, id: 'model' };
    if (!['module', 'tile'].includes(level) || typeof id !== 'string' || !NAME.test(id)) throw new Error('Invalid scope.');
    const g = await graphNow();
    const ok = level === 'module' ? g.modules.some(m => m.id === id) : !!(g.quantities[id] && g.quantities[id].kind === 'tile');
    if (!ok) throw new Error(`There is no ${level} ${id} in the model.`);
    return { level, id };
  };
  const cleanExtra = extra => {
    if (extra === undefined || extra === null) return undefined;
    if (typeof extra !== 'object' || Array.isArray(extra)) throw new Error('Invalid extra.');
    const out = {};
    if (extra.formula !== undefined) { if (typeof extra.formula !== 'string' || extra.formula.length > 2000) throw new Error('Invalid formula.'); out.formula = extra.formula; }
    if (extra.cell !== undefined) { if (typeof extra.cell !== 'string' || !/^[A-Za-z]{1,3}[0-9]{1,7}$/.test(extra.cell)) throw new Error('Invalid cell.'); out.cell = extra.cell; }
    if (extra.case !== undefined) { if (typeof extra.case !== 'string' || extra.case.length > 200) throw new Error('Invalid case.'); out.case = extra.case; }
    if (extra.rows !== undefined) {
      const e = extra.rows && typeof extra.rows === 'object' ? Object.entries(extra.rows) : null;
      if (!e || e.length > 2000 || !e.every(([k, v]) => /^\d{1,7}$/.test(k) && typeof v === 'string' && NAME.test(v))) throw new Error('Invalid rows.');
      out.rows = Object.fromEntries(e);
    }
    return out;
  };
  // The agent's what-if runs pass `--model <copy>`; the window's own `tk` channel never accepts it.
  const agentTk = (command, args = []) => {
    const i = args.indexOf('--model');
    return i < 0 ? run(command, args) : run(command, args.filter((_, j) => j !== i && j !== i + 1), String(args[i + 1]));
  };
  let agent = null;
  const makeAgent = () => createAgentService({
    modelDir: cfg.modelDir, repoRoot: cfg.repoRoot, tilekit: agentTk,
    pythonProject: cfg.projectDir || process.env.APP_TILEKIT_PROJECT || cfg.modelDir,
    modelName: process.env.AGENT_MODEL || settings.agentModel || DEFAULT_MODEL,
    emit: ev => { if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev); },
    confirm: async req => {
      const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
        type: 'warning', buttons: ['Change it', 'Cancel'], defaultId: 1, cancelId: 1,
        title: String(req.title || 'Change this?'), message: String(req.message || req.title || ''), detail: req.detail ? String(req.detail) : undefined,
      });
      return r.response === 0;
    },
    ...(options.agentOptions || {}),
  });
  // The window's agent API exists only while there is an agent (not in fixture mode, unless a test supplies a stub).
  const emitAgent = ev => { if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev); };
  const createAgent = () => options.agentStub ? options.agentStub({ emit: emitAgent }) : (!cfg.fixtures || options.agentOptions ? makeAgent() : null);
  agent = createAgent();
  const needAgent = () => { if (!agent) throw new Error('The agent is not available.'); return agent; };
  ipcMain.on('agent:available', e => { e.returnValue = !!agent; });
  ipcMain.handle('agent:send', wrap(async (scope, text, extra) => {
    scope = await checkScope(scope);
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('The message must be between 1 and 8,000 characters.');
    return needAgent().send(scope, text, cleanExtra(extra));
  }));
  ipcMain.handle('agent:interrupt', wrap(async () => needAgent().interrupt()));      // stops whatever turn is running
  // No scope: the whole conversation of the model. A scope: that selection's own history (older backends).
  ipcMain.handle('agent:history', wrap(async scope => (scope === undefined || scope === null) ? needAgent().history() : needAgent().history(await checkScope(scope))));
  ipcMain.handle('agent:drafts', wrap(() => needAgent().drafts()));
  ipcMain.handle('agent:requests', wrap(() => { const a = needAgent(); return typeof a.requests === 'function' ? a.requests() : []; }));
  ipcMain.handle('agent:acceptDraft', wrap(id => { if (!SLUG.test(String(id))) throw new Error('Invalid draft id.'); return needAgent().acceptDraft(String(id)); }));
  ipcMain.handle('agent:discardDraft', wrap(id => { if (!SLUG.test(String(id))) throw new Error('Invalid draft id.'); return needAgent().discardDraft(String(id)); }));
  ipcMain.handle('agent:buildModule', wrap(async id => { const s = await checkScope({ level: 'module', id }); return needAgent().buildModule(s.id); }));
  ipcMain.handle('agent:status', wrap(() => needAgent().status()));
  // A sign-off made through the chat is recorded only by this button: the model cannot do it.
  const signoffArgs = (id, v) => {
    if (!SLUG.test(String(id))) throw new Error('Invalid request id.');
    const str = (x, n, what) => { if (x === undefined || x === null) return undefined; if (typeof x !== 'string' || x.length > n) throw new Error(`Invalid ${what}.`); return x; };
    v = v && typeof v === 'object' ? v : {};
    return { reviewer: str(v.reviewer, 200, 'reviewer name'), comment: str(v.comment, 4000, 'comment'), valuesOnlyReason: str(v.valuesOnlyReason, 4000, 'reason') };
  };
  ipcMain.handle('agent:confirmSignoff', wrap((id, v) => {
    const a = needAgent(), args = signoffArgs(id, v);
    if (typeof a.confirmSignoff !== 'function') throw new Error('Signing off from the chat is not available yet.');
    return a.confirmSignoff(String(id), args);
  }));
  ipcMain.handle('agent:declineSignoff', wrap(id => {
    const a = needAgent();
    if (!SLUG.test(String(id))) throw new Error('Invalid request id.');
    if (typeof a.declineSignoff !== 'function') throw new Error('Signing off from the chat is not available yet.');
    return a.declineSignoff(String(id));
  }));
  const changeAgentModel = () => {
    if (!agent || options.agentStub) return;
    for (const b of agent.status().busy) { try { agent.interrupt(b.scope); } catch { /* ignore */ } }
    agent = makeAgent();
  };

  const started = await startServer({ gridcraftDir: path.join(REPO_ROOT, 'vendor/gridcraft/web'), rendererDir: path.join(APP_DIR, 'renderer') });
  const server = started.server;
  port = started.port;
  await app.whenReady();

  // ---- File > Open model / New model: switch to another folder with its own runner, watcher and agent
  const sendMenu = a => { if (win && !win.isDestroyed()) win.webContents.send('menu', a); };
  async function switchModel(dir) {
    const full = path.resolve(String(dir));
    if (!fs.existsSync(path.join(full, 'tilekit.toml'))) throw new Error('That folder has no tilekit.toml, so it is not a model.');
    if (agent && !options.agentStub) for (const b of agent.status().busy) { try { agent.interrupt(b.scope); } catch { /* ignore */ } }
    cfg.modelDir = full; cfg.fixtures = null;
    runner = createRunner({ ...cfg, pickedFiles });
    graphCache = null; recentWrites.clear();
    agent = createAgent();
    armWatchers();
    settings.lastModel = full; saveSettings(sFile, settings);
    if (win && !win.isDestroyed()) await win.loadURL(`http://127.0.0.1:${port}/app/index.html?model=${Date.now()}#/model`);
    return full;
  }
  const openModelDialog = async () => {
    let dir = null;
    if (typeof cfg.pickFolder === 'function') dir = await cfg.pickFolder();
    else {
      const r = await dialog.showOpenDialog(win, { title: 'Open model', properties: ['openDirectory'] });
      dir = r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    }
    if (!dir) return null;
    try { return await switchModel(dir); }
    catch (e) { if (typeof cfg.pickFolder !== 'function') await dialog.showMessageBox(win, { type: 'error', message: 'Could not open that folder', detail: String(e.message || e), buttons: ['OK'] }); else throw e; return null; }
  };
  Menu.setApplicationMenu(buildMenu(settings, onSettingChosen, !!agent, { openModel: () => { void openModelDialog(); }, newModel: () => sendMenu('newModel'), centre: seg => sendMenu('centre:' + seg) }));
  try { if (app.dock) app.dock.setIcon(nativeImage.createFromPath(path.join(APP_DIR, 'assets/icon.png'))); } catch { /* the Dock icon is cosmetic */ }

  win = new BrowserWindow({
    width: 1500, height: 950, show: options.show !== false, title: 'Tessera', icon: path.join(APP_DIR, 'assets/icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // File watching: debounce 300 ms, skip our own writes, the agent's logs and drafts, and Python byte-code noise.
  let watchers = [];
  const watching = new Set();
  let timer = null;
  const fire = () => { graphCache = null; if (win && !win.isDestroyed()) win.webContents.send('changed'); };
  const onFs = (base) => (_ev, filename) => {
    const rel = filename ? path.posix.join(base, String(filename).replace(/\\/g, '/')) : base;
    if (/(^|\/)(__pycache__|\.DS_Store)(\/|$)|\.pyc$|\.tmp$/.test(rel)) return;
    if (/(^|\/)(log|chat)\.jsonl$/.test(rel) || /^review\/(drafts|requests)(\/|$)/.test(rel)) return;
    const t = recentWrites.get(rel);
    if (t && Date.now() - t < 3000) return;
    clearTimeout(timer); timer = setTimeout(fire, 300);
  };
  const watchDir = d => {
    if (watching.has(d)) return false;
    const full = path.join(cfg.modelDir, d);
    if (!fs.existsSync(full)) return false;
    try { watchers.push(fs.watch(full, { recursive: true }, onFs(d))); watching.add(d); return true; } catch { return false; /* unsupported: no live refresh */ }
  };
  function armWatchers() {
    watchers.forEach(w => { try { w.close(); } catch { /* ignore */ } });
    watchers = []; watching.clear();
    WATCH.forEach(watchDir);
    // review/, cases/ or src/ may be created after the app starts: the model dir itself tells us.
    try { watchers.push(fs.watch(cfg.modelDir, (_ev, f) => {
      if (f === 'tilekit.toml') onFs('')(_ev, f);
      else if (WATCH.includes(String(f)) && watchDir(String(f))) onFs('')(_ev, f);
    })); } catch { /* ignore */ }
  }
  armWatchers();

  const shutdown = () => { watchers.forEach(w => { try { w.close(); } catch { /* ignore */ } }); clearTimeout(timer); try { server.close(); } catch { /* ignore */ } };
  win.on('closed', shutdown);
  app.on('window-all-closed', () => { shutdown(); app.quit(); });

  await win.loadURL(`http://127.0.0.1:${port}/app/index.html`);
  return { win, port, server, cfg, shutdown, run, settings, setSetting, switchModel, openModelDialog, get settingsFile() { return sFile; }, get agent() { return agent; } };
}

module.exports = { start, safeWorkbookPath };

if (!process.env.APP_NO_AUTOSTART) {
  start().catch(e => { console.error(e); app.exit(1); });
}
