import { rid, clamp } from '../util.js';
import { StoreError } from '../store.js';
import {
  COLORS, NOTE_WIDTH, estimateNoteHeight, bounds, unionBounds, objectText, rectContains, codeHash, WIDGET_HTML_MAX,
} from '../../../web/shared/schema.js';
import { findFreeSpot, nextFlowSlot, layoutGrid, layoutColumns, layoutGraph } from '../../../web/shared/layout.js';
import { boardContext } from './context.js';
import { isImageMime } from '../assets.js';

export class ToolError extends Error {}

const nid = (p) => rid(p, 9);
const snip = (s, n = 90) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Everything a tool needs for one AI turn (or one Live session call). */
export class ToolContext {
  constructor({ store, hub, assets, pending, settings, secrets = null, widgets = null, boardId, turnId, selection = [], anchor = null, live = false }) {
    Object.assign(this, { store, hub, assets, pending, settings, secrets, widgets, boardId, turnId, selection, live });
    this.anchorHint = anchor;
    this.batches = [];
    this.snapshotted = false;
    this.imagesForNextTurn = [];
    this.skipReply = false;
    this.changed = 0;
    this.touched = new Set();
  }

  /** Ids created/changed since the last call; the agent uses them to bring new content into view on the TV. */
  takeTouched() {
    const ids = [...this.touched];
    this.touched.clear();
    return ids;
  }

  board() {
    return this.store.mustBoard(this.boardId);
  }

  must(id) {
    const o = typeof id === 'string' ? this.store.getObject(this.boardId, id) : null;
    if (!o) throw new ToolError(`No object with id "${id}" on this board. Check the board snapshot, or call search_board.`);
    return o;
  }

  all() {
    return this.store.getObjects(this.boardId);
  }

  anchor() {
    const d = this.hub?.display;
    if (d && d.boardId === this.boardId && d.cam) return { x: d.cam.x, y: d.cam.y };
    if (this.anchorHint && Number.isFinite(this.anchorHint.x)) return this.anchorHint;
    const objs = this.all();
    const map = new Map(objs.map((o) => [o.id, o]));
    const u = unionBounds(objs.map((o) => bounds(o, (id) => map.get(id))));
    return u ? { x: u.x + u.w / 2, y: u.y + u.h / 2 } : { x: 0, y: 0 };
  }

  /** Bounds of everything a new item should avoid. Frames are containers, so they only count when asked. */
  obstacles({ frames = false } = {}) {
    const objs = this.all();
    return objs.filter((o) => o.type !== 'arrow' && (frames || o.type !== 'frame')).map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }));
  }

  apply(ops, label) {
    if (!this.snapshotted) {
      this.store.createSnapshot(this.boardId, `Before: ${snip(label, 60)}`);
      this.snapshotted = true;
    }
    const out = this.store.applyBatch(this.boardId, ops, { actor: 'ai', label, turnId: this.turnId });
    if (out.batchId) this.batches.push(out.batchId);
    this.changed += out.ops.length;
    for (const op of out.ops) if (op.op !== 'del') this.touched.add(op.op === 'put' ? op.obj.id : op.id);
    return out;
  }
}

// ------------------------------------------------------------------ helpers

function reqStr(v, name, max = 20000) {
  if (typeof v !== 'string' || !v.trim()) throw new ToolError(`${name} is required and must be non-empty text`);
  if (v.length > max) throw new ToolError(`${name} is too long (max ${max} characters)`);
  return v.trim();
}

function optStr(v, name, max = 2000) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ToolError(`${name} must be text`);
  if (v.length > max) throw new ToolError(`${name} is too long`);
  return v;
}

