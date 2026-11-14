// Reference + measurement for the patched build.
// 1. Draws the sample in Chromium from the Open Sans TTFs (four faces) -> patched-reference.png.
// 2. Measures the ink width of each row of column B in a GridCraft capture (argv[2]) between
//    x0..x1 (argv[3], argv[4], device px) and compares with Chromium's ink width.
// Usage: electron patched-measure.cjs patched-compare.png x0 x1
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const T = 'Units after allocation 1,234.5678';

app.whenReady().then(async () => {
  const b64 = f => fs.readFileSync(path.join(__dirname, 'fonts', f)).toString('base64');
  const faces = [['Regular', 'OpenSans-Regular.ttf'], ['Bold', 'OpenSans-Bold.ttf'], ['Italic', 'OpenSans-Italic.ttf'], ['BoldItalic', 'OpenSans-BoldItalic.ttf']];
  const win = new BrowserWindow({ width: 700, height: 260, show: true, webPreferences: { backgroundThrottling: false } });
  await win.loadURL('data:text/html,<body style="margin:0;background:white"><canvas id=c width=1400 height=520 style="width:700px;height:260px"></canvas></body>');
  const ref = await win.webContents.executeJavaScript(`(async () => {
    const faces = ${JSON.stringify(faces.map(([k, f]) => [k, b64(f)]))};
    for (const [k, b] of faces) { const bytes = Uint8Array.from(atob(b), c => c.charCodeAt(0)); const ff = new FontFace('OS' + k, bytes.buffer); await ff.load(); document.fonts.add(ff); }
    const c = document.getElementById('c'); const ctx = c.getContext('2d'); ctx.scale(2, 2);
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 700, 260); ctx.fillStyle = 'black';
    const px = 14 * 96 / 72; const o = {};
    faces.forEach(([k], i) => { ctx.font = px + 'px OS' + k; ctx.fillText(${JSON.stringify(T)}, 10, 40 + i * 50);
      const m = ctx.measureText(${JSON.stringify(T)}); o[k] = { advance_css_px: +m.width.toFixed(1), ink_css_px: +(m.actualBoundingBoxRight + m.actualBoundingBoxLeft).toFixed(1) }; });
    ctx.font = px + 'px Arial'; ctx.fillText('(Chromium, Open Sans TTFs: Regular, Bold, Italic, Bold Italic)', 10, 240);
    return o;
  })()`);
  const shot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'patched-reference.png'), shot.toPNG());
  const out = { sample: T, size_pt: 14, chromium_open_sans: ref };
  if (process.argv[2]) {
    const img = nativeImage.createFromPath(path.resolve(process.argv[2]));
    const { width: W, height: H } = img.getSize();
    const bmp = img.toBitmap();
    const x0 = +process.argv[3], x1 = +process.argv[4];
    const dark = (x, y) => { const i = (y * W + x) * 4; return (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3 < 140; };
    // Bands of rows with ink in [x0, x1).
    const inked = []; for (let y = 0; y < H; y++) { let a = false; for (let x = x0; x < x1 && !a; x++) a = dark(x, y); inked.push(a); }
    const bands = []; let s = -1;
    for (let y = 0; y <= H; y++) { if (y < H && inked[y]) { if (s < 0) s = y; } else if (s >= 0) { if (y - s > 8) bands.push([s, y]); s = -1; } }
    out.gridcraft_rows = bands.map(([a, b]) => { let lo = 1e9, hi = -1, n = 0; for (let y = a; y < b; y++) for (let x = x0; x < x1; x++) if (dark(x, y)) { lo = Math.min(lo, x); hi = Math.max(hi, x); n++; }
      return { y: [a, b], ink_device_px: hi - lo + 1, ink_css_px: (hi - lo + 1) / 2, dark_px: n }; });
  }
  fs.writeFileSync(path.join(__dirname, 'patched-widths.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  app.quit();
});
