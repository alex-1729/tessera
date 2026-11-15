'use strict';
// Run by Claude Code (through Electron's own Node: ELECTRON_RUN_AS_NODE=1), never by the app itself.
//   cli-bridge.js mcp           an MCP server on stdin/stdout that offers the app's tools and passes each call to the app
//   cli-bridge.js hook prompt   UserPromptSubmit hook: prints what is selected in the app, which Claude Code adds to the message
//   cli-bridge.js hook stop     Stop hook: tells the app the turn is over
// The app is reached on 127.0.0.1:$TESSERA_PORT with $TESSERA_TOKEN; nothing else is contacted.
const http = require('http');

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request({ host: '127.0.0.1', port: Number(process.env.TESSERA_PORT), path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-tessera-token': process.env.TESSERA_TOKEN || '' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(text || `The app answered ${res.statusCode}.`));
        try { resolve(JSON.parse(text)); } catch { reject(new Error('The app sent an answer that is not JSON.')); }
      });
    });
    req.on('error', () => reject(new Error('Tessera is not running, so its tools are not available.')));
    req.end(data);
  });
}

async function mcp() {
  const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
  const handle = async msg => {
    if (msg.id === undefined || msg.id === null) return;            // a notification: nothing to answer
    const ok = result => send({ jsonrpc: '2.0', id: msg.id, result });
    try {
      if (msg.method === 'initialize') return ok({ protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tiles', version: '0.3.0' } });
      if (msg.method === 'ping') return ok({});
      if (msg.method === 'tools/list') return ok({ tools: (await post('/agent/tools')).tools });
      if (msg.method === 'tools/call') return ok(await post('/agent/call', { name: msg.params && msg.params.name, args: (msg.params && msg.params.arguments) || {} }));
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } });
    } catch (e) {
      if (msg.method === 'tools/call') ok({ content: [{ type: 'text', text: String(e && e.message || e) }], isError: true });
      else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e && e.message || e) } });
    }
  };
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      void handle(msg);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// What Claude Code passes a hook on stdin (JSON with the session id); empty if nothing arrives.
function stdinJson() {
  return new Promise(resolve => {
    let buf = '';
    const done = () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { buf += c; });
    process.stdin.on('end', done);
    setTimeout(done, 1500);
  });
}

async function hook(kind) {
  try {
    const input = await stdinJson();
    const r = await post('/agent/hook/' + kind, { session_id: input.session_id || null });
    if (kind === 'prompt' && r.text) process.stdout.write(r.text + '\n');
  } catch { /* the app is gone: the message goes without the selection line */ }
  process.exit(0);
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'mcp') void mcp();
else if (mode === 'hook' && (arg === 'prompt' || arg === 'stop')) void hook(arg);
else { process.stderr.write('usage: cli-bridge.js mcp | hook prompt | hook stop\n'); process.exit(2); }