function reqArr(v, name, min = 1, max = 100) {
  if (!Array.isArray(v) || v.length < min) throw new ToolError(`${name} must be a list with at least ${min} item(s)`);
  if (v.length > max) throw new ToolError(`${name} can have at most ${max} items`);
  return v;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const TEXT_PROP = { note: 'text', text: 'text', shape: 'text', frame: 'title', arrow: 'label', link: 'title', image: 'alt', file: 'name', widget: 'title' };

function nodeSize(label, detail) {
  const text = detail ? `${label}\n${detail}` : label;
  const longest = Math.max(...text.split('\n').map((l) => l.length));
  const w = clamp(Math.round(longest * 8.2 + 48), 150, 320);
  const perLine = Math.max(8, Math.floor((w - 32) / 8.2));
  let lines = 0;
  for (const p of text.split('\n')) lines += Math.max(1, Math.ceil(p.length / perLine));
  return { w, h: clamp(lines * 21 + 44, 64, 240) };
}

function containedIds(frame, objs) {
  return objs.filter((o) => o.id !== frame.id && o.type !== 'frame' && o.type !== 'arrow'
    && rectContains(frame, o)).map((o) => o.id);
}

const idList = (v, name = 'ids', max = 200) => reqArr(v, name, 1, max).map((x) => {
  if (typeof x !== 'string') throw new ToolError(`${name} must be a list of id strings`);
  return x;
});

// ------------------------------------------------------------------ registry

const TOOLS = new Map();
function def(name, description, parameters, run) {
  TOOLS.set(name, { decl: { name, description, parameters }, run });
}

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const N = (description) => ({ type: 'number', description });
const B = (description) => ({ type: 'boolean', description });
const A = (items, description) => ({ type: 'array', items, description });
const O = (properties, required = [], description) => ({ type: 'object', properties, required, description });

// ---- reading

def('read_board',
  'Get a fresh snapshot of the current board: every object with its id, type, text and position. Call this if you need the latest state.',
  O({}),
  (a, ctx) => ({ ok: true, snapshot: boardContext({ store: ctx.store, pending: ctx.pending, widgets: ctx.widgets, boardId: ctx.boardId, selection: ctx.selection, anchor: ctx.anchor() }) }));

def('read_objects',
  'Read the full text and properties of specific objects (the snapshot only shows shortened text).',
  O({ ids: A(S('object id'), 'Up to 30 object ids') }, ['ids']),
  (a, ctx) => {
    const ids = idList(a.ids, 'ids', 30);
    return { ok: true, objects: ids.map((id) => { const o = ctx.store.getObject(ctx.boardId, id); return o ? { ...o, text: objectText(o) } : { id, missing: true }; }) };
  });

def('search_board',
  'Find notes and other objects by keywords. Searches the current board by default; use scope "everywhere" for all boards.',
  O({ query: S('Keywords to look for'), scope: S('board or everywhere', { enum: ['board', 'everywhere'] }), limit: N('Max results, default 10') }, ['query']),
  (a, ctx) => {
    const query = reqStr(a.query, 'query', 300);
    const hits = ctx.store.searchObjects(query, { boardId: a.scope === 'everywhere' ? undefined : ctx.boardId, limit: clamp(a.limit || 10, 1, 25) });
    return {
      ok: true,
      results: hits.map((h) => ({
        id: h.object.id, boardId: h.boardId, board: h.boardName, type: h.object.type, tag: h.object.tag || undefined,
        text: snip(objectText(h.object), 200), x: Math.round(h.object.x ?? 0), y: Math.round(h.object.y ?? 0),
      })),
    };
  });

def('recall',
  'Remember what the user was working on. Returns the notes they created and the things they said in a time window, and/or messages and notes matching keywords. Use ISO 8601 times for since/until.',
  O({
    since: S('Start of the window, ISO 8601 with offset, e.g. 2026-10-18T00:00:00-07:00'),
    until: S('End of the window, ISO 8601'),
    query: S('Optional keywords'),
    scope: S('board or everywhere (default everywhere)', { enum: ['board', 'everywhere'] }),
  }),
  (a, ctx) => {
    const boardId = a.scope === 'board' ? ctx.boardId : undefined;
    const out = { ok: true, notes: [], said: [], matches: [] };
    if (a.since || a.until) {
      const from = a.since ? Date.parse(a.since) : Date.now() - 86_400_000;
      const to = a.until ? Date.parse(a.until) : Date.now();
      if (!Number.isFinite(from) || !Number.isFinite(to)) throw new ToolError('since/until must be ISO 8601 date-times');
      const act = ctx.store.activityBetween(from, to, { boardId, limit: 40 });
      out.notes = act.notes.map((n) => ({ board: n.boardName, text: snip(objectText(n.object), 220), when: new Date(n.object.t).toISOString() }));
      out.said = act.messages.map((m) => ({ text: snip(m.text, 220), when: new Date(m.ts).toISOString() }));
    }
    if (a.query) {
      const q = reqStr(a.query, 'query', 300);
      out.matches = [
        ...ctx.store.searchObjects(q, { boardId, limit: 8 }).map((h) => ({ kind: 'note', board: h.boardName, id: h.object.id, text: snip(objectText(h.object), 220) })),
        ...ctx.store.searchMessages(q, { boardId, limit: 8 }).map((m) => ({ kind: 'said', text: snip(m.text, 220), when: new Date(m.ts).toISOString() })),
      ];
    }
    if (!a.since && !a.until && !a.query) throw new ToolError('Give a time window (since/until) and/or a query');
    return out;
  });

def('list_boards', 'List all boards (the Thoughts inbox and project spaces).', O({}),
  (a, ctx) => ({ ok: true, boards: ctx.store.listBoards().map((b) => ({ id: b.id, name: b.name, kind: b.kind, objects: b.count })) }));

def('view_images',
  'Look at images that are on the board but not attached to the current message. Pass image object ids or asset ids. The images become visible to you on your next step.',
  O({ ids: A(S('image object id or asset id'), 'Up to 4 images') }, ['ids']),
  (a, ctx) => {
    const ids = idList(a.ids, 'ids', 4);
    const seen = [];
    for (const id of ids) {
      const obj = ctx.store.getObject(ctx.boardId, id);
      const assetId = obj?.asset || id;
      const asset = ctx.assets.get(assetId);
      if (!asset || !isImageMime(asset.mime)) throw new ToolError(`"${id}" is not an image on this board`);
      if (ctx.live) { seen.push({ id, caption: asset.caption || obj?.alt || '(no description yet)' }); continue; }
      const file = ctx.assets.read(assetId);
      if (file.data.length > 6 * 1024 * 1024) throw new ToolError(`Image ${id} is too large to look at`);
      ctx.imagesForNextTurn.push({ mime: asset.mime, data: file.data.toString('base64'), id });
      seen.push({ id, viewing: true });
    }
    return ctx.live
      ? { ok: true, note: 'Live mode cannot show you the image directly; here are stored descriptions.', images: seen }
      : { ok: true, images: seen, note: 'The images are attached to your next step.' };
  });

// ---- creating

def('add_notes',
  'Put one or more notes on the board. Use for ideas, facts, questions and suggestions the user wants visible. Keep each note short. Positions are chosen automatically (next to nearId, or near what the user is looking at) unless x and y are given.',
  O({
    notes: A(O({
      text: S('Note text. Short: usually under 200 characters.'),
      tag: S('idea = the user\'s own idea; fact = something you are confident is true; suggestion = your own proposal; question = open question', { enum: ['idea', 'fact', 'suggestion', 'question'] }),
      color: S('Optional color', { enum: COLORS }),
      nearId: S('Place next to this existing object id'),
      x: N('Explicit canvas x (optional)'),
      y: N('Explicit canvas y (optional)'),
    }, ['text']), 'Notes to create (1-30)'),
    sectionTitle: S('If given, wrap the new notes in a titled section'),
    layout: S('How to arrange several notes', { enum: ['auto', 'row', 'column', 'grid'] }),
  }, ['notes']),
  (a, ctx) => {
    const specs = reqArr(a.notes, 'notes', 1, 30).map((n, i) => ({
      text: reqStr(n?.text, `notes[${i}].text`, 4000), tag: n.tag || '', color: n.color, nearId: n.nearId, x: num(n.x), y: num(n.y),
    }));
    const board = ctx.board();
    const items = specs.map((s) => {
      const o = { id: nid('n_'), type: 'note', text: s.text, w: NOTE_WIDTH, h: estimateNoteHeight(s.text, NOTE_WIDTH, 'm'), origin: 'ai' };
      if (s.tag) o.tag = s.tag;
      if (s.color) o.color = s.color;
      return o;
    });
    const ops = [];
    const sectionTitle = optStr(a.sectionTitle, 'sectionTitle', 200);

    if (specs.every((s) => s.x !== undefined && s.y !== undefined)) {
      items.forEach((o, i) => { o.x = specs[i].x; o.y = specs[i].y; });
    } else if (board.kind === 'thoughts' && !sectionTitle) {
      const placed = ctx.obstacles({ frames: true });
      items.forEach((o) => {
        const slot = nextFlowSlot(placed, o.w, o.h, { cols: 4, colW: NOTE_WIDTH, gap: 24 });
        o.x = slot.x; o.y = slot.y;
        placed.push({ x: o.x, y: o.y, w: o.w, h: o.h });
      });
    } else {
      const n = items.length;
      const cols = a.layout === 'row' ? n : a.layout === 'column' ? 1 : a.layout === 'grid' ? clamp(Math.ceil(Math.sqrt(n)), 1, 4) : n <= 1 ? 1 : n <= 4 ? 2 : 3;
      const rel = layoutGrid(items, { cols, gap: 24 });
      const blk = unionBounds(items.map((o) => ({ x: rel.get(o.id).x, y: rel.get(o.id).y, w: o.w, h: o.h })));
      const PAD = sectionTitle ? 36 : 0;
      const TITLE = sectionTitle ? 44 : 0;
      const bw = blk.w + PAD * 2;
      const bh = blk.h + PAD * 2 + TITLE;
      const near = specs.find((s) => s.nearId)?.nearId;
      let anchor = ctx.anchor();
      if (near) {
        const t = ctx.must(near);
        anchor = { x: t.x + t.w + 70 + bw / 2, y: t.y + t.h / 2 };
      }
      const spot = findFreeSpot(ctx.obstacles(), bw, bh, anchor);
      items.forEach((o) => { o.x = spot.x + PAD + rel.get(o.id).x; o.y = spot.y + PAD + TITLE + rel.get(o.id).y; });
      if (sectionTitle) {
        ops.push({ op: 'put', obj: { id: nid('f_'), type: 'frame', title: sectionTitle, x: spot.x, y: spot.y, w: bw, h: bh, color: 'gray', origin: 'ai' } });
      }
    }
    for (const o of items) ops.push({ op: 'put', obj: o });
    ctx.apply(ops, `Added ${items.length} note${items.length > 1 ? 's' : ''}: ${snip(items[0].text, 40)}`);
    return { ok: true, created: items.map((o) => ({ id: o.id, text: snip(o.text, 60) })) };
  });

def('create_diagram',
  'Create a diagram: boxes (nodes) connected by arrows. Also use this to ADD to an existing diagram: reference existing object ids in edges (from/to) and the new nodes are placed next to what they connect to. Node keys are short names you invent; edges refer to node keys or existing ids.',
  O({
    title: S('Optional title; wraps a brand-new diagram in a titled section'),
    nodes: A(O({
      key: S('Short unique name for this node, used by edges'),
      label: S('Text inside the box, a few words'),
      detail: S('Optional second line, smaller detail'),
      shape: S('Box shape', { enum: ['rect', 'pill', 'ellipse', 'diamond'] }),
      color: S('Optional color', { enum: COLORS }),
    }, ['key', 'label']), 'Nodes to create (1-40)'),
    edges: A(O({
      from: S('node key or existing object id'),
      to: S('node key or existing object id'),
      label: S('Optional label on the arrow'),
      dashed: B('Dashed line for weaker/optional relations'),
    }, ['from', 'to']), 'Connections'),
    direction: S('Flow direction: LR left-to-right (default) or TB top-to-bottom', { enum: ['LR', 'TB'] }),
  }, ['nodes']),
  (a, ctx) => {
    const nodes = reqArr(a.nodes, 'nodes', 1, 40);
    const edgesIn = a.edges === undefined ? [] : reqArr(a.edges, 'edges', 0, 80);
    const keyToId = new Map();
    const specs = nodes.map((n, i) => {
      const key = reqStr(n?.key, `nodes[${i}].key`, 40);
      if (keyToId.has(key)) throw new ToolError(`Duplicate node key "${key}"`);
      keyToId.set(key, nid('s_'));
      const label = reqStr(n.label, `nodes[${i}].label`, 300);
      const detail = optStr(n.detail, 'detail', 400);
      const size = nodeSize(label, detail);
      return { key, id: keyToId.get(key), label, detail, shape: n.shape || 'rect', color: n.color || 'blue', ...size };
    });
    const resolve = (ref, where) => {
      if (keyToId.has(ref)) return { id: keyToId.get(ref), isNew: true };
      const existing = typeof ref === 'string' ? ctx.store.getObject(ctx.boardId, ref) : null;
      if (existing && existing.type !== 'arrow') return { id: existing.id, isNew: false, obj: existing };
      throw new ToolError(`${where}: "${ref}" is neither a node key in this call nor an object id on the board`);
    };
    const edges = edgesIn.map((e, i) => ({
      from: resolve(e?.from, `edges[${i}].from`), to: resolve(e?.to, `edges[${i}].to`),
      label: optStr(e.label, 'label', 200), dashed: !!e.dashed,
    }));

    const dir = a.direction === 'TB' ? 'TB' : 'LR';
    const touchesExisting = edges.some((e) => !e.from.isNew || !e.to.isNew);
    const placed = new Map();
    const ops = [];
    const obstacles = ctx.obstacles();
    // Leave room between boxes for the longest edge label so labels never sit on top of a box.
    const longestLabel = Math.max(0, ...edges.map((e) => (e.label || '').length));
    const flowGap = longestLabel ? clamp(Math.round(longestLabel * 7.5 + 56), 80, 280) : 64;

    if (!touchesExisting) {
      const layout = layoutGraph(specs.map((s) => ({ id: s.id, w: s.w, h: s.h })),
        edges.map((e) => ({ from: e.from.id, to: e.to.id })), { direction: dir, hgap: dir === 'LR' ? flowGap : 56, vgap: dir === 'TB' ? Math.max(76, longestLabel ? 84 : 76) : 56 });
      const blk = unionBounds(specs.map((s) => ({ ...layout.get(s.id), w: s.w, h: s.h })));
      const title = optStr(a.title, 'title', 200);
      const PAD = title ? 36 : 0;
      const TITLE = title ? 44 : 0;
      const bw = blk.w + PAD * 2;
      const bh = blk.h + PAD * 2 + TITLE;
      const spot = findFreeSpot(obstacles, bw, bh, ctx.anchor());
      for (const s of specs) {
        const p = layout.get(s.id);
        placed.set(s.id, { x: spot.x + PAD + (p.x - blk.x), y: spot.y + PAD + TITLE + (p.y - blk.y) });
      }
      if (title) ops.push({ op: 'put', obj: { id: nid('f_'), type: 'frame', title, x: spot.x, y: spot.y, w: bw, h: bh, color: 'gray', origin: 'ai' } });
    } else {
      // Extend an existing diagram: drop each new node beside the thing(s) it connects to.
      const centers = (id) => {
        if (placed.has(id)) { const s = specs.find((x) => x.id === id); const p = placed.get(id); return { x: p.x + s.w / 2, y: p.y + s.h / 2, w: s.w, h: s.h }; }
        const o = ctx.store.getObject(ctx.boardId, id);
        return o ? { x: o.x + o.w / 2, y: o.y + o.h / 2, w: o.w, h: o.h } : null;
      };
      const taken = [...obstacles];
      for (const s of specs) {
        const neighbors = edges
          .filter((e) => e.from.id === s.id || e.to.id === s.id)
          .map((e) => centers(e.from.id === s.id ? e.to.id : e.from.id))
          .filter(Boolean);
        const nb = neighbors[0];
        let anchor = ctx.anchor();
        if (neighbors.length) {
          const cx = neighbors.reduce((m, n) => m + n.x, 0) / neighbors.length;
          const cy = neighbors.reduce((m, n) => m + n.y, 0) / neighbors.length;
          anchor = dir === 'LR' ? { x: cx + nb.w / 2 + Math.max(110, flowGap) + s.w / 2, y: cy } : { x: cx, y: cy + nb.h / 2 + 90 + s.h / 2 };
        }
        const spot = findFreeSpot(taken, s.w, s.h, anchor, { gap: 36 });
        placed.set(s.id, spot);
        taken.push({ x: spot.x, y: spot.y, w: s.w, h: s.h });
      }
    }

    for (const s of specs) {
      const p = placed.get(s.id);
      ops.push({ op: 'put', obj: {
        id: s.id, type: 'shape', shape: s.shape, text: s.detail ? `${s.label}\n${s.detail}` : s.label,
        color: s.color, fill: 'tint', x: p.x, y: p.y, w: s.w, h: s.h, origin: 'ai',
      } });
    }
    const arrowIds = [];
    for (const e of edges) {
      const id = nid('a_');
      arrowIds.push(id);
      const arrow = { id, type: 'arrow', from: { id: e.from.id }, to: { id: e.to.id }, origin: 'ai' };
      if (e.label) arrow.label = e.label;
      if (e.dashed) arrow.dash = true;
      ops.push({ op: 'put', obj: arrow });
    }
    ctx.apply(ops, `Diagram: ${snip(specs.map((s) => s.label).join(', '), 60)}`);
    return { ok: true, nodes: Object.fromEntries([...keyToId]), arrows: arrowIds.length };
  });

def('connect_objects',
  'Draw arrows between existing objects.',
  O({
    connections: A(O({
      from: S('source object id'), to: S('target object id'), label: S('optional label'), dashed: B('dashed line'),
    }, ['from', 'to']), 'Arrows to draw (1-40)'),
  }, ['connections']),
  (a, ctx) => {
    const list = reqArr(a.connections, 'connections', 1, 40);
    const existing = ctx.all().filter((o) => o.type === 'arrow');
    const ops = [];
    const made = [];
    for (const [i, c] of list.entries()) {
      const from = ctx.must(c?.from);
      const to = ctx.must(c?.to);
      if (from.id === to.id) throw new ToolError(`connections[${i}]: cannot connect an object to itself`);
      if (from.type === 'arrow' || to.type === 'arrow') throw new ToolError(`connections[${i}]: arrows cannot attach to arrows`);
      const dup = existing.find((x) => x.from?.id === from.id && x.to?.id === to.id);
      if (dup) {
        if (c.label && c.label !== dup.label) ops.push({ op: 'patch', id: dup.id, set: { label: c.label } });
        continue;
      }
      const arrow = { id: nid('a_'), type: 'arrow', from: { id: from.id }, to: { id: to.id }, origin: 'ai' };
      if (c.label) arrow.label = optStr(c.label, 'label', 200);
      if (c.dashed) arrow.dash = true;
      ops.push({ op: 'put', obj: arrow });
      made.push(arrow.id);
    }
    if (!ops.length) return { ok: true, note: 'Those objects are already connected.' };
    ctx.apply(ops, `Connected ${made.length || 'existing'} object${made.length === 1 ? '' : 's'}`);
    return { ok: true, arrows: made };
  });

def('create_section',
  'Create an empty titled section (a labelled region) for a project area. Position is chosen automatically unless given.',
  O({ title: S('Section title'), width: N('Width, default 700'), height: N('Height, default 460'), x: N('Optional x'), y: N('Optional y'), color: S('Optional color', { enum: COLORS }) }, ['title']),
  (a, ctx) => {
    const title = reqStr(a.title, 'title', 200);
    const w = clamp(num(a.width) || 700, 200, 6000);
    const h = clamp(num(a.height) || 460, 120, 6000);
    const spot = num(a.x) !== undefined && num(a.y) !== undefined ? { x: a.x, y: a.y } : findFreeSpot(ctx.obstacles({ frames: true }), w, h, ctx.anchor(), { gap: 40 });
    const id = nid('f_');
    ctx.apply([{ op: 'put', obj: { id, type: 'frame', title, x: spot.x, y: spot.y, w, h, color: a.color || 'gray', origin: 'ai' } }], `Section: ${snip(title, 40)}`);
    return { ok: true, id };
  });

def('group_into_section',
  'Wrap existing objects in a titled section, without moving them. Use to group related ideas.',
  O({ ids: A(S('object id'), 'Objects to group'), title: S('Section title'), color: S('Optional color', { enum: COLORS }) }, ['ids', 'title']),
  (a, ctx) => {
    const objs = idList(a.ids).map((id) => ctx.must(id)).filter((o) => o.type !== 'frame');
    if (!objs.length) throw new ToolError('Nothing to group (frames cannot be grouped)');
    const map = new Map(ctx.all().map((o) => [o.id, o]));
    const u = unionBounds(objs.map((o) => bounds(o, (id) => map.get(id))));
    const PAD = 36;
    const TITLE = 44;
    const id = nid('f_');
    ctx.apply([{ op: 'put', obj: {
      id, type: 'frame', title: reqStr(a.title, 'title', 200), x: Math.round(u.x - PAD), y: Math.round(u.y - PAD - TITLE),
      w: Math.round(u.w + PAD * 2), h: Math.round(u.h + PAD * 2 + TITLE), color: a.color || 'gray', origin: 'ai',
    } }], `Grouped ${objs.length} as "${snip(a.title, 30)}"`);
    return { ok: true, id, grouped: objs.length };
  });

// ---- changing

def('edit_object',
  'Change the text, color, tag or size of one existing object. Mode "append" adds to the existing text instead of replacing it. Replacing a long note the user wrote asks for confirmation.',
  O({
    id: S('Object id'),
    text: S('New text (for notes/text/shapes), title (sections, links), label (arrows) or description (images)'),
    mode: S('replace (default) or append', { enum: ['replace', 'append'] }),
    color: S('Color', { enum: COLORS }),
    tag: S('Note tag', { enum: ['idea', 'fact', 'suggestion', 'question'] }),
    size: S('Text size', { enum: ['s', 'm', 'l', 'xl'] }),
  }, ['id']),
  (a, ctx) => {
    const o = ctx.must(a.id);
    const set = {};
    const prop = TEXT_PROP[o.type];
    const apply = () => {
      if (a.color) set.color = a.color;
      if (a.tag && o.type === 'note') set.tag = a.tag;
      if (a.size && ['note', 'text', 'shape'].includes(o.type)) set.size = a.size;
      if (!Object.keys(set).length) throw new ToolError('Nothing to change: give text, color, tag or size');
      ctx.apply([{ op: 'patch', id: o.id, set }], `Edited ${o.type}: ${snip(set.text ?? objectText(o), 40)}`);
      return { ok: true, id: o.id };
    };
    if (a.text !== undefined) {
      if (!prop) throw new ToolError(`A ${o.type} has no text to edit`);
      const incoming = String(a.text);
      const cur = String(o[prop] || '');
      const next = a.mode === 'append' && cur ? `${cur}\n${incoming}` : incoming;
      set[prop] = next;
      if (a.mode !== 'append' && o.origin !== 'ai' && cur.length > 120 && next !== cur) {
        const p = ctx.pending.create({
          boardId: ctx.boardId, turnId: ctx.turnId,
          summary: `Replace your note "${snip(cur, 50)}" with new text`,
          run: () => apply(),
        });
        return { ok: false, status: 'needs_confirmation', pendingId: p.id, message: 'This would replace text the user wrote. Tell them what you want to change and ask for a yes.' };
      }
    }
    return apply();
  });

def('move_objects',
  'Move objects. Use dx/dy for relative moves ("to the right" is a positive dx), x/y to place their top-left corner, or nextTo to put them beside another object. Moving a section also moves what is inside it.',
  O({
    ids: A(S('object id'), 'Objects to move'),
    dx: N('Move right by this many units (negative = left)'),
    dy: N('Move down by this many units (negative = up)'),
    x: N('Absolute x of the group top-left'),
    y: N('Absolute y of the group top-left'),
    nextTo: O({ id: S('Reference object id'), side: S('Which side of the reference', { enum: ['right', 'left', 'above', 'below'] }), gap: N('Gap, default 48') }, ['id', 'side']),
  }, ['ids']),
  (a, ctx) => {
    const all = ctx.all();
    const map = new Map(all.map((o) => [o.id, o]));
    const set = new Set(idList(a.ids).map((id) => ctx.must(id).id));
    for (const id of [...set]) {
      const f = map.get(id);
      if (f.type === 'frame') for (const c of containedIds(f, all)) set.add(c);
    }
    const objs = [...set].map((id) => map.get(id));
    const boxes = objs.filter((o) => o.type !== 'arrow');
    const gb = unionBounds(boxes.map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h })));
    if (!gb) throw new ToolError('Only arrows were given; move the objects they connect instead');
    let dx = 0;
    let dy = 0;
    if (a.nextTo) {
      const t = ctx.must(a.nextTo.id);
      const gap = num(a.nextTo.gap) ?? 48;
      const target = { right: [t.x + t.w + gap, t.y + (t.h - gb.h) / 2], left: [t.x - gap - gb.w, t.y + (t.h - gb.h) / 2], above: [t.x + (t.w - gb.w) / 2, t.y - gap - gb.h], below: [t.x + (t.w - gb.w) / 2, t.y + t.h + gap] }[a.nextTo.side];
      if (!target) throw new ToolError('nextTo.side must be right, left, above or below');
      dx = target[0] - gb.x; dy = target[1] - gb.y;
    } else if (num(a.x) !== undefined && num(a.y) !== undefined) {
      dx = a.x - gb.x; dy = a.y - gb.y;
    } else {
      dx = num(a.dx) || 0; dy = num(a.dy) || 0;
    }
    dx = Math.round(dx); dy = Math.round(dy);
    if (!dx && !dy) throw new ToolError('Give dx/dy, x/y or nextTo');
    const ops = [];
    for (const o of objs) {
      if (o.type === 'arrow') {
        const patch = {};
        for (const end of ['from', 'to']) if (o[end] && !o[end].id) patch[end] = { x: o[end].x + dx, y: o[end].y + dy };
        if (Object.keys(patch).length) ops.push({ op: 'patch', id: o.id, set: patch });
      } else {
        ops.push({ op: 'patch', id: o.id, set: { x: o.x + dx, y: o.y + dy } });
      }
    }
    if (!ops.length) return { ok: true, note: 'Nothing needed to move.' };
    ctx.apply(ops, `Moved ${boxes.length} object${boxes.length === 1 ? '' : 's'}`);
    return { ok: true, moved: boxes.length, dx, dy };
  });

