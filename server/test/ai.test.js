import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, startMockGemini, wsClient, say, call, sleep } from './helpers.js';

// These tests run the real agent loop, tools, validation and persistence against a scripted fake of the
// Gemini REST protocol. They prove the plumbing. They do NOT prove Gemini's judgment; see docs/TEST-REPORT.md.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function setup(script) {
  const mock = await startMockGemini();
  mock.script = script;
  const s = await startServer({ gemini: { apiKey: 'SERVER-SECRET-KEY', baseUrl: mock.baseUrl, liveWsBase: 'ws://127.0.0.1:9' } });
  const boardId = (await s.call('GET', '/api/boards')).json.boards.find((b) => b.kind === 'space').id;
  const tv = wsClient(s.base, s.token);
  await tv.open;
  tv.send({ t: 'sub', board: boardId });
  await tv.waitFor((m) => m.t === 'board');
  const ask = async (text, extra = {}) => {
    const r = await s.call('POST', '/api/ai/message', { boardId, text, ...extra });
    assert.equal(r.status, 202, r.text);
    return r.json;
  };
  const done = (turnId) => tv.waitFor((m) => m.t === 'ai' && (m.ev === 'done' || m.ev === 'error') && m.turnId === turnId, 8000);
  const close = async () => { await tv.close(); await s.app.close(); await mock.close(); };
  return { s, mock, boardId, tv, ask, done, close };
}

const objects = (t) => t.s.app.store.getObjects(t.boardId);

test('Test C/D — a spoken request becomes real, saved notes; events stream to the TV; history is stored', async () => {
  const t = await setup((body, i) => (i === 0
    ? [call('add_notes', { notes: [{ text: 'Robotic arm that organizes my desk', tag: 'idea' }, { text: 'Use suction cups for light items', tag: 'suggestion' }], layout: 'row' })]
    : [say('Put those on the board. '), say('Want me to sketch how the camera fits in?')]));
  try {
    const { turnId } = await t.ask('I have an idea for a robotic arm that organizes my desk. Put that on the board.', { source: 'voice' });
    const done = await t.done(turnId);
    assert.equal(done.ev, 'done', JSON.stringify(done));
    assert.match(done.text, /Put those on the board/);
    assert.equal(done.changed, 2);

    const notes = objects(t);
    assert.equal(notes.length, 2);
    assert.ok(notes.every((n) => n.type === 'note' && n.origin === 'ai'));
    assert.deepEqual(notes.map((n) => n.tag).sort(), ['idea', 'suggestion']);
    assert.ok(Math.abs(notes[0].y - notes[1].y) < 5 && notes[0].x !== notes[1].x, 'row layout places them side by side');

    // the TV client got the ops live, with the AI label
    const ops = await t.tv.waitFor((m) => m.t === 'ops' && m.actor === 'ai');
    assert.equal(ops.ops.length, 2);
    // streaming events arrived in order
    const evs = t.tv.inbox.filter((m) => m.t === 'ai' && m.turnId === turnId).map((m) => m.ev);
    assert.deepEqual([evs[0], evs.includes('delta'), evs.includes('tool'), evs.at(-1)], ['start', true, true, 'done']);

    // history persisted
    const msgs = t.s.app.store.getMessages(t.boardId);
    assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
    assert.equal(msgs[0].source, 'voice');

    // what Gemini was actually sent
    const first = t.mock.requests.find((r) => r.path.endsWith(':streamGenerateContent')).body;
    assert.match(first.systemInstruction.parts[0].text, /Everything you say is spoken aloud/);
    assert.ok(first.tools[0].functionDeclarations.some((d) => d.name === 'add_notes'));
    assert.match(first.contents.at(-1).parts[0].text, /BOARD "First board"/);
    assert.match(first.contents.at(-1).parts[0].text, /USER \(spoken\)/);
    const second = t.mock.requests.filter((r) => r.path.endsWith(':streamGenerateContent'))[1].body;
    const fr = second.contents.at(-1).parts[0].functionResponse;
    assert.equal(fr.name, 'add_notes');
    assert.equal(fr.response.ok, true);
    assert.equal(fr.response.created.length, 2, 'the model is told the real ids it just created');
    // the key is used server-side only
    assert.ok(t.mock.requests.every((r) => r.key === 'SERVER-SECRET-KEY'));
  } finally { await t.close(); }
});

