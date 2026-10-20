import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeObject, normalizePatch, rectsOverlap } from '../../web/shared/schema.js';
import { BOARD_TEMPLATES } from '../../web/shared/board-templates.js';
import { mergeProjectMemory } from '../../web/shared/project-memory.js';
import { boardContext } from '../src/ai/context.js';
import { runTool, ToolContext } from '../src/ai/tools.js';
import { startServer, pairPhone, wsClient, startMockGemini } from './helpers.js';

async function isolated(t, options) {
  const s = await startServer(options);
  t.after(async () => { await s.app.close(); fs.rmSync(s.dataDir, { recursive: true, force: true }); });
  return s;
}
function context(s, boardId) {
  return new ToolContext({ store: s.app.store, hub: s.app.hub, assets: s.app.assets, pending: s.app.pending, settings: s.app.settings.get(), boardId, turnId: 'v04-test' });
}

test('task schema validates statuses, priorities and real calendar dates', () => {
  const task = normalizeObject({ id: 'task_one', type: 'task', text: 'Build the gripper', x: 0, y: 0 });
  assert.equal(task.status, 'todo'); assert.equal(task.priority, 'normal'); assert.equal(task.due, '');
  for (const due of ['2026-02-29', '2026-04-31', 'tomorrow', '2026-1-01', null, 123]) {
    assert.throws(() => normalizePatch('task', { due }));
  }
  assert.equal(normalizePatch('task', { due: '2028-02-29' }).due, '2028-02-29');
  assert.throws(() => normalizePatch('task', { status: 'finished' }));
  assert.throws(() => normalizePatch('task', { priority: 'urgent' }));
  assert.throws(() => normalizePatch('task', { text: null }));
});

test('memory recovery combines independent edits and flags simultaneous changes without dropping cleared fields', () => {
  const base = { goal: 'Build an arm', decisions: 'Use belts' };
  const result = mergeProjectMemory(base, { goal: 'Build an arm', decisions: '', nextSteps: 'Calibrate' }, { goal: 'Build an arm', decisions: 'Use belts', questions: 'Which camera?' });
  assert.equal(result.merged.decisions, ''); assert.equal(result.merged.nextSteps, 'Calibrate'); assert.equal(result.merged.questions, 'Which camera?');
  assert.equal(result.conflicts.length, 0);
  const conflict = mergeProjectMemory(base, { goal: 'My goal', decisions: 'Use belts' }, { goal: 'Their goal', decisions: 'Use belts' });
  assert.equal(conflict.merged.goal, 'My goal');
  assert.deepEqual(conflict.conflicts.map((c) => [c.key, c.draft, c.latest]), [['goal', 'My goal', 'Their goal']]);
});

test('rapid backup requests produce distinct restorable files', async (t) => {
  const s = await isolated(t);
  const first = s.app.backups.create('manual'), second = s.app.backups.create('manual');
  assert.notEqual(first.name, second.name);
  assert.equal(s.app.backups.list().length, 2);
  assert(first.size > 0 && second.size > 0);
});

test('an in-flight Gemini check cannot mark a replacement key as tested', async (t) => {
  const s = await isolated(t, { gemini: { apiKey: 'old-test-key' } });
  const phone = await pairPhone(s);
  let complete, announce;
  const started = new Promise((resolve) => { announce = resolve; });
  s.app.gemini.listModels = () => { announce(); return new Promise((resolve) => { complete = resolve; }); };
  const checking = s.call('POST', '/api/diagnostics/gemini', {}, { tok: phone });
  await started;
  assert.equal((await s.call('PUT', '/api/setup/gemini-key', { key: 'replacement-test-key' }, { tok: phone })).status, 200);
  complete([{ name: s.app.settings.get().textModel, methods: ['generateContent'] }]);
  const result = await checking;
  assert.equal(result.json.checks[0].status, 'warn');
  assert.equal(s.app.setup.lastTest, null);
  const report = await s.call('GET', '/api/diagnostics', undefined, { tok: phone });
  assert(!report.json.checks.some((c) => c.id === 'gemini-api' && c.status === 'pass'));
});

