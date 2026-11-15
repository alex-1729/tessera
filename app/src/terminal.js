'use strict';
// Claude Code in the chat pane: one `claude` process per open model, in a pseudo-terminal, started in the model's
// folder with the app's tools (through src/agent/cli-bridge.js), the app's instructions, and nothing else:
// built-in tools are limited to reading files and asking the user, and the user's own Claude Code settings,
// plugins and MCP servers are not loaded. The sign-in is the user's Claude Code sign-in.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BRIDGE = path.join(__dirname, 'agent', 'cli-bridge.js');
const sh = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The claude program that ships with the Agent SDK the app already depends on.
function findClaude(appDir) {
  if (process.env.APP_CLAUDE_BIN) return process.env.APP_CLAUDE_BIN;
  const dir = path.join(appDir, 'node_modules', '@anthropic-ai');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* none */ }
  for (const n of names) {
    if (!n.startsWith('claude-agent-sdk-')) continue;
    for (const exe of ['claude', 'claude.exe']) { const f = path.join(dir, n, exe); if (fs.existsSync(f)) return f; }
  }
  return null;
}

function loadPty(appDir) {
  // node-pty's helper must be executable; npm does not always keep the bit when install scripts are off
  const helper = path.join(appDir, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  try { fs.chmodSync(helper, 0o755); } catch { /* not this platform, or already fine */ }
  return require('node-pty');
}

// The arguments and environment Claude Code is started with.
function claudeArgs({ port, token, model, systemPrompt, resume }) {
  const node = `ELECTRON_RUN_AS_NODE=1 ${sh(process.execPath)} ${sh(BRIDGE)}`;
  const mcp = { mcpServers: { tiles: { command: process.execPath, args: [BRIDGE, 'mcp'],
    env: { ELECTRON_RUN_AS_NODE: '1', TESSERA_PORT: String(port), TESSERA_TOKEN: token } } } };
  const settings = { hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${node} hook prompt` }] }],
    Stop: [{ hooks: [{ type: 'command', command: `${node} hook stop` }] }] } };
  const args = [
    ...(typeof resume === 'string' ? ['--resume', resume] : resume ? ['--continue'] : []),
    '--model', model,
    '--append-system-prompt', systemPrompt,
    '--mcp-config', JSON.stringify(mcp), '--strict-mcp-config',
    '--settings', JSON.stringify(settings), '--setting-sources', '',
    '--permission-mode', 'default',
    '--tools', 'Read,Glob,Grep,AskUserQuestion',
    '--allowedTools', 'Read,Glob,Grep,AskUserQuestion,mcp__tiles',
  ];
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    TESSERA_PORT: String(port), TESSERA_TOKEN: token };
  delete env.ELECTRON_RUN_AS_NODE;
  // An app started from inside another Claude Code session inherits that session's switches (no transcripts, its
  // permission mode and so on). Claude Code in the pane must behave as it does when the user starts it themself.
  for (const k of Object.keys(env)) {
    if (/^(CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PREVIEW_)/.test(k) && k !== 'CLAUDE_CODE_DISABLE_AUTO_MEMORY') delete env[k];
  }
  return { args, env };
}

// createTerminal({appDir, port, token, send(channel, payload)}) -> {start, input, resize, stop, running}
function createTerminal({ appDir, port, token, send }) {
  let proc = null, generation = 0;

  function spawnClaude({ modelDir, model, systemPrompt, cols, rows, resume }) {
    const claude = findClaude(appDir);
    if (!claude) throw new Error('Claude Code is not installed with the app (run npm install in app/).');
    const pty = loadPty(appDir);
    const { args, env } = claudeArgs({ port, token, model, systemPrompt, resume });
    return pty.spawn(claude, args, { name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd: modelDir, env });
  }

  // Start (or keep) the process. The last conversation in this folder is continued; when there is none, Claude Code
  // exits at once and it is started again fresh.
  function start(opts) {
    if (proc) { try { proc.resize(opts.cols || 80, opts.rows || 24); } catch { /* ignore */ } return { running: true, already: true }; }
    const gen = ++generation;
    const launch = resume => {
      const started = Date.now();
      let p;
      try { p = spawnClaude({ ...opts, resume }); } catch (e) { send('term:data', `\r\n${e.message}\r\n`); send('term:exit', { code: 1 }); return; }
      proc = p;
      let held = resume ? '' : null;       // output of a --continue attempt is held back until it is clearly running
      const flush = () => { if (held !== null) { if (held) send('term:data', held); held = null; } };
      const timer = resume ? setTimeout(flush, 2500) : null;
      p.onData(d => { if (gen !== generation) return; if (held !== null) held += d; else send('term:data', d); });
      p.onExit(({ exitCode }) => {
        if (timer) clearTimeout(timer);
        if (proc === p) proc = null;
        if (gen !== generation) return;
        if (resume && exitCode !== 0 && Date.now() - started < 8000 && held !== null) return launch(false);
        flush();
        send('term:exit', { code: exitCode });
      });
    };
    launch(opts.resume === undefined ? true : opts.resume);
    return { running: true, already: false };
  }

  return {
    start,
    input(data) { if (proc) proc.write(String(data)); },
    resize(cols, rows) { if (proc && cols > 1 && rows > 1) { try { proc.resize(cols, rows); } catch { /* ignore */ } } },
    stop() { generation++; const p = proc; proc = null; if (p) { try { p.kill(); } catch { /* ignore */ } } },
    get running() { return !!proc; },
  };
}

module.exports = { createTerminal, findClaude, claudeArgs, newToken: () => crypto.randomBytes(24).toString('hex') };
