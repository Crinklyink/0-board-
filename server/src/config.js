import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/** Minimal .env loader (no dependency). Real environment variables always win. */
function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

loadEnvFile(path.join(root, '.env'));
loadEnvFile('/etc/oboard/oboard.env');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const env = process.env;

export const config = {
  version: pkg.version,
  port: Number(env.PORT || 8080),
  host: env.HOST || '0.0.0.0',
  // Relative paths in env files resolve against the server folder, not whatever directory the process started in.
  dataDir: path.resolve(root, env.DATA_DIR || 'data'),
  // The web client has no build step: the server serves ../web directly (and the Android app bundles a copy).
  webDir: path.resolve(root, env.WEB_DIR || path.join('..', 'web')),
  gemini: {
    // The key only ever lives here, on the server. It is never sent to clients.
    apiKey: env.GEMINI_API_KEY || '',
    baseUrl: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, ''),
    // Where the phone should open the Live WebSocket. Overridable so tests can point at a local fake.
    liveWsBase: (env.GEMINI_LIVE_WS_BASE || 'wss://generativelanguage.googleapis.com').replace(/\/$/, ''),
  },
  defaults: {
    textModel: env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash',
    liveModel: env.GEMINI_LIVE_MODEL || 'gemini-3.8-live',
    thinkingLevel: env.GEMINI_THINKING_LEVEL || 'low',
    liveVoice: env.GEMINI_LIVE_VOICE || 'Kore',
  },
  // Extra addresses to tell paired phones about (comma-separated), e.g. a reverse proxy or a custom DNS name.
  // The Pi's own network addresses, including Tailscale, are found automatically.
  publicUrls: (env.PUBLIC_URLS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter((s) => /^https?:\/\/\S+$/.test(s)),
  maxUploadBytes: Number(env.MAX_UPLOAD_MB || 40) * 1024 * 1024,
  backupEveryHours: Number(env.BACKUP_EVERY_HOURS || 6),
  backupKeep: Number(env.BACKUP_KEEP || 14),
  tz: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
};
