#!/usr/bin/env python3
"""
Measures Qwen3-TTS-12Hz-0.6B-CustomVoice on a CPU, with the same sentences as bench_voice.py.

  python -m venv qtts && qtts/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu && qtts/bin/pip install qwen-tts soundfile
  qtts/bin/python tools/bench_qwen3_tts.py --out models/bench-out --threads 4

Why a CPU: the phone has no CUDA GPU, and there is no Android runtime for this model (sherpa-onnx and ONNX Runtime
Mobile do not support it), so the phone would also run it on CPU cores. If it cannot keep up with real time on a
16-core desktop CPU, it cannot on a phone. RTF = synthesis seconds / audio seconds (below 1 is faster than real time).
The reference package (qwen-tts) generates a whole utterance before returning, so first audio = total synthesis time.
"""
import argparse
import json
import os
import platform
import time

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

# Same sentences as bench_voice.py (not imported: that module needs sherpa-onnx).
SENTENCES = [
    "Sure.",
    "I put three notes next to the robotic arm diagram.",
    "Want me to connect the camera to the object detector, or keep it separate for now?",
    "The gripper could use soft silicone pads, which handle pens and paper clips without scratching the desk.",
    "Here's a thought: if the arm only sorts things into four zones, you can skip the vision model at first and add it later, once the basic motion is reliable.",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="models/bench-out")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--speaker", default="Ryan")
    ap.add_argument("--model", default="Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    torch.set_num_threads(args.threads)

    t0 = time.perf_counter()
    model = Qwen3TTSModel.from_pretrained(args.model, device_map="cpu", dtype=torch.float32)
    load_ms = round((time.perf_counter() - t0) * 1000)
    print(f"loaded in {load_ms} ms ({args.threads} threads)")

    # Warm-up (first call pays one-time costs), not counted.
    model.generate_custom_voice(text="Hello.", language="English", speaker=args.speaker)

    rows = []
    for i, text in enumerate(SENTENCES):
        t0 = time.perf_counter()
        wavs, sr = model.generate_custom_voice(text=text, language="English", speaker=args.speaker)
        synth = time.perf_counter() - t0
        audio = np.asarray(wavs[0], dtype=np.float32)
        dur = len(audio) / sr
        sf.write(os.path.join(args.out, f"qwen3-tts-0.6b-{i}.wav"), audio, sr)
        row = {"chars": len(text), "audio_s": round(dur, 2), "synth_ms": round(synth * 1000), "first_audio_ms": round(synth * 1000), "rtf": round(synth / dur, 3) if dur else None}
        rows.append(row)
        print(row)

    report = {
        "model": args.model,
        "machine": f"{platform.processor()} ({os.cpu_count()} logical cores)",
        "torch": torch.__version__,
        "threads": args.threads,
        "dtype": "float32",
        "load_ms": load_ms,
        "mean_rtf": round(sum(r["rtf"] for r in rows) / len(rows), 3),
        "sentences": rows,
    }
    with open(os.path.join(args.out, f"qwen3-tts-t{args.threads}.json"), "w") as f:
        json.dump(report, f, indent=1)
    print(json.dumps({k: v for k, v in report.items() if k != "sentences"}, indent=1))


if __name__ == "__main__":
    main()
