#!/usr/bin/env python3
"""
Compare on-device TTS candidates with sherpa-onnx 1.13.8 on the same sentences (desktop CPU numbers; relative only).

  python tools/bench_tts_compare.py --models models --out models/bench-out

Expects unpacked model folders under --models (see docs/VOICE.md for download links):
  tts-kokoro-v1.0-int8, x-kokoro-multi-lang-v1_0, x-kitten-mini-en-v0_8,
  x-sherpa-onnx-supertonic-3-tts-int8-2026-05-11, x-sherpa-onnx-pocket-tts-int8-2026-01-26
"""
import argparse
import json
import os
import time
import wave

import numpy as np
import sherpa_onnx as s

from bench_voice import SENTENCES, write_wav, read_wav


def kokoro(d, model):
    return s.OfflineTtsModelConfig(kokoro=s.OfflineTtsKokoroModelConfig(
        model=os.path.join(d, model), voices=os.path.join(d, "voices.bin"), tokens=os.path.join(d, "tokens.txt"),
        data_dir=os.path.join(d, "espeak-ng-data"), lexicon=os.path.join(d, "lexicon-us-en.txt"), lang="en-us"))


def kitten(d):
    return s.OfflineTtsModelConfig(kitten=s.OfflineTtsKittenModelConfig(
        model=os.path.join(d, "model.onnx"), voices=os.path.join(d, "voices.bin"), tokens=os.path.join(d, "tokens.txt"),
        data_dir=os.path.join(d, "espeak-ng-data")))


def supertonic(d):
    return s.OfflineTtsModelConfig(supertonic=s.OfflineTtsSupertonicModelConfig(
        duration_predictor=os.path.join(d, "duration_predictor.int8.onnx"), text_encoder=os.path.join(d, "text_encoder.int8.onnx"),
        vector_estimator=os.path.join(d, "vector_estimator.int8.onnx"), vocoder=os.path.join(d, "vocoder.int8.onnx"),
        tts_json=os.path.join(d, "tts.json"), unicode_indexer=os.path.join(d, "unicode_indexer.bin"), voice_style=os.path.join(d, "voice.bin")))


def pocket(d):
    return s.OfflineTtsModelConfig(pocket=s.OfflineTtsPocketModelConfig(
        lm_flow=os.path.join(d, "lm_flow.int8.onnx"), lm_main=os.path.join(d, "lm_main.int8.onnx"), encoder=os.path.join(d, "encoder.onnx"),
        decoder=os.path.join(d, "decoder.int8.onnx"), text_conditioner=os.path.join(d, "text_conditioner.onnx"),
        vocab_json=os.path.join(d, "vocab.json"), token_scores_json=os.path.join(d, "token_scores.json")))


def run(name, model_cfg, threads, gen_cfg, out):
    model_cfg.num_threads = threads
    cfg = s.OfflineTtsConfig(model=model_cfg, max_num_sentences=1)
    t0 = time.perf_counter()
    tts = s.OfflineTts(cfg)
    load = (time.perf_counter() - t0) * 1000
    rows = []
    sample = None
    for i, text in enumerate(SENTENCES):
        first = [None]
        t0 = time.perf_counter()

        def cb(samples, progress):
            if first[0] is None:
                first[0] = (time.perf_counter() - t0) * 1000
            return 1

        audio = tts.generate(text, gen_cfg, cb)
        ms = (time.perf_counter() - t0) * 1000
        dur = len(audio.samples) / audio.sample_rate if len(audio.samples) else 0.001
        rows.append({"audio_s": round(dur, 2), "synth_ms": round(ms), "first_audio_ms": round(first[0] or ms), "rtf": round(ms / 1000 / dur, 3)})
        if i == 3:
            sample = audio
    if sample is not None:
        write_wav(os.path.join(out, f"compare-{name}.wav"), sample.samples, sample.sample_rate)
    mean = round(sum(r["rtf"] for r in rows) / len(rows), 3)
    print(f"{name:28s} threads={threads} load {load:6.0f} ms  mean RTF {mean:5.2f}  first audio {rows[1]['first_audio_ms']:5d} ms (short) {rows[-1]['first_audio_ms']:6d} ms (long)")
    return {"load_ms": round(load), "mean_rtf": mean, "sentences": rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="models")
    ap.add_argument("--out", default="models/bench-out")
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()
    m = a.models
    os.makedirs(a.out, exist_ok=True)
    report = {}

    g = s.GenerationConfig()
    g.sid = 3
    g.speed = 1.0
    report["kokoro-v1.0-int8"] = run("kokoro-v1.0-int8", kokoro(os.path.join(m, "tts-kokoro-v1.0-int8"), "model.int8.onnx"), a.threads, g, a.out)
    report["kokoro-v1.0-fp32"] = run("kokoro-v1.0-fp32", kokoro(os.path.join(m, "x-kokoro-multi-lang-v1_0"), "model.onnx"), a.threads, g, a.out)

    g2 = s.GenerationConfig()
    g2.sid = 0
    report["kitten-mini-v0.8"] = run("kitten-mini-v0.8", kitten(os.path.join(m, "x-kitten-mini-en-v0_8")), a.threads, g2, a.out)
    report["supertonic-3-int8"] = run("supertonic-3-int8", supertonic(os.path.join(m, "x-sherpa-onnx-supertonic-3-tts-int8-2026-05-11")), a.threads, g2, a.out)

    pd = os.path.join(m, "x-sherpa-onnx-pocket-tts-int8-2026-01-26")
    ref, rate = read_wav(os.path.join(pd, "test_wavs", "bria.wav"))
    g3 = s.GenerationConfig()
    g3.reference_audio = ref.tolist()
    g3.reference_sample_rate = rate
    try:
        report["pocket-tts-int8"] = run("pocket-tts-int8 (voice clone)", pocket(pd), a.threads, g3, a.out)
    except Exception as e:  # pragma: no cover
        print("pocket-tts failed:", e)

    with open(os.path.join(a.out, "tts-compare.json"), "w") as f:
        json.dump(report, f, indent=1)


if __name__ == "__main__":
    main()
