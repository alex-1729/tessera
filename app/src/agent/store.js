'use strict';
// Per-scope conversation logs (review/.../log.jsonl), session ids and drafts (review/drafts/<id>.json).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEVELS = new Set(['model', 'module', 'tile']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function now() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function checkScope(scope) {
  if (!scope || !LEVELS.has(scope.level)) throw new Error('Scope must be {level: model|module|tile, id}.');
  if (scope.level !== 'model' && (typeof scope.id !== 'string' || !NAME.test(scope.id))) {
    throw new Error(`A ${scope.level} scope needs a valid id.`);
  }
  return scope.level === 'model' ? { level: 'model', id: scope.id || 'model' } : { level: scope.level, id: scope.id };
}

function scopeKey(scope) {
  return scope.level === 'model' ? 'model' : `${scope.level}:${scope.id}`;
}

function logPath(modelDir, scope) {
  const review = path.join(modelDir, 'review');
  if (scope.level === 'tile') return path.join(review, 'tiles', scope.id, 'log.jsonl');
  if (scope.level === 'module') return path.join(review, 'modules', scope.id, 'log.jsonl');
  return path.join(review, 'model', 'log.jsonl');
}

function appendLog(modelDir, scope, entry) {
  const file = logPath(modelDir, scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

function readLog(modelDir, scope) {
  const file = logPath(modelDir, scope);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

// The last session id recorded for the scope; a `session` entry with null id resets it.
function lastSession(modelDir, scope) {
  const entries = readLog(modelDir, scope).filter(e => e.type === 'session');
  return entries.length ? entries[entries.length - 1].session_id || null : null;
}

// ---------------------------------------------------------------- drafts

function draftsDir(modelDir) {
  return path.join(modelDir, 'review', 'drafts');
}

function newDraftId() {
  const stamp = now().replace(/[-:TZ]/g, '').slice(0, 14);
  return `d${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function draftPath(modelDir, id) {
  if (typeof id !== 'string' || !/^d\d{14}-[0-9a-f]{6}$/.test(id)) throw new Error('Unknown draft id.');
  return path.join(draftsDir(modelDir), id + '.json');
}

function saveDraft(modelDir, draft) {
  fs.mkdirSync(draftsDir(modelDir), { recursive: true });
  fs.writeFileSync(draftPath(modelDir, draft.id), JSON.stringify(draft, null, 2) + '\n');
  return draft;
}

function loadDraft(modelDir, id) {
  const file = draftPath(modelDir, id);
  if (!fs.existsSync(file)) throw new Error(`There is no draft ${id}.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listDrafts(modelDir) {
  let names;
  try { names = fs.readdirSync(draftsDir(modelDir)); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(draftsDir(modelDir), n), 'utf8'))); } catch { /* skip */ }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

module.exports = {
  now, checkScope, scopeKey, logPath, appendLog, readLog, lastSession,
  newDraftId, saveDraft, loadDraft, listDrafts, draftPath,
};
