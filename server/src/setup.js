import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './util.js';

// Server credentials are deliberately separate from widget keys, SQLite, exports and backups.
export class Setup {
  constructor(config) {
    this.config = config;
    this.revision = 0;
    this.file = path.join(config.dataDir, 'server-credentials.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof saved.geminiApiKey === 'string' && saved.geminiApiKey) config.gemini.apiKey = saved.geminiApiKey;
    } catch (e) { if (e.code !== 'ENOENT') throw new Error('Cannot read server credentials; check server-credentials.json'); }
  }

  saveGeminiKey(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4000 || /\s/.test(value.trim())) {
      throw new HttpError(400, 'Paste a valid API key on one line');
    }
    const key = value.trim();
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ geminiApiKey: key })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows permissions are inherited. */ }
    this.config.gemini.apiKey = key;
    this.invalidateTests();
  }

  invalidateTests() { this.lastTest = null; this.revision++; }

  report({ store, hub, backups, gemini, settings }) {
    const checks = [];
    const add = (id, name, status, detail, action = '') => checks.push({ id, name, status, detail, action });
    add('server', 'Pi server', 'pass', `O Board ${this.config.version} is responding.`);
    const integrity = Object.values(store.db.prepare('PRAGMA quick_check').get())[0];
    add('database', 'Board database', integrity === 'ok' ? 'pass' : 'fail', integrity === 'ok' ? 'Database integrity check passed.' : 'The database needs attention.', integrity === 'ok' ? '' : 'Restore a known-good backup on the Pi.');
    try {
      const disk = fs.statfsSync(this.config.dataDir);
      const freeMB = Math.floor(disk.bavail * disk.bsize / 1048576);
      add('storage', 'Free storage', freeMB >= 512 ? 'pass' : 'warn', `${freeMB.toLocaleString('en-US')} MB available.`, freeMB >= 512 ? '' : 'Free space on the Pi before adding large files or models.');
    } catch { add('storage', 'Free storage', 'warn', 'Storage information is unavailable.', 'Check free disk space on the Pi.'); }
    const tv = hub.connected().some((c) => c.role === 'display');
    add('tv', 'TV display', tv ? 'pass' : 'warn', tv ? 'A TV display is connected.' : 'No TV display is connected.', tv ? '' : 'Turn on the TV and check the kiosk service on the Pi.');
    add('gemini', 'Gemini API key', gemini.configured ? 'pass' : 'warn', gemini.configured ? 'A key is configured on the Pi.' : 'The assistant needs an API key.', gemini.configured ? 'Run Test Gemini connection to check access.' : 'Add a Gemini API key below.');
    if (this.lastTest) checks.push(...this.lastTest.checks);
    const newest = backups.list()[0];
    const recent = newest && Date.now() - newest.mtime < 24 * 3600000;
    add('backup', 'Recent backup', recent ? 'pass' : 'warn', newest ? `Last backup: ${new Date(newest.mtime).toISOString()}` : 'No database backup found.', recent ? '' : 'Create a backup in Settings → Backup & export.');
    return { version: this.config.version, checkedAt: Date.now(), checks, textModel: settings.get().textModel, liveModel: settings.get().liveModel };
  }

  async testGemini(gemini, settings) {
    const revision = this.revision;
    const selected = settings.get();
    const checks = [];
    try {
      if (!gemini.configured) throw new HttpError(400, 'No key');
      const models = await gemini.listModels(AbortSignal.timeout(10000));
      const s = selected;
      for (const [kind, model, method] of [['Text', s.textModel, 'generateContent'], ['Live voice', s.liveModel, 'bidiGenerateContent']]) {
        const available = models.some((m) => m.name === model && m.methods.includes(method));
        checks.push({ id: `gemini-${kind === 'Text' ? 'text' : 'live'}`, name: `${kind} model access`, status: available ? 'pass' : 'warn',
          detail: available ? `${model} is available to this key.` : `${model} was not listed for this key.`, action: available ? '' : 'Choose an available model in Assistant settings.' });
      }
      checks.unshift({ id: 'gemini-api', name: 'Gemini connection', status: 'pass', detail: 'Google accepted the key and returned the available models.', action: '' });
    } catch (e) {
      const detail = !gemini.configured ? 'Add an API key first.' : e.status === 401 || e.status === 403 || e.status === 400 ? 'Google did not accept this key.' : e.status === 429 ? 'Google is rate limiting requests.' : 'Could not reach the Gemini API within 10 seconds.';
      // Never return raw provider errors: some upstream services include submitted credentials in them.
      checks.push({ id: 'gemini-api', name: 'Gemini connection', status: 'fail', detail, action: 'Check the key, internet connection and Google AI Studio access, then retry.' });
    }
    if (revision !== this.revision) return { checkedAt: Date.now(), checks: [{ id: 'gemini-api', name: 'Gemini connection', status: 'warn', detail: 'Settings changed during this check.', action: 'Run the connection test again with the current settings.' }] };
    this.lastTest = { checkedAt: Date.now(), checks };
    return this.lastTest;
  }
}
