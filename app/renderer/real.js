// Real model points: the runs table, the policy list and the dialogs. Real policies are for inspection only.
import { h } from './util.js';
import { formDialog } from './dialog.js';

const PAGE = 15;
const sec = title => h('h3', { class: 'sec' }, title);
export const REAL_LINE = 'Real data. Not part of sign-off, and kept out of the repo.';

// State of the policy list. It lives here so that it survives moving between model, module and tile views.
export const R = { run: null, search: '', sort: 'index', desc: false, flag: '', offset: 0, data: null, error: null, seq: 0 };

const sentence = s => s ? s[0].toUpperCase() + s.slice(1) : s;
export function fieldLabel(S, key) {
  const x = S.graph && S.graph.quantities && S.graph.quantities[key];
  if (key === 'index') return 'File order';
  if (key === 'id') return 'Policy id';
  return (x && x.label) || sentence(String(key).replace(/_/g, ' '));
}

export function fmtValue(v) {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return 'missing';
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v)) return v.toLocaleString('en-GB');
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v).toLocaleString('en-GB');
  return String(+v.toPrecision(4));
}

export function errorLines(e, api) {
  const lines = [String(e && e.message || e)];
  const d = (e && e.detail) || (api && api.lastErrorDetail && api.lastErrorDetail());
  if (d && Array.isArray(d.bad_rows)) {
    for (const b of d.bad_rows.slice(0, 20)) lines.push(`Row ${b.row}${b.column ? ', ' + b.column : ''}: ${b.problem}`);
    const more = (d.bad_count || d.bad_rows.length) - Math.min(20, d.bad_rows.length);
    if (more > 0) lines.push(`and ${more} more.`);
  }
  return lines;
}

export function newestRun(S) {
  const runs = S.runs || [];
  if (!runs.length) return null;
  const n = S.status && S.status.runs && S.status.runs.newest;
  return runs.some(r => r.name === n) ? n : runs[runs.length - 1].name;
}

// Fetch the page of policies for the current settings. Keeps the last good list when it fails.
export async function loadPolicies(S, api) {
  const runs = S.runs || [];
  if (!runs.length) { R.data = null; R.run = null; return; }
  if (!runs.some(r => r.name === R.run)) { R.run = newestRun(S); R.offset = 0; }
  const seq = ++R.seq;
  const args = ['--run', R.run, '--limit', String(PAGE), '--offset', String(R.offset)];
  if (R.sort && R.sort !== 'index') args.push('--sort', R.sort);
  if (R.desc) args.push('--desc');
  if (R.search) args.push('--search', R.search);
  if (R.flag) args.push('--flag', R.flag);
  try {
    const d = await api.tk('policies', args);
    if (seq !== R.seq) return;
    R.data = d; R.error = null;
    if (d.policies.length === 0 && R.offset > 0 && d.total > 0) { R.offset = Math.max(0, Math.floor((d.total - 1) / PAGE) * PAGE); return loadPolicies(S, api); }
    if (d.policies.length && !R.keys) {
      R.keys = { mp: Object.keys(d.policies[0].model_point || {}), headline: Object.keys(d.policies[0].headline || {}) };
    }
  } catch (e) { if (seq === R.seq) R.error = e.message; }
}

function valueOf(p, key) {
  if (key === 'id') return '';
  if (key === 'index') return 'row ' + (p.index + 1);
  const v = key in (p.model_point || {}) ? p.model_point[key] : (p.headline || {})[key];
  return fmtValue(v);
}

