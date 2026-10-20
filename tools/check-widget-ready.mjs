#!/usr/bin/env node
// Isolated browser check of when a widget says it is running. Uses a local fake API (no internet, no user boards).
// Regression: a widget whose second request depended on the first (like the weather template: place lookup, then
// forecast) was reported as running while it still showed "Loading…", so the assistant was told it worked.
// node tools/check-widget-ready.mjs [--out dist/qa-widgets]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { startServer, pairPhone } from '../server/test/helpers.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const { WebSocket } = require('ws');
const arg = process.argv.indexOf('--out');
const out = path.resolve(arg >= 0 ? process.argv[arg + 1] : 'dist/qa-widgets');
fs.mkdirSync(out, { recursive: true });
const chromePath = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(fs.existsSync);
if (!chromePath) throw new Error('Chrome not found. Set CHROME to the executable path.');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fake API: one fast lookup, one slow follow-up, a chain of slow steps and a broken endpoint.
const api = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (u.pathname === '/lookup') return json(200, { id: 'nvda' });
  if (u.pathname === '/quote') { await sleep(1500); return json(200, { price: 123.45 }); }
  if (u.pathname === '/step') { await sleep(600); return json(200, { n: Number(u.searchParams.get('n')) }); }
  if (u.pathname === '/broken') { await sleep(300); return json(500, { error: 'upstream down' }); }
  json(404, {});
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const apiBase = `http://127.0.0.1:${api.address().port}`;

const WIDGETS = {
  // Like the weather template: the second request needs the first one's answer.
  w_two_step: `<div id="out">Loading…</div><script>
    ob.every(60, async () => {
      const a = await ob.fetch('${apiBase}/lookup', { cache: 0 });
      document.getElementById('out').textContent = 'Loading price…';
      const q = await ob.fetch('${apiBase}/quote?id=' + a.id, { cache: 0 });
      document.getElementById('out').textContent = 'Price ' + q.price;
    });</script>`,
  // Three slow steps in a row, with a gap between them that is longer than the old "settled" delay.
  w_chain: `<div id="out">Loading…</div><script>
    ob.every(60, async () => {
      for (let n = 1; n <= 3; n++) {
        document.getElementById('out').textContent = 'Loading step ' + n + '…';
        await ob.fetch('${apiBase}/step?n=' + n, { cache: 0 });
        await new Promise((r) => setTimeout(r, 150));
      }
      document.getElementById('out').textContent = 'Done 3';
    });</script>`,
  // No requests at all (timer, calculator): still reported as running.
  w_static: '<div>Static 42</div>',
  // The follow-up request fails: must be reported as an error, never as running.
  w_broken: `<div id="out">Loading…</div><script>
    ob.every(60, async () => {
      await ob.fetch('${apiBase}/lookup', { cache: 0 });
      await ob.fetch('${apiBase}/broken', { cache: 0 });
      document.getElementById('out').textContent = 'Should not get here';
    });</script>`,
};

const server = await startServer();
server.app.widgets.allowPrivate = true; // test mode, so the local fake can stand in for a real API
const token = await pairPhone(server, 'widget ready check', 'web');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oboard-widgets-chrome-'));
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1600,900', '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore', windowsHide: true });
let ws;
const errors = [];
const pending = new Map();
let seq = 0;
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 10000);
  pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result?.value;
};
try {
  const { json: { board } } = await server.call('POST', '/api/boards', { name: 'Widget ready check' }, { tok: token });
  const ops = Object.entries(WIDGETS).map(([id, html], i) => ({ op: 'put', obj: { id, type: 'widget', title: id, html, x: (i % 2) * 460, y: Math.floor(i / 2) * 300, w: 420, h: 260 } }));
  const saved = await server.call('POST', `/api/boards/${board.id}/ops`, { ops, label: 'widget ready check' }, { tok: token });
  assert.equal(saved.status, 200, saved.text);

  const activePortFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(activePortFile); i++) { if (chrome.exitCode !== null) throw new Error('Chrome exited'); await sleep(100); }
  const port = fs.readFileSync(activePortFile, 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    if (message.id) {
      const p = pending.get(message.id); if (!p) return; pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  await call('Runtime.enable'); await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `${server.base}/?board=${board.id}#t=${token}` });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(await evaluate('!!window.oboard?.model.loaded').catch(() => false))) await sleep(100);
  await evaluate('oboard.fit()');

  const reports = (id) => server.app.widgets.recent(id, 30).filter((e) => e.level !== 'log');
  const until = Date.now() + 20000;
  while (Date.now() < until && !Object.keys(WIDGETS).every((id) => reports(id).length)) await sleep(200);
  await sleep(1500); // room for a late, second report (there should be none)
  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, 'widget-ready.png'), Buffer.from(data, 'base64'));

  const first = (id) => reports(id)[0];
  for (const id of Object.keys(WIDGETS)) assert(first(id), `${id} sent no report`);
  for (const id of Object.keys(WIDGETS)) {
    for (const e of reports(id).filter((r) => r.level === 'ready')) assert.doesNotMatch(e.text, /loading/i, `${id} was reported running while it showed "${e.text}"`);
  }
  assert.deepEqual([first('w_two_step').level, first('w_two_step').text], ['ready', 'Price 123.45']);
  console.log('PASSED: a widget whose second request needs the first is reported running only once it shows the result');
  assert.deepEqual([first('w_chain').level, first('w_chain').text], ['ready', 'Done 3']);
  console.log('PASSED: three slow requests in a row are reported once, with the final text');
  assert.deepEqual([first('w_static').level, first('w_static').text], ['ready', 'Static 42']);
  console.log('PASSED: a widget that makes no requests is still reported running');
  assert.equal(first('w_broken').level, 'error');
  assert(!reports('w_broken').some((e) => e.level === 'ready'), 'A widget whose follow-up request failed must never be reported running');
  assert.match(first('w_broken').message, /HTTP 500/);
  console.log('PASSED: a failing follow-up request is reported as an error, never as running');
  assert.deepEqual(errors, [], 'Unexpected JavaScript errors on the board page');
  console.log(`PASSED: no uncaught JavaScript errors; screenshot: ${path.join(out, 'widget-ready.png')}`);
} finally {
  ws?.close(); chrome.kill();
  await server.app.close();
  await new Promise((r) => { api.closeAllConnections?.(); api.close(r); });
  for (const [dir, prefix] of [[profile, 'oboard-widgets-chrome-'], [server.dataDir, 'oboard-test-']]) {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw new Error('Refusing unexpected cleanup path');
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(resolved, { recursive: true, force: true }); break; }
      catch (e) { if (i === 9) console.warn(`Temporary folder retained: ${resolved}`); else await sleep(200); }
    }
  }
}