test('every board template creates editable persisted objects, unique ids and valid non-overlapping cards', async (t) => {
  const s = await isolated(t);
  const response = await s.call('GET', '/api/board-templates');
  assert.equal(response.json.templates.length, 6);
  for (const template of BOARD_TEMPLATES) {
    const r = await s.call('POST', '/api/boards', { name: `Test ${template.name}`, template: template.id });
    assert.equal(r.status, 201);
    const state = (await s.call('GET', `/api/boards/${r.json.board.id}`)).json;
    if (template.id === 'blank') { assert.equal(state.objects.length, 0); continue; }
    assert.equal(state.objects.filter((o) => o.type === 'frame').length, 4);
    const cards = state.objects.filter((o) => o.type !== 'frame');
    assert(cards.length >= 4);
    assert.equal(new Set(state.objects.map((o) => o.id)).size, state.objects.length);
    for (const card of state.objects) normalizeObject(card);
    for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) assert(!rectsOverlap(cards[i], cards[j]));
    assert.equal((await s.call('POST', `/api/boards/${r.json.board.id}/ops`, { ops: [{ op: 'patch', id: cards[0].id, set: { text: 'Edited template card' } }] })).status, 200);
  }
  const count = s.app.store.listBoards().length;
  assert.equal((await s.call('POST', '/api/boards', { name: 'Invalid', template: 'missing' })).status, 400);
  assert.equal(s.app.store.listBoards().length, count);
});

test('AI tasks avoid overlaps, sync to the TV, remain searchable and undo as one change', async (t) => {
  const s = await isolated(t);
  const b = s.app.store.createBoard({ name: 'Tasks' });
  const tv = wsClient(s.base, s.token); await tv.open;
  t.after(() => tv.close());
  tv.send({ t: 'sub', board: b.id, rev: -1 });
  await tv.waitFor((m) => m.t === 'board' && m.board.id === b.id);
  const ctx = context(s, b.id);
  const added = await runTool('add_tasks', { tasks: [{ text: 'Calibrate the camera', priority: 'high', due: '2026-12-01' }, { text: 'Mount the gripper' }] }, ctx);
  assert.equal(added.ok, true);
  assert(!rectsOverlap(added.tasks[0], added.tasks[1]));
  await tv.waitFor((m) => m.t === 'ops' && m.board === b.id && m.ops.some((o) => o.obj?.type === 'task'));
  const id = added.tasks[0].id;
  assert.equal(s.app.store.searchObjects('calibrate', { boardId: b.id })[0].object.id, id);
  const changed = await runTool('update_task', { id, status: 'done' }, ctx);
  assert.equal(changed.task.status, 'done');
  const before = s.app.store.getObject(b.id, id);
  assert.equal((await runTool('update_task', { id, due: '2026-02-31' }, ctx)).ok, false);
  assert.deepEqual(s.app.store.getObject(b.id, id), before);
  const undone = await runTool('undo_ai_change', {}, context(s, b.id));
  assert.equal(undone.ok, true);
  assert.equal(s.app.store.getObjects(b.id).length, 0);
});

