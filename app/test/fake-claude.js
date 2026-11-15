'use strict';
// A stand-in for the Claude Code program, for test/terminal.js. It never calls a model. It does what Claude Code does
// with what the app hands it, so the app's side of the terminal pane is exercised for real:
//   - it starts the MCP server named in --mcp-config (the app's src/agent/cli-bridge.js) and speaks MCP to it;
//   - before each command it runs the UserPromptSubmit hook from --settings, and after it the Stop hook.
// It reads one command per line from the terminal:
//   tools                  list the tools
//   call <tool> [json]     call a tool
//   draft <name>           call propose_params with one new parameter called <name>
// Everything it sees goes, one JSON object per line, to the file named in FAKE_CLAUDE_OUT.
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const OUT = process.env.FAKE_CLAUDE_OUT;
if (!OUT) { process.stderr.write('fake claude: FAKE_CLAUDE_OUT is not set\n'); process.exit(2); }
const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const record = o => fs.appendFileSync(OUT, JSON.stringify(o) + '\n');
const say = text => process.stdout.write(text + '\r\n');

const session = flag('--resume') || crypto.randomUUID();
let mcpConfig = null, settings = null;
try { mcpConfig = JSON.parse(flag('--mcp-config')); settings = JSON.parse(flag('--settings')); } catch { /* recorded below */ }
record({ start: true, argv, session, cwd: process.cwd(),
  env: Object.keys(process.env).filter(k => /^(CLAUDE|TESSERA_|ELECTRON_RUN_AS_NODE$)/.test(k)).sort(),
  port: process.env.TESSERA_PORT || null, configOk: !!(mcpConfig && settings) });

// ---- the MCP server the app named, kept for the life of this process as Claude Code keeps it
let server = null, nextId = 1, buf = '';
const pending = new Map();
function startServer() {
  const spec = mcpConfig.mcpServers.tiles;
  server = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const done = pending.get(msg.id);
      if (done) { pending.delete(msg.id); done(msg); }
    }
  });
}
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`no answer to ${method}`)); }, 180000);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

// ---- the hooks the app named: a shell command, given the session id on stdin; what it prints is the result
function hook(event) {
  return new Promise(resolve => {
    const entry = settings.hooks && settings.hooks[event] && settings.hooks[event][0];
    const command = entry && entry.hooks && entry.hooks[0] && entry.hooks[0].command;
    if (!command) return resolve({ missing: true, text: '' });
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '', err = '';
    child.stdout.on('data', d => { text += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({ code, text: text.trim(), err: err.trim() }));
    child.stdin.end(JSON.stringify({ session_id: session, hook_event_name: event }));
  });
}

async function turn(line) {
  const [word, ...rest] = line.split(/\s+/);
  const out = { command: line, session };
  const prompt = await hook('UserPromptSubmit');
  out.prompt = prompt.text; out.promptCode = prompt.code;
  try {
    if (word === 'tools') {
      const r = await rpc('tools/list', {});
      out.tools = ((r.result && r.result.tools) || []).map(t => ({ name: t.name, described: !!t.description, schema: !!t.inputSchema }));
    } else if (word === 'call' || word === 'draft') {
      const name = word === 'draft' ? 'propose_params' : rest[0];
      const args = word === 'draft'
        ? { summary: 'A parameter for the terminal test.', params: [{ name: rest[0], default: 0.25, label: 'Terminal test loading', format: 'percent', units: 'proportion' }] }
        : (rest.length > 1 ? JSON.parse(rest.slice(1).join(' ')) : {});
      const r = await rpc('tools/call', { name, arguments: args });
      out.tool = name;
      out.isError = !!(r.error || (r.result && r.result.isError));
      out.text = r.error ? r.error.message : ((r.result && r.result.content) || []).map(c => c.text || '').join('\n');
    } else {
      out.unknown = true;
    }
  } catch (e) { out.failed = String(e && e.message || e); }
  const stop = await hook('Stop');
  out.stopCode = stop.code;
  record(out);
  say(`fake claude: done ${word}`);
}

(async () => {
  if (!mcpConfig || !settings) { say('fake claude: could not read --mcp-config or --settings'); return; }
  startServer();
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
  record({ initialized: true, server: init.result && init.result.serverInfo });
  say('fake claude: ready');
  let queue = Promise.resolve(), typed = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    typed += chunk;
    let i;
    while ((i = typed.search(/[\r\n]/)) >= 0) {
      const line = typed.slice(0, i).trim(); typed = typed.slice(i + 1);
      if (line) queue = queue.then(() => turn(line));
    }
  });
  process.stdin.on('end', () => process.exit(0));
})().catch(e => { record({ crashed: String(e && e.stack || e) }); process.exit(1); });
process.on('exit', () => { try { server && server.kill(); } catch { /* gone */ } });
