import { h, sleep } from './util.js';
import * as L from './logic.js';
import { createGrid } from './grid.js';
import { tileView, moduleView, modelView } from './views.js';
import * as agent from './agentlog.js';
import * as RD from './real.js';
import { createSpecLine } from './specline.js';
import { paintSource } from './codeview.js';
import { PREFILL, paintLaunch, newModelDialog, commitDialog, settingsDialog } from './launch.js';

const api = window.api;
const S = { graph: null, status: null, cases: [], runs: [], drafts: [], real: null, notice: null, actionError: null, loadError: null, busy: false };
let working = 0;                // tilekit commands in flight that are not part of act()
const realCache = new Map();    // run|policy|target -> workbook path of the real-data build
const caseSel = {};          // route key -> selected case id
let routeKey = null;
let reviewerName = null;
let openModel = null;               // the open model: {id, dir}, or null (the launch page only)
let grid;
let spec = null;
let settings = { showRibbon: false, showFormulaBar: true, showLeftBar: true, sections: {}, centre: {} };
const codeMem = new Map();           // tile -> the source last seen
const codeWas = new Map();           // tile -> the source it had before it last changed ("Was" in the Code segment)
const LEFT_W = 340;                  // the left bar's width, for the maps (its content is 32px narrower)
const NARROW = 1200;                 // below this window width the right bar starts collapsed unless the reviewer chose
const bars = { left: true, right: true };
let leftName = 'Tile', blocked = false;
const SEGS = ['spreadsheet', 'code', 'test'];

const $ = id => document.getElementById(id);

function parseRoute() {
  const m = /^#\/(launch|model|module|tile)(?:\/(.+))?$/.exec(location.hash);
  if (!m) return openModel ? { view: 'model', id: null, key: 'model' } : { view: 'launch', id: null, key: 'launch' };
  const id = m[2] ? decodeURIComponent(m[2]) : null;
  return { view: m[1], id, key: m[1] + '/' + (id || '') };
}

async function reviewer() {
  if (reviewerName === null) { try { reviewerName = await api.reviewer(); } catch { reviewerName = ''; } }
  return reviewerName;
}

async function refresh() {
  try {
    const [graph, status, cases] = await Promise.all([api.tk('graph'), api.tk('status'), api.tk('cases')]);
    const runs = status.runs && status.runs.count > 0 ? await api.tk('runs') : { runs: [] };
    S.drafts = api.agent ? ((await api.agent.drafts().catch(() => [])) || []).filter(d => d.status === 'proposed') : [];
    S.graph = graph; S.status = status; S.cases = Array.isArray(cases) ? cases : (cases.cases || []);
    S.runs = runs.runs || [];
    S.loadError = null;
    if (S.real && !S.runs.some(r => r.name === S.real.run)) S.real = null;
    await RD.loadPolicies(S, api);
  } catch (e) { S.loadError = e.message; }   // keep the last good state on screen
}

// The "Working…" line and the disabled buttons while a tilekit command runs.
function paintWorking() {
  const on = S.busy || working > 0;
  $('working').hidden = !on;
  for (const b of document.querySelectorAll('#left button, #rightbar button')) {
    if (b.classList.contains('agent-stop') || b.classList.contains('keep')) continue;
    if (on) { if (b.dataset.was === undefined) { b.dataset.was = b.disabled ? '1' : ''; b.disabled = true; } }
    else if (b.dataset.was !== undefined) { b.disabled = !!b.dataset.was; delete b.dataset.was; }
  }
}
function setWorking(on) { working = Math.max(0, working + (on ? 1 : -1)); paintWorking(); }

function selectedCase(route) {
  const sel = caseSel[route.key];
  if (sel && S.cases.some(c => c.id === sel)) return sel;
  return S.cases.length ? S.cases[0].id : null;
}

async function act(fn) {
  S.actionError = null; S.notice = null; S.busy = true; paintWorking(); render();
  try { await fn(); } catch (e) { S.actionError = e.message; }
  await refresh();
  S.busy = false;
  render();
}

// ---------------------------------------------------------------- the two bars

