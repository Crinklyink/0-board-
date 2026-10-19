import { rid } from '../util.js';
import { systemPrompt } from './prompt.js';
import { boardContext } from './context.js';
import { ToolContext, toolDeclarations, runTool } from './tools.js';

const LIVE_WS_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

/**
 * Gemini Live support. Audio never touches the Pi: the phone opens the Live socket itself using a one-use,
 * short-lived token minted here, so the real API key stays on the server. Tool calls coming back from Live
 * are executed here (same validated tools as the text path) so every board change is persisted and synced.
 */
export class LiveService {
  constructor({ store, hub, gemini, settings, assets, pending, config }) {
    Object.assign(this, { store, hub, gemini, settings, assets, pending, config });
  }

  async start({ boardId, selection = [] }) {
    const s = this.settings.get();
    this.store.mustBoard(boardId);
    const minted = await this.gemini.createEphemeralToken({ model: s.liveModel, lockConfig: {} });
    const sessionId = rid('ls_', 10);
    const setup = this.#setup({ boardId, selection, settings: s });
    return {
      sessionId,
      token: minted.token,
      expiresAt: minted.expiresAt,
      newSessionExpiresAt: minted.newSessionExpiresAt,
      model: s.liveModel,
      wsUrl: `${this.config.gemini.liveWsBase}${LIVE_WS_PATH}?access_token=${encodeURIComponent(minted.token)}`,
      setup,
    };
  }

  /** The `setup` frame the phone sends first. Built server-side so prompt and tools stay consistent. */
  #setup({ boardId, selection, settings }) {
    const ctx = boardContext({ store: this.store, pending: this.pending, boardId, selection, anchor: this.hub.display.cam });
    return {
      model: `models/${settings.liveModel}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.liveVoice } } },
      },
      systemInstruction: {
        parts: [{ text: `${systemPrompt({ live: true, tz: this.config.tz, extra: settings.extraInstructions })}\n\nCURRENT BOARD (call read_board for a fresh view)\n${ctx}` }],
      },
      tools: [{ functionDeclarations: toolDeclarations() }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: false, startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH', endOfSpeechSensitivity: 'END_SENSITIVITY_LOW', prefixPaddingMs: 120, silenceDurationMs: 600 },
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
      },
      sessionResumption: {},
      contextWindowCompression: { slidingWindow: {} },
    };
  }

  /** Execute one tool call that Gemini Live asked the phone to perform. */
  runTool({ boardId, name, args, selection = [], sessionId }) {
    const ctx = new ToolContext({
      store: this.store, hub: this.hub, assets: this.assets, pending: this.pending, settings: this.settings.get(), boardId,
      turnId: sessionId || 'live', selection, live: true,
    });
    ctx.tz = this.config.tz;
    const result = runTool(name, args, ctx);
    if (name !== 'focus_tv') this.hub.reveal(ctx.boardId, ctx.takeTouched());
    return { result: JSON.parse(JSON.stringify(result && typeof result === 'object' ? result : { result })), boardId: ctx.switchedTo || boardId, changed: ctx.changed, batches: ctx.batches };
  }

  /** Persist what was said during a Live session, so history and recall work the same as for text turns. */
  transcript({ boardId, role, text, sessionId }) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    this.store.mustBoard(boardId);
    if (role === 'user') this.pending.noteUserTurn(boardId);
    return this.store.addMessage({ boardId, role: role === 'user' ? 'user' : 'assistant', text: clean, source: 'live', turnId: sessionId || null });
  }
}
