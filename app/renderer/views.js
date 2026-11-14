// The reviewer's sheet: the side bar for a tile, a module and the model. Each returns an array of nodes.
// ctx = {S, act, busy(), selectedCase(), selectCase(id), reviewerName(), real(), pendingDrafts(), panelWidth(), api, ...}
import { h, link, plainFormula, fmtDate } from './util.js';
import * as L from './logic.js';
import { moduleMap, modelMap } from './maps.js';
import * as agent from './agentlog.js';
import { policiesSection, runsSection } from './real.js';

const sec = title => h('h3', { class: 'sec' }, title);
const row = (left, right) => h('div', { class: 'row' }, h('span', {}, left), h('span', { class: 'r' }, right));
const tileHref = n => '#/tile/' + encodeURIComponent(n);
const none = text => h('p', { class: 'grey' }, text);

function checksTable(checks) {
  if (!checks || !checks.length) return none('No checks yet.');
  return h('table', { class: 'checks' }, checks.map(c => h('tr', {}, h('td', {}, c.name), h('td', {}, L.checkWord(c)))));
}

function casesSection(ctx, title, tileName) {
  const { S } = ctx;
  if (!S.cases.length) return [sec(title), none('No cases.')];
  const sel = ctx.real() ? null : ctx.selectedCase();
  return [sec(title), ...S.cases.map(c => h('div', { class: 'row' },
    h('a', { href: '#', 'data-case': c.id, title: c.purpose || '', onclick: e => { e.preventDefault(); ctx.selectCase(c.id); } }, c.name || c.id),
    h('span', { class: 'r' }, tileName ? L.caseWord(S, tileName, c, sel) : (c.id === sel ? 'shown' : ''))))];
}

// ---------------------------------------------------------------- the signature block
// What the reviewer has typed or ticked survives the re-renders that follow a refresh: it is kept here, per view.
const FORM = new Map();
const form = key => FORM.get(key) || FORM.set(key, { reviewer: null, comment: '', reason: '', ticks: {} }).get(key);

// o = {key, record, locked, lockedWhy, prepared, valuesOnly (needs a reason), boxes: [checkbox], blockers: [string],
//      buttons: [button node], signLabel, run({reviewer, comment, reason})}
// Returns the nodes to append: a spacer, the signature table and the buttons.
function signature(ctx, o) {
  const f = form(o.key);
  const reviewerBox = o.locked ? null : h('input', { type: 'text', id: 'reviewer', autocomplete: 'off', value: f.reviewer === null ? ctx.reviewerName() : f.reviewer, oninput: e => { f.reviewer = e.target.value; refresh(); } });
  const commentBox = o.locked ? null : h('textarea', { id: 'comment', rows: 2, value: f.comment, oninput: e => { f.comment = e.target.value; } });
  const reasonBox = o.valuesOnly && !o.locked ? h('textarea', { id: 'valuesonly', rows: 2, value: f.reason, oninput: e => { f.reason = e.target.value; refresh(); } }) : null;
  const rec = o.record;
  const rows = [h('tr', {}, h('th', {}, 'Prepared by'), h('td', { id: 'preparedby' }, o.prepared || ''))];
  if (o.locked) {
    rows.push(h('tr', {}, h('th', {}, 'Reviewed by'), h('td', { id: 'reviewedby' }, rec ? `${rec.reviewer || 'unknown'}, ${fmtDate(rec.at)}` : 'signed off')),
      h('tr', {}, h('th', {}, 'Comment'), h('td', {}, (rec && rec.comment) || '')));
  } else {
    rows.push(h('tr', {}, h('th', {}, 'Reviewed by'), h('td', { class: 'in' }, reviewerBox,
      ...(rec ? [h('div', { class: 'grey', style: 'padding:0 8px 4px;font-size:11px' }, `Previously signed by ${rec.reviewer || 'unknown'} on ${fmtDate(rec.at)}.`)] : []))),
      h('tr', {}, h('th', {}, 'Comment'), h('td', { class: 'in' }, commentBox)));
    if (reasonBox) rows.push(h('tr', {}, h('th', {}, 'Reason'), h('td', { class: 'in' }, reasonBox)));
  }
  const sign = h('button', { type: 'button', id: 'signoff', class: 'pri', disabled: true, onclick: async () => {
    const values = { reviewer: reviewerBox.value.trim(), comment: commentBox.value.trim(), reason: reasonBox ? reasonBox.value.trim() : undefined };
    await o.run(values);
    if (!ctx.S.actionError) FORM.delete(o.key);
  } }, o.signLabel || 'Sign off');
  function refresh() {
    let why = '';
    if (o.locked) why = o.lockedWhy || 'Already signed off.';
    else if (o.blockers.length) why = o.blockers[0];
    else if (!(o.boxes || []).every(b => b.checked)) why = 'Confirm every assumption first.';
    else if (!reviewerBox.value.trim()) why = 'Enter the reviewer name first.';
    else if (reasonBox && !reasonBox.value.trim()) why = 'Give the reason first.';
    const off = !!why || ctx.busy();
    if (sign.dataset.was !== undefined) sign.dataset.was = why ? '1' : '';   // "Working…" holds the button; keep what it will restore
    else sign.disabled = off;
    sign.title = why;
  }
  (o.boxes || []).forEach(b => b.addEventListener('change', refresh));
  refresh();
  return [h('div', { class: 'sigspacer' }), h('table', { class: 'sig' }, rows),
    h('div', { class: 'buttons' }, ...(o.buttons || []), sign)];
}

