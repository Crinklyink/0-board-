import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createServer } from '../src/index.js';

export function tmpDir(prefix = 'oboard-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Start an isolated server on a random port. Pass dataDir to reuse state across a simulated restart. */
export async function startServer({ dataDir = tmpDir(), gemini = {}, defaults = {} } = {}) {
  const app = await createServer({ port: 0, host: '127.0.0.1', dataDir, gemini, defaults, backupEveryHours: 6 });
  const port = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const token = app.displayToken;
  const call = async (method, p, body, { tok = token, raw = false, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { app, port, base, token, dataDir, call };
}

/** WebSocket test client with a message queue and waitFor(). */
export function wsClient(base, token) {
  const ws = new WebSocket(base.replace('http', 'ws') + `/ws?token=${token}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(m); }
    }
  });
  const open = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    ws, inbox, open,
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor(pred, ms = 4000) {
      const hit = inbox.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ws message (got: ${inbox.map((m) => m.t).join(',')})`)), ms);
        waiters.push({ pred, resolve, timer });
      });
    },
    take(pred) {
      const i = inbox.findIndex(pred);
      return i >= 0 ? inbox.splice(i, 1)[0] : null;
    },
    close: () => new Promise((resolve) => { ws.once('close', resolve); ws.close(); }),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake Gemini that speaks just enough of the REST + SSE protocol. Script it per test. */
export async function startMockGemini() {
  const state = { requests: [], script: null, tokens: [], captions: 'A test image' };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://x');
    state.requests.push({ method: req.method, path: url.pathname, body, key: req.headers['x-goog-api-key'] });

    if (url.pathname.endsWith(':streamGenerateContent')) {
      const idx = state.requests.filter((r) => r.path.endsWith(':streamGenerateContent')).length - 1;
      const chunksOut = state.script ? await state.script(body, idx) : [{ parts: [{ text: 'ok' }] }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunksOut) {
        if (c.delay) await sleep(c.delay);
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: c.parts }, finishReason: c.final ? 'STOP' : undefined }] })}\r\n\r\n`);
      }
      return res.end();
    }
    if (url.pathname.endsWith(':generateContent')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: state.captions }] } }] }));
    }
    if (url.pathname === '/v1beta/auth_tokens') {
      const name = `auth_tokens/mock-${state.tokens.length + 1}`;
      state.tokens.push({ name, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ name }));
    }
    if (url.pathname === '/v1beta/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: [{ name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] }] }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.baseUrl = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return state;
}

export const say = (text) => ({ parts: [{ text }] });
export const call = (name, args) => ({ parts: [{ functionCall: { name, args } }] });
