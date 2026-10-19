package app.oboard.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.store by preferencesDataStore(name = "oboard")

/** Everything the user can configure on the phone. The Gemini key is deliberately not here: it only exists on the Pi. */
data class AppSettings(
    val serverUrl: String = "",
    val serverId: String = "",
    val token: String = "",
    val deviceName: String = android.os.Build.MODEL ?: "Phone",
    val voiceEngine: String = "local",      // "local" (on-device ASR + TTS) or "live" (Gemini Live native audio)
    val ttsEngine: String = "kokoro",       // on-device voice model: "kokoro" (most natural) or "supertonic" (fastest)
    val voiceId: Int = 3,                   // speaker id within the TTS engine; Kokoro 3 = af_heart
    val speed: Float = 1.0f,
    val talkMode: Boolean = false,          // hold-to-talk sends straight to the assistant instead of filling the text box
    val handsFree: Boolean = false,
    val bargeIn: Boolean = true,            // let speaking interrupt the assistant (best with headphones)
    val tvAudio: Boolean = false,           // beta: play replies through the TV
    val lastBoard: String = "",
    val captureBoard: String = "thoughts",
    val liveVoice: String = "Kore",
    val altUrls: List<String> = emptyList(), // every address the paired Pi answers on, preferred first (see Failover)
) {
    val paired get() = serverUrl.isNotBlank() && token.isNotBlank()
}

class Prefs(private val context: Context) {
    private object K {
        val URL = stringPreferencesKey("server_url")
        val SID = stringPreferencesKey("server_id")
        val TOKEN = stringPreferencesKey("token_enc")
        val NAME = stringPreferencesKey("device_name")
        val ENGINE = stringPreferencesKey("voice_engine")
        val TTS = stringPreferencesKey("tts_engine")
        val VOICE = intPreferencesKey("voice_id")
        val SPEED = floatPreferencesKey("speed")
        val TALK = booleanPreferencesKey("talk_mode")
        val HANDS = booleanPreferencesKey("hands_free")
        val BARGE = booleanPreferencesKey("barge_in")
        val TVAUDIO = booleanPreferencesKey("tv_audio")
        val LAST = stringPreferencesKey("last_board")
        val CAPTURE = stringPreferencesKey("capture_board")
        val LIVEVOICE = stringPreferencesKey("live_voice")
        val ALTS = stringPreferencesKey("server_urls")
    }

    val settings: Flow<AppSettings> = context.store.data.map { p -> p.toSettings() }

    private fun Preferences.toSettings(): AppSettings {
        val d = AppSettings()
        return AppSettings(
            serverUrl = this[K.URL] ?: d.serverUrl,
            serverId = this[K.SID] ?: d.serverId,
            token = this[K.TOKEN]?.let { SecureBox.decrypt(it) } ?: "",
            deviceName = this[K.NAME] ?: d.deviceName,
            voiceEngine = this[K.ENGINE] ?: d.voiceEngine,
            ttsEngine = this[K.TTS] ?: d.ttsEngine,
            voiceId = this[K.VOICE] ?: d.voiceId,
            speed = this[K.SPEED] ?: d.speed,
            talkMode = this[K.TALK] ?: d.talkMode,
            handsFree = this[K.HANDS] ?: d.handsFree,
            bargeIn = this[K.BARGE] ?: d.bargeIn,
            tvAudio = this[K.TVAUDIO] ?: d.tvAudio,
            lastBoard = this[K.LAST] ?: d.lastBoard,
            captureBoard = this[K.CAPTURE] ?: d.captureBoard,
            liveVoice = this[K.LIVEVOICE] ?: d.liveVoice,
            altUrls = this[K.ALTS]?.split('\n')?.filter { it.isNotBlank() } ?: d.altUrls,
        )
    }

    suspend fun savePairing(serverUrl: String, serverId: String, token: String) {
        context.store.edit {
            it[K.URL] = serverUrl
            it[K.SID] = serverId
            it[K.TOKEN] = SecureBox.encrypt(token)
            it[K.ALTS] = serverUrl
        }
    }

    suspend fun forgetPairing() {
        context.store.edit {
            it.remove(K.URL); it.remove(K.SID); it.remove(K.TOKEN); it.remove(K.LAST); it.remove(K.ALTS)
        }
    }

    suspend fun update(block: (MutablePrefs) -> Unit) {
        context.store.edit { p -> block(MutablePrefs(p)) }
    }

    class MutablePrefs(private val p: androidx.datastore.preferences.core.MutablePreferences) {
        fun deviceName(v: String) { p[K.NAME] = v }
        fun voiceEngine(v: String) { p[K.ENGINE] = v }
        fun ttsEngine(v: String) { p[K.TTS] = v }
        fun voiceId(v: Int) { p[K.VOICE] = v }
        fun speed(v: Float) { p[K.SPEED] = v }
        fun talkMode(v: Boolean) { p[K.TALK] = v }
        fun handsFree(v: Boolean) { p[K.HANDS] = v }
        fun bargeIn(v: Boolean) { p[K.BARGE] = v }
        fun tvAudio(v: Boolean) { p[K.TVAUDIO] = v }
        fun lastBoard(v: String) { p[K.LAST] = v }
        fun captureBoard(v: String) { p[K.CAPTURE] = v }
        fun liveVoice(v: String) { p[K.LIVEVOICE] = v }
        fun serverUrl(v: String) { p[K.URL] = v }
        fun altUrls(v: List<String>) { p[K.ALTS] = v.joinToString("\n") }
    }
}
