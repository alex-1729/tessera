'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { startServer } = require('./server');
const { createRunner, COMMANDS } = require('./tilekit');
const { createAgentService, DEFAULT_MODEL, STRONG_MODEL } = require('./agent');

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
const SETTING_DEFAULTS = { showRibbon: false, showFormulaBar: true, agentModel: DEFAULT_MODEL };
function settingsFile(options) { return options.settingsFile || process.env.APP_SETTINGS || path.join(app.getPath('userData'), 'settings.json'); }
function loadSettings(file) {
  try { return { ...SETTING_DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { ...SETTING_DEFAULTS }; }
}
function saveSettings(file, s) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(s, null, 2)); } catch { /* not fatal */ }
}

function buildMenu(settings, onSetting, withAgent) {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [
      { label: 'Show ribbon', type: 'checkbox', checked: !!settings.showRibbon, click: i => onSetting('showRibbon', i.checked) },
      { label: 'Show formula bar', type: 'checkbox', checked: !!settings.showFormulaBar, click: i => onSetting('showFormulaBar', i.checked) },
      ...(withAgent ? [{ type: 'separator' }, { label: 'Agent model', submenu: [
        { label: 'Sonnet (faster)', type: 'radio', checked: settings.agentModel !== STRONG_MODEL, click: () => onSetting('agentModel', DEFAULT_MODEL) },
        { label: 'Opus (stronger)', type: 'radio', checked: settings.agentModel === STRONG_MODEL, click: () => onSetting('agentModel', STRONG_MODEL) }] }] : []),
      { type: 'separator' },
      { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
  ]);
}

async function start(options = {}) {
  const cfg = { ...resolveConfig(), ...options };
  const pickedFiles = new Set();     // CSV files the user chose in the native dialog
  const run = createRunner({ ...cfg, pickedFiles });
  const recentWrites = new Map(); // normalised path -> time of our own write
  let win = null;

  const wrap = fn => async (_e, ...a) => {
    try { return { ok: true, value: await fn(...a) }; }
    catch (e) { return { ok: false, error: String(e && e.message || e), detail: e && e.detail }; }
  };

  // view settings: IPC and menu wiring
  const sFile = settingsFile(options);
  const settings = loadSettings(sFile);
  const setSetting = (k, v) => {
    settings[k] = v; saveSettings(sFile, settings);
    if (win && !win.isDestroyed()) win.webContents.send('settings', { ...settings });
  };
  ipcMain.handle('settings', wrap(() => ({ ...settings })));
  const onSettingChosen = (k, v) => { setSetting(k, v); if (k === 'agentModel') changeAgentModel(); };

  ipcMain.handle('tk', wrap((command, args) => {
    if (typeof command !== 'string' || !COMMANDS.has(command)) throw new Error('Unknown command.');
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
  const withAgent = !cfg.fixtures || !!options.agentOptions;
  if (withAgent) {
    agent = makeAgent();
    ipcMain.on('agent:available', e => { e.returnValue = true; });
    ipcMain.handle('agent:send', wrap(async (scope, text, extra) => {
      scope = await checkScope(scope);
      if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('The message must be between 1 and 8,000 characters.');
      return agent.send(scope, text, cleanExtra(extra));
    }));
    ipcMain.handle('agent:interrupt', wrap(async scope => agent.interrupt(await checkScope(scope))));
    ipcMain.handle('agent:history', wrap(async scope => agent.history(await checkScope(scope))));
    ipcMain.handle('agent:drafts', wrap(() => agent.drafts()));
    ipcMain.handle('agent:acceptDraft', wrap(id => { if (!SLUG.test(String(id))) throw new Error('Invalid draft id.'); return agent.acceptDraft(String(id)); }));
    ipcMain.handle('agent:discardDraft', wrap(id => { if (!SLUG.test(String(id))) throw new Error('Invalid draft id.'); return agent.discardDraft(String(id)); }));
    ipcMain.handle('agent:buildModule', wrap(async id => { const s = await checkScope({ level: 'module', id }); return agent.buildModule(s.id); }));
    ipcMain.handle('agent:status', wrap(() => agent.status()));
  } else ipcMain.on('agent:available', e => { e.returnValue = false; });
  const changeAgentModel = () => {
    if (!agent) return;
    for (const b of agent.status().busy) { try { agent.interrupt(b.scope); } catch { /* ignore */ } }
    agent = makeAgent();
  };

  const { server, port } = await startServer({ gridcraftDir: path.join(REPO_ROOT, 'vendor/gridcraft/web'), rendererDir: path.join(APP_DIR, 'renderer') });
  await app.whenReady();
  Menu.setApplicationMenu(buildMenu(settings, onSettingChosen, withAgent));

  win = new BrowserWindow({
    width: 1500, height: 950, show: options.show !== false, title: 'Model review',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // File watching: debounce 300 ms, skip our own writes, the agent's logs and drafts, and Python byte-code noise.
  const watchers = [];
  const watching = new Set();
  let timer = null;
  const fire = () => { graphCache = null; if (win && !win.isDestroyed()) win.webContents.send('changed'); };
  const onFs = (base) => (_ev, filename) => {
    const rel = filename ? path.posix.join(base, String(filename).replace(/\\/g, '/')) : base;
    if (/(^|\/)(__pycache__|\.DS_Store)(\/|$)|\.pyc$|\.tmp$/.test(rel)) return;
    if (/(^|\/)log\.jsonl$/.test(rel) || /^review\/drafts(\/|$)/.test(rel)) return;
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
  WATCH.forEach(watchDir);
  // review/, cases/ or src/ may be created after the app starts: the model dir itself tells us.
  try { watchers.push(fs.watch(cfg.modelDir, (_ev, f) => {
    if (f === 'tilekit.toml') onFs('')(_ev, f);
    else if (WATCH.includes(String(f)) && watchDir(String(f))) onFs('')(_ev, f);
  })); } catch { /* ignore */ }

  const shutdown = () => { watchers.forEach(w => { try { w.close(); } catch { /* ignore */ } }); clearTimeout(timer); try { server.close(); } catch { /* ignore */ } };
  win.on('closed', shutdown);
  app.on('window-all-closed', () => { shutdown(); app.quit(); });

  await win.loadURL(`http://127.0.0.1:${port}/app/index.html`);
  return { win, port, server, cfg, shutdown, run, settings, setSetting, get agent() { return agent; } };
}

module.exports = { start, safeWorkbookPath };

if (!process.env.APP_NO_AUTOSTART) {
  start().catch(e => { console.error(e); app.exit(1); });
}