// One tick box per assumption. A tick is remembered per view and assumption text.
function assumptionBoxes(key, list, locked) {
  const f = form(key);
  const boxes = list.map(a => h('input', { type: 'checkbox', class: 'assume', disabled: locked, checked: locked || !!f.ticks[a],
    onchange: e => { f.ticks[a] = e.target.checked; } }));
  return { boxes, nodes: list.map((a, i) => h('label', { class: 'ck' }, boxes[i], h('span', {}, L.upFirst(a)))) };
}

// ---------------------------------------------------------------- tile

export function tileView(ctx, name) {
  const { S } = ctx;
  const x = L.q(S, name), st = L.tileStatus(S, name);
  const mod = L.moduleOf(S, x.module);
  const busy = ctx.busy();
  const notBuilt = st.state === 'not_built';
  const valuesOnly = L.isValuesOnly(st);
  const key = 'tile/' + name;
  const out = [];
  out.push(h('div', { class: 'ref' }, h('span', { id: 'tileref' }, L.tileRef(S, name)), ' ', h('span', { id: 'tilename' }, name)));
  out.push(h('h2', { class: 'title', id: 'tiletitle' }, x.label || name));
  out.push(h('p', { class: 'lede', id: 'sentence' }, L.tileSentence(S, name)));

  if (st.state === 'stale' && st.drift === 'formula' && st.workbook_current !== false && st.signed_formula && st.signed_formula !== x.formula) {
    out.push(h('div', { id: 'changed', class: 'changed' }, sec('Changed since sign-off'),
      h('div', {}, h('span', { class: 'lab' }, 'Was'), h('span', { class: 'was' }, plainFormula(st.signed_formula))),
      h('div', {}, h('span', { class: 'lab' }, 'Now'), h('span', { class: 'now' }, plainFormula(x.formula)))));
  }

  out.push(sec('Spec'));
  out.push(h('p', { class: 'spec' }, x.spec));
  const ut = [x.units, x.timing].filter(Boolean).map(v => L.upFirst(String(v).replace(/\.$/, '')) + '.').join(' ');
  if (ut) out.push(h('p', { class: 'grey', id: 'units' }, ut));

  if (!notBuilt) {
    out.push(sec('Formula reviewed'));
    out.push(valuesOnly
      ? h('p', { id: 'valuesonlytext' }, 'This tile cannot be written as an Excel formula, so there is no formula to check. Sign-off rests on its tests.')
      : h('div', { class: 'formula' }, plainFormula(x.formula)));
  }

  const locked = st.state === 'signed_off' && !(st.new_cases || []).length;
  const assumed = x.assumed || [];
  const ab = assumptionBoxes(key, assumed, locked);
  out.push(sec('Assumptions to confirm'));
  out.push(...(assumed.length ? ab.nodes : [none('None.')]));

  out.push(...(notBuilt
    ? [sec('Cases agreed to Python'), none('Not built yet, so no case has been run.')]
    : casesSection(ctx, 'Cases agreed to Python', name)));

  out.push(sec('Relies on'));
  const linkOr = a => L.q(S, a) && L.q(S, a).kind === 'tile' ? link(tileHref(a), a) : a;
  out.push(...(x.args.length ? x.args.map(a => row(linkOr(a), L.argWord(S, a))) : [none('None.')]));
  out.push(sec('Feeds into'));
  out.push(...((x.used_by || []).length ? x.used_by.map(a => row(linkOr(a), L.argWord(S, a))) : [none('Nothing.')]));

  // Blockers come first; the rule and difference lines are listed once even when a blocker already says them.
  const blockers = notBuilt ? ['This tile is not built yet.'] : L.tileBlockers(S, name);
  const lines = L.tileCheckLines(S, name);
  const shown = [...blockers];
  for (const l of lines) if (!shown.some(b => b.includes(l) || l.includes(b))) shown.push(l);
  out.push(sec('Checks'));
  out.push(...(shown.length ? shown.map(l => h('p', {}, l)) : [h('p', {}, 'All checks pass.')]));

  out.push(sec('Code'));
  out.push(h('pre', { class: 'code' }, (x.source && x.source.code) || ''));

  out.push(...policiesSection(ctx));
  agent.mount({ level: 'tile', id: name });
  out.push(agent.section);

  out.push(...signature(ctx, {
    key, record: st.signed_off, locked, prepared: '', valuesOnly: valuesOnly && !locked, boxes: ab.boxes, blockers: locked ? [] : blockers,
    buttons: [h('button', { type: 'button', id: 'rebuild', disabled: busy || notBuilt, onclick: () => ctx.act(() => window.api.tk('build', ['--tile', name, '--force'])) }, 'Rebuild')],
    run: v => ctx.act(() => window.api.tk('signoff', ['--tile', name, '--reviewer', v.reviewer, '--comment', v.comment, ...(valuesOnly ? ['--values-only', v.reason] : [])])),
  }));
  return out;
}

