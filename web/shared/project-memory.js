export const MEMORY_FIELDS = [
  ['goal', 'Goal'], ['decisions', 'Decisions'], ['questions', 'Open questions'], ['nextSteps', 'Next steps'],
];

// Merge independent edits; a simultaneous edit to the same field always needs a human choice.
export function mergeProjectMemory(base, draft, latest) {
  const merged = {}, conflicts = [];
  for (const [key, label] of MEMORY_FIELDS) {
    const before = base[key] || '', mine = draft[key] || '', theirs = latest[key] || '';
    if (mine === before) merged[key] = theirs;
    else if (theirs === before || mine === theirs) merged[key] = mine;
    else { merged[key] = mine; conflicts.push({ key, label, draft: mine, latest: theirs }); }
  }
  return { merged, conflicts };
}
