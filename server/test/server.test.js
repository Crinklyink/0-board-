import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { startServer, wsClient, tmpDir, sleep } from './helpers.js';

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function pairPhone(s, name = 'Test phone') {
  const { json: pc } = await s.call('GET', '/api/pair/new');
  const r = await s.call('POST', '/api/pair', { code: pc.code, name }, { tok: null });
  assert.equal(r.status, 200, r.text);
  return r.json.token;
}

test('auth: API needs a token; health and info do not; static web app is served', async () => {
  const s = await startServer();
  try {
    assert.equal((await s.call('GET', '/healthz', undefined, { tok: null })).status, 200);
    assert.equal((await s.call('GET', '/api/info', undefined, { tok: null })).json.app, 'oboard');
    assert.equal((await s.call('GET', '/api/boards', undefined, { tok: null })).status, 401);
    assert.equal((await s.call('GET', '/api/boards', undefined, { tok: 'x'.repeat(43) })).status, 401);
    assert.equal((await s.call('GET', '/api/boards')).status, 200);
    const html = await fetch(s.base + '/');
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    // path traversal must not escape the web root
    const evil = await fetch(s.base + '/..%2f..%2fserver%2fpackage.json');
    assert.notEqual(evil.status, 200);
    const evil2 = await fetch(s.base + '/shared/../../server/package.json');
    assert.notEqual(evil2.status, 200);
  } finally { await s.app.close(); }
});

test('pairing: single-use codes, bad codes are rejected and throttled, revoked devices lose access', async () => {
  const s = await startServer();
  try {
    const { json: pc } = await s.call('GET', '/api/pair/new');
    assert.match(pc.code, /^\d{8}$/);
    const ok = await s.call('POST', '/api/pair', { code: pc.code, name: 'My Fold' }, { tok: null });
    assert.equal(ok.status, 200);
    const phoneTok = ok.json.token;
    const me = (await s.call('GET', '/api/me', undefined, { tok: phoneTok })).json;
    assert.equal(me.device.name, 'My Fold');
    // a paired phone learns every address the Pi answers on, so it can switch networks without re-pairing
    assert.ok(me.addresses.length >= 2 && me.addresses.every((u) => /^http:\/\/[^/]+:\d+$/.test(u)), JSON.stringify(me.addresses));
    assert.equal((await s.call('GET', '/api/info', undefined, { tok: null })).json.addresses, undefined, 'not shown to unpaired clients');
    // reuse of the same code fails
    assert.equal((await s.call('POST', '/api/pair', { code: pc.code, name: 'again' }, { tok: null })).status, 403);
    // throttle: many wrong guesses get 429
    let got429 = false;
    for (let i = 0; i < 12; i++) {
      const r = await s.call('POST', '/api/pair', { code: '00000000', name: 'x' }, { tok: null });
      if (r.status === 429) got429 = true;
    }
    assert.ok(got429, 'brute forcing is throttled');
    // revoke: the token stops working and an already-open live connection is cut immediately
    const phoneWs = wsClient(s.base, phoneTok);
    await phoneWs.open;
    const cut = new Promise((resolve) => phoneWs.ws.once('close', (code) => resolve(code)));
    const devs = (await s.call('GET', '/api/devices')).json.devices;
    const mine = devs.find((d) => d.name === 'My Fold');
    assert.equal((await s.call('DELETE', `/api/devices/${mine.id}`)).status, 200);
    assert.equal(await cut, 4401);
    assert.equal((await s.call('GET', '/api/me', undefined, { tok: phoneTok })).status, 401);
    // the TV display cannot be revoked
    const tv = devs.find((d) => d.role === 'display');
    assert.equal((await s.call('DELETE', `/api/devices/${tv.id}`)).status, 404);
  } finally { await s.app.close(); }
});

test('websocket: unauthenticated upgrade is refused', async () => {
  const s = await startServer();
  try {
    const c = wsClient(s.base, 'nope'.repeat(10));
    await assert.rejects(c.open);
  } finally { await s.app.close(); }
});