// ctx: {S, api, busy(), setWorking(on), selectPolicy(run, policy, modelPoint), real() -> {run, policy} | null}
export function policiesSection(ctx) {
  const { S } = ctx;
  const runs = S.runs || [];
  if (!runs.length) return [];
  const body = h('div', { id: 'policylist' });
  const flags = (R.data && R.data.flags) || {};

  const update = async () => {
    ctx.setWorking(true);
    await loadPolicies(S, ctx.api);
    ctx.setWorking(false);
    fill();
  };
  const set = patch => { Object.assign(R, patch); return update(); };

  function fill() {
    const d = R.data;
    const nodes = [];
    if (R.error) nodes.push(h('p', { class: 'errline' }, 'Could not list the policies: ' + R.error));
    if (d) {
      if (!d.policies.length) nodes.push(h('p', { class: 'grey' }, 'No policies match.'));
      const sel = ctx.real();
      for (const p of d.policies) {
        const isSel = sel && sel.run === d.run && sel.policy === p.id;
        nodes.push(h('div', { class: 'row' },
          h('a', { href: '#', 'data-policy': p.id, class: isSel ? 'sel' : null, onclick: e => { e.preventDefault(); ctx.selectPolicy(d.run, p.id, p.model_point); } }, p.id),
          h('span', { class: 'r' }, valueOf(p, R.sort) + (isSel ? (R.sort === 'id' ? 'shown' : ', shown') : ''))));
      }
      const from = d.total ? R.offset + 1 : 0, to = R.offset + d.policies.length;
      nodes.push(h('div', { class: 'pager' },
        h('button', { type: 'button', id: 'prevpage', disabled: R.offset <= 0 || ctx.busy(), onclick: () => set({ offset: Math.max(0, R.offset - PAGE) }) }, 'Previous'),
        h('button', { type: 'button', id: 'nextpage', disabled: to >= d.total || ctx.busy(), onclick: () => set({ offset: R.offset + PAGE }) }, 'Next'),
        h('span', { class: 'grey', id: 'pagecount' }, `${from} to ${to} of ${d.total}`)));
    }
    body.replaceChildren(...nodes);
  }

  const sortKeys = ['index', 'id', ...((R.keys && R.keys.mp) || []), ...((R.keys && R.keys.headline) || [])];
  if (!sortKeys.includes(R.sort)) sortKeys.push(R.sort);
  let t = null;
  const search = h('input', { type: 'text', id: 'psearch', value: R.search, placeholder: 'Policy id', autocomplete: 'off',
    oninput: e => { clearTimeout(t); const v = e.target.value.trim(); t = setTimeout(() => set({ search: v, offset: 0 }), 350); } });
  const runSel = runs.length > 1
    ? h('select', { id: 'prun', onchange: e => set({ run: e.target.value, offset: 0 }) }, runs.map(r => h('option', { value: r.name, selected: r.name === R.run }, r.name)))
    : null;
  const sortSel = h('select', { id: 'psort', onchange: e => set({ sort: e.target.value, offset: 0 }) },
    sortKeys.map(k => h('option', { value: k, selected: k === R.sort }, fieldLabel(S, k))));
  const dir = h('select', { id: 'pdir', onchange: e => set({ desc: e.target.value === 'desc', offset: 0 }) },
    h('option', { value: 'asc', selected: !R.desc }, 'Ascending'), h('option', { value: 'desc', selected: R.desc }, 'Descending'));
  const flagSel = h('select', { id: 'pflag', onchange: e => set({ flag: e.target.value, offset: 0 }) },
    h('option', { value: '', selected: !R.flag }, 'All'),
    h('option', { value: 'uncovered', selected: R.flag === 'uncovered' }, 'Takes a branch no case covers' + (flags.uncovered !== undefined ? ` (${flags.uncovered})` : '')),
    h('option', { value: 'nan', selected: R.flag === 'nan' }, 'Has a missing value in a series' + (flags.nan !== undefined ? ` (${flags.nan})` : '')),
    h('option', { value: 'undefined', selected: R.flag === 'undefined' }, 'Has an undefined result, such as no IRR' + (flags.undefined !== undefined ? ` (${flags.undefined})` : '')));
  const run = runs.find(r => r.name === R.run) || runs[0];
  const lab = (text, el) => h('label', { class: 'ctl' }, h('span', { class: 'grey' }, text), el);
  const out = [sec('Real model points'),
    h('p', { class: 'grey' }, `Synthetic cases carry the sign-off. These are real policies, for inspection only.`),
    runSel ? lab('Run', runSel) : h('div', {}, `Run ${run.name}, ${run.policies} policies.`),
    lab('Find', search), lab('Sort by', sortSel), lab('Order', dir), lab('Show', flagSel), body];
  fill();
  if (!R.data) update();
  return out;
}

