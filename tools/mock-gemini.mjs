#!/usr/bin/env node
// DEV TOOL ONLY. A tiny stand-in for the Gemini REST API so the UI and server tools can be exercised without a key:
//   node tools/mock-gemini.mjs            (listens on :8099)
//   GEMINI_API_KEY=dev GEMINI_BASE_URL=http://127.0.0.1:8099 node server/src/index.js
// It reacts to keywords in the user's message by calling the real server tools. It is NOT an AI and understands nothing.
import http from 'node:http';
import { createRequire } from 'node:module';

const PORT = Number(process.env.MOCK_PORT || 8099);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => ({ parts: [{ text }] });
const call = (name, args) => ({ parts: [{ functionCall: { name, args } }] });

function lastUserText(contents) {
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i];
    if (c.role !== 'user') continue;
    const t = c.parts.find((p) => p.text)?.text;
    if (t) return t.split('USER (spoken): ').pop().split('USER (typed): ').pop();
  }
  return '';
}

function respond(body) {
  const contents = body.contents;
  const last = contents.at(-1);
  const sawTool = last.parts.some((p) => p.functionResponse);
  const text = lastUserText(contents).toLowerCase();
  if (sawTool) {
    const fr = last.parts.find((p) => p.functionResponse).functionResponse;
    if (fr.response?.status === 'needs_confirmation') return [say('That would remove several things. Want me to go ahead?')];
    return [say(fr.response?.ok === false ? `I hit a problem: ${fr.response.error}` : 'Done. It is on the board now.')];
  }
  if (/diagram/.test(text)) {
    return [call('create_diagram', {
      title: 'Desk robot',
      nodes: [{ key: 'cam', label: 'Camera' }, { key: 'brain', label: 'Object detector', detail: 'runs on the Pi' }, { key: 'arm', label: 'Robotic arm', shape: 'pill' }, { key: 'desk', label: 'Desk', shape: 'ellipse' }],
      edges: [{ from: 'cam', to: 'brain', label: 'frames' }, { from: 'brain', to: 'arm', label: 'targets' }, { from: 'arm', to: 'desk' }],
      direction: 'LR',
    })];
  }
  if (/delete|clear|remove/.test(text)) return [call('delete_objects', { ids: [...(body.contents.at(-1).parts[0].text?.matchAll(/- ([a-z]_[A-Za-z0-9]{9}) /g) || [])].map((m) => m[1]) })];
  if (/undo/.test(text)) return [call('undo_ai_change', {})];
  if (/explain|tell me everything/.test(text)) {
    return [say('Sure. The arm has three parts. First, a camera above the desk looks down and spots each object. ' +
      'Second, a small model on the Pi decides what the object is and where it belongs. ' +
      'Third, the arm picks it up with suction or the gripper and drops it in the right zone. ' +
      'If anything is unclear it asks you instead of guessing. Over time it learns where you like things to live, ' +
      'so the desk stays the way you want it without you thinking about it.')];
  }
  if (/note|idea|put|board/.test(text)) {
    return [call('add_notes', { notes: [{ text: 'Robotic arm that sorts the desk', tag: 'idea' }, { text: 'Suction cups handle light items; a gripper handles pens', tag: 'suggestion' }, { text: 'Where does the camera mount?', tag: 'question' }], layout: 'row' })];
  }
  return [say('Tell me more. What should the arm do first?')];
}