def('resize_object',
  'Resize one object. Give width and/or height, or a scale factor. Images keep their proportions when only one dimension is given.',
  O({ id: S('Object id'), width: N('New width'), height: N('New height'), scale: N('Multiply size by this factor (e.g. 1.5)') }, ['id']),
  (a, ctx) => {
    const o = ctx.must(a.id);
    if (o.type === 'arrow') throw new ToolError('Arrows cannot be resized');
    let w = o.w;
    let h = o.h;
    if (num(a.scale)) { w *= a.scale; h *= a.scale; }
    if (num(a.width) && num(a.height)) { w = a.width; h = a.height; }
    else if (num(a.width)) { h = ['image', 'draw'].includes(o.type) ? o.h * (a.width / o.w) : o.h; w = a.width; }
    else if (num(a.height)) { w = ['image', 'draw'].includes(o.type) ? o.w * (a.height / o.h) : o.w; h = a.height; }
    w = clamp(Math.round(w), 24, 20000); h = clamp(Math.round(h), 24, 20000);
    const set = { w, h };
    if (o.type === 'note' && h !== o.h && !num(a.scale)) set.autoH = false;
    ctx.apply([{ op: 'patch', id: o.id, set }], `Resized ${o.type}`);
    return { ok: true, id: o.id, w, h };
  });

