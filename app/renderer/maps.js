// SVG maps, computed from the graph with a layered layout (layout.js).
// Outline: signed off = 1px, not signed off = 2px, stale = dashed. Inputs, parameters and state are lighter boxes.
import { q, tileStatus, mapWord, moduleMapWord } from './logic.js';
import { layeredLayout } from './layout.js';

const NS = 'http://www.w3.org/2000/svg';
const MONO = 6.6;
function s(tag, attrs, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) e.setAttribute(k, v);
  for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

const DOTTED = '1.5 3';
const INK = '#14213d', FAINT = '#a9a08c', SOFT = '#7a838c';
function outline(state, light, proposed) {
  if (proposed || state === 'not_built') return { stroke: INK, 'stroke-width': 1, 'stroke-dasharray': DOTTED };
  if (light) return { stroke: FAINT, 'stroke-width': 1 };
  if (state === 'signed_off') return { stroke: INK, 'stroke-width': 1 };
  if (state === 'stale') return { stroke: INK, 'stroke-width': 1, 'stroke-dasharray': '4 3' };
  return { stroke: INK, 'stroke-width': 2 };
}

function arrowDefs() {
  return s('defs', {},
    s('marker', { id: 'arr', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto' },
      s('path', { d: 'M0,1 L9,5 L0,9 z', fill: INK })),
    s('marker', { id: 'arrg', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto' },
      s('path', { d: 'M0,1 L9,5 L0,9 z', fill: SOFT })));
}

function box(n, { name, status, state, light, href, mono = true, proposed = false }) {
  const inner = [
    s('rect', { x: n.x, y: n.y, width: n.w, height: n.h, fill: '#fff', ...outline(state, light, proposed) }),
    s('text', { x: n.x + n.w / 2, y: n.y + (n.h > 38 ? 17 : 15), 'text-anchor': 'middle', class: (mono ? 'nm' : 'ti') + (light ? ' dim' : '') }, name),
    s('text', { x: n.x + n.w / 2, y: n.y + n.h - 8, 'text-anchor': 'middle', class: 'st' }, status),
  ];
  return href ? s('a', { href, style: 'cursor:pointer' }, inner) : s('g', {}, inner);
}

// A small list box: "Parameters" heading and the names under it.
function listBox(n, title, names) {
  const g = [s('rect', { x: n.x, y: n.y, width: n.w, height: n.h, fill: '#fff', stroke: FAINT, 'stroke-width': 1 }),
    s('text', { x: n.x + 6, y: n.y + 12, class: 'st' }, title)];
  const cols = n.cols || 1, per = Math.ceil(names.length / cols), colW = (n.w - 12) / cols;
  names.forEach((nm, i) => g.push(s('text', { x: n.x + 6 + Math.floor(i / per) * colW, y: n.y + 26 + (i % per) * 13, class: 'nm dim', style: 'font-size:10.5px' }, nm)));
  return s('g', {}, g);
}

const polyline = pts => 'M' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L');

// Dashed link routed round the outside: out of `a` to the right margin, along it, and back into `b`.
function outsideRoute(a, b, rows, marginX, k, gy) {
  const rowA = rows[a.row], rowB = rows[b.row];
  const mx = marginX + k * 8;
  const pts = [];
  if (a.last) pts.push([a.x + a.w, a.y + a.h / 2], [mx, a.y + a.h / 2]);
  else { const gyA = rowA.bottom + gy * 0.45 + k * 3; pts.push([a.x + a.w - 6, a.y + a.h], [a.x + a.w - 6, gyA], [mx, gyA]); }
  if (b.last) pts.push([mx, b.y + b.h / 2], [b.x + b.w + 1, b.y + b.h / 2]);
  else { const gyB = rowB.top - gy * 0.45 - k * 3; pts.push([mx, gyB], [b.x + b.w - 6, gyB], [b.x + b.w - 6, b.y - 1]); }
  return pts;
}

function markLast(pos) {
  const maxRight = new Map();
  for (const p of pos.values()) maxRight.set(p.row, Math.max(maxRight.get(p.row) || 0, p.x + p.w));
  for (const p of pos.values()) p.last = Math.abs(p.x + p.w - maxRight.get(p.row)) < 0.5;
}

function legend(text) { return el('p', 'legend', text); }

// `proposed` = items of a pending tile draft for this module: [{name, args, label}]. Only tiles that do not exist yet are drawn.
export function moduleMap(S, mod, avail = 700, proposed = []) {
  const order = S.graph.order || mod.tiles;
  const fresh = proposed.filter(p => !q(S, p.name));
  const prop = new Map(fresh.map(p => [p.name, p]));
  const argsOf = t => (prop.has(t) ? prop.get(t).args : (q(S, t) || {}).args) || [];
  const tiles = [...mod.tiles].sort((a, b) => order.indexOf(a) - order.indexOf(b)).concat(fresh.map(p => p.name));
  const own = new Set(tiles);
  const info = new Map();
  for (const t of tiles) info.set(t, { id: t, kind: 'tile', own: true, proposed: prop.has(t) });
  const consumers = new Map();
  for (const t of tiles) for (const a of argsOf(t)) {
    if (!info.has(a)) info.set(a, { id: a, kind: (q(S, a) || {}).kind || 'input', own: false });
    (consumers.get(a) || consumers.set(a, []).get(a)).push(t);
  }
  const depth = new Map();
  const dep = t => {
    if (depth.has(t)) return depth.get(t);
    depth.set(t, 0);
    const d = Math.max(-1, ...argsOf(t).filter(a => own.has(a)).map(dep)) + 1;
    depth.set(t, d); return d;
  };
  tiles.forEach(dep);
  const rankOf = new Map();
  for (const t of tiles) rankOf.set(t, depth.get(t) + 1);
  for (const [id, n] of info) if (!n.own) rankOf.set(id, Math.min(...consumers.get(id).map(t => rankOf.get(t))) - 1);

  const params = [...info.values()].filter(n => n.kind === 'param');
  const grouped = params.length >= 4;
  const nodes = [], edges = [];
  const w = nm => Math.max(96, Math.ceil(nm.length * MONO + 18));
  for (const [id, n] of info) {
    if (grouped && n.kind === 'param') continue;
    nodes.push({ id, w: w(id), h: n.own || n.kind === 'tile' ? 40 : 36, rank: rankOf.get(id), n });
  }
  const groups = new Map();   // rank of consumers -> {id, names, tiles}
  if (grouped) {
    for (const p of params) for (const t of consumers.get(p.id)) {
      const r = rankOf.get(t);
      const g = groups.get(r) || groups.set(r, { id: 'params@' + r, names: [], tiles: new Set(), rank: r - 1 }).get(r);
      if (!g.names.includes(p.id)) g.names.push(p.id);
      g.tiles.add(t);
    }
    for (const g of groups.values()) {
      const longest = Math.max(...g.names.map(x => x.length));
      const cols = g.names.length > 6 && 2 * (longest * 6.3 + 10) + 12 <= avail * 0.7 ? 2 : 1, per = Math.ceil(g.names.length / cols);
      nodes.push({ id: g.id, w: Math.max(104, cols * (longest * 6.3 + 10) + 12), h: 20 + per * 13 + 4, rank: g.rank, group: g, cols });
      for (const t of g.tiles) edges.push({ from: g.id, to: t, light: true });
    }
  }
  for (const t of tiles) for (const a of argsOf(t)) {
    if (grouped && info.get(a).kind === 'param') continue;
    edges.push({ from: a, to: t, light: !(info.get(a).kind === 'tile'), proposed: prop.has(t) });
  }
  const carries = [];
  for (const n of info.values()) if (n.kind === 'state') { const from = q(S, n.id).from; if (own.has(from)) carries.push({ from, to: n.id }); }

  const reserve = carries.length ? 24 + 70 + carries.length * 8 : 0;
  const lay = layeredLayout({ nodes, edges, maxWidth: avail, reserveRight: reserve, gy: 36 });
  markLast(lay.pos);
  const top = carries.length ? 18 : 0;   // room above the first row for a link that returns to it
  const W = lay.W + reserve, H = lay.H + 4 + top;
  const svg0 = s('svg', { class: 'map', width: W, height: H, viewBox: `0 0 ${W} ${H}` }, arrowDefs());
  const svg = s('g', { transform: `translate(0,${top})` });
  svg0.append(svg);
  for (const e of edges) {
    const pts = lay.routes.get(e); if (!pts) continue;
    pts[pts.length - 1] = [pts[pts.length - 1][0], pts[pts.length - 1][1] - 1];
    svg.append(s('path', { d: polyline(pts), fill: 'none', stroke: e.light ? SOFT : INK, 'stroke-width': 1, 'stroke-dasharray': e.proposed ? DOTTED : null, 'marker-end': e.light ? 'url(#arrg)' : 'url(#arr)' }));
  }
  carries.forEach((c, i) => {
    const a = lay.pos.get(c.from), b = lay.pos.get(c.to);
    const pts = outsideRoute(a, b, lay.rows, lay.W + 10, i, 36);
    svg.append(s('path', { d: polyline(pts), fill: 'none', stroke: INK, 'stroke-width': 1, 'stroke-dasharray': '5 3', 'marker-end': 'url(#arr)' }));
    const onMargin = pts.filter(p => p[0] === lay.W + 10 + i * 8);
    const my = (onMargin[0][1] + onMargin[onMargin.length - 1][1]) / 2;
    svg.append(s('text', { x: lay.W + 10 + i * 8 + 5, y: my + 3, class: 'lbl' }, 'next period'));
  });
  for (const n of nodes) {
    const p = { ...lay.pos.get(n.id) };
    if (n.group) { svg.append(listBox({ ...p, cols: n.cols }, 'Parameters', n.group.names)); continue; }
    const info1 = n.n;
    if (info1.proposed) {
      svg.append(box(p, { name: n.id, status: 'proposed', state: null, proposed: true }));
    } else if (info1.kind === 'tile') {
      const st = (tileStatus(S, n.id) || {}).state;
      svg.append(box(p, { name: n.id, status: mapWord(st), state: st, href: '#/tile/' + encodeURIComponent(n.id) }));
    } else {
      svg.append(box(p, { name: n.id, status: info1.kind === 'state' ? 'carried forward' : 'input', light: true }));
    }
  }
  const wrap = el('div', 'mapwrap');
  const dotted = fresh.length || tiles.some(t => !prop.has(t) && (tileStatus(S, t) || {}).state === 'not_built');
  wrap.append(svg0, legend('Outline: thin = signed off, thick = not signed off, dashed = stale.' + (dotted ? ' Dotted = not built or proposed.' : '') + (carries.length ? ' Dashed arrow = carried to the next period.' : '')));
  return wrap;
}

// `proposed` = items of a pending module draft: [{id, title, layer, feeds}]. New modules are drawn dotted; new feeds too.
export function modelMap(S, avail = 700, proposed = []) {
  const existingIds = new Set(S.graph.modules.map(m => m.id));
  const fresh = proposed.filter(p => !existingIds.has(p.id));
  const g = { ...S.graph, modules: [...S.graph.modules, ...fresh.map(p => ({ id: p.id, title: p.title || p.id, layer: p.layer, feeds: p.feeds || [], inputs: [], tiles: [], proposed: true }))] };
  const layers = [...g.layers];
  for (const m of g.modules) if (!layers.includes(m.layer)) layers.push(m.layer);
  const hasModel = l => g.modules.some(m => m.layer === l);
  const inputNames = Object.entries(g.quantities).filter(([, x]) => x.kind === 'input').map(([k]) => k);
  const bands = layers.filter(l => hasModel(l) || (inputNames.length && l === g.layers[0] && !hasModel(l)));

  const nodes = [], edges = [];
  const bandOf = new Map();
  const edgeList = [];
  for (const m of g.modules) for (const f of m.feeds || []) if (g.modules.some(x => x.id === f)) edgeList.push({ from: m.id, to: f, proposed: !!m.proposed });
  for (const p of proposed) for (const f of p.feeds || []) {
    if (existingIds.has(p.id) && g.modules.some(x => x.id === f) && !edgeList.some(e => e.from === p.id && e.to === f)) edgeList.push({ from: p.id, to: f, proposed: true });
  }
  // local depth inside each band from same-band edges; the band's ranks follow the previous band's
  const depth = new Map();
  const dep = id => {
    if (depth.has(id)) return depth.get(id);
    depth.set(id, 0);
    const m = g.modules.find(x => x.id === id);
    const d = Math.max(-1, ...edgeList.filter(e => e.to === id && g.modules.find(x => x.id === e.from).layer === m.layer).map(e => dep(e.from))) + 1;
    depth.set(id, d); return d;
  };
  let offset = 0;
  const bandStart = new Map();
  for (const b of bands) {
    bandStart.set(b, offset);
    const ms = g.modules.filter(m => m.layer === b);
    const span = ms.length ? Math.max(...ms.map(m => dep(m.id))) + 1 : 1;
    offset += span;
  }
  const inBand = bands.find(b => !hasModel(b));
  if (inBand) nodes.push({ id: 'inputs', w: 0, h: 0, rank: bandStart.get(inBand), inputs: true });
  for (const m of g.modules) {
    const title = m.title;
    nodes.push({ id: m.id, w: Math.max(130, Math.ceil(title.length * 6.8 + 24)), h: 42, rank: bandStart.get(m.layer) + dep(m.id), m });
    bandOf.set(m.id, m.layer);
  }
  if (inBand) {
    const n = nodes.find(x => x.inputs);
    const names = inputNames;
    const lg = Math.max(...names.map(x => x.length));
    const cols = names.length > 6 && 2 * (lg * 6.3 + 10) + 12 <= avail * 0.5 ? 2 : 1, per = Math.ceil(names.length / cols);
    n.cols = cols; n.names = names; n.w = Math.max(104, cols * (Math.max(...names.map(x => x.length)) * 6.3 + 10) + 12); n.h = 20 + per * 13 + 4;
    for (const m of g.modules) if ((m.inputs || []).some(i => (q(S, i) || {}).kind === 'input')) edges.push({ from: 'inputs', to: m.id, light: true });
  }
  edges.push(...edgeList);

  const labelW = 84;
  const lay = layeredLayout({ nodes, edges, maxWidth: avail, left: labelW, gy: 30 });
  markLast(lay.pos);
  const backs = lay.back;
  const reserve = backs.length ? 20 + backs.length * 8 + 60 : 0;
  const W = lay.W + reserve, H = lay.H + 4;
  const svg = s('svg', { class: 'map', width: W, height: H, viewBox: `0 0 ${W} ${H}` }, arrowDefs());

  // bands: a thin rule between bands, the layer name at the left
  const rowsOf = b => [...new Set(nodes.filter(n => (n.inputs ? b === inBand : n.m.layer === b)).map(n => lay.pos.get(n.id).row))];
  bands.forEach((b, bi) => {
    const rs = rowsOf(b);
    const top = Math.min(...rs.map(r => lay.rows[r].top)), bottom = Math.max(...rs.map(r => lay.rows[r].bottom));
    svg.append(s('text', { x: 2, y: (top + bottom) / 2 + 4, class: 'lbl' }, b));
    if (bi > 0) {
      const prev = rowsOf(bands[bi - 1]);
      const y = (Math.max(...prev.map(r => lay.rows[r].bottom)) + top) / 2;
      svg.append(s('line', { x1: 0, y1: y, x2: W, y2: y, stroke: '#cfc6b4', 'stroke-width': 1 }));
    }
  });
  for (const e of edges) {
    const pts = lay.routes.get(e); if (!pts) continue;
    pts[pts.length - 1] = [pts[pts.length - 1][0], pts[pts.length - 1][1] - 1];
    svg.append(s('path', { d: polyline(pts), fill: 'none', stroke: e.light ? SOFT : INK, 'stroke-width': 1, 'stroke-dasharray': e.proposed ? DOTTED : null, 'marker-end': e.light ? 'url(#arrg)' : 'url(#arr)' }));
  }
  backs.forEach((e, i) => {
    const pts = outsideRoute(lay.pos.get(e.from), lay.pos.get(e.to), lay.rows, lay.W + 6, i, 30);
    svg.append(s('path', { d: polyline(pts), fill: 'none', stroke: INK, 'stroke-width': 1, 'stroke-dasharray': '5 3', 'marker-end': 'url(#arr)' }));
  });
  for (const n of nodes) {
    const p = { ...lay.pos.get(n.id) };
    if (n.inputs) { svg.append(listBox({ ...p, cols: n.cols }, 'Inputs', n.names)); continue; }
    if (n.m.proposed) { svg.append(box(p, { name: n.m.title, status: 'proposed', state: null, proposed: true, mono: false })); continue; }
    const st = S.status.modules[n.m.id].state;
    svg.append(box(p, { name: n.m.title, status: moduleMapWord(S, n.m), state: st, href: '#/module/' + encodeURIComponent(n.m.id), mono: false }));
  }
  const wrap = el('div', 'mapwrap');
  wrap.append(svg, legend('Outline: thin = signed off, thick = not signed off, dashed = stale.' + (fresh.length ? ' Dotted = proposed.' : '') + ' Arrows point from a module to the modules it feeds.'));
  return wrap;
}