// Collapsed, a bar is a thin strip with its name written down it, and a word when something in it needs attention.
function paintStrips() {
  $('leftname').textContent = leftName;
  const la = $('leftattn'); la.hidden = !blocked; la.textContent = blocked ? 'blocked' : '';
  const a = agent.attention();
  const ra = $('rightattn'); ra.hidden = !a; ra.textContent = a || '';
}

function paintBars() {
  $('left').classList.toggle('collapsed', !bars.left);
  $('rightbar').classList.toggle('collapsed', !bars.right);
  // "Working…" and the error line live at the top of the left bar; with it collapsed they show above the spreadsheet instead
  const slot = bars.left ? $('leftmsgs') : $('centermsgs');
  if ($('msgs').parentElement !== slot) slot.append($('msgs'));
  paintStrips();
}

// The reviewer's choice (button, strip or View menu): remembered in the settings file.
function setBar(side, on) {
  bars[side] = on;
  paintBars();
  const key = side === 'left' ? 'showLeftBar' : 'showRightBar';
  settings[key] = on;
  api.setSetting(key, on).catch(() => {});
}
function applyBarSettings(s) {
  const left = s.showLeftBar !== false;
  const right = s.showRightBar !== undefined ? !!s.showRightBar : window.innerWidth >= NARROW;
  if (left !== bars.left || right !== bars.right) { bars.left = left; bars.right = right; paintBars(); }
  api.syncBars({ left, right }).catch(() => {});
}

const sectionOpen = key => !!(settings.sections && settings.sections[key]);
function setSectionOpen(key, on) {
  settings.sections = { ...(settings.sections || {}), [key]: on };
  api.setSetting('sections', settings.sections).catch(() => {});
}

// ---------------------------------------------------------------- the centre pane: Spreadsheet, Code, Test

const levelNow = () => { const v = parseRoute().view; return v === 'tile' || v === 'module' ? v : 'model'; };
function centreOf(level) {
  const c = (settings.centre || {})[level];
  return c === 'code' || (c === 'test' && level === 'tile') ? c : 'spreadsheet';
}
function setCentre(seg) {
  const level = levelNow();
  if (!SEGS.includes(seg) || (seg === 'test' && level !== 'tile')) return;
  settings.centre = { ...(settings.centre || {}), [level]: seg };
  api.setSetting('centre', settings.centre).catch(() => {});
  void paintCentre();
}
// The grid stays alive under the code pane: only the pane in front changes, so coming back is instant.
async function paintCentre() {
  const route = parseRoute(), level = levelNow(), seg = centreOf(level);
  for (const b of document.querySelectorAll('button.seg')) b.setAttribute('aria-selected', String(b.dataset.seg === seg));
  $('seg-test').hidden = level !== 'tile';
  $('codewrap').hidden = seg === 'spreadsheet';
  if (seg === 'spreadsheet' || !S.graph || !S.status) return;
  try {
    await paintSource($('codewrap'), { seg, level, id: route.id, S, api, changed: codeWas, busy: () => S.busy || working > 0 || agent.isBusy(), repaint: paintCentre });
  } catch (e) { $('codewrap').replaceChildren(h('p', { class: 'grey' }, 'Could not show this: ' + e.message)); }
}
function trackCode() {
  for (const [n, q] of Object.entries((S.graph && S.graph.quantities) || {})) {
    if (q.kind !== 'tile' || !q.source) continue;
    const prev = codeMem.get(n);
    if (prev && prev.code !== q.source.code) codeWas.set(n, prev);
    codeMem.set(n, { code: q.source.code, line: q.source.line });
  }
}

// ---------------------------------------------------------------- render

let chain = Promise.resolve();
function render() { chain = chain.then(doRender).catch(e => { S.actionError = String(e && e.message || e); }); return chain; }

// The two rows of tabs. Row 1: Model, then one tab per module in dependency order. Row 2 (a module or one of its tiles):
// the module sheet, then one tab per tile in dependency order. Row 2 scrolls sideways and keeps the current tab in view.
const tab = (href, cls, kids, current) => h('a', { href, class: cls || null, ...(current ? { 'aria-current': 'page' } : {}) }, kids);

