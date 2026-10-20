#!/usr/bin/env node
// Isolated v0.4 browser acceptance checks. No user boards or real Gemini key are used.
// node tools/check-productivity.mjs [--out dist/qa-v0.4]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { startServer, pairPhone, startMockGemini } from '../server/test/helpers.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const { WebSocket } = require('ws');
const arg = process.argv.indexOf('--out');
const out = path.resolve(arg >= 0 ? process.argv[arg + 1] : 'dist/qa-v0.4');
fs.mkdirSync(out, { recursive: true });
const chromePath = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(fs.existsSync);
if (!chromePath) throw new Error('Chrome not found. Set CHROME to the executable path.');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oboard-v04-chrome-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mock = await startMockGemini();
const server = await startServer({ gemini: { apiKey: '', baseUrl: mock.baseUrl } });
const token = await pairPhone(server, 'v0.4 browser check', 'web');
server.app.backups.create('manual');
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore', windowsHide: true });
let ws;
const errors = [];
const pending = new Map();
let seq = 0;
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 10000);
  pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result?.value;
};
async function until(expression, label, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await sleep(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
const shot = async (name) => {
  await sleep(150);
  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, name), Buffer.from(data, 'base64'));
};
try {
  const activePortFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(activePortFile); i++) { if (chrome.exitCode !== null) throw new Error('Chrome exited'); await sleep(100); }
  const port = fs.readFileSync(activePortFile, 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    if (message.id) {
      const p = pending.get(message.id); if (!p) return; pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  await call('Runtime.enable'); await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `${server.base}/#t=${token}` });
  await until('window.oboard?.model.loaded && oboard.session.status === "online"', 'board startup');

  await evaluate(`oboard.ui.toggleBoards(); document.querySelector('.menu-new').click();
    document.querySelector('.productivity input[type=text]').value = 'v0.4 project';
    document.querySelector('.productivity select').value = 'project';
    document.querySelector('.productivity select').dispatchEvent(new Event('change'));
    document.querySelector('.productivity form').requestSubmit();`);
  await until('oboard.model.board?.name === "v0.4 project" && oboard.model.objects.size >= 8', 'project template');
  assert.equal(await evaluate('oboard.model.list().filter(o => o.type === "frame").length'), 4);
  console.log('PASSED: board template picker creates a saved project layout');

  await evaluate(`oboard.addTask(); const form = document.querySelector('.productivity form');
    form.querySelector('input[type=text]').value = 'Verify v0.4 on the Fold';
    form.querySelector('textarea').value = 'Install and check the new screens';
    form.querySelectorAll('select')[0].value = 'doing'; form.querySelectorAll('select')[1].value = 'high';
    form.querySelector('input[type=date]').value = '2026-12-01'; form.requestSubmit();`);
  await until('oboard.model.list().some(o => o.text === "Verify v0.4 on the Fold") && oboard.net.pending.size === 0', 'task saved');
  const taskId = await evaluate('oboard.model.list().find(o => o.text === "Verify v0.4 on the Fold").id');
  await evaluate(`{ const o = oboard.model.get(${JSON.stringify(taskId)}); oboard.camera.set(o.x + 150, o.y + 74, 1); }`);
  await sleep(150);
  const p = await evaluate(`{ const o = oboard.model.get(${JSON.stringify(taskId)}); const p = oboard.camera.toScreen(o.x + 25, o.y + 27); const r = document.querySelector('canvas').getBoundingClientRect(); ({ x: p.x + r.left, y: p.y + r.top }); }`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await until(`oboard.model.get(${JSON.stringify(taskId)}).status === 'done' && oboard.net.pending.size === 0`, 'checkbox completion');
  await evaluate('oboard.undo()');
  await until(`oboard.model.get(${JSON.stringify(taskId)}).status === 'doing' && oboard.net.pending.size === 0`, 'task undo');
  await evaluate('oboard.redo()');
  await until(`oboard.model.get(${JSON.stringify(taskId)}).status === 'done' && oboard.net.pending.size === 0`, 'task redo');
  const boardId = await evaluate('oboard.session.boardId');
  assert.equal(server.app.store.getObject(boardId, taskId).status, 'done');
  await until(`!!document.querySelector('[aria-label="Reopen task"]')`, 'task menu updates after completion');
  await evaluate(`document.querySelector('[aria-label="Reopen task"]').click()`);
  await until(`oboard.model.get(${JSON.stringify(taskId)}).status === 'todo' && oboard.net.pending.size === 0`, 'task menu reopens task');
  await until(`!!document.querySelector('[aria-label="Mark task done"]')`, 'task menu updates after reopen');
  await evaluate(`document.querySelector('[aria-label="Mark task done"]').click()`);
  await until(`oboard.model.get(${JSON.stringify(taskId)}).status === 'done' && oboard.net.pending.size === 0`, 'task menu completes task again');
  await shot('task-card.png');
  await evaluate('oboard.fit()'); await sleep(400); await shot('project-board.png');
  console.log('PASSED: task form, actual checkbox click, persistence, undo and redo');

  await evaluate('oboard.openTasks()');
  assert.equal(await evaluate('document.querySelectorAll(".task-row").length'), 3);
  assert.match(await evaluate('document.querySelector(".task-summary").textContent'), /1 of 3 done/);
  await shot('task-list.png');
  await evaluate(`{ const search = document.querySelector('[aria-label="Find a task"]'); search.value = 'Verify'; search.dispatchEvent(new Event('input')); const filter = document.querySelector('[aria-label="Filter tasks"]'); filter.value = 'done'; filter.dispatchEvent(new Event('change')); }`);
  assert.equal(await evaluate('document.querySelectorAll(".task-row").length'), 1);
  await evaluate('document.querySelector(".task-row input[type=checkbox]").click()');
  await until('document.querySelectorAll(".task-row").length === 0 && oboard.net.pending.size === 0', 'task list filters after completion change');
  server.app.store.applyBatch(boardId, [{ op: 'patch', id: taskId, set: { due: '2000-01-01' } }]);
  await until(`oboard.model.get(${JSON.stringify(taskId)}).due === '2000-01-01'`, 'task list receives live edits');
  await evaluate(`{ const filter = document.querySelector('[aria-label="Filter tasks"]'); filter.value = 'overdue'; filter.dispatchEvent(new Event('change')); }`);
  assert.equal(await evaluate('document.querySelectorAll(".task-row.overdue").length'), 1);
  await evaluate('document.querySelector(".task-row input[type=checkbox]").click()');
  await until('document.querySelectorAll(".task-row").length === 0 && oboard.net.pending.size === 0', 'completing task clears overdue filter');
  await evaluate('oboard.ui.closeOverlay()');
  console.log('PASSED: task menu can complete/reopen repeatedly; task list shows progress, filters, search and live updates');

  await evaluate('oboard.openMemory()');
  await until('document.querySelectorAll(".productivity textarea").length === 4', 'memory form');
  await evaluate(`{ const fields = document.querySelectorAll('.productivity textarea'); fields[0].value = 'Build a useful home thinking space'; fields[1].value = 'Keep data on the Pi'; fields[3].value = 'Try a real voice conversation'; document.querySelector('.productivity form').requestSubmit(); }`);
  await until('document.querySelector(".overlay").hidden', 'memory save');
  assert.equal(server.app.store.getBoard(boardId).memory.goal, 'Build a useful home thinking space');
  await evaluate('oboard.openMemory()');
  await until('document.querySelectorAll(".productivity textarea").length === 4', 'memory reopen');
  server.app.store.setProjectMemory(boardId, { questions: 'Test a concurrent edit' }, { expectedRevision: 1 });
  await evaluate(`document.querySelector('.productivity textarea').value = 'Keep my unsaved edit'; document.querySelector('.productivity form').requestSubmit();`);
  await until('document.querySelector(".productivity .picker-err")?.textContent.includes("another device")', 'conflict warning');
  assert.equal(await evaluate('document.querySelector(".productivity textarea").value'), 'Keep my unsaved edit');
  await shot('memory-conflict.png');
  await evaluate(`[...document.querySelectorAll('.productivity button')].find(b => b.textContent === 'Review latest changes').click()`);
  await until('document.querySelector(".picker-err").textContent.includes("Independent changes")', 'independent memory merge');
  await evaluate('document.querySelector(".productivity form").requestSubmit()');
  await until('document.querySelector(".overlay").hidden', 'recovered memory save');
  assert.equal(server.app.store.getBoard(boardId).memory.goal, 'Keep my unsaved edit');
  assert.equal(server.app.store.getBoard(boardId).memory.questions, 'Test a concurrent edit');
  await evaluate('oboard.openMemory()');
  await until('document.querySelectorAll(".productivity textarea").length === 4', 'memory conflict form');
  server.app.store.setProjectMemory(boardId, { goal: 'Another device goal' }, { expectedRevision: 3 });
  await evaluate(`document.querySelector('.productivity textarea').value = 'My final goal'; document.querySelector('.productivity form').requestSubmit()`);
  await until('document.querySelector(".picker-err").textContent.includes("another device")', 'same-field conflict');
  await evaluate(`[...document.querySelectorAll('.productivity button')].find(b => b.textContent === 'Review latest changes').click()`);
  await until('document.querySelectorAll(".memory-conflict").length === 1', 'memory review choices');
  assert(await evaluate('document.querySelector(".productivity [type=submit]").disabled'));
  assert(await evaluate(`{ const button = document.querySelector('.memory-conflict button'); const r = button.getBoundingClientRect(); button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }`), 'Conflict choices must be visible above the sticky footer');
  await shot('memory-review.png');
  await evaluate(`[...document.querySelectorAll('.memory-conflict button')].find(b => b.textContent === 'Keep my draft').click(); document.querySelector('.productivity form').requestSubmit()`);
  await until('document.querySelector(".overlay").hidden', 'reviewed conflict save');
  assert.equal(server.app.store.getBoard(boardId).memory.goal, 'My final goal');
  await evaluate('oboard.openMemory()');
  await until('document.querySelectorAll(".productivity textarea").length === 4', 'fresh memory');
  await shot('project-memory.png');
  console.log('PASSED: memory recovery combines independent edits and requires explicit choices for conflicts');

  await evaluate(`oboard.ui.closeOverlay(); document.querySelector('[aria-label="Setup & diagnostics"]').click()`);
  await until('document.querySelectorAll(".diagnostic").length >= 6', 'diagnostics');
  await evaluate(`document.querySelector('.productivity input[type=password]').value = 'smoke-test-key'; document.querySelector('.productivity form').requestSubmit();`);
  await until('document.querySelector(".productivity input[type=password]").value === ""', 'key save');
  await evaluate(`[...document.querySelectorAll('.productivity button')].find(b => b.textContent === 'Test Gemini connection').click()`);
  await until('document.querySelector(".diagnostic-list").textContent.includes("Google accepted the key")', 'Gemini test');
  await shot('setup-diagnostics.png');
  console.log('PASSED: diagnostics UI, key save and Gemini access check against a local stand-in');

  await call('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await evaluate('oboard.ui.closeOverlay(); oboard.ui.moreTools()');
  await evaluate(`[...document.querySelectorAll('.more-item')].find(b => b.textContent === 'Project memory').click()`);
  await until('document.querySelectorAll(".productivity textarea").length === 4', 'phone memory menu');
  assert(await evaluate('document.querySelector(".sheet").getBoundingClientRect().right <= innerWidth + 1'));
  await shot('phone-memory.png');
  await evaluate('oboard.ui.closeOverlay(); oboard.addTask()');
  assert(await evaluate('document.querySelector(".sheet").getBoundingClientRect().right <= innerWidth + 1'));
  await shot('phone-task.png');
  await evaluate('oboard.ui.closeOverlay(); oboard.ui.moreTools()');
  await evaluate(`[...document.querySelectorAll('.more-item')].find(b => b.textContent === 'Task list').click()`);
  assert(await evaluate('document.querySelector(".sheet").getBoundingClientRect().right <= innerWidth + 1 && document.querySelector(".task-list").scrollWidth <= document.querySelector(".task-list").clientWidth + 1'));
  await shot('phone-task-list.png');
  console.log('PASSED: phone-width menus, task list and task/memory sheets fit 375 px');
  assert.deepEqual(errors, [], 'Unexpected JavaScript errors');
  console.log(`PASSED: no uncaught JavaScript errors; screenshots: ${out}`);
} finally {
  ws?.close(); chrome.kill();
  await server.app.close(); await mock.close();
  for (const [dir, prefix] of [[profile, 'oboard-v04-chrome-'], [server.dataDir, 'oboard-test-']]) {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw new Error('Refusing unexpected cleanup path');
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(resolved, { recursive: true, force: true }); break; }
      catch (e) { if (i === 9) console.warn(`Temporary folder retained: ${resolved}`); else await sleep(200); }
    }
  }
}