def('organize_objects',
  'Tidy objects into a neat arrangement without changing their text. Pass "sections" to cluster related objects into titled groups (you decide the grouping). Without ids it uses the user\'s selection, or the whole board if small.',
  O({
    ids: A(S('object id'), 'Objects to arrange (defaults to the selection)'),
    layout: S('grid (default), columns, row or column', { enum: ['grid', 'columns', 'row', 'column'] }),
    columns: N('Number of columns for grid/columns'),
    sections: A(O({ title: S('Section title'), ids: A(S('object id'), 'Members of this section') }, ['title', 'ids']), 'Cluster into titled sections instead of one layout'),
  }),
  (a, ctx) => {
    const all = ctx.all();
    const map = new Map(all.map((o) => [o.id, o]));
    let ids;
    if (Array.isArray(a.sections) && a.sections.length) {
      ids = a.sections.flatMap((s) => (Array.isArray(s?.ids) ? s.ids : []));
    } else if (Array.isArray(a.ids) && a.ids.length) {
      ids = a.ids;
    } else if (ctx.selection.length) {
      ids = ctx.selection;
    } else {
      ids = all.filter((o) => o.type !== 'arrow' && o.type !== 'frame').map((o) => o.id);
      if (ids.length > 80) throw new ToolError('The board is large; pass specific ids to organize');
    }
    const pick = (list) => [...new Set(list)].map((id) => ctx.must(id)).filter((o) => o.type !== 'arrow' && o.type !== 'frame' && !o.locked);
    const objs = pick(ids);
    if (!objs.length) throw new ToolError('Nothing to organize');
    const origin = unionBounds(objs.map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h })));
    const ops = [];

    if (Array.isArray(a.sections) && a.sections.length) {
      const PAD = 36;
      const TITLE = 44;
      const blocks = a.sections.map((s) => {
        const members = pick(Array.isArray(s?.ids) ? s.ids : []);
        const cols = clamp(Math.ceil(Math.sqrt(members.length)), 1, 3);
        const rel = layoutGrid(members, { cols, gap: 22 });
        const blk = unionBounds(members.map((o) => ({ x: rel.get(o.id).x, y: rel.get(o.id).y, w: o.w, h: o.h })));
        return { title: reqStr(s.title, 'section title', 200), members, rel, blk };
      }).filter((b) => b.members.length);
      let cx = origin.x;
      let cy = origin.y;
      let rowH = 0;
      for (const b of blocks) {
        const w = b.blk.w + PAD * 2;
        const h = b.blk.h + PAD * 2 + TITLE;
        if (cx > origin.x && cx + w > origin.x + 3000) { cx = origin.x; cy += rowH + 60; rowH = 0; }
        ops.push({ op: 'put', obj: { id: nid('f_'), type: 'frame', title: b.title, x: cx, y: cy, w, h, color: 'gray', origin: 'ai' } });
        for (const o of b.members) ops.push({ op: 'patch', id: o.id, set: { x: cx + PAD + b.rel.get(o.id).x, y: cy + PAD + TITLE + b.rel.get(o.id).y } });
        cx += w + 60;
        rowH = Math.max(rowH, h);
      }
    } else {
      const layout = a.layout || 'grid';
      const cols = clamp(num(a.columns) || (layout === 'row' ? objs.length : layout === 'column' ? 1 : Math.ceil(Math.sqrt(objs.length))), 1, 12);
      const sorted = [...objs].sort((p, q) => Math.round(p.y / 100) - Math.round(q.y / 100) || p.x - q.x);
      const pos = layout === 'columns' || layout === 'column'
        ? layoutColumns(sorted, { x: origin.x, y: origin.y, cols })
        : layoutGrid(sorted, { x: origin.x, y: origin.y, cols });
      for (const o of sorted) ops.push({ op: 'patch', id: o.id, set: { x: Math.round(pos.get(o.id).x), y: Math.round(pos.get(o.id).y) } });
    }
    ctx.apply(ops, `Organized ${objs.length} objects`);
    return { ok: true, organized: objs.length, sections: a.sections?.length || 0 };
  });

