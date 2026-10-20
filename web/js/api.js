// Config resolution + REST client. The same code runs on the TV, in a desktop browser, and inside the Android WebView.

const LS = (() => {
  try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return localStorage; } catch { return null; }
})();

export const store = {
  get: (k) => { try { return LS?.getItem(k) ?? null; } catch { return null; } },
  set: (k, v) => { try { LS?.setItem(k, v); } catch { /* storage full or blocked */ } },
  del: (k) => { try { LS?.removeItem(k); } catch { /* ignore */ } },
};

export function loadConfig() {
  const q = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  let host = q.get('host') || '';
  const embedded = !!window.OBoardHost;
  if (!host) host = location.origin;
  host = host.replace(/\/$/, '');

  const tokenKey = `oboard.token@${host}`;
  let token = hash.get('t');
  if (token) {
    store.set(tokenKey, token);
    history.replaceState(null, '', location.pathname + location.search); // keep the token out of the address bar / history
  } else {
    token = store.get(tokenKey) || '';
  }
  if (!token && embedded) {
    try { token = JSON.parse(window.OBoardHost.getConfig()).token || ''; } catch { /* no host config */ }
  }

  const mode = q.get('mode') || 'edit'; // tv | edit | remote
  return {
    host,
    token,
    tokenKey,
    mode,
    board: q.get('board') || hash.get('board') || '',
    chrome: q.get('chrome') || (mode === 'tv' ? 'none' : embedded ? 'min' : 'full'),
    dpr: Number(q.get('dpr')) || 0,
    embedded,
    name: q.get('name') || (mode === 'tv' ? 'TV display' : embedded ? 'Phone canvas' : 'Web'),
  };
}

export class Api {
  constructor(cfg) {
    this.cfg = cfg;
  }

  get base() { return this.cfg.host; }
  set token(t) { this.cfg.token = t; store.set(this.cfg.tokenKey, t); }
  get token() { return this.cfg.token; }

  async request(method, path, body, { raw = false, headers = {}, signal } = {}) {
    const res = await fetch(this.base + path, {
      method,
      signal,
      headers: {
        ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
        ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (!res.ok) {
      const err = new Error(json?.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = json?.code;
      err.body = json;
      throw err;
    }
    return json;
  }

  get(path) { return this.request('GET', path); }
  post(path, body = {}) { return this.request('POST', path, body); }
  put(path, body = {}) { return this.request('PUT', path, body); }
  patch(path, body = {}) { return this.request('PATCH', path, body); }
  del(path) { return this.request('DELETE', path); }

  async pair(code, name) {
    const r = await this.request('POST', '/api/pair', { code, name, role: 'web' });
    this.token = r.token;
    return r;
  }

  async upload(blob, filename = 'file') {
    const r = await this.request('POST', '/api/assets', blob, {
      raw: true,
      headers: { 'content-type': blob.type || 'application/octet-stream', 'x-filename': encodeURIComponent(filename) },
    });
    return r.asset;
  }
}

/** Downscale big photos before upload: faster sync, less Pi storage, and Gemini does not need 12 MP. */
export async function prepareImage(file, maxSide = 2048) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) { bmp.close?.(); return file; }
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const type = file.type === 'image/png' && file.size < 4 * 1024 * 1024 ? 'image/png' : 'image/jpeg';
    return await c.convertToBlob({ type, quality: 0.86 });
  } catch {
    return file;
  }
}
