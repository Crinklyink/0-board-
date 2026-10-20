import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { log } from './util.js';

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

/**
 * Backups
 * - Automatic: a consistent copy of the database (VACUUM INTO) every few hours, newest N kept.
 * - On demand: a single .tar with the database plus every uploaded file, streamed to the phone/PC.
 * Assets are content-addressed and never modified, so a database backup plus the assets folder is a full backup.
 */
export class Backups {
  constructor({ db, dataDir, config }) {
    this.db = db;
    this.dir = path.join(dataDir, 'backups');
    this.assetsDir = path.join(dataDir, 'assets');
    this.config = config;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  start() {
    const everyMs = Math.max(1, this.config.backupEveryHours) * 3_600_000;
    const newest = this.list()[0];
    if (!newest || Date.now() - newest.mtime > everyMs) this.create('auto');
    this.timer = setInterval(() => this.create('auto'), everyMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  create(kind = 'manual') {
    const stem = `oboard-${kind}-${stamp()}`;
    let name = `${stem}.db`, suffix = 0;
    while (fs.existsSync(path.join(this.dir, name))) name = `${stem}-${++suffix}.db`;
    const file = path.join(this.dir, name);
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    try {
      const fd = fs.openSync(file, 'r+'); // fsync needs a writable descriptor on Windows
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (e) {
      log('warn', 'could not fsync backup', { error: e.message });
    }
    this.#prune();
    const size = fs.statSync(file).size;
    log('info', 'backup written', { name, size });
    return { name, size };
  }

  list() {
    return fs.readdirSync(this.dir).filter((n) => n.endsWith('.db')).map((name) => {
      const st = fs.statSync(path.join(this.dir, name));
      return { name, size: st.size, mtime: st.mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);
  }

  #prune() {
    const autos = this.list().filter((b) => b.name.includes('-auto-'));
    for (const old of autos.slice(this.config.backupKeep)) fs.rmSync(path.join(this.dir, old.name), { force: true });
  }

  /** A readable .tar stream: oboard.db + assets/... */
  tarStream() {
    const tmp = path.join(this.dir, `.tmp-${process.pid}-${Date.now()}.db`);
    this.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const self = this;
    async function* gen() {
      try {
        yield* fileEntry('oboard.db', tmp);
        if (fs.existsSync(self.assetsDir)) {
          for (const sub of fs.readdirSync(self.assetsDir)) {
            const subDir = path.join(self.assetsDir, sub);
            if (!fs.statSync(subDir).isDirectory()) continue;
            for (const f of fs.readdirSync(subDir)) {
              if (f.endsWith('.tmp')) continue;
              yield* fileEntry(`assets/${sub}/${f}`, path.join(subDir, f));
            }
          }
        }
        yield Buffer.alloc(1024); // end-of-archive marker
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    return Readable.from(gen());
  }
}

async function* fileEntry(name, file) {
  const st = fs.statSync(file);
  yield tarHeader(name, st.size, Math.floor(st.mtimeMs / 1000));
  for await (const chunk of fs.createReadStream(file)) yield chunk;
  const pad = (512 - (st.size % 512)) % 512;
  if (pad) yield Buffer.alloc(pad);
}

function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512);
  if (Buffer.byteLength(name) > 99) throw new Error(`tar name too long: ${name}`);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(mtime.toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148); // checksum placeholder (spaces)
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