// ---- removing, undoing

def('delete_objects',
  'Delete objects from the board. Deleting more than a couple of things, long notes, images or sections asks the user to confirm first. Deletion can be undone.',
  O({ ids: A(S('object id'), 'Objects to delete'), reason: S('Why, in a few words') }, ['ids']),
  (a, ctx) => {
    const objs = [...new Set(idList(a.ids))].map((id) => ctx.must(id));
    const textLen = objs.reduce((n, o) => n + objectText(o).length, 0);
    const heavy = objs.length > 2 || textLen > 300 || objs.some((o) => ['image', 'file', 'frame', 'widget'].includes(o.type));
    const doDelete = () => {
      ctx.apply(objs.map((o) => ({ op: 'del', id: o.id })), `Deleted ${objs.length} object${objs.length === 1 ? '' : 's'}`);
      return { ok: true, deleted: objs.length };
    };
    if (!heavy) return doDelete();
    const what = objs.length === 1 ? `"${snip(objectText(objs[0]) || objs[0].type, 40)}"` : `${objs.length} objects`;
    const p = ctx.pending.create({ boardId: ctx.boardId, turnId: ctx.turnId, summary: `Delete ${what}`, run: doDelete });
    return { ok: false, status: 'needs_confirmation', pendingId: p.id, message: `Tell the user you are about to delete ${what} and ask whether to go ahead. Do not call resolve_pending until they answer.` };
  });

