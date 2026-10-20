import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';
import { transaction } from './db.js';
import { rid, now, safeJson } from './util.js';
import { buildBoardTemplate } from '../../web/shared/board-templates.js';
import {
  normalizeObject, normalizePatch, applyPatch, diffPatch, objectText, withEstimatedHeight, SchemaError, COLORS,
} from '../../web/shared/schema.js';

// Order matters: the phone decodes kinds by index (BoardThumb in the Android app).
export const PREVIEW_KINDS = ['note', 'text', 'shape', 'frame', 'image', 'widget', 'link', 'file', 'draw', 'task'];

export class StoreError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code; // 'not_found' | 'invalid' | 'conflict' | 'limit'
    this.extra = extra;
  }
}

const MAX_OPS_PER_BATCH = 5000;
const MAX_OBJECTS_PER_BOARD = 20000;
const SNAPSHOT_KEEP = 60;

/** JSON.stringify with sorted keys, so two logically-equal objects compare equal. */
export function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

const ftsQuery = (q) => {
  const tokens = String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!tokens.length) return null;
  return tokens.slice(0, 12).map((t) => `"${t}"*`).join(' OR ');
};

export class Store {
  constructor(db) {
    this.db = db;
    this.events = new EventEmitter();
    this.events.setMaxListeners(50);
    this.q = {
      board: db.prepare('SELECT * FROM boards WHERE id = ?'),
      objects: db.prepare('SELECT data FROM objects WHERE board_id = ?'),
      object: db.prepare('SELECT rid, data FROM objects WHERE board_id = ? AND id = ?'),
      countObjects: db.prepare('SELECT COUNT(*) AS n FROM objects WHERE board_id = ?'),
      upsertObject: db.prepare(`INSERT INTO objects(board_id, id, type, data, updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(board_id, id) DO UPDATE SET type=excluded.type, data=excluded.data, updated_at=excluded.updated_at
        RETURNING rid`),
      deleteObject: db.prepare('DELETE FROM objects WHERE board_id = ? AND id = ? RETURNING rid'),
      boundArrows: db.prepare(`SELECT data FROM objects WHERE board_id = ? AND type = 'arrow'
        AND (json_extract(data,'$.from.id') = ? OR json_extract(data,'$.to.id') = ?)`),
      maxZ: db.prepare(`SELECT MAX(json_extract(data,'$.z')) AS z FROM objects WHERE board_id = ?`),
      insertOp: db.prepare('INSERT INTO ops(board_id, batch_id, actor, obj_id, before, after, ts) VALUES (?,?,?,?,?,?,?) RETURNING seq'),
      insertBatch: db.prepare('INSERT INTO batches(id, board_id, actor, label, turn_id, ts, first_seq, last_seq) VALUES (?,?,?,?,?,?,?,?)'),
      setRev: db.prepare('UPDATE boards SET rev = ?, updated_at = ? WHERE id = ?'),
      ftsDelObj: db.prepare('DELETE FROM fts_obj WHERE rowid = ?'),
      ftsInsObj: db.prepare('INSERT INTO fts_obj(rowid, body) VALUES (?, ?)'),
    };
  }

  // ---------------------------------------------------------------- boards

  ensureDefaults() {
    if (!this.q.board.get('thoughts')) {
      const t = now();
      this.db.prepare(`INSERT INTO boards(id, name, kind, created_at, updated_at) VALUES ('thoughts','Thoughts','thoughts',?,?)`).run(t, t);
    }
    const spaces = this.db.prepare(`SELECT COUNT(*) AS n FROM boards WHERE kind = 'space'`).get().n;
    if (spaces === 0) this.createBoard({ name: 'First board', kind: 'space' });
  }

  listBoards({ includeArchived = false } = {}) {
    const rows = this.db.prepare(`
      SELECT b.*, (SELECT COUNT(*) FROM objects o WHERE o.board_id = b.id) AS count
      FROM boards b ${includeArchived ? '' : 'WHERE b.archived = 0'}
      ORDER BY b.pinned DESC, b.updated_at DESC`).all();
    return rows.map(boardRow);
  }

