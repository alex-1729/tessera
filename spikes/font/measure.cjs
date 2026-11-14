// Width comparison: (1) ink width of each sample row in compare-prebuilt.png (what GridCraft drew),
// (2) Chromium's advance width of the same string in real Open Sans (from fonts/) and in Arial.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const T = 'Units after allocation 1,234.5678';

app.whenReady().then(async () => {
  const img = nativeImage.createFromPath(path.join(__dirname, 'compare-prebuilt.png'));
  const { width: W, height: H } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const dark = (x, y) => { const i = (y * W + x) * 4; return (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3 < 128; };
  const rowsY = [376, 417, 458, 499, 539, 580, 621, 662];
  const labels = ['default', 'Calibri', 'Arial', 'Open Sans', 'Times New Roman', 'Ubuntu', 'Open Sans bold', 'Calibri bold'];
  const ink = {};
  rowsY.forEach((y, r) => {
    let lo = 1e9, hi = -1;
    for (let x = 300; x < 960; x++) for (let yy = y - 14; yy < y + 14; yy++) if (dark(x, yy)) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    ink[labels[r]] = { device_px: hi - lo + 1, css_px: (hi - lo + 1) / 2 };
  });
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<canvas id=c></canvas>');
  const fontsDir = path.join(__dirname, 'fonts');
  const b64 = f => fs.readFileSync(path.join(fontsDir, f)).toString('base64');
  const res = await win.webContents.executeJavaScript(`(async () => {
    const add = async (fam, b, desc) => { const bytes = Uint8Array.from(atob(b), c => c.charCodeAt(0)); const f = new FontFace(fam, bytes.buffer, desc); await f.load(); document.fonts.add(f); };
    await add('OS', '${b64('OpenSans-Regular.ttf')}', {});
    await add('OSB', '${b64('OpenSans-Bold.ttf')}', {});
    const ctx = document.getElementById('c').getContext('2d');
    const m = (f) => { ctx.font = f; return ctx.measureText(${JSON.stringify(T)}); };
    const px = 14 * 96 / 72;
    const o = {};
    for (const [k, f] of [['Open Sans', px + 'px OS'], ['Open Sans bold', px + 'px OSB'], ['Arial (macOS)', px + 'px Arial'], ['Arial bold (macOS)', 'bold ' + px + 'px Arial']]) {
      const r = m(f); o[k] = { advance_css_px: +r.width.toFixed(1), ink_css_px: +(r.actualBoundingBoxRight + r.actualBoundingBoxLeft).toFixed(1) };
    }
    return o;
  })()`);
  const out = { sample: T, size_pt: 14, gridcraft_prebuilt_ink: ink, chromium_reference: res };
  fs.writeFileSync(path.join(__dirname, 'widths.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  app.quit();
});