test('Gemini 3 thought signatures are echoed back untouched on function-call parts', async () => {
  const t = await setup((body, i) => (i === 0
    ? [{ parts: [{ functionCall: { name: 'add_notes', args: { notes: [{ text: 'sig test' }] } }, thoughtSignature: 'SIG-123' }] }]
    : [say('ok')]));
  try {
    const { turnId } = await t.ask('add a note');
    await t.done(turnId);
    const second = t.mock.requests.filter((r) => r.path.endsWith(':streamGenerateContent'))[1].body;
    const modelTurn = second.contents.find((c) => c.role === 'model');
    assert.equal(modelTurn.parts[0].thoughtSignature, 'SIG-123');
  } finally { await t.close(); }
});

test('diagrams: nodes, bound arrows, auto layout without overlaps; extending connects to existing objects', async () => {
  const t = await setup((body, i) => {
    if (i === 0) return [call('create_diagram', {
      title: 'Desk robot',
      nodes: [{ key: 'arm', label: 'Robotic arm' }, { key: 'ctrl', label: 'Controller', shape: 'pill' }, { key: 'desk', label: 'Desk surface', detail: 'cluttered' }],
      edges: [{ from: 'ctrl', to: 'arm', label: 'drives' }, { from: 'arm', to: 'desk' }],
      direction: 'LR',
    })];
    if (i === 1) return [say('Sketched it.')];
    if (i === 2) {
      // The model sees ids in the board snapshot; the fake reads them from the snapshot text it was sent.
      const snapshot = body.contents.at(-1).parts[0].text;
      const arm = /(s_[A-Za-z0-9]{9}) shape·ai "Robotic arm"/.exec(snapshot)?.[1];
      return [call('create_diagram', { nodes: [{ key: 'cam', label: 'Camera' }], edges: [{ from: 'cam', to: arm, label: 'identifies objects' }] })];
    }
    return [say('Added the camera.')];
  });
  try {
    await t.done((await t.ask('Make this into a diagram: controller drives an arm that works on my desk')).turnId);
    let objs = objects(t);
    assert.equal(objs.filter((o) => o.type === 'shape').length, 3);
    assert.equal(objs.filter((o) => o.type === 'arrow').length, 2);
    assert.equal(objs.filter((o) => o.type === 'frame').length, 1);
    const boxes = objs.filter((o) => o.type === 'shape');
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const p = boxes[i]; const q = boxes[j];
      assert.ok(!(p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y), 'diagram nodes do not overlap');
    }
    const frame = objs.find((o) => o.type === 'frame');
    assert.ok(boxes.every((b) => b.x >= frame.x && b.x + b.w <= frame.x + frame.w && b.y >= frame.y && b.y + b.h <= frame.y + frame.h), 'frame wraps the diagram');
    const ctrl = boxes.find((b) => b.text === 'Controller');
    const arm = boxes.find((b) => b.text === 'Robotic arm');
    assert.ok(ctrl.x < arm.x, 'left-to-right flow: controller is left of the arm');

    const { turnId } = await t.ask('Wait, I want to use a camera to identify objects');
    const d2 = await t.done(turnId);
    assert.equal(d2.ev, 'done', JSON.stringify(d2));
    objs = objects(t);
    const cam = objs.find((o) => o.text === 'Camera');
    assert.ok(cam, 'camera node exists');
    const link = objs.find((o) => o.type === 'arrow' && o.from.id === cam.id && o.to.id === arm.id);
    assert.ok(link, 'camera is connected to the existing arm');
    assert.equal(link.label, 'identifies objects');
    const all = objs.filter((o) => o.type === 'shape');
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const p = all[i]; const q = all[j];
      assert.ok(!(p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y), 'new node does not overlap existing ones');
    }
  } finally { await t.close(); }
});