test('Test E — sync: an edit from the phone reaches the TV client, and the TV edit reaches the phone', async () => {
  const s = await startServer();
  try {
    const phoneTok = await pairPhone(s);
    const tv = wsClient(s.base, s.token);
    const phone = wsClient(s.base, phoneTok);
    await Promise.all([tv.open, phone.open]);
    const boardId = (await s.call('GET', '/api/boards')).json.boards.find((b) => b.kind === 'space').id;
    tv.send({ t: 'sub', board: boardId });
    phone.send({ t: 'sub', board: boardId });
    await tv.waitFor((m) => m.t === 'board');
    await phone.waitFor((m) => m.t === 'board');

    const t0 = Date.now();
    phone.send({ t: 'ops', board: boardId, cid: 'c1', ops: [{ op: 'put', obj: { id: 'n_sync001', type: 'note', x: 100, y: 50, text: 'from the phone' } }] });
    const ack = await phone.waitFor((m) => m.t === 'ack' && m.cid === 'c1');
    const seen = await tv.waitFor((m) => m.t === 'ops' && m.ops.some((o) => o.obj?.id === 'n_sync001'));
    const latency = Date.now() - t0;
    assert.equal(seen.ops[0].obj.text, 'from the phone');
    assert.equal(seen.rev, ack.rev);
    assert.equal(phone.take((m) => m.t === 'ops'), null, 'the sender is not echoed its own ops');
    console.log(`    sync latency phone->TV (loopback): ${latency} ms`);

    tv.send({ t: 'ops', board: boardId, cid: 'c2', ops: [{ op: 'patch', id: 'n_sync001', set: { x: 640 } }] });
    const back = await phone.waitFor((m) => m.t === 'ops' && m.ops[0]?.set?.x === 640);
    assert.equal(back.ops[0].id, 'n_sync001');

    // invalid ops are nacked, not applied, and do not break the connection
    phone.send({ t: 'ops', board: boardId, cid: 'c3', ops: [{ op: 'put', obj: { id: 'n_bad0001', type: 'note', x: 'a', y: 0 } }] });
    const nack = await phone.waitFor((m) => m.t === 'nack' && m.cid === 'c3');
    assert.match(nack.error, /number/);
    assert.equal((await s.call('GET', `/api/boards/${boardId}`)).json.objects.length, 1);

    // ephemeral live drag previews are relayed but never stored
    const before = (await s.call('GET', `/api/boards/${boardId}`)).json.rev;
    phone.send({ t: 'live', board: boardId, patches: [{ id: 'n_sync001', set: { x: 700 } }] });
    const live = await tv.waitFor((m) => m.t === 'live');
    assert.equal(live.patches[0].set.x, 700);
    assert.equal((await s.call('GET', `/api/boards/${boardId}`)).json.rev, before);

    await tv.close(); await phone.close();
  } finally { await s.app.close(); }
});

