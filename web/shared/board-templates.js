// Shared by the server and web UI. Templates create ordinary, editable canvas objects.
export const BOARD_TEMPLATES = [
  { id: 'blank', name: 'Blank board', description: 'A clear space for your own layout.' },
  { id: 'project', name: 'Project planner', description: 'Goals, next actions, decisions and open questions.' },
  { id: 'brainstorm', name: 'Brainstorm', description: 'Collect ideas, group possibilities and choose an experiment.' },
  { id: 'decision', name: 'Decision comparison', description: 'Compare options against criteria and record your choice.' },
  { id: 'weekly', name: 'Weekly plan', description: 'Priorities, a working week and a review.' },
  { id: 'research', name: 'Research board', description: 'Questions, sources, findings and follow-up work.' },
];

const LAYOUTS = {
  project: [
    ['Goal', 'What outcome are you working toward?', 'blue'],
    ['Next actions', ['Define the first milestone', 'Choose the next small step'], 'teal'],
    ['Decisions', 'Record choices and the reasons behind them.', 'green'],
    ['Open questions', 'What needs an answer before you can move forward?', 'violet'],
  ],
  brainstorm: [
    ['Prompt', 'What problem or possibility are you exploring?', 'blue'],
    ['Ideas', 'Capture possibilities here. Keep them rough.', 'yellow'],
    ['Promising directions', 'Group related ideas and name each direction.', 'violet'],
    ['Try next', ['Choose one idea to test'], 'teal'],
  ],
  decision: [
    ['Decision and criteria', 'What are you deciding? What matters most?', 'blue'],
    ['Option A', 'Benefits, drawbacks, evidence and unknowns.', 'teal'],
    ['Option B', 'Benefits, drawbacks, evidence and unknowns.', 'violet'],
    ['Choice and follow-up', ['Gather the missing evidence', 'Record the decision and why'], 'green'],
  ],
  weekly: [
    ['This week', 'What would make this week a success?', 'blue'],
    ['Monday / Tuesday', ['Choose the first priority'], 'teal'],
    ['Wednesday / Thursday', ['Make progress on the next priority'], 'violet'],
    ['Friday / Review', ['Review progress and plan next week'], 'green'],
  ],
  research: [
    ['Research question', 'What do you need to learn, and what would count as evidence?', 'blue'],
    ['Sources', 'Add links, photos and reference notes here.', 'teal'],
    ['Findings', 'Separate supported findings from assumptions.', 'green'],
    ['Open questions', ['Check the most important unknown'], 'violet'],
  ],
};

export function buildBoardTemplate(template, makeId, timestamp = Date.now()) {
  if (!BOARD_TEMPLATES.some((t) => t.id === template)) throw new Error('Unknown board template');
  if (template === 'blank') return [];
  const objects = [];
  LAYOUTS[template].forEach(([title, contents, color], i) => {
    const x = (i % 2) * 540, y = Math.floor(i / 2) * 410;
    objects.push({ id: makeId('fr_'), type: 'frame', title, color, x, y, w: 500, h: 370 });
    if (Array.isArray(contents)) contents.forEach((text, n) => objects.push({
      id: makeId('tk_'), type: 'task', text, x: x + 24, y: y + 52 + n * 150, w: 450, h: 132,
      status: 'todo', priority: 'normal', due: '', color, origin: 'user', t: timestamp,
    }));
    else objects.push({ id: makeId('nt_'), type: 'note', text: contents, color, x: x + 24, y: y + 56, w: 450, h: 110, origin: 'user', t: timestamp });
  });
  return objects;
}