test('validation: bad tool arguments return a readable error to the model, change nothing, and the model can retry', async () => {
  const t = await setup((body, i) => {
    if (i === 0) return [call('edit_object', { id: 'does-not-exist', text: 'x' })];
    if (i === 1) return [call('add_notes', { notes: [{ text: '' }] })];
    if (i === 2) return [call('add_notes', { notes: [{ text: 'valid after retry', color: 'neon-pink' }] })];
    if (i === 3) return [call('add_notes', { notes: [{ text: 'valid after retry' }] })];
    return [say('Fixed it.')];
  });
  try {
    const { turnId } = await t.ask('do something');
    const d = await t.done(turnId);
    assert.equal(d.ev, 'done');
    const reqs = t.mock.requests.filter((r) => r.path.endsWith(':streamGenerateContent'));
    const resp = (n) => reqs[n].body.contents.at(-1).parts[0].functionResponse.response;
    assert.equal(resp(1).ok, false);
    assert.match(resp(1).error, /No object with id/);
    assert.match(resp(2).error, /non-empty/);
    assert.equal(resp(3).ok, false, 'invalid color rejected by schema validation');
    assert.equal(resp(4)?.ok ?? true, true);
    assert.equal(objects(t).length, 1, 'only the valid note exists');
    assert.equal(objects(t)[0].text, 'valid after retry');
  } finally { await t.close(); }
});

test('safety: deleting several objects needs confirmation; the AI cannot approve its own request; the user can', async () => {
  const t = await setup(() => [say('ok')]);
  try {
    const ids = ['n_del00001', 'n_del00002', 'n_del00003', 'n_del00004'];
    t.s.app.store.applyBatch(t.boardId, ids.map((id, i) => ({ op: 'put', obj: { id, type: 'note', x: i * 300, y: 0, text: `note ${i}` } })), { actor: 'device:me' });
    let n = 0;
    t.mock.script = (body) => {
      n++;
      if (n === 1) return [call('delete_objects', { ids })];
      if (n === 2) {
        const pid = body.contents.at(-1).parts[0].functionResponse.response.pendingId;
        t.pendingId = pid;
        return [call('resolve_pending', { id: pid, accept: true })]; // cheating in the same breath
      }
      if (n === 3) return [say('I need your yes first. Delete four notes?')];
      return [call('resolve_pending', { id: t.pendingId, accept: true })];
    };
    const a = await t.done((await t.ask('delete all of those')).turnId);
    assert.equal(a.ev, 'done');
    assert.equal(objects(t).length, 4, 'nothing deleted yet');
    const refused = t.mock.requests.filter((r) => r.path.endsWith(':streamGenerateContent'))[2].body.contents.at(-1).parts[0].functionResponse.response;
    assert.equal(refused.ok, false);
    assert.match(refused.error, /not answered yet/);
    assert.ok(t.tv.inbox.some((m) => m.t === 'pending' && /Delete 4 objects/.test(m.pending.summary)), 'confirm chip is pushed to clients');

    // user says yes in a *new* message -> model resolves it
    n = 3;
    t.mock.script = (body) => {
      n++;
      return n === 4 ? [call('resolve_pending', { id: t.pendingId, accept: true })] : [say('Deleted.')];
    };
    const b = await t.done((await t.ask('yes, go ahead')).turnId);
    assert.equal(b.ev, 'done');
    assert.equal(objects(t).length, 0, 'deleted after the user answered');
  } finally { await t.close(); }
});

test('safety: the confirm chip (tap) works too, and expired/unknown ids are harmless', async () => {
  const t = await setup((b, i) => (i === 0 ? [call('delete_objects', { ids: ['n_c0000001', 'n_c0000002', 'n_c0000003'] })] : [say('Waiting for your OK.')]));
  try {
    t.s.app.store.applyBatch(t.boardId, ['n_c0000001', 'n_c0000002', 'n_c0000003'].map((id, i) => ({ op: 'put', obj: { id, type: 'note', x: i * 300, y: 0, text: 'x' } })), {});
    await t.done((await t.ask('clear these')).turnId);
    const pend = (await t.s.call('GET', `/api/ai/pending?boardId=${t.boardId}`)).json.pending;
    assert.equal(pend.length, 1);
    assert.equal((await t.s.call('POST', '/api/ai/confirm', { id: 'pd_nonexist', accept: true })).json.ok, false);
    const r = await t.s.call('POST', '/api/ai/confirm', { id: pend[0].id, accept: true });
    assert.equal(r.json.ok, true);
    assert.equal(objects(t).length, 0);
    // and it is undoable
    const undo = await t.s.call('POST', `/api/boards/${t.boardId}/undo-ai`);
    assert.equal(undo.json.ok, true, undo.text);
    assert.equal(objects(t).length, 3);
  } finally { await t.close(); }
});

