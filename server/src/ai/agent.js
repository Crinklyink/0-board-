import { rid, now, log } from '../util.js';
import { HttpError } from '../util.js';
import { GeminiError } from '../gemini.js';
import { systemPrompt } from './prompt.js';
import { boardContext } from './context.js';
import { ToolContext, toolDeclarations, runTool } from './tools.js';

const MAX_ITERATIONS = 8;
const MAX_TOOL_CALLS = 30;
const TURN_TIMEOUT_MS = 120_000;
const HISTORY_MESSAGES = 24;

/**
 * Runs one AI turn at a time per board:
 *   user input is saved first (instant) -> Gemini streams text and tool calls -> tools make real, validated,
 *   persisted canvas operations -> text deltas and tool events are pushed to every connected client.
 */
export class Agent {
  constructor({ store, hub, gemini, settings, assets, pending, config }) {
    Object.assign(this, { store, hub, gemini, settings, assets, pending, config });
    this.turns = new Map();
    this.activeByBoard = new Map();
  }

  /** Save the user's message, start the turn in the background, return immediately. */
  submit({ boardId, text, source = 'text', attachments = [], selection = [], anchor = null, deviceId = null }) {
    this.store.mustBoard(boardId);
    text = String(text || '').trim();
    if (text.length > 8000) throw new HttpError(413, 'That message is too long');
    const atts = (Array.isArray(attachments) ? attachments : []).slice(0, 6).filter((id) => this.assets.get(id));
    if (!text && !atts.length) throw new HttpError(400, 'Say or type something first');

    const turnId = rid('tn_', 10);
    const message = this.store.addMessage({
      boardId, role: 'user', text: text || '(attachment)', source, attachments: atts.length ? atts : null, turnId,
    });
    this.pending.noteUserTurn(boardId);

    if (!this.gemini.configured) {
      this.#emit({ ev: 'error', turnId, boardId, message: 'Gemini is not set up on the server yet. Add GEMINI_API_KEY to the server environment.', code: 'no_key' });
      return { turnId, messageId: message.id, started: false };
    }

    this.cancel({ boardId, reason: 'superseded' });
    const turn = {
      id: turnId, boardId, abort: new AbortController(), cancelled: false, startedAt: now(),
      message, source, attachments: atts, selection: selection.slice(0, 200), anchor, deviceId,
    };
    this.turns.set(turnId, turn);
    this.activeByBoard.set(boardId, turnId);
    this.#run(turn).catch((e) => log('error', 'turn crashed', { turnId, error: String(e?.stack || e) }));
    return { turnId, messageId: message.id, started: true };
  }

  cancel({ turnId, boardId, reason = 'user' } = {}) {
    const id = turnId || (boardId && this.activeByBoard.get(boardId));
    const turn = id && this.turns.get(id);
    if (!turn || turn.cancelled || turn.done) return false;
    turn.cancelled = true;
    turn.abort.abort();
    this.#emit({ ev: 'cancelled', turnId: turn.id, boardId: turn.boardId, reason });
    return true;
  }

