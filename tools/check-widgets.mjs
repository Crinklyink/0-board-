#!/usr/bin/env node
// DEV TOOL. Puts every widget template on a fresh "Widget check" board, opens the TV view in headless Chrome, and
// reports what each widget did (running + what it shows, or its error). Uses real data from the internet.
//
//   node tools/check-widgets.mjs --base http://127.0.0.1:8090 --token <phone or browser token> [--tv-token <display token>] [--out shot.png]
//
// Needs Google Chrome (or set CHROME=/path/to/chrome).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TEMPLATE_NAMES, buildWidget } from '../web/shared/widget-templates.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const { WebSocket } = require('ws');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('base', 'http://127.0.0.1:8090');
const token = arg('token');
const tvToken = arg('tv-token', token);
const out = arg('out', 'widget-check.png');
if (!token) { console.error('Pass --token <phone or browser token>'); process.exit(2); }
const chromePath = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => fs.existsSync(p));
if (!chromePath) { console.error('Chrome not found; set CHROME'); process.exit(2); }

const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = async (method, p, body) => (await fetch(base + p, { method, headers: H, body: body && JSON.stringify(body) })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLES = {
  stock: { symbol: 'NVDA' }, crypto: { coin: 'BTC' }, weather: { place: 'New York', units: 'fahrenheit' },
  clock: { zones: 'America/New_York, Europe/London, Asia/Tokyo' }, countdown: { label: 'New Year', date: `${new Date().getFullYear() + 1}-01-01` },
  timer: { minutes: 25, label: 'Focus' },
};

const old = (await api('GET', '/api/boards')).boards.find((b) => b.name === 'Widget check');
if (old) await api('DELETE', `/api/boards/${old.id}`);
const board = (await api('POST', '/api/boards', { name: 'Widget check' })).board;
const ops = TEMPLATE_NAMES.map((name, i) => {
  const b = buildWidget(name, SAMPLES[name]);
  return { op: 'put', obj: { id: `w_check_${name}`.slice(0, 40), type: 'widget', title: b.title, html: b.html, template: name, params: b.params, x: (i % 3) * 500, y: Math.floor(i / 3) * 340, w: b.w, h: b.h } };
});
await api('POST', `/api/boards/${board.id}/ops`, { ops, label: 'widget check' });
await api('POST', '/api/display', { boardId: board.id, fit: true });

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'oboard-chrome-'));
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=9339', `--user-data-dir=${prof}`, '--window-size=1600,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
try {
  let pages = [];
  for (let i = 0; i < 60 && !pages.length; i++) { try { pages = (await (await fetch('http://127.0.0.1:9339/json')).json()).filter((p) => p.type === 'page'); } catch { /* starting */ } await sleep(200); }
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const call = (method, params = {}) => new Promise((resolve) => { const i = ++id; ws.on('message', function h(d) { const m = JSON.parse(d); if (m.id === i) { ws.off('message', h); resolve(m.result); } }); ws.send(JSON.stringify({ id: i, method, params })); });
  await call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `${base}/?mode=tv#t=${tvToken}` });
  await sleep(12000);
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  ws.close();
} finally {
  chrome.kill();
  await sleep(300);
  fs.rmSync(prof, { recursive: true, force: true });
}

let failed = 0;
for (const op of ops) {
  const s = (await api('GET', `/api/widgets/${op.obj.id}/logs`)).status;
  // "Running" while it still says "Loading…" means the runtime reported too early (it once did for weather).
  const early = s?.level === 'ready' && /loading/i.test(s.text || '');
  const ok = s?.level === 'ready' && !early;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${op.obj.template.padEnd(10)} ${ok ? s.text : early ? `reported running while showing: ${s.text}` : s ? `${s.level}: ${s.message}` : 'no report'}`);
}
console.log(`screenshot: ${out}`);
process.exit(failed ? 1 : 0);
