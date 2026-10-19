// WebSocket sync client: reconnecting, with an acknowledged outbox so nothing is lost across drops.

export class Net {
  constructor({ api, name, getRev }) {
    this.api = api;
    this.name = name;
    this.getRev = getRev; // (boardId) => last known rev
    this.handlers = new Map();
    this.boards = new Set();
    this.pending = new Map(); // cid -> {board, ops, label, resolve, reject}
    this.state = 'connecting';
    this.attempt = 0;
    this.seq = 0;
    this.stopped = false;
    this.clientId = null;
    this.lastMessageAt = 0;
    this.everOpened = false;
    this.onVis = () => { if (document.visibilityState === 'visible' && this.state !== 'online') this.#reconnectNow(); };
    document.addEventListener('visibilitychange', this.onVis);
    addEventListener('online', this.onVis);
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }

  #emit(type, payload) {
    for (const fn of this.handlers.get(type) || []) {
      try { fn(payload); } catch (e) { console.error('handler error', type, e); }
    }
  }

  #setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.#emit('status', s);
  }

  start() {
    this.stopped = false;
    this.#open();
    this.hb = setInterval(() => {
      if (this.state !== 'online') return;
      if (Date.now() - this.lastMessageAt > 32_000) { this.ws?.close(); return; }
      this.#raw({ t: 'ping', ts: Date.now() });
    }, 12_000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.hb);
    clearTimeout(this.retry);
    document.removeEventListener('visibilitychange', this.onVis);
    removeEventListener('online', this.onVis);
    this.ws?.close();
  }

  #url() {
    const u = new URL(this.api.base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = `token=${encodeURIComponent(this.api.token)}&name=${encodeURIComponent(this.name)}`;
    return u.toString();
  }

  #open() {
    if (this.stopped) return;
    if (!this.api.token) { this.#setState('unauthorized'); return; }
    this.#setState(this.everOpened ? 'offline' : 'connecting');
    let opened = false;
    const ws = new WebSocket(this.#url());
    this.ws = ws;
    ws.onopen = () => {
      opened = true;
      this.everOpened = true;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      this.#dispatch(m);
    };
    ws.onclose = async () => {
      if (ws !== this.ws) return;
      this.#setState('offline');
      this.#emit('closed');
      if (this.stopped) return;
      if (!opened) {
        // The browser hides the HTTP status of a failed upgrade, so ask REST whether our token is still valid.
        try {
          await this.api.get('/api/me');
        } catch (e) {
          if (e.status === 401) { this.#setState('unauthorized'); return; }
        }
      }
      this.#scheduleRetry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  #scheduleRetry() {
    clearTimeout(this.retry);
    const base = Math.min(10_000, 350 * 1.7 ** this.attempt++);
    this.retry = setTimeout(() => this.#open(), base * (0.75 + Math.random() * 0.5));
  }

  #reconnectNow() {
    clearTimeout(this.retry);
    if (this.ws && this.ws.readyState <= 1) { if (this.ws.readyState === 1) return; }
    this.#open();
  }

  #raw(msg) {
    if (this.ws?.readyState === 1) { this.ws.send(JSON.stringify(msg)); return true; }
    return false;
  }

  #dispatch(m) {
    switch (m.t) {
      case 'welcome':
        this.clientId = m.clientId;
        this.#setState('online');
        for (const b of this.boards) this.#raw({ t: 'sub', board: b, rev: this.getRev(b) });
        this.#emit('welcome', m);
        // resend anything not acknowledged before the drop; the session re-applies it after the resync replies
        for (const [cid, p] of this.pending) this.#raw({ t: 'ops', board: p.board, cid, ops: p.ops, label: p.label });
        break;
      case 'ack': {
        const p = this.pending.get(m.cid);
        if (p) { this.pending.delete(m.cid); p.resolve(m); this.#emit('outbox', this.pending.size); }
        break;
      }
      case 'nack': {
        const p = m.cid && this.pending.get(m.cid);
        if (p) { this.pending.delete(m.cid); p.reject(Object.assign(new Error(m.error || 'rejected'), { code: m.code })); this.#emit('outbox', this.pending.size); }
        this.#emit('nack', m);
        break;
      }
      default:
        this.#emit(m.t, m);
    }
  }

  sub(board) {
    this.boards.add(board);
    this.#raw({ t: 'sub', board, rev: this.getRev(board) });
  }

  unsub(board) {
    this.boards.delete(board);
    this.#raw({ t: 'unsub', board });
  }

  /** Throw away local state for a board and ask for the server's copy (used after a rejected change). */
  rawResync(board) {
    this.#raw({ t: 'sub', board, rev: -1 });
  }

  /** Queue ops. Resolves when the server has applied them; survives reconnects. */
  sendOps(board, ops, label) {
    const cid = `${this.clientId || 'x'}-${Date.now().toString(36)}-${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(cid, { board, ops, label, resolve, reject });
      this.#emit('outbox', this.pending.size);
      this.#raw({ t: 'ops', board, cid, ops, label });
    });
  }

  pendingList() {
    return [...this.pending.values()].map((p) => ({ board: p.board, ops: p.ops, label: p.label }));
  }

  live(board, patches) { this.#raw({ t: 'live', board, patches }); }
  display(patch) { this.#raw({ t: 'display', patch }); }
  caption(text, role, final) { this.#raw({ t: 'caption', text, role, final }); }
  tts(msg) { this.#raw({ t: 'tts', ...msg }); }
}
