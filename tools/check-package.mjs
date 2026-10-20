#!/usr/bin/env node
// Verify the distributable itself, including file permissions and a fresh server boot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const version = JSON.parse(fs.readFileSync(new URL('../server/package.json', import.meta.url), 'utf8')).version;
const archive = path.resolve(process.argv[2] || `dist/oboard-pi-${version}.tar.gz`);
// tar runs next to the archive and gets only its file name: GNU tar (Git Bash) reads "C:\..." as a remote host.
const tar = (args, opts = {}) => execFileSync('tar', args, { cwd: path.dirname(archive), windowsHide: true, ...opts });
const archiveName = path.basename(archive);
const entries = tar(['-tzf', archiveName], { encoding: 'utf8' }).trim().split(/\r?\n/);
for (const entry of entries) {
  assert(!entry.includes('..'), `Unsafe archive entry: ${entry}`);
  assert(!/(^|\/)(?:\.env|server-credentials\.json(?:\.tmp)?|secrets\.json|display\.token)$/.test(entry), `Private file included: ${entry}`);
  assert(!/\.(?:db(?:-wal|-shm)?|jks|keystore)$/.test(entry), `Private data included: ${entry}`);
}
for (const rel of ['server/src/setup.js', 'web/shared/board-templates.js', 'web/shared/project-memory.js', 'web/js/productivity.js', 'pi/install.sh']) assert(entries.includes(`oboard/${rel}`), `Missing ${rel}`);
const detail = tar(['-tvzf', archiveName, 'oboard/pi/install.sh'], { encoding: 'utf8' });
assert(detail.startsWith('-rwxr-xr-x'), 'Installer must be executable');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oboard-package-check-'));
let app;
try {
  tar(['-xzf', archiveName, '-C', tmp.replaceAll('\\', '/')]); // GNU tar also mangles backslashes; both tars take "/"
  const root = path.join(tmp, 'oboard');
  assert(!fs.readFileSync(path.join(root, 'pi/install.sh'), 'utf8').includes('\r'), 'Installer has Windows line endings');
  const { createServer } = await import(pathToFileURL(path.join(root, 'server/src/index.js')).href);
  app = await createServer({ port: 0, host: '127.0.0.1', dataDir: path.join(tmp, 'test-data'), gemini: { apiKey: '' } });
  const port = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.version, version);
  const { code } = app.auth.newPairingCode();
  const paired = await (await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'Package verification', role: 'phone' }) })).json();
  const headers = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };
  const created = await (await fetch(`${base}/api/boards`, { method: 'POST', headers, body: JSON.stringify({ name: 'Packaged project', template: 'project' }) })).json();
  assert(created.board?.id, 'Packaged server failed to create a project');
  assert.equal(app.store.getObjects(created.board.id).filter((o) => o.type === 'task').length, 2);
  const memoryRes = await fetch(`${base}/api/boards/${created.board.id}/memory`, { method: 'PUT', headers, body: JSON.stringify({ revision: 0, memory: { goal: 'Verify the packaged server' } }) });
  assert.equal(memoryRes.status, 200);
  const diagnosticRes = await fetch(`${base}/api/diagnostics`, { headers });
  assert.equal(diagnosticRes.status, 200);
  assert((await diagnosticRes.json()).checks.some((c) => c.id === 'database' && c.status === 'pass'));
  console.log(`PASSED: ${path.basename(archive)} boots, creates task templates, saves memory and returns diagnostics`);
  console.log('PASSED: executable Unix installer, required files present, no credential/database/signing files');
} finally {
  if (app) await app.close();
  const resolved = path.resolve(tmp);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('oboard-package-check-')) throw new Error('Unexpected cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true });
}
