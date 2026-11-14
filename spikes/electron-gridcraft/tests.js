const { BrowserWindow } = require('electron');
module.exports = (T, c) => {
  const { ev, shot, sleep, openWin, results } = c;
  const bench = (n, nudge, budgetMs = 2000) => ev(`(async()=>{const gc=H.gc();const ts=[];const end=performance.now()+${budgetMs};
    for(let i=0;i<${n}&&performance.now()<end;i++){const s=performance.now();const nd=H.nudges['${nudge}']||window.__nd&&window.__nd['${nudge}'];if(nd)await nd();
      await gc.execute('sheet.read',{range:'A1:B2'});ts.push(performance.now()-s)}
    return {...H.stats(ts),all:ts.map(Math.round)}})()`);
  const cond = async (label, query, opts, prep) => {
    await openWin(query, opts); await sleep(400);
    const st = await prep();
    await sleep(1200);
    const b = await bench(40, 'none');
    const vis = await ev('document.visibilityState');
    return { ...st, vis, ...b };
  };
  const cover = async () => { const o = new BrowserWindow({ width: 1400, height: 800, x: 40, y: 40, show: true }); o.focus(); c._other = o; await sleep(300); };
  const conds = {
    focused: [{}, async () => { require('electron').app.focus({ steal: true }); c.win.focus(); }],
    unfocused: [{}, async () => { const o = new BrowserWindow({ width: 300, height: 200, x: 1000, y: 700 }); o.focus(); c._other = o; }],
    occluded: [{}, cover],
    minimised: [{}, async () => { c.win.minimize(); }],

    showFalse: [{ show: false }, async () => {}],
  };
  const runCond = async (name, extra = {}, tag = '') => {
    const [opts, prep] = conds[name];
    await openWin('mode=iframe&chrome=none', { ...opts, ...extra }); await sleep(400);
    await prep(); await sleep(1500);
    const st = { isFocused: c.win.isFocused(), minimized: c.win.isMinimized(), visible: c.win.isVisible() };
    const b = await bench(40, 'none');
    st.vis = await ev('document.visibilityState');
    if (c._other) { c._other.destroy(); c._other = null; }
    return { ...st, ...b };
  };
  T('lat', async () => {
    const out = {};
    for (const n of Object.keys(conds)) out[n] = await runCond(n);
    return out;
  });
  T('lat_nothrottle', async () => {
    const out = {};
    for (const n of ["minimised", "occluded", "showFalse"]) out[n] = await runCond(n, { bt: false });
    return out;
  });
  // nudge mechanisms while minimised (the slow case) and while focused
  T('nudge', async () => {
    const out = {};
    await openWin('mode=iframe&chrome=none'); await sleep(400);
    await ev(`window.__nd={ipcmove:()=>hostIpc.nudge(), invalidate:()=>hostIpc.invalidate(), raf:()=>Promise.race([new Promise(r=>requestAnimationFrame(()=>r())),new Promise(r=>setTimeout(r,1000))]), focusFrame:()=>{H.frame.focus()},
      noopParallel: null };0`);
    c.win.minimize(); await sleep(1500);
    out.minimised = {};
    for (const n of ['none', 'mousemove', 'resize', 'ipcmove', 'invalidate', 'raf']) out.minimised[n] = await bench(6, n, 1600);
    return out;
  });

  // ---------- 1. load ----------
  const rendererProbe = `(()=>{const cv=H.canvas();let r='unknown',gl=null;try{gl=cv.getContext('webgl2')}catch(e){}
    if(gl){r='webgl2';let ren='';try{const x=gl.getExtension('WEBGL_debug_renderer_info');ren=x?gl.getParameter(x.UNMASKED_RENDERER_WEBGL):''}catch(e){} return {r,ren}}
    let g=null;try{g=cv.getContext('webgpu')}catch(e){} if(g)return {r:'webgpu'}; let g1=null;try{g1=cv.getContext('webgl')}catch(e){} return {r:g1?'webgl1':'none/unknown'}})()`;
  T('load', async () => {
    const out = {};
    for (const mode of ['iframe', 'page']) {
      const before = results.consoleErrors.length;
      const load = await openWin(`mode=${mode}&chrome=none`);
      await sleep(700);
      out[mode] = { ...load, readyDetail: undefined, appVersion: load.readyDetail && load.readyDetail.appVersion,
        renderer: await ev(rendererProbe), navigatorGpu: await ev('!!navigator.gpu'),
        hostErrors: await ev('H.errors'), events: await ev('H.events.map(e=>e.type)'),
        perf: (await ev('H.gc().uiInspect()')).perf, newConsoleMsgs: results.consoleErrors.slice(before) };
      if (mode === 'page') out[mode].initDoneMs = await ev('H.initDone');
      await shot('load-' + mode);
    }
    out.gpuFeatureStatus = require('electron').app.getGPUFeatureStatus();
    return out;
  });

  // ---------- 2. round trip ----------
  const colName = n => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26 | 0; } return s; };
  const rtCode = `(async()=>{
    const col=n=>{let s='';n++;while(n){const m=(n-1)%26;s=String.fromCharCode(65+m)+s;n=(n-1-m)/26|0}return s};
    const N=480,R=7,gc=H.gc(),vals=[];
    for(let r=0;r<R;r++){const row=[];for(let c=0;c<N;c++)row.push((r+1)*1000+c*0.37+Math.sin(c+r)/3);vals.push(row)}
    const frow=[];for(let c=0;c<N;c++){const L=col(c);frow.push('=SUM('+L+'1:'+L+'7)')}
    const all=vals.concat([frow]); const last=col(N-1);
    let t=performance.now(); await gc.execute('range.setValues',{range:'A1',values:all}); const tSet=performance.now()-t;
    t=performance.now(); const rd=await gc.execute('sheet.read',{range:'A1:'+last+'7'}); const tRead=performance.now()-t;
    t=performance.now(); const rf=await gc.execute('sheet.read',{range:'A8:'+last+'8'}); const tReadF=performance.now()-t;
    t=performance.now(); const rff=await gc.execute('sheet.read',{range:'A8:'+last+'8',formulas:true}); const tReadFF=performance.now()-t;
    let exact=0,bad=0;for(let r=0;r<R;r++)for(let c=0;c<N;c++){if(rd.values[r][c]===vals[r][c])exact++;else bad++}
    let fexact=0,fmax=0,fbad=0;for(let c=0;c<N;c++){let s=0;for(let r=0;r<R;r++)s+=vals[r][c];const g=rf.values[0][c];if(g===s)fexact++;const d=Math.abs(g-s);fmax=Math.max(fmax,d);if(d>1e-9||typeof g!=='number')fbad++}
    let fsame=0;for(let c=0;c<N;c++)if(rff.values[0][c]===frow[c])fsame++;
    t=performance.now(); const ins=await gc.docInspect(); const tIns=performance.now()-t;
    return {cells:(R+1)*N,sentBytes:JSON.stringify(all).length,tSetMs:+tSet.toFixed(1),tReadMs:+tRead.toFixed(1),tReadFormulaRowMs:+tReadF.toFixed(1),tReadFormulasMs:+tReadFF.toFixed(1),
      readRange:rd.range,valuesExact:exact,valuesMismatch:bad,formulaValuesExact:fexact,formulaMaxAbsDiff:fmax,formulaBad:fbad,formulaTextEqual:fsame,usedRange:ins.sheets[0].usedRange,docInspectMs:+tIns.toFixed(1)}})()`;
  T('roundtrip', async () => {
    const out = {};
    for (const mode of ['iframe', 'page']) { await openWin(`mode=${mode}&chrome=none`); await sleep(400); out[mode] = await ev(rtCode); }
    await shot('roundtrip');
    return out;
  });

  // ---------- input helpers ----------
  const key = async (kc, mods = []) => { const w = c.win.webContents; w.sendInputEvent({ type: 'keyDown', keyCode: kc, modifiers: mods }); w.sendInputEvent({ type: 'keyUp', keyCode: kc, modifiers: mods }); await sleep(30); };
  const typeText = async (txt, shift = true) => {
    const w = c.win.webContents;
    for (const ch of txt) {
      const shiftNeeded = false;
      const m = (shift && /[A-Z]/.test(ch)) ? ['shift'] : [];
      w.sendInputEvent({ type: 'keyDown', keyCode: ch, modifiers: m });
      w.sendInputEvent({ type: 'char', keyCode: ch, modifiers: m });
      w.sendInputEvent({ type: 'keyUp', keyCode: ch, modifiers: m });
      await sleep(15);
    }
  };
  const click = async (x, y) => { const w = c.win.webContents; w.sendInputEvent({ type: 'mouseMove', x, y }); w.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); w.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await sleep(120); };
  // cell centre in host-window CSS px (iframe offset 420). grid = uiInspect().grid [x,y,w,h]; default col 51.2px, row 16px at 100%
  const cellXY = (col, row, off = 420) => ({ x: Math.round(off + 28 + 51.2 * col + 25), y: Math.round(177 + 16 * row + 8) });

  // ---------- 5. typing ----------
  T('typing', async () => {
    const out = {};
    await openWin('mode=iframe&chrome=none'); await sleep(500);
    await ev(`H.gc().execute('range.setValues',{range:'A1',values:[['h','m','','',''],[0,10,20,30,'']]})`); await sleep(100);
    // calibrate via uiInspect grid
    out.grid = (await ev('H.gc().uiInspect()')).grid;
    const p = cellXY(4, 1); // E2
    await click(p.x, p.y);
    out.selectedAfterClick = (await ev('H.gc().docInspect()')).selection;
    await typeText('=SUM(B2:D2)');
    out.editorMidEdit = (await ev('H.gc().uiInspect()')).editor;
    await key('Enter'); await sleep(200);
    out.readAfter = await ev(`(async()=>({v:await H.gc().execute('sheet.read',{range:'E2'}),f:await H.gc().execute('sheet.read',{range:'E2',formulas:true}),sel:(await H.gc().docInspect()).selection}))()`);
    await shot('typing');
    // key survey in a scratch cell F3: punctuation + shifted chars as chars
    const survey = "=+-*/^()[]{}:;,.'!@#$%&<>?_ aZ09\"";
    const p2 = cellXY(5, 2); await click(p2.x, p2.y);
    await typeText(survey); await sleep(100);
    const ed = (await ev('H.gc().uiInspect()')).editor;
    out.survey = { sent: survey, editor: ed };
    await key('Escape'); await sleep(100);
    // special keys
    const sp = {};
    const sel = async () => (await ev('H.gc().docInspect()')).selection;
    const p3 = cellXY(1, 4); await click(p3.x, p3.y); sp.start = await sel();
    await key('Down'); sp.Down = await sel(); await key('Right'); sp.Right = await sel(); await key('Up'); sp.Up = await sel(); await key('Left'); sp.Left = await sel();
    await key('Tab'); sp.Tab = await sel(); await key('Enter'); sp.Enter = await sel();
    // Delete / Backspace on E2 (formula) ; Cmd+Z undo
    await click(cellXY(4, 1).x, cellXY(4, 1).y); await key('Delete'); await sleep(150);
    sp.afterDelete = await ev(`H.gc().execute('sheet.read',{range:'E2',formulas:true}).then(r=>r.values[0][0])`);
    await key('Z', ['meta']); await sleep(200);
    sp.afterCmdZ = await ev(`H.gc().execute('sheet.read',{range:'E2',formulas:true}).then(r=>r.values[0][0])`);
    // F2 edit mode: F2 key, Backspace
    await click(cellXY(1, 4).x, cellXY(1, 4).y); await typeText('ab'); await key('Backspace'); sp.afterBackspaceEditor = (await ev('H.gc().uiInspect()')).editor; await key('Escape');
    // clipboard shortcuts
    await click(cellXY(1, 1).x, cellXY(1, 1).y); await key('C', ['meta']); await click(cellXY(1, 6).x, cellXY(1, 6).y); await key('V', ['meta']); await sleep(300);
    sp.cmdC_cmdV = await ev(`H.gc().execute('sheet.read',{range:'B7'}).then(r=>r.values[0][0])`);
    await click(cellXY(1, 1).x, cellXY(1, 1).y); c.win.webContents.copy(); await click(cellXY(1, 7).x, cellXY(1, 7).y); c.win.webContents.paste(); await sleep(300);
    sp.webContentsCopyPaste_B8 = await ev(`H.gc().execute('sheet.read',{range:'B8'}).then(r=>r.values[0][0])`);
    await ev(`H.gc().execute('range.setValues',{range:'H1',values:[['q']]})`);
    // first-letter casing when starting an edit from a letter key
    await click(cellXY(6, 8).x, cellXY(6, 8).y); await typeText('QRs'); await key('Enter'); await sleep(100);
    sp.firstLetterCase_withShiftModifier = await ev(`H.gc().execute('sheet.read',{range:'G9'}).then(r=>r.values[0][0])`);
    await click(cellXY(6, 9).x, cellXY(6, 9).y); await typeText('QRs', false); await key('Enter'); await sleep(100);
    sp.firstLetterCase_noShiftModifier = await ev(`H.gc().execute('sheet.read',{range:'G10'}).then(r=>r.values[0][0])`);
    sp.menuHasEdit = !!require('electron').Menu.getApplicationMenu();
    out.special = sp;
    return out;
  });

  const inputXY = async () => { const r = await ev(`(()=>{const b=document.getElementById('leftinput').getBoundingClientRect();return [Math.round(b.left+b.width/2),Math.round(b.top+b.height/2)]})()`); return r; };
  // ---------- focus isolation: page vs iframe, with a left-pane <input> ----------
  T('focus', async () => {
    const out = {};
    for (const mode of ['iframe', 'page']) {
      await openWin(`mode=${mode}&chrome=none`); await sleep(500);
      const r = {};
      // 1. click the left input, type
      await click(...(await inputXY()));
      await typeText('abc');
      r.leftInputValue = await ev(`document.getElementById('leftinput').value`);
      r.activeIsInput = await ev(`document.activeElement.id`);
      r.gridcraftEditorAfterTypingInLeft = (await ev('H.gc().uiInspect()')).editor;
      r.gridcraftCellA1 = await ev(`H.gc().execute('sheet.read',{range:'A1'}).then(r=>r.values[0][0])`);
      // 2. click a grid cell, type, check input unchanged
      const p = cellXY(0, 0); await click(p.x, p.y); await typeText('Z'); await key('Enter'); await sleep(150);
      r.afterGridTyping = { leftInputValue: await ev(`document.getElementById('leftinput').value`), A1: await ev(`H.gc().execute('sheet.read',{range:'A1'}).then(r=>r.values[0][0])`) };
      // 3. click back into the left input and type again after grid focus
      await click(...(await inputXY())); await typeText('d');
      r.afterReturnToLeft = { leftInputValue: await ev(`document.getElementById('leftinput').value`), A1: await ev(`H.gc().execute('sheet.read',{range:'A1'}).then(r=>r.values[0][0])`) };
      out[mode] = r;
    }
    return out;
  });

  // ---------- 4. file hand-off ----------
  const zipInfo = `(b)=>({len:b.length,magic:Array.from(b.slice(0,4)).map(x=>x.toString(16).padStart(2,'0')).join(''),isZip:b[0]===0x50&&b[1]===0x4b&&b[2]===3&&b[3]===4,
     hasContentTypes:new TextDecoder('latin1').decode(b).includes('[Content_Types].xml'),hasWorkbook:new TextDecoder('latin1').decode(b).includes('xl/workbook.xml')})`;
  T('file', async () => {
    const out = {};
    const fs = c.fs, hs = c.path.resolve(c.OUT, '../house-style/unit_projection.xlsx');
    out.houseStyleExists = fs.existsSync(hs);
    for (const mode of ['iframe', 'page']) {
      const r = {};
      await openWin(`mode=${mode}&chrome=none`); await sleep(400);
      let src;
      if (out.houseStyleExists && !process.env.GEN) { src = new Uint8Array(fs.readFileSync(hs)); r.source = 'house-style/unit_projection.xlsx'; }
      else {
        // have GridCraft produce one: write cells, then File > Save through the bridge
        await ev(`H.gc().execute('range.setValues',{range:'A1',values:[['Month','Premium','Claims'],[1,100.5,60.25],[2,'=B2*1.01','=C2*1.02'],[3,'=B3*1.01','=C3*1.02']]})`);
        await ev(`H.dirtyLog.length=0;H.saves.length=0;0`);
        const t = Date.now();
        await ev(`H.gc().execute('file.save',{})`);
        await sleep(300);
        const n = await ev('H.saves.length');
        r.bridgeSaveCountAfterFileSave = n; r.saveMs = Date.now() - t;
        if (!n) throw new Error('file.save produced no gridcraft:save message');
        src = new Uint8Array(await ev(`Array.from(H.saves[0].bytes)`)); r.source = 'saved by GridCraft via file.save'; r.saveName = await ev('H.saves[0].name');
        r.savedZip = await ev(`(${zipInfo})(H.saves[0].bytes)`);
      }
      // new window = clean document; open the xlsx through the bridge
      await openWin(`mode=${mode}&chrome=none`); await sleep(400);
      await ev(`H.dirtyLog.length=0;H.saves.length=0;0`);
      const arr = Array.from(src);
      const t0 = Date.now();
      await ev(`H.open('unit_projection.xlsx', new Uint8Array(${JSON.stringify(arr)}).buffer); 0`);
      await sleep(600);
      r.openMs = Date.now() - t0;
      const ins = await ev('H.gc().docInspect()');
      r.afterOpen = { title: ins.title, usedRange: ins.sheets.map(x => x.name + ':' + x.usedRange), dirty: ins.dirty };
      r.openedRead = await ev(`H.gc().execute('sheet.read',{range:'A1:C4'}).then(x=>x.values)`);
      r.dirtyEventsAfterOpen = await ev('H.dirtyLog.map(d=>d.dirty)');
      // edit -> dirty
      await ev(`H.dirtyLog.length=0;0`);
      const tE = await ev(`(async()=>{const t=performance.now();await H.gc().execute('cell.set',{cell:'E1',input:'edited'});await new Promise(r=>setTimeout(r,300));return performance.now()-t})()`);
      r.dirtyEventsAfterEdit = await ev('H.dirtyLog.map(d=>d.dirty)');
      // keyboard edit too
      await ev(`H.dirtyLog.length=0;0`);
      // save again, receive bytes
      const t1 = Date.now();
      r.saveArriveMs = await ev(`(async()=>{const t=performance.now();const n=H.saves.length;H.gc().execute('file.save',{});while(H.saves.length===n&&performance.now()-t<3000)await new Promise(r=>setTimeout(r,5));return +(performance.now()-t).toFixed(1)})()`);
      r.saveCount = await ev('H.saves.length');
      if (r.saveCount) { r.saved = await ev(`(()=>{const s=H.saves[H.saves.length-1];return {name:s.name,...(${zipInfo})(s.bytes)}})()`);
        r.dirtyEventsAfterSave = await ev('H.dirtyLog.map(d=>d.dirty)'); }
      // saveBytes alternative (no bridge)
      r.saveBytesCmd = await ev(`(async()=>{const t=performance.now();const b=await H.gc().execute('file.saveBytes',{format:'xlsx'});return {ms:+(performance.now()-t).toFixed(1),name:b.name,base64Len:b.base64.length}})()`);
      // round trip check: reopen saved bytes in a new doc and read E1
      if (r.saveCount) {
        await ev(`H.open('again.xlsx', H.saves[H.saves.length-1].bytes.slice().buffer);0`); await sleep(500);
        r.reopenE1 = await ev(`H.gc().execute('sheet.read',{range:'E1'}).then(x=>x.values[0][0])`);
      }
      out[mode] = r;
      if (mode === 'iframe') fs.writeFileSync(c.path.join(c.OUT, 'handoff-saved.xlsx'), Buffer.from(await ev(`Array.from(H.saves[H.saves.length-1]?.bytes||[])`)));
    }
    return out;
  });

  // ---------- 6. chrome ----------
  T('chrome', async () => {
    const out = {};
    for (const ch of ['default', 'none', 'notitlebar', 'nofiletab']) {
      await openWin(`mode=iframe&chrome=${ch}`); await sleep(700);
      const ui = await ev('H.gc().uiInspect()');
      out[ch] = { grid: ui.grid, window: ui.window, ribbonCollapsed: ui.ui.ribbonCollapsed };
      if (ch === 'default' || ch === 'none') await shot('chrome-' + ch);
    }
    // page mode honours ?chrome= from the page URL?
    await openWin('mode=page&chrome=default'); await sleep(600); out.pageModeDefault = (await ev('H.gc().uiInspect()')).grid;
    await openWin('mode=page&chrome=none'); await sleep(600); out.pageModeNone = (await ev('H.gc().uiInspect()')).grid;
    // host-controlled view options
    await openWin('mode=iframe&chrome=none'); await sleep(500);
    const g = () => ev('H.gc().uiInspect().then(u=>({grid:u.grid,ribbonCollapsed:u.ui.ribbonCollapsed,tab:u.ui.ribbonTab}))');
    const x = (cmd, p = {}) => ev(`H.gc().execute(${JSON.stringify(cmd)},${JSON.stringify(p)}).then(r=>({ok:true,r:JSON.stringify(r).slice(0,150)}),e=>({ok:false,err:e.message.slice(0,200)}))`);
    const v = {}; v.base = await g();
    v.collapseRibbon = await x('view.collapseRibbon'); await sleep(200); v.afterCollapse = await g(); await shot('ribbon-collapsed');
    v.collapseAgain = await x('view.collapseRibbon'); await sleep(200); v.afterExpand = await g();
    v.ribbonTabCmd = await x('ui.ribbonTab', { tab: 'View' }); await sleep(200); v.afterTab = await g();
    v.formulaBarOff = await x('view.formulaBar', { on: false }); await sleep(200); v.afterFormulaBarOff = await g();
    v.statusBar = await x('view.statusBar', {}); 
    v.uiRequestMethods = {};
    for (const m of ['ui.set', 'ui.ribbon', 'ui.hideRibbon', 'view.hideRibbon', 'view.ribbon']) v.uiRequestMethods[m] = await ev(`H.gc().request(${JSON.stringify(m)},{}).then(()=>'ok',e=>e.message.slice(0,80))`);
    out.view = v;
    // protection from host
    await openWin('mode=iframe&chrome=none'); await sleep(500);
    const pr = {};
    await ev(`H.gc().execute('range.setValues',{range:'A1',values:[['locked',1],['free',2]]})`);
    pr.unlockB2 = await x('home.lockCell', { range: 'A2:B2', on: false });
    pr.protect = await x('review.protectSheet', { password: 'pw' });
    pr.protectedFlag = await ev('H.gc().docInspect().then(d=>d.sheets[0].protected)');
    pr.hostSetLocked = await x('cell.set', { cell: 'A1', input: 'HOST-OVERWRITE' });
    pr.hostSetValuesLocked = await x('range.setValues', { range: 'B1', values: [[99]] });
    pr.readBack = await ev(`H.gc().execute('sheet.read',{range:'A1:B2'}).then(r=>r.values)`);
    await click(cellXY(0, 0).x, cellXY(0, 0).y); await typeText('X'); await key('Enter'); await sleep(200);
    pr.afterUserTypingLocked = await ev(`H.gc().execute('sheet.read',{range:'A1'}).then(r=>r.values[0][0])`);
    pr.uiMessage = (await ev('H.gc().uiInspect()')).message; pr.uiDialog = (await ev('H.gc().uiInspect()')).dialog;
    await shot('protected-attempt');
    await key('Enter'); await sleep(100);
    await click(cellXY(0, 1).x, cellXY(0, 1).y); await typeText('Y'); await key('Enter'); await sleep(200);
    pr.afterUserTypingUnlocked = await ev(`H.gc().execute('sheet.read',{range:'A2'}).then(r=>r.values[0][0])`);
    out.protection = pr;
    return out;
  });


  // ---------- batching + CPU cost ----------
  const batchCode = `(async()=>{const gc=H.gc();const out={};
    let t=performance.now();await Promise.all(Array.from({length:40},(_, i)=>gc.execute('sheet.read',{range:'A1:B2'})));out.parallel40Ms=+(performance.now()-t).toFixed(1);
    t=performance.now();await Promise.all([gc.execute('range.setValues',{range:'A1',values:[[1,2],[3,4]]}),gc.execute('sheet.read',{range:'A1:B2'}),gc.execute('sheet.read',{range:'A1:B2',formulas:true}),gc.docInspect(),gc.uiInspect()]);out.batch5Ms=+(performance.now()-t).toFixed(1);
    return out})()`;
  const cpu = async (ms = 1000) => { const { app } = require('electron'); app.getAppMetrics(); await sleep(ms); const m = app.getAppMetrics(); const o = {}; for (const p of m) o[p.type + (p.name ? ':' + p.name : '')] = +((o[p.type + (p.name ? ':' + p.name : '')] || 0) + p.cpu.percentCPUUsage).toFixed(1); return o; };
  T('batch_cpu', async () => {
    const out = {};
    await openWin('mode=iframe&chrome=none'); await sleep(500); await ev(`H.gc().execute('sheet.read',{range:'A1'})`);
    out.focusedBatch = await ev(batchCode);
    out.idleCpu_visible_throttleOn = await cpu();
    c.win.minimize(); await sleep(1500);
    out.minimisedThrottleOn_batch = await ev(batchCode);
    out.idleCpu_minimised_throttleOn = await cpu();
    await openWin('mode=iframe&chrome=none', { bt: false }); await sleep(500);
    out.idleCpu_visible_throttleOff = await cpu();
    c.win.minimize(); await sleep(1500);
    out.minimisedThrottleOff_batch = await ev(batchCode);
    out.idleCpu_minimised_throttleOff = await cpu();
    return out;
  });
};
