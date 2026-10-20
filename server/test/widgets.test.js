import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, wsClient, startMockGemini, call, say, pairPhone, sleep } from './helpers.js';
import { codeHash, normalizeObject, objectText, SchemaError } from '../../web/shared/schema.js';
import { isPrivateAddress } from '../src/widgets.js';

/** A stand-in for a third-party API: echoes what it received and counts hits. */
async function fakeApi() {
  const state = { hits: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.hits.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
    if (url.pathname === '/redir') { res.writeHead(302, { location: `http://localhost:${state.port}/echo` }); return res.end(); }
    if (url.pathname === '/big') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('x'.repeat(3 * 1024 * 1024)); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: url.pathname, query: Object.fromEntries(url.searchParams), key: req.headers['x-api-key'] || null }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.port = server.address().port;
  state.base = `http://127.0.0.1:${state.port}`;
  state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return state;
}

test('schema: widgets are first-class objects with size limits; their title is searchable text', () => {
  const w = normalizeObject({ id: 'w_test00001', type: 'widget', x: 0, y: 0, html: '<b>hi</b>', title: 'NVDA' });
  assert.equal(w.w, 420);
  assert.equal(objectText(w), 'NVDA');
  assert.throws(() => normalizeObject({ id: 'w_test00002', type: 'widget', x: 0, y: 0, html: 'x'.repeat(100_001) }), SchemaError);
  assert.throws(() => normalizeObject({ id: 'w_test00003', type: 'widget', x: 0, y: 0, html: 'x', state: { big: 'y'.repeat(9000) } }), SchemaError);
  assert.throws(() => normalizeObject({ id: 'w_test00004', type: 'widget', x: 0, y: 0 }), SchemaError, 'html is required');
  assert.equal(codeHash('abc'), codeHash('abc'));
  assert.notEqual(codeHash('abc'), codeHash('abd'));
});

test('API keys: added from a phone (never the TV), never returned, never in backups', async () => {
  const s = await startServer();
  try {
    const phone = await pairPhone(s);
    assert.equal((await s.call('PUT', '/api/secrets/FINNHUB_KEY', { value: 'sk-secret-123', host: 'finnhub.io' })).status, 403, 'the TV cannot add keys');
    const saved = await s.call('PUT', '/api/secrets/FINNHUB_KEY', { value: 'sk-secret-123', host: 'https://finnhub.io/docs', service: 'Finnhub' }, { tok: phone });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.secret.host, 'finnhub.io');
    const list = await s.call('GET', '/api/secrets', undefined, { tok: phone });
    assert.ok(!list.text.includes('sk-secret-123'), 'values never come back');
    assert.equal(list.json.secrets[0].set, true);
    assert.equal((await s.call('PUT', '/api/secrets/bad-name', { value: 'x', host: 'a.com' }, { tok: phone })).status, 400);
    assert.equal((await s.call('PUT', '/api/secrets/OTHER_KEY', { value: 'x', host: 'not a host' }, { tok: phone })).status, 400);

    const tar = await fetch(`${s.base}/api/backup/full`, { headers: { authorization: `Bearer ${phone}` } });
    assert.ok(!Buffer.from(await tar.arrayBuffer()).includes('sk-secret-123'), 'keys are not part of the full backup');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(s.dataDir, 'secrets.json')).mode & 0o777, 0o600);

    assert.equal((await s.call('DELETE', '/api/secrets/FINNHUB_KEY', undefined, { tok: phone })).status, 200);
    assert.equal((await s.call('GET', '/api/secrets', undefined, { tok: phone })).json.secrets.length, 0);
  } finally { await s.app.close(); }
});

test('widget data proxy: refuses the home network, fills keys only for their own host, caches, drops keys on cross-host redirects', async () => {
  const api = await fakeApi();
  const s = await startServer();
  try {
    const phone = await pairPhone(s);
    const fetchVia = (body) => s.call('POST', '/api/widgets/fetch', body, { tok: phone });

    // Normal mode: nothing inside the home network is reachable, by IP or by name.
    for (const url of [`${api.base}/echo`, `http://localhost:${api.port}/echo`, 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/']) {
      const r = await fetchVia({ url });
      assert.equal(r.status, 403, url);
      assert.equal(r.json.code, 'blocked_address');
    }
    assert.equal(api.hits.length, 0, 'the private service was never contacted');
    for (const ip of ['10.0.0.1', '172.16.5.4', '100.101.102.103', '::1', 'fd00::1', '::ffff:192.168.0.2']) assert.ok(isPrivateAddress(ip), ip);
    assert.ok(!isPrivateAddress('8.8.8.8'));

    s.app.widgets.allowPrivate = true; // dev/test mode, so the local fake can stand in for a real API
    let r = await fetchVia({ url: `${api.base}/q?token={{FAKE_KEY}}` });
    assert.equal(r.status, 424);
    assert.deepEqual([r.json.code, r.json.key], ['needs_key', 'FAKE_KEY']);

    await s.call('PUT', '/api/secrets/FAKE_KEY', { value: 'k 1&2', host: '127.0.0.1' }, { tok: phone });
    r = await fetchVia({ url: `${api.base}/q?symbol=NVDA&token={{FAKE_KEY}}`, headers: { 'X-Api-Key': '{{FAKE_KEY}}', Cookie: 'no' }, cache: 30, widgetId: 'w_a' });
    assert.equal(r.status, 200);
    const echoed = JSON.parse(r.json.body);
    assert.equal(echoed.query.token, 'k 1&2', 'filled into the query (URL-encoded on the wire)');
    assert.equal(echoed.query.symbol, 'NVDA');
    assert.equal(echoed.key, 'k 1&2', 'filled into the header');
    assert.equal(api.hits.at(-1).headers.cookie, undefined, 'blocked headers are not forwarded');

    const hitsBefore = api.hits.length;
    r = await fetchVia({ url: `${api.base}/q?symbol=NVDA&token={{FAKE_KEY}}`, headers: { 'X-Api-Key': '{{FAKE_KEY}}' }, cache: 30, widgetId: 'w_a' });
    assert.equal(api.hits.length, hitsBefore, 'second identical request is served from the cache');
    assert.equal(r.json.cached, true);

    r = await fetchVia({ url: 'https://example.com/?steal={{FAKE_KEY}}' });
    assert.deepEqual([r.status, r.json.code], [403, 'key_wrong_host']);
    r = await fetchVia({ url: 'https://{{FAKE_KEY}}.example.com/' });
    assert.equal(r.status, 400, 'keys can never be part of a host name');

    // Following a redirect to a different host must not carry the key header along.
    r = await fetchVia({ url: `${api.base}/redir`, headers: { 'x-api-key': '{{FAKE_KEY}}' }, cache: 0 });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.json.body).key, null);

    r = await fetchVia({ url: `${api.base}/big`, cache: 0 });
    assert.equal(r.status, 502, 'answers over 2 MB are refused');
  } finally { await s.app.close(); await api.close(); }
});

