import { BOARD_TEMPLATES } from '../shared/board-templates.js';
import { normalizeObject, TASK_STATUSES, TASK_PRIORITIES } from '../shared/schema.js';
import { newId } from './session.js';
import { MEMORY_FIELDS, mergeProjectMemory } from '../shared/project-memory.js';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null) node.append(child instanceof Node ? child : document.createTextNode(child));
  return node;
}
function sheet(ui, title) {
  ui.closeOverlay();
  ui.overlay.className = 'overlay sheet-wrap'; ui.overlay.hidden = false;
  const content = el('div', { class: 'picker productivity' });
  const close = el('button', { class: 'ib', type: 'button', 'aria-label': 'Close', onclick: () => ui.closeOverlay() }, '×');
  content.append(el('div', { class: 'picker-head' }, el('span', {}, title), close));
  ui.overlay.replaceChildren(el('div', { class: 'scrim', onclick: () => ui.closeOverlay() }),
    el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, content));
  return content;
}
const field = (title, input) => {
  const id = newId('field'); input.id = id;
  return el('div', { class: 'field' }, el('label', { for: id }, title), input);
};
const select = (values, current) => {
  const node = el('select', {}, values.map(([value, label]) => el('option', { value }, label)));
  node.value = current; return node;
};
const error = () => el('div', { class: 'picker-err', role: 'alert' });
const actions = (ui, label) => el('div', { class: 'picker-actions' },
  el('button', { type: 'button', class: 'btn', onclick: () => ui.closeOverlay() }, 'Cancel'),
  el('button', { type: 'submit', class: 'btn primary' }, label));

export function openTask(ui, id = null, noteId = null) {
  if (ui.tv || ui.remote) return;
  const task = id ? ui.s.model.get(id) : null;
  const note = noteId ? ui.s.model.get(noteId) : null;
  if ((id && task?.type !== 'task') || task?.locked || note?.locked) return;
  const boardId = ui.s.boardId;
  const content = sheet(ui, task ? 'Edit task' : note ? 'Create task from note' : 'Add task');
  const text = el('input', { type: 'text', maxlength: 500, required: '', placeholder: 'What needs to happen?' });
  text.value = task?.text || note?.text?.slice(0, 500) || '';
  const detail = el('textarea', { rows: 3, maxlength: 5000, placeholder: 'Optional details' });
  detail.value = task?.detail || (note && note.text?.length > 500 ? note.text.slice(0, 5000) : '');
  const status = select(TASK_STATUSES.map((s, i) => [s, ['To do', 'In progress', 'Done'][i]]), task?.status || 'todo');
  const priority = select(TASK_PRIORITIES.map((p) => [p, p[0].toUpperCase() + p.slice(1)]), task?.priority || 'normal');
  const due = el('input', { type: 'date', min: '1900-01-01', max: '9999-12-31' }); due.value = task?.due || '';
  const err = error();
  const form = el('form', { class: 'picker-form', onsubmit: (event) => {
    event.preventDefault();
    if (ui.s.boardId !== boardId) { err.textContent = 'The board changed. Reopen the task on the right board.'; return; }
    if ((id && (!ui.s.model.get(id) || ui.s.model.get(id).locked)) || (noteId && !ui.s.model.get(noteId))) { err.textContent = 'This item changed. Reopen it before saving.'; return; }
    const values = { text: text.value.trim(), detail: detail.value, status: status.value, priority: priority.value, due: due.value };
    if (!values.text) { err.textContent = 'Give the task a title.'; return; }
    const spot = ui.s.freeSpot(300, 148);
    try {
      const obj = normalizeObject({ id: task?.id || newId('tk'), type: 'task', x: spot.x, y: spot.y, w: 300, h: 148, ...values });
      if (task) ui.s.commit([{ op: 'patch', id: task.id, set: values }], { label: 'Edit task' });
      else {
        // normalizeObject fills in z: 0; drop it so create() puts the new task on top like every other new object.
        const { z: _bottom, ...fresh } = obj;
        ui.s.create({ ...fresh, color: note?.color || 'default' }, noteId ? 'Create task from note' : 'Add task');
        ui.s.setSelection([obj.id]);
      }
      ui.closeOverlay();
    } catch (ex) { err.textContent = ex.message; }
  } }, field('Task', text), field('Details', detail),
  el('div', { class: 'productivity-row' }, field('Status', status), field('Priority', priority)),
  field('Due date (optional)', due), err, actions(ui, task ? 'Save task' : 'Add task'));
  content.append(form); text.focus();
}

