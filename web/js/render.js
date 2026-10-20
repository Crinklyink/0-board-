import { THEME, colorOf, TAG_LABEL } from './theme.js';
import { fontString, wrapLines, noteMetrics, tagShown, shapeFont, textObjFont, ellipsize, measure } from './text.js';
import { NOTE_PAD, TEXT_FONT } from '../shared/schema.js';

const HANDLE = 9; // css px

export function handlePositions(b) {
  const xs = [b.x, b.x + b.w / 2, b.x + b.w];
  const ys = [b.y, b.y + b.h / 2, b.y + b.h];
  return [
    { id: 'nw', x: xs[0], y: ys[0] }, { id: 'n', x: xs[1], y: ys[0] }, { id: 'ne', x: xs[2], y: ys[0] },
    { id: 'e', x: xs[2], y: ys[1] }, { id: 'se', x: xs[2], y: ys[2] }, { id: 's', x: xs[1], y: ys[2] },
    { id: 'sw', x: xs[0], y: ys[2] }, { id: 'w', x: xs[0], y: ys[1] },
  ];
}

class ImageCache {
  constructor(api, onLoad) {
    this.api = api;
    this.onLoad = onLoad;
    this.map = new Map(); // assetId -> ImageBitmap | 'loading' | 'error'
  }

  get(assetId) {
    const v = this.map.get(assetId);
    if (v) return v;
    this.map.set(assetId, 'loading');
    this.#load(assetId);
    return 'loading';
  }

  async #load(assetId, attempt = 0) {
    try {
      const res = await fetch(`${this.api.base}/assets/${assetId}`, { headers: { authorization: `Bearer ${this.api.token}` } });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      this.map.set(assetId, bmp);
    } catch {
      if (attempt < 2) { setTimeout(() => this.#load(assetId, attempt + 1), 1500 * (attempt + 1)); return; }
      this.map.set(assetId, 'error');
    }
    this.onLoad();
  }
}

export class Renderer {
  constructor(canvas, { model, camera, api, dprCap = 2 }) {
    this.canvas = canvas;
    // Note: no `desynchronized` here; Android WebView does not composite low-latency canvases reliably.
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.model = model;
    this.cam = camera;
    this.dprCap = dprCap;
    this.dpr = 1;
    this.selection = new Set();
    this.hover = null;
    this.guides = [];
    this.marquee = null;
    this.draft = null; // object being drawn/created (not yet in the model)
    this.editingId = null;
    this.focusIds = null; // Set => dim everything else
    this.highlightIds = new Set(); // display.selection from remote
    this.arrowTarget = null;
    this.remoteRect = null;
    this.flashes = new Map(); // id -> start time
    this.dirty = true;
    this.raf = 0;
    this.images = new ImageCache(api, () => this.invalidate());
    this.gridTile = this.#makeTile();
    this.onFrame = null;
    model.onChange(() => this.invalidate());
    camera.onChange = () => { this.invalidate(); this.onCameraChange?.(camera); };
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  #makeTile() {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    g.fillStyle = '#16273D';
    g.beginPath();
    g.arc(16, 16, 1.15, 0, Math.PI * 2);
    g.fill();
    return c;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    this.dpr = Math.min(this.dprCap, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.cam.resize(w, h);
    this.onResize?.();
    this.invalidate();
  }

  invalidate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame((t) => { this.raf = 0; this.draw(t); });
  }

  flash(ids) {
    const t = performance.now();
    for (const id of ids) this.flashes.set(id, t);
    this.invalidate();
  }

  // ---------------------------------------------------------------------------------------------

  draw(now = performance.now()) {
    const { ctx, cam, dpr, model } = this;
    const z = cam.z;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, W, H);
    this.#grid(W, H);

    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (cam.w / 2 - cam.x * z), dpr * (cam.h / 2 - cam.y * z));
    const v = cam.view();
    const pad = 40 / z;
    const vx1 = v.x - pad; const vy1 = v.y - pad; const vx2 = v.x + v.w + pad; const vy2 = v.y + v.h + pad;

