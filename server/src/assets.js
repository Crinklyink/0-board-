import fs from 'node:fs';
import path from 'node:path';
import { rid, now, sha256Hex, HttpError } from './util.js';

const ALLOWED = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif'],
  ['application/pdf', 'pdf'], ['text/plain', 'txt'], ['text/markdown', 'md'], ['text/csv', 'csv'], ['application/json', 'json'],
  ['audio/mp4', 'm4a'], ['audio/mpeg', 'mp3'], ['audio/ogg', 'ogg'], ['audio/wav', 'wav'], ['audio/webm', 'webm'], ['audio/aac', 'aac'],
]);

export const isImageMime = (m) => m.startsWith('image/');

export class Assets {
  constructor(db, dataDir) {
    this.db = db;
    this.dir = path.join(dataDir, 'assets');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Content-addressed: uploading the same bytes twice returns the same asset. Writes are atomic (tmp + fsync + rename). */
  save(buffer, { filename = '', mime = 'application/octet-stream' } = {}) {
    mime = String(mime).split(';')[0].trim().toLowerCase();
    if (!ALLOWED.has(mime)) throw new HttpError(415, `Unsupported file type ${mime}`);
    if (!buffer.length) throw new HttpError(400, 'Empty upload');
    const sha = sha256Hex(buffer);
    const existing = this.db.prepare('SELECT * FROM assets WHERE sha256 = ?').get(sha);
    if (existing) return rowOut(existing);

    const ext = ALLOWED.get(mime);
    const file = this.pathFor(sha, ext);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, buffer);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    }
    const dim = isImageMime(mime) ? imageSize(buffer, mime) : null;
    const id = rid('as_', 12);
    this.db.prepare('INSERT INTO assets(id, sha256, filename, mime, size, width, height, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, sha, String(filename).slice(0, 200), mime, buffer.length, dim?.w ?? null, dim?.h ?? null, now());
    return rowOut(this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id));
  }

  pathFor(sha, ext) {
    return path.join(this.dir, sha.slice(0, 2), `${sha}.${ext}`);
  }

  get(id) {
    const r = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    return r ? rowOut(r) : null;
  }

  filePath(asset) {
    return this.pathFor(asset.sha256, ALLOWED.get(asset.mime));
  }

  read(id) {
    const a = this.get(id);
    if (!a) return null;
    return { asset: a, data: fs.readFileSync(this.filePath(a)) };
  }

  setCaption(id, caption) {
    this.db.prepare('UPDATE assets SET caption = ? WHERE id = ?').run(String(caption).slice(0, 600), id);
  }
}

function rowOut(r) {
  return {
    id: r.id, sha256: r.sha256, filename: r.filename, mime: r.mime, size: r.size,
    width: r.width, height: r.height, caption: r.caption, createdAt: r.created_at,
  };
}

/** Header-only image size sniffing so we need no native image library on the Pi. */
export function imageSize(buf, mime) {
  try {
    if (mime === 'image/png' && buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (mime === 'image/gif' && buf.length > 10) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (mime === 'image/webp' && buf.toString('ascii', 0, 4) === 'RIFF') {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
      }
      if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    }
  } catch { /* fall through */ }
  return null;
}
