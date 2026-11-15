'use strict';
// Claude Code's saved conversations for one model folder: the transcripts it keeps in
// <config>/projects/<the folder's path with every other character as ->/<session id>.jsonl.
// The app lists them and deletes one when the user asks; it never edits one.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

function sessionsDir(modelDir) {
  const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(config, 'projects', real(modelDir).replace(/[^A-Za-z0-9]/g, '-'));
}

function textOf(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter(x => x && x.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n');
}

// What the user typed, without the bracketed lines the app puts in front of a message.
const typed = text => text.split('\n').filter(l => l.trim() && !/^\s*\[.*\]\s*$/.test(l)).join(' ').replace(/^\s*\[[^\]]*\]\s*/, '').trim();

function summary(file) {
  let title = '', started = null, last = null, messages = 0;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isMeta || o.isSidechain) continue;
    const said = textOf(o.message);
    if (!said.trim()) continue;
    if (o.timestamp) { if (!started) started = o.timestamp; last = o.timestamp; }
    messages++;
    if (!title && o.type === 'user') title = typed(said).slice(0, 80);
  }
  if (!messages) return null;
  return { title: title || 'Conversation', started, last, messages };
}

// Newest first: [{id, title, started, last, messages}]
function listSessions(modelDir) {
  const dir = sessionsDir(modelDir);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const id = n.replace(/\.jsonl$/, '');
    if (!n.endsWith('.jsonl') || !ID.test(id)) continue;
    const s = summary(path.join(dir, n));
    if (s) out.push({ id, ...s });
  }
  return out.sort((a, b) => String(b.last || '').localeCompare(String(a.last || '')));
}

function deleteSession(modelDir, id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Unknown conversation.');
  const dir = sessionsDir(modelDir);
  const file = path.join(dir, id + '.jsonl');
  if (!fs.existsSync(file)) throw new Error('That conversation is no longer there.');
  fs.unlinkSync(file);
  try { fs.rmSync(path.join(dir, id), { recursive: true, force: true }); } catch { /* its side files, if any */ }
}

module.exports = { listSessions, deleteSession, sessionsDir, SESSION_ID: ID };
