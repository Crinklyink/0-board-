package app.oboard.voice

import android.os.SystemClock
import android.util.Base64
import android.util.Log
import app.oboard.data.Api
import app.oboard.data.AppSettings
import app.oboard.data.Events
import app.oboard.data.ServerEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min

sealed interface VoiceState {
    data object Idle : VoiceState
    data class Preparing(val what: String) : VoiceState
    data class Listening(val partial: String, val handsFree: Boolean) : VoiceState
    data object Transcribing : VoiceState
    data object Thinking : VoiceState
    data class Speaking(val text: String) : VoiceState
    data class Problem(val message: String) : VoiceState
}

data class VoiceMetrics(
    val asrLoadMs: Long = 0,
    val ttsLoadMs: Long = 0,
    val lastAsrMs: Long = 0,
    val lastAsrRtf: Float = 0f,
    val lastTtsRtf: Float = 0f,
    val replyToVoiceMs: Long = 0,   // AI's first words arrive -> first audio out of the speaker
    val releaseToVoiceMs: Long = 0, // you let go of the mic -> you hear the answer start
)

/**
 * The on-device voice pipeline:
 *   hold mic -> Qwen3-ASR (with live partial text) -> text to Gemini on the Pi -> streamed reply -> Kokoro speech.
 * Interrupting (pressing the mic, or speaking in hands-free mode) cancels the AI turn and silences audio at once.
 */
