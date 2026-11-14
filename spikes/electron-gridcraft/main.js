// Spike: GridCraft inside Electron. Usage: electron main.js [testName ...]  (default: all)
const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('http'), fs = require('fs'), path = require('path');
const HERE = __dirname;
const VENDOR = path.resolve(HERE, '../../vendor/gridcraft/web');
const OUT = HERE;
const results = { electron: process.versions.electron, chrome: process.versions.chrome, tests: {}, consoleErrors: [] };
const hard = setTimeout(() => { results.hardTimeout = true; finish(2); }, 90000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BGFLAGS = process.argv.includes('--bgflags');
if (BGFLAGS) { for (const f of ['disable-renderer-backgrounding','disable-background-timer-throttling','disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(f); results.bgflags = true; }
const only = process.argv.slice(2).filter(a => !a.startsWith('-') && !a.startsWith('--') && !a.endsWith('main.js') && !a.startsWith('/') && a !== '.');

const files = fs.readdirSync(VENDOR);
const glue = { js: files.find(f => /^gridcraft-web-.*\.js$/.test(f)), wasm: files.find(f => f.endsWith('.wasm')) };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = u.pathname;
  if (p === '/gridcraft-glue.json') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(glue)); }
  let file;
  if (p.startsWith('/gridcraft/')) { p = p.slice(10); if (p.endsWith('/')) p += 'index.html'; file = path.join(VENDOR, p); }
  else file = path.join(HERE, p === '/' ? 'host.html' : p);
  if (!file.startsWith(VENDOR) && !file.startsWith(HERE)) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (e, b) => {
    if (e) { res.statusCode = 404; return res.end('nf'); }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.end(b);
  });
});

let win, port, finished = false;
async function finish(code) {
  if (finished) return; finished = true;
  results.consoleErrors = [...new Set(results.consoleErrors)].slice(0, 30);
  console.log(JSON.stringify(results, null, 1));
  try { fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1)); } catch {}
  try { server.close(); } catch {}
  app.exit(code || 0);
}
const ev = js => win.webContents.executeJavaScript(js, true);
async function shot(name) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG()); return name + '.png'; }
function frame() { return win.webContents.mainFrame.frames[0] || null; }

async function openWin(query, opts = {}) {
  if (win && !win.isDestroyed()) win.destroy();
  const t = Date.now();
  win = new BrowserWindow({ width: 1400, height: 800, x: 40, y: 40, show: opts.show !== false, webPreferences: { preload: path.join(HERE, 'preload.js'), backgroundThrottling: opts.bt !== false, ...(opts.wp || {}) } });
  win.webContents.on('console-message', (e, level, message, line, src) => {
    const m = e && e.message !== undefined ? e : { level, message };
    if ((m.level === 'error' || m.level === 3 || m.level === 2 || m.level === 'warning') ) results.consoleErrors.push(`[${m.level}] ${String(m.message).slice(0, 300)}`);
  });
  await win.loadURL(`http://127.0.0.1:${port}/host.html?${query}`);
  const created = t;
  const ready = await Promise.race([ev('H.ready.then(d=>d)'), sleep(20000).then(() => null)]);
  const readyMs = Date.now() - created;
  return { ready: !!ready, readyMs, readyDetail: ready, hostReadyAt: await ev('H.readyAt') };
}

ipcMain.handle('invalidate', () => { win.webContents.invalidate(); return true; });
ipcMain.handle('nudge', () => { win.webContents.sendInputEvent({ type: 'mouseMove', x: 700, y: 400 }); return true; });

const tests = {};
module.exports = { tests };
const T = (name, fn) => { tests[name] = fn; };
require('./tests')(T, { ev, shot, sleep, results, openWin, frame, get win() { return win; }, OUT, fs, path, VENDOR });

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); port = server.address().port;
  try {
    for (const [name, fn] of Object.entries(tests)) {
      if (only.length && !only.includes(name)) continue;
      const t = Date.now();
      try { results.tests[name] = await fn(); } catch (e) { results.tests[name] = { error: String(e && e.stack || e) }; }
      results.tests[name] && typeof results.tests[name] === 'object' && (results.tests[name]._ms = Date.now() - t);
    }
  } catch (e) { results.fatal = String(e); }
  await finish(0);
});
app.on('window-all-closed', () => {});
