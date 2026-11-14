// Left-hand panels. Each returns an array of nodes. ctx = {S, act, selectedCase, selectCase, reviewer}
import { h, link, plainFormula, fmtDate } from './util.js';
import * as L from './logic.js';
import { moduleMap, modelMap } from './maps.js';
import { signoffDialog } from './dialog.js';
import * as agent from './agentlog.js';
import { policiesSection, runsSection } from './real.js';

const sec = title => h('h3', { class: 'sec' }, title);
const row = (left, right) => h('div', { class: 'row' }, h('span', {}, left), h('span', { class: 'r' }, right));
const tileHref = n => '#/tile/' + encodeURIComponent(n);
const moduleHref = id => '#/module/' + encodeURIComponent(id);

function checksTable(checks) {
  if (!checks || !checks.length) return h('p', { class: 'grey' }, 'No checks yet.');
  return h('table', { class: 'checks' }, checks.map(c => h('tr', {}, h('td', {}, c.name), h('td', {}, L.checkWord(c)))));
}

function casesSection(ctx, tileName) {
  const { S } = ctx;
  if (!S.cases.length) return [sec('Cases'), h('p', { class: 'grey' }, 'No cases.')];
  const sel = ctx.real() ? null : ctx.selectedCase();
  return [sec('Cases'), ...S.cases.map(c => h('div', { class: 'row' },
    h('a', { href: '#', 'data-case': c.id, title: c.purpose || '', onclick: e => { e.preventDefault(); ctx.selectCase(c.id); } }, c.name || c.id),
    h('span', { class: 'r' }, c.id === sel ? 'shown' : (tileName ? L.caseResult(S, tileName, c) : '')))), ...policiesSection(ctx)];
}

export function tileView(ctx, name) {
  const { S } = ctx;
  const x = L.q(S, name), st = L.tileStatus(S, name);
  const mod = L.moduleOf(S, x.module);
  const busy = ctx.busy();
  const notBuilt = st.state === 'not_built';
  const out = [];
  out.push(h('div', { class: 'path' }, link('#/model', mod.layer, 'grey'), ' / ', link(moduleHref(mod.id), mod.title, 'grey')));
  out.push(h('div', { class: 'name', id: 'tilename' }, name));
  out.push(h('p', { class: 'sentence', id: 'sentence' }, L.tileSentence(S, name)));
  if (st.state === 'signed_off' && (st.new_cases || []).length && st.signed_off) {
    out.push(h('p', { class: 'grey' }, `Signed off by ${st.signed_off.reviewer || 'unknown'} on ${fmtDate(st.signed_off.at)}.`));
  }
  if (st.state === 'stale' && st.drift === 'formula' && st.workbook_current !== false && st.signed_formula && st.signed_formula !== x.formula) {
    out.push(h('div', { id: 'changed', class: 'changed' }, sec('Changed since sign-off'),
      h('div', {}, h('span', { class: 'lab' }, 'Was'), h('span', { class: 'was' }, plainFormula(st.signed_formula))),
      h('div', {}, h('span', { class: 'lab' }, 'Now'), h('span', { class: 'now' }, plainFormula(x.formula)))));
  }

  out.push(sec('Spec'));
  out.push(h('div', {}, x.label));
  out.push(h('p', {}, x.spec));
  if (!L.isValuesOnly(st) && st.state !== 'not_built' && x.formula) out.push(h('div', { class: 'formula' }, plainFormula(x.formula)));
  const up1 = s => s ? s[0].toUpperCase() + s.slice(1) : '';
  const ut = [x.units, x.timing].filter(Boolean).map(v => up1(String(v).replace(/\.$/, '')) + '.').join(' ');
  if (ut) out.push(h('p', { class: 'grey', id: 'units' }, ut));
  if ((x.assumed || []).length) {
    out.push(h('p', {}, 'Assumed, to confirm at sign-off:'), h('ol', {}, x.assumed.map(a => h('li', {}, a))));
  }

  out.push(sec('Inputs'));
  out.push(...(x.args.length ? x.args.map(a => row(L.q(S, a) && L.q(S, a).kind === 'tile' ? link(tileHref(a), a) : a, L.argWord(S, a))) : [h('p', { class: 'grey' }, 'None.')]));
  out.push(sec('Feeds into'));
  out.push(...((x.used_by || []).length ? x.used_by.map(a => row(L.q(S, a) && L.q(S, a).kind === 'tile' ? link(tileHref(a), a) : a, L.argWord(S, a))) : [h('p', { class: 'grey' }, 'Nothing.')]));

  out.push(...casesSection(ctx, name));

  out.push(sec('Code'));
  out.push(h('pre', { class: 'code' }, (x.source && x.source.code) || ''));

  out.push(sec('Checks'));
  const lines = L.tileCheckLines(S, name);
  out.push(...(lines.length ? lines.map(l => h('p', {}, l)) : [h('p', {}, 'All checks pass.')]));

  out.push(h('div', { class: 'buttons' },
    h('button', { type: 'button', id: 'rebuild', disabled: busy || notBuilt, onclick: () => ctx.act(() => window.api.tk('build', ['--tile', name, '--force'])) }, 'Rebuild'),
    h('button', { type: 'button', id: 'signoff', disabled: busy || notBuilt, onclick: () => tileSignoff(ctx, name) }, 'Sign off…')));
  agent.mount({ level: 'tile', id: name });
  out.push(agent.section);
  return out;
}

