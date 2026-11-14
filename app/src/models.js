'use strict';
// The app's list of models. It lives in the settings file (never in a repo):
//   models: [{id, name, dir, github, realDataDir, lastOpened}]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// The model's name from tilekit.toml ([model] name = "..."), or null.
function readName(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, 'tilekit.toml'), 'utf8'); } catch { return null; }
  let inModel = false;
  for (const line of text.split(/\r?\n/)) {
    const sec = /^\s*\[([^\]]*)\]/.exec(line);
    if (sec) { inModel = sec[1].trim() === 'model'; continue; }
    if (!inModel) continue;
    const m = /^\s*name\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line);
    if (m) { try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; } }
  }
  return null;
}

const isModelDir = dir => { try { return fs.statSync(path.join(dir, 'tilekit.toml')).isFile(); } catch { return false; } };

// store: {get(), save()} over the settings object.
function createModels(settings, save) {
  if (!Array.isArray(settings.models)) settings.models = [];
  const list = () => settings.models;
  const byId = id => list().find(m => m.id === id) || null;
  const byDir = dir => { const r = real(dir); return list().find(m => real(m.dir) === r) || null; };
  const persist = () => save();
  return {
    list, byId, byDir,
    // Register a folder (or return the entry it already has). The name comes from tilekit.toml.
    add(dir, { github = '', name } = {}) {
      const full = path.resolve(dir);
      const have = byDir(full);
      if (have) return have;
      const entry = { id: 'm' + crypto.randomBytes(5).toString('hex'), name: name || readName(full) || path.basename(full), dir: full, github: github || '', realDataDir: '', lastOpened: null };
      list().push(entry);
      persist();
      return entry;
    },
    remove(id) {
      const i = list().findIndex(m => m.id === id);
      if (i < 0) throw new Error('That model is not in the list.');
      list().splice(i, 1);
      persist();
    },
    update(id, fields) {
      const m = byId(id);
      if (!m) throw new Error('That model is not in the list.');
      Object.assign(m, fields);
      persist();
      return m;
    },
    touch(id) { const m = byId(id); if (m) { m.lastOpened = new Date().toISOString(); persist(); } },
  };
}

module.exports = { createModels, readName, isModelDir, real };
