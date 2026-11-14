'use strict';
// The only place the app runs `git`. Always `execFile` (no shell), always in a model's own folder, never with a token
// (the user's existing git sign-in does the work; terminal prompts are off so nothing ever waits for a password).
// Never force-pushes and never changes configuration. Only `initRepo` (a brand-new model) adds a remote.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';
const REPO = '[A-Za-z0-9._-]{1,100}';
const HTTPS = new RegExp(`^https://github\\.com/(${OWNER})/(${REPO}?)(?:\\.git)?/?$`);
const SSH = new RegExp(`^git@github\\.com:(${OWNER})/(${REPO}?)(?:\\.git)?$`);

// A GitHub link in one of the three accepted shapes. Returns {ok, url, web, owner, repo} or {ok: false, error}.
// `web` is the https page for the repository (null for a local test remote). Local paths and file:// URLs are accepted
// only when APP_ALLOW_LOCAL_REMOTE=1 (the tests' stand-in for GitHub).
function parseGithubLink(text) {
  const url = String(text === undefined || text === null ? '' : text).trim();
  if (!url) return { ok: false, error: 'Enter the GitHub repository link.' };
  if (url.length > 300 || /[\0\s]/.test(url)) return { ok: false, error: 'That is not a GitHub link. Use https://github.com/owner/repo or git@github.com:owner/repo.git.' };
  let m = HTTPS.exec(url) || SSH.exec(url);
  if (m && !/^\.\.?$/.test(m[2])) return { ok: true, url, owner: m[1], repo: m[2], web: `https://github.com/${m[1]}/${m[2]}` };
  if (process.env.APP_ALLOW_LOCAL_REMOTE === '1' && (path.isAbsolute(url) || /^file:\/\//.test(url))) return { ok: true, url, owner: null, repo: null, web: null };
  return { ok: false, error: 'That is not a GitHub link. Use https://github.com/owner/repo, the same with .git, or git@github.com:owner/repo.git.' };
}

// The page to open in the browser for a stored link; null unless it is an https://github.com/... link.
function webUrl(link) {
  const p = parseGithubLink(link);
  return p.ok && p.web && /^https:\/\/github\.com\//.test(p.web) ? p.web : null;
}

function run(dir, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: dir, timeout, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GCM_INTERACTIVE: 'never' },
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout: String(stdout), stderr: String(stderr) });
      const text = (String(stderr).trim() || String(stdout).trim() || err.message).replace(/\s+$/, '');
      reject(Object.assign(new Error(err.killed ? 'git took too long and was stopped.' : text), { git: text, code: err.code }));
    });
  });
}

const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// Is `dir` the top of its own git repository? (A model folder inside a bigger repository is not: the app would
// otherwise see and commit that repository's other files.)
async function isOwnRepo(dir) {
  try {
    const { stdout } = await run(dir, ['rev-parse', '--show-toplevel']);
    return real(stdout.trim()) === real(dir);
  } catch { return false; }
}

