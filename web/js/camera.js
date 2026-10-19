// Camera = the world point at the centre of the viewport, plus zoom (screen px per world unit).
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;

export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.z = 1;
    this.w = 800; // viewport css px
    this.h = 600;
    this.anim = null;
    this.onChange = null;
  }

  set(x, y, z, silent = false) {
    this.x = x;
    this.y = y;
    this.z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    if (!silent) this.onChange?.(this);
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.onChange?.(this);
  }

  toScreen(wx, wy) {
    return { x: (wx - this.x) * this.z + this.w / 2, y: (wy - this.y) * this.z + this.h / 2 };
  }

  toWorld(sx, sy) {
    return { x: (sx - this.w / 2) / this.z + this.x, y: (sy - this.h / 2) / this.z + this.y };
  }

  /** Pan by a screen-space delta. */
  panBy(dx, dy) {
    this.set(this.x - dx / this.z, this.y - dy / this.z, this.z);
  }

  /** Zoom by a factor keeping the world point under (sx, sy) fixed. */
  zoomAt(factor, sx, sy) {
    const before = this.toWorld(sx, sy);
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.z * factor));
    this.z = z;
    const after = this.toWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.onChange?.(this);
  }

  view() {
    const hw = this.w / 2 / this.z;
    const hh = this.h / 2 / this.z;
    return { x: this.x - hw, y: this.y - hh, w: hw * 2, h: hh * 2 };
  }

  fit(box, { pad = 0.12, maxZoom = 1.5 } = {}) {
    if (!box || !box.w || !box.h) return { x: 0, y: 0, z: 1 };
    const z = Math.min(maxZoom, Math.max(MIN_ZOOM, Math.min(this.w / (box.w * (1 + pad * 2)), this.h / (box.h * (1 + pad * 2)))));
    return { x: box.x + box.w / 2, y: box.y + box.h / 2, z };
  }

  /** Smoothly move to a target camera. Cancels any running animation. */
  animateTo(target, ms = 380) {
    this.cancelAnim();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || ms <= 0) {
      this.set(target.x, target.y, target.z);
      return Promise.resolve();
    }
    const from = { x: this.x, y: this.y, z: this.z };
    const start = performance.now();
    return new Promise((resolve) => {
      const anim = { cancelled: false, resolve };
      this.anim = anim;
      const tick = (now) => {
        if (anim.cancelled) return resolve();
        const t = Math.min(1, (now - start) / ms);
        const e = 1 - (1 - t) ** 3;
        // interpolate zoom in log space so big zoom changes feel even
        const z = Math.exp(Math.log(from.z) + (Math.log(target.z) - Math.log(from.z)) * e);
        this.set(from.x + (target.x - from.x) * e, from.y + (target.y - from.y) * e, z);
        if (t < 1) requestAnimationFrame(tick);
        else { this.anim = null; resolve(); }
      };
      requestAnimationFrame(tick);
    });
  }

  cancelAnim() {
    if (this.anim) {
      this.anim.cancelled = true;
      this.anim = null;
    }
  }
}