export async function openMemory(ui) {
  if (ui.tv || ui.remote || !ui.s.boardId) return;
  const id = ui.s.boardId;
  const content = sheet(ui, 'Project memory');
  const message = el('p', { class: 'picker-desc', role: 'status' }, 'Loading project memory…'); content.append(message);
  try {
    let data = await ui.api.get(`/api/boards/${id}/memory`);
    if (!content.isConnected) return;
    message.textContent = 'Saved on the Pi and included in every assistant turn for this board. Edit or clear any field; these are separate from canvas undo.';
    const fields = {};
    const nodes = MEMORY_FIELDS.map(([key, label]) => {
      const input = el('textarea', { rows: key === 'goal' ? 2 : 3, maxlength: 4000, placeholder: label });
      input.value = data.memory[key] || ''; fields[key] = input; return field(label, input);
    });
    const err = error();
    const review = el('div', { class: 'memory-review' });
    let unresolved = new Set();
    const reviewButton = el('button', { type: 'button', class: 'btn', onclick: async () => {
      reviewButton.disabled = true;
      try {
        const latest = await ui.api.get(`/api/boards/${id}/memory`);
        if (!content.isConnected) return;
        const draft = Object.fromEntries(Object.entries(fields).map(([k, input]) => [k, input.value]));
        const result = mergeProjectMemory(data.memory, draft, latest.memory);
        data = latest;
        for (const [key, value] of Object.entries(result.merged)) fields[key].value = value;
        unresolved = new Set(result.conflicts.map((c) => c.key));
        submitActions.querySelector('[type=submit]').disabled = unresolved.size > 0;
        review.replaceChildren();
        err.textContent = unresolved.size ? 'Choose which version to keep for each field below. Then save.' : 'Independent changes have been combined. Review the form, then save.';
        for (const conflict of result.conflicts) {
          const status = el('span', { class: 'picker-desc', role: 'status' });
          const mine = el('button', { type: 'button', class: 'btn', 'aria-pressed': 'false' }, 'Keep my draft');
          const theirs = el('button', { type: 'button', class: 'btn', 'aria-pressed': 'false' }, 'Use latest');
          const choose = (value, selected) => {
            fields[conflict.key].value = value;
            unresolved.delete(conflict.key);
            mine.setAttribute('aria-pressed', String(selected === mine)); theirs.setAttribute('aria-pressed', String(selected === theirs));
            status.textContent = selected === mine ? 'Your draft selected.' : 'Latest version selected.';
            submitActions.querySelector('[type=submit]').disabled = unresolved.size > 0;
          };
          mine.addEventListener('click', () => choose(conflict.draft, mine));
          theirs.addEventListener('click', () => choose(conflict.latest, theirs));
          review.append(el('div', { class: 'memory-conflict' }, el('strong', {}, conflict.label),
            el('span', { class: 'picker-desc' }, 'Latest saved version:'), el('pre', {}, conflict.latest || '(empty)'),
            el('div', { class: 'productivity-row' }, mine, theirs), status));
        }
        (unresolved.size ? review.firstElementChild : err).scrollIntoView({ block: 'center' });
      } catch (ex) { err.textContent = ex.message; reviewButton.disabled = false; }
    } }, 'Review latest changes');
    reviewButton.hidden = true;
    const submitActions = actions(ui, 'Save memory');
    const form = el('form', { class: 'picker-form', onsubmit: async (event) => {
      event.preventDefault();
      if (unresolved.size) { err.textContent = 'Choose which version to keep for each field before saving.'; return; }
      const button = submitActions.querySelector('[type=submit]'); button.disabled = true;
      try {
        await ui.api.put(`/api/boards/${id}/memory`, { memory: Object.fromEntries(Object.entries(fields).map(([k, input]) => [k, input.value])), revision: data.revision });
        ui.closeOverlay(); ui.toast('Project memory saved'); await ui.s.refreshBoards();
      } catch (ex) {
        if (!content.isConnected) return;
        err.textContent = ex.message; button.disabled = false;
        if (ex.status === 409) { reviewButton.hidden = false; reviewButton.disabled = false; }
      }
    } }, ...nodes, err, reviewButton, review, submitActions);
    content.append(form);
  } catch (ex) { message.textContent = ex.message; }
}