    const list = model.list();
    const labels = [];
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const b = model.box(o);
      if (b.x > vx2 || b.y > vy2 || b.x + b.w < vx1 || b.y + b.h < vy1) continue;
      if (b.w * z < 1.5 && b.h * z < 1.5 && o.type !== 'arrow') continue;
      const dim = this.focusIds && !this.focusIds.has(o.id) && o.type !== 'frame';
      ctx.globalAlpha = dim ? 0.2 : 1;
      if (o.type === 'arrow' && o.label) labels.push([o, dim]);
      switch (o.type) {
        case 'task': this.#task(o, b, z); break;
        case 'note': this.#note(o, b, z); break;
        case 'text': this.#text(o, b, z); break;
        case 'shape': this.#shape(o, b, z); break;
        case 'frame': this.#frame(o, b, z); break;
        case 'arrow': this.#arrow(o, z); break;
        case 'draw': this.#draw(o, z); break;
        case 'image': this.#image(o, b, z); break;
        case 'file': this.#card(o, b, z, o.name || 'File', o.mime || '', 'file'); break;
        case 'link': this.#card(o, b, z, o.title || o.url, hostOf(o.url), 'link'); break;
        case 'widget': this.#widget(o, b, z); break;
        default: break;
      }
    }
    // Arrow labels go on top of everything so short connections between boxes stay readable.
    for (const [o, dim] of labels) { ctx.globalAlpha = dim ? 0.2 : 1; this.#arrowLabel(o, z); }
    ctx.globalAlpha = 1;
    if (this.draft) this.#drawDraft(z);
    this.#overlay(z, now);
    this.onFrame?.();
  }

  #grid(W, H) {
    const { ctx, cam, dpr } = this;
    let step = 32;
    while (step * cam.z < 16) step *= 2;
    const px = step * cam.z * dpr;
    const ox = (((cam.w / 2 - cam.x * cam.z) % (step * cam.z)) + step * cam.z) % (step * cam.z) * dpr;
    const oy = (((cam.h / 2 - cam.y * cam.z) % (step * cam.z)) + step * cam.z) % (step * cam.z) * dpr;
    const pat = ctx.createPattern(this.gridTile, 'repeat');
    if (!pat?.setTransform) return;
    const s = px / 32;
    pat.setTransform(new DOMMatrix([s, 0, 0, s, ox - px / 2, oy - px / 2]));
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, W, H);
  }

  #rr(x, y, w, h, r) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  }

  #task(o, b, z) {
    const { ctx } = this;
    const c = colorOf(o.color);
    this.#rr(b.x, b.y, b.w, b.h, 9);
    ctx.fillStyle = c.fill; ctx.fill();
    ctx.strokeStyle = o.status === 'done' ? '#3F7F5C' : c.stroke;
    ctx.lineWidth = Math.max(1, 1 / z); ctx.stroke();
    this.#rr(b.x + 14, b.y + 16, 22, 22, 5);
    ctx.fillStyle = o.status === 'done' ? '#3F7F5C' : THEME.bg2; ctx.fill();
    ctx.strokeStyle = o.status === 'doing' ? '#D9BE62' : c.ink; ctx.stroke();
    if (o.status === 'done') {
      ctx.beginPath(); ctx.moveTo(b.x + 19, b.y + 27); ctx.lineTo(b.x + 24, b.y + 32); ctx.lineTo(b.x + 32, b.y + 22);
      ctx.strokeStyle = THEME.text; ctx.lineWidth = 2; ctx.stroke();
    }
    if (z * 15 < 3) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(b.x + 8, b.y + 8, b.w - 16, b.h - 16); ctx.clip();
    const lines = wrapLines(o.text || 'Untitled task', fontString(16, 600), Math.max(20, b.w - 66));
    this.#lines(lines.slice(0, 2), fontString(16, 600), 16, 22, b.x + 48, b.y + 16, o.status === 'done' ? THEME.text2 : THEME.text, z, b.w - 66);
    if (o.detail && b.h > 140) {
      ctx.font = fontString(12); ctx.fillStyle = THEME.text2; ctx.textBaseline = 'top';
      ctx.fillText(ellipsize(o.detail.replace(/\s+/g, ' '), ctx.font, Math.max(12, b.w - 28)), b.x + 14, b.y + 76);
    }
    ctx.font = fontString(11, 600); ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = o.status === 'done' ? '#74C69A' : o.status === 'doing' ? '#D9BE62' : THEME.text2;
    const label = o.status === 'done' ? 'DONE' : o.status === 'doing' ? 'IN PROGRESS' : 'TO DO';
    const priority = o.priority === 'high' ? ' · HIGH' : o.priority === 'low' ? ' · LOW' : '';
    ctx.fillText(label + priority, b.x + 14, b.y + b.h - 18);
    if (o.due) {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const late = o.due < today && o.status !== 'done';
      ctx.fillStyle = late ? '#E58583' : THEME.text2;
      ctx.textAlign = 'right'; ctx.fillText(`${late ? 'Overdue ' : 'Due '}${o.due}`, b.x + b.w - 14, b.y + b.h - 18);
    }
    ctx.restore();
  }

  #note(o, b, z) {
    const { ctx } = this;
    const c = colorOf(o.color);
    const lw = Math.max(1 / z, 1);
    this.#rr(b.x, b.y, b.w, b.h, 7);
    ctx.fillStyle = c.fill;
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = c.stroke;
    if (o.tag === 'suggestion') ctx.setLineDash([6 / z, 4 / z]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (o.origin === 'ai') {
      ctx.fillStyle = THEME.accent;
      ctx.beginPath();
      ctx.arc(b.x + b.w - 11, b.y + 11, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.editingId === o.id) return;
    const showTag = tagShown(o);
    const m = noteMetrics(o, showTag);
    const screenPx = m.px * z;
    if (screenPx < 3) return;
    if (showTag && screenPx >= 4.5) {
      ctx.font = fontString(Math.max(9, m.px * 0.62), 650);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0.7px';
      ctx.fillStyle = c.ink;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(TAG_LABEL[o.tag] || '', b.x + NOTE_PAD, b.y + NOTE_PAD + 8);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }
    this.#lines(m.lines, m.font, m.px, m.lh, b.x + NOTE_PAD, b.y + NOTE_PAD + m.tagH, c.text, z, b.w - NOTE_PAD * 2);
  }

  /** Draw wrapped lines, or "greeked" bars when text would be too small to read. */
  #lines(lines, font, px, lh, x, y, color, z, maxW) {
    const { ctx } = this;
    // Swap text for placeholder bars only when it would be under ~9 physical pixels tall (phones have dense screens).
    if (px * z * this.dpr < 9) {
      ctx.fillStyle = color;
      ctx.globalAlpha *= 0.28;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        const w = Math.min(maxW, measure(lines[i], font));
        this.#rr(x, y + i * lh + px * 0.25, w, px * 0.5, px * 0.25);
        ctx.fill();
      }
      ctx.globalAlpha /= 0.28;
      return;
    }
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < lines.length; i++) if (lines[i]) ctx.fillText(lines[i], x, y + i * lh + px * 1.02);
  }

  #text(o, b, z) {
    if (this.editingId === o.id) return;
    const c = colorOf(o.color);
    const px = TEXT_FONT[o.size] || 24;
    const font = textObjFont(o);
    const lines = wrapLines(o.text || '', font, o.w);
    if (px * z < 3) return;
    const { ctx } = this;
    ctx.textAlign = o.align === 'center' ? 'center' : o.align === 'right' ? 'right' : 'left';
    const x = o.align === 'center' ? b.x + b.w / 2 : o.align === 'right' ? b.x + b.w : b.x;
    this.#lines(lines, font, px, px * 1.4, x, b.y, c.text, z, o.w);
    ctx.textAlign = 'left';
  }

  #shape(o, b, z) {
    const { ctx } = this;
    const c = colorOf(o.color);
    const x = b.x; const y = b.y; const w = b.w; const h = b.h;
    ctx.beginPath();
    if (o.shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    else if (o.shape === 'diamond') { ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h / 2); ctx.lineTo(x + w / 2, y + h); ctx.lineTo(x, y + h / 2); ctx.closePath(); }
    else if (o.shape === 'pill') ctx.roundRect(x, y, w, h, h / 2);
    else ctx.roundRect(x, y, w, h, 9);
    if (o.fill !== 'none') {
      ctx.fillStyle = o.fill === 'solid' ? c.stroke : c.fill;
      ctx.fill();
    }
    ctx.lineWidth = Math.max(1.4 / z, 1.4);
    ctx.strokeStyle = c.stroke;
    ctx.stroke();
    if (o.origin === 'ai') {
      ctx.fillStyle = THEME.accent;
      ctx.beginPath();
      ctx.arc(x + w - 9, y + 9, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.editingId === o.id || !o.text) return;
    const font = shapeFont(o);
    const px = parseFloat(font.split(' ')[1]);
    if (px * z < 3) return;
    const inset = o.shape === 'diamond' ? 0.28 : o.shape === 'ellipse' ? 0.16 : 0.07;
    const maxW = Math.max(20, w * (1 - inset * 2) - 10);
    const lines = wrapLines(o.text, font, maxW);
    const lh = px * 1.35;
    const top = y + h / 2 - (lines.length * lh) / 2;
    ctx.textAlign = 'center';
    const color = o.fill === 'solid' ? '#05070C' : c.text;
    if (px * z * this.dpr < 9) { this.#lines(lines, font, px, lh, x + w / 2 - maxW / 2, top, color, z, maxW); } else {
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.textBaseline = 'alphabetic';
      for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], x + w / 2, top + i * lh + px * 1.02);
    }
    ctx.textAlign = 'left';
  }

  #frame(o, b, z) {
    const { ctx } = this;
    const c = colorOf(o.color || 'gray');
    this.#rr(b.x, b.y, b.w, b.h, 12);
    ctx.fillStyle = 'rgba(120,160,210,0.028)';
    ctx.fill();
    ctx.lineWidth = Math.max(1.2 / z, 1.2);
    ctx.strokeStyle = c.stroke;
    ctx.globalAlpha *= 0.75;
    ctx.stroke();
    ctx.globalAlpha /= 0.75;
    if (!o.title || this.editingId === o.id) return;
    // Cap the world-space header size so zooming out does not grow it over the first card.
    const px = Math.min(Math.max(13, 12.5 / z), b.h / 5, 28);
    ctx.font = fontString(px, 600);
    ctx.fillStyle = c.ink;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(ellipsize(o.title, ctx.font, b.w - px * 1.6), b.x + px * 0.9, b.y + px * 1.65);
  }

  #arrow(o, z) {
    const { ctx, model } = this;
    const g = model.arrowGeom(o);
    if (!g) return;
    const c = colorOf(o.color);
    const sw = Math.max(1.5, 1.3 / z);
    const dx = g.x2 - g.x1;
    const dy = g.y2 - g.y1;
    const len = Math.hypot(dx, dy);
    if (len < 2) return;
    const ux = dx / len; const uy = dy / len;
    const head = o.head !== 'none' ? Math.min(len * 0.5, 9 + sw * 2.4) : 0;
    ctx.strokeStyle = c.stroke === colorOf('default').stroke ? '#4A6E96' : c.stroke;
    ctx.lineWidth = sw;
    ctx.lineCap = 'round';
    if (o.dash) ctx.setLineDash([sw * 4, sw * 3]);
    ctx.beginPath();
    ctx.moveTo(g.x1, g.y1);
    ctx.lineTo(g.x2 - ux * head * 0.6, g.y2 - uy * head * 0.6);
    ctx.stroke();
    ctx.setLineDash([]);
    if (head) {
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(g.x2, g.y2);
      ctx.lineTo(g.x2 - ux * head - uy * head * 0.42, g.y2 - uy * head + ux * head * 0.42);
      ctx.lineTo(g.x2 - ux * head + uy * head * 0.42, g.y2 - uy * head - ux * head * 0.42);
      ctx.closePath();
      ctx.fill();
    }
    ctx.lineCap = 'butt';
  }

  #arrowLabel(o, z) {
    const g = this.model.arrowGeom(o);
    if (!g || 12 * z * this.dpr < 7) return;
    const { ctx } = this;
    const px = 12; // world units, so labels shrink and grow with the diagram they belong to
    ctx.font = fontString(px, 500);
    const tw = measure(o.label, ctx.font);
    const mx = (g.x1 + g.x2) / 2;
    const my = (g.y1 + g.y2) / 2;
    this.#rr(mx - tw / 2 - 7, my - px * 0.85, tw + 14, px * 1.55, px * 0.55);
    ctx.fillStyle = THEME.bg2;
    ctx.fill();
    ctx.lineWidth = 1 / z;
    ctx.strokeStyle = THEME.border;
    ctx.stroke();
    ctx.fillStyle = THEME.text2;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(o.label, mx - tw / 2, my + px * 0.32);
  }

  #draw(o, z) {
    const { ctx } = this;
    const pts = o.pts;
    if (!pts || pts.length < 4) return;
    const c = colorOf(o.color);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = o.sw || 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(o.x + pts[0], o.y + pts[1]);
    for (let i = 2; i + 3 < pts.length; i += 2) {
      const mx = (pts[i] + pts[i + 2]) / 2;
      const my = (pts[i + 1] + pts[i + 3]) / 2;
      ctx.quadraticCurveTo(o.x + pts[i], o.y + pts[i + 1], o.x + mx, o.y + my);
    }
    ctx.lineTo(o.x + pts[pts.length - 2], o.y + pts[pts.length - 1]);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  #image(o, b, z) {
    const { ctx } = this;
    const img = this.images.get(o.asset);
    this.#rr(b.x, b.y, b.w, b.h, 6);
    if (img && img !== 'loading' && img !== 'error') {
      ctx.save();
      ctx.clip();
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, b.x, b.y, b.w, b.h);
      ctx.restore();
      this.#rr(b.x, b.y, b.w, b.h, 6);
      ctx.lineWidth = Math.max(1 / z, 1);
      ctx.strokeStyle = 'rgba(160,190,225,0.22)';
      ctx.stroke();
    } else {
      ctx.fillStyle = THEME.surface;
      ctx.fill();
      ctx.lineWidth = Math.max(1 / z, 1);
      ctx.strokeStyle = img === 'error' ? THEME.danger : THEME.border;
      if (img === 'error') ctx.setLineDash([5 / z, 4 / z]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (Math.min(b.w, b.h) * z > 28) {
        ctx.fillStyle = img === 'error' ? THEME.danger : THEME.text3;
        ctx.font = fontString(Math.max(12, 12 / z), 500);
        ctx.textAlign = 'center';
        ctx.fillText(img === 'error' ? "Couldn't load image" : 'Loading…', b.x + b.w / 2, b.y + b.h / 2 + 4);
        ctx.textAlign = 'left';
      }
    }
    if (o.origin === 'ai') {
      ctx.fillStyle = THEME.accent;
      ctx.beginPath();
      ctx.arc(b.x + b.w - 9, b.y + 9, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  #card(o, b, z, title, sub, kind) {
    const { ctx } = this;
    this.#rr(b.x, b.y, b.w, b.h, 8);
    ctx.fillStyle = THEME.surface;
    ctx.fill();
    ctx.lineWidth = Math.max(1 / z, 1);
    ctx.strokeStyle = THEME.border;
    ctx.stroke();
    if (28 * z < 5) return;
    const ix = b.x + 14; const iy = b.y + b.h / 2;
    ctx.strokeStyle = THEME.accent;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    if (kind === 'link') {
      ctx.roundRect(ix, iy - 5, 11, 10, 5); ctx.roundRect(ix + 7, iy - 5, 11, 10, 5);
    } else {
      ctx.moveTo(ix, iy - 9); ctx.lineTo(ix + 11, iy - 9); ctx.lineTo(ix + 17, iy - 3); ctx.lineTo(ix + 17, iy + 9); ctx.lineTo(ix, iy + 9); ctx.closePath();
    }
    ctx.stroke();
    const tx = ix + 30;
    const maxW = b.w - 30 - 28;
    ctx.fillStyle = THEME.text;
    ctx.font = fontString(14, 550);
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(ellipsize(title, ctx.font, maxW), tx, iy - 1);
    ctx.fillStyle = THEME.text2;
    ctx.font = fontString(11.5, 450);
    ctx.fillText(ellipsize(sub, ctx.font, maxW), tx, iy + 15);
  }

  /** A widget's card. The live frame (widgets.js) covers it when big enough; zoomed out, this is what you see. */
  #widget(o, b, z) {
    const { ctx } = this;
    this.#rr(b.x, b.y, b.w, b.h, 10);
    ctx.fillStyle = '#0B1626';
    ctx.fill();
    ctx.lineWidth = Math.max(1 / z, 1);
    ctx.strokeStyle = THEME.border;
    ctx.stroke();
    if (this.widgetLive?.(o.id)) return;
    // Title stays readable when zoomed out, like section titles.
    const px = Math.min(Math.max(14, 13 / z), b.h / 4.5, 80);
    if (px * z < 4) return;
    ctx.font = fontString(px, 600);
    ctx.fillStyle = THEME.text;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(ellipsize(o.title || 'Widget', ctx.font, b.w - px * 2.2), b.x + px, b.y + px * 1.75);
    // A small "live widget" mark (window with a line), never a fake chart: the real content is only in the live frame.
    const s = px * 0.9;
    const ix = b.x + px; const iy = b.y + px * 2.55;
    if (iy + s < b.y + b.h - px * 0.4) {
      ctx.strokeStyle = THEME.accent;
      ctx.lineWidth = Math.max(1 / z, px * 0.08);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.roundRect(ix, iy, s * 1.2, s, s * 0.18);
      ctx.moveTo(ix + s * 0.22, iy + s * 0.72); ctx.lineTo(ix + s * 0.5, iy + s * 0.45); ctx.lineTo(ix + s * 0.7, iy + s * 0.58); ctx.lineTo(ix + s * 0.98, iy + s * 0.28);
      ctx.stroke();
      ctx.font = fontString(px * 0.78, 500);
      ctx.fillStyle = THEME.text3;
      const room = b.x + b.w - (ix + s * 1.6) - px * 0.5; // the label never runs past the card's edge
      if (ctx.measureText('Live widget').width <= room) ctx.fillText('Live widget', ix + s * 1.6, iy + s * 0.78);
    }
  }

  #drawDraft(z) {
    const d = this.draft;
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 0.9;
    if (d.type === 'draw') {
      this.#draw({ ...d, x: 0, y: 0 }, z);
    } else if (d.type === 'arrow') {
      const g = this.model.arrowGeom(d);
      if (g) {
        ctx.strokeStyle = THEME.accent;
        ctx.lineWidth = Math.max(1.5, 1.3 / z);
        ctx.setLineDash([6 / z, 4 / z]);
        ctx.beginPath(); ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); ctx.stroke();
        ctx.setLineDash([]);
      }
    } else {
      this.#rr(d.x, d.y, d.w, d.h, d.type === 'frame' ? 12 : 7);
      ctx.fillStyle = THEME.accentSoft;
      ctx.fill();
      ctx.lineWidth = 1.2 / z;
      ctx.strokeStyle = THEME.accent;
      ctx.setLineDash([5 / z, 4 / z]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  #overlay(z, now) {
    const { ctx, model } = this;
    const lw = 1.5 / z;
    // remote highlight (what the phone selected on the TV)
    for (const id of this.highlightIds) {
      const o = model.get(id);
      if (!o) continue;
      this.#outline(model.box(o), 2.5 / z, THEME.accent, 5 / z);
    }
    // freshly added by AI: a ring that fades out
    let animating = false;
    for (const [id, t0] of this.flashes) {
      const age = (now - t0) / 1400;
      const o = model.get(id);
      if (age >= 1 || !o) { this.flashes.delete(id); continue; }
      animating = true;
      ctx.globalAlpha = (1 - age) * 0.9;
      this.#outline(model.box(o), 2 / z, THEME.accent, (4 + age * 10) / z);
      ctx.globalAlpha = 1;
    }
    if (this.hover && !this.selection.has(this.hover)) {
      const o = model.get(this.hover);
      if (o && o.type !== 'arrow') this.#outline(model.box(o), lw, THEME.borderHi, 3 / z);
    }
    if (this.arrowTarget) {
      const o = model.get(this.arrowTarget);
      if (o) this.#outline(model.box(o), 2 / z, THEME.accent, 4 / z);
    }
    // selection
    const sel = [...this.selection].map((id) => model.get(id)).filter(Boolean);
    for (const o of sel) {
      if (o.type === 'arrow') {
        const g = model.arrowGeom(o);
        if (!g) continue;
        ctx.strokeStyle = THEME.accent;
        ctx.lineWidth = Math.max(3, 2.4 / z);
        ctx.globalAlpha = 0.35;
        ctx.beginPath(); ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); ctx.stroke();
        ctx.globalAlpha = 1;
        for (const [px, py] of [[g.x1, g.y1], [g.x2, g.y2]]) {
          ctx.beginPath();
          ctx.arc(px, py, 5.5 / z, 0, Math.PI * 2);
          ctx.fillStyle = THEME.bg; ctx.fill();
          ctx.lineWidth = 1.6 / z; ctx.strokeStyle = THEME.accent; ctx.stroke();
        }
      } else {
        this.#outline(model.box(o), lw * 1.2, THEME.accent, 0);
      }
    }
    if (sel.length === 1 && sel[0].type !== 'arrow' && !sel[0].locked && !this.noHandles && this.liveWidget !== sel[0].id) {
      const b = model.box(sel[0]);
      const hs = HANDLE / z;
      for (const h of handlePositions(b)) {
        if (sel[0].type === 'note' && sel[0].autoH !== false && (h.id === 'n' || h.id === 's' || h.id.length === 2)) continue;
        ctx.fillStyle = '#E5EDF5';
        ctx.strokeStyle = THEME.accent;
        ctx.lineWidth = 1.4 / z;
        this.#rr(h.x - hs / 2, h.y - hs / 2, hs, hs, 2.5 / z);
        ctx.fill();
        ctx.stroke();
      }
    } else if (sel.length > 1) {
      const u = model.contentBounds(sel.map((o) => o.id));
      if (u) {
        ctx.setLineDash([5 / z, 4 / z]);
        this.#outline(u, lw, THEME.accent, 6 / z);
        ctx.setLineDash([]);
      }
    }
    if (this.marquee) {
      const m = this.marquee;
      ctx.fillStyle = THEME.accentSoft;
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.strokeStyle = THEME.accent;
      ctx.lineWidth = 1 / z;
      ctx.strokeRect(m.x, m.y, m.w, m.h);
    }
    if (this.guides.length) {
      ctx.strokeStyle = '#7FB0E3';
      ctx.lineWidth = 1 / z;
      ctx.beginPath();
      for (const g of this.guides) { ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); }
      ctx.stroke();
    }
    if (this.remoteRect) {
      const r = this.remoteRect;
      if (this.remoteDim) {
        const v = this.cam.view();
        ctx.fillStyle = 'rgba(5,7,12,0.62)';
        ctx.fillRect(v.x, v.y, v.w, r.y - v.y);
        ctx.fillRect(v.x, r.y + r.h, v.w, v.y + v.h - (r.y + r.h));
        ctx.fillRect(v.x, r.y, r.x - v.x, r.h);
        ctx.fillRect(r.x + r.w, r.y, v.x + v.w - (r.x + r.w), r.h);
        ctx.strokeStyle = THEME.borderHi;
        ctx.lineWidth = 1.5 / z;
      } else {
        ctx.fillStyle = 'rgba(86,137,186,0.10)';
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = THEME.accent;
        ctx.lineWidth = 2.5 / z;
      }
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
    if (animating) this.invalidate();
  }

  #outline(b, lw, color, pad) {
    const { ctx } = this;
    ctx.lineWidth = lw;
    ctx.strokeStyle = color;
    this.#rr(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2, 8 + pad);
    ctx.stroke();
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url || ''; }
}