  /**
   * A tiny sketch of a board for thumbnails: up to 80 boxes as [x, y, w, h, kind, color], normalised to the content
   * bounds (0..1), plus the content's aspect ratio. Cached per board revision.
   */
  boardPreview(boardId, rev) {
    this.previewCache ??= new Map();
    const hit = this.previewCache.get(boardId);
    if (hit && hit.rev === rev) return hit.preview;
    const objs = this.getObjects(boardId).filter((o) => o.type !== 'arrow' && Number.isFinite(o.w));
    let preview = null;
    if (objs.length) {
      let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
      for (const o of objs) { x1 = Math.min(x1, o.x); y1 = Math.min(y1, o.y); x2 = Math.max(x2, o.x + o.w); y2 = Math.max(y2, o.y + o.h); }
      const w = Math.max(1, x2 - x1);
      const h = Math.max(1, y2 - y1);
      const r3 = (n) => Math.round(n * 1000) / 1000;
      const picked = objs.sort((a, b) => (a.type === 'frame') - (b.type === 'frame') || b.w * b.h - a.w * a.h).slice(0, 80)
        .sort((a, b) => (b.type === 'frame') - (a.type === 'frame') || (a.z || 0) - (b.z || 0));
      preview = {
        a: r3(w / h),
        b: picked.map((o) => [r3((o.x - x1) / w), r3((o.y - y1) / h), r3(o.w / w), r3(o.h / h), PREVIEW_KINDS.indexOf(o.type), Math.max(0, COLORS.indexOf(o.color || 'default'))]),
      };
    }
    this.previewCache.set(boardId, { rev, preview });
    return preview;
  }

  getBoard(id) {
    const r = this.q.board.get(id);
    return r ? boardRow({ ...r, count: this.q.countObjects.get(id).n }) : null;
  }

  mustBoard(id) {
    const b = this.getBoard(id);
    if (!b) throw new StoreError('not_found', `Board ${id} does not exist`);
    return b;
  }

  findBoardByName(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    const all = this.listBoards();
    return all.find((b) => b.name.toLowerCase() === n) || all.find((b) => b.name.toLowerCase().includes(n)) || null;
  }

  createBoard({ name, kind = 'space', id, template = 'blank' }) {
    name = String(name || '').trim().slice(0, 80);
    if (!name) throw new StoreError('invalid', 'Board needs a name');
    if (kind !== 'space') throw new StoreError('invalid', 'Only spaces can be created; Thoughts is built in');
    const t = now();
    const bid = id || rid('bd_', 10);
    let objects;
    try { objects = buildBoardTemplate(template, (prefix) => rid(prefix, 9), t); }
    catch (e) { throw new StoreError('invalid', e.message); }
    transaction(this.db, () => {
      this.db.prepare('INSERT INTO boards(id, name, kind, created_at, updated_at) VALUES (?,?,?,?,?)').run(bid, name, kind, t, t);
      if (objects.length) this.applyBatch(bid, objects.map((obj) => ({ op: 'put', obj })), { actor: 'system', label: 'Board template' });
    });
    this.events.emit('boards');
    return this.getBoard(bid);
  }

