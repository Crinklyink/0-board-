import { ICON } from './icons.js';
import { colorOf, PALETTE_NAMES } from './theme.js';
import { newId } from './session.js';
import { NOTE_WIDTH, estimateNoteHeight } from '../shared/schema.js';
import { WIDGET_TEMPLATES, TEMPLATE_NAMES, buildWidget } from '../shared/widget-templates.js';
import { openTask, openTasks, openMemory, openNewBoard, openDiagnostics } from './productivity.js';

const FIELD_LABEL = {
  symbol: 'Symbol', range: 'Chart range', coin: 'Coin', currency: 'Currency', days: 'Chart range', place: 'Place',
  units: 'Units', zones: 'Time zones (optional, first is the main one)', label: 'Label', date: 'Date and time', minutes: 'Minutes',
};
const CHOICE_LABEL = {
  '1d': 'Today', '5d': '5 days', '1mo': '1 month', '6mo': '6 months', '1y': '1 year', 1: '24 hours', 7: '7 days', 30: '30 days',
  usd: 'US dollar', eur: 'Euro', gbp: 'British pound', jpy: 'Japanese yen', cad: 'Canadian dollar', aud: 'Australian dollar',
  celsius: 'Celsius', fahrenheit: 'Fahrenheit',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

const TOOL_LABEL = {
  add_tasks: 'Adding tasks', update_task: 'Updating task', update_project_memory: 'Saving project memory',
  add_notes: 'Adding notes', create_diagram: 'Drawing a diagram', connect_objects: 'Connecting', organize_objects: 'Organizing',
  group_into_section: 'Grouping', create_section: 'Adding a section', move_objects: 'Moving things', resize_object: 'Resizing',
  edit_object: 'Editing', delete_objects: 'Checking what to delete', search_board: 'Searching the board', read_board: 'Reading the board',
  focus_tv: 'Moving the view', recall: 'Remembering', view_images: 'Looking at images', undo_ai_change: 'Undoing', restore_version: 'Preparing to restore',
  switch_board: 'Switching board', create_board: 'Creating a board',
  create_widget: 'Building a widget', update_widget: 'Fixing the widget', read_widget_logs: 'Checking the widget',
  list_api_keys: 'Checking API keys', request_api_key: 'Asking for an API key',
};

export class UI {
  constructor({ root, session, editor, cfg, api, widgets = null }) {
    this.root = root;
    this.widgets = widgets;
    this.s = session;
    this.editor = editor;
    this.cfg = cfg;
    this.api = api;
    this.tv = cfg.mode === 'tv';
    this.remote = cfg.mode === 'remote';
    this.full = cfg.chrome === 'full';
    this.pendingConfirms = new Map();
    this.ai = null;
    this.aiTimer = 0;
    this.dragging = false;
    this.toolShape = 'rect';
    this.build();
    this.bind();
  }

  // ----------------------------------------------------------------------------------- structure

  build() {
    const { root } = this;
    root.classList.add('hud');
    if (this.cfg.chrome !== 'none') {
      this.status = h('div', { class: 'status', role: 'status' });
      root.append(this.status);
    }
    if (this.full) {
      this.boardBtn = h('button', { class: 'pill', 'aria-haspopup': 'menu', onclick: () => this.toggleBoards() }, h('span', { class: 'pill-name' }, 'Board'), h('span', { class: 'pill-chev', html: ICON.chevron }));
      this.zoomBox = h('div', { class: 'zoom' },
        this.iconBtn('minus', 'Zoom out', () => this.s.camera.animateTo({ x: this.s.camera.x, y: this.s.camera.y, z: this.s.camera.z / 1.4 }, 180)),
        h('button', { class: 'zoom-val', 'aria-label': 'Reset zoom', onclick: () => this.s.camera.animateTo({ x: this.s.camera.x, y: this.s.camera.y, z: 1 }, 220) }, '100%'),
        this.iconBtn('plus', 'Zoom in', () => this.s.camera.animateTo({ x: this.s.camera.x, y: this.s.camera.y, z: this.s.camera.z * 1.4 }, 180)),
        this.iconBtn('fit', 'Fit everything', () => this.s.fitContent(true)));
      this.topRight = h('div', { class: 'top-actions' },
        this.iconBtn('sliders', 'Setup & diagnostics', () => openDiagnostics(this)),
        this.iconBtn('search', 'Search (Ctrl+K)', () => this.openSearch()),
        this.iconBtn('ask', 'Ask the assistant (/)', () => this.openAsk()),
        this.iconBtn('tv', 'Show this board on the TV', () => this.showOnTv()));
      root.append(this.boardBtn, this.topRight, this.zoomBox);
    }
    if (this.cfg.chrome !== 'none' && !this.remote) this.buildToolbar();
    this.ctx = h('div', { class: 'ctxbar', hidden: true, role: 'toolbar', 'aria-label': 'Selection' });
    this.aiEl = h('div', { class: 'ai', 'aria-live': 'off' });
    this.empty = h('div', { class: 'empty', hidden: true });
    this.toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
    this.overlay = h('div', { class: 'overlay', hidden: true });
    this.live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
    root.append(this.empty, this.ctx, this.aiEl, this.toasts, this.overlay, this.live);
  }

  iconBtn(name, label, onclick, cls = '') {
    return h('button', { class: `ib ${cls}`, 'aria-label': label, title: label, html: ICON[name], onclick });
  }

  buildToolbar() {
    // On narrow screens (phone, cover screen, the unfolded split pane) the less-used tools move into "More" (see app.css).
    const t = (id, icon, label, key, cls = '') => h('button', { class: `tb ${cls}`, 'data-tool': id, 'aria-label': `${label}${key ? ` (${key})` : ''}`, 'aria-pressed': 'false', title: `${label}${key ? `  ${key}` : ''}`, html: ICON[icon], onclick: () => this.pickTool(id) });
    this.toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Tools' },
      t('select', 'select', 'Select', 'V'), t('hand', 'hand', 'Pan', 'H', 'wide-only'),
      h('span', { class: 'sep wide-only' }),
      t('note', 'note', 'Note', 'N'), t('text', 'text', 'Text', 'T'), (this.shapeBtn = t('shape', 'rect', 'Shape', 'R')),
      t('arrow', 'arrow', 'Arrow', 'A'), t('pen', 'pen', 'Draw', 'P', 'not-xs'), t('frame', 'frame', 'Section', 'F', 'wide-only'),
      h('button', { class: 'tb wide-only', 'aria-label': 'Add image or file', title: 'Add image or file', html: ICON.image, onclick: () => this.pickFile() }),
      h('button', { class: 'tb wide-only', 'aria-label': 'Add a widget', title: 'Add a widget (stock, weather, clock…)', html: ICON.widget, onclick: () => this.openWidgetPicker() }),
      h('button', { class: 'tb wide-only', 'aria-label': 'Add task', title: 'Add task', html: ICON.task, onclick: () => openTask(this) }),
      h('button', { class: 'tb wide-only', 'aria-label': 'Project memory', title: 'Project memory', html: ICON.memory, onclick: () => openMemory(this) }),
      h('button', { class: 'tb wide-only', 'aria-label': 'Task list', title: 'Task list and progress', html: ICON.list, onclick: () => openTasks(this) }),
      (this.moreBtn = h('button', { class: 'tb narrow-only', 'aria-label': 'More tools', 'aria-haspopup': 'menu', 'aria-pressed': 'false', title: 'More tools', html: ICON.more, onclick: () => this.moreTools() })),
      h('span', { class: 'sep' }),
      (this.undoBtn = h('button', { class: 'tb', 'aria-label': 'Undo', title: 'Undo  Ctrl+Z', html: ICON.undo, onclick: () => this.s.undo() })),
      (this.redoBtn = h('button', { class: 'tb not-xs', 'aria-label': 'Redo', title: 'Redo  Ctrl+Shift+Z', html: ICON.redo, onclick: () => this.s.redo() })));
    this.fileInput = h('input', { type: 'file', accept: 'image/*,application/pdf,text/plain,text/markdown,text/csv,application/json,audio/*', multiple: true, hidden: true });
    this.fileInput.addEventListener('change', async () => {
      for (const f of this.fileInput.files) await this.s.uploadAndPlace(f).catch((e) => this.toast(e.message, 'error'));
      this.fileInput.value = '';
    });
    this.root.append(this.toolbar, this.fileInput);
  }

  bind() {
    const s = this.s;
    s.on('selection', () => this.updateContext());
    s.on('history', () => this.updateHistoryButtons());
    s.on('board', (b) => this.onBoard(b));
    s.on('boards', () => this.renderBoardsMenu());
    s.on('status', () => this.renderStatus());
    s.on('outbox', () => this.renderStatus());
    s.on('presence', () => this.renderStatus());
    s.on('toast', (t) => this.toast(t.text, t.kind));
    s.on('ai', (m) => this.onAi(m));
    s.on('caption', (m) => this.onCaption(m));
    s.on('confirm', (p) => { this.pendingConfirms.set(p.id, p); this.renderAi(); });
    s.on('confirm-resolved', (m) => { this.pendingConfirms.delete(m.id); this.renderAi(); });
    s.model.onChange(() => { this.updateEmpty(); this.queueContext(); });
    s.on('ai-change', () => {});
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.overlay.hidden) this.closeOverlay(); });
    this.updateHistoryButtons();
    this.renderStatus();
  }

  // ------------------------------------------------------------------------------------- tools

  pickTool(id) {
    if (id === 'shape' && this.input.tool === 'shape') {
      const order = ['rect', 'ellipse', 'diamond', 'pill'];
      this.toolShape = order[(order.indexOf(this.toolShape) + 1) % order.length];
    }
    this.input.setTool(this.input.tool === id && id !== 'shape' && id !== 'select' ? 'select' : id, this.toolShape);
  }

  onTool(tool, shapeKind) {
    this.toolShape = shapeKind || this.toolShape;
    if (!this.toolbar) return;
    for (const b of this.toolbar.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    // "More" lights up when the active tool is hidden inside it.
    const hidden = [...this.toolbar.querySelectorAll('[data-tool]')].some((b) => b.dataset.tool === tool && !b.offsetParent);
    this.moreBtn.setAttribute('aria-pressed', String(hidden));
    this.shapeBtn.innerHTML = ICON[this.toolShape];
    this.root.dataset.tool = tool;
  }

  pickFile() { this.fileInput?.click(); }

  moreTools() {
    if (this.popover?.classList.contains('tool-more')) return this.closePopovers();
    this.closePopovers();
    const tool = this.input.tool;
    const item = (icon, label, fn, { pressed = false, cls = '' } = {}) => h('button', {
      class: `more-item ${cls}`, role: 'menuitem', 'aria-pressed': String(pressed),
      onclick: () => { this.closePopovers(); fn(); },
    }, h('span', { class: 'more-icon', html: ICON[icon] }), h('span', {}, label));
    const pop = h('div', { class: 'popover tool-more', role: 'menu', 'aria-label': 'More tools' },
      item('hand', 'Pan', () => this.pickTool('hand'), { pressed: tool === 'hand' }),
      item('pen', 'Draw', () => this.pickTool('pen'), { pressed: tool === 'pen', cls: 'only-xs' }),
      item('frame', 'Section', () => this.pickTool('frame'), { pressed: tool === 'frame' }),
      item('image', 'Add image or file', () => this.pickFile()),
      item('widget', 'Add a widget', () => this.openWidgetPicker()),
      item('task', 'Add task', () => openTask(this)),
      item('list', 'Task list', () => openTasks(this)),
      item('memory', 'Project memory', () => openMemory(this)),
      item('sliders', 'Setup & diagnostics', () => openDiagnostics(this)),
      item('redo', 'Redo', () => this.s.redo(), { cls: 'only-xs' }));
    this.root.append(pop);
    const a = this.moreBtn.getBoundingClientRect();
    const r = this.root.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(a.left - r.left, r.width - pop.offsetWidth - 8))}px`;
    pop.style.bottom = `${r.bottom - a.top + 10}px`;
    this.popover = pop;
    setTimeout(() => addEventListener('pointerdown', (e) => {
      if (!pop.contains(e.target) && !this.moreBtn.contains(e.target)) this.closePopovers();
    }, { once: true }), 0);
  }

  updateHistoryButtons() {
    if (!this.undoBtn) return;
    this.undoBtn.disabled = !this.s.history.canUndo;
    this.redoBtn.disabled = !this.s.history.canRedo;
  }

  // -------------------------------------------------------------------------------------- state

  onBoard(b) {
    const name = this.s.model.board?.name || b.board?.name || this.s.boards.find((x) => x.id === b.id)?.name || 'Board';
    this.boardName = name;
    if (this.boardBtn) $('.pill-name', this.boardBtn).textContent = name;
    this.updateEmpty();
    this.onBoardLabel?.(name);
  }

  updateEmpty() {
    if (this.tv || this.remote) { this.empty.hidden = true; return; }
    const show = this.s.model.loaded && this.s.model.objects.size === 0 && !this.editor.editing;
    this.empty.hidden = !show;
    if (show) {
      const touch = matchMedia('(pointer: coarse)').matches;
      const second = this.cfg.embedded ? 'Add an image, or hold the mic to talk it through.' : 'Drop an image here, or press / to ask the assistant.';
      this.empty.innerHTML = `<div class="empty-title">${esc(this.boardName || 'Blank board')}</div><div class="empty-sub">${touch ? 'Double-tap' : 'Double-click'} anywhere to add a note.<br>${second}</div>`;
    }
  }

  renderStatus() {
    if (!this.status) return;
    const st = this.s.status;
    const pend = this.s.net.pending.size;
    const tvOn = this.s.clients.some((c) => c.role === 'display');
    let dot = 'ok'; let label = '';
    if (st === 'unauthorized') { dot = 'bad'; label = 'Not paired'; }
    else if (st !== 'online') { dot = 'warn'; label = st === 'connecting' ? 'Connecting…' : pend ? `Offline · ${pend} change${pend > 1 ? 's' : ''} waiting` : 'Offline'; }
    else if (pend) { dot = 'ok'; label = 'Saving…'; }
    else if (this.full) label = tvOn ? 'Synced · TV connected' : 'Synced';
    this.status.className = `status ${dot} ${label ? 'show' : ''}`;
    this.status.innerHTML = `<i></i><span>${esc(label)}</span>`;
    if (!label || dot === 'ok') {
      clearTimeout(this.statusTimer);
      if (label) this.statusTimer = setTimeout(() => this.status.classList.remove('show'), 2600);
    }
    this.onStatus?.(st);
  }

  toast(text, kind = 'info') {
    if (!text) return;
    const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
    this.toasts.append(el);
    this.live.textContent = text;
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, kind === 'error' ? 5200 : 2800);
    while (this.toasts.children.length > 3) this.toasts.firstChild.remove();
  }

  // ------------------------------------------------------------------------------ editing glue

  startEdit(id, worldPt) {
    const o = this.s.model.get(id);
    if (!o) return;
    if (o.type === 'link') { this.openLink(o.url); return; }
    if (o.type === 'task') { openTask(this, id); return; }
    if (o.type === 'image' || o.type === 'file') { this.openAsset(o); return; }
    if (o.type === 'widget') { this.s.setSelection([id]); this.widgets?.setInteractive(id); this.updateContext(); return; }
    if (this.remote) { this.editor.start(id); return; }
    this.editor.start(id);
    void worldPt;
  }

  openLink(url) {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return;
      if (window.OBoardHost?.openUrl) window.OBoardHost.openUrl(u.toString()); else window.open(u.toString(), '_blank', 'noopener');
    } catch { /* not a URL */ }
  }

  openAsset(o) {
    const url = `${this.api.base}/assets/${o.asset}?token=${encodeURIComponent(this.api.token)}`;
    if (window.OBoardHost?.openUrl) window.OBoardHost.openUrl(url); else window.open(url, '_blank', 'noopener');
  }

  createAndEdit(kind, center, extra = {}) {
    const s = this.s;
    let obj;
    if (kind === 'note') {
      const w = extra.w || NOTE_WIDTH;
      obj = s.makeNote(center.x - w / 2, center.y - 24, '', { w, h: estimateNoteHeight('', w) });
    } else if (kind === 'text') {
      const w = extra.w || 320;
      obj = { id: newId('t'), type: 'text', x: Math.round(center.x - w / 2), y: Math.round(center.y - 16), w, h: 36, text: '', size: 'm', z: s.nextZ(), origin: 'user', t: Date.now() };
    } else {
      obj = { z: s.nextZ(), origin: 'user', t: Date.now(), ...extra };
    }
    s.model.applyOps([{ op: 'put', obj }]);
    s.setSelection([obj.id]);
    this.editor.start(obj.id, { fresh: true });
  }

  captureText(text, at) {
    const s = this.s;
    const isUrl = /^https?:\/\/\S+$/i.test(text);
    const p = at || { x: s.camera.x, y: s.camera.y };
    if (isUrl) {
      let host = text; try { host = new URL(text).hostname.replace(/^www\./, ''); } catch { /* keep */ }
      const spot = s.freeSpot(300, 92);
      const obj = { id: newId('l'), type: 'link', url: text, title: host, x: Math.round(at ? p.x - 150 : spot.x), y: Math.round(at ? p.y - 46 : spot.y), w: 300, h: 92 };
      s.create(obj, 'Add link');
      s.setSelection([obj.id]);
    } else {
      const spot = at ? { x: p.x - NOTE_WIDTH / 2, y: p.y - 30 } : s.freeSpot(NOTE_WIDTH, estimateNoteHeight(text));
      const obj = s.makeNote(spot.x, spot.y, text.slice(0, 20000));
      s.create(obj, 'Add note');
      s.setSelection([obj.id]);
    }
  }

  // ----------------------------------------------------------------------------- context bar

  queueContext() {
    if (this.ctxRaf) return;
    this.ctxRaf = requestAnimationFrame(() => { this.ctxRaf = 0; this.updateContext(); });
  }

  onPointerDown() { this.dragging = true; this.ctx.classList.add('dim'); if (this.widgets?.interactive) this.widgets.setInteractive(null); }
  onPointerUp() { this.dragging = false; setTimeout(() => { if (!this.dragging) this.ctx.classList.remove('dim'); this.updateContext(); }, 60); }
  onCameraSettled() { this.updateContext(); }
  onEscape() { this.closeOverlay(); this.s.setSelection([]); }

  updateContext() {
    if (this.tv || this.remote || this.cfg.chrome === 'none') { this.ctx.hidden = true; return; }
    const ids = [...this.s.selection];
    const objs = ids.map((id) => this.s.model.get(id)).filter(Boolean);
    if (!objs.length || this.editor.editing) { this.ctx.hidden = true; return; }
    this.ctx.hidden = false;
    const key = objs.map((o) => `${o.id}:${o.color}:${o.size}:${o.tag}:${o.dash}:${o.head}:${o.locked}:${o.status}`).join('|') + `:${this.widgets?.interactive || ''}`;
    if (key !== this.ctxKey) { this.ctxKey = key; this.buildContext(objs); }
    const union = this.s.model.contentBounds(ids);
    if (!union) return;
    const cam = this.s.camera;
    const a = cam.toScreen(union.x, union.y);
    const b = cam.toScreen(union.x + union.w, union.y + union.h);
    const bw = this.ctx.offsetWidth || 240;
    const bh = this.ctx.offsetHeight || 44;
    let x = (a.x + b.x) / 2 - bw / 2;
    let y = a.y - bh - 14;
    if (y < 56) y = Math.min(cam.h - bh - 80, b.y + 14);
    x = Math.max(8, Math.min(cam.w - bw - 8, x));
    y = Math.max(8, y);
    this.ctx.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  buildContext(objs) {
    const ids = objs.map((o) => o.id);
    const patch = (set, label) => this.s.commit(ids.map((id) => ({ op: 'patch', id, set })), { label });
    const els = [];
    const colorable = objs.filter((o) => ['note', 'shape', 'frame', 'text', 'arrow', 'draw'].includes(o.type));
    const single = objs.length === 1 ? objs[0] : null;
    this.ctx.replaceChildren();
    if (single?.type === 'task') {
      els.push(this.iconBtn('task', single.status === 'done' ? 'Reopen task' : 'Mark task done', () => patch({ status: single.status === 'done' ? 'todo' : 'done' }, 'Task status')));
      els.push(this.iconBtn('sliders', 'Edit task', () => openTask(this, single.id)));
    }
    if (single?.type === 'note' && !single.locked) els.push(this.iconBtn('task', 'Create task from note', () => openTask(this, null, single.id)));
    if (colorable.length) {
      const cur = colorable[0].color || 'default';
      const sw = h('button', { class: 'swatch-btn', 'aria-label': 'Color', title: 'Color', onclick: (e) => this.colorPopover(e.currentTarget, (c) => patch({ color: c }, 'Color')) }, h('i', { style: `background:${colorOf(cur).stroke}; box-shadow: inset 0 0 0 2px ${colorOf(cur).fill}` }));
      els.push(sw);
    }
    if (objs.some((o) => ['note', 'text', 'shape'].includes(o.type))) {
      const order = ['s', 'm', 'l', 'xl'];
      const cur = objs.find((o) => o.size)?.size || 'm';
      els.push(h('button', { class: 'ctx-text', 'aria-label': `Text size ${cur.toUpperCase()}`, title: 'Text size', onclick: () => patch({ size: order[(order.indexOf(cur) + 1) % 4] }, 'Text size') }, h('b', {}, 'Aa'), h('span', {}, cur.toUpperCase())));
    }
    if (objs.every((o) => o.type === 'note')) {
      const tags = ['', 'idea', 'fact', 'suggestion', 'question'];
      const cur = objs[0].tag || '';
      els.push(h('button', { class: 'ctx-text wide', 'aria-label': 'Label', title: 'Mark as idea, fact, suggestion or question', onclick: () => patch({ tag: tags[(tags.indexOf(cur) + 1) % tags.length] }, 'Label') }, h('span', {}, cur ? cur[0].toUpperCase() + cur.slice(1) : 'Label')));
    }
    if (single?.type === 'arrow') {
      els.push(h('button', { class: `ctx-text ${single.dash ? 'on' : ''}`, 'aria-pressed': String(!!single.dash), onclick: () => patch({ dash: !single.dash }, 'Arrow style') }, h('span', {}, 'Dashed')));
      els.push(h('button', { class: `ctx-text ${single.head === 'none' ? '' : 'on'}`, 'aria-pressed': String(single.head !== 'none'), onclick: () => patch({ head: single.head === 'none' ? 'arrow' : 'none' }, 'Arrow head') }, h('span', {}, 'Head')));
    }
    if (single && ['note', 'text', 'shape', 'frame', 'arrow', 'link'].includes(single.type)) els.push(this.iconBtn('text', 'Edit text (Enter)', () => this.startEdit(single.id)));
    if (single?.type === 'widget') {
      const using = this.widgets?.interactive === single.id;
      els.push(h('button', { class: `ctx-text ${using ? 'on' : ''}`, 'aria-pressed': String(using), title: 'Use the widget (double-tap)', onclick: () => { this.widgets?.setInteractive(using ? null : single.id); this.ctxKey = ''; this.updateContext(); } }, h('span', { html: ICON.tap }), h('span', {}, using ? 'Done' : 'Use')));
      if (single.template && WIDGET_TEMPLATES[single.template]) els.push(this.iconBtn('sliders', 'Widget settings', () => this.openWidgetPicker(single.id)));
      els.push(this.iconBtn('refresh', 'Reload widget', () => this.widgets?.reload(single.id)));
      if (this.full) els.push(this.iconBtn('ask', 'Ask the assistant to change this widget', () => this.openAsk(`Change the "${single.title || 'widget'}" widget: `)));
    }
    if (els.length) els.push(h('span', { class: 'sep' }));
    els.push(this.iconBtn('copy', 'Duplicate (Ctrl+D)', () => this.s.duplicate(ids)));
    els.push(this.iconBtn('front', 'Bring to front', () => this.s.reorder(ids, 'front')));
    const locked = objs.every((o) => o.locked);
    els.push(this.iconBtn(locked ? 'unlock' : 'lock', locked ? 'Unlock' : 'Lock in place', () => patch({ locked: locked ? null : true }, locked ? 'Unlock' : 'Lock')));
    if (this.full && single?.type !== 'widget') els.push(this.iconBtn('ask', 'Ask the assistant about this', () => this.openAsk(`About the selected ${objs.length > 1 ? 'items' : objs[0].type}: `)));
    els.push(this.iconBtn('trash', 'Delete', () => this.s.deleteObjects(ids), 'danger'));
    this.ctx.append(...els);
  }

  colorPopover(anchor, onPick) {
    this.closePopovers();
    const pop = h('div', { class: 'popover colors', role: 'menu' }, PALETTE_NAMES.map((c) => h('button', { class: 'swatch', 'aria-label': c, title: c, style: `background:${colorOf(c).stroke}; box-shadow: inset 0 0 0 3px ${colorOf(c).fill}`, onclick: () => { onPick(c); this.closePopovers(); } })));
    this.ctx.append(pop);
    const r = anchor.getBoundingClientRect();
    const cr = this.ctx.getBoundingClientRect();
    pop.style.left = `${r.left - cr.left}px`;
    pop.style.bottom = `${cr.height + 8}px`;
    this.popover = pop;
    setTimeout(() => addEventListener('pointerdown', this.popClose = (e) => { if (!pop.contains(e.target)) this.closePopovers(); }, { once: true }), 0);
  }

  closePopovers() { this.popover?.remove(); this.popover = null; }

  // ------------------------------------------------------------------------------ AI strip

  onAi(m) {
    const tvish = this.tv;
    if (!tvish && m.boardId && m.boardId !== this.s.boardId && m.ev !== 'cancelled') return;
    if (tvish && m.boardId && m.boardId !== this.s.boardId && m.ev === 'delta') return;
    clearTimeout(this.aiTimer);
    switch (m.ev) {
      case 'start': this.ai = { turn: m.turnId, text: '', state: 'thinking', label: 'Thinking' }; break;
      case 'delta': if (this.ai?.turn === m.turnId) { this.ai.text += m.text; this.ai.state = 'speaking'; } break;
      case 'tool': if (this.ai?.turn === m.turnId) { this.ai.state = 'working'; this.ai.label = TOOL_LABEL[m.name] || 'Working'; } break;
      case 'done':
        if (this.ai?.turn === m.turnId) {
          this.ai.text = m.text || this.ai.text;
          this.ai.state = 'done';
          this.ai.changed = m.changed || 0;
          if (m.text) this.live.textContent = m.text;
        }
        break;
      case 'error': this.ai = { turn: m.turnId, state: 'error', text: m.message }; this.live.textContent = m.message; break;
      case 'cancelled': if (this.ai?.turn === m.turnId) this.ai = null; break;
      default: break;
    }
    this.renderAi();
    if (this.ai && (this.ai.state === 'done' || this.ai.state === 'error')) {
      this.aiTimer = setTimeout(() => { if (this.ai?.state === 'done' || this.ai?.state === 'error') { this.ai = null; this.renderAi(); } }, this.ai.changed ? 14000 : this.tv ? 9000 : 8000);
    }
  }

  onCaption(m) {
    clearTimeout(this.aiTimer);
    this.ai = { turn: 'cap', state: m.final ? 'done' : 'speaking', text: m.text, role: m.role, changed: 0 };
    this.renderAi();
    if (m.final) this.aiTimer = setTimeout(() => { this.ai = null; this.renderAi(); }, 6500);
  }

  renderAi() {
    const a = this.ai;
    const chips = [...this.pendingConfirms.values()].filter((p) => !p.boardId || p.boardId === this.s.boardId || this.tv);
    this.aiEl.classList.toggle('on', !!a || chips.length > 0);
    this.aiEl.replaceChildren();
    if (a) {
      const line = h('div', { class: `ai-line ${a.state} ${a.role === 'user' ? 'user' : ''}` });
      if (a.state === 'thinking' || a.state === 'working') {
        line.append(h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', { class: 'ai-label' }, a.state === 'working' ? `${a.label}…` : 'Thinking…'));
        if (a.text) line.append(h('span', { class: 'ai-text' }, a.text));
      } else if (a.text) {
        line.append(h('span', { class: 'ai-text' }, a.text));
      }
      this.aiEl.append(line);
      if (a.state === 'done' && a.changed > 0 && !this.tv) {
        this.aiEl.append(h('div', { class: 'chips' }, h('button', { class: 'chip', onclick: () => this.undoAi() }, h('span', { html: ICON.undo }), `Undo ${a.changed} change${a.changed > 1 ? 's' : ''}`)));
      }
    }
    for (const p of chips) {
      this.aiEl.append(h('div', { class: 'chips confirm' },
        h('span', { class: 'chip-text' }, p.summary),
        this.tv ? h('span', { class: 'chip-hint' }, 'Confirm on your phone, or just say yes')
          : [h('button', { class: 'chip ok', onclick: () => this.resolvePending(p.id, true) }, 'Confirm'), h('button', { class: 'chip', onclick: () => this.resolvePending(p.id, false) }, 'Cancel')]));
    }
  }

  async undoAi() {
    try {
      const r = await this.api.post(`/api/boards/${this.s.boardId}/undo-ai`);
      this.toast(r.ok === false ? r.error : 'Undone', r.ok === false ? 'error' : 'info');
      this.ai = null;
      this.renderAi();
    } catch (e) { this.toast(e.message, 'error'); }
  }

  async resolvePending(id, accept) {
    try {
      const r = await this.api.post('/api/ai/confirm', { id, accept });
      if (r.ok === false) this.toast(r.error, 'error');
    } catch (e) { this.toast(e.message, 'error'); }
    this.pendingConfirms.delete(id);
    this.renderAi();
  }

  // --------------------------------------------------------------------------------- overlays

  closeOverlay() {
    this.overlayCleanup?.(); this.overlayCleanup = null;
    this.overlay.hidden = true;
    this.overlay.replaceChildren();
    this.overlay.className = 'overlay';
  }

  openAsk(prefill = '') {
    if (this.tv || this.remote) return;
    this.closeOverlay();
    this.overlay.className = 'overlay ask-wrap';
    this.overlay.hidden = false;
    const input = h('input', { type: 'text', class: 'ask-input', placeholder: 'Ask or tell the assistant…', value: prefill, 'aria-label': 'Message the assistant', autocomplete: 'off', enterkeyhint: 'send' });
    const form = h('form', { class: 'ask-bar', onsubmit: async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      this.closeOverlay();
      try { await this.s.ask(text); } catch (err) { this.toast(err.message, 'error'); }
    } }, input, h('button', { class: 'ib send', type: 'submit', 'aria-label': 'Send', html: ICON.send }));
    this.overlay.replaceChildren(h('div', { class: 'scrim', onclick: () => this.closeOverlay() }), form);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /**
   * Ready-made widgets (stock, crypto, weather, clock, countdown, timer): pick one, fill in a setting or two, done.
   * With `editId`, it changes the settings of an existing template widget instead.
   */
  openWidgetPicker(editId = null) {
    if (this.tv || this.remote) return;
    this.closeOverlay();
    const editing = editId ? this.s.model.get(editId) : null;
    this.overlay.className = 'overlay sheet-wrap';
    this.overlay.hidden = false;
    const body = h('div', { class: 'picker' });
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-label': editing ? 'Widget settings' : 'Add a widget' }, body);
    this.overlay.replaceChildren(h('div', { class: 'scrim', onclick: () => this.closeOverlay() }), sheet);

    const showList = () => {
      body.replaceChildren(
        h('div', { class: 'picker-head' }, h('span', { html: ICON.widget }), h('span', {}, 'Add a widget')),
        h('div', { class: 'picker-grid' }, TEMPLATE_NAMES.map((name) => h('button', { class: 'pick', onclick: () => showForm(name) },
          h('b', {}, WIDGET_TEMPLATES[name].label), h('span', {}, WIDGET_TEMPLATES[name].description)))),
        h('div', { class: 'picker-note' }, 'Want something else? Ask the assistant to build it, for example "a habit tracker for my runs".'),
      );
    };

    const showForm = (name, current = {}) => {
      const t = WIDGET_TEMPLATES[name];
      const inputs = {};
      const fields = Object.entries(t.params).map(([key, spec]) => {
        const id = `wp-${key}`;
        let input;
        const cur = current[key] ?? (spec.kind === 'choice' || spec.kind === 'number' ? spec.def : '');
        if (spec.kind === 'choice') {
          input = h('select', { id }, spec.options.map((o) => h('option', { value: String(o), selected: String(o) === String(cur) }, CHOICE_LABEL[o] || String(o))));
        } else if (spec.kind === 'datetime') {
          input = h('input', { id, type: 'datetime-local', value: String(cur || '').slice(0, 16) });
        } else {
          input = h('input', {
            id, type: spec.kind === 'number' ? 'number' : 'text', value: Array.isArray(cur) ? cur.join(', ') : String(cur ?? ''),
            placeholder: spec.hint || '', autocomplete: 'off', autocapitalize: spec.upper ? 'characters' : 'off', spellcheck: 'false',
            ...(spec.kind === 'number' ? { min: spec.min, max: spec.max, step: 1 } : {}),
          });
        }
        inputs[key] = input;
        return h('div', { class: 'field' }, h('label', { for: id }, FIELD_LABEL[key] || key), input);
      });
      const err = h('div', { class: 'picker-err', role: 'alert' });
      for (const el of Object.values(inputs)) el.addEventListener('input', () => { err.textContent = ''; });
      const submit = (e) => {
        e.preventDefault();
        const raw = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
        let built;
        try { built = buildWidget(name, raw); } catch (ex) { err.textContent = ex.message; return; }
        if (editing) {
          const set = { html: built.html, params: built.params, template: name };
          if (!editing.title || editing.title === WIDGET_TEMPLATES[name].title(editing.params || {})) set.title = built.title;
          this.s.commit([{ op: 'patch', id: editing.id, set }], { label: 'Widget settings' });
        } else {
          const spot = this.s.freeSpot(built.w, built.h);
          const obj = { id: newId('w'), type: 'widget', title: built.title, html: built.html, template: name, params: built.params, x: Math.round(spot.x), y: Math.round(spot.y), w: built.w, h: built.h };
          this.s.create(obj, `Add ${t.label.toLowerCase()} widget`);
          this.s.setSelection([obj.id]);
        }
        this.closeOverlay();
      };
      body.replaceChildren(h('form', { class: 'picker-form', onsubmit: submit },
        h('div', { class: 'picker-head' },
          editing ? null : h('button', { type: 'button', class: 'ib', 'aria-label': 'Back', html: ICON.chevron, style: 'transform: rotate(90deg)', onclick: showList }),
          h('span', {}, editing ? `${t.label} settings` : t.label)),
        h('div', { class: 'picker-desc' }, t.description),
        ...fields, err,
        h('div', { class: 'picker-actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => this.closeOverlay() }, 'Cancel'),
          h('button', { type: 'submit', class: 'btn primary' }, editing ? 'Save' : 'Add to board'))));
      setTimeout(() => Object.values(inputs)[0]?.focus(), 30);
    };

    if (editing?.template && WIDGET_TEMPLATES[editing.template]) showForm(editing.template, editing.params || {});
    else showList();
  }

  openSearch() {
    if (this.tv) return;
    this.closeOverlay();
    this.overlay.className = 'overlay sheet-wrap';
    this.overlay.hidden = false;
    const input = h('input', { type: 'search', class: 'sheet-input', placeholder: 'Search every board…', 'aria-label': 'Search', autocomplete: 'off' });
    const list = h('div', { class: 'results', role: 'listbox' });
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (!q) { list.replaceChildren(); return; }
        try {
          const r = await this.api.get(`/api/search?q=${encodeURIComponent(q)}`);
          list.replaceChildren(...(r.objects.length ? r.objects.map((hit) => {
            const o = hit.object;
            const text = o.text || o.title || o.label || o.alt || o.name || o.type;
            return h('button', { class: 'result', role: 'option', onclick: () => this.gotoObject(hit.boardId, o.id) },
              h('span', { class: 'result-text' }, String(text).slice(0, 140)), h('span', { class: 'result-board' }, hit.board));
          }) : [h('div', { class: 'result-empty' }, 'Nothing found')]));
        } catch (e) { list.replaceChildren(h('div', { class: 'result-empty' }, e.message)); }
      }, 140);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') list.firstElementChild?.click(); });
    this.overlay.replaceChildren(h('div', { class: 'scrim', onclick: () => this.closeOverlay() }), h('div', { class: 'sheet' }, input, list));
    input.focus();
  }

  async gotoObject(boardId, objectId) {
    this.closeOverlay();
    if (boardId !== this.s.boardId) {
      await this.s.openBoard(boardId);
      await new Promise((r) => { const off = this.s.on('board', () => { off(); r(); }); setTimeout(r, 1500); });
    }
    this.s.setSelection([objectId]);
    this.s.fitContent(true, [objectId]);
  }

  toggleBoards() {
    if (!this.overlay.hidden && this.overlay.classList.contains('menu-wrap')) { this.closeOverlay(); return; }
    this.closeOverlay();
    this.overlay.className = 'overlay menu-wrap';
    this.overlay.hidden = false;
    this.renderBoardsMenu();
  }

  renderBoardsMenu() {
    if (this.overlay.hidden || !this.overlay.classList.contains('menu-wrap')) return;
    const boards = this.s.boards;
    const thoughts = boards.filter((b) => b.kind === 'thoughts');
    const spaces = boards.filter((b) => b.kind === 'space');
    const row = (b) => h('div', { class: `menu-row ${b.id === this.s.boardId ? 'active' : ''}` },
      h('button', { class: 'menu-main', role: 'menuitem', onclick: () => { this.s.openBoard(b.id); this.closeOverlay(); } }, h('span', { class: 'menu-name' }, b.name), h('span', { class: 'menu-count' }, String(b.count))),
      this.iconBtn('tv', `Show ${b.name} on the TV`, () => { this.s.net.display({ boardId: b.id }); this.toast(`Showing ${b.name} on the TV`); this.closeOverlay(); }));
    const name = h('button', { class: 'menu-new', onclick: () => openNewBoard(this) }, '+ New board from template');
    this.overlay.replaceChildren(h('div', { class: 'scrim clear', onclick: () => this.closeOverlay() }),
      h('div', { class: 'menu', role: 'menu' },
        h('div', { class: 'menu-label' }, 'Thoughts'), ...thoughts.map(row),
        h('div', { class: 'menu-label' }, 'Spaces'), ...spaces.map(row), name));
  }

  async showOnTv() {
    this.s.net.display({ boardId: this.s.boardId });
    this.toast('Showing this board on the TV');
  }
}
