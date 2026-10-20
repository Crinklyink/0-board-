#!/usr/bin/env node
// Builds the release bundle for the Raspberry Pi:  node scripts/package.mjs
//   -> dist/oboard-pi-<version>.tar.gz   (server + web + pi scripts + docs + the server's one dependency)
// Copy it to the Pi and run:  tar -xzf oboard-pi-*.tar.gz && cd oboard && sudo ./pi/install.sh
// The bundle is architecture-independent (no native modules), so it is built on any machine. The archive is written
// here rather than with the system `tar`, so the Pi scripts keep Unix line endings and their executable bit even when
// the bundle is made on Windows.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8')).version;
const dist = path.join(root, 'dist');
const stage = path.join(dist, 'stage', 'oboard');
fs.rmSync(path.join(dist, 'stage'), { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const skip = new Set(['data', '.env', 'test', '.devdata', 'server-credentials.json', 'server-credentials.json.tmp', 'secrets.json', 'display.token']);
for (const rel of ['server', 'web', 'pi', 'docs', 'README.md', 'LICENSE']) {
  if (!fs.existsSync(path.join(root, rel))) continue;
  fs.cpSync(path.join(root, rel), path.join(stage, rel), {
    recursive: true,
    filter: (p) => !skip.has(path.basename(p)) && !/\.(?:log|db(?:-wal|-shm)?)$/.test(p),
  });
}
if (!fs.existsSync(path.join(stage, 'server/node_modules/ws'))) {
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: path.join(stage, 'server'), stdio: 'inherit', shell: process.platform === 'win32' });
}

// ---------------------------------------------------------------- tar (ustar) writer
const isExecutable = (rel) => /^oboard\/pi\/[^/]+\.sh$/.test(rel);
const isText = (rel) => /\.(sh|service|timer|js|mjs|json|md|html|css|txt)$/.test(rel);

function header(name, { size = 0, mode, dir = false, mtime }) {
  const h = Buffer.alloc(512);
  let prefix = '';
  if (Buffer.byteLength(name) > 99) {
    const cut = name.lastIndexOf('/', 154);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 99) throw new Error(`path too long for tar: ${name}`);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  h.write(name, 0);
  h.write(oct(mode, 8), 100);
  h.write(oct(0, 8), 108); // uid
  h.write(oct(0, 8), 116); // gid
  h.write(oct(size, 12), 124);
  h.write(oct(mtime, 12), 136);
  h.write('        ', 148);
  h.write(dir ? '5' : '0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write('root', 265);
  h.write('root', 297);
  h.write(prefix, 345);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

const chunks = [];
const mtime = Math.floor(Date.now() / 1000);
(function walk(abs, rel) {
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    chunks.push(header(rel + '/', { mode: 0o755, dir: true, mtime }));
    for (const f of fs.readdirSync(abs).sort()) walk(path.join(abs, f), `${rel}/${f}`);
    return;
  }
  let data = fs.readFileSync(abs);
  if (isText(rel) && rel.startsWith('oboard/pi/')) data = Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'));
  chunks.push(header(rel, { size: data.length, mode: isExecutable(rel) ? 0o755 : 0o644, mtime }), data);
  const pad = (512 - (data.length % 512)) % 512;
  if (pad) chunks.push(Buffer.alloc(pad));
})(stage, 'oboard');
chunks.push(Buffer.alloc(1024)); // end-of-archive

const out = path.join(dist, `oboard-pi-${version}.tar.gz`);
fs.writeFileSync(out, zlib.gzipSync(Buffer.concat(chunks), { level: 9 }));
fs.rmSync(path.join(dist, 'stage'), { recursive: true, force: true });
console.log(`wrote ${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