function aiTurnBatches(ctx, undone) {
  const last = ctx.store.lastBatch(ctx.boardId, { actor: 'ai', undone });
  if (!last) return [];
  if (!last.turnId) return [last];
  return ctx.store.db.prepare('SELECT id, label FROM batches WHERE board_id = ? AND turn_id = ? AND actor = ? AND undone = ? ORDER BY ts DESC, rowid DESC')
    .all(ctx.boardId, last.turnId, 'ai', undone ? 1 : 0);
}

def('undo_ai_change',
  'Undo your most recent changes to this board (everything you changed in your last turn). Things the user edited afterwards are left alone.',
  O({}),
  (a, ctx) => {
    const batches = aiTurnBatches(ctx, false);
    if (!batches.length) return { ok: false, error: 'There is nothing of mine to undo on this board.' };
    let restored = 0;
    let skipped = 0;
    for (const b of batches) {
      const r = ctx.store.revertBatch(b.id, 'undo', { actor: 'undo' });
      restored += r.restored; skipped += r.skipped;
    }
    return { ok: true, undone: batches.map((b) => b.label).filter(Boolean), restored, skippedBecauseEditedSince: skipped };
  });

def('redo_ai_change', 'Redo the changes you just undid.', O({}),
  (a, ctx) => {
    const batches = aiTurnBatches(ctx, true).reverse();
    if (!batches.length) return { ok: false, error: 'There is nothing to redo.' };
    let restored = 0;
    for (const b of batches) restored += ctx.store.revertBatch(b.id, 'redo', { actor: 'undo' }).restored;
    return { ok: true, restored };
  });

def('list_versions', 'List saved earlier versions of this board (automatic snapshots taken before AI changes, and manual ones).', O({}),
  (a, ctx) => ({
    ok: true,
    versions: ctx.store.listSnapshots(ctx.boardId, 15).map((s) => ({ id: s.id, when: new Date(s.ts).toISOString(), label: s.label || 'Saved version', objects: s.count })),
  }));