export function openTasks(ui) {
  if (ui.tv || ui.remote || !ui.s.boardId) return;
  const boardId = ui.s.boardId;
  const content = sheet(ui, 'Task list');
  const summary = el('div', { class: 'task-summary', role: 'status' });
  const progress = el('progress', { 'aria-label': 'Completed tasks' });
  const filter = select([['all', 'All tasks'], ['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done'], ['overdue', 'Overdue']], 'all');
  filter.setAttribute('aria-label', 'Filter tasks');
  const search = el('input', { type: 'search', placeholder: 'Find a task…', 'aria-label': 'Find a task' });
  const list = el('div', { class: 'task-list' });
  const render = () => {
    if (!content.isConnected) return;
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const all = ui.s.model.list().filter((o) => o.type === 'task');
    const done = all.filter((o) => o.status === 'done').length;
    const late = (o) => o.due && o.due < day && o.status !== 'done';
    const overdue = all.filter(late).length;
    summary.textContent = all.length ? `${done} of ${all.length} done${overdue ? ` · ${overdue} overdue` : ''}` : 'No tasks on this board yet.';
    progress.max = Math.max(1, all.length); progress.value = done;
    const query = search.value.trim().toLowerCase();
    const matches = all.filter((o) => (filter.value === 'all' || (filter.value === 'overdue' ? late(o) : o.status === filter.value))
      && `${o.text} ${o.detail || ''} ${o.priority} ${o.due || ''}`.toLowerCase().includes(query))
      .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || Number(!!late(b)) - Number(!!late(a))
        || Number(b.priority === 'high') - Number(a.priority === 'high') || (a.due || '9999').localeCompare(b.due || '9999') || a.text.localeCompare(b.text));
    const focused = document.activeElement?.dataset.taskToggle;
    list.replaceChildren(...matches.map((o) => {
      const check = el('input', { type: 'checkbox', 'aria-label': `Complete ${o.text}`, 'data-task-toggle': o.id, onchange: () => {
        const current = ui.s.model.get(o.id);
        if (current && !current.locked) ui.s.commit([{ op: 'patch', id: o.id, set: { status: current.status === 'done' ? 'todo' : 'done' } }], { label: 'Task status' });
      } });
      check.checked = o.status === 'done'; check.disabled = !!o.locked;
      const metadata = [o.status === 'doing' ? 'In progress' : o.status === 'done' ? 'Done' : 'To do', `${o.priority} priority`, o.due ? `${late(o) ? 'Overdue' : 'Due'} ${o.due}` : '', o.locked ? 'Locked' : ''].filter(Boolean).join(' · ');
      const title = el('button', { type: 'button', class: 'task-row-title', onclick: () => {
        ui.closeOverlay(); ui.s.setSelection([o.id]); ui.s.fitContent(true, [o.id]);
      } }, el('strong', {}, o.text || 'Untitled task'), el('span', {}, metadata));
      const edit = el('button', { type: 'button', class: 'btn', 'aria-label': `Edit ${o.text}`, onclick: () => openTask(ui, o.id) }, 'Edit'); edit.disabled = !!o.locked;
      return el('div', { class: `task-row ${late(o) ? 'overdue' : ''}` }, check, title, edit);
    }));
    if (!matches.length) list.append(el('p', { class: 'picker-desc' }, all.length ? 'No tasks match these filters.' : 'Add a task or start with a project template.'));
    if (focused) [...list.querySelectorAll('[data-task-toggle]')].find((node) => node.dataset.taskToggle === focused)?.focus();
  };
  filter.addEventListener('change', render); search.addEventListener('input', render);
  content.append(summary, progress, el('div', { class: 'productivity-row' }, field('Show', filter), field('Search', search)), list,
    el('div', { class: 'picker-actions' }, el('button', { type: 'button', class: 'btn', onclick: () => ui.closeOverlay() }, 'Close'),
      el('button', { type: 'button', class: 'btn primary', onclick: () => openTask(ui) }, 'Add task')));
  const offModel = ui.s.model.onChange(render);
  const offBoard = ui.s.on('board', (board) => { if (board.id !== boardId) ui.closeOverlay(); });
  ui.overlayCleanup = () => { offModel(); offBoard(); };
  render();
}

