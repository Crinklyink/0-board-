#!/usr/bin/env python3
"""
Voice benchmark for O Board's on-device models, using the same sherpa-onnx runtime (1.13.8) the Android app ships.

  python tools/bench_voice.py --models models --out models/bench-out

Measures, per model and thread count:
  - load time
  - TTS: time to first audio, real-time factor (RTF = synth seconds / audio seconds; < 1 is faster than real time)
  - ASR: decode time, RTF and word error rate on Kokoro-spoken sentences and on recorded test clips
Writes WAV samples so voices can be compared by ear, and a JSON report.

Numbers from a desktop CPU are NOT phone numbers; they are for comparing models against each other. The app has a
built-in self-test (Settings > Voice > Run voice self-test) that measures the same things on the phone.
"""
import argparse
import json
import os
import platform
import re
import time
import wave

import numpy as np
import sherpa_onnx

SENTENCES = [
    "Sure.",
    "I put three notes next to the robotic arm diagram.",
    "Want me to connect the camera to the object detector, or keep it separate for now?",
    "The gripper could use soft silicone pads, which handle pens and paper clips without scratching the desk.",
    "Here's a thought: if the arm only sorts things into four zones, you can skip the vision model at first and add it later, once the basic motion is reliable.",
]


def write_wav(path, samples, rate):
    pcm = np.clip(np.asarray(samples) * 32767, -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def read_wav(path):
    with wave.open(path, "rb") as w:
        rate = w.getframerate()
        n = w.getnframes()
        ch = w.getnchannels()
        data = np.frombuffer(w.readframes(n), dtype="<i2").astype(np.float32) / 32768
        if ch > 1:
            data = data.reshape(-1, ch).mean(axis=1)
    return data, rate


def resample(x, src, dst):
    if src == dst:
        return x
    n = int(len(x) * dst / src)
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


def wer(ref, hyp):
    norm = lambda s: re.sub(r"[^a-z0-9' ]", " ", s.lower()).split()
    r, h = norm(ref), norm(hyp)
    d = [[0] * (len(h) + 1) for _ in range(len(r) + 1)]
    for i in range(len(r) + 1):
        d[i][0] = i
    for j in range(len(h) + 1):
        d[0][j] = j
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] != h[j - 1]))
    return d[len(r)][len(h)] / max(1, len(r))


def kokoro(models, threads):
    d = os.path.join(models, "tts-kokoro-v1.0-int8")
    model = os.path.join(d, "model.int8.onnx") if os.path.exists(os.path.join(d, "model.int8.onnx")) else os.path.join(d, "model.onnx")
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=model,
                voices=os.path.join(d, "voices.bin"),
                tokens=os.path.join(d, "tokens.txt"),
                data_dir=os.path.join(d, "espeak-ng-data"),
                lexicon=os.path.join(d, "lexicon-us-en.txt"),
                lang="en-us",
            ),
            num_threads=threads,
        ),
        max_num_sentences=1,
    )
    t0 = time.perf_counter()
    tts = sherpa_onnx.OfflineTts(cfg)
    return tts, (time.perf_counter() - t0) * 1000


def bench_tts(tts, sid, speed=1.0):
    rows = []
    for s in SENTENCES:
        first = [None]
        chunks = []
        t0 = time.perf_counter()

        def cb(samples, progress):
            if first[0] is None:
                first[0] = (time.perf_counter() - t0) * 1000
            chunks.append(np.array(samples, dtype=np.float32))
            return 1

        audio = tts.generate(s, sid=sid, speed=speed, callback=cb)
        ms = (time.perf_counter() - t0) * 1000
        dur = len(audio.samples) / audio.sample_rate
        rows.append({"chars": len(s), "audio_s": round(dur, 2), "synth_ms": round(ms), "first_audio_ms": round(first[0] or ms), "rtf": round(ms / 1000 / dur, 3)})
    return rows


def qwen3(models, threads):
    d = os.path.join(models, "asr-qwen3-0.6b-int8")
    t0 = time.perf_counter()
    rec = sherpa_onnx.OfflineRecognizer.from_qwen3_asr(
        conv_frontend=os.path.join(d, "conv_frontend.onnx"),
        encoder=os.path.join(d, "encoder.int8.onnx"),
        decoder=os.path.join(d, "decoder.int8.onnx"),
        tokenizer=os.path.join(d, "tokenizer"),
        num_threads=threads,
    )
    return rec, (time.perf_counter() - t0) * 1000


