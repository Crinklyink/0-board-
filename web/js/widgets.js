import { THEME } from './theme.js';
import { codeHash } from '../shared/schema.js';

// Narrower than this on screen: show the canvas card instead of the live frame. Dense phone screens still show a
// small widget's numbers sharply, so there the limit is ~200 physical pixels (about 76 CSS px instead of 110).
const MIN_LIVE_PX = 110;
const MIN_LIVE_DEVICE_PX = 200;
const minLivePx = () => Math.min(MIN_LIVE_PX, MIN_LIVE_DEVICE_PX / (window.devicePixelRatio || 1));
const MARGIN_PX = 240;         // start frames a little before they scroll into view
const MAX_LIVE = 12;           // frames are real pages: cap how many run at once
const UNLOAD_AFTER_MS = 60_000; // off screen this long: stop it
const STATE_SAVE_MS = 5000;    // widget data is saved at most this often

// Passed to every widget as ob.theme and as CSS variables.
const WIDGET_THEME = {
  bg: '#0B1626', surface: THEME.surface, 'surface-hi': THEME.surfaceHi, border: THEME.border, text: THEME.text,
  muted: THEME.text2, faint: THEME.text3, accent: THEME.accent, up: '#4FB286', down: '#D46A68',
  grid: 'rgba(141,159,180,0.12)', font: THEME.font,
};

/**
 * Live widgets on the board. Each widget runs in its own sandboxed frame (no same-origin, no network), laid over the
 * canvas at the widget's position and scaled with the camera. The frame asks this page for data; this page asks the
 * Pi, which adds API keys. A widget cannot see the board, the device token or any key.
 */
