import crypto from 'node:crypto';

export const now = () => Date.now();

/** Short random id with an optional prefix, URL/JSON safe. */
export function rid(prefix = '', n = 10) {
  return prefix + crypto.randomBytes(Math.ceil(n * 0.75) + 2).toString('base64url').replace(/[-_]/g, 'x').slice(0, n);
}

export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 20;

export function log(level, msg, extra = {}) {
  if ((LEVELS[level] ?? 20) < MIN) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function safeJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Constant-time string compare. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });
}
