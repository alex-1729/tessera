// The approval view: a draft the agent has proposed, laid out across the centre pane so everything to be approved can
// be read before Accept or Discard. One draft at a time, oldest first. Nothing here changes the model: only the
// Accept button does, through the same call the chat's card uses.
import { h, fmtNumber } from './util.js';
import { testCases } from './codeview.js';

function value(v, format) {
  if (typeof v !== 'number') return v === undefined || v === null ? '' : String(v);
  if (format === 'percent' || format === 'rate' || format === 'irr') return (v * 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + '%';
  if (format === 'amount') return v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (format === 'integer') return v.toLocaleString('en-GB', { maximumFractionDigits: 0 });
  return fmtNumber(v);
}

const sec = (title, n) => h('h3', { class: 'dv-sec' }, title, n === undefined ? null : h('span', { class: 'dv-count' }, String(n)));
const name = n => h('td', { class: 'dv-name' }, n || '');
const head = (...cols) => h('thead', {}, h('tr', {}, cols.map(c => h('th', typeof c === 'object' ? { class: c.cls } : {}, typeof c === 'object' ? c.t : c))));
// a row, then (when there is one) a second row under it for the sentence of explanation and the code
function pair(cells, more, code) {
  const rows = [h('tr', { class: 'dv-row' }, cells)];
  if (more || code) rows.push(h('tr', { class: 'dv-more' }, h('td', { colspan: String(cells.length) },
    more ? h('div', {}, more) : null, code ? h('pre', { class: 'dv-code' }, code) : null)));
  return rows;
}
const table = (cols, rows) => h('table', { class: 'dv-table' }, head(...cols), h('tbody', {}, rows));

function dataTable(t) {
  const cols = t.columns || [], formats = t.formats || {};
  return h('table', { class: 'dv-table dv-data' }, head(...cols.map((c, i) => (i ? { t: c, cls: 'r' } : c))),
    h('tbody', {}, (t.rows || []).map(r => h('tr', {}, r.map((x, i) => h('td', { class: i ? 'r dv-val' : '' }, value(x, formats[cols[i]])))))));
}

function sections(d) {
  const items = (d.items || []).filter(it => it && typeof it === 'object');
  const out = [];
  if (d.kind === 'params') {
    out.push(sec('Parameters', items.length), table(['Parameter', 'Name', 'Units', { t: 'Default', cls: 'r' }],
      items.flatMap(it => pair([h('td', {}, it.label || it.name), name(it.name), h('td', { class: 'grey' }, it.units || ''), h('td', { class: 'r dv-val' }, value(it.default, it.format))]))));
  } else if (d.kind === 'inputs') {
    const fields = items.filter(it => it.type === 'model_point'), tables = items.filter(it => it.type === 'table'), series = items.filter(it => it.type === 'input');
    if (fields.length) out.push(sec('Model-point fields', fields.length), h('p', { class: 'dv-note' }, 'One value per policy. The example is written into the existing cases.'),
      table(['Field', 'Name', 'Format', { t: 'Example', cls: 'r' }],
        fields.flatMap(it => pair([h('td', {}, it.label || it.name), name(it.name), h('td', { class: 'grey' }, it.format || ''), h('td', { class: 'r dv-val' }, value(it.example, it.format))]))));
    for (const t of tables) out.push(sec(`Table: ${t.label || t.name}`), h('p', { class: 'dv-note' }, h('span', { class: 'dv-name' }, t.name), t.file ? `  saved as ${t.file}` : ''), dataTable(t));
    if (series.length) out.push(sec('Input series', series.length), h('p', { class: 'dv-note' }, 'One value per policy per month, worked out before any tile runs. Tiles read these, never the model-point fields directly, so a field a tile needs appears here too.'),
      table(['Series', 'Name', 'Format', 'Comes from'], series.flatMap(it => {
        // a series with no code of its own is a model-point field passed straight through, so tiles can read it
        const passed = !it.python && !it.excel && fields.some(f => f.name === it.name);
        return pair([h('td', {}, it.label || it.name), name(it.name), h('td', { class: 'grey' }, it.format || ''),
          h('td', { class: 'grey' }, passed ? 'the model-point field, as it is' : it.python || it.excel ? 'worked out' : 'a model-point field')],
          it.description, it.python || (it.excel ? it.excel : ''));
      })));
  } else if (d.kind === 'modules') {
    out.push(sec('Modules', items.length), table(['Module', 'Id', 'Layer', 'Feeds'],
      items.flatMap(it => pair([h('td', {}, it.title || it.id), name(it.id), h('td', { class: 'grey' }, it.layer || ''), h('td', { class: 'dv-name' }, (it.feeds || []).join(', '))], it.purpose))));
  } else if (d.kind === 'tiles') {
    out.push(sec(`Tiles${d.module ? ' in ' + d.module : ''}`, items.length), table(['Tile', 'Name', 'Uses', 'Units', 'Timing'],
      items.flatMap(it => pair([h('td', {}, it.label || it.name), name(it.name), h('td', { class: 'dv-name' }, (it.args || []).join(', ')), h('td', { class: 'grey' }, it.units || ''), h('td', { class: 'grey' }, it.timing || '')],
        [it.spec, ...(it.assumed || []).map(a => 'Assumed: ' + a)].filter(Boolean).join('\n')))));
    if ((d.states || []).length) out.push(sec('Carried-forward states', d.states.length),
      h('p', { class: 'dv-note' }, 'How a tile reads last month\'s value: each month the state takes the value its tile had at the end of the month before.'),
      table(['State', 'Name', 'Takes its value from', { t: 'In month 1', cls: 'r' }],
        d.states.flatMap(st => pair([h('td', {}, st.label || st.name), name(st.name), name(st.from), h('td', { class: 'r dv-val' }, value(st.initial, st.format))]))));
  } else if (d.kind === 'tests') {
    out.push(sec(`Tests to add to ${d.tile || 'the tile'}`, items.length), h('p', { class: 'dv-note' }, 'On accept they are added to the tile\'s test file and run. If one does not agree with the tile, nothing is saved and you are told which.'));
    for (const it of items) {
      const c = testCases(String(it.code || ''))[0] || { title: it.name, lead: '', working: '', checks: [] };
      out.push(h('section', { class: 'testcase' },
        h('div', { class: 'testhead' }, h('span', { class: 'testname' }, c.title), it.kind ? h('span', { class: 'grey' }, it.kind) : null),
        c.lead ? h('p', { class: 'testlead' }, c.lead) : null,
        c.caseCheck ? h('p', { class: 'dv-note' }, `Taken from case ${c.caseCheck.case}, month ${c.caseCheck.month}.`) : null,
        c.working ? h('div', { class: 'testwork' }, h('div', { class: 'srclab' }, 'Worked by hand'), h('pre', {}, c.working)) : null,
        c.checks.length ? h('div', { class: 'testchecks' }, h('div', { class: 'srclab' }, 'Will be checked against the tile'), c.checks.map(k => h('pre', { class: 'testcheck' }, k))) : null));
    }
  } else if (d.kind === 'cases') {
    for (const c of items) {
      out.push(sec(`Case: ${c.name || c.id}`), h('p', { class: 'dv-note' }, h('span', { class: 'dv-name' }, c.id || ''), c.purpose ? '  ' + c.purpose : ''),
        table(['Value', { t: '', cls: 'r' }], [...Object.entries(c.model_point || {}).map(([k, v]) => h('tr', { class: 'dv-row' }, name(k), h('td', { class: 'r dv-val' }, fmtNumber(v)))),
          ...Object.entries(c.params || {}).map(([k, v]) => h('tr', { class: 'dv-row' }, h('td', {}, h('span', { class: 'dv-name' }, k), h('span', { class: 'grey' }, '  parameter override')), h('td', { class: 'r dv-val' }, fmtNumber(v))))]));
    }
  } else {
    out.push(sec('Changes', items.length), table(['Item', 'Name'], items.flatMap(it => pair([h('td', {}, it.label || it.title || it.name || it.id || ''), name(it.name || it.id)], it.purpose || it.description || it.spec, it.code || it.formula))));
  }
  return out;
}

// drafts: the proposed drafts, oldest first. act = {accept(id), discard(id)}: each resolves when the app has refreshed.
export function draftView(drafts, act) {
  const d = drafts[0];
  const errors = h('p', { class: 'warn', id: 'dv-error' });
  const working = h('span', { class: 'grey', id: 'dv-working' });
  const buttons = () => {
    const yes = h('button', { type: 'button', class: 'primary', 'data-dv': 'accept' }, 'Accept draft');
    const no = h('button', { type: 'button', 'data-dv': 'discard' }, 'Discard');
    const run = (fn, word) => async () => {
      for (const b of document.querySelectorAll('[data-dv]')) b.disabled = true;
      errors.textContent = ''; working.textContent = word;
      try { await fn(d.id); } catch (e) { errors.textContent = String(e && e.message || e); working.textContent = ''; for (const b of document.querySelectorAll('[data-dv]')) b.disabled = false; }
    };
    yes.addEventListener('click', run(act.accept, 'Applying… this can take a few seconds.'));
    no.addEventListener('click', run(act.discard, 'Discarding…'));
    return h('div', { class: 'dv-btns' }, yes, no);
  };
  const lead = String(d.summary || '').replace(/^Draft:\s*/i, '').replace(/\s*\([^)]*\)/g, '').replace(/^./, c => c.toUpperCase());
  return h('div', { class: 'draftview', id: 'draftview', 'data-draft': d.id },
    h('div', { class: 'dv-head' },
      h('div', {}, h('div', { class: 'dv-kicker' }, drafts.length > 1 ? `Draft to approve, 1 of ${drafts.length}` : 'Draft to approve'), h('h2', { class: 'dv-title' }, lead),
        d.note ? h('p', { class: 'dv-lead' }, d.note) : null, h('p', { class: 'dv-note' }, 'Nothing is written to the model until you accept.')),
      buttons()),
    working, errors,
    ...(d.warnings || []).map(w => h('p', { class: 'warn' }, w)),
    ...sections(d),
    h('div', { class: 'dv-foot' }, buttons()));
}