export class WidgetLayer {
  constructor({ host, before, session, api, cfg }) {
    this.s = session;
    this.api = api;
    this.cfg = cfg;
    this.el = document.createElement('div');
    this.el.className = 'widgets';
    host.insertBefore(this.el, before);
    this.frames = new Map();
    this.interactive = null;
    // The phone's TV remote runs them too, so its mirror shows what the TV shows (it never saves widget state).
    this.enabled = true;
    window.addEventListener('message', (e) => this.#onMessage(e));
    session.net.on('secrets', (m) => this.#onSecrets(m));
    session.on('board', (b) => { if (b.id !== this.boardId) { this.clear(); this.boardId = b.id; } });
    document.addEventListener('visibilitychange', () => this.sync());
  }

  /** Is the live frame covering this widget right now (so the canvas can skip drawing its card content)? */
  isLive(id) {
    const f = this.frames.get(id);
    return !!f && f.shown;
  }

  clear() {
    for (const id of [...this.frames.keys()]) this.#destroy(id);
    this.interactive = null;
  }

  // ------------------------------------------------------------------------------------ layout

  /** Called after every canvas frame: place, start and stop widget frames to match the camera and the model. */
  sync() {
    if (!this.enabled) return;
    const { model, camera: cam } = this.s;
    const z = cam.z;
    const now = Date.now();
    const pageVisible = document.visibilityState === 'visible';
    const widgets = model.list().filter((o) => o.type === 'widget');
    const seen = new Set();
    let live = [...this.frames.values()].filter((f) => f.alive).length;
    const minPx = minLivePx();
    let order = 0;
    for (const o of widgets) {
      seen.add(o.id);
      const p = cam.toScreen(o.x, o.y);
      const sw = o.w * z;
      const sh = o.h * z;
      const onScreen = p.x < cam.w + MARGIN_PX && p.y < cam.h + MARGIN_PX && p.x + sw > -MARGIN_PX && p.y + sh > -MARGIN_PX;
      const bigEnough = sw >= minPx;
      let f = this.frames.get(o.id);
      if (!f && onScreen && bigEnough && live < MAX_LIVE) { f = this.#create(o); live++; }
      if (!f) continue;
      if (f.hash !== codeHash(o.html)) { this.#destroy(o.id); f = this.#create(o); }
      if (f.title !== o.title) { f.title = o.title; f.iframe.title = o.title; }
      if (JSON.stringify(o.state || {}) !== f.stateJson && !f.saveTimer) { f.stateJson = JSON.stringify(o.state || {}); this.#post(f, { type: 'state', state: o.state || {} }); }
      if (f.w !== o.w || f.h !== o.h) {
        f.w = o.w; f.h = o.h;
        f.wrap.style.width = `${o.w}px`;
        f.wrap.style.height = `${o.h}px`;
        this.#post(f, { type: 'resize', w: o.w, h: o.h });
      }
      const shown = onScreen && bigEnough;
      // The canvas draws the widget's card only while its frame is hidden: redraw when that flips.
      if (shown !== f.shown) this.s.renderer.invalidate();
      f.wrap.style.transform = `translate(${p.x}px, ${p.y}px) scale(${z})`;
      f.wrap.style.setProperty('--inv', String(1 / z));
      f.wrap.style.zIndex = String(++order);
      f.wrap.hidden = !shown;
      f.shown = shown;
      f.wrap.classList.toggle('sel', this.s.selection.has(o.id) && this.s.selection.size === 1);
      f.wrap.classList.toggle('dim', !!this.s.renderer.focusIds && !this.s.renderer.focusIds.has(o.id));
      const vis = shown && pageVisible;
      if (vis !== f.visible) { f.visible = vis; this.#post(f, { type: 'visible', on: vis }); }
      if (onScreen) f.lastSeen = now;
      else if (now - f.lastSeen > UNLOAD_AFTER_MS) this.#destroy(o.id);
    }
    for (const id of [...this.frames.keys()]) if (!seen.has(id)) this.#destroy(id);
    if (this.interactive && (!this.frames.has(this.interactive) || !this.s.selection.has(this.interactive))) this.setInteractive(null);
  }

  #create(o) {
    const wrap = document.createElement('div');
    wrap.className = 'wg';
    wrap.style.width = `${o.w}px`;
    wrap.style.height = `${o.h}px`;
    const iframe = document.createElement('iframe');
    // allow-scripts only: the frame gets an opaque origin, so it cannot read this page, its token, or its storage.
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'");
    iframe.setAttribute('loading', 'eager');
    iframe.title = o.title || 'Widget';
    iframe.src = 'widget.html';
    wrap.append(iframe);
    for (const pos of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const hd = document.createElement('i');
      hd.className = `hd hd-${pos}`;
      wrap.append(hd);
    }
    this.el.append(wrap);
    const f = {
      id: o.id, wrap, iframe, hash: codeHash(o.html), title: o.title, w: o.w, h: o.h, stateJson: JSON.stringify(o.state || {}),
      alive: true, shown: false, visible: false, lastSeen: Date.now(), inited: false, readySent: false, errors: 0, lastErrorAt: 0,
      needsKey: null, saveTimer: 0, lastSave: 0, inflight: 0,
    };
    this.frames.set(o.id, f);
    return f;
  }

  #destroy(id) {
    const f = this.frames.get(id);
    if (!f) return;
    clearTimeout(f.saveTimer);
    f.wrap.remove();
    this.frames.delete(id);
    if (this.interactive === id) this.interactive = null;
    this.s.renderer.invalidate();
  }

  reload(id) {
    if (!this.frames.has(id)) return;
    this.#destroy(id);
    this.s.renderer.invalidate();
  }

  /** Let touches and clicks reach the widget (buttons, inputs). Anything else on the board ends it. */
  setInteractive(id) {
    if (this.cfg.mode === 'tv') return;
    if (this.interactive && this.interactive !== id) this.frames.get(this.interactive)?.wrap.classList.remove('live');
    this.interactive = id;
    const f = id && this.frames.get(id);
    if (f) { f.wrap.classList.add('live'); f.iframe.focus(); }
    this.s.renderer.liveWidget = id || null; // no resize handles while the widget itself is being used
    this.s.renderer.invalidate();
    this.s.emit('widget-interactive', id);
  }

  // ------------------------------------------------------------------------------- messaging

  #post(f, msg) {
    try { f.iframe.contentWindow?.postMessage({ __ob: 1, ...msg }, '*'); } catch { /* frame gone */ }
  }

  #onMessage(e) {
    const m = e.data;
    if (!m || m.__ob !== 1) return;
    let f = null;
    for (const x of this.frames.values()) if (x.iframe.contentWindow === e.source) { f = x; break; }
    if (!f) return;
    const o = this.s.model.get(f.id);
    if (!o) return;
    switch (m.type) {
      case 'hello':
        f.inited = true;
        this.#post(f, { type: 'init', id: o.id, html: o.html, title: o.title, mode: this.cfg.mode === 'tv' ? 'tv' : 'edit', state: o.state || {}, theme: WIDGET_THEME, w: o.w, h: o.h });
        this.#post(f, { type: 'visible', on: f.visible });
        break;
      case 'fetch': this.#fetch(f, m); break;
      case 'state': this.#saveState(f, m.state); break;
      case 'report': this.#report(f, o, m); break;
      default: break;
    }
  }

  async #fetch(f, m) {
    if (f.inflight > 20) { this.#post(f, { type: 'fetch:result', rid: m.rid, url: m.url, error: 'Too many requests at once' }); return; }
    f.inflight++;
    try {
      const r = await this.api.post('/api/widgets/fetch', { url: m.url, headers: m.headers, cache: m.cache, widgetId: f.id });
      this.#post(f, { type: 'fetch:result', rid: m.rid, url: m.url, ok: r.ok, status: r.status, body: r.body });
    } catch (e) {
      this.#post(f, { type: 'fetch:result', rid: m.rid, url: m.url, error: e.message, code: e.code || e.body?.code, key: e.body?.key });
    } finally { f.inflight--; }
  }

  #saveState(f, state) {
    if (this.cfg.mode === 'remote' || !state || typeof state !== 'object') return;
    const json = JSON.stringify(state);
    if (json.length > 8000 || json === f.stateJson) return;
    f.stateJson = json;
    clearTimeout(f.saveTimer);
    const wait = Math.max(0, f.lastSave + STATE_SAVE_MS - Date.now());
    f.saveTimer = setTimeout(() => {
      f.saveTimer = 0;
      f.lastSave = Date.now();
      if (!this.s.model.get(f.id)) return;
      this.s.commit([{ op: 'patch', id: f.id, set: { state: JSON.parse(f.stateJson) } }], { label: 'Widget data', history: false });
    }, wait);
  }

  #report(f, o, m) {
    const level = m.level;
    if (level === 'ready') { if (f.readySent) return; f.readySent = true; }
    if (level === 'needs_key') f.needsKey = m.message;
    if (level === 'error') {
      const t = Date.now();
      if (f.errors >= 3 && t - f.lastErrorAt < 30_000) return;
      f.errors++; f.lastErrorAt = t;
    }
    if (level === 'log' && f.logs > 20) return;
    if (level === 'log') f.logs = (f.logs || 0) + 1;
    this.api.post(`/api/widgets/${encodeURIComponent(f.id)}/report`, {
      boardId: this.s.boardId, level, message: m.message || '', text: m.text || '', hash: f.hash,
    }).catch(() => { /* offline: the next report will do */ });
    void o;
  }

  #onSecrets(m) {
    // A key was just saved: restart the widgets that were waiting for it.
    if (!m.set) return;
    for (const f of [...this.frames.values()]) if (f.needsKey && (!m.name || f.needsKey === m.name)) this.reload(f.id);
  }
}
