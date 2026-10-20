import { loadConfig, Api, store as lstore } from './api.js';
import { Net } from './net.js';
import { Camera } from './camera.js';
import { BoardModel } from './model.js';
import { Renderer } from './render.js';
import { Session } from './session.js';
import { Editor } from './editor.js';
import { Input } from './input.js';
import { UI } from './ui.js';
import { TvController } from './tv.js';
import { RemoteController } from './remote.js';
import { openMemory, openTask, openTasks } from './productivity.js';
import { WidgetLayer } from './widgets.js';

const cfg = loadConfig();
document.documentElement.dataset.mode = cfg.mode;
document.documentElement.dataset.chrome = cfg.chrome;
const root = document.getElementById('ui');
const canvas = document.getElementById('board');
const host = window.OBoardHost;
const post = (type, data = {}) => { try { host?.postMessage(JSON.stringify({ type, ...data })); } catch { /* host gone */ } };

const api = new Api(cfg);

if (!cfg.token) {
  showPairing(null);
} else {
  start();
}

function start() {
  const camera = new Camera();
  const model = new BoardModel();
  const dprCap = cfg.dpr || (cfg.mode === 'tv' ? 1.5 : 2);
  let session;
  // -1 means "I have nothing for this board": an unloaded model must not claim to be at rev 0.
  const net = new Net({ api, name: cfg.name, getRev: (b) => (session && b === session.boardId && model.loaded ? model.rev : -1) });
  const renderer = new Renderer(canvas, { model, camera, api, dprCap });
  session = new Session({ cfg, api, net, model, camera, renderer });
  const editor = new Editor({ host: document.getElementById('stage'), session });
  const widgets = new WidgetLayer({ host: document.getElementById('stage'), before: root, session, api, cfg });
  renderer.widgetLive = (id) => widgets.isLive(id);
  // A fitted side pane stays fitted while it settles or the phone unfolds, until the user moves the view themselves.
  if (cfg.fit) renderer.onResize = () => { if (model.loaded && !session?.userMovedCam) session.fitContent(false); };
  renderer.onFrame = () => widgets.sync();
  const ui = new UI({ root, session, editor, cfg, api, widgets });
  // Native controls sit above the WebView; keep them clear of HTML dialogs and their save buttons.
  new MutationObserver(() => post('overlay', { open: !ui.overlay.hidden }))
    .observe(ui.overlay, { attributes: true, attributeFilter: ['hidden'] });
  // Same for small menus (More tools, colours): on the unfolded phone the native mic sits where their last items open.
  let popoverOpen = false;
  new MutationObserver(() => {
    const open = !!root.querySelector('.popover');
    if (open !== popoverOpen) post('popover', { open: (popoverOpen = open) });
  }).observe(root, { childList: true, subtree: true });
  const input = new Input({ canvas, session, ui });
  ui.input = input;
  session.input = input;
  editor.onStop = () => { ui.updateEmpty(); ui.updateContext(); };

  const follows = cfg.mode === 'tv' || cfg.mode === 'remote';
  let tv; let remote;
  if (cfg.mode === 'tv') tv = new TvController({ session, ui, api, cfg, root });
  if (cfg.mode === 'remote') { input.remote = true; remote = new RemoteController({ session, canvas, ui }); }

  renderer.onCameraChange = () => {
    editor.reposition();
    ui.queueContext();
    if (follows) session.pushCamera();
    const z = ui.zoomBox?.querySelector('.zoom-val');
    if (z) z.textContent = `${Math.round(camera.z * 100)}%`;
  };

  // ---- connection lifecycle
  let first = true;
  net.on('welcome', (m) => {
    session.display = m.display;
    if (first) {
      first = false;
      if (follows) {
        session.followDisplay(m.display);
        if (tv) tv.reportViewport();
      } else {
        const last = lstore.get('oboard.lastBoard');
        const fallback = m.boards.find((b) => b.kind === 'space')?.id || 'thoughts';
        const want = [cfg.board, last, m.display.boardId, fallback].find((id) => id && m.boards.some((b) => b.id === id));
        session.openBoard(want || fallback);
      }
      session.restoreOutbox();
    } else if (follows && m.display.boardId !== session.boardId) {
      session.followDisplay(m.display);
    }
  });
  session.on('board', (b) => {
    if (cfg.mode === 'edit' && b.id) lstore.set('oboard.lastBoard', b.id);
    post('board', { id: b.id, name: b.board?.name || ui.boardName || '' });
  });
  session.on('display', (d) => { if (follows) remote?.onDisplay(d); });
  session.on('status', (st) => {
    post('status', { state: st });
    if (st === 'unauthorized') showPairing(api);
  });
  session.on('selection', (ids) => post('selection', { ids }));
  session.on('history', () => post('history', { canUndo: session.history.canUndo, canRedo: session.history.canRedo }));
  session.on('outbox', (n) => post('outbox', { pending: n }));
  session.on('ai', (m) => post('ai', { ev: m.ev, text: m.text, turnId: m.turnId, boardId: m.boardId }));

  net.start();

  // Surface for the Android host (and for debugging in a desktop browser).
  window.oboard = {
    session, model, camera, input, ui, net, widgets,
    setTool: (t) => input.setTool(t),
    undo: () => session.undo(),
    redo: () => session.redo(),
    fit: () => session.fitContent(true),
    openBoard: (id) => session.openBoard(id),
    setOverview: (on) => remote?.setOverview(on),
    getSelection: () => [...session.selection],
    exportState: () => ({ board: session.boardId, objects: model.objects.size, rev: model.rev, status: session.status, pending: net.pending.size, display: session.display }),
    addNote: (text) => ui.captureText(text),
    pickFile: () => ui.pickFile(),
    openSearch: () => ui.openSearch(),
    openMemory: () => openMemory(ui),
    addTask: () => openTask(ui),
    openTasks: () => openTasks(ui),
    closeOverlay: () => ui.closeOverlay(),
    openAsk: () => ui.openAsk(),
    insetsChanged: (top, bottom) => { root.style.setProperty('--inset-top', `${top}px`); root.style.setProperty('--inset-bottom', `${bottom}px`); },
  };
  post('ready', { mode: cfg.mode });
  if (cfg.mode === 'tv') document.addEventListener('contextmenu', (e) => e.preventDefault());
}

