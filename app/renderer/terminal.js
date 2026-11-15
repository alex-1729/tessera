// Claude Code in the chat pane: an xterm.js terminal joined to the `claude` process the main process runs for the
// open model. The element lives for the life of the window; views re-attach it on every render.
import { h } from './util.js';

const api = () => (window.api && window.api.term) || null;
export const available = () => !!api();
export const el = h('div', { class: 'termhost', id: 'termhost' });

let term = null, fit = null, started = false, ready = false, ended = false;
const waiting = [];          // text to type once Claude Code is up

function script(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.append(s);
  });
}

async function boot() {
  document.head.append(h('link', { rel: 'stylesheet', href: '/xterm/xterm/css/xterm.css' }));
  await script('/xterm/xterm/lib/xterm.js');
  await script('/xterm/addon-fit/lib/addon-fit.js');
  term = new window.Terminal({
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.15, cursorBlink: true, scrollback: 5000,
    macOptionIsMeta: true, allowProposedApi: false,
    theme: { background: '#14213d', foreground: '#f4efe6', cursor: '#e08a5c', cursorAccent: '#14213d', selectionBackground: '#3b4d7a' },
  });
  fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.onData(d => {
    if (ended) { if (d === '\r') void launch(); return; }
    api().input(d);
  });
  api().onData(d => {
    term.write(d);
    if (!ready) { ready = true; setTimeout(flush, 1500); }
  });
  api().onExit(info => {
    ended = true; ready = false;
    if (info && info.restart) { term.reset(); void launch(); return; }
    term.write('\r\n\x1b[2mClaude Code has ended. Press Enter to start it again.\x1b[0m\r\n');
  });
  new ResizeObserver(() => resize()).observe(el);
  await launch();
}

function resize() {
  if (!term || !el.clientWidth || !el.clientHeight) return;
  try { fit.fit(); } catch { return; }
  api().resize({ cols: term.cols, rows: term.rows });
}

async function launch() {
  ended = false;
  try { fit.fit(); } catch { /* not laid out yet */ }
  const r = await api().start({ cols: term.cols, rows: term.rows }).catch(e => { term.write(`\r\n${e.message}\r\n`); return null; });
  if (r && r.already) { ready = true; flush(); }
}

function flush() { while (ready && waiting.length) api().input(waiting.shift()); }

// Called by the chat pane each time it is shown: starts Claude Code the first time the pane has a size.
export function show() {
  if (!available() || started || !el.isConnected || !el.clientWidth) { if (term) resize(); return; }
  started = true;
  void boot();
}

// Type text at Claude Code's prompt; with `enter` it is sent. Held until Claude Code is up.
export function type(text, enter) {
  const clean = String(text).replace(/\r?\n/g, ' ').trim();
  if (!clean) return;
  waiting.push(clean);
  if (enter) waiting.push('\r');
  flush();
  if (term) term.focus();
}

export const focus = () => { if (term) term.focus(); };
