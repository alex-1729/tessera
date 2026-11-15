'use strict';
// Local http server: /gridcraft/* -> vendor web build, /app/* -> app/renderer.
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveInside(root, rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const file = path.resolve(root, '.' + path.sep + decoded);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

// `roots` adds more read-only folders ({'/prefix/': dir}); `handler(req, res)` gets each request first and returns true
// when it has answered it (the terminal's bridge uses this for its POSTs).
function startServer({ gridcraftDir, rendererDir, roots: more = {}, handler = null }) {
  const roots = { '/gridcraft/': path.resolve(gridcraftDir), '/app/': path.resolve(rendererDir) };
  for (const [k, v] of Object.entries(more)) roots[k] = path.resolve(v);
  const server = http.createServer((req, res) => {
    if (handler && handler(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
    const u = new URL(req.url, 'http://127.0.0.1');
    const prefix = Object.keys(roots).find(p => u.pathname.startsWith(p));
    if (!prefix) { res.statusCode = 404; return res.end('Not found'); }
    const rel = u.pathname.slice(prefix.length);
    const file = resolveInside(roots[prefix], rel === '' ? 'index.html' : rel);
    if (!file) { res.statusCode = 403; return res.end('Forbidden'); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.statusCode = 404; return res.end('Not found'); }
      res.setHeader('content-type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('content-length', st.size);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { startServer, resolveInside };
