package app.oboard.voice

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Process
import android.os.Build
import android.os.SystemClock
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Streams PCM to an AudioTrack on its own thread. Audio is grouped into "generations": stop() bumps the generation,
 * which drops everything queued and silences the track within one write (~20 ms). That is what makes interruptions
 * feel instant and guarantees an old answer can never resume after you cut it off.
 */
class PcmPlayer(val sampleRate: Int, private val voiceComm: Boolean = false) {
    private class Chunk(val gen: Long, val pcm: FloatArray)

    private val queue = LinkedBlockingQueue<Chunk>()
    private val gen = AtomicLong(1)
    private val _playing = MutableStateFlow(false)
    val playing: StateFlow<Boolean> = _playing.asStateFlow()
    @Volatile private var endsAt = 0L
    @Volatile private var running = true
    @Volatile var onFirstAudio: ((Long) -> Unit)? = null
    @Volatile var onDrained: ((Long) -> Unit)? = null
    private var firstFor = 0L

    private val track: AudioTrack = AudioTrack.Builder()
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(if (voiceComm) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(sampleRate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
        .setTransferMode(AudioTrack.MODE_STREAM)
        .setBufferSizeInBytes(max(AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT) * 2, sampleRate * 4 / 4))
        .build()

    private val thread = Thread({ loop() }, "pcm-player").apply {
        priority = Thread.MAX_PRIORITY
        isDaemon = true
        start()
    }

    val generation: Long get() = gen.get()

    fun enqueue(pcm: FloatArray, generation: Long = gen.get()) {
        if (generation != gen.get() || pcm.isEmpty()) return
        queue.offer(Chunk(generation, pcm))
    }

    /** Drop everything queued and silence immediately. Returns the new generation id. */
    fun stop(): Long {
        val g = gen.incrementAndGet()
        queue.clear()
        runCatching { track.pause(); track.flush() }
        endsAt = 0
        _playing.value = false
        return g
    }

    private fun loop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        while (running) {
            val c = queue.poll(30, TimeUnit.MILLISECONDS)
            if (c == null) {
                if (_playing.value && SystemClock.elapsedRealtime() > endsAt + 60) {
                    _playing.value = false
                    runCatching { track.pause() }
                    onDrained?.invoke(gen.get())
                }
                continue
            }
            if (c.gen != gen.get()) continue
            if (!_playing.value) {
                _playing.value = true
                runCatching { track.play() }
                if (firstFor != c.gen) { firstFor = c.gen; onFirstAudio?.invoke(c.gen) }
            }
            var off = 0
            while (off < c.pcm.size && c.gen == gen.get() && running) {
                val n = track.write(c.pcm, off, c.pcm.size - off, AudioTrack.WRITE_NON_BLOCKING)
                if (n < 0) { Log.w("PcmPlayer", "write error $n"); break }
                if (n == 0) { Thread.sleep(8); continue }
                off += n
            }
            val ms = c.pcm.size * 1000L / sampleRate
            endsAt = max(endsAt, SystemClock.elapsedRealtime()) + ms
        }
    }

    fun release() {
        running = false
        stop()
        runCatching { track.release() }
    }
}

/** 16 kHz mono microphone capture in 20 ms frames on a dedicated thread. */
class Mic(private val ctx: Context) {
    private val _level = MutableStateFlow(0f)
    val level: StateFlow<Float> = _level.asStateFlow()
    @Volatile private var running = false
    private var thread: Thread? = null
    private var record: AudioRecord? = null
    private val effects = mutableListOf<android.media.audiofx.AudioEffect>()
    val isRunning get() = running

    /** [comm] = voice-communication source with echo cancellation, for hands-free and Live conversations. */
    @SuppressLint("MissingPermission")
    fun start(comm: Boolean, onFrame: (ShortArray) -> Unit): Boolean {
        stop()
        val rate = 16000
        val min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = try {
            AudioRecord(if (comm) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.VOICE_RECOGNITION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(min, rate / 5 * 2))
        } catch (e: SecurityException) {
            return false
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return false }
        if (comm) {
            if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(rec.audioSessionId)?.let { it.enabled = true; effects += it }
            if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(rec.audioSessionId)?.let { it.enabled = true; effects += it }
        }
        record = rec
        running = true
        rec.startRecording()
        thread = Thread({
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
            val buf = ShortArray(320)
            while (running) {
                val n = rec.read(buf, 0, buf.size)
                if (n <= 0) continue
                val frame = if (n == buf.size) buf.copyOf() else buf.copyOf(n)
                var sum = 0.0
                for (s in frame) sum += (s * s).toDouble()
                _level.value = (sqrt(sum / frame.size) / 6000.0).coerceIn(0.0, 1.0).toFloat()
                onFrame(frame)
            }
        }, "mic").apply { start() }
        return true
    }

    /** Stop and release the microphone right away (the system mic indicator turns off). */
    fun stop() {
        running = false
        thread?.join(300)
        thread = null
        record?.let { runCatching { it.stop() }; it.release() }
        record = null
        effects.forEach { runCatching { it.release() } }
        effects.clear()
        _level.value = 0f
    }

    companion object {
        fun toFloat(s: ShortArray): FloatArray = FloatArray(s.size) { s[it] / 32768f }
    }
}

/**
 * Communication mode routes audio so the platform echo canceller has a reference signal. Used for hands-free and
 * Gemini Live, where the microphone stays open while the assistant talks.
 */
class AudioRoute(ctx: Context) {
    private val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var active = false

    fun headsetConnected(): Boolean = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
        it.type in setOf(AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_USB_HEADSET)
            || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && it.type == AudioDeviceInfo.TYPE_BLE_HEADSET)
    }

    @Suppress("DEPRECATION")
    fun enterConversation() {
        if (active) return
        active = true
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        if (!headsetConnected()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                am.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }?.let { am.setCommunicationDevice(it) }
            } else am.isSpeakerphoneOn = true
        }
    }

    @Suppress("DEPRECATION")
    fun exitConversation() {
        if (!active) return
        active = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) runCatching { am.clearCommunicationDevice() }
        else am.isSpeakerphoneOn = false
        am.mode = AudioManager.MODE_NORMAL
    }
}