test('replacing a long note the user wrote asks first; small edits and AI-made notes do not', async () => {
  const long = 'This is my own long thought about the robot arm. '.repeat(5);
  const t = await setup((b, i) => (i === 0 ? [call('edit_object', { id: 'n_user0001', text: 'Rewritten by the AI' })]
    : i === 1 ? [say('That would replace your note. Okay?')]
      : i === 2 ? [call('edit_object', { id: 'n_user0001', text: ' And one more line.', mode: 'append' })] : [say('Appended.')]));
  try {
    t.s.app.store.applyBatch(t.boardId, [{ op: 'put', obj: { id: 'n_user0001', type: 'note', x: 0, y: 0, text: long } }], { actor: 'device:me' });
    await t.done((await t.ask('reword my note')).turnId);
    assert.equal(objects(t)[0].text, long, 'user text untouched pending confirmation');
    assert.equal(t.s.app.pending.list(t.boardId).length, 1);
    await t.done((await t.ask('append something')).turnId);
    assert.ok(objects(t)[0].text.endsWith('And one more line.'));
    assert.ok(objects(t)[0].text.startsWith('This is my own'), 'append preserves the original words');
  } finally { await t.close(); }
});

test('undo: "undo what you just changed" reverts the whole last AI turn but leaves user edits alone', async () => {
  let phase = 0;
  const t = await setup((b, i) => {
    if (phase === 0) return i === 0 ? [call('add_notes', { notes: [{ text: 'AI one' }, { text: 'AI two' }] })] : [say('Added.')];
    return i % 2 === 0 ? [call('undo_ai_change', {})] : [say('Undone.')];
  });
  try {
    t.s.app.store.applyBatch(t.boardId, [{ op: 'put', obj: { id: 'n_mine0001', type: 'note', x: -800, y: 0, text: 'mine' } }], { actor: 'device:me' });
    await t.done((await t.ask('add two notes')).turnId);
    assert.equal(objects(t).length, 3);
    phase = 1;
    t.mock.requests.length = 0;
    await t.done((await t.ask('undo what you just changed')).turnId);
    assert.deepEqual(objects(t).map((o) => o.text), ['mine']);
    assert.equal(t.s.app.store.listSnapshots(t.boardId).some((s) => /^Before:/.test(s.label)), true, 'a restorable version was saved before the AI changed things');
  } finally { await t.close(); }
});

test('go back to an earlier version: list_versions then restore_version (with confirmation)', async () => {
  let n = 0;
  const t = await setup((body) => {
    n++;
    if (n === 1) return [call('add_notes', { notes: [{ text: 'second idea' }] })];
    if (n === 2) return [say('Added.')];
    if (n === 3) return [call('list_versions', {})];
    if (n === 4) {
      const v = body.contents.at(-1).parts[0].functionResponse.response.versions;
      return [call('restore_version', { versionId: v[0].id })];
    }
    if (n === 5) return [say('Restore to the earlier version?')];
    if (n === 6) return [call('resolve_pending', { id: t.s.app.pending.list(t.boardId)[0].id, accept: true })];
    return [say('Went back.')];
  });
  try {
    t.s.app.store.applyBatch(t.boardId, [{ op: 'put', obj: { id: 'n_first001', type: 'note', x: 0, y: 0, text: 'first idea' } }], { actor: 'device:me' });
    await t.done((await t.ask('add another idea')).turnId);
    assert.equal(objects(t).length, 2);
    await t.done((await t.ask('go back to the earlier version')).turnId);
    assert.equal(objects(t).length, 2, 'not restored until the user confirms');
    await t.done((await t.ask('yes')).turnId);
    assert.deepEqual(objects(t).map((o) => o.text), ['first idea']);
  } finally { await t.close(); }
});

