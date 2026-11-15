'use strict';
// The model's one conversation (review/model/chat.jsonl: every event in order, with its scope, and the
// session id), the per-scope audit trails (review/.../log.jsonl), drafts (review/drafts/<id>.json) and
// sign-off requests (review/requests/<id>.json).
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
  return readJsonl(logPath(modelDir, scope));
}

function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

// ---------------------------------------------------------------- the model's conversation

function chatPath(modelDir) {
  return path.join(modelDir, 'review', 'model', 'chat.jsonl');
}

function appendChat(modelDir, entry) {
  const file = chatPath(modelDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

function readChat(modelDir) {
  return readJsonl(chatPath(modelDir));
}

// An event goes into the conversation and into its scope's audit trail.
function appendEvent(modelDir, scope, event) {
  appendChat(modelDir, event);
  appendLog(modelDir, scope, event);
}

// The conversation's last session id; a `session` entry with a null id starts a new one.
// Without chat.jsonl there is no session yet (old per-scope sessions are not resumed).
function lastSession(modelDir) {
  const entries = readChat(modelDir).filter(e => e.type === 'session');
  return entries.length ? entries[entries.length - 1].session_id || null : null;
}

// ---------------------------------------------------------------- earlier conversations
// The conversation on show is chat.jsonl. Starting a new one moves it to review/model/chats/<id>.jsonl; opening an
// earlier one swaps the two. The folder ignores itself in git (transcripts stay out of the model's repository).

const CHAT_ID = /^c\d{14}-[0-9a-f]{6}$/;

function chatsDir(modelDir) {
  return path.join(modelDir, 'review', 'model', 'chats');
}

function archivedChatPath(modelDir, id) {
  if (typeof id !== 'string' || !CHAT_ID.test(id)) throw new Error('Unknown conversation.');
  return path.join(chatsDir(modelDir), id + '.jsonl');
}

function chatSummary(entries) {
  const said = entries.filter(e => e.type === 'user' || e.type === 'agent' || e.type === 'question');
  const first = entries.find(e => e.type === 'user' && e.text) || said.find(e => e.text) || null;
  const line = first ? String(first.text).split('\n').find(l => l.trim()) || '' : '';
  const ats = entries.map(e => e.at).filter(Boolean);
  return { title: line.trim().slice(0, 80) || 'Conversation', started: ats[0] || null, last: ats[ats.length - 1] || null, messages: said.length };
}

// Move the conversation on show into the folder of earlier ones. Returns its id, or null when it was empty.
function archiveChat(modelDir) {
  const file = chatPath(modelDir);
  const entries = readChat(modelDir);
  if (!entries.some(e => e.type !== 'session')) { try { fs.unlinkSync(file); } catch { /* none */ } return null; }
  const dir = chatsDir(modelDir);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  const at = entries.map(e => e.at).find(Boolean) || now();
  const id = `c${String(at).replace(/[-:TZ.]/g, '').slice(0, 14).padEnd(14, '0')}-${crypto.randomBytes(3).toString('hex')}`;
  fs.renameSync(file, archivedChatPath(modelDir, id));
  return id;
}

function restoreChat(modelDir, id) {
  const from = archivedChatPath(modelDir, id);
  if (!fs.existsSync(from)) throw new Error('That conversation is no longer there.');
  archiveChat(modelDir);
  fs.mkdirSync(path.dirname(chatPath(modelDir)), { recursive: true });
  fs.renameSync(from, chatPath(modelDir));
}

function deleteChat(modelDir, id) {
  const file = id === 'current' ? chatPath(modelDir) : archivedChatPath(modelDir, id);
  if (!fs.existsSync(file)) { if (id === 'current') return; throw new Error('That conversation is no longer there.'); }
  fs.unlinkSync(file);
}

// The conversation on show first (when it has anything in it), then the earlier ones, newest first.
function listChats(modelDir) {
  const out = [];
  const cur = readChat(modelDir);
  if (cur.some(e => e.type !== 'session')) out.push({ id: 'current', current: true, ...chatSummary(cur) });
  let names = [];
  try { names = fs.readdirSync(chatsDir(modelDir)); } catch { /* none yet */ }
  const old = [];
  for (const n of names) {
    const id = n.replace(/\.jsonl$/, '');
    if (!n.endsWith('.jsonl') || !CHAT_ID.test(id)) continue;
    old.push({ id, current: false, ...chatSummary(readJsonl(path.join(chatsDir(modelDir), n))) });
  }
  old.sort((a, b) => String(b.last || b.id).localeCompare(String(a.last || a.id)));
  return out.concat(old);
}

// ---------------------------------------------------------------- sign-off requests

function requestsDir(modelDir) {
  return path.join(modelDir, 'review', 'requests');
}

function newRequestId() {
  const stamp = now().replace(/[-:TZ]/g, '').slice(0, 14);
  return `r${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function requestPath(modelDir, id) {
  if (typeof id !== 'string' || !/^r\d{14}-[0-9a-f]{6}$/.test(id)) throw new Error('Unknown sign-off request id.');
  return path.join(requestsDir(modelDir), id + '.json');
}

function saveRequest(modelDir, request) {
  fs.mkdirSync(requestsDir(modelDir), { recursive: true });
  fs.writeFileSync(requestPath(modelDir, request.id), JSON.stringify(request, null, 2) + '\n');
  return request;
}

function loadRequest(modelDir, id) {
  const file = requestPath(modelDir, id);
  if (!fs.existsSync(file)) throw new Error(`There is no sign-off request ${id}.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listRequests(modelDir) {
  let names;
  try { names = fs.readdirSync(requestsDir(modelDir)); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(requestsDir(modelDir), n), 'utf8'))); } catch { /* skip */ }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
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
  chatPath, appendChat, readChat, appendEvent, listChats, archiveChat, restoreChat, deleteChat,
  newDraftId, saveDraft, loadDraft, listDrafts, draftPath,
  newRequestId, saveRequest, loadRequest, listRequests, requestPath,
};
