'use strict';
// A stand-in for the GitHub command-line tool `gh`, for test/launch.js. It never talks to GitHub. State lives in the
// folder FAKE_GH_DIR: state.json ({signedIn, login, orgs}), calls.jsonl (every invocation with its arguments) and
// repos/<owner>/<name>.git (a local bare repository standing in for each GitHub repository).
// Answers: auth status, api user, api user/orgs, repo view <owner>/<name> --json url, repo create <owner>/<name>.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = process.env.FAKE_GH_DIR;
if (!dir) { process.stderr.write('fake gh: FAKE_GH_DIR is not set\n'); process.exit(2); }
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args }) + '\n');
const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
const out = text => { process.stdout.write(text + '\n'); process.exit(0); };
const fail = (text, code = 1) => { process.stderr.write(text + '\n'); process.exit(code); };
const repoDir = full => path.join(dir, 'repos', full + '.git');
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };

const [a, b, c] = args;
if (a === 'auth' && b === 'status') {
  if (!state.signedIn) fail('You are not logged into any GitHub hosts. To log in, run: gh auth login');
  out(`github.com\n  ✓ Logged in to github.com account ${state.login} (keyring)\n  - Active account: true`);
}
if (!state.signedIn) fail('To get started with GitHub CLI, please run:  gh auth login', 4);
if (a === 'api' && b === 'user' && flag('--jq') === '.login') out(state.login);
if (a === 'api' && b === 'user/orgs' && flag('--jq') === '.[].login') out((state.orgs || []).join('\n'));
if (a === 'repo' && (b === 'view' || b === 'create') && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(c || '')) {
  const there = fs.existsSync(repoDir(c));
  if (b === 'view') {
    if (flag('--json') !== 'url') fail('fake gh: repo view needs --json url', 2);
    if (!there) fail(`GraphQL: Could not resolve to a Repository with the name '${c}'. (repository)`);
    out(JSON.stringify({ url: repoDir(c) }));
  }
  const rest = args.slice(3);
  const vis = rest.filter(x => x === '--private' || x === '--public');
  const known = rest.every((x, i) => x === '--private' || x === '--public' || x === '--description' || rest[i - 1] === '--description');
  if (vis.length !== 1 || !known) fail('fake gh: repo create takes one of --private/--public and --description only', 2);
  if (there) fail('GraphQL: Name already exists on this account (createRepository)');
  fs.mkdirSync(repoDir(c), { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: repoDir(c), env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  fs.appendFileSync(path.join(dir, 'created.jsonl'), JSON.stringify({ full: c, visibility: vis[0].slice(2), description: flag('--description') || '' }) + '\n');
  out(`https://github.com/${c}`);
}
fail('fake gh: unexpected command: ' + args.join(' '), 2);
