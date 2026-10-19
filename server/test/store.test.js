import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Store, StoreError } from '../src/store.js';
import { tmpDir } from './helpers.js';

function fresh() {
  const dir = tmpDir();
  const { db } = openDb(dir);
  const store = new Store(db);
  store.ensureDefaults();
  const board = store.createBoard({ name: 'Test' });
  return { store, db, board, dir };
}

const note = (id, text, extra = {}) => ({ op: 'put', obj: { id, type: 'note', x: 0, y: 0, text, ...extra } });

test('defaults: Thoughts inbox and a first space exist', () => {
  const { store } = fresh();
  const boards = store.listBoards();
  assert.ok(boards.find((b) => b.id === 'thoughts' && b.kind === 'thoughts'));
  assert.ok(boards.filter((b) => b.kind === 'space').length >= 1);
});

test('put/patch/del apply, bump rev, and persist', () => {
  const { store, board } = fresh();
  const r1 = store.applyBatch(board.id, [note('n_aaaa1', 'hello'), note('n_aaaa2', 'world', { x: 300 })], { actor: 'device:t' });
  assert.equal(r1.ops.length, 2);
  assert.ok(store.getBoard(board.id).rev === r1.rev);
  store.applyBatch(board.id, [{ op: 'patch', id: 'n_aaaa1', set: { text: 'hello again', color: 'teal' } }], { actor: 'device:t' });
  const o = store.getObject(board.id, 'n_aaaa1');
  assert.equal(o.text, 'hello again');
  assert.equal(o.color, 'teal');
  store.applyBatch(board.id, [{ op: 'del', id: 'n_aaaa2' }], { actor: 'device:t' });
  assert.equal(store.getObject(board.id, 'n_aaaa2'), null);
  assert.equal(store.getObjects(board.id).length, 1);
});

test('validation rejects bad input atomically (nothing is written)', () => {
  const { store, board } = fresh();
  assert.throws(
    () => store.applyBatch(board.id, [note('n_good1', 'fine'), { op: 'put', obj: { id: 'n_bad11', type: 'note', x: 'left', y: 0 } }], {}),
    (e) => e instanceof StoreError && e.code === 'invalid',
  );
  assert.equal(store.getObjects(board.id).length, 0, 'first valid op must be rolled back too');
  for (const bad of [
    { op: 'put', obj: { id: 'n_bad22', type: 'spaceship', x: 0, y: 0 } },
    { op: 'put', obj: { id: 'n_bad33', type: 'note', x: 0, y: 0, color: 'hotpink' } },
    { op: 'put', obj: { id: 'n_bad44', type: 'note', x: 0, y: 0, nope: 1 } },
    { op: 'put', obj: { id: 'n_bad55', type: 'note', x: 1e12, y: 0 } },
    { op: 'patch', id: 'missing01', set: { text: 'x' } },
    { op: 'wat' },
  ]) {
    assert.throws(() => store.applyBatch(board.id, [bad], {}), StoreError, JSON.stringify(bad));
  }
});

test('no-op patches are dropped and do not bump rev', () => {
  const { store, board } = fresh();
  store.applyBatch(board.id, [note('n_same1', 'same')], {});
  const rev = store.getBoard(board.id).rev;
  const out = store.applyBatch(board.id, [{ op: 'patch', id: 'n_same1', set: { text: 'same' } }], {});
  assert.equal(out.ops.length, 0);
  assert.equal(store.getBoard(board.id).rev, rev);
});

test('arrows bind to objects, reject missing targets, and unbind when a target is deleted', () => {
  const { store, board } = fresh();
  store.applyBatch(board.id, [note('n_a0001', 'A'), note('n_b0001', 'B', { x: 500 })], {});
  assert.throws(
    () => store.applyBatch(board.id, [{ op: 'put', obj: { id: 'a_bad001', type: 'arrow', from: { id: 'n_a0001' }, to: { id: 'ghost001' } } }], {}),
    /does not exist/,
  );
  store.applyBatch(board.id, [{ op: 'put', obj: { id: 'a_ok0001', type: 'arrow', from: { id: 'n_a0001' }, to: { id: 'n_b0001' }, label: 'leads to' } }], {});
  store.applyBatch(board.id, [{ op: 'del', id: 'n_b0001' }], {});
  const arrow = store.getObject(board.id, 'a_ok0001');
  assert.ok(arrow, 'arrow survives');
  assert.equal(arrow.from.id, 'n_a0001');
  assert.equal(arrow.to.id, undefined, 'deleted end becomes a free point');
  assert.equal(typeof arrow.to.x, 'number');
});

