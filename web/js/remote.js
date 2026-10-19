/**
 * Phone-as-remote. The phone shows the board exactly as the TV frames it (same centre, scaled to fit the phone),
 * and any pan/zoom you do here moves the TV. "Overview" zooms out to the whole board with a rectangle showing the
 * TV's view; drag that rectangle (or tap) to jump the TV somewhere else.
 */
export class RemoteController {
  constructor({ session, canvas, ui }) {
    this.s = session;
    this.canvas = canvas;
    this.ui = ui;
    this.overview = false;
    this.pointers = new Map();
    session.camMap = {
      toDisplay: (c) => ({ x: c.x, y: c.y, z: c.z / this.factor() }),
      fromDisplay: (c) => ({ x: c.x, y: c.y, z: c.z * this.factor() }),
    };
    session.on('display', (d) => this.onDisplay(d));
    session.on('selection', (ids) => { if (!this.applyingSel) this.s.net.display({ selection: ids }); });
    session.on('board', () => this.drawRect());
    const prev = session.renderer.onCameraChange;
    session.renderer.onCameraChange = (c) => { prev?.(c); this.drawRect(); };
    canvas.addEventListener('pointerdown', (e) => this.#down(e), true);
    canvas.addEventListener('pointermove', (e) => this.#move(e), true);
    canvas.addEventListener('pointerup', (e) => this.#up(e), true);
    canvas.addEventListener('pointercancel', (e) => this.#up(e), true);
  }

  get tv() { return this.s.display?.viewport || { w: 1920, h: 1080 }; }

  /** phone px per TV px so the TV's whole viewport fits on this screen */
  factor() {
    const c = this.s.camera;
    return Math.min(c.w / this.tv.w, c.h / this.tv.h) * 0.94;
  }

  onDisplay(d) {
    this.applyingSel = true;
    this.s.setSelection((d.selection || []).filter((id) => this.s.model.get(id)));
    this.applyingSel = false;
    this.drawRect();
    if (this.overview) this.#overviewCam();
  }

  drawRect() {
    const d = this.s.display;
    if (!d?.cam) { this.s.renderer.remoteRect = null; return; }
    const v = this.tv;
    // Always show the TV's frame; in mirror mode also dim what the TV can't see (the phone is taller than 16:9).
    this.s.renderer.remoteRect = { x: d.cam.x - v.w / (2 * d.cam.z), y: d.cam.y - v.h / (2 * d.cam.z), w: v.w / d.cam.z, h: v.h / d.cam.z };
    this.s.renderer.remoteDim = !this.overview;
    this.s.renderer.invalidate();
  }

  setOverview(on) {
    this.overview = !!on;
    this.s.input.enabled = !this.overview;
    if (this.overview) this.#overviewCam(); else if (this.s.display?.cam) this.s.camera.animateTo(this.s.camMap.fromDisplay(this.s.display.cam), 350);
    this.drawRect();
  }

  #overviewCam() {
    const box = this.s.model.contentBounds();
    const d = this.s.display;
    if (!box) return;
    const v = this.tv;
    const tvBox = d?.cam ? { x: d.cam.x - v.w / (2 * d.cam.z), y: d.cam.y - v.h / (2 * d.cam.z), w: v.w / d.cam.z, h: v.h / d.cam.z } : box;
    const x1 = Math.min(box.x, tvBox.x); const y1 = Math.min(box.y, tvBox.y);
    const x2 = Math.max(box.x + box.w, tvBox.x + tvBox.w); const y2 = Math.max(box.y + box.h, tvBox.y + tvBox.h);
    const target = this.s.camera.fit({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, { pad: 0.08, maxZoom: 1 });
    this.s.applyingRemote = true;
    this.s.camera.animateTo(target, 300).then(() => { this.s.applyingRemote = false; });
  }

  #pt(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #down(e) {
    if (!this.overview) return;
    e.stopPropagation();
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.#pt(e));
    if (this.pointers.size === 1) this.#jump(this.#pt(e));
    else this.pinch = { d0: this.#dist(), z0: this.s.display?.cam?.z || 1 };
  }

  #move(e) {
    if (!this.overview || !this.pointers.has(e.pointerId)) return;
    e.stopPropagation();
    this.pointers.set(e.pointerId, this.#pt(e));
    if (this.pointers.size >= 2 && this.pinch) {
      const z = Math.min(8, Math.max(0.02, this.pinch.z0 * (this.#dist() / this.pinch.d0)));
      this.#sendCam({ ...this.s.display.cam, z });
    } else this.#jump(this.#pt(e));
  }

  #up(e) {
    if (!this.overview) return;
    e.stopPropagation();
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
  }

  #dist() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  #jump(p) {
    const w = this.s.camera.toWorld(p.x, p.y);
    const cam = this.s.display?.cam || { z: 1 };
    this.#sendCam({ x: w.x, y: w.y, z: cam.z });
  }

  #sendCam(cam) {
    this.s.display = { ...this.s.display, cam };
    this.drawRect();
    this.s.net.display({ cam });
  }
}