// ---------------------------------------------------------------- module

export function moduleView(ctx, id) {
  const { S } = ctx;
  const mod = L.moduleOf(S, id), ms = S.status.modules[id];
  const busy = ctx.busy();
  const out = [];
  out.push(h('div', { class: 'ref' }, h('span', { id: 'moduleref' }, L.moduleRef(mod)), h('span', { class: 'sub' }, mod.layer)));
  out.push(h('h2', { class: 'title', id: 'title' }, mod.title));
  out.push(h('p', { class: 'lede', id: 'sentence' }, L.moduleSentence(S, id)));
  out.push(sec('Tiles'));
  const pending = ctx.pendingDrafts().filter(d => d.kind === 'tiles' && d.scope && d.scope.level === 'module' && d.scope.id === id).flatMap(d => d.items || []);
  out.push(moduleMap(S, mod, ctx.panelWidth(), pending));
  out.push(sec('Module checks'));
  out.push(checksTable(ms.checks));
  const blockers = L.moduleBlockers(S, id);
  const locked = ms.state === 'signed_off';
  if (!locked && blockers.length) out.push(h('div', { class: 'blockers' }, blockers.map(b => h('p', {}, b))));
  out.push(...casesSection(ctx, 'Cases', null));
  out.push(...policiesSection(ctx));
  agent.mount({ level: 'module', id });
  out.push(agent.section);

  const notBuilt = L.notBuiltTiles(S, mod.tiles);
  const rebuild = L.needsRebuild(S, mod.tiles), modStale = L.workbookStale(ms), rebuildN = rebuild.length + (modStale ? 1 : 0), reconf = L.canReconfirm(S, mod.tiles);
  out.push(...signature(ctx, {
    key: 'module/' + id, record: ms.signed_off, locked, prepared: '', boxes: [], blockers: locked ? [] : blockers, signLabel: 'Sign off module',
    buttons: [
      h('button', { type: 'button', id: 'rebuild', disabled: busy || !rebuildN, onclick: () => ctx.act(async () => {
        // A module build writes only the module workbook, so rebuild its stale tiles first.
        for (const t of rebuild) await window.api.tk('build', ['--tile', t]);
        await window.api.tk('build', ['--module', id]);
      }) }, `Rebuild stale (${rebuildN})`),
      h('button', { type: 'button', id: 'reconfirm', disabled: busy || !reconf.length, onclick: async () => {
        const r = form('module/' + id).reviewer || ctx.reviewerName();
        ctx.act(async () => {
          const res = await window.api.tk('reconfirm', ['--reviewer', r, '--module', id]);
          const skipped = (res && res.skipped) || [];
          const lines = (Array.isArray(skipped) ? skipped : Object.entries(skipped).map(([tile, reason]) => ({ tile, reason })))
            .map(x => typeof x === 'string' ? x : `${x.tile || x.name}: ${x.reason}`);
          if (lines.length) ctx.S.notice = 'Not re-confirmed:\n' + lines.join('\n');
        });
      } }, `Re-confirm values-only (${reconf.length})`),
      ...(notBuilt.length && window.api.agent ? [h('button', { type: 'button', id: 'buildnotbuilt', disabled: busy, onclick: () => agent.buildModule(id) }, `Build not-built tiles (${notBuilt.length})`)] : []),
    ],
    run: v => ctx.act(() => window.api.tk('signoff', ['--module', id, '--reviewer', v.reviewer, '--comment', v.comment])),
  }));
  return out;
}

