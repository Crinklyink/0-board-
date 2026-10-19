package app.oboard.voice

import android.os.SystemClock
import android.util.Log
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineQwen3AsrModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsSupertonicModelConfig
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.Executors

private fun threads(max: Int) = Runtime.getRuntime().availableProcessors().coerceIn(1, max)

data class AsrResult(val text: String, val audioSec: Float, val decodeMs: Long) {
    val rtf get() = if (audioSec > 0) decodeMs / 1000f / audioSec else 0f
}

/**
 * Qwen3-ASR 0.6B through sherpa-onnx. All native calls run on one dedicated thread: the recognizer is loaded once
 * (several seconds, ~1 GB) and then reused. Silero VAD trims silence so the model never "hears" words in noise.
 */
class LocalAsr(private val store: ModelStore) {
    private val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "asr").apply { priority = Thread.NORM_PRIORITY + 1 } }
    val dispatcher = exec.asCoroutineDispatcher()
    private var recognizer: OfflineRecognizer? = null
    var loadMs = 0L
        private set

    val available get() = store.isReady(ModelCatalog.QWEN3_ASR)
    val loaded get() = recognizer != null

    suspend fun load(): Boolean = withContext(dispatcher) {
        if (recognizer != null) return@withContext true
        if (!available) return@withContext false
        val d = store.dir(ModelCatalog.QWEN3_ASR).absolutePath
        val t0 = SystemClock.elapsedRealtime()
        recognizer = OfflineRecognizer(
            config = OfflineRecognizerConfig(
                modelConfig = OfflineModelConfig(
                    qwen3Asr = OfflineQwen3AsrModelConfig(
                        convFrontend = "$d/conv_frontend.onnx",
                        encoder = "$d/encoder.int8.onnx",
                        decoder = "$d/decoder.int8.onnx",
                        tokenizer = "$d/tokenizer",
                        maxTotalLen = 1024,
                        maxNewTokens = 256,
                    ),
                    tokens = "",
                    numThreads = threads(4),
                ),
            ),
        )
        loadMs = SystemClock.elapsedRealtime() - t0
        Log.i("LocalAsr", "Qwen3-ASR loaded in $loadMs ms")
        true
    }

    /** Blocking decode of 16 kHz mono audio. Call from any coroutine; it hops onto the ASR thread. */
    suspend fun transcribe(samples: FloatArray): AsrResult = withContext(dispatcher) {
        val rec = recognizer ?: return@withContext AsrResult("", 0f, 0)
        if (samples.size < 16000 / 4) return@withContext AsrResult("", samples.size / 16000f, 0)
        val t0 = SystemClock.elapsedRealtime()
        val stream = rec.createStream()
        try {
            stream.acceptWaveform(samples, 16000)
            rec.decode(stream)
            val text = rec.getResult(stream).text.trim()
            AsrResult(cleanTranscript(text), samples.size / 16000f, SystemClock.elapsedRealtime() - t0)
        } finally {
            stream.release()
        }
    }

    fun release() {
        exec.execute { recognizer?.release(); recognizer = null }
    }

    private fun cleanTranscript(t: String): String {
        // Qwen3-ASR sometimes prefixes a language tag like "language English<asr_text>"; keep only the text.
        val i = t.indexOf("<asr_text>")
        val s = if (i >= 0) t.substring(i + "<asr_text>".length) else t
        return s.replace(Regex("<[^>]+>"), "").trim()
    }
}

/** Silero VAD: finds where speech starts and stops, used to trim and to end turns in hands-free mode. */
class SpeechDetector(private val store: ModelStore) {
    private var vad: Vad? = null

    fun ensure(): Boolean {
        if (vad != null) return true
        if (!store.isReady(ModelCatalog.VAD)) return false
        vad = Vad(
            config = VadModelConfig(
                sileroVadModelConfig = SileroVadModelConfig(
                    model = File(store.dir(ModelCatalog.VAD), "silero_vad.onnx").absolutePath,
                    threshold = 0.5f,
                    minSilenceDuration = 0.55f,
                    minSpeechDuration = 0.2f,
                    windowSize = 512,
                    maxSpeechDuration = 30f,
                ),
                sampleRate = 16000,
                numThreads = 1,
            ),
        )
        return true
    }

    /** Keep only the speech in [samples] (plus a little padding). Returns null if nobody spoke. */
    fun trim(samples: FloatArray): FloatArray? {
        val v = vad ?: return samples
        v.reset()
        var i = 0
        while (i + 512 <= samples.size) {
            v.acceptWaveform(samples.copyOfRange(i, i + 512)); i += 512
        }
        v.flush()
        var first = -1
        var last = -1
        while (!v.empty()) {
            val seg = v.front()
            if (first < 0) first = seg.start
            last = seg.start + seg.samples.size
            v.pop()
        }
        v.reset()
        if (first < 0) return null
        val pad = 16000 / 5
        return samples.copyOfRange((first - pad).coerceAtLeast(0), (last + pad).coerceAtMost(samples.size))
    }

