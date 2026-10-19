// Shared by the Pi server, the TV client and the Android WebView.
// One definition of "what is a valid canvas object" keeps AI actions, user edits and sync consistent.

export const COLORS = ['default', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'violet', 'gray'];
export const TAGS = ['', 'idea', 'fact', 'suggestion', 'question'];
export const SIZES = ['s', 'm', 'l', 'xl'];
export const SHAPES = ['rect', 'ellipse', 'diamond', 'pill'];

export const NOTE_FONT = { s: 13, m: 15, l: 19, xl: 25 };
export const TEXT_FONT = { s: 16, m: 24, l: 36, xl: 56 };
export const SHAPE_FONT = { s: 13, m: 15, l: 18, xl: 24 };
export const NOTE_WIDTH = 240;
export const NOTE_PAD = 14;

export class SchemaError extends Error {}
const bad = (m) => {
  throw new SchemaError(m);
};

const num = (min, max, dp = 2) => (v, k) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${k} must be a finite number`);
  if (v < min || v > max) bad(`${k} must be between ${min} and ${max}`);
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};
const str = (max) => (v, k) => {
  if (typeof v !== 'string') bad(`${k} must be a string`);
  if (v.length > max) bad(`${k} is too long (max ${max} characters)`);
  return v;
};
const oneOf = (list) => (v, k) => {
  if (!list.includes(v)) bad(`${k} must be one of: ${list.map((s) => s || '""').join(', ')}`);
  return v;
};
const bool = (v, k) => {
  if (typeof v !== 'boolean') bad(`${k} must be true or false`);
  return v;
};
const idStr = (v, k) => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{4,48}$/.test(v)) bad(`${k} must be a valid id`);
  return v;
};
const endpoint = (v, k) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(`${k} must be an object like {"id":"..."} or {"x":0,"y":0}`);
  const out = {};
  if (v.id !== undefined && v.id !== null) out.id = idStr(v.id, `${k}.id`);
  if (v.x !== undefined) out.x = num(-1e7, 1e7)(v.x, `${k}.x`);
  if (v.y !== undefined) out.y = num(-1e7, 1e7)(v.y, `${k}.y`);
  if (!out.id && (out.x === undefined || out.y === undefined)) bad(`${k} needs an id or both x and y`);
  for (const key of Object.keys(v)) if (!['id', 'x', 'y'].includes(key)) bad(`${k} has unknown property ${key}`);
  return out;
};
const points = (v, k) => {
  if (!Array.isArray(v) || v.length < 4 || v.length % 2 !== 0 || v.length > 20000) bad(`${k} must be an even-length number array (4..20000)`);
  return v.map((n) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) bad(`${k} contains a non-number`);
    return Math.round(n * 10) / 10;
  });
};
const meta = (v, k) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(`${k} must be an object`);
  if (JSON.stringify(v).length > 2000) bad(`${k} is too large`);
  return v;
};

const color = oneOf(COLORS);
const size = oneOf(SIZES);

const COMMON = {
  x: num(-1e7, 1e7),
  y: num(-1e7, 1e7),
  w: num(8, 40000),
  h: num(8, 40000),
  z: num(-1e9, 1e9, 3),
  origin: oneOf(['user', 'ai']),
  locked: bool,
  meta,
  t: num(0, 1e14, 0),
};

export const PROPS = {
  note: { text: str(20000), color, size, tag: oneOf(TAGS), autoH: bool },
  text: { text: str(5000), color, size, align: oneOf(['left', 'center', 'right']) },
  shape: { shape: oneOf(SHAPES), text: str(2000), color, fill: oneOf(['none', 'tint', 'solid']), size },
  frame: { title: str(200), color },
  arrow: { from: endpoint, to: endpoint, label: str(200), dash: bool, color, head: oneOf(['arrow', 'none']) },
  draw: { pts: points, color, sw: num(0.5, 40) },
  image: { asset: idStr, alt: str(500) },
  file: { asset: idStr, name: str(300), mime: str(100) },
  link: { url: str(2000), title: str(300) },
};

export const TYPES = Object.keys(PROPS);
export const isBoxType = (t) => t !== 'arrow';

// Keys that can never be removed with a null patch.
const REQUIRED = {
  note: ['x', 'y', 'w', 'h'],
  text: ['x', 'y', 'w', 'h'],
  shape: ['x', 'y', 'w', 'h', 'shape'],
  frame: ['x', 'y', 'w', 'h'],
  arrow: ['from', 'to'],
  draw: ['x', 'y', 'w', 'h', 'pts'],
  image: ['x', 'y', 'w', 'h', 'asset'],
  file: ['x', 'y', 'w', 'h', 'asset'],
  link: ['x', 'y', 'w', 'h', 'url'],
};

export function defaultsFor(type) {
  switch (type) {
    case 'note': return { w: NOTE_WIDTH, h: 96, color: 'default', size: 'm', tag: '', autoH: true, text: '' };
    case 'text': return { w: 320, h: 40, color: 'default', size: 'm', align: 'left', text: '' };
    case 'shape': return { w: 180, h: 100, color: 'blue', fill: 'tint', size: 'm', text: '' };
    case 'frame': return { w: 640, h: 420, color: 'gray', title: '' };
    case 'link': return { w: 260, h: 84, title: '' };
    case 'file': return { w: 240, h: 84, name: 'File' };
    case 'arrow': return { color: 'default', head: 'arrow', dash: false };
    default: return {};
  }
}

function checkKnown(type, key) {
  return key in COMMON || key in PROPS[type];
}

/** Validate + fill defaults for a complete object (used for `put`). Throws SchemaError. */
export function normalizeObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('object must be a JSON object');
  const type = input.type;
  if (!TYPES.includes(type)) bad(`type must be one of: ${TYPES.join(', ')}`);
  const id = idStr(input.id, 'id');
  const merged = { ...defaultsFor(type), ...input };
  const out = { id, type };
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'id' || key === 'type') continue;
    if (value === undefined || value === null) continue;
    if (!checkKnown(type, key)) bad(`unknown property "${key}" for ${type}`);
    const fn = COMMON[key] || PROPS[type][key];
    out[key] = fn(value, key);
  }
  for (const key of REQUIRED[type]) if (out[key] === undefined) bad(`${type} requires "${key}"`);
  if (type === 'draw' && (out.w === undefined || out.h === undefined)) bad('draw requires w and h');
  if (out.z === undefined) out.z = 0;
  return out;
}

/** Validate a partial update. `null` clears an optional property. Throws SchemaError. */
export function normalizePatch(type, set) {
  if (!set || typeof set !== 'object' || Array.isArray(set)) bad('set must be an object');
  const out = {};
  for (const [key, value] of Object.entries(set)) {
    if (key === 'id' || key === 'type') bad(`"${key}" cannot be changed`);
    if (!checkKnown(type, key)) bad(`unknown property "${key}" for ${type}`);
    if (value === null) {
      if (REQUIRED[type].includes(key)) bad(`"${key}" cannot be removed from ${type}`);
      out[key] = null;
      continue;
    }
    const fn = COMMON[key] || PROPS[type][key];
    out[key] = fn(value, key);
  }
  return out;
}

export function applyPatch(obj, set) {
  const next = { ...obj };
  for (const [k, v] of Object.entries(set)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

/** Only the keys whose value actually differs; used to drop no-op patches. */
export function diffPatch(obj, set) {
  const out = {};
  for (const [k, v] of Object.entries(set)) {
    const cur = obj[k];
    if (v === null ? cur !== undefined : JSON.stringify(cur) !== JSON.stringify(v)) out[k] = v;
  }
  return out;
}

export function objectText(o) {
  switch (o.type) {
    case 'note': case 'text': return o.text || '';
    case 'shape': return o.text || '';
    case 'frame': return o.title || '';
    case 'arrow': return o.label || '';
    case 'image': return o.alt || '';
    case 'file': return o.name || '';
    case 'link': return `${o.title || ''} ${o.url || ''}`.trim();
    default: return '';
  }
}

/** Rough height for a note, for server-side placement. The client measures real text and wins when autoH is on. */
export function estimateNoteHeight(text, width = NOTE_WIDTH, sz = 'm') {
  const font = NOTE_FONT[sz] || 15;
  const perLine = Math.max(8, Math.floor((width - NOTE_PAD * 2) / (font * 0.52)));
  let lines = 0;
  for (const para of String(text || '').split('\n')) lines += Math.max(1, Math.ceil(para.length / perLine));
  return Math.max(64, Math.round(lines * font * 1.4 + NOTE_PAD * 2));
}

export function withEstimatedHeight(obj) {
  if (obj.type === 'note' && obj.autoH !== false) return { ...obj, h: estimateNoteHeight(obj.text, obj.w, obj.size) };
  return obj;
}

/**
 * Bounding box for any object. Arrows need `lookup(id)` to resolve bound endpoints.
 */
export function bounds(o, lookup) {
  if (o.type === 'arrow') {
    const a = endpointPoint(o.from, lookup);
    const b = endpointPoint(o.to, lookup);
    if (!a || !b) return null;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(1, Math.abs(a.x - b.x)), h: Math.max(1, Math.abs(a.y - b.y)) };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

export function endpointPoint(ep, lookup) {
  if (!ep) return null;
  if (ep.id) {
    const t = lookup?.(ep.id);
    if (t && t.type !== 'arrow') return { x: t.x + t.w / 2, y: t.y + t.h / 2 };
  }
  if (typeof ep.x === 'number' && typeof ep.y === 'number') return { x: ep.x, y: ep.y };
  return null;
}

export function unionBounds(boxes) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const b of boxes) {
    if (!b) continue;
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  if (x1 === Infinity) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export const rectsOverlap = (a, b, pad = 0) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

export const rectContains = (outer, inner) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