  updateBoard(id, patch) {
    const b = this.mustBoard(id);
    const sets = [];
    const args = [];
    if (patch.name !== undefined) {
      const name = String(patch.name).trim().slice(0, 80);
      if (!name) throw new StoreError('invalid', 'Board needs a name');
      if (b.kind === 'thoughts') throw new StoreError('invalid', 'Thoughts cannot be renamed');
      sets.push('name = ?'); args.push(name);
    }
    if (patch.pinned !== undefined) { sets.push('pinned = ?'); args.push(patch.pinned ? 1 : 0); }
    if (patch.archived !== undefined) {
      if (b.kind === 'thoughts') throw new StoreError('invalid', 'Thoughts cannot be archived');
      sets.push('archived = ?'); args.push(patch.archived ? 1 : 0);
    }
    if (!sets.length) return b;
    sets.push('updated_at = ?'); args.push(now());
    this.db.prepare(`UPDATE boards SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    this.events.emit('boards');
    return this.getBoard(id);
  }

  setProjectMemory(id, patch, { expectedRevision, actor = 'user' } = {}) {
    const board = this.mustBoard(id);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new StoreError('invalid', 'Memory revision is required');
    if (expectedRevision !== board.memoryRevision) throw new StoreError('conflict', 'Project memory changed on another device. Reload it before saving.');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new StoreError('invalid', 'Memory must be an object');
    const memory = { ...board.memory };
    for (const [key, value] of Object.entries(patch)) {
      if (!['goal', 'decisions', 'questions', 'nextSteps'].includes(key)) throw new StoreError('invalid', `Unknown memory field: ${key}`);
      if (typeof value !== 'string' || value.length > 4000) throw new StoreError('invalid', `${key} must be text of at most 4000 characters`);
      memory[key] = value.trim();
    }
    memory.updatedAt = now();
    memory.updatedBy = actor === 'ai' ? 'ai' : 'user';
    this.db.prepare('UPDATE boards SET memory = ?, memory_rev = memory_rev + 1, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(memory), memory.updatedAt, id);
    this.events.emit('boards');
    return this.getBoard(id);
  }

  deleteBoard(id) {
    const b = this.mustBoard(id);
    if (b.kind === 'thoughts') throw new StoreError('invalid', 'Thoughts cannot be deleted');
    transaction(this.db, () => {
      for (const { rid: r } of this.db.prepare('SELECT rid FROM objects WHERE board_id = ?').all(id)) this.q.ftsDelObj.run(r);
      for (const { rid: r } of this.db.prepare('SELECT rid FROM messages WHERE board_id = ?').all(id)) this.db.prepare('DELETE FROM fts_msg WHERE rowid = ?').run(r);
      this.db.prepare('DELETE FROM messages WHERE board_id = ?').run(id);
      this.db.prepare('DELETE FROM ops WHERE board_id = ?').run(id);
      this.db.prepare('DELETE FROM batches WHERE board_id = ?').run(id);
      this.db.prepare('DELETE FROM snapshots WHERE board_id = ?').run(id);
      this.db.prepare('DELETE FROM boards WHERE id = ?').run(id);
    });
    this.events.emit('boards');
  }

  markOpened(id) {
    this.db.prepare('UPDATE boards SET opened_at = ? WHERE id = ?').run(now(), id);
  }

  setCamera(id, cam) {
    this.db.prepare('UPDATE boards SET camera = ? WHERE id = ?').run(JSON.stringify(cam), id);
  }

  // --------------------------------------------------------------- objects

  getObjects(boardId) {
    return this.q.objects.all(boardId).map((r) => JSON.parse(r.data));
  }

  getObject(boardId, id) {
    const r = this.q.object.get(boardId, id);
    return r ? JSON.parse(r.data) : null;
  }

  state(boardId) {
    const board = this.mustBoard(boardId);
    return { board, objects: this.getObjects(boardId), rev: board.rev };
  }

  /**
   * Apply a list of ops atomically. Throws StoreError('invalid') and changes nothing if any op is bad.
   * ops: {op:'put', obj} | {op:'patch', id, set} | {op:'del', id}
   */
  applyBatch(boardId, rawOps, meta = {}) {
    this.mustBoard(boardId);
    if (!Array.isArray(rawOps) || rawOps.length === 0) throw new StoreError('invalid', 'ops must be a non-empty array');
    if (rawOps.length > MAX_OPS_PER_BATCH) throw new StoreError('limit', `Too many ops in one batch (max ${MAX_OPS_PER_BATCH})`);

    const actor = meta.actor || 'system';
    const batchId = meta.batchId || rid('ba_', 12);
    const ts = now();
    const applied = [];
    let firstSeq = null;
    let lastSeq = null;
    let rev;

    transaction(this.db, () => {
      const cache = new Map(); // id -> object | null  (state as of this point in the batch)
      let zTop = null;
      const current = (id) => {
        if (cache.has(id)) return cache.get(id);
        const r = this.q.object.get(boardId, id);
        const obj = r ? JSON.parse(r.data) : null;
        cache.set(id, obj);
        return obj;
      };
      const nextZ = () => {
        if (zTop === null) zTop = this.q.maxZ.get(boardId)?.z ?? 0;
        zTop = Math.floor(zTop) + 1;
        return zTop;
      };
      let count = this.q.countObjects.get(boardId).n;

      const write = (id, before, after) => {
        const bj = before ? stable(before) : null;
        const aj = after ? stable(after) : null;
        const { seq } = this.q.insertOp.get(boardId, batchId, actor, id, bj, aj, ts);
        if (firstSeq === null) firstSeq = seq;
        lastSeq = seq;
        cache.set(id, after);
        if (after) {
          const { rid: r } = this.q.upsertObject.get(boardId, id, after.type, JSON.stringify(after), ts);
          this.q.ftsDelObj.run(r);
          const text = objectText(after).trim();
          if (text) this.q.ftsInsObj.run(r, text);
          if (!before) count++;
        } else {
          const gone = this.q.deleteObject.get(boardId, id);
          if (gone) this.q.ftsDelObj.run(gone.rid);
          count--;
        }
      };

      const checkArrowTargets = (arrow) => {
        for (const end of ['from', 'to']) {
          const ep = arrow[end];
          if (ep?.id) {
            const t = current(ep.id);
            if (!t) throw new StoreError('invalid', `Arrow ${arrow.id}: ${end} refers to ${ep.id}, which does not exist on this board`);
            if (t.type === 'arrow') throw new StoreError('invalid', `Arrow ${arrow.id}: ${end} cannot attach to another arrow`);
          }
        }
      };

      for (const op of rawOps) {
        try {
          if (!op || typeof op !== 'object') throw new SchemaError('op must be an object');
          if (op.op === 'put') {
            const hadZ = op.obj && op.obj.z !== undefined;
            let obj = normalizeObject(op.obj);
            const before = current(obj.id);
            if (before && before.type !== obj.type) throw new SchemaError(`${obj.id} is a ${before.type}; its type cannot change`);
            if (!before && !hadZ) obj.z = nextZ();
            if (!before && count >= MAX_OBJECTS_PER_BOARD) throw new StoreError('limit', 'This board has reached its object limit');
            if (before?.locked && meta.actor === 'ai') throw new SchemaError(`${obj.id} is locked`);
            if (!before && !obj.t) obj.t = ts;
            if (!obj.origin) obj.origin = actor === 'ai' ? 'ai' : 'user';
            obj = withEstimatedHeight(obj);
            if (obj.type === 'arrow') checkArrowTargets(obj);
            if (before && stable(before) === stable(obj)) continue;
            write(obj.id, before, obj);
            applied.push({ op: 'put', obj });
          } else if (op.op === 'patch') {
            const before = current(op.id);
            if (!before) throw new SchemaError(`${op.id} does not exist`);
            if (before.locked && meta.actor === 'ai' && !('locked' in (op.set || {}))) throw new SchemaError(`${op.id} is locked`);
            const set = diffPatch(before, normalizePatch(before.type, op.set));
            if (!Object.keys(set).length) continue;
            let after = applyPatch(before, set);
            if (after.type === 'note' && ('text' in set || 'size' in set || 'w' in set || 'autoH' in set)) after = withEstimatedHeight(after);
            if (after.type === 'arrow') checkArrowTargets(after);
            write(after.id, before, after);
            const outSet = diffPatch(before, Object.fromEntries(Object.keys(set).map((k) => [k, after[k] === undefined ? null : after[k]])));
            if (after.h !== before.h && !('h' in outSet)) outSet.h = after.h;
            applied.push({ op: 'patch', id: after.id, set: outSet });
          } else if (op.op === 'del') {
            const before = current(op.id);
            if (!before) continue; // idempotent
            if (before.locked && meta.actor === 'ai') throw new SchemaError(`${op.id} is locked`);
            // Unbind arrows attached to the doomed object so nothing dangles.
            if (before.type !== 'arrow') {
              const center = { x: Math.round(before.x + before.w / 2), y: Math.round(before.y + before.h / 2) };
              for (const row of this.q.boundArrows.all(boardId, op.id, op.id)) {
                const arrow = current(JSON.parse(row.data).id);
                if (!arrow) continue;
                const set = {};
                if (arrow.from?.id === op.id) set.from = center;
                if (arrow.to?.id === op.id) set.to = center;
                if (!Object.keys(set).length) continue;
                const after = applyPatch(arrow, set);
                write(arrow.id, arrow, after);
                applied.push({ op: 'patch', id: arrow.id, set });
              }
              // Arrows created earlier in this very batch are not in the DB scan above only if not yet written; they are written immediately, so covered.
            }
            write(op.id, before, null);
            applied.push({ op: 'del', id: op.id });
          } else {
            throw new SchemaError(`unknown op "${op.op}"`);
          }
        } catch (e) {
          if (e instanceof SchemaError) throw new StoreError('invalid', e.message, { op });
          throw e;
        }
      }

      if (applied.length === 0) return;
      rev = lastSeq;
      this.q.setRev.run(rev, ts, boardId);
      this.q.insertBatch.run(batchId, boardId, actor, (meta.label || '').slice(0, 120) || null, meta.turnId || null, ts, firstSeq, lastSeq);
    });

    if (applied.length === 0) return { batchId: null, rev: this.mustBoard(boardId).rev, ops: [] };
    const result = { batchId, rev, ops: applied };
    this.events.emit('ops', {
      boardId, batchId, rev, actor, label: meta.label || null, cid: meta.cid || null, turnId: meta.turnId || null, ts, ops: applied,
    });
    return result;
  }

  /** Changes since a client's last known rev, coalesced to the final state per object. null => resync fully. */
  delta(boardId, sinceRev) {
    const board = this.mustBoard(boardId);
    if (sinceRev >= board.rev) return { rev: board.rev, upserts: [], deletes: [] };
    const rows = this.db.prepare('SELECT obj_id, after FROM ops WHERE board_id = ? AND seq > ? ORDER BY seq').all(boardId, sinceRev);
    if (rows.length > 4000) return null;
    const last = new Map();
    for (const r of rows) last.set(r.obj_id, r.after);
    const upserts = [];
    const deletes = [];
    for (const [id, after] of last) {
      if (after) upserts.push(JSON.parse(after));
      else deletes.push(id);
    }
    return { rev: board.rev, upserts, deletes };
  }

  // ----------------------------------------------------------- undo / redo

  recentBatches(boardId, { limit = 10, actor } = {}) {
    const rows = this.db.prepare(
      `SELECT * FROM batches WHERE board_id = ? ${actor ? 'AND actor = ?' : ''} ORDER BY ts DESC, rowid DESC LIMIT ?`,
    ).all(...(actor ? [boardId, actor, limit] : [boardId, limit]));
    return rows.map((r) => ({ id: r.id, actor: r.actor, label: r.label, ts: r.ts, undone: !!r.undone, turnId: r.turn_id }));
  }

  lastBatch(boardId, { actor, undone }) {
    const r = this.db.prepare(
      `SELECT * FROM batches WHERE board_id = ? AND actor = ? AND undone = ? ORDER BY ts DESC, rowid DESC LIMIT 1`,
    ).get(boardId, actor, undone ? 1 : 0);
    return r ? { id: r.id, label: r.label, ts: r.ts, turnId: r.turn_id } : null;
  }

  /** Undo (direction='undo') or redo (direction='redo') one batch. Objects edited by someone else since are left alone. */
  revertBatch(batchId, direction, meta = {}) {
    const batch = this.db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
    if (!batch) throw new StoreError('not_found', 'That change no longer exists');
    if (direction === 'undo' && batch.undone) throw new StoreError('conflict', 'That change was already undone');
    if (direction === 'redo' && !batch.undone) throw new StoreError('conflict', 'That change is not undone');
    const rows = this.db.prepare('SELECT * FROM ops WHERE batch_id = ? ORDER BY seq').all(batchId);
    const ordered = direction === 'undo' ? [...rows].reverse() : rows;
    const working = new Map(); // id -> stable json of state as we go
    const getNow = (id) => (working.has(id) ? working.get(id) : (() => { const o = this.getObject(batch.board_id, id); return o ? stable(o) : null; })());
    const ops = [];
    const skipped = new Set();
    for (const r of ordered) {
      const expect = direction === 'undo' ? r.after : r.before;
      const target = direction === 'undo' ? r.before : r.after;
      if (skipped.has(r.obj_id)) continue;
      if (getNow(r.obj_id) !== expect) { skipped.add(r.obj_id); continue; }
      working.set(r.obj_id, target);
      ops.push(target ? { op: 'put', obj: JSON.parse(target) } : { op: 'del', id: r.obj_id });
    }
    // Arrows must come after the objects they attach to when restoring; deletes of boxes should come after arrow deletes.
    const rank = (o) => {
      const t = o.op === 'put' ? o.obj.type : 'x';
      if (o.op === 'del') return 0;
      return t === 'arrow' ? 2 : 1;
    };
    ops.sort((a, b) => rank(a) - rank(b));
    let result = { batchId: null, rev: this.mustBoard(batch.board_id).rev, ops: [] };
    if (ops.length) {
      result = this.applyBatch(batch.board_id, ops, {
        actor: meta.actor || 'system',
        label: `${direction === 'undo' ? 'Undo' : 'Redo'}: ${batch.label || 'change'}`,
        cid: meta.cid,
      });
    }
    this.db.prepare('UPDATE batches SET undone = ? WHERE id = ?').run(direction === 'undo' ? 1 : 0, batchId);
    return { ...result, restored: ops.length, skipped: skipped.size, label: batch.label };
  }

  // ------------------------------------------------------------- snapshots

  createSnapshot(boardId, label = '') {
    const board = this.mustBoard(boardId);
    const objects = this.getObjects(boardId);
    const id = rid('sn_', 10);
    this.db.prepare('INSERT INTO snapshots(id, board_id, ts, rev, label, n, data) VALUES (?,?,?,?,?,?,?)')
      .run(id, boardId, now(), board.rev, label.slice(0, 120), objects.length, zlib.gzipSync(JSON.stringify(objects)));
    const old = this.db.prepare('SELECT id FROM snapshots WHERE board_id = ? ORDER BY ts DESC LIMIT -1 OFFSET ?').all(boardId, SNAPSHOT_KEEP);
    for (const o of old) this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(o.id);
    return id;
  }

  listSnapshots(boardId, limit = 30) {
    return this.db.prepare('SELECT id, ts, rev, label, n FROM snapshots WHERE board_id = ? ORDER BY ts DESC LIMIT ?').all(boardId, limit)
      .map((r) => ({ id: r.id, ts: r.ts, rev: r.rev, label: r.label, count: r.n }));
  }

  restoreSnapshot(boardId, snapshotId, meta = {}) {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE id = ? AND board_id = ?').get(snapshotId, boardId);
    if (!row) throw new StoreError('not_found', 'That version does not exist');
    const target = JSON.parse(zlib.gunzipSync(row.data).toString('utf8'));
    this.createSnapshot(boardId, 'Before restore');
    const cur = new Map(this.getObjects(boardId).map((o) => [o.id, o]));
    const want = new Map(target.map((o) => [o.id, o]));
    const ops = [];
    for (const id of cur.keys()) if (!want.has(id)) ops.push({ op: 'del', id });
    const puts = [];
    for (const [id, o] of want) if (!cur.has(id) || stable(cur.get(id)) !== stable(o)) puts.push({ op: 'put', obj: o });
    puts.sort((a, b) => (a.obj.type === 'arrow') - (b.obj.type === 'arrow'));
    ops.push(...puts);
    if (!ops.length) return { batchId: null, ops: [], rev: this.mustBoard(boardId).rev };
    // Deletes first would unbind arrows needlessly; those arrows get restored by the puts that follow.
    return this.applyBatch(boardId, ops, { actor: meta.actor || 'system', label: `Restore version${row.label ? `: ${row.label}` : ''}`, cid: meta.cid });
  }

  // --------------------------------------------------------------- messages

  addMessage({ boardId, role, text, source = null, attachments = null, turnId = null, meta = null, id }) {
    const mid = id || rid('ms_', 12);
    const ts = now();
    const row = this.db.prepare(`INSERT INTO messages(id, board_id, role, text, source, attachments, turn_id, meta, ts)
      VALUES (?,?,?,?,?,?,?,?,?) RETURNING rid`).get(
      mid, boardId, role, text, source, attachments ? JSON.stringify(attachments) : null, turnId, meta ? JSON.stringify(meta) : null, ts);
    if (text.trim()) this.db.prepare('INSERT INTO fts_msg(rowid, body) VALUES (?, ?)').run(row.rid, text);
    const msg = { id: mid, boardId, role, text, source, attachments, turnId, meta, ts };
    this.events.emit('message', msg);
    return msg;
  }

  getMessages(boardId, { limit = 40, beforeTs } = {}) {
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE board_id = ? ${beforeTs ? 'AND ts < ?' : ''} ORDER BY ts DESC, rid DESC LIMIT ?`,
    ).all(...(beforeTs ? [boardId, beforeTs, limit] : [boardId, limit]));
    return rows.reverse().map(msgRow);
  }

