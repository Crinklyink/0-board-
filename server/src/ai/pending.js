import { rid, now } from '../util.js';

const TTL_MS = 10 * 60 * 1000;

/**
 * Destructive or bulk AI actions are parked here until the user says yes.
 * The AI can only resolve one itself after a *new* user message has arrived since the request,
 * so it cannot ask and approve in the same breath.
 */
export class Pending {
  constructor(hub) {
    this.hub = hub;
    this.items = new Map();
    this.userTurns = new Map(); // boardId -> count of user messages seen
  }

  noteUserTurn(boardId) {
    this.userTurns.set(boardId, (this.userTurns.get(boardId) || 0) + 1);
  }

  userTurnNo(boardId) {
    return this.userTurns.get(boardId) || 0;
  }

  create({ boardId, turnId, summary, run }) {
    this.#sweep();
    const id = rid('pd_', 8);
    const item = { id, boardId, turnId, summary, run, createdAt: now(), expiresAt: now() + TTL_MS, userTurnNo: this.userTurnNo(boardId) };
    this.items.set(id, item);
    this.hub.broadcast({ t: 'pending', pending: publicView(item) });
    return item;
  }

  list(boardId) {
    this.#sweep();
    return [...this.items.values()].filter((p) => !boardId || p.boardId === boardId).map(publicView);
  }

  /** viaUser=true when the user tapped the confirm chip; false when the AI is acting on a spoken/typed yes. */
  resolve(id, accept, { viaUser, boardId }) {
    this.#sweep();
    const item = this.items.get(id);
    if (!item) return { ok: false, error: 'That confirmation has expired or was already answered.' };
    if (!viaUser && this.userTurnNo(item.boardId) <= item.userTurnNo) {
      return { ok: false, error: 'The user has not answered yet. Ask them, then wait for their next message before resolving this.' };
    }
    this.items.delete(id);
    this.hub.broadcast({ t: 'pending.resolved', id, accepted: !!accept, boardId: item.boardId });
    if (!accept) return { ok: true, cancelled: true, message: 'Cancelled. Nothing was changed.' };
    try {
      const out = item.run();
      return { ok: true, ...(out || {}) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  #sweep() {
    const t = now();
    for (const [id, p] of this.items) if (p.expiresAt < t) this.items.delete(id);
  }
}

const publicView = (p) => ({ id: p.id, boardId: p.boardId, summary: p.summary, expiresAt: p.expiresAt });
