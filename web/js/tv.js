import qrcode from '../vendor/qrcode.mjs';

/**
 * Everything specific to the TV display: it follows the shared display state (board, camera, selection, focus,
 * presentation slide), shows the pairing card until a phone is paired, and (beta) plays assistant speech sent by the phone.
 */
export class TvController {
  constructor({ session, ui, api, cfg, root }) {
    Object.assign(this, { s: session, ui, api, cfg, root });
    this.slide = -1;
    this.mode = 'normal';
    this.pairEl = document.createElement('div');
    this.pairEl.className = 'pair-card';
    this.pairEl.hidden = true;
    root.append(this.pairEl);
    this.label = document.createElement('div');
    this.label.className = 'tv-label';
    root.append(this.label);

    session.on('display', (d) => this.onDisplay(d));
    session.on('presence', () => this.checkPairing());
    session.on('tts', (m) => this.#audio(m));
    session.on('board', () => this.flashLabel());
    session.on('status', (st) => { this.root.dataset.conn = st; });
    // Everything on the TV chrome is sized for a couch: scale with the screen, from 1080p (x1.15) up to 4K (x2.3).
    const fit = () => { document.documentElement.style.setProperty('--tvz', String(Math.min(2.4, Math.max(0.62, innerWidth / 1700)))); };
    fit();
    addEventListener('resize', () => { fit(); this.reportViewport(); });
    addEventListener('keydown', (e) => this.#key(e));
    ui.onBoardLabel = () => this.flashLabel();
    setInterval(() => this.checkPairing(), 5000);
  }

  reportViewport() {
    this.s.net.display({ viewport: { w: this.s.camera.w, h: this.s.camera.h } });
  }

  onDisplay(d) {
    this.s.followDisplay(d);
    const r = this.s.renderer;
    r.highlightIds = new Set(d.selection || []);
    r.focusIds = d.mode === 'focus' && d.focusIds?.length ? new Set(d.focusIds) : null;
    r.invalidate();
    if (d.mode === 'present') {
      if (d.slide !== this.slide || this.mode !== 'present') { this.slide = d.slide; this.gotoSlide(d.slide); }
    } else if (this.mode === 'present') {
      this.slide = -1;
    }
    this.mode = d.mode;
  }

  slides() {
    return this.s.model.list().filter((o) => o.type === 'frame')
      .sort((a, b) => Math.round(a.y / 200) - Math.round(b.y / 200) || a.x - b.x || (a.title || '').localeCompare(b.title || '', undefined, { numeric: true }));
  }

  gotoSlide(i) {
    const frames = this.slides();
    if (!frames.length) return;
    const f = frames[((i % frames.length) + frames.length) % frames.length];
    const target = this.s.camera.fit(this.s.model.box(f), { pad: 0.05, maxZoom: 2 });
    this.s.camera.animateTo(target, 600).then(() => this.s.pushCamera());
  }

  #key(e) {
    if (e.target?.tagName === 'INPUT') return;
    if (this.mode === 'present' && ['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) { this.s.net.display({ slide: (this.slide + 1) }); e.preventDefault(); }
    else if (this.mode === 'present' && ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { this.s.net.display({ slide: Math.max(0, this.slide - 1) }); e.preventDefault(); }
    else if (e.key === 'p' || e.key === 'P') this.checkPairing(true);
    else if (e.key === 'Escape') { this.s.net.display({ mode: 'normal', selection: [] }); this.pairEl.hidden = true; }
  }

  flashLabel() {
    const name = this.s.model.board?.name || this.ui.boardName;
    if (!name) return;
    this.label.textContent = name;
    this.label.classList.add('on');
    clearTimeout(this.labelTimer);
    this.labelTimer = setTimeout(() => this.label.classList.remove('on'), 3200);
  }

  // ------------------------------------------------------------------------------------ pairing

  async checkPairing(force = false) {
    try {
      const info = await this.api.get('/api/info');
      const phones = this.s.clients.some((c) => c.role !== 'display');
      const need = force || !info.paired;
      if (!need) { this.pairEl.hidden = true; return; }
      if (!this.pairEl.hidden && !force && this.pairCode && Date.now() < this.pairCode.expiresAt - 60_000) return;
      const p = await this.api.get('/api/pair/new');
      this.pairCode = p;
      this.renderPair(p, info, phones);
    } catch { /* offline: leave as is */ }
  }

  renderPair(p, info) {
    const host = p.addresses[0] || location.hostname;
    const uri = `oboard://pair?h=${encodeURIComponent(`${host}:${p.port}`)}&c=${p.code}&s=${p.serverId}`;
    const qr = qrcode(0, 'M');
    qr.addData(uri);
    qr.make();
    const code = `${p.code.slice(0, 4)} ${p.code.slice(4)}`;
    this.pairEl.innerHTML = `
      <div class="pair-qr"><img alt="QR code to pair your phone" src="${qr.createDataURL(8, 2)}"></div>
      <div class="pair-body">
        <div class="pair-title">Pair your phone</div>
        <div class="pair-step">Open the O Board app and choose <b>Pair with TV</b>.</div>
        <div class="pair-code" aria-label="Pairing code">${code}</div>
        <div class="pair-addr">${p.addresses.map((a) => `${a}:${p.port}`).join('  ·  ') || p.hostname}</div>
        ${info.gemini ? '' : '<div class="pair-warn">Gemini key not set on the Pi. Voice and AI will wait until it is.</div>'}
      </div>`;
    this.pairEl.hidden = false;
  }

  // ------------------------------------------------------------------------- speaker (beta)

  #audio(m) {
    if (m.stop) { this.#stopAudio(); return; }
    if (!m.data) return;
    try {
      this.ac ||= new AudioContext({ sampleRate: m.rate || 24000 });
      if (this.ac.state === 'suspended') this.ac.resume();
      const bin = atob(m.data);
      const n = bin.length >> 1;
      const buf = this.ac.createBuffer(1, n, m.rate || 24000);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) { const v = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16; ch[i] = v / 32768; }
      const src = this.ac.createBufferSource();
      src.buffer = buf;
      src.connect(this.ac.destination);
      const t = Math.max(this.ac.currentTime + 0.04, this.nextAt || 0);
      src.start(t);
      this.nextAt = t + buf.duration;
      (this.playing ||= new Set()).add(src);
      src.onended = () => this.playing.delete(src);
    } catch (e) { console.warn('tv audio', e); }
  }

  #stopAudio() {
    for (const s of this.playing || []) { try { s.stop(); } catch { /* already stopped */ } }
    this.playing?.clear();
    this.nextAt = 0;
  }
}