  deleteMessages(ids) {
    transaction(this.db, () => {
      for (const id of ids) {
        const r = this.db.prepare('DELETE FROM messages WHERE id = ? RETURNING rid').get(id);
        if (r) this.db.prepare('DELETE FROM fts_msg WHERE rowid = ?').run(r.rid);
      }
    });
  }

  recentMessageIds(boardId, n) {
    return this.db.prepare('SELECT id FROM messages WHERE board_id = ? ORDER BY ts DESC, rid DESC LIMIT ?').all(boardId, n).map((r) => r.id);
  }

  // ----------------------------------------------------------------- search

  searchObjects(query, { boardId, limit = 12 } = {}) {
    const q = ftsQuery(query);
    if (!q) return [];
    const rows = this.db.prepare(`
      SELECT o.board_id, o.data, b.name AS board_name FROM fts_obj f
      JOIN objects o ON o.rid = f.rowid JOIN boards b ON b.id = o.board_id
      WHERE fts_obj MATCH ? ${boardId ? 'AND o.board_id = ?' : ''} AND b.archived = 0
      ORDER BY rank LIMIT ?`).all(...(boardId ? [q, boardId, limit] : [q, limit]));
    return rows.map((r) => ({ boardId: r.board_id, boardName: r.board_name, object: JSON.parse(r.data) }));
  }

