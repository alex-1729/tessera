// The launch page: one tile per model, plus the dialogs that belong to it (New model, Settings, Commit and push, Remove).
import { h, fmtDate } from './util.js';
import { formDialog } from './dialog.js';
import { repoChoice } from './newrepo.js';

const api = () => window.api;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const PREFILL = 'Scaffold this model with me. Ask me what you need to know.';   // put in the chat after a new, empty model opens

async function pickInto(input) {
  let f = null;
  try { f = await api().pickFolder(); } catch { /* cancelled */ }
  if (f) { input.value = f; input.dispatchEvent(new Event('input', { bubbles: true })); }
}

export const reviewWords = r => {
  if (r.error) return 'could not read: ' + r.error;
  if (!r.total) return 'no tiles yet';
  return `${r.signed_off} of ${plural(r.total, 'tile', 'tiles')} signed off${r.stale ? `, ${r.stale} stale` : ''}`;
};

// ---------------------------------------------------------------- the page

// root: the element that holds the page. Draws the tiles at once from the saved list, then fills in each tile's git
// state and review progress as it arrives, so nothing waits for Python.
export async function paintLaunch(root, { notice }) {
  let list = [];
  try { list = await api().launch.list(); } catch (e) { notice(e.message); }
  const cells = new Map();

  const say = text => notice(text);
  const reload = () => paintLaunch(root, { notice });

  function tile(m) {
    const link = m.github
      ? (m.web ? h('a', { href: '#', class: 'mlink', onclick: e => { e.preventDefault(); e.stopPropagation(); api().launch.openLink(m.id).catch(x => say(x.message)); } }, m.github)
        : h('span', { class: 'mlink' }, m.github))
      : h('span', { class: 'mlink grey' }, 'no GitHub link');
    const git = h('div', { class: 'mgit grey' }, 'Checking git…');
    const review = h('div', { class: 'mreview grey' }, 'Checking review progress…');
    const box = h('div', { class: 'mtile', 'data-id': m.id, role: 'button', tabindex: '0',
      onclick: () => open(m), onkeydown: e => { if (e.key === 'Enter') open(m); } },
      h('div', { class: 'mname' }, m.name),
      h('div', { class: 'mdir' }, m.dir),
      link, git, review,
      h('div', { class: 'mopened grey' }, m.lastOpened ? `Last opened ${fmtDate(m.lastOpened)}` : 'Not opened yet'));
    const btns = h('div', { class: 'mbtns' },
      h('button', { type: 'button', class: 'linkbtn', 'data-act': 'commit', onclick: () => commitDialog(m.id, reload) }, 'Commit and push…'),
      h('button', { type: 'button', class: 'linkbtn', 'data-act': 'settings', onclick: () => settingsDialog(m.id, reload) }, 'Settings…'),
      h('button', { type: 'button', class: 'linkbtn', 'data-act': 'remove', onclick: () => removeDialog(m, reload) }, 'Remove from list'));
    cells.set(m.id, { git, review });
    return h('div', { class: 'mcell' }, box, btns);
  }

  async function open(m) {
    say('');
    try { await api().launch.open(m.id); } catch (e) { say(e.message); }
  }

  const newCell = h('div', { class: 'mcell newcell' },
    h('button', { type: 'button', class: 'mtile newtile', id: 'newmodel', onclick: () => newModelDialog() }, 'New model…'),
    h('div', { class: 'mbtns' }, h('button', { type: 'button', class: 'linkbtn', id: 'addfolder', onclick: async () => {
      say('');
      try { const r = await api().launch.addFolder(); if (r) { if (r.already) say(`${r.name} is already in the list.`); await reload(); } } catch (e) { say(e.message); }
    } }, 'Add existing folder…')));

  root.replaceChildren(h('div', { id: 'launchhead' }, h('h1', {}, 'Models'), h('p', { class: 'grey' }, 'Open a model to review it, or start a new one.')),
    h('div', { id: 'models' }, list.map(tile), newCell));

  for (const m of list) {
    const c = cells.get(m.id);
    api().launch.git(m.id).then(g => { c.git.classList.remove('grey'); c.git.textContent = g.isRepo ? `${g.branch || 'no branch'}: ${g.words}` : g.words; }, e => { c.git.textContent = 'could not read git: ' + e.message; });
    api().launch.review(m.id).then(r => { c.review.classList.remove('grey'); c.review.textContent = reviewWords(r); }, e => { c.review.classList.remove('grey'); c.review.textContent = reviewWords({ error: e.message }); });
  }
}

// ---------------------------------------------------------------- dialogs

export async function removeDialog(m, then) {
  await formDialog({
    title: 'Remove from list', confirm: 'Remove', fields: [],
    intro: [`Remove ${m.name} from the list of models?`, `The folder ${m.dir} is not deleted, and nothing in it changes. You can add it again with Add existing folder.`],
    submit: async () => { await api().launch.remove(m.id); return null; } });
  await then();
}