export function openNewBoard(ui) {
  const content = sheet(ui, 'New board');
  const name = el('input', { type: 'text', maxlength: 80, required: '', placeholder: 'Board name' });
  const template = select(BOARD_TEMPLATES.map((t) => [t.id, t.name]), 'blank');
  const description = el('p', { class: 'picker-desc' }, BOARD_TEMPLATES[0].description);
  template.addEventListener('change', () => { description.textContent = BOARD_TEMPLATES.find((t) => t.id === template.value).description; });
  const err = error();
  const buttons = actions(ui, 'Create board');
  content.append(el('form', { class: 'picker-form', onsubmit: async (event) => {
    event.preventDefault(); const submit = buttons.querySelector('[type=submit]'); submit.disabled = true;
    try {
      const result = await ui.api.post('/api/boards', { name: name.value.trim(), template: template.value });
      await ui.s.refreshBoards(); await ui.s.openBoard(result.board.id); ui.closeOverlay();
    } catch (ex) { err.textContent = ex.message; submit.disabled = false; }
  } }, field('Name', name), field('Start with', template), description, err, buttons));
  name.focus();
}

export async function openDiagnostics(ui) {
  if (ui.tv || ui.remote) return;
  const content = sheet(ui, 'Setup & diagnostics');
  const list = el('div', { class: 'diagnostic-list', role: 'status' }, 'Checking the Pi…');
  const err = error();
  const refresh = async () => {
    try {
      const data = await ui.api.get('/api/diagnostics');
      if (!content.isConnected) return;
      list.replaceChildren(...data.checks.map((c) => el('div', { class: `diagnostic ${c.status}` },
        el('strong', {}, `${c.status === 'pass' ? '✓' : c.status === 'fail' ? '×' : '!'} ${c.name}`), el('span', {}, c.detail), c.action ? el('small', {}, c.action) : null)));
    } catch (ex) { list.textContent = ex.message; }
  };
  const key = el('input', { type: 'password', autocomplete: 'new-password', maxlength: 4000, placeholder: 'Paste Gemini API key', spellcheck: 'false' });
  const keyForm = el('form', { class: 'picker-form', onsubmit: async (event) => {
    event.preventDefault(); const button = keyForm.querySelector('button'); button.disabled = true;
    try { await ui.api.put('/api/setup/gemini-key', { key: key.value }); key.value = ''; err.textContent = ''; await refresh(); ui.toast('Key saved on the Pi'); }
    catch (ex) { err.textContent = ex.message; } finally { button.disabled = false; }
  } }, field('Gemini API key', key), el('p', { class: 'picker-desc' }, 'The key is stored only on your Pi. It is never included in board exports, backups or conversations.'),
  el('button', { type: 'submit', class: 'btn primary' }, 'Save key on Pi'));
  const test = el('button', { type: 'button', class: 'btn', onclick: async () => {
    test.disabled = true; test.textContent = 'Testing…'; err.textContent = '';
    try { await ui.api.post('/api/diagnostics/gemini'); await refresh(); } catch (ex) { err.textContent = ex.message; }
    finally { test.disabled = false; test.textContent = 'Test Gemini connection'; }
  } }, 'Test Gemini connection');
  content.append(list, keyForm, err, el('div', { class: 'picker-actions' }, el('button', { type: 'button', class: 'btn', onclick: refresh }, 'Refresh'), test));
  await refresh();
}