test('Test H (part) — interruption: cancelling mid-stream stops the turn, applies no further tool calls, and the next turn works', async () => {
  let call1 = true;
  const t = await setup(async (body, i) => {
    if (call1) {
      call1 = false;
      return [{ parts: [{ text: 'Let me think about that for a ' }] }, { delay: 700, parts: [{ text: 'while longer. ' }] }, { delay: 50, parts: [{ functionCall: { name: 'add_notes', args: { notes: [{ text: 'should never exist' }] } } }] }];
    }
    return [say('Fresh answer.')];
  });
  try {
    const { turnId } = await t.ask('long answer please');
    await t.tv.waitFor((m) => m.t === 'ai' && m.ev === 'delta' && m.turnId === turnId);
    assert.equal((await t.s.call('POST', '/api/ai/cancel', { turnId })).json.cancelled, true);
    const c = await t.tv.waitFor((m) => m.t === 'ai' && m.ev === 'cancelled' && m.turnId === turnId);
    assert.ok(c);
    await sleep(1000);
    assert.equal(objects(t).length, 0, 'tool call after the interruption never ran');
    assert.ok(!t.tv.inbox.some((m) => m.t === 'ai' && m.turnId === turnId && (m.ev === 'done' || m.ev === 'tool')), 'no done/tool events after cancel');
    assert.equal(t.s.app.store.getMessages(t.boardId).filter((m) => m.role === 'assistant').length, 0, 'no stale reply stored');
    // the user's interrupting message is processed
    const next = await t.done((await t.ask('never mind, hello')).turnId);
    assert.equal(next.text, 'Fresh answer.');
    // a new message while one is running supersedes it
    t.mock.script = async (b, i) => (i === 2 ? [{ delay: 400, parts: [{ text: 'slow one' }] }] : [say('fast one')]);
    const slow = await t.ask('first');
    await sleep(50);
    const fast = await t.ask('second');
    const f = await t.done(fast.turnId);
    assert.equal(f.text, 'fast one');
    await sleep(600);
    assert.ok(!t.tv.inbox.some((m) => m.t === 'ai' && m.turnId === slow.turnId && m.ev === 'done'), 'superseded turn never completes');
  } finally { await t.close(); }
});

test('Test G (plumbing) — an attached photo reaches Gemini byte-for-byte as inline image data', async () => {
  const t = await setup(() => [say('That looks like a tiny test image.')]);
  try {
    const up = await t.s.call('POST', '/api/assets', PNG, { raw: true, headers: { 'content-type': 'image/png', 'x-filename': 'design.png' } });
    const { turnId } = await t.ask('Look at this design. Could we make something similar?', { attachments: [up.json.asset.id] });
    await t.done(turnId);
    const req = t.mock.requests.find((r) => r.path.endsWith(':streamGenerateContent')).body;
    const img = req.contents.at(-1).parts.find((p) => p.inlineData);
    assert.ok(img, 'image part present');
    assert.equal(img.inlineData.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(img.inlineData.data, 'base64'), PNG);
    assert.equal(t.s.app.store.getMessages(t.boardId)[0].attachments[0], up.json.asset.id);
  } finally { await t.close(); }
});

test('view_images: the model can ask to see a board image; it is attached on the next step', async () => {
  let n = 0;
  const t = await setup((body) => {
    n++;
    if (n === 1) return [call('view_images', { ids: ['i_board001'] })];
    return [say('Seen it.')];
  });
  try {
    const up = await t.s.call('POST', '/api/assets', PNG, { raw: true, headers: { 'content-type': 'image/png' } });
    t.s.app.store.applyBatch(t.boardId, [{ op: 'put', obj: { id: 'i_board001', type: 'image', x: 0, y: 0, w: 100, h: 100, asset: up.json.asset.id } }], {});
    await t.done((await t.ask('compare this with the other one')).turnId);
    const second = t.mock.requests.filter((r) => r.path.endsWith(':streamGenerateContent'))[1].body;
    const last = second.contents.at(-1);
    assert.ok(last.parts.some((p) => p.inlineData && Buffer.from(p.inlineData.data, 'base64').equals(PNG)));
  } finally { await t.close(); }
});

