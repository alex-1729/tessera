'use strict';
// Runs `tilekit` commands (live) or answers from fixture JSON (APP_FIXTURES).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Allowed flags per command: name -> true when the flag takes a value, false when it is a switch.
const SPEC = {
  graph: {}, cases: {}, check: {}, status: {}, test: { '--file': true }, runs: {},
  trace: { '--case': true, '--run': true, '--policy': true },
  build: { '--tile': true, '--module': true, '--whole-model': false, '--case': true, '--force': false, '--run': true, '--policy': true },
  signoff: { '--tile': true, '--module': true, '--whole-model': false, '--reviewer': true, '--comment': true, '--values-only': true },
  reconfirm: { '--reviewer': true, '--module': true, '--comment': true },
  export: { '--out': true, '--case': true },
  'sample-portfolio': { '--out': true, '--policies': true, '--seed': true },
  run: { '--model-points': true, '--name': true, '--id-column': true },
  policies: { '--run': true, '--sort': true, '--desc': false, '--limit': true, '--offset': true, '--search': true, '--flag': true },
  promote: { '--run': true, '--policy': true, '--id': true, '--name': true, '--purpose': true },
  init: { '--name': true, '--package': true },     // File > New model: `tilekit init --model DIR --name NAME`; only the window's New model path reaches it
};
const COMMANDS = new Set(Object.keys(SPEC));
const INTEGERS = new Set(['--policies', '--seed', '--limit', '--offset']);
const NAMES = new Set(['--run', '--name', '--id', '--id-column', '--policy', '--tile', '--module', '--case', '--sort', '--flag']);

// Check the arguments of one command and return them in `--flag=value` form, so a value that starts with a
// dash cannot be read as a flag. Paths for real data stay inside real-data/ (or are files the user picked).
function validateArgs(command, args, { modelDir, pickedFiles } = {}) {
  const spec = SPEC[command];
  if (!spec) throw new Error('Unknown command: ' + command);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!Object.prototype.hasOwnProperty.call(spec, flag)) throw new Error(`Argument not allowed for ${command}: ${String(flag).slice(0, 40)}`);
    if (!spec[flag]) { out.push(flag); continue; }
    if (i + 1 >= args.length) throw new Error(`${flag} needs a value.`);
    let v = args[++i];
    if (v.includes('\0')) throw new Error('Invalid value for ' + flag);
    if (INTEGERS.has(flag) && !/^\d{1,9}$/.test(v)) throw new Error(`${flag} must be a whole number.`);
    if (NAMES.has(flag) && (!v || v.length > 200)) throw new Error(`${flag} needs a value.`);
    if (command === 'sample-portfolio' && flag === '--out') v = realDataPath(modelDir, v, '.csv');
    if (command === 'run' && flag === '--model-points') {
      const picked = pickedFiles && pickedFiles.has(v);
      if (!picked) v = realDataPath(modelDir, v, '.csv');
    }
    out.push(flag + '=' + v);
  }
  return out;
}

function realDataPath(modelDir, v, ext) {
  const rel = path.isAbsolute(v) ? path.relative(modelDir, v) : v;
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  const parts = norm.split('/');
  if (parts.length < 2 || parts[0] !== 'real-data' || parts.includes('..') || !norm.toLowerCase().endsWith(ext)) {
    throw new Error('Real-data files must be ' + ext + ' files inside real-data/.');
  }
  return path.join(modelDir, norm);
}

