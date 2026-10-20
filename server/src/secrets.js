import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { now, log } from './util.js';

const NAME_RE = /^[A-Z][A-Z0-9_]{1,47}$/;
const HOST_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export class SecretError extends Error {}

/**
 * API keys for widgets (stock prices, weather...). They live in their own file next to the database, readable only by
 * the server, and are never part of backups, exports, API responses, the board or anything sent to Gemini.
 *
 * Each key is bound to one host (e.g. finnhub.io). The widget data proxy only ever puts a key into requests to that
 * host, so widget code, even if written badly or maliciously, cannot send the key anywhere else.
 * An entry without a value is an open request ("please add a Finnhub key") made by the assistant.
 */
export class Secrets {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'secrets.json');
    this.items = new Map();
    this.#load();
  }

  static validName(name) { return typeof name === 'string' && NAME_RE.test(name); }

  static normalizeHost(host) {
    const h = String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '').replace(/^www\./, '');
    if (!HOST_RE.test(h) && !net.isIPv4(h)) throw new SecretError(`"${host}" is not a valid host name (example: api.example.com)`);
    return h;
  }

  #load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    try {
      for (const e of JSON.parse(raw).secrets || []) if (Secrets.validName(e.name)) this.items.set(e.name, e);
    } catch (e) {
      log('error', 'secrets file unreadable; starting empty', { error: e.message });
    }
  }

  #save() {
    const tmp = `${this.file}.tmp`;
    const body = JSON.stringify({ secrets: [...this.items.values()] }, null, 1);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* windows */ }
  }

  /** Public view: never includes values. */
  list() {
    return [...this.items.values()]
      .map(({ name, host, service, signupUrl, why, value, createdAt, updatedAt, requestedAt }) => ({
        name, host, service: service || '', signupUrl: signupUrl || '', why: why || '', set: !!value, createdAt, updatedAt: updatedAt || null, requestedAt: requestedAt || null,
      }))
      .sort((a, b) => Number(a.set) - Number(b.set) || a.name.localeCompare(b.name));
  }

  has(name) { return !!this.items.get(name)?.value; }
  info(name) { return this.list().find((s) => s.name === name) || null; }

  /** The assistant asks for a key. Keeps an existing value; refreshes the description. */
  request({ name, host, service = '', signupUrl = '', why = '' }) {
    if (!Secrets.validName(name)) throw new SecretError('Key names look like FINNHUB_KEY: capital letters, digits and _');
    const h = Secrets.normalizeHost(host);
    const cur = this.items.get(name);
    if (cur?.value && cur.host !== h) throw new SecretError(`${name} already exists for ${cur.host}. Use a different name for ${h}.`);
    const t = now();
    const next = {
      ...(cur || { createdAt: t }), name, host: h, service: String(service).slice(0, 80), signupUrl: safeUrl(signupUrl), why: String(why).slice(0, 300), requestedAt: t,
    };
    this.items.set(name, next);
    this.#save();
    return this.info(name);
  }

  /** The user saves a key from the app. */
  set(name, { value, host, service }) {
    if (!Secrets.validName(name)) throw new SecretError('Key names look like FINNHUB_KEY: capital letters, digits and _');
    const v = String(value ?? '').trim();
    if (!v || v.length > 4000 || /[\r\n]/.test(v)) throw new SecretError('Paste the key on one line');
    const cur = this.items.get(name);
    const h = host ? Secrets.normalizeHost(host) : cur?.host;
    if (!h) throw new SecretError('Say which website this key is for (its host, e.g. finnhub.io)');
    const t = now();
    this.items.set(name, { ...(cur || { createdAt: t }), name, host: h, service: service ? String(service).slice(0, 80) : cur?.service || '', value: v, updatedAt: t });
    this.#save();
    log('info', 'api key saved', { name, host: h });
    return this.info(name);
  }

  delete(name) {
    const ok = this.items.delete(name);
    if (ok) this.#save();
    return ok;
  }

  /** Only for the widget proxy: the value, if the request is going to the host this key belongs to. */
  valueFor(name, requestHost) {
    const e = this.items.get(name);
    if (!e) return { error: 'missing' };
    if (!e.value) return { error: 'missing', host: e.host };
    const host = String(requestHost || '').toLowerCase().replace(/^www\./, '');
    if (host !== e.host && !host.endsWith(`.${e.host}`)) return { error: 'wrong_host', host: e.host };
    return { value: e.value, host: e.host };
  }
}

function safeUrl(u) {
  try {
    const x = new URL(String(u || ''));
    return /^https?:$/.test(x.protocol) ? x.toString().slice(0, 300) : '';
  } catch { return ''; }
}