function showPairing(existingApi) {
  const tvMode = cfg.mode === 'tv';
  document.documentElement.dataset.state = 'pair';
  const card = document.createElement('div');
  card.className = 'gate';
  if (tvMode) {
    card.innerHTML = `<div class="gate-card"><div class="gate-title">This display isn’t set up yet</div>
      <p>Start it with <code>pi/kiosk.sh</code> on the Raspberry Pi, which gives the browser its own access token.</p></div>`;
  } else {
    card.innerHTML = `<form class="gate-card"><div class="gate-title">Pair this device</div>
      <p>Enter the 8-digit code shown on your TV.</p>
      <input class="gate-input" inputmode="numeric" autocomplete="one-time-code" maxlength="9" placeholder="0000 0000" aria-label="Pairing code">
      <div class="gate-err" role="alert"></div>
      <button class="gate-btn" type="submit">Pair</button></form>`;
    const form = card.querySelector('form');
    const input = card.querySelector('input');
    const err = card.querySelector('.gate-err');
    input.addEventListener('input', () => { const d = input.value.replace(/\D/g, '').slice(0, 8); input.value = d.length > 4 ? `${d.slice(0, 4)} ${d.slice(4)}` : d; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      try {
        await (existingApi || api).pair(input.value, cfg.name);
        location.reload();
      } catch (ex) { err.textContent = ex.message; }
    });
    setTimeout(() => input.focus(), 50);
  }
  document.body.append(card);
}
