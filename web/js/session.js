import { store as lstore } from './api.js';
import { History } from './model.js';
import { NOTE_WIDTH, estimateNoteHeight } from '../shared/schema.js';
import { findFreeSpot } from '../shared/layout.js';

const rand = () => {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => (b % 36).toString(36)).join('');
};
export const newId = (prefix) => `${prefix}_${rand()}`;

export class Emitter {
  constructor() { this.h = new Map(); }
  on(t, fn) { (this.h.get(t) || this.h.set(t, new Set()).get(t)).add(fn); return () => this.h.get(t).delete(fn); }
  emit(t, p) { for (const fn of this.h.get(t) || []) { try { fn(p); } catch (e) { console.error(t, e); } } }
}

/**
 * Glue between network, model, history and the UI. Everything the user does goes through `commit`, which applies
 * optimistically, records undo, and queues the change for the server.
 */
export class Session extends Emitter {
  constructor({ cfg, api, net, model, camera, renderer }) {
    super();
    Object.assign(this, { cfg, api, net, model, camera, renderer });
    this.history = new History();
    this.boardId = null;
    this.boards = [];
    this.display = null;
    this.clients = [];
    this.selection = new Set();
    this.clip = null;
    this.status = 'connecting';
    this.applyingRemote = false;
    // The phone remote shows the TV's view scaled to fit its own screen; these map between the two cameras.
    this.camMap = { toDisplay: (c) => c, fromDisplay: (c) => c };
    this.aiTurn = null;
    this.camTimer = 0;
    this.cacheTimer = 0;
    this.firstLoad = true;

    net.on('status', (s) => { this.status = s; this.emit('status', s); });
    net.on('outbox', (n) => { this.emit('outbox', n); this.#saveOutbox(); });
    net.on('welcome', (m) => { this.display = m.display; this.boards = m.boards; this.emit('boards', this.boards); this.emit('display', this.display); });
    net.on('board', (m) => this.#onBoard(m));
    net.on('delta', (m) => this.#onDelta(m));
    net.on('ops', (m) => this.#onOps(m));
    net.on('live', (m) => { if (m.board === this.boardId) this.model.applyOps(m.patches.map((p) => ({ op: 'patch', id: p.id, set: p.set }))); });
    net.on('display', (m) => { this.display = m.display; this.emit('display', this.display); });
    net.on('presence', (m) => { this.clients = m.clients; this.emit('presence', this.clients); });
    net.on('boards', () => this.refreshBoards());
    net.on('ai', (m) => this.emit('ai', m));
    net.on('msg', (m) => this.emit('msg', m.message));
    net.on('pending', (m) => this.emit('confirm', m.pending)); // an AI action is waiting for the user's yes
    net.on('pending.resolved', (m) => this.emit('confirm-resolved', m));
    net.on('caption', (m) => this.emit('caption', m));
    net.on('tts', (m) => this.emit('tts', m));
    net.on('nack', (m) => { if (m.board === this.boardId && !m.cid) this.emit('toast', { text: m.error || 'A change was rejected', kind: 'error' }); });
  }

  async refreshBoards() {
    try {
      const r = await this.api.get('/api/boards');
      this.boards = r.boards;
      this.emit('boards', this.boards);
    } catch { /* offline */ }
  }

  // ------------------------------------------------------------------------------- board lifecycle

  async openBoard(id, { silent = false } = {}) {
    if (!id) return;
    if (this.boardId) {
      this.net.unsub(this.boardId);
      this.#saveCam();
    }
    this.boardId = id;
    this.model.reset({ id });
    this.history.clear();
    this.setSelection([]);
    this.firstLoad = true;
    const cached = this.#readCache(id);
    if (cached) {
      this.model.load(cached);
      this.#restoreCamera(id, cached.objects.length > 0);
      this.firstLoad = false;
    }
    this.net.sub(id);
    this.emit('board', { id, board: cached?.board || null, cached: !!cached });
    if (!silent) this.emit('toast-clear');
  }

  resync() {
    if (this.boardId) this.net.rawResync(this.boardId);
  }

  #onBoard(m) {
    if (m.board.id !== this.boardId) return;
    this.model.load({ board: m.board, objects: m.objects, rev: m.rev });
    this.#replayPending();
    if (this.firstLoad) { this.#restoreCamera(this.boardId, m.objects.length > 0); this.firstLoad = false; }
    this.#writeCache();
    this.emit('board', { id: m.board.id, board: m.board });
  }

  #onDelta(m) {
    if (m.board !== this.boardId) return;
    this.model.applyDelta(m);
    this.#replayPending();
    this.#writeCache();
    this.#pruneSelection();
  }

  #onOps(m) {
    if (m.board !== this.boardId) return;
    this.model.applyOps(m.ops, m.rev);
    if (m.actor === 'ai') {
      const created = m.ops.filter((o) => o.op === 'put').map((o) => o.obj.id);
      if (created.length) this.renderer.flash(created);
      this.emit('ai-change', { label: m.label, batch: m.batch });
    }
    this.#pruneSelection();
    clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => this.#writeCache(), 1500);
  }

  #replayPending() {
    for (const p of this.net.pendingList()) if (p.board === this.boardId) this.model.applyOps(p.ops);
  }

  #pruneSelection() {
    let changed = false;
    for (const id of [...this.selection]) if (!this.model.get(id)) { this.selection.delete(id); changed = true; }
    if (changed) this.#syncSelection();
  }

  // ---------------------------------------------------------------------------------- persistence

  #readCache(id) {
    const raw = lstore.get(`oboard.cache.${id}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  #writeCache() {
    if (!this.model.loaded || !this.boardId) return;
    const data = JSON.stringify({ board: this.model.board, objects: [...this.model.objects.values()], rev: this.model.rev });
    if (data.length < 3_000_000) lstore.set(`oboard.cache.${this.boardId}`, data);
  }

  #saveOutbox() {
    const list = this.net.pendingList();
    if (list.length) lstore.set('oboard.outbox', JSON.stringify(list));
    else lstore.del('oboard.outbox');
  }

  restoreOutbox() {
    const raw = lstore.get('oboard.outbox');
    if (!raw) return;
    try {
      for (const p of JSON.parse(raw)) this.net.sendOps(p.board, p.ops, p.label).catch(() => {});
    } catch { /* corrupt */ }
  }

  #saveCam() {
    if (this.cfg.mode !== 'edit' || !this.boardId) return;
    lstore.set(`oboard.cam.${this.boardId}`, JSON.stringify({ x: this.camera.x, y: this.camera.y, z: this.camera.z }));
  }

  queueCamSave() {
    clearTimeout(this.camTimer);
    this.camTimer = setTimeout(() => this.#saveCam(), 500);
  }

  #restoreCamera(id, hasContent) {
    if (this.cfg.mode === 'tv' || this.cfg.mode === 'remote') {
      if (this.display?.cam && this.display.boardId === id) this.#applyRemoteCam(this.camMap.fromDisplay(this.display.cam), false);
      else this.fitContent(false);
      return;
    }
    const saved = lstore.get(`oboard.cam.${id}`);
    if (saved) {
      try { const c = JSON.parse(saved); this.camera.set(c.x, c.y, c.z); return; } catch { /* fall through */ }
    }
    if (hasContent) this.fitContent(false); else this.camera.set(0, 0, 1);
  }

  fitContent(animate = true, ids) {
    const box = this.model.contentBounds(ids);
    const target = box ? this.camera.fit(box, { maxZoom: 1.2 }) : { x: 0, y: 0, z: 1 };
    if (animate) this.camera.animateTo(target); else this.camera.set(target.x, target.y, target.z);
  }

  // ------------------------------------------------------------------------------------ display sync

  #applyRemoteCam(cam, animate = true) {
    this.applyingRemote = true;
    const done = () => { this.applyingRemote = false; };
    if (animate) this.camera.animateTo(cam, 420).then(done); else { this.camera.set(cam.x, cam.y, cam.z); done(); }
  }

  /** Called by TV/remote modes when the server's display state changes. */
  followDisplay(d) {
    this.display = d;
    if (d.boardId !== this.boardId) { this.openBoard(d.boardId); return; }
    const prev = this._lastCam;
    if (d.cam && (!prev || prev.x !== d.cam.x || prev.y !== d.cam.y || prev.z !== d.cam.z)) {
      this._lastCam = { ...d.cam };
      const mine = this.camMap.fromDisplay(d.cam);
      const near = Math.abs(this.camera.x - mine.x) < 0.5 && Math.abs(this.camera.y - mine.y) < 0.5 && Math.abs(this.camera.z / mine.z - 1) < 0.002;
      if (!near) this.#applyRemoteCam(mine, true);
    }
  }

  /** Report this client's camera as the shared display camera (TV, or the phone remote's mirror view). */
  pushCamera() {
    if (this.applyingRemote) return;
    clearTimeout(this._camPush);
    this._camPush = setTimeout(() => {
      const c = this.camMap.toDisplay({ x: this.camera.x, y: this.camera.y, z: this.camera.z });
      this._lastCam = c;
      const patch = { cam: c };
      if (this.cfg.mode === 'tv') patch.viewport = { w: this.camera.w, h: this.camera.h };
      this.net.display(patch);
    }, 60);
  }

  // --------------------------------------------------------------------------------------- selection

  setSelection(ids) {
    this.selection = new Set(ids);
    this.#syncSelection();
  }

  #syncSelection() {
    this.renderer.selection = this.selection;
    this.renderer.invalidate();
    this.emit('selection', [...this.selection]);
  }

  // ------------------------------------------------------------------------------------ editing core

  commit(ops, { label = '', history = true } = {}) {
    ops = this.model.sanitize(ops);
    if (!ops.length || !this.boardId) return false;
    const inverse = this.model.inverseOf(ops);
    this.model.applyOps(ops);
    if (history) {
      this.history.push({ forward: ops, inverse, label });
      this.emit('history');
    }
    this.net.sendOps(this.boardId, ops, label).catch((e) => {
      this.emit('toast', { text: e.message || "Couldn't save that change", kind: 'error' });
      this.resync();
    });
    this.#pruneSelection();
    clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => this.#writeCache(), 1500);
    return true;
  }

  undo() {
    const e = this.history.undoStack.pop();
    if (!e) return;
    this.commit(e.inverse, { label: `Undo ${e.label}`, history: false });
    this.history.redoStack.push(e);
    this.emit('history');
  }

  redo() {
    const e = this.history.redoStack.pop();
    if (!e) return;
    this.commit(e.forward, { label: `Redo ${e.label}`, history: false });
    this.history.undoStack.push(e);
    this.emit('history');
  }

  // ---------------------------------------------------------------------------------------- objects

  nextZ() { return Math.floor(this.model.maxZ()) + 1; }

  makeNote(x, y, text = '', extra = {}) {
    return { id: newId('n'), type: 'note', x: Math.round(x), y: Math.round(y), w: NOTE_WIDTH, h: estimateNoteHeight(text), text, origin: 'user', z: this.nextZ(), t: Date.now(), ...extra };
  }

  create(obj, label = 'Create') {
    const full = { z: this.nextZ(), origin: 'user', t: Date.now(), ...obj };
    this.commit([{ op: 'put', obj: full }], { label });
    return full;
  }

  /** Free spot near the middle of what the user is looking at. */
  freeSpot(w, h) {
    const boxes = this.model.list().filter((o) => o.type !== 'arrow' && o.type !== 'frame').map((o) => this.model.box(o));
    return findFreeSpot(boxes, w, h, { x: this.camera.x, y: this.camera.y });
  }

  deleteObjects(ids) {
    const doomed = new Set(ids);
    const ops = [];
    for (const id of doomed) {
      const o = this.model.get(id);
      if (!o) continue;
      if (o.type !== 'arrow') {
        const b = this.model.box(o);
        const c = { x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) };
        for (const a of this.model.arrowsFor(id)) {
          if (doomed.has(a.id)) continue;
          const set = {};
          if (a.from.id === id) set.from = c;
          if (a.to.id === id) set.to = c;
          ops.push({ op: 'patch', id: a.id, set });
        }
      }
    }
    for (const id of doomed) if (this.model.get(id)) ops.push({ op: 'del', id });
    if (ops.length) this.commit(ops, { label: ids.length === 1 ? 'Delete' : `Delete ${ids.length} objects` });
    this.setSelection([]);
  }

  copy(ids) {
    const objs = ids.map((id) => this.model.get(id)).filter(Boolean);
    if (!objs.length) return;
    const set = new Set(objs.map((o) => o.id));
    // arrows travel along if both ends are inside the copied set
    for (const o of this.model.objects.values()) if (o.type === 'arrow' && set.has(o.from.id) && set.has(o.to.id) && !set.has(o.id)) objs.push(o);
    this.clip = { objs: JSON.parse(JSON.stringify(objs)), at: Date.now() };
  }

  paste(at) {
    if (!this.clip) return false;
    const map = new Map();
    for (const o of this.clip.objs) map.set(o.id, newId(o.type[0]));
    const boxes = this.clip.objs.filter((o) => o.type !== 'arrow');
    const minX = Math.min(...boxes.map((o) => o.x));
    const minY = Math.min(...boxes.map((o) => o.y));
    const dx = at ? at.x - minX : 28;
    const dy = at ? at.y - minY : 28;
    let z = this.nextZ();
    const ops = [];
    for (const o of this.clip.objs) {
      const copy = { ...o, id: map.get(o.id), z: z++, t: Date.now(), origin: 'user' };
      delete copy.meta;
      if (o.type === 'arrow') {
        for (const end of ['from', 'to']) copy[end] = o[end].id ? { id: map.get(o[end].id) } : { x: o[end].x + dx, y: o[end].y + dy };
      } else { copy.x = Math.round(o.x + dx); copy.y = Math.round(o.y + dy); }
      ops.push({ op: 'put', obj: copy });
    }
    ops.sort((a, b) => (a.obj.type === 'arrow') - (b.obj.type === 'arrow'));
    this.commit(ops, { label: 'Paste' });
    this.setSelection(ops.filter((o) => o.obj.type !== 'arrow').map((o) => o.obj.id));
    if (!at) this.clip.objs = this.clip.objs.map((o) => (o.type === 'arrow' ? o : { ...o, x: o.x + 28, y: o.y + 28 }));
    return true;
  }

  duplicate(ids) {
    this.copy(ids);
    this.paste(null);
  }

  reorder(ids, where) {
    const objs = ids.map((id) => this.model.get(id)).filter(Boolean);
    if (!objs.length) return;
    const all = [...this.model.objects.values()];
    const hi = Math.max(...all.map((o) => o.z || 0));
    const lo = Math.min(...all.map((o) => o.z || 0));
    const ops = objs.map((o, i) => ({ op: 'patch', id: o.id, set: { z: where === 'front' ? hi + 1 + i : lo - objs.length + i } }));
    this.commit(ops, { label: where === 'front' ? 'Bring to front' : 'Send to back' });
  }

  // ------------------------------------------------------------------------------------------- AI

  async ask(text, attachments = []) {
    const c = this.camera;
    return this.api.post('/api/ai/message', {
      boardId: this.boardId, text, attachments, selection: [...this.selection], source: 'text', anchor: { x: c.x, y: c.y },
    });
  }

  async uploadAndPlace(file, at) {
    const { prepareImage } = await import('./api.js');
    const blob = await prepareImage(file);
    const asset = await this.api.upload(blob, file.name || 'image');
    const isImg = asset.mime.startsWith('image/');
    const w = isImg ? 320 : 240;
    const h = isImg ? Math.round(w * ((asset.height || 3) / (asset.width || 4))) : 84;
    const spot = at ? { x: at.x - w / 2, y: at.y - h / 2 } : this.freeSpot(w, h);
    const obj = isImg
      ? { id: newId('i'), type: 'image', asset: asset.id, x: Math.round(spot.x), y: Math.round(spot.y), w, h, alt: asset.caption || '' }
      : { id: newId('f'), type: 'file', asset: asset.id, name: asset.filename || 'File', mime: asset.mime, x: Math.round(spot.x), y: Math.round(spot.y), w, h };
    this.create(obj, isImg ? 'Add image' : 'Add file');
    this.setSelection([obj.id]);
    return { asset, obj };
  }
}
