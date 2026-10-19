import { applyPatch, bounds, unionBounds, endpointPoint } from '../shared/schema.js';
import { effectiveHeight } from './text.js';

const LAYER = { frame: 0, draw: 1, arrow: 2 };
const layerOf = (o) => LAYER[o.type] ?? 3;

/** Client-side copy of one board: objects, ordering, geometry helpers and hit testing. */
export class BoardModel {
  constructor() {
    this.listeners = new Set();
    this.effCache = new WeakMap();
    this.reset();
  }

  reset(board = null) {
    this.board = board;
    this.objects = new Map();
    this.rev = 0;
    this.version = 0;
    this.sorted = null;
    this.loaded = false;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #touch(ids) {
    this.version++;
    this.sorted = null;
    for (const fn of this.listeners) fn(ids);
  }

  load({ board, objects, rev }) {
    this.board = board;
    this.objects = new Map(objects.map((o) => [o.id, o]));
    this.rev = rev;
    this.loaded = true;
    this.#touch(null);
  }

  applyDelta({ upserts = [], deletes = [], rev }) {
    for (const o of upserts) this.objects.set(o.id, o);
    for (const id of deletes) this.objects.delete(id);
    if (rev !== undefined) this.rev = rev;
    this.#touch([...upserts.map((o) => o.id), ...deletes]);
  }

  /** Apply ops (from the server or optimistically from local edits). Missing targets are ignored, never thrown. */
  applyOps(ops, rev) {
    const touched = [];
    for (const op of ops) {
      if (op.op === 'put') {
        this.objects.set(op.obj.id, op.obj);
        touched.push(op.obj.id);
      } else if (op.op === 'patch') {
        const cur = this.objects.get(op.id);
        if (!cur) continue;
        this.objects.set(op.id, applyPatch(cur, op.set));
        touched.push(op.id);
      } else if (op.op === 'del') {
        if (this.objects.delete(op.id)) touched.push(op.id);
      }
    }
    if (rev !== undefined) this.rev = Math.max(this.rev, rev);
    if (touched.length) this.#touch(touched);
    return touched;
  }

  /** Compute the ops that exactly undo `ops` against the current state (without applying anything). */
  inverseOf(ops) {
    const shadow = new Map();
    const cur = (id) => (shadow.has(id) ? shadow.get(id) : this.objects.get(id) ?? null);
    const inverse = [];
    for (const op of ops) {
      if (op.op === 'put') {
        const before = cur(op.obj.id);
        inverse.push(before ? { op: 'put', obj: before } : { op: 'del', id: op.obj.id });
        shadow.set(op.obj.id, op.obj);
      } else if (op.op === 'patch') {
        const before = cur(op.id);
        if (!before) continue;
        const set = {};
        for (const k of Object.keys(op.set)) set[k] = before[k] === undefined ? null : before[k];
        inverse.push({ op: 'patch', id: op.id, set });
        shadow.set(op.id, applyPatch(before, op.set));
      } else if (op.op === 'del') {
        const before = cur(op.id);
        if (!before) continue;
        inverse.push({ op: 'put', obj: before });
        shadow.set(op.id, null);
      }
    }
    return inverse.reverse();
  }

  /** Drop ops that could not apply (stale ids) so one dead reference never nacks a whole batch. */
  sanitize(ops) {
    const exists = new Set(this.objects.keys());
    const out = [];
    for (const op of ops) {
      if (op.op === 'put') { exists.add(op.obj.id); out.push(op); }
      else if (op.op === 'patch') { if (exists.has(op.id)) out.push(op); }
      else if (op.op === 'del') { exists.delete(op.id); out.push(op); }
    }
    return out.filter((op) => {
      const o = op.op === 'put' ? op.obj : null;
      if (o?.type !== 'arrow') return true;
      return [o.from, o.to].every((e) => !e.id || exists.has(e.id));
    });
  }

  get(id) {
    return this.objects.get(id);
  }

  /** Draw order: frames, drawings, arrows, then everything else by z. */
  list() {
    if (!this.sorted) {
      this.sorted = [...this.objects.values()].sort((a, b) => layerOf(a) - layerOf(b) || (a.z || 0) - (b.z || 0));
    }
    return this.sorted;
  }

  /** Bounds as drawn (notes use their measured height). */
  box(o) {
    if (o.type === 'arrow') return this.arrowBox(o);
    let b = this.effCache.get(o);
    if (!b) {
      b = { x: o.x, y: o.y, w: o.w, h: effectiveHeight(o) };
      this.effCache.set(o, b);
    }
    return b;
  }

  arrowGeom(a) {
    const from = this.#end(a.from, a.to);
    const to = this.#end(a.to, a.from);
    if (!from || !to) return null;
    return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  }

