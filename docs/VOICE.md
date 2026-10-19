# Voice: research, measurements and choices

## Goals

The spec asked for:
- realistic speech that starts quickly;
- recognition on the phone (Qwen3-ASR);
- the ability to cut the assistant off;
- hands-free conversation;
- an optional cloud mode (Gemini Live).

The constraint is the Galaxy Z Fold 7: a fast arm64 phone, but no CUDA GPU, and an NPU that general-purpose ONNX
models can't easily target. Anything on-device runs on CPU cores.

## The pipeline (default, on-device)

```
hold mic ─▶ 16 kHz PCM ─▶ Silero VAD (hands-free: finds start/end of speech)
                       ─▶ Qwen3-ASR 0.6B int8 ─▶ text ─▶ (edit, or send straight away)
                                                         │
                                         Pi ─▶ Gemini (streams reply text, runs board tools)
                                                         │
reply text ─▶ SentenceSplitter: first sentence released early ─▶ TTS (Kokoro or Supertonic) ─▶ PcmPlayer
```

How it is put together:
- **Runtime.** Everything runs in [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 1.13.8 (ONNX Runtime
  underneath). One native library covers recognition, voice activity detection and both voices, and it supports
  16 KB-page devices.
- **Starting fast.**
  - The assistant is told to keep its first sentence short.
  - The phone starts speaking that sentence while the rest of the reply is still arriving and being synthesised.
- **Interruption.**
  - Every reply gets a *generation* number.
  - Stopping bumps the generation, which flushes the audio track at once (measured: silent within 3 ms) and makes any
    synthesis still running for the old reply throw its audio away.
  - The server cancels the Gemini turn too, so no more tool calls happen.
- **Hands-free.**
  - Uses the `VOICE_COMMUNICATION` audio source, so Android's echo cancellation keeps the assistant's own voice out of
    the microphone.
  - With **Interrupt by speaking** on, starting to talk stops the reply.
  - This works best with headphones.
  - The mic is only ever open while the mic button shows it (push-to-talk) or hands-free mode is on.

## Speech recognition: Qwen3-ASR 0.6B (int8)

The spec named Qwen3-ASR. It runs well on CPU through sherpa-onnx, so it was kept.

| | |
|---|---|
| Files | conv_frontend, encoder (int8), decoder (int8), tokenizer: **987 MB**, downloaded once and SHA-256-checked |
| Languages | 30; handled English, French, German and Spanish in testing |

**Accuracy and speed on the PC** (AMD, 16 threads available; same runtime as the app):

| Threads | Load | Mean real-time factor | WER on test sentences |
|---|---|---|---|
| 1 | 4.8 s | 0.43 | 0% |
| 2 | 4.3 s | 0.29 | 0% |
| 4 | 5.0 s | **0.22** | 0% |

Real-time factor (RTF) = processing time ÷ audio length; below 1 is faster than real time. At RTF 0.22, a 5-second
sentence is recognised in about 1.1 s.

**Real recordings:**
- Noisy radio chatter and fast rap were transcribed well, with a few slips on mumbled words.
- French, German and Spanish clips were accurate.
- A clip that switches between four languages mid-sentence was weak. That is expected for a 0.6B model.

**On the emulator** (x86_64, the PC's CPU): RTF 0.62, and WER 0% in the self-test.

**On the Fold 7:** not measured yet. The app's **Settings → Voice → Run voice self-test** measures it.

## Text-to-speech: what was compared

The candidates were measured with the same runtime the app ships (sherpa-onnx 1.13.8), on the same five sentences,
on the PC with 4 threads. Desktop numbers are not phone numbers; they rank the models against each other.

"First audio" is how long until the first sound for a typical one-line reply (the 50-character sentence).

| Model | Size | Mean RTF | First audio (typical reply) | Verdict |
|---|---|---|---|---|
| **Kokoro 82M v1.0, fp32** | 350 MB | **0.41** | 1.1 s | **Default.** Most natural voices, 28 English speakers (US and UK) |
| Kokoro 82M v1.0, int8 | 132 MB | 1.39 | 3.7 s | Rejected: about 3.4× *slower* than fp32 here; dynamic-int8 kernels are poorly optimised |
| **Supertonic 3, int8** | 129 MB | **0.17** | 0.63 s | **Optional "fastest" voice.** Slightly less expressive, 10 voices |
| Kitten TTS mini v0.8 | — | 0.75 | 2.2 s | Rejected: slower than Kokoro fp32 and less natural |
| Pocket TTS, int8 | — | 0.33 | 0.64 s | Rejected: fast and good, but the available ONNX export is under a non-commercial licence |
| Qwen3-TTS 0.6B (PyTorch, CPU) | 2.4 GB (fp32) | 5.52 | 19.7 s | Not shipped: about 13× slower than Kokoro, and no Android runtime. See below |

**On the emulator** (x86_64), in the app:

| Voice | Result |
|---|---|
| Kokoro | 4.31 s of speech in 2.67 s (RTF 0.62) |
| Supertonic | RTF 0.15, first audio 811 ms |

In a full conversation, the first sound came **0.65–0.77 s** after the reply text arrived.

**Choice:** Kokoro fp32 is the default, because it sounds the most human. Supertonic is offered as a one-tap
alternative when speed matters more. Both are downloads (*Settings → Voice models*), not part of the APK.

### Qwen3-TTS (the spec's "primary quality candidate")

The spec asked for this model to be measured rather than assumed to be fast enough. It was.

**Android runtime.** There is none today. sherpa-onnx (1.13.8) and ONNX Runtime Mobile don't support its architecture
(a language model that writes 12 Hz speech tokens, then a neural codec), and there is no official ONNX or mobile
export. The only way to run it is the reference PyTorch package `qwen-tts`, which is built for NVIDIA GPUs. The Fold 7
has no CUDA GPU, so on the phone it would run on CPU cores. It was measured on CPU, with
`tools/bench_qwen3_tts.py`, on the same five sentences:

| Qwen3-TTS-12Hz-0.6B-CustomVoice (fp32, PyTorch 2.14 CPU) | Mean RTF | Typical one-line reply ready after | Longest sentence (12 s of speech) |
|---|---|---|---|
| 4 threads | 5.52 | 19.7 s | 61.8 s |
| 8 threads (the Fold 7 has 8 cores) | 5.35 | 20.6 s | 54.7 s |

**What the numbers mean:**
- On a 16-core desktop CPU, Qwen3-TTS takes about **5.3–5.5× longer than the speech it makes**.
- It is about 13× slower than Kokoro fp32 and about 30× slower than Supertonic.
- Doubling the threads barely helps, because it generates speech step by step.
- With the package's standard call, audio comes back when the whole sentence is done: about 20 seconds of waiting for
  a one-line reply.
- The model can stream in principle, but at 5× slower than real time a stream would stall after its first chunk.

**Why it was not shipped:**
- Even an optimistic 4–5× speed-up from int8/GGUF-style runtimes would leave it around real time on a phone, with
  several seconds of silence first.
- It would also keep about 2.4 GB of weights (fp32; about 0.7 GB at int8) in RAM beside the 1 GB recogniser.
- That fails the "starts speaking quickly" goal.

**Decision:**
- Kokoro is the quality voice and Supertonic the fast one.
- Revisit Qwen3-TTS when sherpa-onnx or another mobile runtime supports it with streaming output.
- The WAV samples it generated are in `models/bench-out/qwen3-tts-0.6b-*.wav`, to compare with the Kokoro and
  Supertonic samples by ear.

### TV audio

Options considered:

1. **The phone speaks** (default). Lowest latency, and echo cancellation works.
2. **The phone streams its voice to the TV** (beta, *Play replies on the TV*).
   - The phone sends the generated PCM over the existing WebSocket.
   - The Pi relays it only to the TV display, and only while the user has it switched on.
   - The kiosk browser plays it through Web Audio on HDMI.
   - The voice is still made on the phone, so it costs the Pi nothing.
   - The catch is echo: the phone's microphone hears the TV, so use push-to-talk with this.
3. **Make the voice on the Pi.**
   - Rejected for now: the Pi 5 CPU would be slower than the Fold 7's at this.
   - It would compete with Chromium for 4 GB of RAM.
   - It still needs the phone to stop listening while the TV talks.

The TV path has been tested only in the browser, not on Pi hardware with HDMI audio.

## Gemini Live (optional cloud mode)

Instead of the on-device pipeline, audio goes straight to Gemini Live:
- The phone streams 16 kHz microphone audio, and Gemini answers with its own voice at 24 kHz.
- Gemini handles interruptions itself.
- Tool calls made during the conversation run on the Pi, so board changes are the same validated, undoable operations.
- The phone never holds the API key; it uses a one-time ephemeral token from the Pi (see [SECURITY.md](SECURITY.md)).

**Trade-off:** Live mode is very natural, but it needs internet, uses your Gemini quota, and sends audio to Google.
The on-device mode keeps audio on the phone.

Verified against the local stand-in:
- the session setup (model, 25 tools, prompt);
- microphone audio streaming;
- a tool call creating a real note;
- audio playback;
- transcripts saved on the Pi.

**Not yet run against Google's real Live endpoint.**

## Reproducing the measurements

Use Python 3.12 with `numpy` and `sherpa-onnx==1.13.8`.

Download the models from the sherpa-onnx `tts-models` and `asr-models` releases
(`https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/<archive>`). Unpack them under `models/`:
- `kokoro-int8-multi-lang-v1_0.tar.bz2`
- `kokoro-multi-lang-v1_0.tar.bz2`
- `kitten-mini-en-v0_8.tar.bz2`
- `sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2`
- `sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2`

Then run:

```bash
python tools/bench_voice.py --models models --out models/bench-out
```

```bash
python tools/bench_tts_compare.py --models models --out models/bench-out
```

Qwen3-TTS uses its own environment. See the header of `tools/bench_qwen3_tts.py`.

Reports (`report.json`, `tts-compare.json`, `qwen3-tts-*.json`) and WAV samples land in `models/bench-out/`, so the
voices can be compared by ear.
