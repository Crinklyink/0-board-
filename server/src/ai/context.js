import { bounds, objectText } from '../../../web/shared/schema.js';

const SNIP = 160;
const MAX_LINES = 260;

const snip = (s, n = SNIP) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** A compact, id-rich description of a board for the model. Not JSON, to keep it cheap and readable. */
export function boardContext({ store, pending, widgets = null, boardId, selection = [], anchor = null }) {
  const board = store.getBoard(boardId);
  if (!board) return 'No board is open.';
  const objs = store.getObjects(boardId);
  const byId = new Map(objs.map((o) => [o.id, o]));
  const lines = [];
  lines.push(`BOARD "${board.name}" (id ${board.id}, ${board.kind === 'thoughts' ? 'the Thoughts inbox' : 'a space'}), ${objs.length} objects.`);
  if (selection.length) lines.push(`SELECTED by the user: ${selection.join(', ')}`);

  const arrows = objs.filter((o) => o.type === 'arrow');
  const frames = objs.filter((o) => o.type === 'frame');
  let boxes = objs.filter((o) => o.type !== 'arrow' && o.type !== 'frame');

  let truncated = false;
  if (boxes.length > MAX_LINES) {
    truncated = true;
    const sel = new Set(selection);
    const a = anchor || { x: 0, y: 0 };
    boxes = boxes
      .map((o) => ({ o, d: sel.has(o.id) ? -1 : Math.hypot(o.x + o.w / 2 - a.x, o.y + o.h / 2 - a.y) }))
      .sort((p, q) => p.d - q.d).slice(0, MAX_LINES).map((p) => p.o);
  }
  boxes.sort((p, q) => Math.round(p.y / 120) - Math.round(q.y / 120) || p.x - q.x);

  for (const f of frames) {
    const inside = objs.filter((o) => o.id !== f.id && o.type !== 'frame' && o.type !== 'arrow'
      && o.x >= f.x && o.y >= f.y && o.x + o.w <= f.x + f.w && o.y + o.h <= f.y + f.h).map((o) => o.id);
    lines.push(`- ${f.id} section "${snip(f.title, 80)}" @${r(f.x)},${r(f.y)} ${r(f.w)}x${r(f.h)} contains: ${inside.join(', ') || 'nothing'}`);
  }
  for (const o of boxes) {
    const tag = o.tag ? `[${o.tag}]` : '';
    const ai = o.origin === 'ai' ? '·ai' : '';
    let body = '';
    if (o.type === 'image') body = ` asset=${o.asset}${o.alt ? ` "${snip(o.alt, 120)}"` : ''}`;
    else if (o.type === 'link') body = ` "${snip(o.title, 60)}" ${snip(o.url, 80)}`;
    else if (o.type === 'draw') body = ' (freehand drawing)';
    else if (o.type === 'file') body = ` "${snip(o.name, 60)}"`;
    else if (o.type === 'widget') body = ` "${snip(o.title, 60)}"${widgetStatus(widgets?.status(o.id))}`;
    else body = ` "${snip(objectText(o))}"`;
    lines.push(`- ${o.id} ${o.type}${tag}${ai}${body} @${r(o.x)},${r(o.y)} ${r(o.w)}x${r(o.h)}`);
  }
  for (const a of arrows.slice(0, 120)) {
    const end = (e) => (e?.id ? (byId.get(e.id) ? e.id : `${e.id}(missing)`) : `(${r(e?.x)},${r(e?.y)})`);
    lines.push(`- ${a.id} arrow ${end(a.from)} -> ${end(a.to)}${a.label ? ` "${snip(a.label, 60)}"` : ''}`);
  }
  if (truncated) lines.push(`(Board is large: only the ${MAX_LINES} objects nearest the user are listed. Use search_board to find others.)`);
  if (!objs.length) lines.push('(The board is empty.)');

  const others = store.listBoards().filter((b) => b.id !== boardId).slice(0, 12);
  if (others.length) lines.push('OTHER BOARDS: ' + others.map((b) => `"${b.name}" (${b.id}, ${b.count} objects)`).join('; '));

  const ai = store.recentBatches(boardId, { limit: 4, actor: 'ai' }).filter((b) => !b.undone);
  if (ai.length) lines.push('RECENT AI CHANGES (newest first): ' + ai.map((b) => `${b.label || 'change'} (${ago(b.ts)})`).join('; '));

  const pend = pending?.list(boardId) || [];
  if (pend.length) lines.push('AWAITING USER CONFIRMATION: ' + pend.map((p) => `${p.id}: ${p.summary}`).join('; '));

  return lines.join('\n');
}

const r = (n) => Math.round(Number(n) || 0);

function widgetStatus(s) {
  if (!s) return '';
  if (s.level === 'ready') return ` [running${s.text ? `, shows: ${snip(s.text, 80)}` : ''}]`;
  if (s.level === 'needs_key') return ` [waiting for API key ${s.message}]`;
  return ` [ERROR: ${snip(s.message, 120)}]`;
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export { bounds };
