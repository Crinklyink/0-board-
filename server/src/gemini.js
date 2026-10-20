import { sleep, log } from './util.js';

export class GeminiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }

  get retriable() {
    return this.status === 429 || this.status === 500 || this.status === 503 || this.status === 504;
  }
}

/** Thin REST client for the Gemini Developer API. No SDK: fewer dependencies, easy to point at a local fake in tests. */
export class Gemini {
  constructor(config) {
    this.cfg = config.gemini;
  }

  get configured() {
    return !!this.cfg.apiKey;
  }

  #headers() {
    return { 'x-goog-api-key': this.cfg.apiKey, 'content-type': 'application/json' };
  }

  async #post(path, body, signal, attempts = 3) {
    let last;
    for (let i = 0; i < attempts; i++) {
      let res;
      try {
        res = await fetch(`${this.cfg.baseUrl}${path}`, { method: 'POST', headers: this.#headers(), body: JSON.stringify(body), signal });
      } catch (e) {
        if (signal?.aborted) throw e;
        last = new GeminiError(0, `Network error talking to Gemini: ${e.message}`);
        await sleep(500 * 2 ** i, signal).catch(() => {});
        continue;
      }
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      let msg = text.slice(0, 500);
      try { msg = JSON.parse(text).error?.message || msg; } catch { /* keep raw */ }
      last = new GeminiError(res.status, msg, text);
      if (!last.retriable || i === attempts - 1) throw last;
      log('warn', 'gemini retry', { status: res.status, attempt: i + 1 });
      await sleep(700 * 2 ** i, signal);
    }
    throw last;
  }

  /**
   * Stream a generateContent call. Yields {parts, finishReason, usage} per SSE event.
   * req: {model, system, contents, tools, thinkingLevel, temperature, maxOutputTokens}
   */
  async *stream(req, signal) {
    const body = this.#body(req);
    let res;
    try {
      res = await this.#post(`/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`, body, signal);
    } catch (e) {
      // Some models reject thinking settings; retry once without them.
      if (e instanceof GeminiError && e.status === 400 && /think/i.test(e.message) && body.generationConfig?.thinkingConfig) {
        delete body.generationConfig.thinkingConfig;
        res = await this.#post(`/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`, body, signal);
      } else {
        throw e;
      }
    }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        const ev = parseSse(raw);
        if (ev) yield ev;
      }
    }
    const tail = parseSse(buf.trim());
    if (tail) yield tail;
  }

  async generate(req, signal) {
    const body = this.#body(req);
    const res = await this.#post(`/v1beta/models/${encodeURIComponent(req.model)}:generateContent`, body, signal);
    const json = await res.json();
    const parts = json.candidates?.[0]?.content?.parts || [];
    return { parts, text: parts.filter((p) => p.text && !p.thought).map((p) => p.text).join(''), raw: json };
  }

  #body({ system, contents, tools, thinkingLevel, temperature = 0.7, maxOutputTokens = 2048, toolMode = 'AUTO' }) {
    const body = {
      contents,
      generationConfig: { temperature, maxOutputTokens },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (thinkingLevel) body.generationConfig.thinkingConfig = { thinkingLevel };
    if (tools?.length) {
      body.tools = [{ functionDeclarations: tools }];
      body.toolConfig = { functionCallingConfig: { mode: toolMode } };
    }
    return body;
  }

  async listModels(signal) {
    const res = await fetch(`${this.cfg.baseUrl}/v1beta/models?pageSize=200`, { headers: { 'x-goog-api-key': this.cfg.apiKey }, signal });
    if (!res.ok) throw new GeminiError(res.status, (await res.text()).slice(0, 300));
    const json = await res.json();
    return (json.models || []).map((m) => ({
      name: String(m.name).replace(/^models\//, ''),
      displayName: m.displayName,
      methods: m.supportedGenerationMethods || [],
    }));
  }

  /**
   * Mint a short-lived token the phone can use to open a Live API socket without ever seeing the real key.
   * The token is single-use for new sessions, expires quickly, and is locked to one model.
   */
  async createEphemeralToken({ model, lockConfig = {}, expireMinutes = 30, newSessionMinutes = 1, uses = 1 }) {
    const t = Date.now();
    const base = {
      uses,
      expireTime: new Date(t + expireMinutes * 60_000).toISOString(),
      newSessionExpireTime: new Date(t + newSessionMinutes * 60_000).toISOString(),
    };
    const constraints = { model: `models/${model}`, config: lockConfig };
    const attempts = [
      { ...base, liveConnectConstraints: constraints },
      { authToken: { ...base, bidiGenerateContentSetup: { model: `models/${model}`, ...lockConfig } } },
    ];
    let last;
    for (const body of attempts) {
      const res = await fetch(`${this.cfg.baseUrl}/v1beta/auth_tokens`, { method: 'POST', headers: this.#headers(), body: JSON.stringify(body) });
      const text = await res.text();
      if (res.ok) {
        const json = JSON.parse(text);
        if (!json.name) throw new GeminiError(502, 'Gemini returned no token name');
        return { token: json.name, expiresAt: Date.parse(base.expireTime), newSessionExpiresAt: Date.parse(base.newSessionExpireTime) };
      }
      last = new GeminiError(res.status, (() => { try { return JSON.parse(text).error?.message; } catch { return text.slice(0, 300); } })(), text);
      if (res.status !== 400) break;
    }
    throw last;
  }
}

function parseSse(raw) {
  const data = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
  if (!data) return null;
  let j;
  try { j = JSON.parse(data); } catch { return null; }
  if (j.error) throw new GeminiError(j.error.code || 500, j.error.message || 'Gemini stream error', data);
  const cand = j.candidates?.[0];
  return {
    parts: cand?.content?.parts || [],
    finishReason: cand?.finishReason || null,
    blockReason: j.promptFeedback?.blockReason || null,
    usage: j.usageMetadata || null,
  };
}