async function tileSignoff(ctx, name) {
  const { S } = ctx;
  const x = L.q(S, name), st = L.tileStatus(S, name);
  const blockers = L.tileBlockers(S, name);
  const up = L.upstreamUnsigned(S, name);
  const sections = [
    sec('Spec and formula'),
    h('div', {}, x.label), h('p', {}, x.spec), L.isValuesOnly(st) ? null : h('div', { class: 'formula' }, plainFormula(x.formula)),
    sec('Cases covered'),
    h('ul', {}, S.cases.map(c => h('li', {}, (c.name || c.id) + ((st.new_cases || []).includes(c.id) ? ' (new)' : '')))),
  ];
  if (st.state === 'signed_off') sections.push(h('p', { class: 'grey' }, `Already signed off by ${st.signed_off.reviewer} on ${fmtDate(st.signed_off.at)}. Confirming records a new sign-off.`));
  const valuesOnly = L.isValuesOnly(st);
  const r = await signoffDialog({
    title: `Sign off tile ${name}`, sections, blockers, assumptions: x.assumed || [],
    warnings: up.map(u => `Upstream tile ${u} is not signed off.`), reviewer: await ctx.reviewer(),
    ...(valuesOnly ? { valuesOnly: 'This tile cannot be written as an Excel formula, so there is no formula to check. Sign-off rests on its tests.' } : {}),
  });
  if (!r) return;
  ctx.act(() => window.api.tk('signoff', ['--tile', name, '--reviewer', r.reviewer, '--comment', r.comment, ...(valuesOnly ? ['--values-only', r.valuesOnly] : [])]));
}

export function moduleView(ctx, id) {
  const { S } = ctx;
  const mod = L.moduleOf(S, id), ms = S.status.modules[id];
  const busy = ctx.busy();
  const out = [];
  out.push(h('div', { class: 'path' }, link('#/model', mod.layer, 'grey')));
  out.push(h('div', { class: 'title15', id: 'title' }, mod.title));
  out.push(h('p', { class: 'sentence', id: 'sentence' }, L.moduleSentence(S, id)));
  out.push(sec('Tiles'));
  const pending = ctx.pendingDrafts().filter(d => d.kind === 'tiles' && d.scope && d.scope.level === 'module' && d.scope.id === id).flatMap(d => d.items || []);
  out.push(moduleMap(S, mod, ctx.panelWidth(), pending));
  out.push(...casesSection(ctx, null));
  out.push(sec('Module checks'));
  out.push(checksTable(ms.checks));
  const notBuilt = L.notBuiltTiles(S, mod.tiles);
  const rebuild = L.needsRebuild(S, mod.tiles), modStale = L.workbookStale(ms), rebuildN = rebuild.length + (modStale ? 1 : 0), reconf = L.canReconfirm(S, mod.tiles);
  out.push(h('div', { class: 'buttons' },
    h('button', { type: 'button', id: 'rebuild', disabled: busy || !rebuildN, onclick: () => ctx.act(async () => {
      // A module build writes only the module workbook, so rebuild its stale tiles first.
      for (const t of rebuild) await window.api.tk('build', ['--tile', t]);
      await window.api.tk('build', ['--module', id]);
    }) }, `Rebuild stale (${rebuildN})`),
    h('button', { type: 'button', id: 'reconfirm', disabled: busy || !reconf.length, onclick: async () => {
      const r = await ctx.reviewer();
      ctx.act(async () => {
        const res = await window.api.tk('reconfirm', ['--reviewer', r, '--module', id]);
        const skipped = (res && res.skipped) || [];
        const lines = (Array.isArray(skipped) ? skipped : Object.entries(skipped).map(([tile, reason]) => ({ tile, reason })))
          .map(x => typeof x === 'string' ? x : `${x.tile || x.name}: ${x.reason}`);
        if (lines.length) ctx.S.notice = 'Not re-confirmed:\n' + lines.join('\n');
      });
    } }, `Re-confirm values-only (${reconf.length})`),
    h('button', { type: 'button', id: 'signoff', disabled: busy, onclick: () => moduleSignoff(ctx, id) }, 'Sign off module…'),
    ...(notBuilt.length && window.api.agent ? [h('button', { type: 'button', id: 'buildnotbuilt', disabled: busy, onclick: () => agent.buildModule(id) }, `Build not-built tiles (${notBuilt.length})`)] : [])));
  agent.mount({ level: 'module', id });
  out.push(agent.section);
  return out;
}