test('Test F — persistence: boards, objects, images, conversation and settings survive a server restart', async () => {
  const dataDir = tmpDir();
  let s = await startServer({ dataDir });
  const boardId = (await s.call('GET', '/api/boards')).json.boards.find((b) => b.kind === 'space').id;
  const up = await s.call('POST', '/api/assets', PNG, { raw: true, headers: { 'content-type': 'image/png', 'x-filename': 'dot.png' } });
  assert.equal(up.status, 201, up.text);
  const assetId = up.json.asset.id;
  assert.equal(up.json.asset.width, 1);
  await s.call('POST', `/api/boards/${boardId}/ops`, { ops: [
    { op: 'put', obj: { id: 'n_keep001', type: 'note', x: 0, y: 0, text: 'robotic arm idea' } },
    { op: 'put', obj: { id: 'i_keep001', type: 'image', x: 300, y: 0, w: 120, h: 120, asset: assetId } },
    { op: 'put', obj: { id: 'a_keep001', type: 'arrow', from: { id: 'n_keep001' }, to: { id: 'i_keep001' } } },
  ] });
  s.app.store.addMessage({ boardId, role: 'user', text: 'I want a camera to identify objects' });
  await s.call('PUT', '/api/settings', { textModel: 'gemini-test-model' });
  await s.app.close();

  s = await startServer({ dataDir });
  try {
    const state = (await s.call('GET', `/api/boards/${boardId}`)).json;
    assert.deepEqual(state.objects.map((o) => o.id).sort(), ['a_keep001', 'i_keep001', 'n_keep001']);
    const img = await fetch(`${s.base}/assets/${assetId}`, { headers: { authorization: `Bearer ${s.token}` } });
    assert.equal(img.status, 200);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG, 'image bytes identical after restart');
    assert.equal((await s.call('GET', `/api/conversation/${boardId}`)).json.messages[0].text, 'I want a camera to identify objects');
    assert.equal((await s.call('GET', '/api/settings')).json.settings.textModel, 'gemini-test-model');
    assert.equal((await s.call('GET', `/api/search?q=camera`)).json.messages.length, 1, 'search index rebuilt/kept');
    assert.equal((await s.call('GET', `/api/search?q=robot`)).json.objects.length, 1);
    // the same display token still works (kiosk keeps its identity across reboots)
    assert.equal(s.token, fs.readFileSync(path.join(dataDir, 'display.token'), 'utf8').trim());
  } finally { await s.app.close(); }
});

test('capture: saves instantly to Thoughts, understands links, dedupes retries, accepts photos', async () => {
  const s = await startServer();
  try {
    const a = await s.call('POST', '/api/capture', { text: 'What if the arm used suction?', clientId: 'cap-1', source: 'voice' });
    assert.equal(a.status, 201);
    assert.equal(a.json.boardId, 'thoughts');
    const dup = await s.call('POST', '/api/capture', { text: 'What if the arm used suction?', clientId: 'cap-1' });
    assert.equal(dup.status, 200);
    assert.equal(dup.json.duplicate, true);
    const link = await s.call('POST', '/api/capture', { text: 'https://example.com/robot-arm', clientId: 'cap-2' });
    assert.equal(link.json.created[0].type, 'link');
    const up = await s.call('POST', '/api/assets', PNG, { raw: true, headers: { 'content-type': 'image/png', 'x-filename': 'p.png' } });
    const photo = await s.call('POST', '/api/capture', { assetIds: [up.json.asset.id], clientId: 'cap-3' });
    assert.equal(photo.json.created[0].type, 'image');
    const objs = (await s.call('GET', '/api/boards/thoughts')).json.objects;
    assert.equal(objs.length, 3);
    // masonry placement: no overlaps
    for (let i = 0; i < objs.length; i++) for (let j = i + 1; j < objs.length; j++) {
      const p = objs[i]; const q = objs[j];
      const overlap = p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y;
      assert.ok(!overlap, `${p.id} overlaps ${q.id}`);
    }
    assert.equal((await s.call('POST', '/api/capture', {})).status, 400);
  } finally { await s.app.close(); }
});

test('assets: dedupe by content, reject unsupported types, enforce auth, 304 on revalidation', async () => {
  const s = await startServer();
  try {
    const h = { 'content-type': 'image/png', 'x-filename': 'a.png' };
    const a = await s.call('POST', '/api/assets', PNG, { raw: true, headers: h });
    const b = await s.call('POST', '/api/assets', PNG, { raw: true, headers: h });
    assert.equal(a.json.asset.id, b.json.asset.id);
    const exe = await s.call('POST', '/api/assets', Buffer.from('MZ....'), { raw: true, headers: { 'content-type': 'application/x-msdownload' } });
    assert.equal(exe.status, 415);
    const svg = await s.call('POST', '/api/assets', Buffer.from('<svg onload=alert(1)>'), { raw: true, headers: { 'content-type': 'image/svg+xml' } });
    assert.equal(svg.status, 415, 'SVG (script-capable) is not accepted');
    const anon = await fetch(`${s.base}/assets/${a.json.asset.id}`);
    assert.equal(anon.status, 401);
    const r1 = await fetch(`${s.base}/assets/${a.json.asset.id}?token=${s.token}`);
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('x-content-type-options'), 'nosniff');
    const r2 = await fetch(`${s.base}/assets/${a.json.asset.id}?token=${s.token}`, { headers: { 'if-none-match': r1.headers.get('etag') } });
    assert.equal(r2.status, 304);
  } finally { await s.app.close(); }
});