// ---- fake Gemini Live (BidiGenerateContent over WebSocket) --------------------------------------------------
// Speaks the Live message shapes so the phone's Live client can be exercised end to end: setup -> setupComplete,
// streamed mic audio -> input transcription + a tool call -> (phone runs it on the Pi) toolResponse -> spoken reply.
const liveLog = [];
function liveSession(ws, url) {
  const log = (e) => { liveLog.push({ t: Date.now(), ...e }); console.log('[live]', JSON.stringify(e).slice(0, 160)); };
  if (!url.searchParams.get('access_token')) { log({ ev: 'rejected-no-token' }); ws.close(1008, 'token required'); return; }
  let audioBytes = 0;
  let phase = 0;
  const send = (o) => ws.send(JSON.stringify(o));
  ws.on('message', async (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.setup) {
      log({ ev: 'setup', model: m.setup.model, tools: m.setup.tools?.[0]?.functionDeclarations?.length || 0, hasSystem: !!m.setup.systemInstruction, resumeHandle: m.setup.sessionResumption?.handle || null });
      send({ setupComplete: {} });
      send({ sessionResumptionUpdate: { newHandle: 'mock-handle-1', resumable: true } });
      return;
    }
    if (m.realtimeInput?.audio) {
      audioBytes += Math.floor((m.realtimeInput.audio.data.length * 3) / 4);
      if (phase === 0 && audioBytes > 16000 * 2) { // about a second of microphone audio received
        phase = 1;
        log({ ev: 'audio-received', bytes: audioBytes, mime: m.realtimeInput.audio.mimeType });
        send({ serverContent: { inputTranscription: { text: 'Put a note on the board ' } } });
        send({ serverContent: { inputTranscription: { text: 'saying live mode works.' } } });
        send({ toolCall: { functionCalls: [{ id: 'call-1', name: 'add_notes', args: { notes: [{ text: 'Live mode works end to end', tag: 'idea' }] } }] } });
      }
      return;
    }
    if (m.toolResponse) {
      const r = m.toolResponse.functionResponses?.[0];
      log({ ev: 'toolResponse', id: r?.id, name: r?.name, ok: r?.response?.ok, created: r?.response?.created?.length || 0 });
      phase = 2;
      // ~1.2 s of a soft 220 Hz tone at 24 kHz, as six chunks, with the matching transcript
      const rate = 24000;
      for (let c = 0; c < 6; c++) {
        const n = rate / 5;
        const buf = Buffer.alloc(n * 2);
        for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * (c * n + i) / rate) * 3000), i * 2);
        send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: buf.toString('base64') } }] } } });
        if (c === 0) send({ serverContent: { outputTranscription: { text: 'Done, ' } } });
        if (c === 3) send({ serverContent: { outputTranscription: { text: 'it is on the board.' } } });
        await sleep(150);
      }
      send({ serverContent: { generationComplete: true } });
      send({ serverContent: { turnComplete: true } });
      log({ ev: 'reply-sent' });
    }
  });
  ws.on('close', (code) => log({ ev: 'closed', code }));
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/live-log') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(liveLog)); }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const url = new URL(req.url, 'http://x');
  if (url.pathname.endsWith(':streamGenerateContent')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    await sleep(350);
    for (const c of respond(body)) {
      if (c.parts[0].text) {
        // stream words so captions and speech start before the whole reply exists
        for (const w of c.parts[0].text.split(/(?<= )/)) { res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: w }] } }] })}\r\n\r\n`); await sleep(60); }
      } else {
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: c.parts }, finishReason: 'STOP' }] })}\r\n\r\n`);
      }
    }
    return res.end();
  }
  if (url.pathname.endsWith(':generateContent')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'A photo (description from the dev mock).' }] } }] }));
  }
  if (url.pathname === '/v1beta/auth_tokens') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ name: 'auth_tokens/dev-mock' })); }
  if (url.pathname === '/v1beta/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] })); }
  res.writeHead(404); res.end('{}');
});

// ws is resolved from the server's node_modules so this dev tool needs no install of its own.
const { WebSocketServer } = createRequire(new URL('../server/package.json', import.meta.url))('ws');
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.includes('BidiGenerateContent')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => liveSession(ws, url));
});
server.listen(PORT, '127.0.0.1', () => console.log(`mock Gemini on http://127.0.0.1:${PORT} (REST + Live WebSocket)`));
