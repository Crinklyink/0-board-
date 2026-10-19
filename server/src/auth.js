import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { rid, now, sha256Hex, HttpError, log } from './util.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const ROLES = new Set(['phone', 'display', 'web']);

/**
 * Device auth.
 * - Every client holds a random 256-bit bearer token; only its SHA-256 is stored.
 * - New devices pair with a short-lived 8-digit code that the TV (or an already-paired phone) displays.
 * - The Pi's own kiosk browser gets a "display" token created at first start (data/display.token, mode 0600).
 */
export class Auth {
  constructor(db, dataDir) {
    this.db = db;
    this.dataDir = dataDir;
    this.codes = new Map(); // code -> expiresAt
    this.attempts = new Map(); // ip -> {n, reset}
    this.failures = [];
    this.touchCache = new Map();
    this.serverId = this.#ensureServerId();
  }

  #ensureServerId() {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'server_id'`).get();
    if (row) return row.value;
    const id = rid('sv_', 12);
    this.db.prepare(`INSERT INTO meta(key, value) VALUES ('server_id', ?)`).run(id);
    return id;
  }

  /** Make sure the TV kiosk has a device token. Returns it so start scripts can read data/display.token. */
  ensureDisplayToken() {
    const file = path.join(this.dataDir, 'display.token');
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
    if (existing) {
      const dev = this.authenticate(existing);
      if (dev) return existing;
    }
    const { token } = this.createDevice({ name: 'TV display', role: 'display' });
    fs.writeFileSync(file, token + '\n', { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
    return token;
  }

  createDevice({ name, role }) {
    if (!ROLES.has(role)) throw new HttpError(400, 'Unknown device role');
    const token = crypto.randomBytes(32).toString('base64url');
    const id = rid('dv_', 10);
    this.db.prepare('INSERT INTO devices(id, name, role, token_hash, created_at, last_seen) VALUES (?,?,?,?,?,?)')
      .run(id, String(name || 'Device').slice(0, 60), role, sha256Hex(token), now(), now());
    return { device: { id, name, role }, token };
  }

  authenticate(token) {
    if (!token || token.length < 20 || token.length > 100) return null;
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked = 0').get(sha256Hex(token));
    if (!row) return null;
    const t = now();
    if ((this.touchCache.get(row.id) || 0) < t - 60_000) {
      this.touchCache.set(row.id, t);
      this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(t, row.id);
    }
    return { id: row.id, name: row.name, role: row.role };
  }

  newPairingCode() {
    this.#sweep();
    let code;
    do {
      code = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
    } while (this.codes.has(code));
    const expiresAt = now() + CODE_TTL_MS;
    this.codes.set(code, expiresAt);
    return { code, expiresAt };
  }

  redeem(code, { name, role = 'phone', ip = '?' }) {
    this.#throttle(ip);
    const clean = String(code || '').replace(/\D/g, '');
    this.#sweep();
    const exp = this.codes.get(clean);
    if (!exp || exp < now()) {
      this.#fail(ip);
      throw new HttpError(403, 'That pairing code is wrong or has expired');
    }
    this.codes.delete(clean); // single use
    if (role === 'display') role = 'phone'; // only the installer can mint display tokens
    const out = this.createDevice({ name, role });
    log('info', 'device paired', { id: out.device.id, role, name: out.device.name });
    return out;
  }

  listDevices() {
    return this.db.prepare('SELECT id, name, role, created_at, last_seen, revoked FROM devices WHERE revoked = 0 ORDER BY created_at').all()
      .map((r) => ({ id: r.id, name: r.name, role: r.role, createdAt: r.created_at, lastSeen: r.last_seen }));
  }

  revoke(id) {
    const r = this.db.prepare('UPDATE devices SET revoked = 1 WHERE id = ? AND role != ?').run(id, 'display');
    return r.changes > 0;
  }

  hasPairedPhone() {
    return !!this.db.prepare(`SELECT 1 FROM devices WHERE role != 'display' AND revoked = 0 LIMIT 1`).get();
  }

  #sweep() {
    const t = now();
    for (const [c, exp] of this.codes) if (exp < t) this.codes.delete(c);
  }

  #throttle(ip) {
    const t = now();
    const a = this.attempts.get(ip);
    if (!a || a.reset < t) {
      this.attempts.set(ip, { n: 1, reset: t + 5 * 60_000 });
      return;
    }
    a.n++;
    if (a.n > 8) throw new HttpError(429, 'Too many pairing attempts; wait a few minutes');
  }

  #fail(ip) {
    const t = now();
    this.failures = this.failures.filter((x) => x > t - 10 * 60_000);
    this.failures.push(t);
    if (this.failures.length >= 25) {
      // Someone is guessing: burn every outstanding code.
      this.codes.clear();
      this.failures = [];
      log('warn', 'pairing codes revoked after repeated failures', { ip });
    }
  }
}
