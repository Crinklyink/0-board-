import { HttpError } from './util.js';

const MODEL_RE = /^[A-Za-z0-9._-]{3,80}$/;
const VOICE_RE = /^[A-Za-z0-9 _-]{2,40}$/;

export class Settings {
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  get() {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'settings'`).get();
    let saved = {};
    try { saved = row ? JSON.parse(row.value) : {}; } catch { /* corrupt row => defaults */ }
    const d = this.config.defaults;
    return {
      textModel: saved.textModel || d.textModel,
      liveModel: saved.liveModel || d.liveModel,
      thinkingLevel: saved.thinkingLevel || d.thinkingLevel,
      liveVoice: saved.liveVoice || d.liveVoice,
      voiceEngine: saved.voiceEngine || 'local', // 'local' | 'live' — which one the phone should default to
      extraInstructions: saved.extraInstructions || '',
      autoCaptionImages: saved.autoCaptionImages !== false,
    };
  }

  set(patch) {
    const cur = this.get();
    const next = { ...cur };
    if (patch.textModel !== undefined) next.textModel = checkModel(patch.textModel);
    if (patch.liveModel !== undefined) next.liveModel = checkModel(patch.liveModel);
    if (patch.thinkingLevel !== undefined) {
      if (!['minimal', 'low', 'medium', 'high'].includes(patch.thinkingLevel)) throw new HttpError(400, 'thinkingLevel must be low, medium or high');
      next.thinkingLevel = patch.thinkingLevel;
    }
    if (patch.liveVoice !== undefined) {
      if (!VOICE_RE.test(patch.liveVoice)) throw new HttpError(400, 'Invalid voice name');
      next.liveVoice = patch.liveVoice;
    }
    if (patch.voiceEngine !== undefined) {
      if (!['local', 'live'].includes(patch.voiceEngine)) throw new HttpError(400, 'voiceEngine must be local or live');
      next.voiceEngine = patch.voiceEngine;
    }
    if (patch.extraInstructions !== undefined) next.extraInstructions = String(patch.extraInstructions).slice(0, 2000);
    if (patch.autoCaptionImages !== undefined) next.autoCaptionImages = !!patch.autoCaptionImages;
    this.db.prepare(`INSERT INTO meta(key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(next));
    return next;
  }
}

function checkModel(m) {
  const s = String(m).replace(/^models\//, '');
  if (!MODEL_RE.test(s)) throw new HttpError(400, 'Invalid model name');
  return s;
}