// ---------------------------------------------------------------- model

export function modelView(ctx) {
  const { S } = ctx;
  const busy = ctx.busy();
  const all = S.graph.modules.flatMap(m => m.tiles);
  const rebuild = L.needsRebuild(S, all);
  const rebuildN = rebuild.length + S.graph.modules.filter(m => L.workbookStale(S.status.modules[m.id])).length + (L.workbookStale(S.status.model) ? 1 : 0);
  const out = [];
  out.push(h('h2', { class: 'title', id: 'title' }, S.graph.model.name));
  out.push(h('p', { class: 'lede', id: 'sentence' }, L.modelSentence(S)));
  out.push(sec('Modules'));
  const pending = ctx.pendingDrafts().filter(d => d.kind === 'modules' && d.scope && d.scope.level === 'model').flatMap(d => d.items || []);
  out.push(modelMap(S, ctx.panelWidth(), pending));
  out.push(sec('Model checks'));
  out.push(checksTable(S.status.model.checks));
  const blockers = L.modelBlockers(S);
  const locked = S.status.model.state === 'signed_off';
  if (!locked && blockers.length) out.push(h('div', { class: 'blockers' }, blockers.map(b => h('p', {}, b))));
  out.push(...casesSection(ctx, 'Cases', null));
  out.push(...runsSection(ctx));
  out.push(...policiesSection(ctx));
  agent.mount({ level: 'model', id: null });
  out.push(agent.section);
  out.push(...signature(ctx, {
    key: 'model', record: S.status.model.signed_off, locked, prepared: '', boxes: [], blockers: locked ? [] : blockers, signLabel: 'Sign off model',
    buttons: [
      h('button', { type: 'button', id: 'rebuild', disabled: busy || !rebuildN, onclick: () => ctx.act(() => window.api.tk('build')) }, `Rebuild stale (${rebuildN})`),
      h('button', { type: 'button', id: 'runtests', disabled: busy, onclick: () => ctx.act(async () => { await window.api.tk('test'); }) }, 'Run tests'),
      h('button', { type: 'button', id: 'export', disabled: busy, onclick: () => ctx.act(async () => { await window.api.exportWorkbook(); }) }, 'Export workbook'),
    ],
    run: v => ctx.act(() => window.api.tk('signoff', ['--whole-model', '--reviewer', v.reviewer, '--comment', v.comment])),
  }));
  return out;
}