def('restore_version',
  'Restore the board to an earlier version. Asks the user to confirm; the current state is saved as a version first, so it can be undone.',
  O({ versionId: S('Version id from list_versions') }, ['versionId']),
  (a, ctx) => {
    const v = ctx.store.listSnapshots(ctx.boardId, 100).find((s) => s.id === a.versionId);
    if (!v) throw new ToolError('No such version. Call list_versions first.');
    const p = ctx.pending.create({
      boardId: ctx.boardId, turnId: ctx.turnId,
      summary: `Go back to the version from ${new Date(v.ts).toLocaleString('en-US', { timeZone: ctx.tz })} (${v.count} objects)`,
      run: () => {
        const r = ctx.store.restoreSnapshot(ctx.boardId, v.id, { actor: 'ai' });
        return { restored: true, changes: r.ops.length };
      },
    });
    return { ok: false, status: 'needs_confirmation', pendingId: p.id, message: 'Tell the user which version you would restore and ask for a yes. Do not call resolve_pending until they answer.' };
  });

def('resolve_pending',
  'Carry out or cancel an action that was waiting for the user\'s confirmation. Only call this AFTER the user has answered yes or no in a new message.',
  O({ id: S('pendingId from the earlier needs_confirmation result'), accept: B('true if the user said yes') }, ['id', 'accept']),
  (a, ctx) => ctx.pending.resolve(a.id, !!a.accept, { viaUser: false, boardId: ctx.boardId }));

def('forget_recent',
  'Honor "don\'t save that": delete the most recent exchanges from conversation memory. Does not touch notes already on the board.',
  O({ count: N('How many earlier messages to forget besides this request, default 2') }),
  (a, ctx) => {
    const n = clamp(Math.round(num(a.count) ?? 2), 1, 10);
    const ids = ctx.store.recentMessageIds(ctx.boardId, n + 1);
    ctx.store.deleteMessages(ids);
    ctx.skipReply = true;
    return { ok: true, forgotten: ids.length, note: 'Forgotten. Confirm briefly to the user; this reply will not be stored either.' };
  });

// ---- widgets (live mini-apps) and the API keys they use

const WIDGET_WAIT_MS = 9000;

/** Quick checks that catch the usual mistakes before the code ever runs. */
function checkWidgetHtml(html) {
  const code = reqStr(html, 'html', WIDGET_HTML_MAX);
  if (/<script[^>]+\bsrc\s*=/i.test(code)) throw new ToolError('Do not load scripts with src: Chart.js is already available as the global Chart, and everything else must be inline.');
  if (/(?<!ob\.)\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|EventSource/.test(code)) throw new ToolError('The widget has no direct network access. Use await ob.fetch(url, options) instead of fetch/XMLHttpRequest/WebSocket.');
  if (/(?<![{])\{\{[A-Z][A-Z0-9_]*\}\}(?![}])/.test(code) && !/ob\.fetch/.test(code)) throw new ToolError('{{KEY}} placeholders only work inside ob.fetch URLs or headers.');
  return code;
}

async function firstRun(ctx, id, html) {
  if (!ctx.widgets) return { status: 'unknown' };
  const watching = ctx.hub?.watching?.(ctx.boardId);
  if (!watching) return { status: 'not_running_yet', note: 'No screen has this board open right now. The widget will start when the TV or the app shows it.' };
  ctx.hub.reveal?.(ctx.boardId, [id]);
  const r = await ctx.widgets.waitForReport(id, codeHash(html), WIDGET_WAIT_MS);
  if (!r) return { status: 'no_report', note: 'No screen reported back within a few seconds (it may be off screen). Check later with read_widget_logs.' };
  if (r.level === 'ready') return { status: 'running', shows: r.text || '(no visible text)' };
  if (r.level === 'needs_key') {
    const info = ctx.secrets?.info(r.message);
    return { status: 'waiting_for_key', key: r.message, keyRequested: !!info, note: info ? 'The widget will start by itself once the user saves the key in the app.' : `Call request_api_key for ${r.message} so the user gets a card to add it.` };
  }
  return { status: 'error', error: r.message, fix: 'Read the error, then call update_widget with corrected html.' };
}

def('create_widget',
  'Put a live widget on the board: a small self-contained web app (HTML, CSS, JavaScript) that runs on the TV and in the app, such as a stock or crypto ticker with a chart, weather, a countdown, a timer, a habit tracker or a calculator. Returns what happened when it first ran, so you can fix errors with update_widget.',
  O({
    title: S('Short title shown on the board, e.g. "NVDA live"'),
    html: S('The widget code: an HTML fragment with markup, <style> and inline <script>. See WIDGETS in your instructions for the runtime (ob.fetch, ob.every, ob.state, Chart).'),
    w: N('Width in canvas units (default 420; 200-1600)'),
    h: N('Height in canvas units (default 300; 120-1200)'),
    nearId: S('Place next to this object id'),
  }, ['title', 'html']),
  async (a, ctx) => {
    const title = reqStr(a.title, 'title', 200);
    const html = checkWidgetHtml(a.html);
    const w = clamp(Math.round(num(a.w) ?? 420), 200, 1600);
    const h = clamp(Math.round(num(a.h) ?? 300), 120, 1200);
    let anchor = ctx.anchor();
    if (a.nearId) { const t = ctx.must(a.nearId); anchor = { x: t.x + t.w + 60 + w / 2, y: t.y + t.h / 2 }; }
    const spot = findFreeSpot(ctx.obstacles(), w, h, anchor);
    const obj = { id: nid('w_'), type: 'widget', title, html, x: Math.round(spot.x), y: Math.round(spot.y), w, h, origin: 'ai' };
    ctx.apply([{ op: 'put', obj }], `Added widget: ${snip(title, 40)}`);
    return { ok: true, id: obj.id, ...(await firstRun(ctx, obj.id, html)) };
  });

def('update_widget',
  'Change a widget: replace its code (to fix an error or add a feature), rename it, or resize it. Returns what happened when the new code first ran.',
  O({ id: S('Widget id'), html: S('Complete new code (not a diff)'), title: S('New title'), w: N('New width'), h: N('New height') }, ['id']),
  async (a, ctx) => {
    const o = ctx.must(a.id);
    if (o.type !== 'widget') throw new ToolError(`${a.id} is a ${o.type}, not a widget`);
    const set = {};
    if (a.html !== undefined) set.html = checkWidgetHtml(a.html);
    if (a.title !== undefined) set.title = reqStr(a.title, 'title', 200);
    if (num(a.w) !== undefined) set.w = clamp(Math.round(a.w), 200, 1600);
    if (num(a.h) !== undefined) set.h = clamp(Math.round(a.h), 120, 1200);
    if (!Object.keys(set).length) throw new ToolError('Nothing to change: pass html, title, w or h');
    ctx.apply([{ op: 'patch', id: o.id, set }], `Updated widget: ${snip(set.title || o.title, 40)}`);
    if (set.html === undefined || set.html === o.html) return { ok: true, id: o.id, status: 'updated' };
    return { ok: true, id: o.id, ...(await firstRun(ctx, o.id, set.html)) };
  });

