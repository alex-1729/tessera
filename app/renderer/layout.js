// Layered graph layout. No DOM here.
//
// Input: nodes [{id, w, h, rank}] (rank = layer, any integers) and edges [{from, to}].
// Edges must go from a lower rank to a higher rank; others are returned in `back` for the caller to route.
// Steps: compress ranks, order nodes in each rank by barycentre sweeps (keeping the order with fewest
// crossings), split over-wide ranks into several rows, place x by neighbour averaging, then route every edge
// through a dummy point in each rank it passes, so it runs between boxes and never through one.
//
// Output: {pos: Map id -> {x, y, w, h, row}, rows: [{top, bottom}], routes: Map edge -> [[x, y], ...], back, W, H}

export function layeredLayout({ nodes, edges, maxWidth = 700, gx = 16, gy = 34, pad = 8, dummyW = 12, left = 0, reserveRight = 0 }) {
  const N = new Map();
  nodes.forEach((n, i) => N.set(n.id, { id: n.id, w: n.w, h: n.h, rank: n.rank, real: true, seq: i }));
  const used = [...new Set(nodes.map(n => n.rank))].sort((a, b) => a - b);
  const remap = new Map(used.map((r, i) => [r, i]));
  for (const n of N.values()) n.rank = remap.get(n.rank);

  const fwd = [], back = [];
  for (const e of edges) {
    const a = N.get(e.from), b = N.get(e.to);
    if (!a || !b) continue;
    (b.rank > a.rank ? fwd : back).push(e);
  }

  // Builds dummies for the current ranks. `seed` (optional) is a Map id -> sort key for the real nodes.
  function build(seed) {
    const items = [...N.values()];
    const chains = new Map();
    let k = 0;
    for (const e of fwd) {
      const a = N.get(e.from), b = N.get(e.to);
      const chain = [];
      for (let r = a.rank + 1; r < b.rank; r++) {
        const d = { id: 'dummy' + (k++), w: dummyW, h: 0, rank: r, real: false, seq: 1e6 + k };
        chain.push(d); items.push(d);
      }
      chains.set(e, chain);
    }
    const R = Math.max(0, ...items.map(i => i.rank)) + 1;
    const ranks = Array.from({ length: R }, () => []);
    for (const it of items) ranks[it.rank].push(it);
    for (const r of ranks) r.sort((a, b) => (seed ? (seed.get(a.id) ?? 1e6 + a.seq) - (seed.get(b.id) ?? 1e6 + b.seq) : a.seq - b.seq));
    const up = new Map(items.map(i => [i.id, []])), down = new Map(items.map(i => [i.id, []]));
    for (const e of fwd) {
      const seq = [N.get(e.from), ...chains.get(e), N.get(e.to)];
      for (let i = 0; i + 1 < seq.length; i++) { down.get(seq[i].id).push(seq[i + 1].id); up.get(seq[i + 1].id).push(seq[i].id); }
    }
    return { items, chains, ranks, up, down };
  }

  const positions = ranks => { const m = new Map(); ranks.forEach(r => r.forEach((n, i) => m.set(n.id, i))); return m; };

  function crossings(g) {
    const idx = positions(g.ranks);
    let c = 0;
    for (let r = 0; r + 1 < g.ranks.length; r++) {
      const links = [];
      for (const n of g.ranks[r]) for (const m of g.down.get(n.id)) links.push([idx.get(n.id), idx.get(m)]);
      for (let i = 0; i < links.length; i++) for (let j = i + 1; j < links.length; j++) {
        if ((links[i][0] - links[j][0]) * (links[i][1] - links[j][1]) < 0) c++;
      }
    }
    return c;
  }

  function sweep(g, dir) {
    const idx = positions(g.ranks);
    const R = g.ranks.length;
    const rs = [];
    if (dir > 0) for (let r = 1; r < R; r++) rs.push(r); else for (let r = R - 2; r >= 0; r--) rs.push(r);
    for (const r of rs) {
      const nb = dir > 0 ? g.up : g.down;
      const keyed = g.ranks[r].map((n, i) => {
        const ns = nb.get(n.id);
        return { n, i, k: ns.length ? ns.reduce((s, m) => s + idx.get(m), 0) / ns.length : i };
      });
      keyed.sort((a, b) => a.k - b.k || a.i - b.i);
      g.ranks[r] = keyed.map(x => x.n);
      g.ranks[r].forEach((n, i) => idx.set(n.id, i));
    }
  }

  function order(g, rounds) {
    let best = g.ranks.map(r => r.slice()), bestC = crossings(g);
    for (let i = 0; i < rounds && bestC > 0; i++) {
      sweep(g, i % 2 === 0 ? 1 : -1);
      const c = crossings(g);
      if (c < bestC) { bestC = c; best = g.ranks.map(r => r.slice()); }
    }
    g.ranks = best;
  }

  let g = build();
  order(g, 10);

  // Split over-wide ranks into several rows, in the order found.
  const cap = Math.max(60, maxWidth - left - pad * 2 - reserveRight);
  let split = false;
  const seed = new Map();
  let newRank = 0;
  for (const r of g.ranks) {
    const reals = r.filter(n => n.real);
    const total = reals.reduce((s, n) => s + n.w, 0) + gx * Math.max(0, reals.length - 1);
    const k = Math.max(1, Math.ceil(total / cap));
    if (k > 1) split = true;
    const target = total / k;
    let row = 0, acc = 0;
    for (const n of reals) {
      if (acc > 0 && acc + n.w > target * 1.15 && row < k - 1) { row++; acc = 0; }
      n.rank = newRank + row; acc += n.w + gx;
      seed.set(n.id, seed.size);
    }
    newRank += reals.length ? row + 1 : 1;
  }
  if (split) {
    // ranks without real nodes cannot occur after compression, so every new rank is non-empty
    g = build(seed);
    order(g, 8);
  }
  const ranks = g.ranks;

  // ---- x placement
  const gap = (a, b) => (a.real || b.real ? gx : 8);
  const rowW = r => r.reduce((s, n, i) => s + n.w + (i ? gap(r[i - 1], n) : 0), 0);
  const innerW = Math.max(1, ...ranks.map(rowW));
  const x0 = left + pad;
  for (const r of ranks) {
    let x = x0 + (innerW - rowW(r)) / 2;
    r.forEach((n, i) => { if (i) x += gap(r[i - 1], n); n.x = x; x += n.w; });
  }
  const resolve = r => {
    for (let i = 0; i < r.length; i++) r[i].x = Math.max(r[i].x, i ? r[i - 1].x + r[i - 1].w + gap(r[i - 1], r[i]) : x0);
    for (let i = r.length - 1; i >= 0; i--) {
      const lim = i < r.length - 1 ? r[i + 1].x - gap(r[i], r[i + 1]) - r[i].w : x0 + innerW - r[i].w;
      r[i].x = Math.min(r[i].x, lim);
    }
    for (let i = 0; i < r.length; i++) r[i].x = Math.max(r[i].x, i ? r[i - 1].x + r[i - 1].w + gap(r[i - 1], r[i]) : x0);
  };
  const center = n => n.x + n.w / 2;
  const byId = new Map(g.items.map(n => [n.id, n]));
  for (let it = 0; it < 14; it++) {
    const rs = ranks.map((_, i) => i);
    if (it % 2) rs.reverse();
    for (const ri of rs) {
      const r = ranks[ri];
      for (const n of r) {
        const ns = [...g.up.get(n.id), ...g.down.get(n.id)];
        if (ns.length) n.x = ns.reduce((s, m) => s + center(byId.get(m)), 0) / ns.length - n.w / 2;
      }
      resolve(r);
    }
  }

  // ---- y placement
  const rows = [];
  let y = pad;
  ranks.forEach((r, ri) => {
    const h = Math.max(0, ...r.map(n => n.h));
    rows.push({ top: y, bottom: y + h });
    for (const n of r) { n.y = y; n.row = ri; }
    y += h + gy;
  });
  const H = y - gy + pad;
  const W = x0 + innerW + pad;

  // ---- routes
  const outs = new Map(), ins = new Map();
  const chainOf = new Map();
  for (const e of fwd) {
    const chain = g.chains.get(e);
    chainOf.set(e, chain);
    const a = N.get(e.from), b = N.get(e.to);
    const nextX = center(chain.length ? chain[0] : b), prevX = center(chain.length ? chain[chain.length - 1] : a);
    (outs.get(a.id) || outs.set(a.id, []).get(a.id)).push({ e, k: nextX });
    (ins.get(b.id) || ins.set(b.id, []).get(b.id)).push({ e, k: prevX });
  }
  const portX = new Map();
  const spread = (map, tag) => {
    for (const [id, list] of map) {
      const n = N.get(id);
      list.sort((p, q) => p.k - q.k);
      list.forEach((p, i) => portX.set(tag + (fwd.indexOf(p.e)), n.x + n.w * (i + 1) / (list.length + 1)));
    }
  };
  spread(outs, 'o'); spread(ins, 'i');

  const routes = new Map();
  for (const e of fwd) {
    const ei = fwd.indexOf(e);
    const a = N.get(e.from), b = N.get(e.to);
    const px = portX.get('o' + ei), qx = portX.get('i' + ei);
    const pts = [[px, a.y + a.h], [px, rows[a.row].bottom]];
    for (const d of chainOf.get(e)) {
      const cx = center(d);
      pts.push([cx, rows[d.row].top], [cx, rows[d.row].bottom]);
    }
    pts.push([qx, rows[b.row].top], [qx, b.y]);
    // drop repeated points
    routes.set(e, pts.filter((p, i) => !i || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]));
  }

  const pos = new Map();
  for (const n of N.values()) pos.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h, row: n.row });
  return { pos, rows, routes, back, W, H, crossings: crossings(g) };
}