test('organize: sections cluster notes into titled frames without altering their text', async () => {
  let n = 0;
  const t = await setup(() => {
    n++;
    return n === 1 ? [call('organize_objects', { sections: [{ title: 'Hardware', ids: ['n_org00001', 'n_org00002'] }, { title: 'Software', ids: ['n_org00003'] }] })] : [say('Grouped.')];
  });
  try {
    const mk = (id, text, x, y) => ({ op: 'put', obj: { id, type: 'note', x, y, text } });
    t.s.app.store.applyBatch(t.boardId, [mk('n_org00001', 'servo motors', 0, 0), mk('n_org00002', 'gripper', 900, 40), mk('n_org00003', 'vision model', 300, 700)], {});
    await t.done((await t.ask('organize these notes')).turnId);
    const objs = objects(t);
    const frames = objs.filter((o) => o.type === 'frame');
    assert.deepEqual(frames.map((f) => f.title).sort(), ['Hardware', 'Software']);
    assert.deepEqual(objs.filter((o) => o.type === 'note').map((o) => o.text).sort(), ['gripper', 'servo motors', 'vision model']);
    const hw = frames.find((f) => f.title === 'Hardware');
    for (const id of ['n_org00001', 'n_org00002']) {
      const o = objs.find((x) => x.id === id);
      assert.ok(o.x >= hw.x && o.x + o.w <= hw.x + hw.w && o.y >= hw.y && o.y + o.h <= hw.y + hw.h, `${id} sits inside Hardware`);
    }
  } finally { await t.close(); }
});

test('move/resize/group/connect/search/recall/forget all hit real state', async () => {
  const steps = [];
  const t = await setup((body) => {
    const k = steps.length;
    steps.push(1);
    switch (k) {
      case 0: return [call('move_objects', { ids: ['i_img00001'], nextTo: { id: 'n_ref00001', side: 'right', gap: 60 } })];
      case 1: return [call('resize_object', { id: 'i_img00001', width: 600 })];
      case 2: return [call('group_into_section', { ids: ['n_ref00001', 'i_img00001'], title: 'Inspiration' })];
      case 3: return [call('connect_objects', { connections: [{ from: 'n_ref00001', to: 'i_img00001', label: 'see' }] })];
      case 4: return [call('search_board', { query: 'suction' })];
      case 5: return [call('recall', { since: new Date(Date.now() - 3600_000).toISOString(), until: new Date(Date.now() + 3600_000).toISOString() })];
      case 6: return [call('forget_recent', { count: 1 })];
      default: return [say('Done.')];
    }
  });
  try {
    t.s.app.store.applyBatch(t.boardId, [
      { op: 'put', obj: { id: 'n_ref00001', type: 'note', x: 0, y: 0, text: 'Suction gripper reference' } },
      { op: 'put', obj: { id: 'i_img00001', type: 'image', x: 900, y: 900, w: 200, h: 100, asset: 'as_fake00001' } },
    ], { actor: 'device:me' });
    const d = await t.done((await t.ask('arrange my references')).turnId);
    assert.equal(d.ev, 'done', JSON.stringify(d));
    const reqs = t.mock.requests.filter((r) => r.path.endsWith(':streamGenerateContent'));
    const out = (step) => reqs[step + 1].body.contents.at(-1).parts[0].functionResponse.response; // result of step N is sent in request N+1
    const objs = objects(t);
    const note = objs.find((o) => o.id === 'n_ref00001');
    const img = objs.find((o) => o.id === 'i_img00001');
    assert.equal(img.x, note.x + note.w + 60, 'moved to the right of the note with the requested gap');
    assert.equal(img.w, 600);
    assert.equal(img.h, 300, 'image resize kept its aspect ratio');
    assert.equal(objs.find((o) => o.type === 'frame').title, 'Inspiration');
    assert.equal(objs.find((o) => o.type === 'arrow').label, 'see');
    assert.equal(out(4).results[0].id, 'n_ref00001');
    assert.ok(out(5).said.some((s) => /arrange my references/.test(s.text)), 'recall returns what the user said in the window');
    assert.equal(out(6).ok, true);
    assert.equal(t.s.app.store.getMessages(t.boardId).length, 0, 'forget_recent removed the exchange, and the reply was not stored');
  } finally { await t.close(); }
});

