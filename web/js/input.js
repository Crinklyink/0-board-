import { handlePositions } from './render.js';
import { newId } from './session.js';
import { distToSegment } from './model.js';
import { NOTE_WIDTH } from '../shared/schema.js';

const DRAG_SLOP_MOUSE = 3;
const DRAG_SLOP_TOUCH = 8;
const LONG_PRESS_MS = 420;

/**
 * Pointer/keyboard/wheel handling for the canvas. Touch: one finger pans (or drags what it lands on), two fingers
 * pinch-zoom; a long press on empty space starts a selection rectangle. Mouse/pen: drag on empty space selects,
 * space/middle-drag pans, wheel zooms.
 */
export class Input {
  constructor({ canvas, session, ui }) {
    this.canvas = canvas;
    this.s = session;
    this.ui = ui;
    this.cam = session.camera;
    this.model = session.model;
    this.r = session.renderer;
    this.tool = 'select';
    this.shapeKind = 'rect';
    this.ptrs = new Map();
    this.g = null; // current gesture
    this.space = false;
    this.lastTap = { t: 0, x: 0, y: 0, id: null };
    this.inertia = 0;
    this.liveTimer = 0;
    this.enabled = true;

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => this.#down(e));
    canvas.addEventListener('pointermove', (e) => this.#move(e));
    canvas.addEventListener('pointerup', (e) => this.#up(e));
    canvas.addEventListener('pointercancel', (e) => this.#up(e, true));
    canvas.addEventListener('wheel', (e) => this.#wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('dragover', (e) => { e.preventDefault(); });
    canvas.addEventListener('drop', (e) => this.#drop(e));
    addEventListener('keydown', (e) => this.#key(e));
    addEventListener('keyup', (e) => { if (e.code === 'Space') { this.space = false; this.#cursor(); } });
    addEventListener('paste', (e) => this.#paste(e));
    addEventListener('blur', () => { this.space = false; });
  }

  setTool(t, shapeKind) {
    this.tool = t;
    if (shapeKind) this.shapeKind = shapeKind;
    this.#cancelGesture();
    this.s.renderer.draft = null;
    this.#cursor();
    this.ui.onTool?.(t, this.shapeKind);
  }

  // ---------------------------------------------------------------------------------- helpers

  #pt(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #tol(e) {
    return (e?.pointerType === 'touch' ? 14 : 5) / this.cam.z;
  }

  #cursor(hit) {
    let c = 'default';
    if (this.space || this.tool === 'hand') c = this.g?.type === 'pan' ? 'grabbing' : 'grab';
    else if (['note', 'text', 'shape', 'frame', 'arrow', 'pen'].includes(this.tool)) c = 'crosshair';
    else if (hit) c = 'move';
    this.canvas.style.cursor = c;
  }

  #cancelGesture() {
    if (this.g?.type === 'move' || this.g?.type === 'resize' || this.g?.type === 'endpoint') this.#revertTransient();
    clearTimeout(this.g?.lpTimer);
    this.g = null;
    this.r.marquee = null;
    this.r.guides = [];
    this.r.arrowTarget = null;
    this.r.draft = null;
  }

  #revertTransient() {
    const g = this.g;
    if (!g?.orig) return;
    this.model.applyOps(g.orig.map((o) => ({ op: 'patch', id: o.id, set: o.set })));
  }

  // ------------------------------------------------------------------------------------ pointers

  #down(e) {
    if (!this.enabled) return;
    this.canvas.setPointerCapture(e.pointerId);
    cancelAnimationFrame(this.inertia);
    this.cam.cancelAnim();
    const p = this.#pt(e);
    this.ptrs.set(e.pointerId, { ...p, type: e.pointerType, sx: p.x, sy: p.y, t: performance.now() });
    this.ui.onPointerDown?.(e);

    if (this.ptrs.size === 2) { this.#startPinch(); return; }
    if (this.ptrs.size > 2) return;

    const w = this.cam.toWorld(p.x, p.y);
    const touch = e.pointerType === 'touch';

    if ((e.pointerType === 'mouse' && e.button === 1) || this.space || this.tool === 'hand') { this.#startPan(p); return; }
    if (e.pointerType === 'mouse' && e.button === 2) return;

    switch (this.tool) {
      case 'select': this.#downSelect(e, p, w, touch); break;
      case 'note': case 'text': case 'shape': case 'frame':
        this.g = { type: 'create', kind: this.tool, start: w, sp: p, moved: false };
        break;
      case 'arrow': this.#startArrow(w, e); break;
      case 'pen': this.g = { type: 'pen', pts: [[w.x, w.y]] }; this.r.draft = { type: 'draw', pts: [w.x, w.y, w.x, w.y], color: 'default', sw: this.#penWidth() }; break;
      default: break;
    }
  }

  #downSelect(e, p, w, touch) {
    if (this.remote) {
      // Remote: tapping selects (on the TV too), dragging always pans the TV's view.
      const hit = this.model.hit(w.x, w.y, this.#tol(e));
      if (hit && this.#isDouble(p, hit.id)) { this.lastTap = { t: 0 }; this.ui.startEdit(hit.id, w); return; }
      this.lastTap = { t: performance.now(), x: p.x, y: p.y, id: hit?.id || null };
      this.s.setSelection(hit ? [hit.id] : []);
      this.#startPan(p, true);
      return;
    }
    const sel = [...this.s.selection].map((id) => this.model.get(id)).filter(Boolean);
    // 1. handles of the current selection
    if (sel.length === 1 && !sel[0].locked) {
      const o = sel[0];
      if (o.type === 'arrow') {
        const geom = this.model.arrowGeom(o);
        if (geom) {
          const slop = touch ? 20 : 11;
          for (const end of ['from', 'to']) {
            const sp = this.cam.toScreen(end === 'from' ? geom.x1 : geom.x2, end === 'from' ? geom.y1 : geom.y2);
            if (Math.hypot(sp.x - p.x, sp.y - p.y) <= slop) { this.g = { type: 'endpoint', id: o.id, end, orig: [{ id: o.id, set: { from: o.from, to: o.to } }], moved: false }; return; }
          }
        }
      } else {
        const slop = touch ? 20 : 11;
        const box = this.model.box(o);
        for (const h of handlePositions(box)) {
          if (o.type === 'note' && o.autoH !== false && h.id !== 'e' && h.id !== 'w') continue;
          const sp = this.cam.toScreen(h.x, h.y);
          if (Math.hypot(sp.x - p.x, sp.y - p.y) <= slop) {
            this.g = { type: 'resize', handle: h.id, id: o.id, box0: { ...box }, obj0: o, orig: [{ id: o.id, set: pick(o, ['x', 'y', 'w', 'h']) }], moved: false };
            return;
          }
        }
      }
    }
    // 2. objects
    const hit = this.model.hit(w.x, w.y, this.#tol(e));
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (hit) {
      if (hit.type === 'task' && !hit.locked && !this.remote && !additive
        && w.x >= hit.x + 6 && w.x <= hit.x + 44 && w.y >= hit.y + 6 && w.y <= hit.y + 46) {
        this.s.setSelection([hit.id]);
        this.g = { type: 'task-toggle', id: hit.id, sp: p };
        return;
      }
      const was = this.s.selection.has(hit.id);
      if (additive) {
        const next = new Set(this.s.selection);
        if (was) next.delete(hit.id); else next.add(hit.id);
        this.s.setSelection([...next]);
      } else if (!was) {
        this.s.setSelection([hit.id]);
      }
      const dbl = this.#isDouble(p, hit.id);
      if (dbl && !additive) { this.#cancelGesture(); this.ui.startEdit(hit.id, w); this.lastTap = { t: 0 }; return; }
      this.lastTap = { t: performance.now(), x: p.x, y: p.y, id: hit.id };
      if (!hit.locked && this.s.selection.has(hit.id)) this.#startMove(p, w, hit, touch);
      else this.g = { type: 'tap', sp: p };
      return;
    }
    // 3. empty space
    if (this.#isDouble(p, null) && !additive) {
      this.lastTap = { t: 0 };
      this.ui.createAndEdit('note', w);
      return;
    }
    this.lastTap = { t: performance.now(), x: p.x, y: p.y, id: null };
    if (!additive) this.s.setSelection([]);
    if (touch) {
      this.#startPan(p, true);
      this.g.lpTimer = setTimeout(() => {
        if (this.g?.type === 'pan' && !this.g.moved) {
          this.g = { type: 'marquee', start: this.cam.toWorld(p.x, p.y), additive, base: new Set(this.s.selection) };
          navigator.vibrate?.(8);
        }
      }, LONG_PRESS_MS);
    } else {
      this.g = { type: 'marquee', start: w, additive, base: new Set(this.s.selection) };
    }
  }

  #isDouble(p, id) {
    const t = this.lastTap;
    return performance.now() - t.t < 340 && Math.hypot(p.x - t.x, p.y - t.y) < 22 && (t.id ?? null) === (id ?? null);
  }

  #startPan(p, maybe = false) {
    this.g = { type: 'pan', last: p, moved: !maybe, samples: [{ t: performance.now(), x: p.x, y: p.y }], maybe };
    this.#cursor();
  }

  #startMove(p, w, hit, touch) {
    const ids = new Set(this.s.selection);
    // moving a section carries what is inside it
    for (const id of [...ids]) {
      const o = this.model.get(id);
      if (o?.type === 'frame') for (const c of this.model.contentsOf(o)) ids.add(c.id);
    }
    const items = [];
    for (const id of ids) {
      const o = this.model.get(id);
      if (!o || o.locked) continue;
      if (o.type === 'arrow') {
        const free = ['from', 'to'].filter((k) => !o[k].id);
        if (free.length === 2) items.push({ id, arrow: true, from: { ...o.from }, to: { ...o.to } });
      } else items.push({ id, x: o.x, y: o.y });
    }
    const boxes = items.filter((i) => !i.arrow).map((i) => this.model.box(this.model.get(i.id)));
    const u = boxes.length ? unionBox(boxes) : null;
    this.g = {
      type: 'move', start: w, sp: p, items, ids, union: u, moved: false, slop: touch ? DRAG_SLOP_TOUCH : DRAG_SLOP_MOUSE,
      orig: items.map((i) => ({ id: i.id, set: i.arrow ? { from: i.from, to: i.to } : { x: i.x, y: i.y } })),
    };
  }

  #startPinch() {
    const [a, b] = [...this.ptrs.values()];
    clearTimeout(this.g?.lpTimer);
    if (this.g?.type === 'move' || this.g?.type === 'resize') this.#cancelGesture();
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.g = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: this.cam.z, wp: this.cam.toWorld(mid.x, mid.y) };
  }

  #move(e) {
    const known = this.ptrs.get(e.pointerId);
    const p = this.#pt(e);
    if (!known) { this.#hover(e, p); return; }
    known.x = p.x; known.y = p.y;
    const g = this.g;
    if (!g) { this.#hover(e, p); return; }
    const w = this.cam.toWorld(p.x, p.y);

    switch (g.type) {
      case 'pinch': {
        if (this.ptrs.size < 2) break;
        const [a, b] = [...this.ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const z = Math.min(8, Math.max(0.02, g.z0 * (d / g.d0)));
        this.cam.set(g.wp.x - (mid.x - this.cam.w / 2) / z, g.wp.y - (mid.y - this.cam.h / 2) / z, z);
        break;
      }
      case 'pan': {
        const dx = p.x - g.last.x;
        const dy = p.y - g.last.y;
        if (!g.moved && Math.hypot(p.x - known.sx, p.y - known.sy) > DRAG_SLOP_TOUCH) { g.moved = true; clearTimeout(g.lpTimer); }
        if (g.moved) {
          this.cam.panBy(dx, dy);
          g.last = p;
          const t = performance.now();
          g.samples.push({ t, x: p.x, y: p.y });
          while (g.samples.length > 6 || (g.samples.length > 2 && t - g.samples[0].t > 120)) g.samples.shift();
        }
        break;
      }
      case 'move': this.#doMove(g, p, w, e); break;
      case 'resize': this.#doResize(g, w, e); break;
      case 'endpoint': this.#doEndpoint(g, w); break;
      case 'marquee': {
        const x = Math.min(g.start.x, w.x); const y = Math.min(g.start.y, w.y);
        const rect = { x, y, w: Math.abs(w.x - g.start.x), h: Math.abs(w.y - g.start.y) };
        this.r.marquee = rect;
        const hits = this.model.inRect(rect).filter((o) => o.type !== 'frame' || (o.x >= rect.x && o.y >= rect.y && o.x + o.w <= rect.x + rect.w && o.y + o.h <= rect.y + rect.h));
        const next = new Set(g.additive ? g.base : []);
        for (const o of hits) next.add(o.id);
        this.s.setSelection([...next]);
        break;
      }
      case 'create': {
        if (!g.moved && Math.hypot(p.x - g.sp.x, p.y - g.sp.y) < 5) break;
        g.moved = true;
        const x = Math.min(g.start.x, w.x); const y = Math.min(g.start.y, w.y);
        this.r.draft = { type: g.kind === 'frame' ? 'frame' : 'rect', x, y, w: Math.abs(w.x - g.start.x), h: g.kind === 'note' || g.kind === 'text' ? 60 : Math.abs(w.y - g.start.y) };
        this.r.invalidate();
        break;
      }
      case 'arrow': this.#doArrow(g, w); break;
      case 'pen': {
        const last = g.pts[g.pts.length - 1];
        if (Math.hypot(w.x - last[0], w.y - last[1]) * this.cam.z < 2) break;
        g.pts.push([w.x, w.y]);
        this.r.draft = { type: 'draw', pts: g.pts.flat(), color: 'default', sw: this.#penWidth() };
        this.r.invalidate();
        break;
      }
      default: break;
    }
  }

  #penWidth() {
    return Math.round(Math.min(24, Math.max(1.5, 2.6 / this.cam.z)) * 10) / 10;
  }

  #hover(e, p) {
    if (e.pointerType === 'touch' || this.tool !== 'select') { this.#cursor(); return; }
    const w = this.cam.toWorld(p.x, p.y);
    const hit = this.model.hit(w.x, w.y, this.#tol(e));
    const id = hit?.id || null;
    if (id !== this.r.hover) { this.r.hover = id; this.r.invalidate(); }
    this.#cursor(hit);
  }

  #doMove(g, p, w, e) {
    if (!g.moved) {
      if (Math.hypot(p.x - g.sp.x, p.y - g.sp.y) < g.slop) return;
      g.moved = true;
    }
    let dx = w.x - g.start.x;
    let dy = w.y - g.start.y;
    this.r.guides = [];
    if (g.union && !e.altKey) {
      const snap = this.#snap(g, dx, dy);
      dx += snap.dx; dy += snap.dy;
      this.r.guides = snap.guides;
    }
    const ops = g.items.map((i) => (i.arrow
      ? { op: 'patch', id: i.id, set: { from: { x: i.from.x + dx, y: i.from.y + dy }, to: { x: i.to.x + dx, y: i.to.y + dy } } }
      : { op: 'patch', id: i.id, set: { x: round(i.x + dx), y: round(i.y + dy) } }));
    this.model.applyOps(ops);
    this.#live(ops);
  }

  #snap(g, dx, dy) {
    const z = this.cam.z;
    const th = 6 / z;
    const u = g.union;
    const mv = { x: u.x + dx, y: u.y + dy, w: u.w, h: u.h };
    const view = this.cam.view();
    const others = this.model.inRect({ x: view.x - 200, y: view.y - 200, w: view.w + 400, h: view.h + 400 })
      .filter((o) => !g.ids.has(o.id) && o.type !== 'arrow' && o.type !== 'frame' && o.type !== 'draw')
      .map((o) => this.model.box(o));
    const xs = [mv.x, mv.x + mv.w / 2, mv.x + mv.w];
    const ys = [mv.y, mv.y + mv.h / 2, mv.y + mv.h];
    let bx = null; let by = null;
    for (const b of others) {
      for (const tx of [b.x, b.x + b.w / 2, b.x + b.w]) for (const mx of xs) { const d = tx - mx; if (Math.abs(d) < th && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, at: tx, b }; }
      for (const ty of [b.y, b.y + b.h / 2, b.y + b.h]) for (const my of ys) { const d = ty - my; if (Math.abs(d) < th && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, at: ty, b }; }
    }
    const guides = [];
    const sx = bx ? bx.d : 0;
    const sy = by ? by.d : 0;
    if (bx) guides.push({ x1: bx.at, y1: Math.min(mv.y + sy, bx.b.y) - 12, x2: bx.at, y2: Math.max(mv.y + sy + mv.h, bx.b.y + bx.b.h) + 12 });
    if (by) guides.push({ x1: Math.min(mv.x + sx, by.b.x) - 12, y1: by.at, x2: Math.max(mv.x + sx + mv.w, by.b.x + by.b.w) + 12, y2: by.at });
    return { dx: sx, dy: sy, guides };
  }

  #doResize(g, w, e) {
    g.moved = true;
    const b = g.box0;
    let x1 = b.x; let y1 = b.y; let x2 = b.x + b.w; let y2 = b.y + b.h;
    const h = g.handle;
    if (h.includes('w')) x1 = w.x; if (h.includes('e')) x2 = w.x;
    if (h.includes('n')) y1 = w.y; if (h.includes('s')) y2 = w.y;
    const o = g.obj0;
    const keep = o.type === 'image' || o.type === 'draw' || e.shiftKey;
    const minS = 24;
    if (keep && h.length === 2) {
      const ratio = b.w / b.h;
      let nw = Math.abs(x2 - x1);
      let nh = Math.abs(y2 - y1);
      if (nw / nh > ratio) nw = nh * ratio; else nh = nw / ratio;
      if (h.includes('w')) x1 = x2 - nw; else x2 = x1 + nw;
      if (h.includes('n')) y1 = y2 - nh; else y2 = y1 + nh;
    }
    if (x2 - x1 < minS) { if (h.includes('w')) x1 = x2 - minS; else x2 = x1 + minS; }
    if (y2 - y1 < minS) { if (h.includes('n')) y1 = y2 - minS; else y2 = y1 + minS; }
    const set = { x: round(x1), y: round(y1), w: round(x2 - x1) };
    if (!(o.type === 'note' && o.autoH !== false) && o.type !== 'text') set.h = round(y2 - y1);
    const ops = [{ op: 'patch', id: g.id, set }];
    this.model.applyOps(ops);
    this.#live(ops);
  }

  #doEndpoint(g, w) {
    g.moved = true;
    const o = this.model.get(g.id);
    const other = g.end === 'from' ? 'to' : 'from';
    const target = this.model.hit(w.x, w.y, 6 / this.cam.z, { skip: new Set([g.id]) });
    const t = target && target.type !== 'arrow' && target.type !== 'frame' && !(o[other].id && o[other].id === target.id) ? target : null;
    this.r.arrowTarget = t?.id || null;
    const ep = t ? { id: t.id } : { x: round(w.x), y: round(w.y) };
    this.model.applyOps([{ op: 'patch', id: g.id, set: { [g.end]: ep } }]);
  }

  #startArrow(w, e) {
    const hit = this.model.hit(w.x, w.y, this.#tol(e));
    const start = hit && hit.type !== 'arrow' ? { id: hit.id } : { x: round(w.x), y: round(w.y) };
    this.g = { type: 'arrow', start, startId: hit?.id || null, end: { x: w.x, y: w.y }, endId: null, moved: false };
    this.r.draft = { type: 'arrow', from: start, to: { x: w.x, y: w.y } };
  }

  #doArrow(g, w) {
    g.moved = true;
    const target = this.model.hit(w.x, w.y, 6 / this.cam.z);
    const t = target && target.type !== 'arrow' && target.type !== 'frame' && target.id !== g.startId ? target : null;
    g.endId = t?.id || null;
    this.r.arrowTarget = g.endId;
    g.end = t ? { id: t.id } : { x: round(w.x), y: round(w.y) };
    this.r.draft = { type: 'arrow', from: g.start, to: g.end };
    this.r.invalidate();
  }

  #live(ops) {
    if (this.liveTimer) { this.pendingLive = ops; return; }
    this.s.net.live(this.s.boardId, ops.map((o) => ({ id: o.id, set: o.set })));
    this.liveTimer = setTimeout(() => {
      this.liveTimer = 0;
      if (this.pendingLive) { const p = this.pendingLive; this.pendingLive = null; this.#live(p); }
    }, 55);
  }

  #up(e, cancelled = false) {
    const known = this.ptrs.get(e.pointerId);
    this.ptrs.delete(e.pointerId);
    this.ui.onPointerUp?.(e);
    const g = this.g;
    if (!g) return;
    const p = this.#pt(e);
    const w = this.cam.toWorld(p.x, p.y);

    if (g.type === 'pinch') {
      if (this.ptrs.size < 2) {
        // keep going as a pan with the remaining finger so there is no jump
        const rest = [...this.ptrs.values()][0];
        this.g = rest ? { type: 'pan', last: { x: rest.x, y: rest.y }, moved: true, samples: [] } : null;
        if (rest) { rest.sx = rest.x; rest.sy = rest.y; }
      }
      this.s.queueCamSave();
      this.ui.onCameraSettled?.();
      return;
    }
    this.g = null;
    clearTimeout(g.lpTimer);

    switch (g.type) {
      case 'pan': {
        if (!g.moved && !cancelled && g.maybe) { this.ui.onEmptyTap?.(w); }
        else if (g.moved && !cancelled) this.#fling(g);
        this.s.queueCamSave();
        this.ui.onCameraSettled?.();
        this.#cursor();
        break;
      }
      case 'move': {
        this.r.guides = [];
        if (!g.moved || cancelled) { if (cancelled) this.#revertAfter(g); break; }
        const finalOps = g.items.map((i) => {
          const o = this.model.get(i.id);
          return i.arrow ? { op: 'patch', id: i.id, set: { from: o.from, to: o.to } } : { op: 'patch', id: i.id, set: { x: o.x, y: o.y } };
        });
        this.#revertAfter(g);
        this.s.commit(finalOps, { label: 'Move' });
        break;
      }
      case 'resize': {
        if (!g.moved) break;
        const o = this.model.get(g.id);
        const set = pick(o, ['x', 'y', 'w', 'h']);
        this.#revertAfter(g);
        this.s.commit([{ op: 'patch', id: g.id, set: { ...set, ...(g.obj0.type === 'note' ? { autoH: g.obj0.autoH !== false ? true : false } : {}) } }], { label: 'Resize' });
        break;
      }
      case 'endpoint': {
        this.r.arrowTarget = null;
        if (!g.moved) break;
        const o = this.model.get(g.id);
        const set = { from: o.from, to: o.to };
        this.#revertAfter(g);
        this.s.commit([{ op: 'patch', id: g.id, set }], { label: 'Reconnect arrow' });
        break;
      }
      case 'marquee': this.r.marquee = null; this.r.invalidate(); break;
      case 'create': this.#finishCreate(g, w); break;
      case 'arrow': this.#finishArrow(g); break;
      case 'pen': this.#finishPen(g); break;
      case 'task-toggle': {
        if (!cancelled && Math.hypot(p.x - g.sp.x, p.y - g.sp.y) < 12) {
          const task = this.model.get(g.id);
          if (task && !task.locked) this.s.commit([{ op: 'patch', id: task.id, set: { status: task.status === 'done' ? 'todo' : 'done' } }], { label: 'Task status' });
        }
        break;
      }
      case 'tap': break;
      default: break;
    }
    void known;
  }

  #revertAfter(g) {
    this.model.applyOps(g.orig.map((o) => ({ op: 'patch', id: o.id, set: o.set })));
  }

  #fling(g) {
    const s = g.samples;
    if (s.length < 2) return;
    const a = s[0]; const b = s[s.length - 1];
    const dt = b.t - a.t;
    if (dt <= 0 || performance.now() - b.t > 60) return;
    let vx = (b.x - a.x) / dt;
    let vy = (b.y - a.y) / dt;
    if (Math.hypot(vx, vy) < 0.25) return;
    let last = performance.now();
    const step = (now) => {
      const dtf = Math.min(32, now - last);
      last = now;
      this.cam.panBy(vx * dtf, vy * dtf);
      const decay = 0.94 ** (dtf / 16);
      vx *= decay; vy *= decay;
      if (Math.hypot(vx, vy) > 0.03) this.inertia = requestAnimationFrame(step);
      else { this.s.queueCamSave(); this.ui.onCameraSettled?.(); }
    };
    this.inertia = requestAnimationFrame(step);
  }

  #finishCreate(g, w) {
    this.r.draft = null;
    const dragged = g.moved;
    const x = Math.min(g.start.x, w.x); const y = Math.min(g.start.y, w.y);
    const dw = Math.abs(w.x - g.start.x); const dh = Math.abs(w.y - g.start.y);
    const kind = g.kind;
    this.setTool('select');
    if (kind === 'note') {
      const wd = dragged ? Math.max(120, dw) : NOTE_WIDTH;
      this.ui.createAndEdit('note', { x: dragged ? x + wd / 2 : g.start.x, y: g.start.y }, { w: wd });
    } else if (kind === 'text') {
      const wd = dragged ? Math.max(80, dw) : 320;
      this.ui.createAndEdit('text', { x: dragged ? x + wd / 2 : g.start.x, y: g.start.y }, { w: wd });
    } else if (kind === 'shape') {
      const wd = dragged ? Math.max(40, dw) : 180; const ht = dragged ? Math.max(40, dh) : 100;
      const obj = { id: newId('s'), type: 'shape', shape: this.shapeKind, text: '', x: round(dragged ? x : g.start.x - wd / 2), y: round(dragged ? y : g.start.y - ht / 2), w: round(wd), h: round(ht), color: 'blue', fill: 'tint', size: 'm' };
      this.ui.createAndEdit('shape', null, obj);
    } else if (kind === 'frame') {
      const wd = dragged ? Math.max(120, dw) : 640; const ht = dragged ? Math.max(90, dh) : 420;
      const obj = { id: newId('f'), type: 'frame', title: '', x: round(dragged ? x : g.start.x - wd / 2), y: round(dragged ? y : g.start.y - ht / 2), w: round(wd), h: round(ht), color: 'gray' };
      this.ui.createAndEdit('frame', null, obj);
    }
  }

  #finishArrow(g) {
    this.r.draft = null;
    this.r.arrowTarget = null;
    const at = (ep) => {
      const o = ep.id && this.model.get(ep.id);
      if (!o) return { x: ep.x ?? 0, y: ep.y ?? 0 };
      const b = this.model.box(o);
      return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    };
    const a = at(g.start);
    const b = at(g.end);
    const len = Math.hypot(a.x - b.x, a.y - b.y) * this.cam.z;
    if (!g.moved || len < 18 || (g.start.id && g.start.id === g.end.id)) { this.setTool('select'); return; }
    const obj = { id: newId('a'), type: 'arrow', from: g.start, to: g.end, color: 'default', head: 'arrow' };
    this.s.create(obj, 'Add arrow');
    this.s.setSelection([obj.id]);
    this.setTool('select');
  }