function paintNav(route) {
  const mods = $('mods'), tiles = $('tiles');
  if (!S.graph || !S.status) { mods.replaceChildren(tab('#/model', 'cur', 'Model', true)); tiles.hidden = true; return; }
  $('modelname').textContent = S.graph.model.name || '';
  const q = route.view === 'tile' ? L.q(S, route.id) : null;
  const curMod = route.view === 'module' ? L.moduleOf(S, route.id) : (q && q.kind === 'tile' ? L.moduleOf(S, q.module) : null);
  const m1 = mods.scrollLeft;
  mods.replaceChildren(tab('#/model', !curMod ? 'cur' : '', 'Model', !curMod),
    ...L.orderedModules(S).map(m => {
      const ms = S.status.modules[m.id] || {};
      return tab('#/module/' + encodeURIComponent(m.id), curMod && curMod.id === m.id ? 'cur' : '', [m.title, h('small', {}, `${ms.tiles_signed_off ?? 0} of ${ms.tiles_total ?? m.tiles.length}`)], curMod && curMod.id === m.id);
    }));
  mods.scrollLeft = m1;
  keepInView(mods);
  tiles.hidden = !curMod;
  if (!curMod) return;
  const before = tiles.dataset.mod === curMod.id ? tiles.scrollLeft : 0;
  tiles.dataset.mod = curMod.id;
  const onSheet = route.view === 'module';
  const ordered = L.orderedTiles(S, curMod);
  const uses = (later, earlier) => ((L.q(S, later) || {}).args || []).includes(earlier);
  const inputs = (curMod.inputs || []).filter(i => (L.q(S, i) || {}).kind === 'input');
  const arrow = on => h('span', { class: 'arr' }, on ? '\u2192' : '');
  const strip = [
    h('a', { href: '#/module/' + encodeURIComponent(curMod.id), class: 'sheet' + (onSheet ? ' cur' : ''), ...(onSheet ? { 'aria-current': 'page' } : {}) },
      [h('b', {}, 'Module sheet'), h('i', {}, `all ${curMod.tiles.length} linked`)]),
    h('span', { class: 'vr' }),
    h('span', { class: 't io' }, [h('b', {}, 'inputs'), h('i', {}, inputs.length > 2 ? `${inputs.length} series` : (inputs.join(', ') || 'parameters'))]),
  ];
  strip.push(arrow(ordered.length > 0 && (L.q(S, ordered[0]).args || []).some(a => !((L.q(S, a) || {}).kind === 'tile'))));
  ordered.forEach((t, i) => {
    const st = (L.tileStatus(S, t) || {}).state;
    const cur = route.view === 'tile' && route.id === t;
    const cls = ['t', cur ? 'cur' : '', st === 'stale' ? 'stale' : '', st === 'not_built' ? 'notbuilt' : ''].filter(Boolean).join(' ');
    if (i) strip.push(arrow(uses(t, ordered[i - 1])));
    strip.push(h('a', { href: '#/tile/' + encodeURIComponent(t), class: cls, ...(cur ? { 'aria-current': 'page' } : {}) }, [h('b', {}, t), h('i', {}, L.mapWord(st))]));
  });
  const proposed = (S.drafts || []).filter(d => d.kind === 'tiles' && (d.module === curMod.id || (d.scope && d.scope.level === 'module' && d.scope.id === curMod.id)))
    .flatMap(d => d.items || []).filter(p => !L.q(S, p.name));
  proposed.forEach(p => {
    strip.push(arrow(uses(p.name, ordered[ordered.length - 1]) || (p.args || []).includes(ordered[ordered.length - 1])));
    strip.push(h('span', { class: 't notbuilt' }, [h('b', {}, p.name), h('i', {}, 'proposed')]));
  });
  const nexts = (curMod.feeds || []).map(f => L.moduleOf(S, f)).filter(Boolean);
  nexts.forEach((m, i) => {
    strip.push(arrow(i === 0));
    strip.push(h('a', { href: '#/module/' + encodeURIComponent(m.id), class: 't io next' }, [h('b', {}, m.title), h('i', {}, 'next module')]));
  });
  tiles.replaceChildren(...strip);
  tiles.scrollLeft = before;
  keepInView(tiles);
}
function keepInView(nav) {
  const cur = nav.querySelector('a.cur');
  if (!cur) return;
  const left = cur.offsetLeft, right = left + cur.offsetWidth;
  if (left < nav.scrollLeft) nav.scrollLeft = Math.max(0, left - 14);
  else if (right > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = right - nav.clientWidth + 14;
}

async function renderLaunch() {
  document.body.classList.add('launching');
  $('launch').hidden = false;
  routeKey = 'launch';
  $('error').hidden = true; $('notice').hidden = true;
  const msg = $('launchmsg');
  await paintLaunch($('launchpage'), { notice: t => { msg.textContent = t || ''; msg.hidden = !t; } });
}

async function doRender() {
  const route = parseRoute();
  if (route.view === 'launch' || !openModel) { if (route.view !== 'launch') { location.hash = '#/launch'; return; } return renderLaunch(); }
  document.body.classList.remove('launching');
  $('launch').hidden = true;
  if (routeKey === 'launch') await refresh();   // coming back from the launch page: the model may have changed meanwhile
  const panel = $('panel'), lpin = $('lpin');
  const errLine = S.actionError || S.loadError;
  $('error').hidden = !errLine; $('error').textContent = errLine || '';
  $('notice').hidden = !S.notice; $('notice').textContent = S.notice || '';
  paintWorking();
  if (!S.graph || !S.status) {
    paintNav(route); panel.replaceChildren(h('p', {}, 'The model could not be loaded.'),
      h('button', { type: 'button', id: 'retry', onclick: () => act(async () => {}) }, 'Try again'));
    lpin.replaceChildren();
    return;
  }

  const ctx = {
    S, act, busy: () => S.busy || working > 0 || agent.isBusy(), reviewer, reviewerName: () => reviewerName || '', api, setWorking,
    pendingDrafts: () => S.drafts || [],
    real: () => S.real,
    selectPolicy: (run, policy, mp) => { S.real = { run, policy, mp }; render(); },
    fail: m => { S.actionError = m; render(); },
    afterRun: async name => { RD.R.run = name; RD.R.offset = 0; RD.R.data = null; realCache.clear(); await act(async () => {}); },
    afterPromote: async v => {
      S.real = null; realCache.clear();
      await act(async () => {});
      S.notice = `Case ${v.name || v.id} created. Tiles that were signed off show it as a new case to review.`; render();
    },
    panelWidth: () => LEFT_W - 32,
    sectionOpen, setSectionOpen,
    selectedCase: () => selectedCase(route),
    selectCase: id => { caseSel[route.key] = id; S.real = null; render(); grid.forceActivate(caseCandidates(id)); },
  };
  let nodes, workbook = null, state = null, buildArgs = null, candidates = [], current = true;
  if (route.view === 'tile' && L.q(S, route.id) && L.q(S, route.id).kind === 'tile') {
    const st = L.tileStatus(S, route.id);
    nodes = tileView(ctx, route.id); workbook = st.workbook; state = st.state; buildArgs = ['--tile', route.id]; current = st.workbook_current !== false;
    candidates = caseCandidates(selectedCase(route));
  } else if (route.view === 'module' && L.moduleOf(S, route.id)) {
    const ms = S.status.modules[route.id];
    nodes = moduleView(ctx, route.id); workbook = ms.workbook; state = ms.state; buildArgs = ['--module', route.id]; current = ms.workbook_current !== false;
    candidates = caseCandidates(selectedCase(route));
  } else if (route.view === 'model' || !route.id) {
    nodes = modelView(ctx); workbook = S.status.model.workbook; state = S.status.model.state; buildArgs = ['--whole-model']; current = S.status.model.workbook_current !== false;
  } else {
    S.actionError = `Unknown ${route.view}: ${route.id}`;
    $('error').hidden = false; $('error').textContent = S.actionError;
    location.hash = '#/model';
    return;
  }

  // the left bar scrolls; the signature block is pinned below it. Scrolling keeps its place across a refresh of the same view.
  const same = routeKey === route.key;
  const top = same ? panel.scrollTop : 0;
  routeKey = route.key;
  const view = agent.saveView();
  panel.replaceChildren(...nodes.left, ...nodes.right);
  lpin.replaceChildren(...nodes.pin);
  panel.scrollTop = top;
  trackCode();
  agent.restoreView(view);
  leftName = route.view === 'tile' ? 'Tile' : route.view === 'module' ? 'Module' : 'Model';
  blocked = !!nodes.blocked;
  paintStrips();
  paintNav(route);
  await paintCentre();

  const real = S.real;
  if (real) {
    const sentence = $('sentence');
    if (sentence) sentence.textContent += ` Showing real data: policy ${real.policy}, run ${real.run}.`;
  }
  paintWorking();

  // right half
  const nog = $('nogrid');
  const bar = $('stalebar');
  const rbar = $('realbar');
  if (real) {
    // A real policy: build its workbook for this view (under real-data/) and show it. Sign-off is not involved.
    bar.hidden = true; spec.clear();
    rbar.hidden = false;
    rbar.replaceChildren(RD.REAL_LINE + ' ',
      h('button', { type: 'button', id: 'promote', disabled: S.busy, onclick: () => RD.promoteDialog(ctx, S.real) }, 'Promote to case…'),
      h('button', { type: 'button', id: 'backtocases', disabled: S.busy, onclick: () => { S.real = null; render(); } }, 'Back to cases'));
    const key = [real.run, real.policy, ...buildArgs].join('|');
    let wb = realCache.get(key), err = null;
    if (!wb) {
      setWorking(true);
      try {
        const res = await api.tk('build', ['--run', real.run, '--policy', real.policy, ...buildArgs]);
        wb = res.built && res.built[0] && res.built[0].workbook;
        if (!wb) err = 'No workbook came back.';
        else realCache.set(key, wb);
      } catch (e) { err = e.message; }
      setWorking(false);
    }
    if (S.real !== real) return;     // the selection changed while building; a newer render follows
    if (err) {
      await grid.hide();
      nog.hidden = false; nog.replaceChildren(h('p', {}, 'The real-data workbook could not be built: ' + err));
    } else {
      try { await grid.show(wb, ['Policy ' + real.policy]); nog.hidden = true; }
      catch (e) { await grid.hide(); nog.hidden = false; nog.replaceChildren(h('p', {}, 'The workbook could not be opened: ' + e.message)); }
    }
    paintWorking();
    return;
  }
  rbar.hidden = true;
  if (route.view !== 'tile' || state === 'unbuilt' || state === 'not_built' || !workbook) spec.clear();
  if (current || state === 'unbuilt' || !workbook) bar.hidden = true;
  else {
    bar.hidden = false;
    bar.replaceChildren('This workbook is out of date. Rebuild to see current numbers. ',
      h('button', { type: 'button', id: 'rebuildbar', disabled: S.busy, onclick: () => act(() => api.tk('build', [...buildArgs, '--force'])) }, 'Rebuild'));
  }
  if (state === 'not_built') {
    bar.hidden = true;
    await grid.hide();
    nog.hidden = false; nog.replaceChildren(h('p', {}, 'No workbook: this tile is not built yet.'));
  } else if (state === 'unbuilt' || !workbook) {
    await grid.hide();
    nog.hidden = false; nog.replaceChildren(
      h('p', {}, 'No workbook yet'),
      h('button', { type: 'button', id: 'build', disabled: S.busy, onclick: () => act(() => api.tk('build', buildArgs)) }, 'Build'));
  } else {
    try {
      let wbs = route.view === 'model' && S.status.model.workbooks;
      if (wbs && selectedCase(route) && !wbs[selectedCase(route)]) {
        // The model workbook is stored per case and built on demand.
        setWorking(true);
        try { await api.tk('build', ['--whole-model', '--case', selectedCase(route)]); await refresh(); wbs = S.status.model.workbooks; }
        finally { setWorking(false); }
      }
      if (wbs && selectedCase(route) && wbs[selectedCase(route)]) await grid.show(wbs[selectedCase(route)], candidates);
      else if (route.view === 'model' && S.cases.length && selectedCase(route) !== S.cases[0].id) {
        // review/model/workbook.xlsx is the default case; others are workbook-<case id>.xlsx
        const alt = workbook.replace(/workbook\.xlsx$/, `workbook-${selectedCase(route)}.xlsx`);
        try { await grid.show(alt, candidates); } catch { await grid.show(workbook, candidates); }
      } else await grid.show(workbook, candidates);
      nog.hidden = true;
      if (route.view === 'tile') { spec.repaint(); void spec.capture(); }
    } catch (e) {
      nog.hidden = false;
      nog.replaceChildren(h('p', {}, 'The workbook could not be opened: ' + e.message));
      await grid.hide();
    }
  }
  paintWorking();
}

function caseCandidates(id) {
  const c = S.cases.find(x => x.id === id);
  return c ? [c.name, c.id].filter(Boolean) : [];
}

// ---------------------------------------------------------------- boot

async function boot() {
  $('back').addEventListener('click', () => history.back());
  $('forward').addEventListener('click', () => history.forward());
  $('hideleft').addEventListener('click', () => setBar('left', false));
  $('hideright').addEventListener('click', () => setBar('right', false));
  $('leftstrip').addEventListener('click', () => setBar('left', true));
  $('rightstrip').addEventListener('click', () => setBar('right', true));
  $('rightbar').insertBefore(agent.section, $('rightstrip'));
  $('rightbar').insertBefore(agent.unavailable, $('rightstrip'));
  agent.onLogChange(paintStrips);
  for (const b of document.querySelectorAll('button.seg')) b.addEventListener('click', () => setCentre(b.dataset.seg));
  // Cmd/Ctrl+1, 2, 3 choose Spreadsheet, Code, Test (the View menu has the same items)
  window.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || !['1', '2', '3'].includes(e.key)) return;
    e.preventDefault(); setCentre(SEGS[+e.key - 1]);
  });
  const needId = () => { if (openModel && openModel.id) return openModel.id; S.actionError = 'This model is not in your list of models.'; render(); return null; };
  if (api.onMenu) api.onMenu(a => {
    if (a === 'newModel') void newModelDialog();
    else if (a === 'commit') { const id = needId(); if (id) void commitDialog(id, async () => {}); }
    else if (a === 'modelSettings') { const id = needId(); if (id) void settingsDialog(id, async () => {}); }
    else if (a.startsWith('centre:') && openModel) setCentre(a.slice(7));
  });
  window.addEventListener('hashchange', () => render());
  try { openModel = await api.launch.current(); } catch { openModel = null; }
  if (!location.hash || (!openModel && !location.hash.startsWith('#/launch'))) location.hash = openModel ? '#/model' : '#/launch';
  grid = createGrid($('gridhost'), { author: await reviewer(), settings: () => settings, onError: m => { S.actionError = m; render(); }, onEdit: info => spec && spec.onEdit(info) });
  spec = createSpecLine({
    bar: $('sheetbar'), grid, enabled: () => !!api.agent,
    tile: () => { const r = parseRoute(); return r.view === 'tile' && !S.real ? r.id : null; },
    caseId: sheet => (S.cases.find(c => (c.name || c.id) === sheet) || {}).id || null,
    canSend: () => !!api.agent && !agent.isBusy(),
    send: (text, extra) => agent.send(text, extra),
  });
  agent.configure({
    afterTurn: async () => { await refresh(); await render(); },
    draftsChanged: async () => { await refresh(); await render(); },
    onBusy: () => { render(); },
    titleOf: sc => sc.level === 'model' ? 'Model' : sc.level === 'module' ? ((L.moduleOf(S, sc.id) || {}).title || sc.id) : sc.id,
    reviewer: () => reviewer(),
  });
  window.__app = { S, RD, current: () => openModel, render, bars, setBar, setCentre, centre: () => centreOf(levelNow()), settings: () => settings, refresh, grid, route: parseRoute, ready: false, idle: () => chain };
  try { settings = { ...settings, ...(await api.settings()) }; } catch { /* defaults */ }
  grid.applySettings(settings);
  applyBarSettings(settings);
  if (api.onSettings) api.onSettings(s => { settings = { ...settings, ...s }; grid.applySettings(settings); applyBarSettings(settings); });
  if (openModel) await refresh();
  await render();
  window.__app.ready = true;
  if (new URLSearchParams(location.search).get('scaffold') === '1') agent.prefill(PREFILL);   // a new, empty model: the chat starts with the scaffolding request
  let timer = null;
  api.onChanged(() => {
    realCache.clear(); clearTimeout(timer);
    // Our own commands write files too; an action refreshes when it ends, so do not refresh in the middle of one.
    timer = setTimeout(async () => { if (!openModel || parseRoute().view === 'launch' || S.busy || working > 0) return; await refresh(); render(); }, 0);
  });
  void sleep;
}
boot();
