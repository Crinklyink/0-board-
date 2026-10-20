import { WebSocketServer } from 'ws';
import { rid, now, safeJson, log, clamp } from './util.js';
import { StoreError } from './store.js';
import { bounds, unionBounds } from '../../web/shared/schema.js';

const HEARTBEAT_MS = 25_000;
const MAX_PAYLOAD = 12 * 1024 * 1024;

/**
 * WebSocket hub: board sync, the shared "display" state (what the TV shows), and event fan-out for AI turns.
 *
 * Wire format: JSON text frames, always {t: <type>, ...}.
 *   client -> server: hello, sub, unsub, ops, live, display, ping, tts
 *   server -> client: welcome, board, delta, ops, ack, nack, live, display, presence, boards, ai, msg, pending, toast, pong, tts
 */
export class Hub {
  constructor({ store, auth, config }) {
    this.store = store;
    this.auth = auth;
    this.config = config;
    this.clients = new Set();
    this.skip = null;
    this.display = this.#loadDisplay();
    this.camTimer = null;

    store.events.on('ops', (ev) => this.#fanOps(ev));
    store.events.on('boards', () => this.broadcast({ t: 'boards' }));
    store.events.on('message', (m) => this.broadcast({ t: 'msg', message: m }));
  }

  attach(httpServer) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== '/ws') return socket.destroy();
      const token = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer /i, '');
      const device = this.auth.authenticate(token);
      if (!device) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return socket.destroy();
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.#onConnect(ws, device, url));
    });
    this.hb = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) { c.ws.terminate(); continue; }
        c.alive = false;
        try { c.ws.ping(); } catch { /* closing */ }
      }
    }, HEARTBEAT_MS);
    this.hb.unref?.();
  }

  close() {
    clearInterval(this.hb);
    clearTimeout(this.camTimer);
    for (const c of this.clients) c.ws.terminate();
    this.wss?.close();
  }

  // ---------------------------------------------------------------- display

  #loadDisplay() {
    const saved = safeJson(this.store.db.prepare(`SELECT value FROM meta WHERE key = 'display'`).get()?.value, {});
    let boardId = saved.boardId;
    if (!boardId || !this.store.getBoard(boardId)) boardId = this.store.listBoards().find((b) => b.kind === 'space')?.id || 'thoughts';
    const board = this.store.getBoard(boardId);
    return {
      boardId, cam: board?.camera || null, viewport: { w: 1920, h: 1080 },
      selection: [], mode: 'normal', focusIds: [], slide: 0, rev: 0, audio: !!saved.audio,
    };
  }

  #saveDisplay() {
    this.store.db.prepare(`INSERT INTO meta(key, value) VALUES ('display', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify({ boardId: this.display.boardId, audio: this.display.audio }));
  }

  /** Apply a partial display change. `from` is the client that originated it (it is not echoed back). */
  setDisplay(patch, from = null) {
    const d = this.display;
    if (patch.boardId && patch.boardId !== d.boardId) {
      const board = this.store.getBoard(patch.boardId);
      if (board) {
        this.#flushCamera();
        d.boardId = board.id;
        d.cam = patch.cam || board.camera || null;
        d.selection = [];
        d.focusIds = [];
        d.mode = 'normal';
        d.slide = 0;
        this.store.markOpened(board.id);
        this.#saveDisplay();
      }
    } else if (patch.cam && validCam(patch.cam)) {
      d.cam = { x: patch.cam.x, y: patch.cam.y, z: clamp(patch.cam.z, 0.01, 8) };
      this.#queueCameraSave();
    }
    if (patch.selection && Array.isArray(patch.selection)) d.selection = patch.selection.filter((x) => typeof x === 'string').slice(0, 500);
    if (patch.mode && ['normal', 'focus', 'present'].includes(patch.mode)) d.mode = patch.mode;
    if (patch.focusIds && Array.isArray(patch.focusIds)) d.focusIds = patch.focusIds.filter((x) => typeof x === 'string').slice(0, 500);
    if (Number.isInteger(patch.slide)) d.slide = Math.max(0, patch.slide);
    if (patch.viewport && patch.viewport.w > 0 && patch.viewport.h > 0) d.viewport = { w: Math.round(patch.viewport.w), h: Math.round(patch.viewport.h) };
    if (typeof patch.audio === 'boolean') { d.audio = patch.audio; this.#saveDisplay(); }
    if (patch.fit === true) {
      // "Show everything" / "show what I selected", computed here so the phone needs no geometry.
      const ids = Array.isArray(patch.fitIds) ? patch.fitIds.filter((x) => typeof x === 'string').slice(0, 500) : [];
      const box = this.boundsOf(d.boardId, ids);
      if (box) {
        const v = d.viewport;
        const pad = 0.14;
        const z = clamp(Math.min(v.w / (box.w * (1 + pad * 2)), v.h / (box.h * (1 + pad * 2))), 0.02, ids.length ? 1.4 : 1.2);
        d.cam = { x: box.x + box.w / 2, y: box.y + box.h / 2, z };
        this.#queueCameraSave();
      }
    }
    d.rev++;
    this.broadcast({ t: 'display', display: d, from: from?.id || null }, { except: from });
  }

  /** Fit the TV camera around some bounds (used by focus_tv). */
  fitDisplayTo(bbox, { maxZoom = 1.6, pad = 0.14 } = {}) {
    if (!bbox) return;
    const v = this.display.viewport;
    const z = clamp(Math.min(v.w / (bbox.w * (1 + pad * 2)), v.h / (bbox.h * (1 + pad * 2))), 0.02, maxZoom);
    this.setDisplay({ cam: { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2, z } });
  }

  /** Bring objects the AI just touched into view on the TV, unless they are already mostly visible. */
  reveal(boardId, ids) {
    const d = this.display;
    if (!ids.length || d.boardId !== boardId) return;
    const box = this.boundsOf(boardId, ids);
    if (!box) return;
    if (d.cam) {
      const vw = d.viewport.w / d.cam.z;
      const vh = d.viewport.h / d.cam.z;
      const vx = d.cam.x - vw / 2;
      const vy = d.cam.y - vh / 2;
      const ox = Math.max(0, Math.min(box.x + box.w, vx + vw) - Math.max(box.x, vx));
      const oy = Math.max(0, Math.min(box.y + box.h, vy + vh) - Math.max(box.y, vy));
      const visible = (ox * oy) / Math.max(1, box.w * box.h);
      const tooSmall = (box.w * box.h) / (vw * vh) < 0.03;
      if (visible > 0.9 && !tooSmall) return;
    }
    this.fitDisplayTo(box, { maxZoom: 1.25, pad: 0.18 });
  }

  #queueCameraSave() {
    clearTimeout(this.camTimer);
    this.camTimer = setTimeout(() => this.#flushCamera(), 1200);
    this.camTimer.unref?.();
  }

  #flushCamera() {
    clearTimeout(this.camTimer);
    const d = this.display;
    if (d.cam && this.store.getBoard(d.boardId)) this.store.setCamera(d.boardId, d.cam);
  }

  // ------------------------------------------------------------- connections

  /** Is any screen that runs widgets (the TV, a phone or browser canvas; not the small remote mirror) showing this board? */
  watching(boardId) {
    for (const c of this.clients) if (c.boards.has(boardId) && !/ remote$/.test(c.name)) return true;
    return false;
  }

  /** A removed device loses its open connections at once, not just on its next reconnect. */
  dropDevice(deviceId) {
    for (const c of this.clients) if (c.device.id === deviceId) c.ws.close(4401, 'Device removed');
  }

  #onConnect(ws, device, url) {
    const client = {
      id: rid('c_', 8), ws, device, role: device.role, name: url.searchParams.get('name') || device.name,
      boards: new Set(), alive: true, msgCount: 0, msgReset: 0,
    };
    this.clients.add(client);
    log('info', 'ws connected', { client: client.id, device: device.name, role: client.role });

    ws.on('pong', () => { client.alive = true; });
    ws.on('close', () => {
      this.clients.delete(client);
      this.#presence();
    });
    ws.on('error', () => ws.terminate());
    ws.on('message', (data, isBinary) => {
      client.alive = true;
      if (isBinary) return;
      const t = now();
      if (client.msgReset < t) { client.msgReset = t + 1000; client.msgCount = 0; }
      if (++client.msgCount > 400) return; // flood guard
      const msg = safeJson(data.toString('utf8'));
      if (!msg || typeof msg.t !== 'string') return;
      try {
        this.#handle(client, msg);
      } catch (e) {
        log('error', 'ws handler failed', { t: msg.t, error: String(e?.stack || e) });
        this.send(client, { t: 'nack', cid: msg.cid || null, error: 'Internal error' });
      }
    });

    this.send(client, {
      t: 'welcome', clientId: client.id, device: { id: device.id, name: device.name, role: device.role },
      serverTime: now(), version: this.config.version, display: this.display, boards: this.store.listBoards(),
    });
    this.#presence();
  }

  #handle(client, msg) {
    switch (msg.t) {
      case 'ping':
        return this.send(client, { t: 'pong', ts: msg.ts || null });

      case 'sub': {
        const board = this.store.getBoard(msg.board);
        if (!board) return this.send(client, { t: 'nack', error: 'No such board', board: msg.board });
        client.boards.add(board.id);
        const since = Number.isInteger(msg.rev) ? msg.rev : -1;
        const delta = since >= 0 && since <= board.rev ? this.store.delta(board.id, since) : null;
        if (delta) {
          this.send(client, { t: 'delta', board: board.id, name: board.name, ...delta });
        } else {
          this.send(client, { t: 'board', board, objects: this.store.getObjects(board.id), rev: board.rev });
        }
        return undefined;
      }

      case 'unsub':
        client.boards.delete(msg.board);
        return undefined;

      case 'ops': {
        const board = this.store.getBoard(msg.board);
        if (!board) return this.send(client, { t: 'nack', cid: msg.cid, error: 'No such board', board: msg.board });
        this.skip = client;
        try {
          const out = this.store.applyBatch(board.id, msg.ops, { actor: `device:${client.device.id}`, label: msg.label, cid: msg.cid });
          this.send(client, { t: 'ack', cid: msg.cid, board: board.id, rev: out.rev });
        } catch (e) {
          if (!(e instanceof StoreError)) throw e;
          this.send(client, { t: 'nack', cid: msg.cid, board: board.id, error: e.message, code: e.code, rev: board.rev });
        } finally {
          this.skip = null;
        }
        return undefined;
      }

      case 'live': {
        // Ephemeral drag previews: relayed, never persisted.
        if (!Array.isArray(msg.patches) || msg.patches.length > 200) return undefined;
        const out = { t: 'live', board: msg.board, patches: msg.patches, from: client.id };
        for (const c of this.clients) if (c !== client && c.boards.has(msg.board)) this.send(c, out);
        return undefined;
      }

      case 'display':
        if (msg.patch && typeof msg.patch === 'object') this.setDisplay(msg.patch, client);
        return undefined;

      case 'caption': {
        // Live subtitles (what the assistant is saying / what the user said) for the TV to show.
        const text = String(msg.text || '').slice(0, 600);
        this.broadcast({ t: 'caption', role: msg.role === 'user' ? 'user' : 'assistant', text, final: !!msg.final, from: client.id }, { except: client });
        return undefined;
      }

      case 'tts': {
        // Phone -> TV speaker audio relay (beta). Only forwarded when the user turned TV audio on.
        if (!this.display.audio) return undefined;
        for (const c of this.clients) if (c.role === 'display') this.send(c, { t: 'tts', ...msg });
        return undefined;
      }

      default:
        return undefined;
    }
  }

  #fanOps(ev) {
    const out = {
      t: 'ops', board: ev.boardId, batch: ev.batchId, rev: ev.rev, actor: ev.actor, label: ev.label, turnId: ev.turnId, ops: ev.ops,
    };
    for (const c of this.clients) {
      if (c === this.skip || !c.boards.has(ev.boardId)) continue;
      this.send(c, out);
    }
  }

  #presence() {
    const list = [...this.clients].map((c) => ({ id: c.id, role: c.role, name: c.name, deviceId: c.device.id }));
    this.broadcast({ t: 'presence', clients: list });
  }

  send(client, msg) {
    if (client.ws.readyState !== 1) return;
    // Backpressure: drop ephemeral traffic for slow consumers rather than ballooning memory.
    if (client.ws.bufferedAmount > 4 * 1024 * 1024 && (msg.t === 'live' || msg.t === 'display' || msg.t === 'ai')) return;
    client.ws.send(JSON.stringify(msg));
  }

  broadcast(msg, { except = null, role = null } = {}) {
    const text = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c === except || (role && c.role !== role)) continue;
      if (c.ws.readyState !== 1) continue;
      if (c.ws.bufferedAmount > 4 * 1024 * 1024 && (msg.t === 'live' || msg.t === 'display' || msg.t === 'ai')) continue;
      c.ws.send(text);
    }
  }

  connected() {
    return [...this.clients].map((c) => ({ id: c.id, role: c.role, name: c.name }));
  }

  /** Bounds of some objects on a board, for camera fitting. */
  boundsOf(boardId, ids) {
    const objs = this.store.getObjects(boardId);
    const map = new Map(objs.map((o) => [o.id, o]));
    const picked = ids?.length ? ids.map((id) => map.get(id)).filter(Boolean) : objs;
    return unionBounds(picked.map((o) => bounds(o, (id) => map.get(id))));
  }
}

function validCam(c) {
  return c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z) && c.z > 0;
}
