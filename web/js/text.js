import { THEME } from './theme.js';
import { NOTE_FONT, TEXT_FONT, SHAPE_FONT, NOTE_PAD } from '../shared/schema.js';

const measureCtx = document.createElement('canvas').getContext('2d');
const widthCache = new Map();
const layoutCache = new Map();
const LH = 1.4;

export function fontString(px, weight = 450) {
  return `${weight} ${px}px ${THEME.font}`;
}

function measure(str, font) {
  const key = font + '|' + str;
  let w = widthCache.get(key);
  if (w === undefined) {
    measureCtx.font = font;
    w = measureCtx.measureText(str).width;
    if (widthCache.size > 20000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}

/** Greedy word wrap that preserves explicit newlines and breaks over-long words. */
export function wrapLines(text, font, maxWidth) {
  const key = font + '|' + maxWidth + '|' + text;
  const hit = layoutCache.get(key);
  if (hit) return hit;
  const out = [];
  for (const para of String(text).split('\n')) {
    if (para === '') { out.push(''); continue; }
    const words = para.split(/(\s+)/);
    let line = '';
    for (const word of words) {
      if (!word) continue;
      const tryLine = line + word;
      if (measure(tryLine, font) <= maxWidth || !line.trim()) {
        if (measure(word, font) > maxWidth && !/\s/.test(word)) {
          // single word wider than the box: hard-break by characters
          let chunk = line;
          for (const ch of word) {
            if (measure(chunk + ch, font) > maxWidth && chunk) { out.push(chunk.trimEnd()); chunk = ''; }
            chunk += ch;
          }
          line = chunk;
        } else {
          line = tryLine;
        }
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  if (layoutCache.size > 4000) layoutCache.clear();
  layoutCache.set(key, out);
  return out;
}

export function noteMetrics(o, showTag) {
  const px = NOTE_FONT[o.size] || 15;
  const font = fontString(px);
  const lines = wrapLines(o.text || '', font, o.w - NOTE_PAD * 2);
  const tagH = showTag ? 18 : 0;
  const textH = Math.max(1, lines.length) * px * LH;
  return { px, font, lines, lh: px * LH, tagH, h: Math.max(56, Math.round(textH + NOTE_PAD * 2 + tagH)) };
}

/** Effective height: notes with autoH grow to fit their text; everything else uses the stored height. */
export function effectiveHeight(o) {
  if (o.type === 'note' && o.autoH !== false) return noteMetrics(o, tagShown(o)).h;
  if (o.type === 'text') {
    const px = TEXT_FONT[o.size] || 24;
    return Math.max(px * LH, wrapLines(o.text || '', fontString(px, 500), o.w).length * px * LH);
  }
  return o.h;
}

export const tagShown = (o) => !!o.tag && o.tag !== 'idea';

export function shapeFont(o) {
  return fontString(SHAPE_FONT[o.size] || 15, 500);
}

export function textObjFont(o) {
  return fontString(TEXT_FONT[o.size] || 24, 500);
}

export function ellipsize(str, font, maxWidth) {
  if (measure(str, font) <= maxWidth) return str;
  let s = str;
  while (s.length > 1 && measure(s + '…', font) > maxWidth) s = s.slice(0, -1);
  return s + '…';
}

export { measure };
