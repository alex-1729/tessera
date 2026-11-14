'use strict';
// The only place the app runs the GitHub command-line tool `gh`. Always `execFile` (no shell), always with the user's
// existing `gh` sign-in: the app never reads, asks for or stores a token. The only thing it ever changes on GitHub is
// `createRepo`, which is reached from one place: the New model dialog's button (src/newrepo.js through `launch:new`).
// Nothing here deletes or pushes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const git = require('./git');

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const DESCRIPTION_MAX = 350;

const NOT_INSTALLED = 'The GitHub command-line tool is not installed.';
const SIGNED_OUT = 'You are not signed in to GitHub in the command-line tool. Run `gh auth login` in a terminal.';

// Tests never reach the real `gh`: under test the binary comes from APP_GH_BIN or there is none.
const underTest = () => process.env.APP_ALLOW_LOCAL_REMOTE === '1' || !!process.env.APP_FIXTURES || !!process.env.APP_NO_AUTOSTART;

const executable = p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

// The `gh` to run: APP_GH_BIN when set (tests), else the first one on PATH, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin.
function findGh() {
  const forced = process.env.APP_GH_BIN;
  if (forced) return executable(forced) ? forced : null;
  if (underTest()) return null;
  const dirs = (process.env.PATH || '').split(path.delimiter).concat([
    path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']);
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, 'gh');
    if (executable(p)) return p;
  }
  return null;
}

function run(args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = findGh();
    if (!bin) return reject(Object.assign(new Error(NOT_INSTALLED), { missing: true }));
    execFile(bin, args, {
      cwd: os.homedir(), timeout, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0' },
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout: String(stdout), stderr: String(stderr) });
      if (err.code === 'ENOENT' || err.code === 'EACCES') return reject(Object.assign(new Error(NOT_INSTALLED), { missing: true }));
      const text = (String(stderr).trim() || String(stdout).trim() || err.message).replace(/\s+$/, '');
      reject(Object.assign(new Error(err.killed ? 'The GitHub command-line tool took too long and was stopped.' : text), { gh: text }));
    });
  });
}

const lastLine = text => String(text || '').split('\n').filter(Boolean).slice(-1)[0] || '';

// Is `gh` present and signed in to github.com? -> {ok: true} or {ok: false, reason: 'missing' | 'signedOut', message}
async function available() {
  if (!findGh()) return { ok: false, reason: 'missing', message: NOT_INSTALLED };
  try { await run(['auth', 'status', '--hostname', 'github.com']); return { ok: true }; }
  catch (e) { return e.missing ? { ok: false, reason: 'missing', message: NOT_INSTALLED } : { ok: false, reason: 'signedOut', message: SIGNED_OUT }; }
}

// Who the user is: {ok: true, login, owners: [login, ...organisations]}, or the same {ok: false, ...} as available().
async function account() {
  const a = await available();
  if (!a.ok) return a;
  let login;
  try { login = (await run(['api', 'user', '--jq', '.login'])).stdout.trim(); }
  catch (e) { return { ok: false, reason: 'error', message: 'GitHub could not be asked who you are: ' + lastLine(e.message) }; }
  if (!OWNER.test(login)) return { ok: false, reason: 'error', message: 'The GitHub command-line tool did not say who you are.' };
  let orgs = [];
  try { orgs = (await run(['api', 'user/orgs', '--jq', '.[].login'])).stdout.split('\n').map(s => s.trim()).filter(s => OWNER.test(s)); }
  catch { /* the account alone is enough */ }
  return { ok: true, login, owners: [login, ...orgs.filter(o => o !== login)] };
}

// GitHub's naming rules for a repository. -> null, or a plain sentence saying what is wrong.
function nameProblem(name) {
  if (typeof name !== 'string' || !name) return 'Give the repository a name.';
  if (!NAME.test(name) || name === '.' || name === '..' || /\.git$/i.test(name)) {
    return 'A repository name can use letters, digits, dashes, underscores and dots, up to 100 characters, and cannot end in .git.';
  }
  return null;
}

// Every argument that reaches `gh` goes through here. -> {owner, name, visibility, description, full}
function checkSpec(v) {
  v = v && typeof v === 'object' ? v : {};
  if (typeof v.owner !== 'string' || !OWNER.test(v.owner)) throw new Error('Choose the account or organisation that will own the repository.');
  const bad = nameProblem(v.name);
  if (bad) throw new Error(bad);
  if (v.visibility !== 'private' && v.visibility !== 'public') throw new Error('Choose Private or Public.');
  const description = v.description === undefined || v.description === null ? '' : v.description;
  if (typeof description !== 'string' || description.length > DESCRIPTION_MAX || /[\0-\x1f\x7f]/.test(description)) {
    throw new Error(`The description must be one line of at most ${DESCRIPTION_MAX} characters.`);
  }
  return { owner: v.owner, name: v.name, visibility: v.visibility, description: description.trim(), full: `${v.owner}/${v.name}` };
}

// Does <owner>/<name> exist (as far as this sign-in can see)? `gh repo view` failing with not-found means it is free.
async function repoExists(owner, name) {
  const s = checkSpec({ owner, name, visibility: 'private' });
  try { await run(['repo', 'view', s.full, '--json', 'url']); return true; }
  catch (e) {
    if (e.missing) throw e;
    if (/Could not resolve to a Repository|\bnot found\b|HTTP 404/i.test(e.gh || '')) return false;
    throw new Error('GitHub could not be asked whether that name is free: ' + lastLine(e.message));
  }
}

// The link git uses for <owner>/<name>, from `gh repo view --json url`.
async function repoUrl(owner, name) {
  const s = checkSpec({ owner, name, visibility: 'private' });
  const { stdout } = await run(['repo', 'view', s.full, '--json', 'url']);
  let url = null;
  try { url = JSON.parse(stdout).url; } catch { /* below */ }
  const p = git.parseGithubLink(url);
  if (!p.ok) throw new Error('The GitHub command-line tool did not give the link of the new repository.');
  if (p.owner && (p.owner.toLowerCase() !== s.owner.toLowerCase() || p.repo.toLowerCase() !== s.name.toLowerCase())) {
    throw new Error('The GitHub command-line tool gave the link of another repository.');
  }
  return p.url;
}

// Create an EMPTY repository: no --source, no --push, no --clone. -> {full, url}.
// An error thrown after GitHub made the repository carries `created: true`.
async function createRepo(v) {
  const s = checkSpec(v);
  if (underTest() && !process.env.APP_GH_BIN) throw new Error('APP_GH_BIN is not set: a test must never create a repository with the real GitHub command-line tool.');
  const args = ['repo', 'create', s.full, s.visibility === 'public' ? '--public' : '--private'];
  if (s.description) args.push('--description', s.description);
  await run(args, { timeout: 60000 });
  try { return { full: s.full, url: await repoUrl(s.owner, s.name) }; }
  catch (e) { throw Object.assign(new Error(e.message), { created: true }); }
}

module.exports = { findGh, available, account, nameProblem, checkSpec, repoExists, repoUrl, createRepo, NOT_INSTALLED, SIGNED_OUT };