test('focus_tv: the TV camera is pointed at the object and the selection is highlighted', async () => {
  let n = 0;
  const t = await setup(() => (++n === 1 ? [call('focus_tv', { ids: ['n_far00001'], highlight: true })] : [say('Here it is.')]));
  try {
    t.s.app.store.applyBatch(t.boardId, [
      { op: 'put', obj: { id: 'n_far00001', type: 'note', x: 5000, y: 3000, text: 'far away' } },
      { op: 'put', obj: { id: 'n_near0001', type: 'note', x: 0, y: 0, text: 'near' } },
    ], {});
    await t.done((await t.ask('show me the far note')).turnId);
    const d = t.s.app.hub.display;
    assert.ok(Math.abs(d.cam.x - (5000 + 120)) < 2 && d.cam.y > 3000, `camera centred on target: ${JSON.stringify(d.cam)}`);
    assert.deepEqual(d.selection, ['n_far00001']);
    assert.equal(d.mode, 'focus');
    assert.ok(t.tv.inbox.some((m) => m.t === 'display' && m.display.mode === 'focus'));
  } finally { await t.close(); }
});

test('no API key: the message is still saved instantly and the user gets a clear error event', async () => {
  const s = await startServer({ gemini: { apiKey: '' } });
  try {
    const boardId = (await s.call('GET', '/api/boards')).json.boards.find((b) => b.kind === 'space').id;
    const tv = wsClient(s.base, s.token);
    await tv.open;
    const r = await s.call('POST', '/api/ai/message', { boardId, text: 'hello?' });
    assert.equal(r.status, 202);
    assert.equal(r.json.started, false);
    const err = await tv.waitFor((m) => m.t === 'ai' && m.ev === 'error');
    assert.match(err.message, /GEMINI_API_KEY/);
    assert.equal(s.app.store.getMessages(boardId)[0].text, 'hello?');
    assert.equal((await s.call('POST', '/api/live/token', { boardId })).status, 503);
    await tv.close();
  } finally { await s.app.close(); }
});

test('upstream failures are reported plainly (rate limit, bad key) without crashing the server', async () => {
  const mock = await startMockGemini();
  const http = await import('node:http');
  const failing = http.createServer((req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 429, message: 'quota' } })); });
  await new Promise((r) => failing.listen(0, '127.0.0.1', r));
  const s = await startServer({ gemini: { apiKey: 'k', baseUrl: `http://127.0.0.1:${failing.address().port}` } });
  try {
    const boardId = (await s.call('GET', '/api/boards')).json.boards.find((b) => b.kind === 'space').id;
    const tv = wsClient(s.base, s.token);
    await tv.open;
    await s.call('POST', '/api/ai/message', { boardId, text: 'hi' });
    const err = await tv.waitFor((m) => m.t === 'ai' && m.ev === 'error', 15000);
    assert.match(err.message, /rate limiting/);
    assert.equal((await s.call('GET', '/healthz', undefined, { tok: null })).status, 200, 'server still healthy');
    await tv.close();
  } finally { await s.app.close(); await mock.close(); failing.closeAllConnections?.(); failing.close(); }
});