async function moduleSignoff(ctx, id) {
  const { S } = ctx;
  const mod = L.moduleOf(S, id), ms = S.status.modules[id];
  const sections = [
    sec('Tiles'),
    h('ul', {}, mod.tiles.map(t => h('li', {}, `${t}: ${L.mapWord((L.tileStatus(S, t) || {}).state)}`))),
    sec('Module checks'),
    checksTable(ms.checks),
    sec('Cases covered'),
    h('ul', {}, S.cases.map(c => h('li', {}, c.name || c.id))),
  ];
  const r = await signoffDialog({ title: `Sign off module ${mod.title}`, sections, blockers: L.moduleBlockers(S, id),
    warnings: (ms.checks || []).filter(c => !c.pass && !c.stale).map(c => `Module check fails: ${c.name}.`), reviewer: await ctx.reviewer() });
  if (!r) return;
  ctx.act(() => window.api.tk('signoff', ['--module', id, '--reviewer', r.reviewer, '--comment', r.comment]));
}

export function modelView(ctx) {
  const { S } = ctx;
  const busy = ctx.busy();
  const all = S.graph.modules.flatMap(m => m.tiles);
  const rebuild = L.needsRebuild(S, all);
  const rebuildN = rebuild.length + S.graph.modules.filter(m => L.workbookStale(S.status.modules[m.id])).length + (L.workbookStale(S.status.model) ? 1 : 0);
  const out = [];
  out.push(h('div', { class: 'path' }, 'Model'));
  out.push(h('div', { class: 'title15', id: 'title' }, S.graph.model.name));
  out.push(h('p', { class: 'sentence', id: 'sentence' }, L.modelSentence(S)));
  out.push(sec('Modules'));
  const pending = ctx.pendingDrafts().filter(d => d.kind === 'modules' && d.scope && d.scope.level === 'model').flatMap(d => d.items || []);
  out.push(modelMap(S, ctx.panelWidth(), pending));
  out.push(...casesSection(ctx, null));
  out.push(...runsSection(ctx));
  out.push(sec('Model checks'));
  out.push(checksTable(S.status.model.checks));
  out.push(h('div', { class: 'buttons' },
    h('button', { type: 'button', id: 'rebuild', disabled: busy || !rebuildN, onclick: () => ctx.act(() => window.api.tk('build')) }, `Rebuild stale (${rebuildN})`),
    h('button', { type: 'button', id: 'runtests', disabled: busy, onclick: () => ctx.act(async () => { await window.api.tk('test'); }) }, 'Run tests'),
    h('button', { type: 'button', id: 'export', disabled: busy, onclick: () => ctx.act(async () => { await window.api.exportWorkbook(); }) }, 'Export workbook'),
    h('button', { type: 'button', id: 'signoff', disabled: busy, onclick: () => modelSignoff(ctx) }, 'Sign off model…')));
  agent.mount({ level: 'model', id: null });
  out.push(agent.section);
  return out;
}

async function modelSignoff(ctx) {
  const { S } = ctx;
  const sections = [
    sec('Modules'),
    h('ul', {}, S.graph.modules.map(m => h('li', {}, `${m.title}: ${L.mapWord(S.status.modules[m.id].state)}`))),
    sec('Model checks'),
    checksTable(S.status.model.checks),
  ];
  const r = await signoffDialog({ title: `Sign off model ${S.graph.model.name}`, sections, blockers: L.modelBlockers(S),
    warnings: (S.status.model.checks || []).filter(c => !c.pass && !c.stale).map(c => `Model check fails: ${c.name}.`), reviewer: await ctx.reviewer() });
  if (!r) return;
  ctx.act(() => window.api.tk('signoff', ['--whole-model', '--reviewer', r.reviewer, '--comment', r.comment]));
}
