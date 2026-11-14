import { h, link, sleep } from './util.js';
import * as L from './logic.js';
import { createGrid } from './grid.js';
import { tileView, moduleView, modelView } from './views.js';
import * as agent from './agentlog.js';
import * as RD from './real.js';
import { createSpecLine } from './specline.js';

const api = window.api;
const S = { graph: null, status: null, cases: [], runs: [], drafts: [], real: null, notice: null, actionError: null, loadError: null, busy: false };
let working = 0;                // tilekit commands in flight that are not part of act()
const realCache = new Map();    // run|policy|target -> workbook path of the real-data build
const caseSel = {};          // route key -> selected case id
let routeKey = null;
let reviewerName = null;
let grid;
let spec = null;
let settings = { showRibbon: false, showFormulaBar: true };

const $ = id => document.getElementById(id);

function parseRoute() {
  const m = /^#\/(model|module|tile)(?:\/(.+))?$/.exec(location.hash);
  if (!m) return { view: 'model', id: null, key: 'model' };
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
  for (const b of document.querySelectorAll('#left button, #right button')) {
    if (b.classList.contains('agent-stop')) continue;
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

// ---------------------------------------------------------------- render

let chain = Promise.resolve();
function render() { chain = chain.then(doRender).catch(e => { S.actionError = String(e && e.message || e); }); return chain; }

function crumbs(route) {
  const box = $('crumbs'); box.textContent = '';
  const parts = [];
  if (!S.graph) { box.append('Model'); return; }
  const here = (node) => { node.classList.add('here'); return node; };
  if (route.view === 'model') parts.push(here(h('span', {}, 'Model')));
  else {
    parts.push(link('#/model', 'Model', 'grey'));
    const mod = route.view === 'module' ? L.moduleOf(S, route.id) : (L.q(S, route.id) && L.moduleOf(S, L.q(S, route.id).module));
    if (mod) {
      parts.push(link('#/model', mod.layer, 'grey'));
      parts.push(route.view === 'module' ? here(h('span', {}, mod.title)) : link('#/module/' + encodeURIComponent(mod.id), mod.title, 'grey'));
    }
    if (route.view === 'tile') parts.push(here(h('span', { class: 'mono' }, route.id)));
  }
  parts.forEach((p, i) => { if (i) box.append(h('span', { class: 'sep' }, '/')); box.append(p); });
}

async function doRender() {
  const route = parseRoute();
  const panel = $('panel'), left = $('left');
  const errLine = S.actionError || S.loadError;
  $('error').hidden = !errLine; $('error').textContent = errLine || '';
  $('notice').hidden = !S.notice; $('notice').textContent = S.notice || '';
  paintWorking();
  if (!S.graph || !S.status) {
    crumbs(route); panel.replaceChildren(h('p', {}, 'The model could not be loaded.'),
      h('button', { type: 'button', id: 'retry', onclick: () => act(async () => {}) }, 'Try again'));
    return;
  }

  const ctx = {
    S, act, busy: () => S.busy || working > 0 || agent.isBusy(), reviewer, api, setWorking,
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
    panelWidth: () => Math.max(320, left.clientWidth - 30),
    selectedCase: () => selectedCase(route),
    selectCase: id => { caseSel[route.key] = id; S.real = null; render(); grid.forceActivate(caseCandidates(id)); },
  };
  let nodes, workbook = null, state = null, buildArgs = null, candidates = [], current = true;
  if (routeKey !== route.key) agent.unmount();
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

  const top = routeKey === route.key ? left.scrollTop : 0;
  routeKey = route.key;
  const view = agent.saveView();
  panel.replaceChildren(...nodes);
  left.scrollTop = top;
  agent.restoreView(view);
  crumbs(route);

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
  window.addEventListener('hashchange', () => render());
  if (!location.hash) location.hash = '#/model';
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
  });
  window.__app = { S, RD, render, settings: () => settings, refresh, grid, route: parseRoute, ready: false, idle: () => chain };
  try { settings = { ...settings, ...(await api.settings()) }; } catch { /* defaults */ }
  grid.applySettings(settings);
  if (api.onSettings) api.onSettings(s => { settings = { ...settings, ...s }; grid.applySettings(settings); });
  await refresh();
  await render();
  window.__app.ready = true;
  let timer = null;
  api.onChanged(() => {
    realCache.clear(); clearTimeout(timer);
    // Our own commands write files too; an action refreshes when it ends, so do not refresh in the middle of one.
    timer = setTimeout(async () => { if (S.busy || working > 0) return; await refresh(); render(); }, 0);
  });
  void sleep;
}
boot();