def('read_widget_logs',
  'See how a widget is doing on the screens running it: whether it is running and what it shows, its recent errors, and missing API keys.',
  O({ id: S('Widget id') }, ['id']),
  (a, ctx) => {
    const o = ctx.must(a.id);
    if (o.type !== 'widget') throw new ToolError(`${a.id} is not a widget`);
    const current = codeHash(o.html);
    const logs = (ctx.widgets?.recent(o.id, 12) || []).map((e) => ({
      level: e.level, message: e.message || undefined, shows: e.text || undefined, screen: e.client, ago: `${Math.round((Date.now() - e.ts) / 1000)} s`, oldCode: e.hash && e.hash !== current ? true : undefined,
    }));
    return { ok: true, title: o.title, logs, note: logs.length ? undefined : 'No reports yet: no screen has run this widget since the Pi started.' };
  });

def('list_api_keys',
  'List the API keys saved for widgets (names, which website each is for, and whether it is set). Never shows the keys themselves.',
  O({}),
  (a, ctx) => ({ ok: true, keys: ctx.secrets?.list().map(({ name, host, service, set }) => ({ name, host, service, set })) || [] }));

def('request_api_key',
  'Ask the user for an API key a widget needs. A card appears in the O Board app where they paste it; it is stored only on the Pi and only ever sent to the given host. Never ask the user to say or type a key in this conversation.',
  O({
    name: S('Name to use in ob.fetch placeholders, capitals and underscores, e.g. FINNHUB_KEY'),
    service: S('Service name shown to the user, e.g. Finnhub'),
    host: S('The API host the key is for, e.g. finnhub.io (subdomains included)'),
    signupUrl: S('Where the user gets a free key'),
    why: S('One short sentence: what the key is for'),
  }, ['name', 'service', 'host']),
  (a, ctx) => {
    if (!ctx.secrets) throw new ToolError('API keys are not available here');
    const name = reqStr(a.name, 'name', 48);
    if (ctx.secrets.has(name)) return { ok: true, status: 'already_set', note: `${name} is already saved. Use {{${name}}} in ob.fetch.` };
    let info;
    try { info = ctx.secrets.request({ name, host: a.host, service: a.service, signupUrl: a.signupUrl, why: a.why }); } catch (e) { throw new ToolError(e.message); }
    ctx.hub?.broadcast({ t: 'secrets', name: info.name, set: false, requested: true });
    return { ok: true, status: 'requested', key: info.name, host: info.host, note: 'Tell the user that a card is waiting in the O Board app where they can paste the key. It is kept on the Pi only. Do not ask them to read it out.' };
  });

// ---- the TV and boards

def('focus_tv',
  'Point the TV at something: pan and zoom to the given objects (or the whole board), optionally switching boards first. Use when the user says "show me", "zoom in on" or "go to".',
  O({
    ids: A(S('object id'), 'Objects to bring into view; omit for the whole board'),
    boardId: S('Switch the TV to this board first'),
    highlight: B('Dim everything else (focus mode) until the user dismisses it'),
  }),
  (a, ctx) => {
    if (!ctx.hub) throw new ToolError('No display is connected');
    let boardId = ctx.boardId;
    if (a.boardId && a.boardId !== boardId) {
      ctx.store.mustBoard(a.boardId);
      boardId = a.boardId;
      ctx.hub.setDisplay({ boardId });
    } else if (ctx.hub.display.boardId !== boardId) {
      ctx.hub.setDisplay({ boardId });
    }
    const ids = Array.isArray(a.ids) ? a.ids : [];
    const box = ctx.hub.boundsOf(boardId, ids);
    if (!box) return { ok: true, note: 'The board is empty; nothing to focus on.' };
    ctx.hub.fitDisplayTo(box, { maxZoom: ids.length ? 1.4 : 1 });
    ctx.hub.setDisplay({ selection: ids, mode: a.highlight && ids.length ? 'focus' : 'normal', focusIds: a.highlight ? ids : [] });
    return { ok: true, focused: ids.length || 'whole board' };
  });

def('switch_board', 'Open a different board on the TV (and make it the board you are working on).',
  O({ boardId: S('Board id'), name: S('Board name (if you do not know the id)') }),
  (a, ctx) => {
    const b = a.boardId ? ctx.store.getBoard(a.boardId) : ctx.store.findBoardByName(a.name);
    if (!b) throw new ToolError('No such board. Call list_boards.');
    ctx.hub?.setDisplay({ boardId: b.id });
    ctx.switchedTo = b.id;
    return { ok: true, boardId: b.id, name: b.name };
  });

def('create_board', 'Create a new blank project board (space) and open it on the TV.',
  O({ name: S('Board name') }, ['name']),
  (a, ctx) => {
    const b = ctx.store.createBoard({ name: reqStr(a.name, 'name', 80), kind: 'space' });
    ctx.hub?.setDisplay({ boardId: b.id });
    ctx.switchedTo = b.id;
    return { ok: true, boardId: b.id, name: b.name };
  });

// ------------------------------------------------------------------ public API

export const TOOL_NAMES = [...TOOLS.keys()];

export function toolDeclarations() {
  return [...TOOLS.values()].map((t) => t.decl);
}

/** Run one tool. Never throws: errors come back as {ok:false,error} so the model can correct itself. */
export async function runTool(name, args, ctx) {
  const t = TOOLS.get(name);
  if (!t) return { ok: false, error: `Unknown tool "${name}"` };
  try {
    return await t.run(args && typeof args === 'object' ? args : {}, ctx);
  } catch (e) {
    if (e instanceof ToolError || e instanceof StoreError) return { ok: false, error: e.message };
    return { ok: false, error: `Internal error in ${name}: ${e.message}` };
  }
}

export const MUTATING = new Set([
  'add_notes', 'create_diagram', 'connect_objects', 'create_section', 'group_into_section', 'edit_object', 'move_objects',
  'resize_object', 'organize_objects', 'delete_objects', 'undo_ai_change', 'redo_ai_change', 'restore_version', 'resolve_pending',
  'create_widget', 'update_widget',
]);