test('task edits from a phone sync and survive a server restart', async (t) => {
  let s = await startServer();
  const dataDir = s.dataDir;
  t.after(async () => { await s.app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const token = await pairPhone(s);
  const b = s.app.store.createBoard({ name: 'Task persistence' });
  let r = await s.call('POST', `/api/boards/${b.id}/ops`, { ops: [{ op: 'put', obj: { id: 'task_saved', type: 'task', text: 'Saved work', x: 20, y: 30, status: 'doing', priority: 'high', due: '2026-12-10' } }] }, { tok: token });
  assert.equal(r.status, 200);
  await s.app.close();
  s = await startServer({ dataDir });
  const task = (await s.call('GET', `/api/boards/${b.id}`)).json.objects[0];
  assert.equal(task.status, 'doing'); assert.equal(task.due, '2026-12-10');
});

test('project memory persists, rejects conflicting edits, and is included in AI context and board exports', async (t) => {
  let s = await startServer();
  const dataDir = s.dataDir;
  t.after(async () => { await s.app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const phone = await pairPhone(s);
  const b = s.app.store.createBoard({ name: 'Robot project' });
  const endpoint = `/api/boards/${b.id}/memory`;
  assert.equal((await s.call('PUT', endpoint, { memory: { goal: 'Build a robot arm' }, revision: 0 })).status, 403);
  assert.equal((await s.call('PUT', endpoint, { memory: { goal: 'Build a robot arm', decisions: 'Use a belt drive' }, revision: 0 }, { tok: phone })).status, 200);
  assert.equal((await s.call('PUT', endpoint, { memory: { goal: 'Stale overwrite' }, revision: 0 }, { tok: phone })).status, 409);
  assert.equal((await s.call('PUT', endpoint, { memory: { goal: 'x'.repeat(4001) }, revision: 1 }, { tok: phone })).status, 400);
  assert.equal((await s.call('PUT', endpoint, { memory: { unknown: 'value' }, revision: 1 }, { tok: phone })).status, 400);
  assert.match(boardContext({ store: s.app.store, boardId: b.id }), /Build a robot arm/);
  assert.match(boardContext({ store: s.app.store, boardId: b.id }), /Use a belt drive/);
  const exported = (await s.call('GET', `/api/boards/${b.id}/export`)).json;
  const imported = await s.call('POST', '/api/import', exported);
  assert.equal(imported.status, 201); assert.equal(imported.json.board.memory.decisions, 'Use a belt drive');
  await s.app.close(); s = await startServer({ dataDir });
  const remembered = (await s.call('GET', endpoint)).json;
  assert.equal(remembered.memory.goal, 'Build a robot arm'); assert.equal(remembered.revision, 1);
});

test('AI memory appends safely and requires a later user confirmation to replace saved text', async (t) => {
  const s = await isolated(t);
  const b = s.app.store.createBoard({ name: 'Memory tools' });
  const ctx = context(s, b.id);
  const first = await runTool('update_project_memory', { revision: 0, goal: 'Build a robot' }, ctx);
  assert.equal(first.ok, true);
  const append = await runTool('update_project_memory', { revision: 1, decisions: 'Use metric units' }, ctx);
  assert.equal(append.ok, true);
  const stale = await runTool('update_project_memory', { revision: 0, goal: 'Old edit' }, ctx);
  assert.equal(stale.ok, false);
  const replace = await runTool('update_project_memory', { revision: 2, mode: 'replace', goal: 'Build a rover' }, ctx);
  assert.equal(replace.status, 'needs_confirmation');
  assert.equal(s.app.store.getBoard(b.id).memory.goal, 'Build a robot');
  assert.equal(s.app.pending.resolve(replace.pendingId, true, { viaUser: true }).ok, true);
  assert.equal(s.app.store.getBoard(b.id).memory.goal, 'Build a rover');
});

test('v0.3 database migrates without losing existing boards or objects', async (t) => {
  let s = await startServer();
  const dataDir = s.dataDir;
  t.after(async () => { await s.app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const b = s.app.store.createBoard({ name: 'Existing project' });
  s.app.store.applyBatch(b.id, [{ op: 'put', obj: { id: 'old_note', type: 'note', text: 'Do not lose this', x: 0, y: 0 } }]);
  s.app.db.exec('ALTER TABLE boards DROP COLUMN memory; ALTER TABLE boards DROP COLUMN memory_rev; PRAGMA user_version = 1');
  await s.app.close(); s = await startServer({ dataDir });
  assert.equal(s.app.store.getObject(b.id, 'old_note').text, 'Do not lose this');
  assert.deepEqual(s.app.store.getBoard(b.id).memory, {});
  assert.equal(s.app.store.getBoard(b.id).memoryRevision, 0);
  assert.equal(s.app.db.prepare('PRAGMA user_version').get().user_version, 2);
});

test('setup is paired-device only; credentials persist but never appear in diagnostics, widgets or backups', async (t) => {
  const mock = await startMockGemini(); t.after(() => mock.close());
  let s = await startServer({ gemini: { apiKey: '', baseUrl: mock.baseUrl } });
  const dataDir = s.dataDir;
  t.after(async () => { await s.app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const phone = await pairPhone(s);
  assert.equal((await s.call('GET', '/api/diagnostics', undefined, { tok: null })).status, 401);
  assert.equal((await s.call('GET', '/api/diagnostics')).status, 403);
  assert.equal((await s.call('PUT', '/api/setup/gemini-key', { key: 'private-test-key' })).status, 403);
  assert.equal((await s.call('POST', '/api/diagnostics/gemini')).status, 403);
  assert.equal((await s.call('PUT', '/api/setup/gemini-key', { key: 'line\nbreak' }, { tok: phone })).status, 400);
  assert.equal((await s.call('PUT', '/api/setup/gemini-key', { key: 'private-test-key' }, { tok: phone })).status, 200);
  const saved = fs.readFileSync(path.join(dataDir, 'server-credentials.json'), 'utf8');
  assert.match(saved, /private-test-key/);
  const r = await s.call('POST', '/api/diagnostics/gemini', {}, { tok: phone });
  assert.equal(r.json.checks.find((c) => c.id === 'gemini-api').status, 'pass');
  assert.equal(r.json.checks.find((c) => c.id === 'gemini-text').status, 'pass');
  assert.equal(mock.requests.at(-1).key, 'private-test-key');
  for (const p of ['/api/diagnostics', '/api/settings', '/api/secrets', '/api/backup/full']) {
    const result = await s.call('GET', p, undefined, { tok: phone });
    assert.equal(result.status, 200); assert(!result.text.includes('private-test-key'));
  }
  assert.equal(s.app.secrets.list().length, 0);
  await s.app.close(); s = await startServer({ dataDir, gemini: { apiKey: '', baseUrl: mock.baseUrl } });
  assert.equal(s.app.gemini.configured, true);
  assert.equal(s.app.cfg.gemini.apiKey, 'private-test-key');
});

test('diagnostics report missing setup and redact errors returned by the provider', async (t) => {
  const s = await isolated(t, { gemini: { apiKey: '' } });
  const phone = await pairPhone(s);
  let r = await s.call('GET', '/api/diagnostics', undefined, { tok: phone });
  assert.equal(r.json.checks.find((c) => c.id === 'gemini').status, 'warn');
  assert.equal(r.json.checks.find((c) => c.id === 'database').status, 'pass');
  assert.equal(r.json.checks.find((c) => c.id === 'tv').status, 'warn');
  await s.call('PUT', '/api/setup/gemini-key', { key: 'do-not-return-this' }, { tok: phone });
  s.app.gemini.listModels = async () => { throw { status: 403, message: 'Rejected do-not-return-this' }; };
  r = await s.call('POST', '/api/diagnostics/gemini', {}, { tok: phone });
  assert.equal(r.json.checks[0].status, 'fail'); assert(!r.text.includes('do-not-return-this'));
  assert.equal((await s.call('GET', '/api/diagnostics', undefined, { tok: phone })).json.checks.find((c) => c.id === 'gemini-api').status, 'fail');
  await s.call('PUT', '/api/settings', { textModel: 'another-valid-model' }, { tok: phone });
  assert(!(await s.call('GET', '/api/diagnostics', undefined, { tok: phone })).json.checks.some((c) => c.id === 'gemini-api'), 'Model changes invalidate old diagnostic results');
});

test('lasting project memory reaches a real agent turn after its original conversation falls out of recent history', async (t) => {
  const mock = await startMockGemini(); t.after(() => mock.close());
  mock.script = () => [{ parts: [{ text: 'The goal is still available.' }] }];
  const s = await isolated(t, { gemini: { apiKey: 'mock-key', baseUrl: mock.baseUrl } });
  const b = s.app.store.createBoard({ name: 'Long project' });
  s.app.store.addMessage({ boardId: b.id, role: 'user', text: 'Original conversation with the goal' });
  s.app.store.setProjectMemory(b.id, { goal: 'Durable goal: build a belt-driven robot', nextSteps: 'Calibrate the camera' }, { expectedRevision: 0 });
  for (let i = 0; i < 32; i++) s.app.store.addMessage({ boardId: b.id, role: i % 2 ? 'assistant' : 'user', text: `Later conversation ${i}` });
  const tv = wsClient(s.base, s.token); await tv.open; t.after(() => tv.close());
  const result = await s.call('POST', '/api/ai/message', { boardId: b.id, text: 'Continue this project' });
  const turn = await tv.waitFor((m) => m.t === 'ai' && m.ev === 'done' && m.turnId === result.json.turnId);
  assert.match(turn.text, /still available/);
  const body = mock.requests.find((r) => r.path.endsWith(':streamGenerateContent')).body;
  assert.match(JSON.stringify(body.contents), /Durable goal: build a belt-driven robot/);
  assert.match(JSON.stringify(body.contents), /Calibrate the camera/);
  assert(!JSON.stringify(body.contents).includes('Original conversation with the goal'));
  const names = body.tools[0].functionDeclarations.map((f) => f.name);
  for (const name of ['add_tasks', 'update_task', 'update_project_memory']) assert(names.includes(name));
});

test('AI replacement of substantial task details waits for the user and locked tasks reject AI edits', async (t) => {
  const s = await isolated(t);
  const b = s.app.store.createBoard({ name: 'Protected tasks' });
  s.app.store.applyBatch(b.id, [{ op: 'put', obj: { id: 'task_details', type: 'task', x: 0, y: 0, text: 'User task', detail: 'Important user detail. '.repeat(10), origin: 'user' } }]);
  const ctx = context(s, b.id);
  const replacement = await runTool('update_task', { id: 'task_details', detail: 'Replace these details' }, ctx);
  assert.equal(replacement.status, 'needs_confirmation');
  assert.match(s.app.store.getObject(b.id, 'task_details').detail, /Important user detail/);
  assert.equal(s.app.pending.resolve(replacement.pendingId, true, { viaUser: true }).ok, true);
  s.app.store.applyBatch(b.id, [{ op: 'patch', id: 'task_details', set: { locked: true } }]);
  assert.equal((await runTool('update_task', { id: 'task_details', status: 'done' }, ctx)).ok, false);
  assert.equal(s.app.store.getObject(b.id, 'task_details').status, 'todo');
});

test('an invalid imported memory rolls back its board and objects', async (t) => {
  const s = await isolated(t);
  const before = s.app.store.listBoards().length;
  const result = await s.call('POST', '/api/import', {
    format: 'oboard-board', board: { name: 'Invalid memory', memory: { goal: 'x'.repeat(4001) } },
    objects: [{ id: 'imported_task', type: 'task', text: 'Should roll back', x: 0, y: 0 }],
  });
  assert.equal(result.status, 400);
  assert.equal(s.app.store.listBoards().length, before);
  assert.equal(s.app.store.searchObjects('Should roll back').length, 0);
});
