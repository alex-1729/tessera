// The module view's map of its tiles: every link drawn, which the tile strip cannot show (the strip only marks a
// tile that reads the one just before it). A solid arrow runs from a tile to each tile that reads it; a dashed
// arrow is a value carried forward to the next month (a state: this month's end value is next month's start).
// A light box lists what the module reads from outside. Sections of the module, when it has them, are bands.
import { q, tileStatus, mapWord } from './logic.js';
import { layeredLayout } from './layout.js';
import { s, el, INK, arrowDefs, box, listBox, polyline, outsideRoute, markLast, legend } from './maps.js';

const SOFT = '#7a838c';

export function tileMap(S, moduleId, avail = 700) {
  const mod = S.graph.modules.find(m => m.id === moduleId);
  if (!mod || !mod.tiles.length) return null;
  const own = new Set(mod.tiles);
  const argsOf = t => (q(S, t) || {}).args || [];
  const kindOf = n => (q(S, n) || {}).kind;

  // bands: the module's titled sections in order, or one band when it has none
  const titled = (mod.sections || []).filter(x => x && x.title && (x.tiles || []).some(t => own.has(t)));
  const sectionOf = new Map();
  (mod.sections || []).forEach((x, i) => (x.tiles || []).forEach(t => sectionOf.set(t, i)));
  const banded = titled.length > 0 && (mod.sections || []).length > 1;
  const bandIds = banded ? [...new Set(mod.tiles.map(t => (sectionOf.has(t) ? sectionOf.get(t) : -1)))].sort((a, b) => (a < 0 ? 1e9 : a) - (b < 0 ? 1e9 : b)) : [0];
  const bandOf = t => (banded ? (sectionOf.has(t) ? sectionOf.get(t) : -1) : 0);

  // links inside the module, and values carried forward (a state read by a tile here, fed by a tile here)
  const edges = [];
  for (const t of mod.tiles) {
    for (const a of argsOf(t)) {
      if (own.has(a) && a !== t) edges.push({ from: a, to: t });
      const st = q(S, a);
      // (a tile that reads its own value from last month needs no arrow to itself: the dashed arrows out of it say so)
      if (st && st.kind === 'state' && own.has(st.from) && st.from !== t) edges.push({ from: st.from, to: t, carried: true, state: a });
    }
  }
  const plain = edges.filter(e => !e.carried);

  // depth inside each band from same-band links; a band's ranks follow the band before it
  const depth = new Map();
  const dep = id => {
    if (depth.has(id)) return depth.get(id);
    depth.set(id, 0);
    const d = Math.max(-1, ...plain.filter(e => e.to === id && bandOf(e.from) === bandOf(id)).map(e => dep(e.from))) + 1;
    depth.set(id, d); return d;
  };
  let offset = 1;                       // rank 0 is the box of what comes from outside
  const start = new Map();
  for (const b of bandIds) {
    start.set(b, offset);
    offset += Math.max(...mod.tiles.filter(t => bandOf(t) === b).map(t => dep(t))) + 1;
  }

  const nodes = [];
  // what the module reads from outside: input series, values carried forward from elsewhere, other modules' tiles
  const outside = [...new Set(mod.tiles.flatMap(argsOf).filter(a => {
    const k = kindOf(a);
    if (k === 'input') return true;
    if (k === 'tile') return !own.has(a);
    if (k === 'state') return !own.has((q(S, a) || {}).from);
    return false;
  }))];
  if (outside.length) {
    const cols = outside.length > 6 ? 2 : 1, per = Math.ceil(outside.length / cols);
    nodes.push({ id: '\u0000outside', outside: true, names: outside, cols, rank: 0,
      w: Math.max(110, cols * (Math.max(...outside.map(x => x.length)) * 6.3 + 10) + 12), h: 20 + per * 13 + 4 });
    for (const t of mod.tiles) if (argsOf(t).some(a => outside.includes(a))) edges.push({ from: '\u0000outside', to: t, light: true });
  }
  for (const t of mod.tiles) {
    const label = (q(S, t) || {}).label || '';
    nodes.push({ id: t, tile: true, rank: start.get(bandOf(t)) + dep(t), w: Math.max(128, Math.ceil(Math.max(t.length * 6.9, label.length * 5.6) + 22)), h: 42 });
  }

  const labelW = banded ? 96 : 0;
  // carried-forward arrows run round the right-hand side: leave room for them inside the width given
  const carriedN = edges.filter(e => e.carried).length;
  const room = carriedN ? 26 + carriedN * 8 : 0;
  const lay = layeredLayout({ nodes, edges, maxWidth: Math.max(avail - room, 240), left: labelW, gy: 30 });
  markLast(lay.pos);
  const backs = lay.back;
  const reserve = backs.length ? 14 + backs.length * 8 : 0;
  const W = lay.W + reserve, H = lay.H + 4;
  const svg = s('svg', { class: 'map tilemap', width: W, height: H, viewBox: `0 0 ${W} ${H}` }, arrowDefs());

  if (banded) {
    const rowsOf = b => [...new Set(mod.tiles.filter(t => bandOf(t) === b).map(t => lay.pos.get(t).row))];
    bandIds.forEach((b, bi) => {
      const rs = rowsOf(b);
      const top = Math.min(...rs.map(r => lay.rows[r].top)), bottom = Math.max(...rs.map(r => lay.rows[r].bottom));
      const title = b < 0 ? 'Other' : (mod.sections[b].title || 'Other');
      // the section's name down the left, wrapped at about fourteen characters
      const words = title.split(' '), lines = [];
      for (const w of words) { if (lines.length && (lines[lines.length - 1] + ' ' + w).length <= 14) lines[lines.length - 1] += ' ' + w; else lines.push(w); }
      lines.forEach((ln, i) => svg.append(s('text', { x: 2, y: (top + bottom) / 2 + 4 + (i - (lines.length - 1) / 2) * 12, class: 'lbl' }, ln)));
      if (bi > 0) {
        const prev = rowsOf(bandIds[bi - 1]);
        const y = (Math.max(...prev.map(r => lay.rows[r].bottom)) + top) / 2;
        svg.append(s('line', { x1: 0, y1: y, x2: W, y2: y, stroke: '#cfc6b4', 'stroke-width': 1 }));
      }
    });
  }
  for (const e of edges) {
    const pts = lay.routes.get(e); if (!pts) continue;
    pts[pts.length - 1] = [pts[pts.length - 1][0], pts[pts.length - 1][1] - 1];
    svg.append(s('path', { d: polyline(pts), fill: 'none', stroke: e.light ? SOFT : INK, 'stroke-width': 1, 'stroke-dasharray': e.carried ? '5 3' : null, 'marker-end': e.light ? 'url(#arrg)' : 'url(#arr)' }));
  }
  backs.forEach((e, i) => {
    const pts = outsideRoute(lay.pos.get(e.from), lay.pos.get(e.to), lay.rows, lay.W + 6, i, 30);
    svg.append(s('path', { d: polyline(pts), fill: 'none', stroke: INK, 'stroke-width': 1, 'stroke-dasharray': '5 3', 'marker-end': 'url(#arr)' }));
  });
  for (const n of nodes) {
    const p = { ...lay.pos.get(n.id) };
    if (n.outside) { svg.append(listBox({ ...p, cols: n.cols }, 'From outside', n.names)); continue; }
    const st = (tileStatus(S, n.id) || {}).state;
    svg.append(box(p, { name: n.id, status: mapWord(st), state: st, href: '#/tile/' + encodeURIComponent(n.id) }));
  }
  const carried = edges.some(e => e.carried);
  const wrap = el('div', 'mapwrap');
  wrap.id = 'tilemap';
  wrap.append(svg, legend('An arrow runs from a tile to each tile that reads it.' + (carried ? ' Dashed = carried forward: the value at the end of one month is read at the start of the next.' : '')
    + ' Outline: thin = signed off, thick = not signed off, dashed = stale, dotted = not built.'));
  return wrap;
}
