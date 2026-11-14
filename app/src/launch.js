'use strict';
// IPC for the launch page: the list of models, git state, review progress, New model, Add existing folder,
// Commit and push, and per-model settings. Every call names a model by its id in the app's list; a folder that is not
// in the list is never touched.
const fs = require('fs');
const path = require('path');
const git = require('./git');
const { isModelDir, readName } = require('./models');
const { createNewModel } = require('./newmodel');
const github = require('./github');
const { createModelInNewRepo } = require('./newrepo');

function registerLaunch({ ipcMain, dialog, shell, wrap, models, cfg, getWin, switchModel, mkRunner, pickFolder }) {
  const need = id => {
    const m = models.byId(String(id));
    if (!m) throw new Error('That model is not in the list.');
    return m;
  };
  const view = m => ({ id: m.id, name: m.name, dir: m.dir, github: m.github || '', web: git.webUrl(m.github), realDataDir: m.realDataDir || '', lastOpened: m.lastOpened || null, exists: isModelDir(m.dir) });
  const str = (v, n, what) => { if (typeof v !== 'string' || v.length > n || v.includes('\0')) throw new Error(`Invalid ${what}.`); return v; };

  // The one place that knows what a GitHub link looks like (the window asks, so its error matches the real check).
  ipcMain.handle('launch:checkLink', wrap(text => { const r = git.parseGithubLink(str(String(text === undefined ? '' : text), 300, 'link')); return { ok: r.ok, error: r.ok ? null : r.error }; }));
  ipcMain.handle('launch:list', wrap(() => models.list().map(view)));
  ipcMain.handle('launch:current', wrap(() => {
    if (!cfg.modelDir) return null;
    const m = models.byDir(cfg.modelDir);
    return { id: m ? m.id : null, dir: cfg.modelDir };
  }));

  // git state, filled in tile by tile
  ipcMain.handle('launch:git', wrap(async id => {
    const m = need(id);
    if (!fs.existsSync(m.dir)) return { isRepo: false, words: 'folder not found', changed: 0, ahead: 0, branch: null, remote: null };
    const st = await git.status(m.dir);
    return { isRepo: st.isRepo, words: git.stateWords(st), branch: st.branch, changed: st.changed.length, ahead: st.ahead, behind: st.behind, remote: st.remote, hasCommits: st.hasCommits };
  }));

  // review progress: `tilekit status`, two at a time so a long list does not start a dozen Python processes
  let active = 0; const waiting = [];
  const slot = () => new Promise(res => { const go = () => { active++; res(); }; if (active < 2) go(); else waiting.push(go); });
  const release = () => { active--; const n = waiting.shift(); if (n) n(); };
  ipcMain.handle('launch:review', wrap(async id => {
    const m = need(id);
    if (!isModelDir(m.dir)) throw new Error('the folder is missing or has no tilekit.toml');
    await slot();
    try {
      const st = await mkRunner(m.dir)('status');
      const t = (st.counts && st.counts.tiles) || {};
      return { total: t.total || 0, signed_off: t.signed_off || 0, stale: t.stale || 0, not_built: t.not_built || 0 };
    } finally { release(); }
  }));

  ipcMain.handle('launch:open', wrap(async id => { const m = need(id); if (!isModelDir(m.dir)) throw new Error('That folder is missing or has no tilekit.toml, so it cannot be opened.'); models.touch(m.id); await switchModel(m.dir); return true; }));
  ipcMain.handle('launch:remove', wrap(id => { models.remove(need(id).id); return true; }));
  ipcMain.handle('launch:openLink', wrap(async id => {
    const url = git.webUrl(need(id).github);
    if (!url) throw new Error('That link cannot be opened.');
    await shell.openExternal(url);
    return true;
  }));

  // settings for one model: the GitHub link and the real-data folder
  ipcMain.handle('launch:setSettings', wrap((id, v) => {
    const m = need(id);
    v = v && typeof v === 'object' ? v : {};
    const out = {};
    if (v.github !== undefined) {
      const g = str(v.github, 300, 'link').trim();
      if (g) { const p = git.parseGithubLink(g); if (!p.ok) throw new Error(p.error); }
      out.github = g;
    }
    if (v.realDataDir !== undefined) {
      const d = str(v.realDataDir, 500, 'folder').trim();
      if (d) {
        if (!path.isAbsolute(d)) throw new Error('The real-data folder must be a full path.');
        let st = null; try { st = fs.statSync(d); } catch { /* new folder */ }
        if (st && !st.isDirectory()) throw new Error('That real-data location is a file, not a folder.');
      }
      out.realDataDir = d ? path.resolve(d) : '';
    }
    return view(models.update(m.id, out));
  }));

  // Add existing folder
  ipcMain.handle('launch:addFolder', wrap(async () => {
    const dir = await pickFolder();
    if (!dir) return null;
    if (!isModelDir(dir)) throw new Error('That folder has no tilekit.toml, so it is not a model.');
    const have = models.byDir(dir);
    if (have) return { ...view(have), already: true };
    const remote = await git.originUrl(dir);
    return view(models.add(dir, { github: remote || '', name: readName(dir) || undefined }));
  }));

  // The GitHub command-line tool, for the New model dialog: is it there and signed in, who is the user, is a name valid.
  // Read-only. A repository is created only by `launch:new` below, which only the dialog's button calls.
  ipcMain.handle('launch:github', wrap(() => github.account()));
  ipcMain.handle('launch:checkRepoName', wrap(text => { const error = github.nameProblem(str(String(text === undefined ? '' : text), 300, 'name')); return { ok: !error, error }; }));

  // New model: `create` (owner, name, visibility, description) makes a new GitHub repository first; else `github` is the
  // link of an existing one.
  ipcMain.handle('launch:new', wrap(async v => {
    v = v && typeof v === 'object' ? v : {};
    const win = getWin();
    const progress = line => { if (win && !win.isDestroyed()) win.webContents.send('launch:progress', String(line)); };
    const base = { name: str(v.name || '', 200, 'name'), folder: str(v.folder || '', 500, 'folder') };
    const how = { runnerFor: dir => mkRunner(dir), progress };
    const r = v.create !== undefined
      ? await createModelInNewRepo({ ...base, repo: github.checkSpec(v.create) }, how)
      : await createNewModel({ ...base, github: str(v.github || '', 300, 'link') }, how);
    const m = models.add(r.dir, { github: r.github });
    models.touch(m.id);
    progress('Opening the model…');
    await switchModel(r.dir, { scaffold: r.scaffold });
    return { id: m.id, dir: r.dir, scaffold: r.scaffold };
  }));

  // Commit and push
  ipcMain.handle('launch:commitInfo', wrap(async id => {
    const m = need(id);
    const st = await git.status(m.dir);
    return { isRepo: st.isRepo, branch: st.branch, remote: st.remote, ahead: st.ahead, hasCommits: st.hasCommits, changed: st.changed, name: m.name };
  }));
  ipcMain.handle('launch:commit', wrap(async (id, message, push) => {
    const m = need(id);
    const st = await git.status(m.dir);
    if (!st.isRepo) throw new Error('This model folder is not a git repository of its own.');
    const out = { committed: null, pushed: null, pushError: null };
    if (st.changed.length) out.committed = await git.commit(m.dir, String(message || ''));
    else if (!push) throw new Error('There is nothing to commit.');
    if (push) {
      try { out.pushed = await git.push(m.dir); } catch (e) { out.pushError = e.message; }
    }
    return out;
  }));
}

module.exports = { registerLaunch };