test('backup: on-demand DB backup and full tar contain real, restorable data', async () => {
  const s = await startServer();
  try {
    const boardId = (await s.call('GET', '/api/boards')).json.boards.find((b) => b.kind === 'space').id;
    const up = await s.call('POST', '/api/assets', PNG, { raw: true, headers: { 'content-type': 'image/png' } });
    await s.call('POST', `/api/boards/${boardId}/ops`, { ops: [{ op: 'put', obj: { id: 'n_bk00001', type: 'note', x: 0, y: 0, text: 'back me up' } }] });
    const mk = await s.call('POST', '/api/backups');
    assert.equal(mk.status, 201);
    assert.ok(mk.json.size > 0);
    assert.ok((await s.call('GET', '/api/backups')).json.backups.some((b) => b.name === mk.json.name));

    // restore the backup file as a database and read the note
    const { DatabaseSync } = await import('node:sqlite');
    const copy = path.join(tmpDir(), 'restored.db');
    fs.copyFileSync(path.join(s.dataDir, 'backups', mk.json.name), copy);
    const rdb = new DatabaseSync(copy);
    assert.equal(rdb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.match(rdb.prepare(`SELECT data FROM objects WHERE id = 'n_bk00001'`).get().data, /back me up/);
    rdb.close();

    const tar = await fetch(`${s.base}/api/backup/full?token=${s.token}`);
    assert.equal(tar.status, 200);
    const buf = Buffer.from(await tar.arrayBuffer());
    const names = [];
    for (let off = 0; off + 512 <= buf.length;) {
      const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/s, '');
      if (!name) break;
      const size = parseInt(buf.toString('ascii', off + 124, off + 135), 8);
      names.push(name);
      off += 512 + Math.ceil(size / 512) * 512;
    }
    assert.ok(names.includes('oboard.db'));
    assert.ok(names.some((n) => n.startsWith('assets/') && n.endsWith('.png')), `tar has the image: ${names}`);
    void up;
  } finally { await s.app.close(); }
});

test('export/import round-trips a board with its images', async () => {
  const s = await startServer();
  try {
    const boardId = (await s.call('GET', '/api/boards')).json.boards.find((b) => b.kind === 'space').id;
    const up = await s.call('POST', '/api/assets', PNG, { raw: true, headers: { 'content-type': 'image/png', 'x-filename': 'dot.png' } });
    await s.call('POST', `/api/boards/${boardId}/ops`, { ops: [
      { op: 'put', obj: { id: 'n_ex00001', type: 'note', x: 0, y: 0, text: 'portable' } },
      { op: 'put', obj: { id: 'i_ex00001', type: 'image', x: 300, y: 0, w: 100, h: 100, asset: up.json.asset.id } },
      { op: 'put', obj: { id: 'a_ex00001', type: 'arrow', from: { id: 'n_ex00001' }, to: { id: 'i_ex00001' }, label: 'shows' } },
    ] });
    const exp = await s.call('GET', `/api/boards/${boardId}/export`);
    assert.equal(exp.status, 200);
    const imp = await s.call('POST', '/api/import', exp.json);
    assert.equal(imp.status, 201, imp.text);
    const copy = (await s.call('GET', `/api/boards/${imp.json.board.id}`)).json;
    assert.equal(copy.objects.length, 3);
    assert.equal(copy.objects.find((o) => o.type === 'arrow').label, 'shows');
    assert.equal((await s.call('POST', '/api/import', { format: 'nope' })).status, 400);
  } finally { await s.app.close(); }
});

