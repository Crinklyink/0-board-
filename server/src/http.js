import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError, log, now, rid } from './util.js';
import { StoreError } from './store.js';
import { GeminiError } from './gemini.js';
import { capture } from './capture.js';
import { captionAsset } from './ai/caption.js';
import { runTool, ToolContext } from './ai/tools.js';

const PROTOCOL = 1;

const PAGE_CSP = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; frame-src 'self'; frame-ancestors 'none'";
// The frame widgets run in (always sandboxed, without same-origin). Their code is inline, but they get no network at
// all: data only comes through the board page, which asks the Pi's proxy. Keys never enter the frame.
export const WIDGET_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function createApp(deps) {
  const { store, auth, hub, assets, agent, live, settings, gemini, backups, pending, secrets, widgets, config } = deps;
  const routes = [];
  const route = (method, pattern, opts, handler) => {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, auth: opts.auth !== false, handler });
  };

  // ---- public ---------------------------------------------------------------------------------

  route('GET', '/healthz', { auth: false }, (ctx) => {
    ctx.json({
      ok: true, version: config.version, uptime: Math.round(process.uptime()), clients: hub.clients.size,
      gemini: gemini.configured, rssMB: Math.round(process.memoryUsage().rss / 1048576), ...store.stats(),
    });
  });

  route('GET', '/api/info', { auth: false }, (ctx) => {
    ctx.json({ app: 'oboard', serverId: auth.serverId, version: config.version, protocol: PROTOCOL, paired: auth.hasPairedPhone(), gemini: gemini.configured });
  });

  route('POST', '/api/pair', { auth: false }, async (ctx) => {
    const b = await ctx.body();
    const out = auth.redeem(b.code, { name: String(b.name || 'Phone').slice(0, 60), role: b.role === 'web' ? 'web' : 'phone', ip: ctx.ip });
    ctx.json({ deviceId: out.device.id, token: out.token, serverId: auth.serverId, version: config.version, protocol: PROTOCOL });
  });

  // ---- devices / pairing ----------------------------------------------------------------------

  // `addresses` lets a paired phone keep working when it leaves home: it remembers them and switches to whichever
  // one answers (the Tailscale address when away). Only paired devices see them.
  route('GET', '/api/me', (ctx) => ctx.json({ device: ctx.device, serverId: auth.serverId, addresses: serverUrls(config.port, config.publicUrls) }));

  route('GET', '/api/pair/new', (ctx) => {
    const { code, expiresAt } = auth.newPairingCode();
    ctx.json({ code, expiresAt, port: config.port, hostname: os.hostname(), addresses: ipv4Addresses().map((a) => a.address), serverId: auth.serverId });
  });

  route('GET', '/api/devices', (ctx) => ctx.json({ devices: auth.listDevices() }));
  route('DELETE', '/api/devices/:id', (ctx) => {
    if (!auth.revoke(ctx.params.id)) throw new HttpError(404, 'No such device (the TV display cannot be removed)');
    hub.dropDevice(ctx.params.id);
    ctx.json({ ok: true });
  });

  // ---- boards ---------------------------------------------------------------------------------

  route('GET', '/api/boards', (ctx) => {
    const boards = store.listBoards({ includeArchived: ctx.query.get('archived') === '1' });
    // ?preview=1 adds a small layout sketch per board (the phone draws thumbnails from it).
    const withPreview = ctx.query.get('preview') === '1' ? boards.map((b) => ({ ...b, preview: store.boardPreview(b.id, b.rev) })) : boards;
    ctx.json({ boards: withPreview, display: hub.display });
  });

  route('POST', '/api/boards', async (ctx) => {
    const b = await ctx.body();
    ctx.json({ board: store.createBoard({ name: b.name, kind: 'space' }) }, 201);
  });

  route('PATCH', '/api/boards/:id', async (ctx) => {
    const b = await ctx.body();
    ctx.json({ board: store.updateBoard(ctx.params.id, b) });
  });

  route('DELETE', '/api/boards/:id', (ctx) => {
    if (ctx.query.get('confirm') !== 'yes') throw new HttpError(400, 'Deleting a board is permanent; pass ?confirm=yes (or archive it instead)');
    backups.create('pre-delete');
    store.deleteBoard(ctx.params.id);
    ctx.json({ ok: true });
  });

  route('GET', '/api/boards/:id', (ctx) => {
    const s = store.state(ctx.params.id);
    store.markOpened(ctx.params.id);
    ctx.json(s);
  });

  route('POST', '/api/boards/:id/ops', async (ctx) => {
    const b = await ctx.body();
    const out = store.applyBatch(ctx.params.id, b.ops, { actor: `device:${ctx.device.id}`, label: b.label, cid: b.cid });
    ctx.json({ rev: out.rev, batchId: out.batchId });
  });

  route('GET', '/api/boards/:id/history', (ctx) => ctx.json({ batches: store.recentBatches(ctx.params.id, { limit: 30 }) }));

  route('GET', '/api/boards/:id/snapshots', (ctx) => ctx.json({ snapshots: store.listSnapshots(ctx.params.id) }));
  route('POST', '/api/boards/:id/snapshots', async (ctx) => {
    const b = await ctx.body();
    ctx.json({ id: store.createSnapshot(ctx.params.id, String(b.label || 'Saved version')) }, 201);
  });
  route('POST', '/api/boards/:id/restore', async (ctx) => {
    const b = await ctx.body();
    const out = store.restoreSnapshot(ctx.params.id, b.snapshotId, { actor: `device:${ctx.device.id}` });
    ctx.json({ rev: out.rev, changes: out.ops.length });
  });

  route('POST', '/api/boards/:id/undo-ai', async (ctx) => {
    const tctx = new ToolContext({ store, hub, assets, pending, secrets, widgets, settings: settings.get(), boardId: ctx.params.id, turnId: 'ui', selection: [] });
    ctx.json(await runTool('undo_ai_change', {}, tctx));
  });
  route('POST', '/api/boards/:id/redo-ai', async (ctx) => {
    const tctx = new ToolContext({ store, hub, assets, pending, secrets, widgets, settings: settings.get(), boardId: ctx.params.id, turnId: 'ui', selection: [] });
    ctx.json(await runTool('redo_ai_change', {}, tctx));
  });

  route('GET', '/api/boards/:id/export', (ctx) => {
    const board = store.mustBoard(ctx.params.id);
    const objects = store.getObjects(board.id);
    const used = new Set(objects.filter((o) => o.asset).map((o) => o.asset));
    const files = [];
    for (const id of used) {
      const f = assets.read(id);
      if (f) files.push({ id, mime: f.asset.mime, filename: f.asset.filename, caption: f.asset.caption, data: f.data.toString('base64') });
    }
    const body = JSON.stringify({ format: 'oboard-board', version: 1, exportedAt: now(), board: { name: board.name, kind: board.kind }, objects, assets: files });
    ctx.raw(200, 'application/json', Buffer.from(body), {
      'content-disposition': `attachment; filename="${board.name.replace(/[^\w.-]+/g, '_') || 'board'}.oboard.json"`,
    });
  });

  route('POST', '/api/import', { maxBody: 200 * 1024 * 1024 }, async (ctx) => {
    const b = await ctx.body(200 * 1024 * 1024);
    if (b.format !== 'oboard-board' || !Array.isArray(b.objects)) throw new HttpError(400, 'Not an O Board export file');
    const idMap = new Map();
    for (const f of b.assets || []) {
      const saved = assets.save(Buffer.from(f.data, 'base64'), { filename: f.filename, mime: f.mime });
      if (f.caption && !saved.caption) assets.setCaption(saved.id, f.caption);
      idMap.set(f.id, saved.id);
    }
    const board = store.createBoard({ name: `${b.board?.name || 'Imported'} (imported)`, kind: 'space' });
    const ops = b.objects.map((o) => ({ op: 'put', obj: o.asset && idMap.has(o.asset) ? { ...o, asset: idMap.get(o.asset) } : o }))
      .sort((x, y) => (x.obj.type === 'arrow') - (y.obj.type === 'arrow'));
    if (ops.length) store.applyBatch(board.id, ops, { actor: `device:${ctx.device.id}`, label: 'Import' });
    ctx.json({ board: store.getBoard(board.id) }, 201);
  });

  // ---- capture / assets -----------------------------------------------------------------------

  route('POST', '/api/capture', async (ctx) => {
    const b = await ctx.body();
    const out = capture({
      store, assets, hub, boardId: b.boardId || 'thoughts', text: b.text, assetIds: b.assetIds, clientId: b.clientId,
      source: b.source, actor: `device:${ctx.device.id}`,
    });
    ctx.json(out, out.duplicate ? 200 : 201);
  });

  route('POST', '/api/assets', { maxBody: config.maxUploadBytes }, async (ctx) => {
    const buf = await ctx.buffer(config.maxUploadBytes);
    const filename = decodeURIComponent(String(ctx.req.headers['x-filename'] || ''));
    const asset = assets.save(buf, { filename, mime: ctx.req.headers['content-type'] });
    if (asset.mime.startsWith('image/') && !asset.caption) {
      captionAsset({ gemini, assets, store, hub, settings }, asset.id).catch(() => {});
    }
    ctx.json({ asset }, 201);
  });

  route('GET', '/api/assets/:id', (ctx) => {
    const a = assets.get(ctx.params.id);
    if (!a) throw new HttpError(404, 'No such asset');
    ctx.json({ asset: a });
  });

  route('GET', '/assets/:id', (ctx) => {
    const a = assets.get(ctx.params.id);
    if (!a) throw new HttpError(404, 'No such asset');
    const etag = `"${a.sha256}"`;
    if (ctx.req.headers['if-none-match'] === etag) return ctx.raw(304, null, null, { etag });
    const file = assets.filePath(a);
    const st = fs.statSync(file);
    ctx.res.writeHead(200, {
      'content-type': a.mime, 'content-length': st.size, etag, 'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff', 'content-disposition': `inline; filename="${(a.filename || 'file').replace(/[^\w.-]+/g, '_')}"`,
      ...corsHeaders(ctx.req),
    });
    fs.createReadStream(file).pipe(ctx.res);
    ctx.handled = true;
  });

  // ---- AI -------------------------------------------------------------------------------------

  route('POST', '/api/ai/message', async (ctx) => {
    const b = await ctx.body();
    const out = agent.submit({
      boardId: b.boardId || hub.display.boardId, text: b.text, source: b.source === 'voice' ? 'voice' : 'text',
      attachments: b.attachments, selection: Array.isArray(b.selection) ? b.selection.filter((x) => typeof x === 'string') : [],
      anchor: b.anchor, deviceId: ctx.device.id,
    });
    ctx.json(out, 202);
  });

  route('POST', '/api/ai/cancel', async (ctx) => {
    const b = await ctx.body();
    ctx.json({ cancelled: agent.cancel({ turnId: b.turnId, boardId: b.boardId, reason: 'user' }) });
  });

  route('GET', '/api/ai/pending', (ctx) => ctx.json({ pending: pending.list(ctx.query.get('boardId') || undefined) }));
  route('POST', '/api/ai/confirm', async (ctx) => {
    const b = await ctx.body();
    ctx.json(pending.resolve(b.id, !!b.accept, { viaUser: true }));
  });

  route('GET', '/api/ai/models', async (ctx) => {
    if (!gemini.configured) throw new HttpError(503, 'No Gemini API key on the server');
    const models = await gemini.listModels();
    ctx.json({ models: models.filter((m) => m.methods.includes('generateContent') || m.methods.includes('bidiGenerateContent')) });
  });

  route('GET', '/api/settings', (ctx) => ctx.json({ settings: settings.get(), gemini: gemini.configured, tz: config.tz }));
  route('PUT', '/api/settings', async (ctx) => {
    ctx.json({ settings: settings.set(await ctx.body()) });
  });

  // ---- Gemini Live ----------------------------------------------------------------------------

  route('POST', '/api/live/token', async (ctx) => {
    if (!gemini.configured) throw new HttpError(503, 'No Gemini API key on the server');
    const b = await ctx.body();
    ctx.json(await live.start({ boardId: b.boardId || hub.display.boardId, selection: Array.isArray(b.selection) ? b.selection : [] }));
  });

  route('POST', '/api/live/tool', async (ctx) => {
    const b = await ctx.body();
    ctx.json(await live.runTool({ boardId: b.boardId || hub.display.boardId, name: String(b.name || ''), args: b.args, selection: b.selection, sessionId: b.sessionId }));
  });

  // ---- widgets and their API keys -------------------------------------------------------------

  route('GET', '/api/secrets', (ctx) => ctx.json({ secrets: secrets.list() }));

  route('PUT', '/api/secrets/:name', async (ctx) => {
    if (ctx.device.role === 'display') throw new HttpError(403, 'Add keys from the phone app or a paired browser');
    const b = await ctx.body(16 * 1024);
    let info;
    try { info = secrets.set(ctx.params.name, { value: b.value, host: b.host, service: b.service }); } catch (e) { throw new HttpError(400, e.message); }
    hub.broadcast({ t: 'secrets', name: info.name, set: true });
    ctx.json({ secret: info });
  });

  route('DELETE', '/api/secrets/:name', (ctx) => {
    if (ctx.device.role === 'display') throw new HttpError(403, 'Not allowed from the TV');
    if (!secrets.delete(ctx.params.name)) throw new HttpError(404, 'No such key');
    hub.broadcast({ t: 'secrets', name: ctx.params.name, set: false });
    ctx.json({ ok: true });
  });

  route('POST', '/api/widgets/fetch', async (ctx) => {
    const b = await ctx.body(64 * 1024);
    ctx.json(await widgets.fetch({ url: b.url, headers: b.headers || {}, cache: b.cache ?? 10, widgetId: String(b.widgetId || '').slice(0, 48) }));
  });

  route('POST', '/api/widgets/:id/report', async (ctx) => {
    const b = await ctx.body(16 * 1024);
    widgets.report({ boardId: String(b.boardId || ''), widgetId: ctx.params.id, level: b.level, message: b.message, hash: b.hash, text: b.text, client: ctx.device.name });
    ctx.json({ ok: true });
  });

  route('GET', '/api/widgets/:id/logs', (ctx) => ctx.json({ status: widgets.status(ctx.params.id), logs: widgets.recent(ctx.params.id, 30) }));

  route('POST', '/api/live/transcript', async (ctx) => {
    const b = await ctx.body();
    const m = live.transcript({ boardId: b.boardId || hub.display.boardId, role: b.role, text: b.text, sessionId: b.sessionId });
    ctx.json({ ok: true, id: m?.id || null });
  });

  // ---- conversation / search / display --------------------------------------------------------

  route('GET', '/api/conversation/:boardId', (ctx) => {
    const limit = Math.min(200, Number(ctx.query.get('limit')) || 40);
    const before = Number(ctx.query.get('before')) || undefined;
    ctx.json({ messages: store.getMessages(ctx.params.boardId, { limit, beforeTs: before }) });
  });

  route('DELETE', '/api/conversation/:boardId', (ctx) => {
    const ids = store.db.prepare('SELECT id FROM messages WHERE board_id = ?').all(ctx.params.boardId).map((r) => r.id);
    store.deleteMessages(ids);
    ctx.json({ ok: true, deleted: ids.length });
  });

  route('GET', '/api/search', (ctx) => {
    const q = ctx.query.get('q') || '';
    const boardId = ctx.query.get('board') || undefined;
    ctx.json({
      objects: store.searchObjects(q, { boardId, limit: 30 }).map((h) => ({ boardId: h.boardId, board: h.boardName, object: h.object })),
      messages: store.searchMessages(q, { boardId, limit: 15 }),
    });
  });

  route('GET', '/api/display', (ctx) => ctx.json({ display: hub.display, clients: hub.connected() }));
  route('POST', '/api/display', async (ctx) => {
    hub.setDisplay(await ctx.body());
    ctx.json({ display: hub.display });
  });

  // ---- backups --------------------------------------------------------------------------------

  route('GET', '/api/backups', (ctx) => ctx.json({ backups: backups.list() }));
  route('POST', '/api/backups', (ctx) => ctx.json(backups.create('manual'), 201));
  route('GET', '/api/backup/full', (ctx) => {
    const stream = backups.tarStream();
    ctx.res.writeHead(200, {
      'content-type': 'application/x-tar',
      'content-disposition': `attachment; filename="oboard-full-${new Date().toISOString().slice(0, 10)}.tar"`,
      ...corsHeaders(ctx.req),
    });
    stream.pipe(ctx.res);
    ctx.handled = true;
  });

  // ---- request pipeline -----------------------------------------------------------------------

  const staticRoot = config.webDir;

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(staticRoot, rel));
    if (!file.startsWith(staticRoot + path.sep) && file !== staticRoot) return false;
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    if (!st.isFile()) return false;
    const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
    const headers = {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      etag, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
      'content-security-policy': rel === '/widget.html' ? WIDGET_CSP : PAGE_CSP,
      // Widget frames have an opaque origin, and fonts load in CORS mode: allow them to use the board's typeface.
      ...(/\.woff2?$/.test(file) ? { 'access-control-allow-origin': '*' } : {}),
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
    return true;
  }

  return async function handle(req, res) {
    const started = now();
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const ip = req.socket.remoteAddress || '?';
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { ...(type ? { 'content-type': type } : {}), ...(body ? { 'content-length': Buffer.byteLength(body) } : {}), ...corsHeaders(req), ...extra });
      res.end(body);
    };

    try {
      if (req.method === 'OPTIONS') {
        return send(204, null, null, {
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type,x-filename,if-none-match',
          'access-control-allow-private-network': 'true',
          'access-control-max-age': '600',
        });
      }

      let matched = null;
      let params = {};
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (m) { matched = r; params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); break; }
      }

      if (!matched) {
        if ((req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api/') && serveStatic(req, res, pathname)) return undefined;
        throw new HttpError(404, 'Not found');
      }

      let device = null;
      if (matched.auth) {
        const token = (req.headers.authorization || '').replace(/^Bearer /i, '') || (req.method === 'GET' ? url.searchParams.get('token') : '');
        device = auth.authenticate(token);
        if (!device) throw new HttpError(401, 'Not paired. Pair this device with the code shown on the TV.');
      }

      const ctx = {
        req, res, params, query: url.searchParams, device, ip, handled: false,
        json: (obj, status = 200) => send(status, 'application/json; charset=utf-8', JSON.stringify(obj)),
        raw: (status, type, body, extra) => {
          res.writeHead(status, { ...(type ? { 'content-type': type } : {}), ...(body ? { 'content-length': body.length } : {}), ...corsHeaders(req), ...extra });
          res.end(body);
        },
        body: async (limit = 2 * 1024 * 1024) => {
          const buf = await readBody(req, limit);
          if (!buf.length) return {};
          try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'Body must be JSON'); }
        },
        buffer: (limit) => readBody(req, limit),
      };
      await matched.handler(ctx);
      return undefined;
    } catch (e) {
      if (res.headersSent) { res.destroy(); return undefined; }
      let status = 500;
      let message = 'Internal error';
      let extra = {};
      if (e instanceof HttpError) { status = e.status; message = e.message; extra = e.extra; }
      else if (e instanceof StoreError) { status = e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : 400; message = e.message; extra = { code: e.code }; }
      else if (e instanceof GeminiError) { status = e.status >= 400 && e.status < 600 ? 502 : 502; message = e.message; extra = { code: `gemini_${e.status}` }; }
      else log('error', 'request failed', { path: pathname, error: String(e?.stack || e) });
      send(status, 'application/json; charset=utf-8', JSON.stringify({ error: message, ...extra }));
      return undefined;
    } finally {
      if (process.env.LOG_REQUESTS) log('debug', 'http', { m: req.method, p: pathname, ms: now() - started });
    }
  };
}