test('Gemini Live: server mints a constrained one-use token; the real key never leaves the Pi; tools mutate the real board', async () => {
  const t = await setup(() => [say('unused')]);
  try {
    t.s.app.store.applyBatch(t.boardId, [{ op: 'put', obj: { id: 'n_live0001', type: 'note', x: 0, y: 0, text: 'existing note' } }], {});
    const r = await t.s.call('POST', '/api/live/token', { boardId: t.boardId });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.token, 'auth_tokens/mock-1');
    assert.ok(!r.text.includes('SERVER-SECRET-KEY'), 'real API key is never sent to the phone');
    assert.match(r.json.wsUrl, /BidiGenerateContentConstrained\?access_token=auth_tokens%2Fmock-1$/);
    const minted = t.mock.tokens[0].body;
    assert.equal(minted.uses, 1);
    assert.equal(minted.liveConnectConstraints.model, 'models/gemini-3.8-live');
    assert.ok(Date.parse(minted.newSessionExpireTime) - Date.now() <= 61_000, 'token is only valid to START a session for ~1 minute');
    assert.ok(Date.parse(minted.expireTime) - Date.now() <= 31 * 60_000);
    const setup1 = r.json.setup;
    assert.equal(setup1.model, 'models/gemini-3.8-live');
    assert.deepEqual(setup1.generationConfig.responseModalities, ['AUDIO']);
    assert.match(setup1.systemInstruction.parts[0].text, /existing note/);
    assert.ok(setup1.tools[0].functionDeclarations.some((d) => d.name === 'create_diagram'));
    assert.ok(setup1.inputAudioTranscription && setup1.outputAudioTranscription);

    const tool = await t.s.call('POST', '/api/live/tool', { boardId: t.boardId, name: 'add_notes', args: { notes: [{ text: 'created via live voice', tag: 'idea' }] }, sessionId: r.json.sessionId });
    assert.equal(tool.json.result.ok, true);
    assert.ok(objects(t).some((o) => o.text === 'created via live voice' && o.origin === 'ai'));
    const bad = await t.s.call('POST', '/api/live/tool', { boardId: t.boardId, name: 'add_notes', args: { notes: [] } });
    assert.equal(bad.json.result.ok, false);
    const unknown = await t.s.call('POST', '/api/live/tool', { boardId: t.boardId, name: 'rm_rf', args: {} });
    assert.match(unknown.json.result.error, /Unknown tool/);

    await t.s.call('POST', '/api/live/transcript', { boardId: t.boardId, role: 'user', text: 'what was I thinking about?', sessionId: r.json.sessionId });
    await t.s.call('POST', '/api/live/transcript', { boardId: t.boardId, role: 'assistant', text: 'You were on the desk robot.', sessionId: r.json.sessionId });
    assert.deepEqual(t.s.app.store.getMessages(t.boardId).map((m) => [m.role, m.source]), [['user', 'live'], ['assistant', 'live']]);
  } finally { await t.close(); }
});

test('image auto-description: uploaded photos get a searchable caption and board images are updated', async () => {
  const t = await setup(() => [say('x')]);
  try {
    t.mock.captions = 'A tiny transparent pixel, used as a placeholder';
    const up = await t.s.call('POST', '/api/assets', PNG, { raw: true, headers: { 'content-type': 'image/png' } });
    t.s.app.store.applyBatch(t.boardId, [{ op: 'put', obj: { id: 'i_cap00001', type: 'image', x: 0, y: 0, w: 100, h: 100, asset: up.json.asset.id } }], {});
    const msg = await t.tv.waitFor((m) => m.t === 'asset', 4000).catch(() => null);
    // captioning happens right after upload (before the object existed); re-trigger for the existing object
    if (!msg) {
      const { captionAsset } = await import('../src/ai/caption.js');
      t.s.app.assets.db.prepare('UPDATE assets SET caption = NULL WHERE id = ?').run(up.json.asset.id);
      await captionAsset(t.s.app, up.json.asset.id);
    }
    assert.match(t.s.app.assets.get(up.json.asset.id).caption, /placeholder/);
    assert.match(t.s.app.store.getObject(t.boardId, 'i_cap00001').alt, /placeholder/);
    assert.equal(t.s.app.store.searchObjects('placeholder').length, 1, 'now findable by what it shows');
  } finally { await t.close(); }
});

test('settings: models are configurable, validated, and used on the next turn', async () => {
  const t = await setup(() => [say('hi')]);
  try {
    assert.equal((await t.s.call('PUT', '/api/settings', { textModel: 'bad model!' })).status, 400);
    assert.equal((await t.s.call('PUT', '/api/settings', { textModel: 'gemini-9.9-flash', thinkingLevel: 'medium' })).status, 200);
    await t.done((await t.ask('hello')).turnId);
    const r = t.mock.requests.find((x) => x.path.includes(':streamGenerateContent'));
    assert.match(r.path, /models\/gemini-9\.9-flash:/);
    assert.equal(r.body.generationConfig.thinkingConfig.thinkingLevel, 'medium');
    const models = await t.s.call('GET', '/api/ai/models');
    assert.equal(models.json.models[0].name, 'gemini-3.8-flash');
  } finally { await t.close(); }
});
