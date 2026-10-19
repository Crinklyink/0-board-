import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { Store } from './store.js';
import { Auth } from './auth.js';
import { Hub } from './hub.js';
import { Assets } from './assets.js';
import { Settings } from './settings.js';
import { Gemini } from './gemini.js';
import { Agent } from './ai/agent.js';
import { LiveService } from './ai/live.js';
import { Pending } from './ai/pending.js';
import { Backups } from './backup.js';
import { createApp } from './http.js';
import { log } from './util.js';

/** Build the whole server. Exported so tests can start isolated instances on random ports with a temp data dir. */
export async function createServer(overrides = {}) {
  const cfg = {
    ...config,
    ...overrides,
    gemini: { ...config.gemini, ...(overrides.gemini || {}) },
    defaults: { ...config.defaults, ...(overrides.defaults || {}) },
  };
  const { db } = openDb(cfg.dataDir);
  const store = new Store(db);
  store.ensureDefaults();
  const auth = new Auth(db, cfg.dataDir);
  const displayToken = auth.ensureDisplayToken();
  const assets = new Assets(db, cfg.dataDir);
  const settings = new Settings(db, cfg);
  const gemini = new Gemini(cfg);
  const hub = new Hub({ store, auth, config: cfg });
  const pending = new Pending(hub);
  const deps = { store, auth, hub, assets, settings, gemini, pending, config: cfg };
  const backups = new Backups({ db, dataDir: cfg.dataDir, config: cfg });
  const agent = new Agent({ ...deps });
  const live = new LiveService({ ...deps });
  const handler = createApp({ ...deps, agent, live, backups });

  const server = http.createServer(handler);
  server.headersTimeout = 20_000;
  server.requestTimeout = 0; // uploads and the backup stream can be long; bodies are size-limited instead
  hub.attach(server);

  const api = {
    cfg, db, store, auth, hub, assets, settings, gemini, pending, agent, live, backups, server, displayToken,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, resolve);
      });
      return server.address().port;
    },
    async close() {
      backups.stop();
      hub.close();
      await new Promise((resolve) => server.close(resolve));
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
      db.close();
    },
  };
  return api;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = await createServer();
  const port = await app.listen();
  app.backups.start();
  log('info', 'O Board server up', {
    version: config.version, port, host: config.host, data: config.dataDir, web: config.webDir,
    gemini: app.gemini.configured ? 'configured' : 'NOT configured (set GEMINI_API_KEY)',
    textModel: app.settings.get().textModel, liveModel: app.settings.get().liveModel,
  });

  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    log('info', 'shutting down', { sig });
    const t = setTimeout(() => process.exit(1), 8000);
    t.unref();
    try { await app.close(); } finally { process.exit(0); }
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('unhandledRejection', (e) => log('error', 'unhandled rejection', { error: String(e?.stack || e) }));
  process.on('uncaughtException', (e) => {
    log('error', 'uncaught exception', { error: String(e?.stack || e) });
    process.exit(1); // systemd restarts us; WAL guarantees the database is consistent
  });
}