function ipv4Addresses() {
  const out = [];
  for (const [ifname, list] of Object.entries(os.networkInterfaces())) {
    // 169.254.x.x is a self-assigned address that no phone can route to.
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) out.push({ ifname, address: i.address });
  }
  return out;
}

/** Every URL this Pi may answer on, in the order a phone should prefer them: home network first, Tailscale last. */
export function serverUrls(port, extra = []) {
  const isTailscale = (a) => { const [x, y] = a.split('.').map(Number); return x === 100 && y >= 64 && y <= 127; };
  const ips = ipv4Addresses().map((a) => a.address);
  const host = os.hostname();
  return [...new Set([
    `http://${host}.local:${port}`,
    ...ips.filter((a) => !isTailscale(a)).map((a) => `http://${a}:${port}`),
    ...extra,
    ...ips.filter(isTailscale).map((a) => `http://${a}:${port}`),
    `http://${host}:${port}`, // Tailscale MagicDNS (and some home routers) resolve the bare name
  ])];
}

function corsHeaders(req) {
  // Bearer tokens (not cookies) authenticate API calls, so a permissive origin is safe and lets the Android WebView call us.
  return { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'etag', vary: 'origin' };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) { req.resume(); return reject(new HttpError(413, 'Upload too large')); }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Upload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