  #finishPen(g) {
    this.r.draft = null;
    if (g.pts.length < 2) return;
    const xs = g.pts.map((p) => p[0]); const ys = g.pts.map((p) => p[1]);
    const x = Math.min(...xs); const y = Math.min(...ys);
    const w = Math.max(8, Math.max(...xs) - x); const h = Math.max(8, Math.max(...ys) - y);
    const simplified = simplify(g.pts.map((p) => [p[0] - x, p[1] - y]), 0.6 / this.cam.z);
    const flat = simplified.flat().map((n) => Math.round(n * 10) / 10);
    if (flat.length < 4) return;
    this.s.create({ id: newId('d'), type: 'draw', x: round(x), y: round(y), w: round(w), h: round(h), pts: flat, color: 'default', sw: this.#penWidth() }, 'Draw');
  }

  // --------------------------------------------------------------------------------- wheel / keys

  #wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    cancelAnimationFrame(this.inertia);
    this.cam.cancelAnim();
    const p = this.#pt(e);
    const lineMul = e.deltaMode === 1 ? 16 : 1;
    const dx = e.deltaX * lineMul;
    const dy = e.deltaY * lineMul;
    if (e.ctrlKey || e.metaKey) {
      this.cam.zoomAt(Math.exp(-dy * 0.012), p.x, p.y);
    } else if (dx !== 0 || e.shiftKey || (e.deltaMode === 0 && Math.abs(dy) < 40 && !Number.isInteger(e.deltaY))) {
      this.cam.panBy(-(e.shiftKey && !dx ? dy : dx), e.shiftKey && !dx ? 0 : -dy);
    } else {
      this.cam.zoomAt(Math.exp(-dy * 0.0016), p.x, p.y);
    }
    this.s.queueCamSave();
    this.ui.onCameraSettled?.();
  }

