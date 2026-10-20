import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { HttpError, now, log } from './util.js';

const MAX_BODY = 2 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;
const UPSTREAM_PER_MIN = 60; // per widget, after the cache
const LOGS_KEPT = 30;
const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]{1,47})\}\}/g;
const BLOCKED_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'cookie', 'upgrade', 'te', 'trailer', 'proxy-authorization']);

/**
 * The widget side of the server.
 *
 * - Data proxy: widgets cannot reach the network themselves (their sandbox blocks it). They ask the Pi, which fetches
 *   the URL for them. API keys are written in the widget as {{NAME}} and filled in here, only for the host each key
 *   belongs to. Requests into the home network (router, the Pi itself...) are refused. Answers are cached briefly, so
 *   the TV and the phone showing the same widget cost one upstream request.
 * - Reports: each screen running a widget reports "ready" (with the text it shows), errors, and missing keys. The
 *   assistant waits for the first report after writing code, so it can fix mistakes in the same turn.
 */
export class Widgets {
  constructor({ secrets, config }) {
    this.secrets = secrets;
    this.allowPrivate = !!config.widgetAllowPrivate;
    this.cache = new Map();
    this.inflight = new Map();
    this.rate = new Map();
    this.logs = new Map();
    this.events = new EventEmitter();
    this.events.setMaxListeners(200);
  }

  // ------------------------------------------------------------------------------ data proxy

