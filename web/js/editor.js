import { THEME, colorOf } from './theme.js';
import { NOTE_FONT, TEXT_FONT, SHAPE_FONT, NOTE_PAD } from '../shared/schema.js';

const PROP = { note: 'text', text: 'text', shape: 'text', frame: 'title', arrow: 'label', link: 'title', image: 'alt', file: 'name' };

/**
 * In-place text editing. A real <textarea> is laid over the canvas object (so IME, selection, spellcheck and the
 * Android soft keyboard all behave natively) and sized in screen space to match the canvas rendering.
 */
export class Editor {
  constructor({ host, session }) {
    this.host = host;
    this.s = session;
    this.model = session.model;
    this.cam = session.camera;
    this.r = session.renderer;
    this.active = null;
    this.ta = document.createElement('textarea');
    this.ta.className = 'editor';
    this.ta.spellcheck = true;
    this.ta.autocapitalize = 'sentences';
    this.ta.hidden = true;
    this.ta.setAttribute('aria-label', 'Edit text');
    host.appendChild(this.ta);

    this.ta.addEventListener('input', () => this.#onInput());
    this.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.stop(true); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.stop(true); }
      e.stopPropagation();
    });
    this.ta.addEventListener('blur', () => { if (this.active && !this.ignoreBlur) this.stop(true); });
    this.cam.onChangeEditor = () => this.reposition();
    if (window.visualViewport) visualViewport.addEventListener('resize', () => this.#ensureVisible());
  }

  get editing() { return this.active?.id || null; }

  /** Start editing an object already in the model. */
  start(id, { fresh = false, select = false } = {}) {
    const o = this.model.get(id);
    if (!o || o.locked || !PROP[o.type] || o.type === 'image' || o.type === 'file') return false;
    this.stop(true);
    const prop = PROP[o.type];
    this.active = { id, prop, original: o[prop] || '', fresh, type: o.type, obj0: o };
    this.r.editingId = id;
    this.r.noHandles = true;
    this.ta.hidden = false;
    this.ta.value = o[prop] || '';
    this.reposition();
    this.r.invalidate();
    this.ignoreBlur = true;
    this.ta.focus({ preventScroll: true });
    if (select || !fresh) this.ta.select(); else this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length);
    setTimeout(() => { this.ignoreBlur = false; this.#ensureVisible(); }, 120);
    return true;
  }

  #onInput() {
    const a = this.active;
    if (!a) return;
    // Preview the text in the model so a note grows as you type; the real change is committed on stop().
    this.model.applyOps([{ op: 'patch', id: a.id, set: { [a.prop]: this.ta.value } }]);
    this.reposition();
    this.#ensureVisible();
  }

  /** Finish editing. Empty brand-new objects are discarded; everything else is one undoable change. */
  stop(commit = true) {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.ta.hidden = true;
    this.r.editingId = null;
    this.r.noHandles = false;
    const value = this.ta.value;
    const o = this.model.get(a.id);
    // roll back the live preview first so history records a clean before/after
    if (o) this.model.applyOps([{ op: 'patch', id: a.id, set: { [a.prop]: a.original || null } }]);
    this.ta.blur();
    if (!o) return;
    if (a.fresh) {
      this.model.applyOps([{ op: 'del', id: a.id }]);
      if (commit && (value.trim() || a.type === 'shape' || a.type === 'frame')) {
        const base = { ...a.obj0, [a.prop]: value, ...(a.type === 'shape' || a.type === 'frame' ? {} : {}) };
        this.s.create(base, `Add ${a.type}`);
        this.s.setSelection([a.id]);
      }
    } else if (commit && value !== (a.original || '')) {
      this.s.commit([{ op: 'patch', id: a.id, set: { [a.prop]: value === '' && a.type === 'arrow' ? null : value } }], { label: 'Edit text' });
    }
    this.r.invalidate();
    this.onStop?.();
  }

  reposition() {
    const a = this.active;
    if (!a) return;
    const o = this.model.get(a.id);
    if (!o) { this.stop(false); return; }
    const z = this.cam.z;
    const b = this.model.box(o);
    const c = colorOf(o.color);
    const ta = this.ta;
    let left; let top; let width; let height; let fs; let pad; let align = 'left'; let bg = c.fill; let weight = 450; let radius = 7;
    const p = this.cam.toScreen(b.x, b.y);
    left = p.x; top = p.y; width = b.w * z; height = b.h * z;
    if (o.type === 'note') { fs = (NOTE_FONT[o.size] || 15) * z; pad = NOTE_PAD * z; }
    else if (o.type === 'text') { fs = (TEXT_FONT[o.size] || 24) * z; pad = 0; bg = 'transparent'; weight = 500; radius = 2; align = o.align || 'left'; }
    else if (o.type === 'shape') { fs = (SHAPE_FONT[o.size] || 15) * z; pad = 12 * z; align = 'center'; weight = 500; radius = o.shape === 'ellipse' ? 999 : 9; }
    else if (o.type === 'frame') { fs = Math.min(Math.max(13, 12.5 / z), b.h / 5, 90) * z; left = p.x + fs * 0.6; top = p.y + fs * 0.7; width = Math.max(160, b.w * z * 0.6); height = fs * 1.9; pad = fs * 0.3; bg = THEME.bg; weight = 600; radius = 6; }
    else if (o.type === 'arrow') {
      const g = this.model.arrowGeom(o);
      const m = this.cam.toScreen((g.x1 + g.x2) / 2, (g.y1 + g.y2) / 2);
      fs = 13 * Math.max(1, z); width = 200; height = fs * 2; left = m.x - width / 2; top = m.y - height / 2; pad = 6; align = 'center'; bg = THEME.bg; radius = 8;
    } else { fs = 14 * z; pad = 8; }
    Object.assign(ta.style, {
      left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${Math.max(height, fs * 1.6)}px`,
      font: `${weight} ${Math.max(10, fs)}px ${THEME.font}`, lineHeight: '1.4', padding: `${pad}px`,
      textAlign: align, background: bg, color: o.type === 'shape' && o.fill === 'solid' ? '#05070C' : c.text,
      borderRadius: `${radius * z}px`, caretColor: THEME.accent,
      borderColor: THEME.accent,
    });
    if (o.type === 'shape') {
      // vertically centre text in shapes
      const lines = ta.value.split('\n').length;
      const textH = Math.min(height, lines * fs * 1.4);
      ta.style.paddingTop = `${Math.max(pad, (height - textH) / 2)}px`;
    }
  }

  #ensureVisible() {
    if (!this.active || this.ta.hidden) return;
    const vv = window.visualViewport;
    const vh = vv ? vv.height : innerHeight;
    const r = this.ta.getBoundingClientRect();
    const margin = 24;
    if (r.bottom > vh - margin) this.cam.panBy(0, -(r.bottom - vh + margin));
    else if (r.top < margin) this.cam.panBy(0, margin - r.top);
  }
}