    /** Streaming use for hands-free mode: feed 512-sample windows, ask whether speech is happening. */
    fun accept(window: FloatArray) { vad?.acceptWaveform(window) }
    fun speaking(): Boolean = vad?.isSpeechDetected() ?: false
    fun popSegment(): FloatArray? {
        val v = vad ?: return null
        if (v.empty()) return null
        val s = v.front().samples
        v.pop()
        return s
    }
    fun reset() { vad?.reset() }
    fun release() { vad?.release(); vad = null }
}

/**
 * Kokoro 82M via sherpa-onnx, sentence by sentence. Synthesis runs on its own thread and hands audio to the
 * PcmPlayer as soon as each sentence is ready, so the first words play while later ones are still being made.
 */
class LocalTts(private val store: ModelStore) {
    private val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "tts").apply { priority = Thread.MAX_PRIORITY - 1 } }
    private val dispatcher = exec.asCoroutineDispatcher()
    private var tts: OfflineTts? = null
    private var loadedKey = ""
    var loadMs = 0L
        private set
    val sampleRate: Int get() = tts?.sampleRate() ?: 24000
    fun available(engine: TtsEngine) = store.isReady(engine.spec)
    val loaded get() = tts != null
    fun loadedFor(engine: TtsEngine) = loadedKey.startsWith(engine.id + ":")

    /** Load (or switch to) an engine. British Kokoro voices use the British pronunciation lexicon. */
    suspend fun load(engine: TtsEngine, british: Boolean = false): Boolean = withContext(dispatcher) {
        if (!available(engine)) return@withContext false
        val key = "${engine.id}:${if (british && engine == TtsEngine.Kokoro) "gb" else "us"}"
        if (tts != null && key == loadedKey) return@withContext true
        tts?.release()
        tts = null
        val d = store.dir(engine.spec).absolutePath
        val t0 = SystemClock.elapsedRealtime()
        val modelConfig = when (engine) {
            TtsEngine.Kokoro -> OfflineTtsModelConfig(
                kokoro = OfflineTtsKokoroModelConfig(
                    model = listOf("model.onnx", "model.int8.onnx").map { File(d, it) }.first { it.exists() }.absolutePath,
                    voices = "$d/voices.bin",
                    tokens = "$d/tokens.txt",
                    dataDir = "$d/espeak-ng-data",
                    lexicon = "$d/${if (british) "lexicon-gb-en.txt" else "lexicon-us-en.txt"}",
                    lang = if (british) "en-gb" else "en-us",
                ),
                numThreads = threads(4),
            )
            TtsEngine.Supertonic -> OfflineTtsModelConfig(
                supertonic = OfflineTtsSupertonicModelConfig(
                    durationPredictor = "$d/duration_predictor.int8.onnx",
                    textEncoder = "$d/text_encoder.int8.onnx",
                    vectorEstimator = "$d/vector_estimator.int8.onnx",
                    vocoder = "$d/vocoder.int8.onnx",
                    ttsJson = "$d/tts.json",
                    unicodeIndexer = "$d/unicode_indexer.bin",
                    voiceStyle = "$d/voice.bin",
                ),
                numThreads = threads(4),
            )
        }
        tts = OfflineTts(config = OfflineTtsConfig(model = modelConfig, maxNumSentences = 1, silenceScale = 0.2f))
        loadedKey = key
        loadMs = SystemClock.elapsedRealtime() - t0
        Log.i("LocalTts", "${engine.label} loaded in $loadMs ms, rate ${tts?.sampleRate()}")
        true
    }

    /**
     * Synthesize one chunk. [onAudio] receives audio as it is produced; return false from [keepGoing] to abort
     * mid-sentence (used when the user interrupts). Returns (audio seconds, synth ms).
     */
    suspend fun synth(text: String, sid: Int, speed: Float, keepGoing: () -> Boolean, onAudio: (FloatArray) -> Unit): Pair<Float, Long> = withContext(dispatcher) {
        val engine = tts ?: return@withContext 0f to 0L
        val clean = SpeechText.clean(text)
        if (clean.isEmpty() || !keepGoing()) return@withContext 0f to 0L
        val t0 = SystemClock.elapsedRealtime()
        val cb = AudioCallback(keepGoing, onAudio)
        engine.generateWithCallback(clean, sid, speed, cb)
        (cb.total / engine.sampleRate().toFloat()) to (SystemClock.elapsedRealtime() - t0)
    }

    fun release() { exec.execute { tts?.release(); tts = null } }
}

/**
 * The native side calls `invoke(float[]): Integer` on this object by name, so it must be a real class: Kotlin 2
 * compiles plain lambdas via invokedynamic, which only exposes the generic `invoke(Object)` and crashes the JNI lookup.
 * Return 1 to keep generating, 0 to stop (used for instant interruption).
 */
class AudioCallback(private val keepGoing: () -> Boolean, private val onAudio: (FloatArray) -> Unit) : (FloatArray) -> Int {
    var total = 0
        private set

    override fun invoke(samples: FloatArray): Int {
        if (!keepGoing()) return 0
        total += samples.size
        onAudio(samples.copyOf())
        return 1
    }
}
