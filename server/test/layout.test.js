import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFreeSpot, nextFlowSlot, layoutGrid, layoutGraph } from '../../web/shared/layout.js';
import { normalizeObject, normalizePatch, estimateNoteHeight, rectsOverlap, SchemaError } from '../../web/shared/schema.js';
import { startServer, wsClient, startMockGemini, call, say } from './helpers.js';

test('findFreeSpot never overlaps existing boxes and stays near the anchor', () => {
  const boxes = [];
  for (let i = 0; i < 40; i++) {
    const spot = findFreeSpot(boxes, 240, 100, { x: 0, y: 0 });
    const r = { ...spot, w: 240, h: 100 };
    for (const b of boxes) assert.ok(!rectsOverlap(r, b, 0), `spot ${i} overlaps`);
    boxes.push(r);
  }
  const far = Math.max(...boxes.map((b) => Math.hypot(b.x + 120, b.y + 50)));
  assert.ok(far < 2500, 'placements stay clustered around the anchor');
});

test('nextFlowSlot fills the shortest column (masonry) without overlaps', () => {
  const boxes = [];
  const heights = [80, 200, 120, 90, 300, 60, 150, 110];
  for (const h of heights) {
    const s = nextFlowSlot(boxes, 240, h, { cols: 3, colW: 240, gap: 24 });
    const r = { ...s, w: 240, h };
    for (const b of boxes) assert.ok(!rectsOverlap(r, b, 0));
    boxes.push(r);
  }
  assert.deepEqual([...new Set(boxes.map((b) => b.x))].sort((a, b) => a - b), [0, 264, 528]);
});

test('layoutGraph orders a chain left to right, separates layers, and survives cycles', () => {
  const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, w: 160, h: 70 }));
  const pos = layoutGraph(nodes, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }, { from: 'b', to: 'd' }], { direction: 'LR', hgap: 100 });
  assert.ok(pos.get('a').x < pos.get('b').x && pos.get('b').x < pos.get('c').x, 'chain flows left to right despite the cycle');
  assert.ok(pos.get('c').x - (pos.get('b').x + 160) >= 100, 'horizontal gap honoured');
  const rects = nodes.map((n) => ({ ...pos.get(n.id), w: n.w, h: n.h }));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.ok(!rectsOverlap(rects[i], rects[j], 0));
});

test('layoutGrid wraps rows by column count', () => {
  const pos = layoutGrid([1, 2, 3, 4, 5].map((i) => ({ id: `n${i}`, w: 100, h: 50 })), { cols: 2, gap: 10 });
  assert.equal(pos.get('n3').y, 60);
  assert.equal(pos.get('n2').x, 110);
});

test('schema: defaults, strict keys, patch rules, and height estimates', () => {
  const n = normalizeObject({ id: 'n_test0001', type: 'note', x: 1.234, y: 2, text: 'hi' });
  assert.equal(n.w, 240);
  assert.equal(n.x, 1.23, 'coordinates rounded to 2 dp');
  assert.throws(() => normalizeObject({ id: 'n_test0002', type: 'note', x: 0, y: 0, onclick: 'x' }), SchemaError);
  assert.throws(() => normalizePatch('shape', { shape: null }), SchemaError, 'required props cannot be cleared');
  assert.deepEqual(normalizePatch('note', { tag: null }), { tag: null });
  assert.ok(estimateNoteHeight('x'.repeat(600)) > estimateNoteHeight('short'));
  assert.throws(() => normalizeObject({ id: 'bad id!', type: 'note', x: 0, y: 0 }), SchemaError);
  assert.throws(() => normalizeObject({ id: 'a_arrow001', type: 'arrow', from: { id: 'x' } }), SchemaError, 'arrow needs both ends');
});

test('display fit: "show everything" and "show what I tapped" frame the TV correctly', async () => {
  const s = await startServer();
  try {
    const boardId = s.app.hub.display.boardId;
    s.app.store.applyBatch(boardId, [
      { op: 'put', obj: { id: 'n_fit00001', type: 'note', x: 0, y: 0, text: 'a' } },
      { op: 'put', obj: { id: 'n_fit00002', type: 'note', x: 4000, y: 2000, text: 'b' } },
    ], {});
    const tv = wsClient(s.base, s.token);
    await tv.open;
    tv.send({ t: 'display', patch: { viewport: { w: 1920, h: 1080 } } });
    await new Promise((r) => setTimeout(r, 50));
    s.app.hub.setDisplay({ fit: true });
    const all = s.app.hub.display.cam;
    assert.ok(Math.abs(all.x - 2120) < 2 && all.z < 0.5, `whole board framed: ${JSON.stringify(all)}`);
    s.app.hub.setDisplay({ fit: true, fitIds: ['n_fit00002'] });
    const one = s.app.hub.display.cam;
    assert.ok(Math.abs(one.x - 4120) < 2 && one.z > 1, `single note framed: ${JSON.stringify(one)}`);
    await tv.close();
  } finally { await s.app.close(); }
});

test('diagrams with labelled edges leave room so labels never sit on a box', async () => {
  const mock = await startMockGemini();
  let n = 0;
  mock.script = () => (++n === 1 ? [call('create_diagram', {
    nodes: [{ key: 'a', label: 'Camera' }, { key: 'b', label: 'Detector' }, { key: 'c', label: 'Arm' }],
    edges: [{ from: 'a', to: 'b', label: 'sends video frames' }, { from: 'b', to: 'c', label: 'target positions' }],
  })] : [say('ok')]);
  const s = await startServer({ gemini: { apiKey: 'k', baseUrl: mock.baseUrl } });
  try {
    const boardId = s.app.hub.display.boardId;
    const tv = wsClient(s.base, s.token);
    await tv.open;
    const r = await s.call('POST', '/api/ai/message', { boardId, text: 'diagram please' });
    await tv.waitFor((m) => m.t === 'ai' && m.ev === 'done' && m.turnId === r.json.turnId, 8000);
    const objs = s.app.store.getObjects(boardId);
    const box = (label) => objs.find((o) => o.text === label);
    const gap1 = box('Detector').x - (box('Camera').x + box('Camera').w);
    const gap2 = box('Arm').x - (box('Detector').x + box('Detector').w);
    const labelWidth = (t) => t.length * 6.5 + 14; // 12 px label font
    assert.ok(gap1 > labelWidth('sends video frames'), `gap ${gap1} fits its label`);
    assert.ok(gap2 > labelWidth('target positions'), `gap ${gap2} fits its label`);
    await tv.close();
  } finally { await s.app.close(); await mock.close(); }
});