  #typing(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  #key(e) {
    if (!this.enabled || this.#typing(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    const sel = [...this.s.selection];
    if (e.code === 'Space' && !e.repeat) { this.space = true; this.#cursor(); e.preventDefault(); return; }
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) this.s.redo(); else this.s.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.s.redo(); return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); this.s.setSelection([...this.model.objects.keys()]); return; }
    if (mod && e.key.toLowerCase() === 'c') { this.s.copy(sel); return; }
    if (mod && e.key.toLowerCase() === 'x') { this.s.copy(sel); this.s.deleteObjects(sel); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); this.s.duplicate(sel); return; }
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); this.ui.openSearch?.(); return; }
    if (mod && e.key === 'Enter') { this.ui.openAsk?.(); return; }
    if (mod) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { if (sel.length) { e.preventDefault(); this.s.deleteObjects(sel.filter((id) => !this.model.get(id)?.locked)); } return; }
    if (e.key === 'Escape') { this.#cancelGesture(); this.setTool('select'); this.s.setSelection([]); this.ui.onEscape?.(); return; }
    if (e.key === 'Enter' && sel.length === 1) { e.preventDefault(); this.ui.startEdit(sel[0]); return; }
    if (e.key.startsWith('Arrow') && sel.length) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) * 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const ops = sel.map((id) => this.model.get(id)).filter((o) => o && o.type !== 'arrow' && !o.locked).map((o) => ({ op: 'patch', id: o.id, set: { x: o.x + dx, y: o.y + dy } }));
      this.s.commit(ops, { label: 'Nudge' });
      return;
    }
    const k = e.key.toLowerCase();
    const map = { v: 'select', h: 'hand', n: 'note', t: 'text', r: 'shape', a: 'arrow', p: 'pen', f: 'frame' };
    if (map[k] && !e.altKey) { this.setTool(map[k]); return; }
    if (e.key === '/' ) { e.preventDefault(); this.ui.openAsk?.(); return; }
    if (e.key === '+' || e.key === '=') { this.cam.animateTo({ x: this.cam.x, y: this.cam.y, z: this.cam.z * 1.4 }, 180); return; }
    if (e.key === '-') { this.cam.animateTo({ x: this.cam.x, y: this.cam.y, z: this.cam.z / 1.4 }, 180); return; }
    if (e.key === '0') { this.cam.animateTo({ x: this.cam.x, y: this.cam.y, z: 1 }, 220); return; }
    if (e.key === '1' && e.shiftKey || e.key === '!') { this.s.fitContent(true); return; }
    if (e.key === '2' && e.shiftKey || e.key === '@') { if (sel.length) this.s.fitContent(true, sel); }
  }

  async #paste(e) {
    if (!this.enabled || this.#typing(e)) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      for (const f of files) await this.s.uploadAndPlace(f).catch((err) => this.ui.toast?.(err.message, 'error'));
      return;
    }
    const text = e.clipboardData?.getData('text/plain');
    if (this.s.clip && (!text || text.startsWith('oboard:'))) { e.preventDefault(); this.s.paste(null); return; }
    if (text?.trim()) {
      e.preventDefault();
      this.ui.captureText?.(text.trim());
    }
  }

  async #drop(e) {
    e.preventDefault();
    const p = this.#pt(e);
    const w = this.cam.toWorld(p.x, p.y);
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) {
      let i = 0;
      for (const f of files) await this.s.uploadAndPlace(f, { x: w.x + i++ * 40, y: w.y + i * 40 }).catch((err) => this.ui.toast?.(err.message, 'error'));
      return;
    }
    const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
    if (text?.trim()) this.ui.captureText?.(text.trim(), w);
  }
}

const round = (n) => Math.round(n * 10) / 10;
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

function unionBox(boxes) {
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const b of boxes) { x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h); }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Douglas–Peucker polyline simplification. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0; let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