test('the assistant builds a widget, sees how it runs, fixes its own error, and asks for keys through the app', async () => {
  const mock = await startMockGemini();
  const GOOD = '<div id="v">NVDA $217.09</div><script>ob.every(60, async () => {})</script>';
  const BROKEN = '<div>BROKEN</div><script>undefinedThing()</script>';
  const seen = [];
  mock.script = (body, idx) => {
    const fr = body.contents.at(-1).parts.find((p) => p.functionResponse)?.functionResponse;
    if (fr) seen.push({ name: fr.name, response: fr.response });
    if (idx === 0) return [call('create_widget', { title: 'NVDA live', html: BROKEN })];
    if (idx === 1) return [call('update_widget', { id: fr.response.id, html: GOOD })];
    if (idx === 2) return [call('request_api_key', { name: 'FINNHUB_KEY', service: 'Finnhub', host: 'finnhub.io', signupUrl: 'https://finnhub.io/register', why: 'Live NVDA quotes' })];
    if (idx === 3) return [call('create_widget', { title: 'Bad', html: '<script>fetch("https://x.com")</script>' })];
    return [say('Done.')];
  };
  const s = await startServer({ gemini: { apiKey: 'k', baseUrl: mock.baseUrl } });
  try {
    const phone = await pairPhone(s);
    const boardId = s.app.hub.display.boardId;
    // A screen that has the board open and runs widgets: it reports back like the real widget runtime does.
    const screen = wsClient(s.base, phone);
    await screen.open;
    screen.send({ t: 'sub', board: boardId, rev: -1 });
    await screen.waitFor((m) => m.t === 'board' || m.t === 'delta');
    screen.ws.on('message', async (d) => {
      const m = JSON.parse(d.toString());
      if (m.t !== 'ops') return;
      for (const op of m.ops) {
        const html = op.op === 'put' ? op.obj.html : op.set?.html;
        const id = op.op === 'put' ? op.obj.id : op.id;
        if (!html) continue;
        await sleep(30);
        const report = html.includes('BROKEN')
          ? { level: 'error', message: 'ReferenceError: undefinedThing is not defined' }
          : { level: 'ready', text: 'NVDA $217.09 [1 chart]' };
        await s.call('POST', `/api/widgets/${id}/report`, { boardId, hash: codeHash(html), ...report }, { tok: phone });
      }
    });

    const r = await s.call('POST', '/api/ai/message', { boardId, text: 'track NVDA' }, { tok: phone });
    await screen.waitFor((m) => m.t === 'ai' && m.ev === 'done' && m.turnId === r.json.turnId, 30000);

    assert.equal(seen[0].name, 'create_widget');
    assert.equal(seen[0].response.status, 'error');
    assert.match(seen[0].response.error, /undefinedThing/);
    assert.equal(seen[1].name, 'update_widget');
    assert.equal(seen[1].response.status, 'running');
    assert.match(seen[1].response.shows, /\$217\.09/);
    assert.equal(seen[2].response.status, 'requested');
    assert.equal(seen[3].response.ok, false, 'direct fetch() is caught before the widget ever runs');
    assert.match(seen[3].response.error, /ob\.fetch/);

    const widgets = s.app.store.getObjects(boardId).filter((o) => o.type === 'widget');
    assert.equal(widgets.length, 1);
    assert.equal(widgets[0].html, GOOD);
    assert.ok(screen.inbox.some((m) => m.t === 'secrets' && m.name === 'FINNHUB_KEY' && m.requested), 'the app is told to show the key card');
    const keys = (await s.call('GET', '/api/secrets', undefined, { tok: phone })).json.secrets;
    assert.deepEqual(keys.map((k) => [k.name, k.host, k.set]), [['FINNHUB_KEY', 'finnhub.io', false]]);
    const logs = (await s.call('GET', `/api/widgets/${widgets[0].id}/logs`, undefined, { tok: phone })).json;
    assert.equal(logs.status.level, 'ready');
    // The board summary the model reads includes the widget's state.
    const { boardContext } = await import('../src/ai/context.js');
    assert.match(boardContext({ store: s.app.store, widgets: s.app.widgets, boardId }), /widget·ai "NVDA live" \[running, shows: NVDA \$217\.09/);
    await screen.close();
  } finally { await s.app.close(); await mock.close(); }
});