  arrowBox(a) {
    const g = this.arrowGeom(a);
    if (!g) return { x: 0, y: 0, w: 1, h: 1 };
    return { x: Math.min(g.x1, g.x2), y: Math.min(g.y1, g.y2), w: Math.max(1, Math.abs(g.x1 - g.x2)), h: Math.max(1, Math.abs(g.y1 - g.y2)) };
  }

  #center(ep) {
    if (ep.id) {
      const t = this.objects.get(ep.id);
      if (t && t.type !== 'arrow') { const b = this.box(t); return { x: b.x + b.w / 2, y: b.y + b.h / 2, obj: t, box: b }; }
    }
    return typeof ep.x === 'number' ? { x: ep.x, y: ep.y } : null;
  }

  #end(ep, other) {
    const c = this.#center(ep);
    const o = this.#center(other);
    if (!c || !o) return null;
    if (!c.obj) return { x: c.x, y: c.y };
    const dx = o.x - c.x;
    const dy = o.y - c.y;
    if (!dx && !dy) return { x: c.x, y: c.y };
    const a = c.box.w / 2 + 6;
    const b = c.box.h / 2 + 6;
    let t;
    const shape = c.obj.type === 'shape' ? c.obj.shape : 'rect';
    if (shape === 'ellipse') t = 1 / Math.sqrt((dx / a) ** 2 + (dy / b) ** 2);
    else if (shape === 'diamond') t = 1 / (Math.abs(dx) / a + Math.abs(dy) / b);
    else t = Math.min(dx ? a / Math.abs(dx) : Infinity, dy ? b / Math.abs(dy) : Infinity);
    return { x: c.x + dx * t, y: c.y + dy * t };
  }

  arrowsFor(id) {
    const out = [];
    for (const o of this.objects.values()) if (o.type === 'arrow' && (o.from.id === id || o.to.id === id)) out.push(o);
    return out;
  }

  contentBounds(ids) {
    const list = ids ? ids.map((id) => this.objects.get(id)).filter(Boolean) : [...this.objects.values()];
    return unionBounds(list.map((o) => this.box(o)));
  }

  /** Top-most object under a world point; `tol` is in world units (use 8 / zoom). */
  hit(wx, wy, tol = 0, { skip } = {}) {
    const list = this.list();
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i];
      if (skip?.has(o.id)) continue;
      if (this.#hits(o, wx, wy, tol)) return o;
    }
    return null;
  }

  #hits(o, wx, wy, tol) {
    if (o.type === 'arrow') {
      const g = this.arrowGeom(o);
      if (!g) return false;
      return distToSegment(wx, wy, g.x1, g.y1, g.x2, g.y2) <= Math.max(tol, 6);
    }
    const b = this.box(o);
    if (o.type === 'frame') {
      // frames are only grabbed by their title bar or border, so you can still click what's inside them
      const bar = Math.max(34, tol * 2);
      const inside = wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h;
      if (!inside) return false;
      const onBorder = wx < b.x + tol || wx > b.x + b.w - tol || wy < b.y + tol || wy > b.y + b.h - tol;
      return wy <= b.y + bar || onBorder;
    }
    if (o.type === 'draw') {
      const pts = o.pts;
      const sw = (o.sw || 3) / 2 + tol;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        if (distToSegment(wx, wy, o.x + pts[i], o.y + pts[i + 1], o.x + pts[i + 2], o.y + pts[i + 3]) <= sw) return true;
      }
      return false;
    }
    return wx >= b.x - tol && wx <= b.x + b.w + tol && wy >= b.y - tol && wy <= b.y + b.h + tol;
  }

  /** Objects whose box intersects the rect. */
  inRect(r) {
    const out = [];
    for (const o of this.objects.values()) {
      const b = this.box(o);
      if (b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y) out.push(o);
    }
    return out;
  }

  /** Non-frame boxes fully inside a frame (the frame's "contents"). */
  contentsOf(frame) {
    const f = this.box(frame);
    const out = [];
    for (const o of this.objects.values()) {
      if (o.id === frame.id || o.type === 'frame' || o.type === 'arrow') continue;
      const b = this.box(o);
      if (b.x >= f.x && b.y >= f.y && b.x + b.w <= f.x + f.w && b.y + b.h <= f.y + f.h) out.push(o);
    }
    return out;
  }

  maxZ() {
    let z = 0;
    for (const o of this.objects.values()) z = Math.max(z, o.z || 0);
    return z;
  }
}

export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export { bounds, endpointPoint };

/** Undo/redo stack of {forward, inverse, label}. Session-local (never synced). */
export class History {
  constructor(max = 300) {
    this.undoStack = [];
    this.redoStack = [];
    this.max = max;
  }

  push(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.max) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}