test('undo/redo of a batch restores exact prior state; later user edits are not clobbered', () => {
  const { store, board } = fresh();
  store.applyBatch(board.id, [note('n_u00001', 'original', { x: 10 })], { actor: 'device:me' });
  const ai = store.applyBatch(board.id, [
    { op: 'patch', id: 'n_u00001', set: { text: 'rewritten by ai', x: 400 } },
    note('n_ai0001', 'added by ai', { x: 900 }),
  ], { actor: 'ai', label: 'AI edit' });

  // user edits a *different* object field of the AI-created note afterwards
  store.applyBatch(board.id, [{ op: 'patch', id: 'n_ai0001', set: { text: 'user changed this' } }], { actor: 'device:me' });

  const undo = store.revertBatch(ai.batchId, 'undo', { actor: 'undo' });
  assert.equal(undo.skipped, 1, 'the note the user touched is skipped');
  assert.equal(store.getObject(board.id, 'n_u00001').text, 'original');
  assert.equal(store.getObject(board.id, 'n_u00001').x, 10);
  assert.equal(store.getObject(board.id, 'n_ai0001').text, 'user changed this');

  assert.throws(() => store.revertBatch(ai.batchId, 'undo'), /already undone/);
  const redo = store.revertBatch(ai.batchId, 'redo', { actor: 'undo' });
  assert.equal(redo.skipped, 1, 'the note the user edited after the AI is not recreated over their change');
  assert.equal(store.getObject(board.id, 'n_u00001').text, 'rewritten by ai');
  assert.equal(store.getObject(board.id, 'n_ai0001').text, 'user changed this');
});

test('undo of a deletion brings the object back with its arrow binding intact', () => {
  const { store, board } = fresh();
  store.applyBatch(board.id, [note('n_x00001', 'X'), note('n_y00001', 'Y', { x: 400 })], {});
  store.applyBatch(board.id, [{ op: 'put', obj: { id: 'a_xy0001', type: 'arrow', from: { id: 'n_x00001' }, to: { id: 'n_y00001' } } }], {});
  const del = store.applyBatch(board.id, [{ op: 'del', id: 'n_y00001' }], { actor: 'ai', label: 'delete Y' });
  assert.equal(store.getObject(board.id, 'a_xy0001').to.id, undefined);
  store.revertBatch(del.batchId, 'undo', { actor: 'undo' });
  assert.equal(store.getObject(board.id, 'n_y00001').text, 'Y');
  assert.equal(store.getObject(board.id, 'a_xy0001').to.id, 'n_y00001');
});

test('snapshots restore the board as one batch and keep a pre-restore snapshot', () => {
  const { store, board } = fresh();
  store.applyBatch(board.id, [note('n_s00001', 'one'), note('n_s00002', 'two', { x: 300 })], {});
  const snap = store.createSnapshot(board.id, 'v1');
  store.applyBatch(board.id, [{ op: 'del', id: 'n_s00001' }, { op: 'patch', id: 'n_s00002', set: { text: 'changed' } }, note('n_s00003', 'three', { x: 600 })], {});
  store.restoreSnapshot(board.id, snap, { actor: 'device:me' });
  const objs = store.getObjects(board.id);
  assert.deepEqual(objs.map((o) => o.text).sort(), ['one', 'two']);
  assert.ok(store.listSnapshots(board.id).some((s) => s.label === 'Before restore'));
});

