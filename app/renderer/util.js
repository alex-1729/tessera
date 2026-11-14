// Small DOM helper and formatting.
export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  const add = k => {
    if (Array.isArray(k)) return k.forEach(add);
    if (k === null || k === undefined || k === false) return;
    e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  };
  kids.forEach(add);
  return e;
}

export function link(href, text, cls) { return h('a', { href, class: cls }, text); }

export function fmtDate(iso) {
  if (!iso) return '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : String(iso);
}

export function fmtNumber(x) {
  if (typeof x !== 'number') return String(x);
  if (x === 0) return '0';
  return Math.abs(x) < 0.0001 ? x.toExponential(2) : String(+x.toFixed(6));
}

// Show {name} markers in an Excel formula as plain names.
export function plainFormula(f) { return String(f || '').replace(/\{([^}]+)\}/g, '$1'); }

export function checksum(bytes) {
  let a = 2166136261 >>> 0;
  for (let i = 0; i < bytes.length; i++) { a ^= bytes[i]; a = Math.imul(a, 16777619) >>> 0; }
  return bytes.length + ':' + a.toString(16);
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