// The "Runs" section of the model view.
export function runsSection(ctx) {
  const { S } = ctx;
  const runs = S.runs || [];
  const out = [sec('Runs')];
  if (!runs.length) out.push(h('p', { class: 'grey' }, 'No runs yet.'));
  else {
    out.push(h('table', { class: 'checks runs', id: 'runs' }, h('tr', { class: 'head' }, h('td', {}, 'Name'), h('td', {}, 'Policies'), h('td', {}, 'Date'), h('td', {}, 'Current')),
      runs.map(r => h('tr', {}, h('td', {}, r.name), h('td', {}, String(r.policies)), h('td', {}, (r.at || '').slice(0, 10)),
        h('td', {}, r.current ? 'current' : 'model changed since this run')))));
  }
  const busy = ctx.busy();
  out.push(h('div', { class: 'buttons plainbtns' },
    h('button', { type: 'button', id: 'newrun', disabled: busy, onclick: () => newRun(ctx) }, 'New run…'),
    h('button', { type: 'button', id: 'sample', disabled: busy, onclick: () => samplePortfolio(ctx) }, 'Sample portfolio…')));
  return out;
}

const slug = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

async function newRun(ctx) {
  let file;
  try { file = await ctx.api.pickCsv(); } catch (e) { return ctx.fail(e.message); }
  if (!file) return;
  const base = file.split(/[\\/]/).pop().replace(/\.csv$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[^A-Za-z0-9]+/, '') || 'run';
  const r = await formDialog({
    title: 'New run', intro: ['Model points from ' + file + '.'], confirm: 'Run',
    fields: [{ id: 'name', label: 'Run name', value: base }, { id: 'idcol', label: 'Id column', value: 'policy_id' }],
    submit: async v => {
      if (!slug.test(v.name)) return ['The run name may use letters, digits, dash and underscore.'];
      try { await ctx.api.tk('run', ['--model-points', file, '--name', v.name, '--id-column', v.idcol]); } catch (e) { return errorLines(e, ctx.api); }
      return null;
    } });
  if (r) await ctx.afterRun(r.name);
}

async function samplePortfolio(ctx) {
  const r = await formDialog({
    title: 'Sample portfolio', confirm: 'Create and run',
    intro: ['This makes synthetic data for trying the feature. It is not a real portfolio. The file is written under real-data/, which is kept out of the repo.'],
    fields: [{ id: 'n', label: 'Number of policies', value: '300' }, { id: 'name', label: 'Run name', value: 'sample' }],
    submit: async v => {
      if (!/^\d+$/.test(v.n) || +v.n < 1) return ['The number of policies must be a whole number of at least 1.'];
      if (!slug.test(v.name)) return ['The run name may use letters, digits, dash and underscore.'];
      const rel = `real-data/${v.name}.csv`;
      try {
        await ctx.api.tk('sample-portfolio', ['--out', rel, '--policies', v.n]);
        await ctx.api.tk('run', ['--model-points', rel, '--name', v.name]);
      } catch (e) { return errorLines(e, ctx.api); }
      return null;
    } });
  if (r) await ctx.afterRun(r.name);
}

// Promote the policy that is on show to a synthetic case.
export async function promoteDialog(ctx, real) {
  const mp = real.mp || {};
  const rows = Object.entries(mp).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, fmtValue(v))));
  const r = await formDialog({
    title: `Promote policy ${real.policy} to a case`, confirm: 'Promote',
    intro: ['Policy values will be written to a new synthetic case, rounded to three significant figures, with ids removed. The case then needs review like any other.'],
    sections: [h('h3', { class: 'sec' }, 'Model point values'), h('table', { class: 'checks', id: 'mpvalues' }, rows)],
    fields: [
      { id: 'id', label: 'Case id', value: 'policy_' + String(real.policy).toLowerCase().replace(/[^a-z0-9]+/g, '_') },
      { id: 'name', label: 'Name', value: 'Policy ' + real.policy },
      { id: 'purpose', label: 'Purpose', value: '', multiline: true, optional: true }],
    submit: async v => {
      if (!/^[a-z0-9][a-z0-9_]*$/.test(v.id)) return ['The case id may use lower-case letters, digits and underscore.'];
      const args = ['--run', real.run, '--policy', real.policy, '--id', v.id, '--name', v.name];
      if (v.purpose) args.push('--purpose', v.purpose);
      try { await ctx.api.tk('promote', args); } catch (e) { return errorLines(e, ctx.api); }
      return null;
    } });
  if (r) await ctx.afterPromote(r);
}
