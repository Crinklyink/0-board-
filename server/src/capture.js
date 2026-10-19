import { rid } from './util.js';
import { HttpError } from './util.js';
import { estimateNoteHeight, NOTE_WIDTH, bounds, unionBounds } from '../../web/shared/schema.js';
import { findFreeSpot, nextFlowSlot } from '../../web/shared/layout.js';
import { isImageMime } from './assets.js';

const URL_ONLY = /^(https?:\/\/[^\s]+)$/i;

/**
 * Quick Capture: drop text, links, photos or files onto a board immediately, with no AI involved.
 * Safe to retry: every created object carries meta.cid derived from the client's capture id.
 */
export function capture({ store, assets, hub, boardId = 'thoughts', text, assetIds = [], clientId, source = 'capture', actor }) {
  const board = store.mustBoard(boardId);
  const objs = store.getObjects(board.id);
  const cid = clientId && /^[A-Za-z0-9_.-]{1,64}$/.test(String(clientId)) ? String(clientId) : null;
  if (cid) {
    const existing = store.db.prepare(`SELECT id, type FROM objects WHERE board_id = ? AND json_extract(data,'$.meta.cid') LIKE ?`).all(board.id, `${cid}%`);
    if (existing.length) return { boardId: board.id, created: existing.map((e) => ({ id: e.id, type: e.type })), duplicate: true };
  }

  const items = [];
  const body = String(text || '').trim();
  if (body.length > 20000) throw new HttpError(413, 'That is too much text for one note');
  if (body) {
    const m = body.match(URL_ONLY);
    if (m) {
      let host = m[1];
      try { host = new URL(m[1]).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
      items.push({ type: 'link', url: m[1], title: host, w: 300, h: 92 });
    } else {
      items.push({ type: 'note', text: body, w: NOTE_WIDTH, h: estimateNoteHeight(body), tag: '' });
    }
  }
  for (const id of (assetIds || []).slice(0, 12)) {
    const a = assets.get(id);
    if (!a) throw new HttpError(404, `Unknown asset ${id}`);
    if (isImageMime(a.mime)) {
      const ratio = a.width && a.height ? a.height / a.width : 0.75;
      const w = 320;
      items.push({ type: 'image', asset: a.id, w, h: Math.max(60, Math.min(900, Math.round(w * ratio))), alt: a.caption || '' });
    } else {
      items.push({ type: 'file', asset: a.id, name: a.filename || 'File', mime: a.mime, w: 240, h: 84 });
    }
  }
  if (!items.length) throw new HttpError(400, 'Nothing to capture');

  const placed = objs.filter((o) => o.type !== 'arrow' && o.type !== 'frame').map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }));
  const map = new Map(objs.map((o) => [o.id, o]));
  let anchor = { x: 0, y: 0 };
  const d = hub?.display;
  if (d && d.boardId === board.id && d.cam) anchor = { x: d.cam.x, y: d.cam.y };
  else {
    const u = unionBounds(objs.map((o) => bounds(o, (i) => map.get(i))));
    if (u) anchor = { x: u.x + u.w / 2, y: u.y + u.h / 2 };
  }

  const ops = [];
  items.forEach((it, i) => {
    const slot = board.kind === 'thoughts'
      ? nextFlowSlot(placed, it.w, it.h, { cols: 4, colW: NOTE_WIDTH, gap: 24 })
      : findFreeSpot(placed, it.w, it.h, anchor);
    placed.push({ x: slot.x, y: slot.y, w: it.w, h: it.h });
    const obj = { id: rid(it.type[0] + '_', 9), origin: 'user', ...it, x: slot.x, y: slot.y };
    if (cid) obj.meta = { cid: `${cid}:${i}`, src: source };
    ops.push({ op: 'put', obj });
  });
  const out = store.applyBatch(board.id, ops, { actor: actor || 'system', label: 'Captured' });
  return { boardId: board.id, created: ops.map((o) => ({ id: o.obj.id, type: o.obj.type })), rev: out.rev };
}
