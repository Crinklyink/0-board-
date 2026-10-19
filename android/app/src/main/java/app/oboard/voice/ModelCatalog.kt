package app.oboard.voice

/** One file to fetch. sha256 is null only where the host publishes no hash (then size is checked instead). */
data class ModelFile(val url: String, val path: String, val size: Long, val sha256: String?)

/** A .tar.bz2 that unpacks into the model directory; `strip` is the archive's top folder. */
data class ModelArchive(val url: String, val size: Long, val sha256: String, val strip: String)

enum class ModelKind { ASR, TTS, VAD }

data class ModelSpec(
    val id: String,
    val kind: ModelKind,
    val title: String,
    val description: String,
    val files: List<ModelFile> = emptyList(),
    val archive: ModelArchive? = null,
    val license: String,
) {
    val downloadBytes: Long get() = archive?.size ?: files.sumOf { it.size }
}

/**
 * Speech models used on the phone. Sizes and SHA-256 hashes come from the publishers' release APIs
 * (GitHub k2-fsa/sherpa-onnx releases and the Hugging Face mirror), so every download is verified.
 */
object ModelCatalog {
    private const val HF_ASR = "https://huggingface.co/csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/main"

    val VAD = ModelSpec(
        id = "vad-silero",
        kind = ModelKind.VAD,
        title = "Silero voice activity detector",
        description = "Notices when you start and stop talking.",
        files = listOf(
            ModelFile(
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
                "silero_vad.onnx", 643_854, "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
            ),
        ),
        license = "MIT",
    )

    val QWEN3_ASR = ModelSpec(
        id = "asr-qwen3-0.6b-int8",
        kind = ModelKind.ASR,
        title = "Qwen3-ASR 0.6B (int8)",
        description = "On-device speech recognition, 30 languages. Runs entirely on the phone.",
        files = listOf(
            ModelFile("$HF_ASR/conv_frontend.onnx", "conv_frontend.onnx", 44_148_281, "d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e"),
            ModelFile("$HF_ASR/encoder.int8.onnx", "encoder.int8.onnx", 182_491_662, "60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9"),
            ModelFile("$HF_ASR/decoder.int8.onnx", "decoder.int8.onnx", 755_914_231, "4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771"),
            ModelFile("$HF_ASR/tokenizer/merges.txt", "tokenizer/merges.txt", 1_671_853, null),
            ModelFile("$HF_ASR/tokenizer/tokenizer_config.json", "tokenizer/tokenizer_config.json", 12_487, "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c"),
            ModelFile("$HF_ASR/tokenizer/vocab.json", "tokenizer/vocab.json", 2_776_833, "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910"),
        ),
        license = "Apache-2.0",
    )

    /**
     * Full-precision Kokoro. Measured with the same runtime the app uses: the int8 build was ~3.4x slower
     * (RTF 1.39 vs 0.41 on 4 threads) because dynamic int8 kernels are poorly optimized, so fp32 is the better trade.
     */
    val KOKORO = ModelSpec(
        id = "tts-kokoro-v1.0",
        kind = ModelKind.TTS,
        title = "Kokoro 82M v1.0",
        description = "The most natural voice here. 28 English voices; starts speaking while the rest is still being made.",
        archive = ModelArchive(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
            349_906_910, "c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298", "kokoro-multi-lang-v1_0",
        ),
        license = "Apache-2.0",
    )

    /** Optional: about 2.4x faster than Kokoro (RTF 0.17), first audio in ~0.6 s; slightly less expressive. */
    val SUPERTONIC = ModelSpec(
        id = "tts-supertonic-3-int8",
        kind = ModelKind.TTS,
        title = "Supertonic 3",
        description = "The fastest voice: answers start almost instantly. 10 voices.",
        archive = ModelArchive(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2",
            128_774_318, "82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427", "sherpa-onnx-supertonic-3-tts-int8-2026-05-11",
        ),
        license = "OpenRAIL-M (model), MIT (code)",
    )

    /** What "Download all" fetches: everything the default voice pipeline needs. */
    val ESSENTIAL = listOf(QWEN3_ASR, KOKORO, VAD)
    val ALL = listOf(QWEN3_ASR, KOKORO, SUPERTONIC, VAD)
}

enum class TtsEngine(val id: String, val label: String) {
    Kokoro("kokoro", "Kokoro"),
    Supertonic("supertonic", "Supertonic");

    val spec get() = if (this == Kokoro) ModelCatalog.KOKORO else ModelCatalog.SUPERTONIC

    companion object {
        fun of(id: String) = entries.find { it.id == id } ?: Kokoro
    }
}

/** English Kokoro v1.0 speakers (sid -> name). Ids 0-27 in kokoro-multi-lang-v1_0. */
data class Voice(val sid: Int, val id: String, val label: String, val accent: String, val gender: String)

object Voices {
    val ALL = listOf(
        Voice(3, "af_heart", "Heart", "American", "Female"),
        Voice(2, "af_bella", "Bella", "American", "Female"),
        Voice(6, "af_nicole", "Nicole", "American", "Female"),
        Voice(9, "af_sarah", "Sarah", "American", "Female"),
        Voice(0, "af_alloy", "Alloy", "American", "Female"),
        Voice(1, "af_aoede", "Aoede", "American", "Female"),
        Voice(5, "af_kore", "Kore", "American", "Female"),
        Voice(7, "af_nova", "Nova", "American", "Female"),
        Voice(8, "af_river", "River", "American", "Female"),
        Voice(10, "af_sky", "Sky", "American", "Female"),
        Voice(4, "af_jessica", "Jessica", "American", "Female"),
        Voice(16, "am_michael", "Michael", "American", "Male"),
        Voice(13, "am_eric", "Eric", "American", "Male"),
        Voice(15, "am_liam", "Liam", "American", "Male"),
        Voice(11, "am_adam", "Adam", "American", "Male"),
        Voice(12, "am_echo", "Echo", "American", "Male"),
        Voice(14, "am_fenrir", "Fenrir", "American", "Male"),
        Voice(17, "am_onyx", "Onyx", "American", "Male"),
        Voice(18, "am_puck", "Puck", "American", "Male"),
        Voice(21, "bf_emma", "Emma", "British", "Female"),
        Voice(20, "bf_alice", "Alice", "British", "Female"),
        Voice(22, "bf_isabella", "Isabella", "British", "Female"),
        Voice(23, "bf_lily", "Lily", "British", "Female"),
        Voice(26, "bm_george", "George", "British", "Male"),
        Voice(24, "bm_daniel", "Daniel", "British", "Male"),
        Voice(25, "bm_fable", "Fable", "British", "Male"),
        Voice(27, "bm_lewis", "Lewis", "British", "Male"),
    )

    fun bySid(sid: Int) = ALL.find { it.sid == sid } ?: ALL.first()

    /** Supertonic 3 ships 10 preset styles; the runtime exposes them by index only, so they are previewed by ear. */
    val SUPERTONIC = (0 until 10).map { Voice(it, "st_$it", "Voice ${it + 1}", "Neutral", if (it < 5) "Style A" else "Style B") }

    fun forEngine(engine: TtsEngine) = if (engine == TtsEngine.Kokoro) ALL else SUPERTONIC

    /** Gemini Live prebuilt voices (cloud). */
    val LIVE = listOf("Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr")
}