export async function newModelDialog() {
  let stop = () => {}, repo = null;
  await formDialog({
    title: 'New model', confirm: 'Create',
    intro: ['A model is a local folder with a GitHub repository behind it. Give both. Nothing is pushed.'],
    fields: [
      { id: 'name', label: 'Model name', value: '' },
      { id: 'folder', label: 'Local folder', value: '', button: { id: 'pickfolder', text: 'Choose…', onclick: pickInto } },
      { id: 'github', label: 'GitHub repository link', value: '', optional: true, placeholder: 'https://github.com/owner/repo' }],
    // the repository: an existing one by its link, or a new one made on GitHub when the button is pressed
    onReady: check => { repo = repoChoice({ api: api(), nameInput: document.getElementById('f-name'), linkInput: document.getElementById('f-github'), confirmButton: document.getElementById('confirm'), changed: check }); },
    canSubmit: () => !repo || repo.ready(),
    submit: async (v, progress) => {
      const create = repo.mode() === 'create';
      if (!create) {
        const chk = await api().launch.checkLink(v.github);
        if (!chk.ok) return [chk.error];
      }
      if (!/^\//.test(v.folder) && !/^[A-Za-z]:[\\/]/.test(v.folder)) return ['Choose the local folder with Choose…, or type its full path.'];
      stop = api().launch.onProgress(progress);
      try { await api().launch.newModel(create ? { name: v.name, folder: v.folder, create: repo.values() } : { name: v.name, folder: v.folder, github: v.github }); }
      catch (e) {
        stop();
        const d = api().lastErrorDetail();
        if (create && d && d.link) repo.useExisting(d.link);
        return [String(e && e.message || e)];
      }
      stop();
      return null;
    } });
}

export async function settingsDialog(id, then) {
  const m = (await api().launch.list()).find(x => x.id === id);
  if (!m) return;
  await formDialog({
    title: 'Settings', confirm: 'Save',
    sections: [h('div', { class: 'field' }, h('div', { class: 'lab' }, 'Model'), h('div', { class: 'mname', id: 'settingsname' }, m.name), h('div', { class: 'mdir' }, m.dir))],
    fields: [
      { id: 'github', label: 'GitHub repository link', value: m.github, optional: true, placeholder: 'https://github.com/owner/repo' },
      { id: 'realDataDir', label: 'Real-data folder', value: m.realDataDir, optional: true, placeholder: `${m.dir}/real-data (the default)`,
        button: { id: 'pickrealdata', text: 'Choose…', onclick: pickInto } }],
    onReady: () => {
      const f = document.getElementById('f-realDataDir');
      f.closest('.field').append(h('button', { type: 'button', id: 'usedefault', class: 'linkbtn', onclick: () => { f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); } }, 'Use the default'),
        h('p', { class: 'grey small' }, 'Runs and real-policy workbooks are stored here, outside the model repository. Leave it empty to use the default.'));
    },
    submit: async v => {
      if (v.github) { const chk = await api().launch.checkLink(v.github); if (!chk.ok) return [chk.error]; }
      try { await api().launch.setSettings(id, { github: v.github, realDataDir: v.realDataDir }); } catch (e) { return [e.message]; }
      return null;
    } });
  await then();
}

export async function commitDialog(id, then) {
  let info;
  try { info = await api().launch.commitInfo(id); } catch (e) { info = { error: e.message }; }
  if (info.error || !info.isRepo) {
    await formDialog({ title: 'Commit and push', confirm: 'OK', fields: [], intro: [info.error || 'This model folder is not a git repository of its own, so there is nothing to commit here.'], submit: async () => null });
    return;
  }
  const changed = info.changed || [];
  const noChanges = changed.length === 0;
  const hasRemote = !!info.remote;
  const push = h('input', { type: 'checkbox', id: 'pushafter', ...(hasRemote ? { checked: true } : { disabled: true }) });
  const list = noChanges
    ? [h('p', { id: 'nochanges' }, 'No files have changed.' + (info.ahead ? ` ${plural(info.ahead, 'commit is', 'commits are')} not pushed.` : ''))]
    : [h('div', { class: 'lab' }, `${plural(changed.length, 'file', 'files')} changed on ${info.branch || 'no branch'}`),
      h('div', { id: 'changedfiles' }, changed.map(c => h('div', { class: 'cfile' }, h('span', { class: 'cstate' }, c.state), h('span', { class: 'cpath' }, c.path))))];
  const canPushOnly = noChanges && hasRemote && info.ahead > 0;
  await formDialog({
    title: `Commit and push: ${info.name}`, confirm: noChanges ? 'Push' : 'Commit',
    sections: [...list, h('label', { class: 'ck pushck' }, push, h('span', {}, hasRemote ? 'Push to GitHub after committing' : 'Push to GitHub after committing (this model has no remote)'))],
    fields: noChanges ? [] : [{ id: 'message', label: 'Message', value: '', multiline: true, placeholder: 'Sign off the unit projection tiles' }],
    canSubmit: () => !noChanges || canPushOnly,
    submit: async v => {
      const wantPush = push.checked && !push.disabled;
      let r;
      try { r = await api().launch.commit(id, v.message || '', wantPush || noChanges); } catch (e) { return [e.message]; }
      const out = [];
      if (r.committed) out.push(`Committed ${plural(r.committed.files, 'file', 'files')}.`);
      if (r.pushed) out.push(`Pushed to ${r.pushed.remote}.`);
      if (r.pushError) out.push(`The push did not work: ${r.pushError}`);
      return { result: out };
    } });
  await then();
}