def transcribe(rec, samples, rate):
    s = rec.create_stream()
    s.accept_waveform(rate, samples)
    t0 = time.perf_counter()
    rec.decode_stream(s)
    ms = (time.perf_counter() - t0) * 1000
    text = s.result.text
    text = text.split("<asr_text>")[-1]
    text = re.sub(r"<[^>]+>", "", text).strip()
    return text, ms


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="models")
    ap.add_argument("--out", default="models/bench-out")
    ap.add_argument("--threads", default="1,2,4")
    ap.add_argument("--clips", default="", help="folder with test WAVs + transcript.txt (optional)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    report = {"machine": f"{platform.processor() or platform.machine()} ({os.cpu_count()} logical cores)", "sherpa_onnx": "1.13.8", "tts": {}, "asr": {}}

    # ---------------- TTS ----------------
    for t in [int(x) for x in a.threads.split(",")]:
        tts, load = kokoro(a.models, t)
        rows = bench_tts(tts, sid=3)
        report["tts"][f"kokoro-int8 threads={t}"] = {"load_ms": round(load), "sentences": rows,
                                                     "mean_rtf": round(sum(r["rtf"] for r in rows) / len(rows), 3),
                                                     "first_audio_ms_short": rows[1]["first_audio_ms"], "first_audio_ms_long": rows[-1]["first_audio_ms"]}
        print(f"Kokoro int8, {t} thread(s): load {load:.0f} ms, mean RTF {report['tts'][f'kokoro-int8 threads={t}']['mean_rtf']}, "
              f"first audio {rows[1]['first_audio_ms']} ms (short) / {rows[-1]['first_audio_ms']} ms (long)")
    # voice samples for listening
    tts, _ = kokoro(a.models, 4)
    for sid, name in [(3, "af_heart"), (2, "af_bella"), (16, "am_michael"), (21, "bf_emma"), (26, "bm_george")]:
        audio = tts.generate(SENTENCES[3], sid=sid, speed=1.0)
        write_wav(os.path.join(a.out, f"kokoro-{name}.wav"), audio.samples, audio.sample_rate)

    # ---------------- ASR ----------------
    spoken = []
    for i, s in enumerate(SENTENCES[1:]):
        audio = tts.generate(s, sid=16, speed=1.0)
        spoken.append((s, resample(np.array(audio.samples, dtype=np.float32), audio.sample_rate, 16000)))
    clips = []
    if a.clips and os.path.exists(os.path.join(a.clips, "transcript.txt")):
        for line in open(os.path.join(a.clips, "transcript.txt"), encoding="utf-8"):
            parts = line.strip().split(maxsplit=1)
            if len(parts) == 2 and os.path.exists(os.path.join(a.clips, parts[0])):
                x, r = read_wav(os.path.join(a.clips, parts[0]))
                clips.append((parts[0], parts[1], resample(x, r, 16000)))
    for t in [int(x) for x in a.threads.split(",")]:
        rec, load = qwen3(a.models, t)
        rows = []
        for ref, x in spoken:
            hyp, ms = transcribe(rec, x, 16000)
            rows.append({"audio_s": round(len(x) / 16000, 2), "decode_ms": round(ms), "rtf": round(ms / 1000 / (len(x) / 16000), 3), "wer": round(wer(ref, hyp), 3), "heard": hyp})
        clip_rows = []
        for name, ref, x in clips:
            hyp, ms = transcribe(rec, x, 16000)
            clip_rows.append({"clip": name, "audio_s": round(len(x) / 16000, 2), "decode_ms": round(ms), "rtf": round(ms / 1000 / (len(x) / 16000), 3), "ref": ref, "heard": hyp})
        key = f"qwen3-asr-0.6b-int8 threads={t}"
        report["asr"][key] = {"load_ms": round(load), "kokoro_speech": rows, "recorded_clips": clip_rows,
                              "mean_rtf": round(sum(r["rtf"] for r in rows) / len(rows), 3), "mean_wer": round(sum(r["wer"] for r in rows) / len(rows), 3)}
        print(f"Qwen3-ASR int8, {t} thread(s): load {load:.0f} ms, mean RTF {report['asr'][key]['mean_rtf']}, mean WER {report['asr'][key]['mean_wer']}")
        for c in clip_rows:
            print(f"   {c['clip']}: RTF {c['rtf']}  heard: {c['heard'][:90]}")

    with open(os.path.join(a.out, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    print("wrote", os.path.join(a.out, "report.json"))


if __name__ == "__main__":
    main()