const STATE_WORD = { '?': 'new', M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflicted', T: 'modified' };
const stateOf = xy => {
  if (xy === '??') return 'new';
  const c = xy[0] !== ' ' ? xy[0] : xy[1];
  return STATE_WORD[c] || 'changed';
};

/**
 * status(dir) -> {isRepo, ownRepo, branch, upstream, ahead, behind, remote, hasCommits, changed: [{state, path}]}
 * `isRepo` is false when the folder is not the top of a repository of its own.
 */
async function status(dir) {
  const none = { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, remote: null, hasCommits: false, changed: [] };
  if (!(await isOwnRepo(dir))) return none;
  const out = { ...none, isRepo: true };
  const { stdout } = await run(dir, ['status', '--porcelain=v1', '-z', '-uall']);
  const parts = stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    out.changed.push({ state: stateOf(xy), path: e.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') i++;   // the old name follows
  }
  try { out.branch = (await run(dir, ['branch', '--show-current'])).stdout.trim() || null; } catch { /* detached */ }
  try { await run(dir, ['rev-parse', '--verify', '-q', 'HEAD']); out.hasCommits = true; } catch { out.hasCommits = false; }
  try { out.remote = (await run(dir, ['remote', 'get-url', 'origin'])).stdout.trim() || null; } catch { out.remote = null; }
  try { out.upstream = (await run(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).stdout.trim() || null; } catch { out.upstream = null; }
  if (out.hasCommits) {
    try {
      if (out.upstream) {
        const [b, a] = (await run(dir, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])).stdout.trim().split(/\s+/).map(Number);
        out.behind = b || 0; out.ahead = a || 0;
      } else if (out.remote) {
        out.ahead = Number((await run(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).stdout.trim()) || 0;
      }
    } catch { /* leave zero */ }
  }
  return out;
}

// The commits that are not on the remote yet, newest first: [{hash, subject}].
async function unpushed(dir, limit = 20) {
  const st = await status(dir);
  if (!st.isRepo || !st.hasCommits) return [];
  const args = st.upstream ? ['log', `-${limit}`, '--format=%h%x09%s', '@{u}..HEAD'] : ['log', `-${limit}`, '--format=%h%x09%s', 'HEAD', '--not', '--remotes'];
  const { stdout } = await run(dir, args);
  return stdout.split('\n').filter(Boolean).map(l => { const [hash, ...rest] = l.split('\t'); return { hash, subject: rest.join('\t') }; });
}

// `git add -A` (which respects .gitignore) and commit. Returns {files, hash, subject}.
async function commit(dir, message) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('A commit message is required.');
  if (message.length > 2000) throw new Error('The commit message is too long.');
  if (!(await isOwnRepo(dir))) throw new Error('This model folder is not a git repository of its own, so nothing was committed.');
  await run(dir, ['add', '-A']);
  const staged = (await run(dir, ['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean);
  if (!staged.length) throw new Error('There is nothing to commit.');
  await run(dir, ['commit', '-m', message.trim()]);
  const { stdout } = await run(dir, ['log', '-1', '--format=%h%x09%s']);
  const [hash, ...rest] = stdout.trim().split('\t');
  return { files: staged.length, filesList: staged, hash, subject: rest.join('\t') };
}

// `git push -u origin <branch>`: never forced. Returns {branch, remote: 'origin/<branch>'}.
async function push(dir) {
  if (!(await isOwnRepo(dir))) throw new Error('This model folder is not a git repository of its own, so nothing was pushed.');
  const st = await status(dir);
  if (!st.remote) throw new Error('This model has no remote called origin to push to.');
  if (!st.branch) throw new Error('There is no branch checked out to push.');
  if (!st.hasCommits) throw new Error('There is nothing to push yet: no commits.');
  await run(dir, ['push', '-u', 'origin', st.branch], { timeout: 180000 });
  return { branch: st.branch, remote: `origin/${st.branch}` };
}

// ---- used when a model is created from a GitHub link (src/newmodel.js)

// What `git ls-remote` says: {commits: bool}, or an Error with a plain sentence.
async function checkRemote(url) {
  try {
    const { stdout } = await run(process.cwd(), ['ls-remote', '--heads', '--', url], { timeout: 60000 });
    return { commits: stdout.trim().length > 0 };
  } catch (e) { throw new Error(remoteProblem(e.git || e.message)); }
}

function remoteProblem(text) {
  const t = String(text || '');
  if (/could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied|publickey|Invalid username or password|403|401/i.test(t)) {
    return 'Git could not sign in to that repository with your existing git sign-in (authentication failed). Check that the link is right and that you have access to it. Git said: ' + t.split('\n').slice(-2).join(' ');
  }
  if (/not found|does not exist|does not appear to be a git repository|Could not resolve host/i.test(t)) {
    return /resolve host/i.test(t) ? 'Git could not reach GitHub: ' + t.split('\n').slice(-1)[0] : 'That repository was not found (or you do not have access to it). Git said: ' + t.split('\n').slice(-2).join(' ');
  }
  return 'Git could not check the repository: ' + t.split('\n').slice(-2).join(' ');
}

async function clone(url, target) {
  await run(path.dirname(target), ['clone', '--', url, target], { timeout: 600000 });
}

// A brand-new model: `git init -b main`, `origin`, and a first local commit. Nothing is pushed.
async function initRepo(dir, url, message) {
  await run(dir, ['init', '-b', 'main']);
  await run(dir, ['remote', 'add', 'origin', url]);
  return commit(dir, message);
}

async function originUrl(dir) {
  if (!(await isOwnRepo(dir))) return null;
  try { return (await run(dir, ['remote', 'get-url', 'origin'])).stdout.trim() || null; } catch { return null; }
}

// The words the launch tile shows for git state.
function stateWords(st) {
  if (!st || !st.isRepo) return 'not a git repository of its own';
  const bits = [];
  if (st.changed.length) bits.push(`${st.changed.length} file${st.changed.length === 1 ? '' : 's'} changed`);
  if (st.ahead) bits.push(`${st.ahead} commit${st.ahead === 1 ? '' : 's'} not pushed`);
  if (st.behind) bits.push(`${st.behind} commit${st.behind === 1 ? '' : 's'} behind origin`);
  if (!st.remote) bits.push('no remote');
  return bits.length ? bits.join(', ') : 'clean';
}

module.exports = { parseGithubLink, webUrl, status, unpushed, commit, push, checkRemote, clone, initRepo, originUrl, isOwnRepo, stateWords, run };