function findUv() {
  const dirs = (process.env.PATH || '').split(path.delimiter).concat([
    path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']);
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, 'uv');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

function createRunner({ repoRoot, modelDir, fixtures, projectDir, pickedFiles }) {
  if (fixtures) return createFixtureRunner(fixtures);
  // The Python environment (projectDir) can differ from the model directory, for a test on a copy.
  const project = projectDir || process.env.APP_TILEKIT_PROJECT || modelDir;
  const env = { ...process.env };
  if (!env.GRIDCRAFT_CLI) {
    const cli = path.join(repoRoot, 'vendor', 'gridcraft', 'cli', 'gridcraft-cli');
    if (fs.existsSync(cli)) env.GRIDCRAFT_CLI = cli;
  }
  // `modelOverride` is for the agent only (what-if runs in a temporary copy of the model); the window's IPC never passes it.
  return function run(command, args = [], modelOverride) {
    let flags;
    try {
      if (!COMMANDS.has(command)) throw new Error('Unknown command: ' + command);
      flags = validateArgs(command, args, { modelDir, pickedFiles });
    } catch (e) { return Promise.reject(e); }
    const uv = findUv();
    if (!uv) return Promise.reject(new Error('Cannot find uv on PATH or in ~/.local/bin.'));
    const argv = ['run', '--project', project, 'tilekit', command, '--model', modelOverride || modelDir, ...flags];
    return new Promise((resolve, reject) => {
      const child = spawn(uv, argv, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', e => reject(new Error('Could not start uv: ' + e.message)));
      child.on('close', code => {
        let doc;
        try { doc = JSON.parse(out); } catch { doc = undefined; }
        if (doc && doc.error) return reject(Object.assign(new Error(doc.error.message || 'tilekit failed'), { detail: doc.error.detail }));
        if (code !== 0) {
          const tail = err.trim().split('\n').slice(-3).join(' ');
          return reject(new Error(`tilekit ${command} exited with code ${code}.${tail ? ' ' + tail : ''}`));
        }
        if (doc === undefined) return reject(new Error(`tilekit ${command} did not print a JSON document.`));
        resolve(doc);
      });
    });
  };
}

// ---------------------------------------------------------------- fixtures

function createFixtureRunner(dir) {
  const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const status = read('status.json');
  const graph = read('graph.json');
  const built = new Set();   // modules/model whose workbook has been (re)built in this session
  for (const [id, m] of Object.entries(status.modules)) if (m.state !== 'unbuilt') built.add('module:' + id);
  if (status.model.state !== 'unbuilt') built.add('model');
  const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  function recompute() {
    for (const m of graph.modules) {
      const ms = status.modules[m.id];
      const ts = m.tiles.map(t => status.tiles[t]);
      ms.tiles_total = ts.length;
      ms.tiles_signed_off = ts.filter(t => t.state === 'signed_off').length;
      ms.stale = ts.filter(t => t.state === 'stale').length;
      const all = ms.tiles_signed_off === ms.tiles_total;
      if (ms.signed_off) ms.state = all ? 'signed_off' : 'stale';
      else ms.state = built.has('module:' + m.id) ? 'built' : 'unbuilt';
    }
    const mm = status.model;
    mm.modules_total = graph.modules.length;
    mm.modules_signed_off = graph.modules.filter(m => status.modules[m.id].state === 'signed_off').length;
    const all = mm.modules_signed_off === mm.modules_total;
    if (mm.signed_off) mm.state = all ? 'signed_off' : 'stale';
    else mm.state = built.has('model') ? 'built' : 'unbuilt';
  }
  recompute();

  function targets(args) {
    const val = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
    return { tile: val('--tile'), module: val('--module'), model: args.includes('--whole-model'), reviewer: val('--reviewer'),
      comment: val('--comment'), out: val('--out'), case: val('--case'), force: args.includes('--force') };
  }

  return async function run(command, args = []) {
    if (!COMMANDS.has(command)) throw new Error('Unknown command: ' + command);
    const a = targets(args);
    switch (command) {
      case 'graph': return JSON.parse(JSON.stringify(graph));
      case 'cases': return read('cases.json');
      case 'runs': return { runs: [] };
      case 'check': return read('check.json');
      case 'status': return JSON.parse(JSON.stringify(status));
      case 'trace': {
        const f = `trace-${a.case}.json`;
        if (!a.case || !/^[A-Za-z0-9_-]+$/.test(a.case) || !fs.existsSync(path.join(dir, f))) throw new Error(`No fixture trace for case ${a.case}.`);
        return read(f);
      }
      case 'build': {
        const tiles = a.tile ? [a.tile] : a.module ? (graph.modules.find(m => m.id === a.module) || { tiles: [] }).tiles : graph.modules.flatMap(m => m.tiles);
        for (const t of tiles) {
          const s = status.tiles[t];
          if (!s) throw new Error('Unknown tile ' + t);
          if (s.state === 'unbuilt' || s.state === 'stale' || a.force) {
            s.state = 'built'; s.drift = null; s.signed_off = null;
          }
        }
        for (const m of graph.modules) {
          if (a.model || a.module === m.id || (a.tile && m.tiles.includes(a.tile))) built.add('module:' + m.id);
        }
        if (a.model) built.add('model');
        recompute();
        return { built: tiles };
      }
      case 'signoff': {
        if (!a.reviewer) throw new Error('A reviewer name is required.');
        const rec = { reviewer: a.reviewer, at: now(), comment: a.comment || '' };
        if (a.tile) {
          const s = status.tiles[a.tile];
          if (!s) throw new Error('Unknown tile ' + a.tile);
          if (s.state === 'unbuilt' || s.state === 'stale') throw new Error(`Tile ${a.tile} is ${s.state === 'stale' ? 'stale' : 'not built'}; rebuild it first.`);
          if (s.can_sign_off === false) throw new Error(`Tile ${a.tile} cannot be signed off: ${(s.blockers || []).join(' ')}`);
          if (!s.checks_pass || (s.rule_violations || []).length || (s.uncovered_branches || []).length) throw new Error(`Tile ${a.tile} has failing checks.`);
          s.state = 'signed_off'; s.signed_off = rec; s.drift = null;
        } else if (a.module) {
          const m = status.modules[a.module];
          if (!m) throw new Error('Unknown module ' + a.module);
          if (m.tiles_signed_off !== m.tiles_total || m.stale) throw new Error('Every tile must be signed off first.');
          m.signed_off = rec;
        } else if (a.model) {
          if (status.model.modules_signed_off !== status.model.modules_total) throw new Error('Every module must be signed off first.');
          status.model.signed_off = rec;
        } else throw new Error('Say what to sign off.');
        recompute();
        return { signed_off: rec };
      }
      case 'reconfirm': {
        if (!a.reviewer) throw new Error('A reviewer name is required.');
        const done = [];
        for (const m of graph.modules) {
          if (a.module && a.module !== m.id) continue;
          for (const t of m.tiles) {
            const s = status.tiles[t];
            if (s.state === 'stale' && s.drift === 'values' && s.checks_pass) {
              s.state = 'signed_off'; s.drift = null; s.signed_off = { reviewer: a.reviewer, at: now(), comment: 'Re-confirmed, values only.' };
              done.push(t);
            }
          }
        }
        recompute();
        return { reconfirmed: done };
      }
      case 'test': {
        // Fixture mode: pretend the model's tests ran and passed.
        for (const c of status.model.checks || []) if (c.stale) { delete c.stale; c.pass = true; }
        for (const m of Object.values(status.modules)) for (const c of m.checks || []) if (c.stale) { delete c.stale; c.pass = true; }
        return { passed: true, tests: 0 };
      }
      case 'export': {
        if (!a.out) throw new Error('--out is required.');
        fs.copyFileSync(path.join(dir, status.model.workbook), a.out);
        return { out: a.out };
      }
      default: throw new Error('Unsupported command');
    }
  };
}

module.exports = { createRunner, COMMANDS, findUv, validateArgs };