test('delta returns the final state of everything changed since a rev', () => {
  const { store, board } = fresh();
  store.applyBatch(board.id, [note('n_d00001', 'a'), note('n_d00002', 'b', { x: 300 })], {});
  const since = store.getBoard(board.id).rev;
  store.applyBatch(board.id, [{ op: 'patch', id: 'n_d00001', set: { text: 'a2' } }, { op: 'del', id: 'n_d00002' }, note('n_d00003', 'c', { x: 600 })], {});
  store.applyBatch(board.id, [{ op: 'patch', id: 'n_d00001', set: { text: 'a3' } }], {});
  const d = store.delta(board.id, since);
  assert.deepEqual(d.upserts.map((o) => [o.id, o.text]).sort(), [['n_d00001', 'a3'], ['n_d00003', 'c']]);
  assert.deepEqual(d.deletes, ['n_d00002']);
  assert.equal(store.delta(board.id, d.rev).upserts.length, 0);
});

test('full-text search finds notes (prefix, stemming) and follows edits and deletes', () => {
  const { store, board } = fresh();
  store.applyBatch(board.id, [note('n_f00001', 'A robotic arm that organizes my desk'), note('n_f00002', 'Camera to identify objects', { x: 300 })], {});
  assert.equal(store.searchObjects('organize').length, 1);
  assert.equal(store.searchObjects('robot').length, 1);
  assert.equal(store.searchObjects('camer')[0].object.id, 'n_f00002');
  store.applyBatch(board.id, [{ op: 'patch', id: 'n_f00002', set: { text: 'Lidar scanner' } }], {});
  assert.equal(store.searchObjects('camera').length, 0);
  assert.equal(store.searchObjects('lidar').length, 1);
  store.applyBatch(board.id, [{ op: 'del', id: 'n_f00001' }], {});
  assert.equal(store.searchObjects('robotic').length, 0);
  assert.equal(store.searchObjects('   ').length, 0, 'empty queries are safe');
  assert.doesNotThrow(() => store.searchObjects('"; DROP TABLE objects; --'));
});

test('thoughts and spaces: protected built-ins, rename, archive, delete', () => {
  const { store } = fresh();
  assert.throws(() => store.updateBoard('thoughts', { name: 'x' }), StoreError);
  assert.throws(() => store.deleteBoard('thoughts'), StoreError);
  const b = store.createBoard({ name: 'Robot desk' });
  store.applyBatch(b.id, [note('n_del001', 'bye')], {});
  store.updateBoard(b.id, { name: 'Robot desk v2', pinned: true });
  assert.equal(store.getBoard(b.id).pinned, true);
  assert.ok(store.listBoards()[0].pinned, 'pinned boards sort first');
  store.updateBoard(b.id, { archived: true });
  assert.ok(!store.listBoards().find((x) => x.id === b.id));
  store.deleteBoard(b.id);
  assert.equal(store.getBoard(b.id), null);
  assert.equal(store.searchObjects('bye').length, 0);
});

test('persistence: reopening the database file keeps everything', () => {
  const { store, db, board, dir } = fresh();
  store.applyBatch(board.id, [note('n_p00001', 'survives restart')], { actor: 'device:me' });
  store.addMessage({ boardId: board.id, role: 'user', text: 'remember the plan' });
  db.close();
  const { db: db2 } = openDb(dir);
  const s2 = new Store(db2);
  assert.equal(s2.getObject(board.id, 'n_p00001').text, 'survives restart');
  assert.equal(s2.getMessages(board.id)[0].text, 'remember the plan');
  assert.equal(s2.searchMessages('plan').length, 1);
});

test('notes get a server-side height estimate; locked objects reject AI edits', () => {
  const { store, board } = fresh();
  store.applyBatch(board.id, [note('n_h00001', 'x'.repeat(400))], {});
  assert.ok(store.getObject(board.id, 'n_h00001').h > 150, 'long note is taller than the default');
  store.applyBatch(board.id, [note('n_l00001', 'locked', { locked: true, x: 400 })], {});
  assert.throws(() => store.applyBatch(board.id, [{ op: 'patch', id: 'n_l00001', set: { text: 'no' } }], { actor: 'ai' }), /locked/);
  assert.doesNotThrow(() => store.applyBatch(board.id, [{ op: 'patch', id: 'n_l00001', set: { text: 'yes' } }], { actor: 'device:me' }));
});