  searchMessages(query, { boardId, limit = 12 } = {}) {
    const q = ftsQuery(query);
    if (!q) return [];
    const rows = this.db.prepare(`
      SELECT m.* FROM fts_msg f JOIN messages m ON m.rid = f.rowid
      WHERE fts_msg MATCH ? ${boardId ? 'AND m.board_id = ?' : ''} ORDER BY rank LIMIT ?`).all(...(boardId ? [q, boardId, limit] : [q, limit]));
    return rows.map(msgRow);
  }

  /** Everything created or said inside [fromTs, toTs]. Powers "what was I thinking about yesterday?". */
  activityBetween(fromTs, toTs, { boardId, limit = 60 } = {}) {
    const notes = this.db.prepare(`
      SELECT o.board_id, o.data, b.name AS board_name FROM objects o JOIN boards b ON b.id = o.board_id
      WHERE json_extract(o.data,'$.t') BETWEEN ? AND ? AND o.type IN ('note','text','shape','frame','link','task')
      ${boardId ? 'AND o.board_id = ?' : ''} AND json_extract(o.data,'$.origin') IS NOT 'ai'
      ORDER BY json_extract(o.data,'$.t') LIMIT ?`).all(...(boardId ? [fromTs, toTs, boardId, limit] : [fromTs, toTs, limit]));
    const msgs = this.db.prepare(`
      SELECT * FROM messages WHERE ts BETWEEN ? AND ? AND role = 'user' ${boardId ? 'AND board_id = ?' : ''} ORDER BY ts LIMIT ?`)
      .all(...(boardId ? [fromTs, toTs, boardId, limit] : [fromTs, toTs, limit]));
    return {
      notes: notes.map((r) => ({ boardId: r.board_id, boardName: r.board_name, object: JSON.parse(r.data) })),
      messages: msgs.map(msgRow),
    };
  }

  stats() {
    const c = (sql) => this.db.prepare(sql).get().n;
    return {
      boards: c('SELECT COUNT(*) AS n FROM boards'),
      objects: c('SELECT COUNT(*) AS n FROM objects'),
      ops: c('SELECT COUNT(*) AS n FROM ops'),
      messages: c('SELECT COUNT(*) AS n FROM messages'),
      assets: c('SELECT COUNT(*) AS n FROM assets'),
    };
  }
}

function boardRow(r) {
  return {
    id: r.id, name: r.name, kind: r.kind, pinned: !!r.pinned, archived: !!r.archived, rev: r.rev,
    camera: r.camera ? safeJson(r.camera) : null, createdAt: r.created_at, updatedAt: r.updated_at, openedAt: r.opened_at,
    count: r.count ?? 0,
    memory: safeJson(r.memory, {}), memoryRevision: r.memory_rev || 0,
  };
}

function msgRow(r) {
  return {
    id: r.id, boardId: r.board_id, role: r.role, text: r.text, source: r.source,
    attachments: r.attachments ? safeJson(r.attachments) : null, turnId: r.turn_id, meta: r.meta ? safeJson(r.meta) : null, ts: r.ts,
  };
}
