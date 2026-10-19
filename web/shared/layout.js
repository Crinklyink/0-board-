// Pure layout helpers shared by the server (AI actions) and the client ("Tidy").
import { rectsOverlap } from './schema.js';

/**
 * Find a free rectangle of size w x h as close as possible to `anchor` (center point),
 * scanning outward on a coarse grid. Used for AI-created notes so nothing lands on top of anything.
 */
export function findFreeSpot(boxes, w, h, anchor = { x: 0, y: 0 }, { gap = 28, step = 40, maxRings = 60 } = {}) {
  const cx = anchor.x - w / 2;
  const cy = anchor.y - h / 2;
  const test = (x, y) => {
    const r = { x, y, w, h };
    for (const b of boxes) if (rectsOverlap(r, b, gap)) return false;
    return true;
  };
  if (test(cx, cy)) return { x: Math.round(cx), y: Math.round(cy) };
  for (let ring = 1; ring <= maxRings; ring++) {
    const d = ring * step;
    const cands = [];
    for (let dx = -d; dx <= d; dx += step) {
      cands.push([dx, -d], [dx, d]);
    }
    for (let dy = -d + step; dy <= d - step; dy += step) {
      cands.push([-d, dy], [d, dy]);
    }
    cands.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
    for (const [dx, dy] of cands) if (test(cx + dx, cy + dy)) return { x: Math.round(cx + dx), y: Math.round(cy + dy) };
  }
  // Give up: stack below everything.
  const bottom = boxes.reduce((m, b) => Math.max(m, b.y + b.h), cy);
  return { x: Math.round(cx), y: Math.round(bottom + gap) };
}

/**
 * Masonry slot for an inbox-style board: put the item in the shortest column.
 */
export function nextFlowSlot(boxes, w, h, { x0 = 0, y0 = 0, cols = 4, colW = 240, gap = 24 } = {}) {
  const heights = new Array(cols).fill(y0);
  for (const b of boxes) {
    const first = Math.max(0, Math.floor((b.x - x0 + gap / 2) / (colW + gap)));
    const last = Math.min(cols - 1, Math.floor((b.x + b.w - x0 - gap / 2) / (colW + gap)));
    for (let c = first; c <= last; c++) heights[c] = Math.max(heights[c], b.y + b.h + gap);
  }
  let best = 0;
  for (let c = 1; c < cols; c++) if (heights[c] < heights[best]) best = c;
  return { x: x0 + best * (colW + gap), y: heights[best] };
}

/** Row-major grid. items: [{id,w,h}] -> Map(id -> {x,y}) */
export function layoutGrid(items, { x = 0, y = 0, cols = 3, gap = 28 } = {}) {
  const out = new Map();
  const n = Math.max(1, cols);
  let cy = y;
  for (let i = 0; i < items.length; i += n) {
    const row = items.slice(i, i + n);
    let cx = x;
    let rowH = 0;
    for (const it of row) {
      out.set(it.id, { x: cx, y: cy });
      cx += it.w + gap;
      rowH = Math.max(rowH, it.h);
    }
    cy += rowH + gap;
  }
  return out;
}

/** Vertical stacks side by side. */
export function layoutColumns(items, { x = 0, y = 0, cols = 3, gap = 24 } = {}) {
  const out = new Map();
  const colW = new Array(cols).fill(0);
  const colItems = Array.from({ length: cols }, () => []);
  items.forEach((it, i) => {
    colItems[i % cols].push(it);
    colW[i % cols] = Math.max(colW[i % cols], it.w);
  });
  let cx = x;
  colItems.forEach((list, c) => {
    let cy = y;
    for (const it of list) {
      out.set(it.id, { x: cx, y: cy });
      cy += it.h + gap;
    }
    cx += colW[c] + gap;
  });
  return out;
}

/**
 * Layered graph layout (Sugiyama-style, simplified).
 * nodes: [{id,w,h}], edges: [{from,to}], direction 'TB' or 'LR'. Returns Map(id -> {x,y}) top-left.
 */
export function layoutGraph(nodes, edges, { direction = 'TB', hgap = 56, vgap = 72, x = 0, y = 0 } = {}) {
  const ids = nodes.map((n) => n.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map(ids.map((id) => [id, []]));
  const valid = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
  for (const e of valid) out.get(e.from).push(e.to);

  // Drop back-edges so cycles don't break layering.
  const state = new Map();
  const dag = new Map(ids.map((id) => [id, []]));
  const visit = (id) => {
    state.set(id, 1);
    for (const t of out.get(id)) {
      const s = state.get(t);
      if (s === 1) continue; // back edge
      dag.get(id).push(t);
      if (!s) visit(t);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.get(id)) visit(id);

  const preds = new Map(ids.map((id) => [id, []]));
  for (const [a, list] of dag) for (const b of list) preds.get(b).push(a);

  const layer = new Map();
  const depth = (id) => {
    if (layer.has(id)) return layer.get(id);
    layer.set(id, 0); // guard
    let d = 0;
    for (const p of preds.get(id)) d = Math.max(d, depth(p) + 1);
    layer.set(id, d);
    return d;
  };
  for (const id of ids) depth(id);

  const maxLayer = Math.max(0, ...layer.values());
  const layers = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of ids) layers[layer.get(id)].push(id);

  // Barycenter ordering sweeps.
  const pos = new Map();
  layers.forEach((l) => l.forEach((id, i) => pos.set(id, i)));
  const bary = (id, neighbors) => {
    if (!neighbors.length) return pos.get(id);
    return neighbors.reduce((s, n) => s + pos.get(n), 0) / neighbors.length;
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let li = 1; li < layers.length; li++) {
      layers[li].sort((a, b) => bary(a, preds.get(a)) - bary(b, preds.get(b)));
      layers[li].forEach((id, i) => pos.set(id, i));
    }
    for (let li = layers.length - 2; li >= 0; li--) {
      layers[li].sort((a, b) => bary(a, dag.get(a)) - bary(b, dag.get(b)));
      layers[li].forEach((id, i) => pos.set(id, i));
    }
  }

  const main = direction === 'TB' ? 'h' : 'w'; // size along the layer axis
  const cross = direction === 'TB' ? 'w' : 'h';
  const gapMain = direction === 'TB' ? vgap : hgap;
  const gapCross = direction === 'TB' ? hgap : vgap;

  const layerExtent = layers.map((l) => l.reduce((s, id, i) => s + byId.get(id)[cross] + (i ? gapCross : 0), 0));
  const widest = Math.max(0, ...layerExtent);
  const result = new Map();
  let mainPos = direction === 'TB' ? y : x;
  layers.forEach((l, li) => {
    const thickness = Math.max(0, ...l.map((id) => byId.get(id)[main]));
    let crossPos = (direction === 'TB' ? x : y) + (widest - layerExtent[li]) / 2;
    for (const id of l) {
      const n = byId.get(id);
      const along = mainPos + (thickness - n[main]) / 2;
      result.set(id, direction === 'TB' ? { x: Math.round(crossPos), y: Math.round(along) } : { x: Math.round(along), y: Math.round(crossPos) });
      crossPos += n[cross] + gapCross;
    }
    mainPos += thickness + gapMain;
  });
  return result;
}