  async fetch({ url, headers = {}, cache = 10, widgetId = '' }) {
    if (typeof url !== 'string' || !url || url.length > 4000) throw new HttpError(400, 'url is required');
    let probe;
    try { probe = new URL(url); } catch { throw new HttpError(400, `Not a valid URL: ${url.slice(0, 120)}`); }
    if (!/^https?:$/.test(probe.protocol)) throw new HttpError(400, 'Only http and https URLs can be fetched');
    if (/\{\{|%7B%7B/i.test(`${probe.username}${probe.password}${probe.host}`)) throw new HttpError(400, 'Keys can go in the path, query or headers, never in the host name');
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new HttpError(400, 'headers must be an object');
    const hdrs = {};
    for (const [k, v] of Object.entries(headers).slice(0, 20)) {
      const key = String(k).toLowerCase().trim();
      if (!/^[a-z0-9-]{1,64}$/.test(key) || BLOCKED_HEADERS.has(key)) continue;
      hdrs[key] = String(v).slice(0, 2000);
    }

    // Fill in {{KEY}} placeholders, only for the host each key is bound to.
    const host = probe.hostname.toLowerCase();
    const used = new Set();
    const fill = (s, encode) => s.replace(PLACEHOLDER, (_, name) => {
      const r = this.secrets.valueFor(name, host);
      if (r.error === 'missing') throw new HttpError(424, `This widget needs the ${name} key. Add it in the O Board app.`, { code: 'needs_key', key: name, host: r.host || null });
      if (r.error === 'wrong_host') throw new HttpError(403, `${name} can only be sent to ${r.host}, not ${host}.`, { code: 'key_wrong_host', key: name });
      used.add(name);
      return encode ? encodeURIComponent(r.value) : r.value;
    });
    const finalUrl = fill(url, true);
    const secretHeaders = new Set();
    for (const [k, v] of Object.entries(hdrs)) {
      const filled = fill(v, false);
      if (filled !== v) secretHeaders.add(k);
      hdrs[k] = filled;
    }
    // (Local test/dev mode, where widgets may reach private addresses, also allows plain-http fakes of real APIs.)
    if (used.size && probe.protocol !== 'https:' && !this.allowPrivate) throw new HttpError(400, 'API keys are only sent over https');
    if (new URL(finalUrl).hostname.toLowerCase() !== host) throw new HttpError(400, 'The URL changed host after filling in keys');

    const ttl = Math.max(0, Math.min(3600, Number(cache) || 0)) * 1000;
    const key = `${finalUrl}\n${JSON.stringify(hdrs)}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires > now()) return { ...hit.value, cached: true };
    if (this.inflight.has(key)) return this.inflight.get(key);

    this.#rateLimit(widgetId || 'anon');
    const p = this.#request(finalUrl, hdrs, secretHeaders)
      .then((value) => {
        if (ttl) this.cache.set(key, { value, expires: now() + ttl });
        if (this.cache.size > 300) for (const [k, v] of this.cache) if (v.expires <= now() || this.cache.size > 250) this.cache.delete(k);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  #rateLimit(id) {
    const t = now();
    const r = this.rate.get(id);
    if (!r || r.reset < t) { this.rate.set(id, { n: 1, reset: t + 60_000 }); return; }
    if (++r.n > UPSTREAM_PER_MIN) throw new HttpError(429, `Too many requests from this widget (over ${UPSTREAM_PER_MIN} a minute). Refresh less often or use the cache option.`, { code: 'rate_limited' });
  }

  async #request(url, headers, secretHeaders, hops = 0) {
    const u = new URL(url);
    if (net.isIP(u.hostname) && !this.allowPrivate && isPrivateAddress(u.hostname)) {
      throw new HttpError(403, 'Widgets cannot reach addresses inside the home network', { code: 'blocked_address' });
    }
    const lib = u.protocol === 'https:' ? https : http;
    const res = await new Promise((resolve, reject) => {
      const req = lib.request(u, {
        method: 'GET',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; OBoard/0.1; +widgets)', accept: 'application/json, text/*;q=0.9, */*;q=0.5', 'accept-encoding': 'gzip, deflate, br', ...headers },
        timeout: TIMEOUT_MS,
        lookup: (hostname, options, cb) => this.#lookup(hostname, options, cb),
      }, resolve);
      req.on('timeout', () => req.destroy(new HttpError(504, `${u.hostname} did not answer in time`, { code: 'upstream_timeout' })));
      req.on('error', reject);
      req.end();
    }).catch((e) => {
      if (e instanceof HttpError) throw e;
      if (e.code === 'BLOCKED_ADDRESS') throw new HttpError(403, 'Widgets cannot reach addresses inside the home network', { code: 'blocked_address' });
      throw new HttpError(502, `Could not reach ${u.hostname}: ${e.code || e.message}`, { code: 'upstream_unreachable' });
    });

    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      if (hops >= MAX_REDIRECTS) throw new HttpError(502, 'Too many redirects', { code: 'upstream_redirects' });
      const next = new URL(res.headers.location, u);
      const sameHost = next.hostname.toLowerCase() === u.hostname.toLowerCase();
      const nextHeaders = sameHost ? headers : Object.fromEntries(Object.entries(headers).filter(([k]) => !secretHeaders.has(k)));
      return this.#request(next.toString(), nextHeaders, sameHost ? secretHeaders : new Set(), hops + 1);
    }

    const enc = String(res.headers['content-encoding'] || '').toLowerCase();
    const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
    const chunks = [];
    let size = 0;
    for await (const c of stream) {
      size += c.length;
      if (size > MAX_BODY) { res.destroy(); throw new HttpError(502, 'The answer was larger than 2 MB', { code: 'upstream_too_large' }); }
      chunks.push(c);
    }
    const contentType = String(res.headers['content-type'] || '');
    if (/^(image|audio|video)\/|octet-stream/.test(contentType)) throw new HttpError(415, `Widgets can read text and JSON, not ${contentType}`, { code: 'upstream_binary' });
    return { status: res.statusCode, ok: res.statusCode < 400, contentType, body: Buffer.concat(chunks).toString('utf8') };
  }

  #lookup(hostname, options, cb) {
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err);
      const ok = this.allowPrivate ? addrs : addrs.filter((a) => !isPrivateAddress(a.address));
      if (!ok.length) {
        const e = new Error(`blocked address for ${hostname}`);
        e.code = 'BLOCKED_ADDRESS';
        return cb(e);
      }
      if (options?.all) return cb(null, ok);
      return cb(null, ok[0].address, ok[0].family);
    });
  }

  // ------------------------------------------------------------------------------ reports

  report({ boardId, widgetId, level, message = '', hash = '', text = '', client = '' }) {
    if (!['ready', 'error', 'needs_key', 'log'].includes(level)) throw new HttpError(400, 'Unknown report level');
    const list = this.logs.get(widgetId) || [];
    const t = now();
    if (list.filter((e) => e.ts > t - 60_000).length >= 40) return null; // a looping widget should not flood the log
    const entry = {
      ts: t, boardId, level, message: String(message).slice(0, 600), hash: String(hash).slice(0, 16), text: String(text).replace(/\s+/g, ' ').trim().slice(0, 400), client: String(client).slice(0, 60),
    };
    list.push(entry);
    while (list.length > LOGS_KEPT) list.shift();
    this.logs.set(widgetId, list);
    this.events.emit('report', widgetId, entry);
    if (level === 'error') log('info', 'widget error', { widgetId, message: entry.message.slice(0, 160) });
    return entry;
  }

  recent(widgetId, n = 12) {
    return (this.logs.get(widgetId) || []).slice(-n);
  }

  /** Latest meaningful state of a widget: running / error / waiting for a key. */
  status(widgetId) {
    const last = [...(this.logs.get(widgetId) || [])].reverse().find((e) => e.level !== 'log');
    if (!last) return null;
    return { level: last.level, message: last.message, text: last.text, hash: last.hash, ts: last.ts };
  }

  /** Resolves with the first report for this exact code version (or null after `ms`). */
  waitForReport(widgetId, hash, ms) {
    return new Promise((resolve) => {
      const done = (entry) => {
        clearTimeout(timer);
        this.events.off('report', on);
        resolve(entry);
      };
      const on = (id, entry) => { if (id === widgetId && entry.level !== 'log' && (!hash || entry.hash === hash)) done(entry); };
      const timer = setTimeout(() => done(null), ms);
      this.events.on('report', on);
    });
  }
}

/** Loopback, private, link-local, carrier-grade NAT (also Tailscale), multicast and reserved ranges. */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd)/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x);
  }
  return true;
}