test('display state: phone remote moves the TV camera, switches boards, and the TV reopens where it was', async () => {
  const dataDir = tmpDir();
  let s = await startServer({ dataDir });
  const spaces = (await s.call('GET', '/api/boards')).json.boards.filter((b) => b.kind === 'space');
  const second = (await s.call('POST', '/api/boards', { name: 'Robot desk' })).json.board;
  try {
    const phoneTok = await pairPhone(s);
    const tv = wsClient(s.base, s.token);
    const phone = wsClient(s.base, phoneTok);
    await Promise.all([tv.open, phone.open]);
    phone.send({ t: 'display', patch: { boardId: second.id } });
    const sw = await tv.waitFor((m) => m.t === 'display' && m.display.boardId === second.id);
    assert.equal(sw.display.mode, 'normal');
    phone.send({ t: 'display', patch: { cam: { x: 1200, y: -300, z: 0.5 } } });
    const cam = await tv.waitFor((m) => m.t === 'display' && m.display.cam?.x === 1200);
    assert.equal(cam.display.cam.z, 0.5);
    phone.send({ t: 'display', patch: { mode: 'present', slide: 2 } });
    await tv.waitFor((m) => m.t === 'display' && m.display.mode === 'present' && m.display.slide === 2);
    // bad camera values are ignored
    phone.send({ t: 'display', patch: { cam: { x: 'NaN', y: 0, z: -4 } } });
    await sleep(100);
    assert.equal(s.app.hub.display.cam.x, 1200);
    await tv.close(); await phone.close();
    await sleep(1400); // camera save debounce
  } finally { await s.app.close(); }

  s = await startServer({ dataDir });
  try {
    assert.equal(s.app.hub.display.boardId, second.id, 'TV opens the board it was last showing');
    assert.equal(s.app.hub.display.cam.x, 1200, 'and the camera position it was left at');
    void spaces;
  } finally { await s.app.close(); }
});

test('Test H (part): client reconnects and resyncs only what it missed (delta), no data lost', async () => {
  const s = await startServer();
  try {
    const phoneTok = await pairPhone(s);
    const boardId = (await s.call('GET', '/api/boards')).json.boards.find((b) => b.kind === 'space').id;
    let phone = wsClient(s.base, phoneTok);
    await phone.open;
    phone.send({ t: 'sub', board: boardId });
    const first = await phone.waitFor((m) => m.t === 'board');
    const lastRev = first.rev;
    await phone.close(); // network drop

    // meanwhile the TV / AI changes the board
    await s.call('POST', `/api/boards/${boardId}/ops`, { ops: [
      { op: 'put', obj: { id: 'n_miss001', type: 'note', x: 0, y: 0, text: 'made while you were away' } },
      { op: 'put', obj: { id: 'n_miss002', type: 'note', x: 300, y: 0, text: 'also missed' } },
    ] });
    await s.call('POST', `/api/boards/${boardId}/ops`, { ops: [{ op: 'del', id: 'n_miss002' }] });

    phone = wsClient(s.base, phoneTok);
    await phone.open;
    phone.send({ t: 'sub', board: boardId, rev: lastRev });
    const delta = await phone.waitFor((m) => m.t === 'delta');
    assert.deepEqual(delta.upserts.map((o) => o.id), ['n_miss001']);
    assert.deepEqual(delta.deletes, ['n_miss002']);
    assert.ok(delta.rev > lastRev);
    await phone.close();
  } finally { await s.app.close(); }
});

test('graceful shutdown leaves a consistent database (WAL checkpointed, quick_check ok)', async () => {
  const dataDir = tmpDir();
  const s = await startServer({ dataDir });
  const boardId = (await s.call('GET', '/api/boards')).json.boards.find((b) => b.kind === 'space').id;
  for (let i = 0; i < 40; i++) {
    await s.call('POST', `/api/boards/${boardId}/ops`, { ops: [{ op: 'put', obj: { id: `n_wal${String(i).padStart(5, '0')}`, type: 'note', x: i * 10, y: 0, text: `note ${i}` } }] });
  }
  await s.app.close();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'oboard.db'));
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM objects').get().n, 40);
  db.close();
  void zlib;
});