  #emit(ev) {
    this.hub.broadcast({ t: 'ai', ...ev });
  }

  /**
   * If the AI just added or changed things that the TV is not showing, glide the TV camera to them,
   * so the user watches it happen instead of wondering where it went.
   */
  #reveal(ctx) {
    this.hub.reveal(ctx.boardId, ctx.takeTouched());
  }

  #history(boardId, excludeId) {
    const rows = this.store.getMessages(boardId, { limit: HISTORY_MESSAGES + 1 }).filter((m) => m.id !== excludeId);
    const contents = [];
    for (const m of rows) {
      if (!m.text?.trim() || (m.role !== 'user' && m.role !== 'assistant')) continue;
      const role = m.role === 'user' ? 'user' : 'model';
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts.push({ text: m.text });
      else contents.push({ role, parts: [{ text: m.text }] });
    }
    while (contents.length && contents[0].role !== 'user') contents.shift();
    return contents;
  }

  async #run(turn) {
    const { boardId } = turn;
    const settings = this.settings.get();
    const ctx = new ToolContext({
      store: this.store, hub: this.hub, assets: this.assets, pending: this.pending, settings, boardId,
      turnId: turn.id, selection: turn.selection, anchor: turn.anchor,
    });
    ctx.tz = this.config.tz;
    const timer = setTimeout(() => turn.abort.abort(), TURN_TIMEOUT_MS);
    this.#emit({ ev: 'start', turnId: turn.id, boardId });

    let spoken = '';
    let calls = 0;
    try {
      const contents = this.#history(boardId, turn.message.id);
      const ctxText = boardContext({ store: this.store, pending: this.pending, boardId, selection: turn.selection, anchor: ctx.anchor() });
      const userParts = [{ text: `${ctxText}\n\n${turn.source === 'voice' ? 'USER (spoken)' : 'USER (typed)'}: ${turn.message.text}` }];
      for (const id of turn.attachments) {
        const f = this.assets.read(id);
        if (f && f.asset.mime.startsWith('image/') && f.data.length <= 7 * 1024 * 1024) {
          userParts.push({ inlineData: { mimeType: f.asset.mime, data: f.data.toString('base64') } });
        } else if (f && f.asset.mime === 'application/pdf' && f.data.length <= 7 * 1024 * 1024) {
          userParts.push({ inlineData: { mimeType: f.asset.mime, data: f.data.toString('base64') } });
        }
      }
      contents.push({ role: 'user', parts: userParts });

      const system = systemPrompt({ tz: this.config.tz, extra: settings.extraInstructions });
      const tools = toolDeclarations();

      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        const parts = [];
        const fcalls = [];
        let iterText = '';
        let blocked = null;
        for await (const chunk of this.gemini.stream({
          model: settings.textModel, system, contents, tools, thinkingLevel: settings.thinkingLevel,
        }, turn.abort.signal)) {
          if (turn.cancelled) break;
          if (chunk.blockReason) blocked = chunk.blockReason;
          for (const p of chunk.parts) {
            if (p.thought) continue;
            const last = parts[parts.length - 1];
            if (typeof p.text === 'string' && Object.keys(p).length === 1 && last && typeof last.text === 'string' && Object.keys(last).length === 1) {
              last.text += p.text; // merge plain adjacent text, but never touch parts carrying thought signatures
            } else {
              parts.push({ ...p });
            }
            if (typeof p.text === 'string' && p.text) {
              iterText += p.text;
              this.#emit({ ev: 'delta', turnId: turn.id, boardId, text: p.text });
            }
            if (p.functionCall) fcalls.push(p.functionCall);
          }
        }
        if (turn.cancelled) return;
        if (blocked) throw new GeminiError(400, `Gemini declined this request (${blocked}).`);
        spoken += (spoken && iterText ? ' ' : '') + iterText.trim();

        if (!fcalls.length) break;
        contents.push({ role: 'model', parts });

        const responses = [];
        for (const fc of fcalls) {
          if (++calls > MAX_TOOL_CALLS) throw new Error('Too many tool calls in one turn');
          const result = runTool(fc.name, fc.args, ctx);
          this.#emit({ ev: 'tool', turnId: turn.id, boardId, name: fc.name, ok: result?.ok !== false, status: result?.status || null });
          if (fc.name !== 'focus_tv') this.#reveal(ctx);
          responses.push({ functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response: sanitize(result) } });
        }
        contents.push({ role: 'user', parts: responses });
        if (ctx.imagesForNextTurn.length) {
          contents.push({
            role: 'user',
            parts: [{ text: 'These are the images you asked to see:' }, ...ctx.imagesForNextTurn.map((i) => ({ inlineData: { mimeType: i.mime, data: i.data } }))],
          });
          ctx.imagesForNextTurn = [];
        }
        if (ctx.switchedTo) ctx.boardId = ctx.switchedTo;
      }

      turn.done = true;
      const finalText = spoken.trim();
      let messageId = null;
      if (finalText && !ctx.skipReply) {
        messageId = this.store.addMessage({ boardId, role: 'assistant', text: finalText, source: 'ai', turnId: turn.id, meta: ctx.batches.length ? { batches: ctx.batches } : null }).id;
      }
      this.#emit({ ev: 'done', turnId: turn.id, boardId, text: finalText, messageId, changed: ctx.changed, batches: ctx.batches, tools: calls });
    } catch (e) {
      turn.done = true;
      if (turn.cancelled) return;
      const msg = e instanceof GeminiError ? friendly(e) : e.name === 'AbortError' ? 'That took too long, so I stopped.' : `Something went wrong: ${e.message}`;
      log('warn', 'turn failed', { turnId: turn.id, error: String(e?.message || e) });
      this.#emit({ ev: 'error', turnId: turn.id, boardId, message: msg, code: e instanceof GeminiError ? `gemini_${e.status}` : 'internal' });
    } finally {
      clearTimeout(timer);
      if (this.activeByBoard.get(boardId) === turn.id) this.activeByBoard.delete(boardId);
      setTimeout(() => this.turns.delete(turn.id), 60_000).unref?.();
    }
  }
}

function sanitize(result) {
  // functionResponse.response must be an object.
  const r = result && typeof result === 'object' ? result : { result };
  return JSON.parse(JSON.stringify(r));
}

function friendly(e) {
  if (e.status === 429) return 'Gemini is rate limiting me right now. Give it a moment and try again.';
  if (e.status === 401 || e.status === 403) return 'Gemini rejected the API key. Check GEMINI_API_KEY on the server.';
  if (e.status === 404) return `Gemini does not know that model (${e.message}). Pick another in Settings.`;
  if (e.status === 0) return 'I could not reach Gemini. Check the Pi\'s internet connection.';
  return `Gemini error: ${e.message}`;
}