class VoiceController(
    private val scope: CoroutineScope,
    private val store: ModelStore,
    private val asr: LocalAsr,
    private val vad: SpeechDetector,
    private val tts: LocalTts,
    private val mic: Mic,
    private val route: AudioRoute,
    private val api: Api,
    private val events: Events,
    private val settings: StateFlow<AppSettings>,
) {
    private val _state = MutableStateFlow<VoiceState>(VoiceState.Idle)
    val state: StateFlow<VoiceState> = _state.asStateFlow()
    private val _metrics = MutableStateFlow(VoiceMetrics())
    val metrics: StateFlow<VoiceMetrics> = _metrics.asStateFlow()
    val level get() = mic.level

    private var player: PcmPlayer? = null
    private val speechGen = AtomicLong(0)
    private var speechChannel = Channel<String>(Channel.UNLIMITED)
    private var speakJob: Job? = null
    private var spokenText = StringBuilder()

    // Listening
    private val audio = ArrayList<FloatArray>()
    private var audioSamples = 0
    private var partialJob: Job? = null
    private var releasedAt = 0L

    // Turn tracking: replies are spoken only for turns this phone started (by voice).
    @Volatile var activeTurn: String? = null
        private set
    private var activeBoard: String? = null
    private val early = LinkedHashMap<String, MutableList<ServerEvent.Ai>>()
    private val splitter = SentenceSplitter()
    private var firstDeltaAt = 0L
    private var turnDone = false

    // Hands-free
    private var handsFreeJob: Job? = null
    @Volatile var handsFree = false
        private set
    var onUtterance: ((String) -> Unit)? = null

    val ready get() = asr.available && tts.available(engine()) && store.isReady(ModelCatalog.VAD)

    /** True while audio is actually coming out of the speaker. */
    val isPlaying get() = player?.playing?.value == true

    private fun engine() = TtsEngine.of(settings.value.ttsEngine)
    private fun british(sid: Int) = engine() == TtsEngine.Kokoro && Voices.bySid(sid).accent == "British"
    private suspend fun loadTts(sid: Int = settings.value.voiceId) = tts.load(engine(), british(sid))

    init {
        scope.launch { events.events.collect { if (it is ServerEvent.Ai) onAi(it) } }
    }

    // ------------------------------------------------------------------------------- loading

    /** Load models into memory ahead of time so the first press is fast. Safe to call repeatedly. */
    fun warmUp() {
        scope.launch(Dispatchers.Default) {
            if (!ready) return@launch
            loadTts()
            vad.ensure()
            if (!asr.loaded) asr.load()
            _metrics.value = _metrics.value.copy(asrLoadMs = asr.loadMs, ttsLoadMs = tts.loadMs)
        }
    }

    private fun ensurePlayer(): PcmPlayer {
        val rate = tts.sampleRate
        val p = player
        if (p != null && p.sampleRate == rate) return p
        p?.release()
        return PcmPlayer(rate, voiceComm = handsFree).also { np ->
            np.onDrained = { if (speechDone()) onSpeechFinished() }
            player = np
        }
    }

    // ------------------------------------------------------------------- push-to-talk

    /** Mic pressed. Interrupts anything the assistant is saying or thinking. Returns false if the mic could not open. */
    fun startListening(): Boolean {
        if (!ready) { _state.value = VoiceState.Problem("Download the voice models in Settings first"); return false }
        interrupt()
        audio.clear(); audioSamples = 0
        val ok = mic.start(comm = false) { frame -> synchronized(audio) { audio += Mic.toFloat(frame); audioSamples += frame.size } }
        if (!ok) { _state.value = VoiceState.Problem("Microphone unavailable"); return false }
        _state.value = VoiceState.Listening("", handsFree = false)
        if (!asr.loaded) warmUp()
        partialJob = scope.launch(Dispatchers.Default) {
            // Near-live transcript: re-decode what we have about once a second while you talk.
            var lastLen = 0
            while (isActive && mic.isRunning) {
                delay(900)
                val n = synchronized(audio) { audioSamples }
                if (n < 16000 || n - lastLen < 8000 || !asr.loaded) continue
                lastLen = n
                val window = snapshot(maxSeconds = 25)
                val r = asr.transcribe(window)
                if (mic.isRunning && r.text.isNotBlank()) _state.value = VoiceState.Listening(r.text, false)
            }
        }
        return true
    }

    private fun snapshot(maxSeconds: Int = 120): FloatArray = synchronized(audio) {
        val total = audioSamples
        val keep = min(total, maxSeconds * 16000)
        val out = FloatArray(keep)
        var pos = keep
        for (i in audio.indices.reversed()) {
            val c = audio[i]
            val take = min(c.size, pos)
            System.arraycopy(c, c.size - take, out, pos - take, take)
            pos -= take
            if (pos == 0) break
        }
        out
    }

    /** Mic released: final transcription of the whole utterance. Empty string if nothing was said. */
    suspend fun stopListening(): String {
        partialJob?.cancel()
        mic.stop()
        releasedAt = SystemClock.elapsedRealtime()
        _state.value = VoiceState.Transcribing
        if (!asr.loaded && !asr.load()) { _state.value = VoiceState.Problem("Speech model not ready"); return "" }
        vad.ensure()
        val all = snapshot()
        val speech = vad.trim(all)
        if (speech == null) { _state.value = VoiceState.Idle; return "" }
        val r = asr.transcribe(speech)
        _metrics.value = _metrics.value.copy(lastAsrMs = r.decodeMs, lastAsrRtf = r.rtf)
        Log.i("Voice", "ASR ${"%.1f".format(r.audioSec)}s audio in ${r.decodeMs}ms (RTF ${"%.2f".format(r.rtf)})")
        _state.value = VoiceState.Idle
        return r.text
    }

    fun cancelListening() {
        partialJob?.cancel()
        mic.stop()
        _state.value = VoiceState.Idle
    }

    // -------------------------------------------------------------------- AI replies

    /** The phone just asked the assistant something by voice: speak the reply for this turn. */
    fun expectTurn(turnId: String, boardId: String) {
        activeTurn = turnId
        activeBoard = boardId
        splitter.reset()
        spokenText = StringBuilder()
        firstDeltaAt = 0
        turnDone = false
        _state.value = VoiceState.Thinking
        early.remove(turnId)?.forEach { onAi(it) }
        early.clear()
    }

    private fun onAi(e: ServerEvent.Ai) {
        val turn = e.turnId ?: return
        if (activeTurn == null || turn != activeTurn) {
            // Events can beat the HTTP response that tells us our turn id; keep a few around briefly.
            if (early.size > 8) early.remove(early.keys.first())
            early.getOrPut(turn) { mutableListOf() } += e
            return
        }
        when (e.ev) {
            "delta" -> {
                if (firstDeltaAt == 0L) firstDeltaAt = SystemClock.elapsedRealtime()
                spokenText.append(e.text ?: "")
                splitter.feed(e.text ?: "").forEach { say(it) }
            }
            "done" -> {
                splitter.flush().forEach { say(it) }
                turnDone = true
                if (spokenText.isEmpty() && (e.text ?: "").isNotBlank()) say(e.text!!)
                if (speechDone() && player?.playing?.value != true) onSpeechFinished()
            }
            "error" -> { turnDone = true; _state.value = VoiceState.Problem(e.message ?: "Something went wrong") }
            "cancelled" -> { turnDone = true; if (_state.value is VoiceState.Thinking) _state.value = VoiceState.Idle }
        }
    }

    // ----------------------------------------------------------------------- speaking

    private var pendingSentences = 0

    /** Queue text to speak in the current speech generation. */
    fun say(text: String) {
        if (text.isBlank()) return
        pendingSentences++
        speechChannel.trySend(text)
        ensureSpeaker()
    }

    private fun speechDone() = pendingSentences <= 0 && turnDone

    private fun ensureSpeaker() {
        if (speakJob?.isActive == true) return
        val gen = speechGen.get()
        val ch = speechChannel
        speakJob = scope.launch(Dispatchers.Default) {
            if (!loadTts()) {
                _state.value = VoiceState.Problem("Voice model not ready"); return@launch
            }
            val p = ensurePlayer()
            var first = true
            for (sentence in ch) {
                if (gen != speechGen.get()) break
                val s = settings.value
                _state.value = VoiceState.Speaking(spokenText.toString().ifBlank { sentence })
                val (audioSec, ms) = tts.synth(sentence, s.voiceId, s.speed, keepGoing = { gen == speechGen.get() }) { pcm ->
                    if (gen != speechGen.get()) return@synth
                    if (first) {
                        first = false
                        val now = SystemClock.elapsedRealtime()
                        _metrics.value = _metrics.value.copy(
                            replyToVoiceMs = if (firstDeltaAt > 0) now - firstDeltaAt else _metrics.value.replyToVoiceMs,
                            releaseToVoiceMs = if (releasedAt > 0) now - releasedAt else _metrics.value.releaseToVoiceMs,
                        )
                        releasedAt = 0
                    }
                    if (s.tvAudio && events.tvOnline) sendToTv(pcm, tts.sampleRate) else p.enqueue(pcm, p.generation)
                }
                if (audioSec > 0) _metrics.value = _metrics.value.copy(lastTtsRtf = ms / 1000f / audioSec)
                pendingSentences--
                if (speechDone() && p.playing.value.not() && !(s.tvAudio && events.tvOnline)) onSpeechFinished()
            }
        }
    }

    private fun onSpeechFinished() {
        if (_state.value is VoiceState.Speaking || _state.value is VoiceState.Thinking) {
            _state.value = if (handsFree) VoiceState.Listening("", true) else VoiceState.Idle
        }
    }

    /** Stop talking now, drop everything queued, and cancel the AI turn this phone started. */
    fun interrupt() {
        val turn = activeTurn
        val board = activeBoard
        activeTurn = null
        stopSpeaking()
        if (turn != null && !turnDone) scope.launch { runCatching { api.aiCancel(turnId = turn, boardId = board) } }
    }

    fun stopSpeaking() {
        speechGen.incrementAndGet()
        speechChannel.close()
        speechChannel = Channel(Channel.UNLIMITED)
        speakJob?.cancel()
        speakJob = null
        pendingSentences = 0
        player?.stop()
        if (settings.value.tvAudio) events.sendTts(buildJsonObject { put("stop", true) })
        if (_state.value is VoiceState.Speaking || _state.value is VoiceState.Thinking) _state.value = if (handsFree) VoiceState.Listening("", true) else VoiceState.Idle
    }

    private fun sendToTv(pcm: FloatArray, rate: Int) {
        val bb = ByteBuffer.allocate(pcm.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (f in pcm) bb.putShort((f.coerceIn(-1f, 1f) * 32767).toInt().toShort())
        events.sendTts(buildJsonObject { put("rate", rate); put("data", Base64.encodeToString(bb.array(), Base64.NO_WRAP)) })
    }

    /** Preview a voice in Settings. */
    fun preview(sid: Int, speed: Float, text: String = "Hi. This is how I'll sound when we talk through your ideas.") {
        interrupt()
        scope.launch(Dispatchers.Default) {
            if (!loadTts(sid)) { _state.value = VoiceState.Problem("Download the voice model first"); return@launch }
            turnDone = true
            spokenText = StringBuilder(text)
            val gen = speechGen.get()
            val p = ensurePlayer()
            _state.value = VoiceState.Speaking(text)
            tts.synth(text, sid, speed, keepGoing = { gen == speechGen.get() }) { pcm -> p.enqueue(pcm, p.generation) }
        }
    }

    // --------------------------------------------------------------------- hands-free

    /**
     * Open-mic conversation: speech is detected automatically, each finished sentence is transcribed and sent.
     * While the assistant talks, speaking over it interrupts (if enabled). Always visible; stops when the app is hidden.
     */
    fun startHandsFree(): Boolean {
        if (!ready) { _state.value = VoiceState.Problem("Download the voice models in Settings first"); return false }
        if (handsFree) return true
        handsFree = true
        route.enterConversation()
        player?.release(); player = null
        vad.ensure(); vad.reset()
        val window = FloatArray(512)
        var fill = 0
        var speechFrames = 0
        val ok = mic.start(comm = true) { frame ->
            val f = Mic.toFloat(frame)
            var i = 0
            while (i < f.size) {
                val take = min(512 - fill, f.size - i)
                System.arraycopy(f, i, window, fill, take)
                fill += take; i += take
                if (fill == 512) {
                    vad.accept(window.copyOf()); fill = 0
                    val speaking = vad.speaking()
                    speechFrames = if (speaking) speechFrames + 1 else 0
                    val st = _state.value
                    if (speechFrames == 4 && (st is VoiceState.Speaking || st is VoiceState.Thinking) && settings.value.bargeIn) {
                        interrupt()
                        _state.value = VoiceState.Listening("", true)
                    }
                }
            }
            vad.popSegment()?.let { seg -> handleUtterance(seg) }
        }
        if (!ok) { stopHandsFree(); _state.value = VoiceState.Problem("Microphone unavailable"); return false }
        _state.value = VoiceState.Listening("", true)
        if (!asr.loaded) warmUp()
        return true
    }

    private fun handleUtterance(seg: FloatArray) {
        if (seg.size < 16000 / 3) return
        handsFreeJob = scope.launch(Dispatchers.Default) {
            _state.value = VoiceState.Transcribing
            releasedAt = SystemClock.elapsedRealtime()
            val r = asr.transcribe(seg)
            _metrics.value = _metrics.value.copy(lastAsrMs = r.decodeMs, lastAsrRtf = r.rtf)
            if (r.text.isBlank()) { _state.value = VoiceState.Listening("", true); return@launch }
            onUtterance?.invoke(r.text)
        }
    }

    fun stopHandsFree() {
        handsFree = false
        handsFreeJob?.cancel()
        mic.stop()
        vad.reset()
        route.exitConversation()
        player?.release(); player = null
        if (_state.value is VoiceState.Listening) _state.value = VoiceState.Idle
    }

    fun clearProblem() { if (_state.value is VoiceState.Problem) _state.value = VoiceState.Idle }

    // ---------------------------------------------------------------------- self test

    /**
     * End-to-end check that needs no human: Kokoro speaks a sentence into memory, it is resampled to 16 kHz and fed
     * to Qwen3-ASR, and the transcript is compared with the original. Reports load times, speeds and word accuracy.
     */
    suspend fun selfTest(sentence: String = "Put a note on the board about using a camera to identify objects on my desk."): String {
        if (!ready) return "Models not downloaded."
        val t0 = SystemClock.elapsedRealtime()
        loadTts()
        val ttsLoad = SystemClock.elapsedRealtime() - t0
        val t1 = SystemClock.elapsedRealtime()
        asr.load()
        val asrLoad = SystemClock.elapsedRealtime() - t1
        val chunks = ArrayList<FloatArray>()
        var firstAt = 0L
        val ts = SystemClock.elapsedRealtime()
        val (audioSec, synthMs) = tts.synth(sentence, settings.value.voiceId, 1f, keepGoing = { true }) { pcm ->
            if (firstAt == 0L) firstAt = SystemClock.elapsedRealtime() - ts
            chunks += pcm
        }
        val pcm24 = chunks.fold(FloatArray(0)) { acc, c -> acc + c }
        val pcm16 = resample(pcm24, tts.sampleRate, 16000)
        val r = asr.transcribe(pcm16)
        val wer = wordErrorRate(sentence, r.text)
        val report = buildString {
            appendLine("Voice self-test")
            appendLine("TTS load ${ttsLoad} ms, ASR load ${asrLoad} ms")
            appendLine("Speech: ${"%.2f".format(audioSec)} s of audio in $synthMs ms (RTF ${"%.2f".format(synthMs / 1000f / audioSec)}), first audio after $firstAt ms")
            appendLine("Recognition: ${r.decodeMs} ms (RTF ${"%.2f".format(r.rtf)})")
            appendLine("Heard: \"${r.text}\"")
            appendLine("Word error rate: ${"%.0f".format(wer * 100)}%")
        }
        Log.i("VoiceSelfTest", report)
        _metrics.value = _metrics.value.copy(asrLoadMs = asrLoad, ttsLoadMs = ttsLoad, lastAsrMs = r.decodeMs, lastAsrRtf = r.rtf, lastTtsRtf = synthMs / 1000f / audioSec)
        return report
    }

    /**
     * Test hook: speak [sentence] with the TTS into memory and run it through exactly the same path as a real
     * push-to-talk recording (VAD trim + Qwen3-ASR). Lets the whole voice loop be verified without a human.
     */
    suspend fun simulateSpokenInput(sentence: String): String {
        if (!ready || !loadTts()) return ""
        interrupt()
        val chunks = ArrayList<FloatArray>()
        tts.synth(sentence, settings.value.voiceId, 1f, keepGoing = { true }) { chunks += it }
        val pcm = resample(chunks.fold(FloatArray(0)) { acc, c -> acc + c }, tts.sampleRate, 16000)
        // a little silence either side, like a real press-and-release
        val padded = FloatArray(pcm.size + 16000) { i -> if (i in 8000 until 8000 + pcm.size) pcm[i - 8000] else 0f }
        synchronized(audio) { audio.clear(); audio += padded; audioSamples = padded.size }
        _state.value = VoiceState.Listening("", handsFree = false)
        return stopListening()
    }

    fun release() {
        stopHandsFree()
        stopSpeaking()
        player?.release()
        asr.release(); tts.release(); vad.release()
    }

    companion object {
        fun resample(input: FloatArray, from: Int, to: Int): FloatArray {
            if (from == to) return input
            val n = (input.size.toLong() * to / from).toInt()
            val out = FloatArray(n)
            val ratio = from.toDouble() / to
            for (i in 0 until n) {
                val src = i * ratio
                val j = src.toInt()
                val frac = (src - j).toFloat()
                val a = input[j.coerceAtMost(input.size - 1)]
                val b = input[(j + 1).coerceAtMost(input.size - 1)]
                out[i] = a + (b - a) * frac
            }
            return out
        }

        fun wordErrorRate(ref: String, hyp: String): Float {
            val norm = { s: String -> s.lowercase().replace(Regex("[^a-z0-9' ]"), " ").split(Regex("\\s+")).filter { it.isNotBlank() } }
            val r = norm(ref); val h = norm(hyp)
            if (r.isEmpty()) return if (h.isEmpty()) 0f else 1f
            val d = Array(r.size + 1) { IntArray(h.size + 1) }
            for (i in 0..r.size) d[i][0] = i
            for (j in 0..h.size) d[0][j] = j
            for (i in 1..r.size) for (j in 1..h.size) {
                d[i][j] = minOf(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + if (r[i - 1] == h[j - 1]) 0 else 1)
            }
            return d[r.size][h.size].toFloat() / r.size
        }
    }
}
