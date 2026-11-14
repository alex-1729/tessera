// Electron harness: load the prebuilt GridCraft web build, run a JS file in the page, save PNGs.
// Usage: electron run.cjs <page-script.js> [url]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const script = fs.readFileSync(path.resolve(process.argv[2]), 'utf8');
const url = process.argv[3] || 'http://127.0.0.1:8771/?chrome=none';
const outDir = __dirname;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 520, show: true, x: 20, y: 20,
    webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => {
    const m = e.message || '';
    if (/error|panic|font/i.test(m)) console.log('[page]', m.slice(0, 300));
  });
  await win.loadURL(url);
  // Wait for window.gridcraft.
  for (let i = 0; i < 120; i++) {
    const ok = await win.webContents.executeJavaScript('!!(window.gridcraft && window.gridcraft.execute)');
    if (ok) break;
    await new Promise(r => setTimeout(r, 500));
  }
  try {
    const result = await win.webContents.executeJavaScript(`(async () => { ${script} })()`);
    // result may contain {shots: {name: true}} -> capture after each? We support capture requests via a global.
    console.log(JSON.stringify(result, null, 1));
  } catch (e) {
    console.log('SCRIPT ERROR', e && e.message);
  }
  const img = await win.webContents.capturePage();
  const name = process.env.SHOT || 'shot.png';
  fs.writeFileSync(path.join(outDir, name), img.toPNG());
  console.log('saved', name);
  app.quit();
});
