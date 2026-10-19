package app.oboard

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import app.oboard.data.Api
import app.oboard.data.AppSettings
import app.oboard.data.CaptureQueue
import app.oboard.data.Discovery
import app.oboard.data.Events
import app.oboard.data.Failover
import app.oboard.data.Link
import app.oboard.data.Prefs
import app.oboard.voice.AudioRoute
import app.oboard.voice.LiveSession
import app.oboard.voice.LocalAsr
import app.oboard.voice.LocalTts
import app.oboard.voice.Mic
import app.oboard.voice.ModelStore
import app.oboard.voice.SpeechDetector
import app.oboard.voice.VoiceController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class OBoardApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}

/** Long-lived services shared by every screen. Created once per process. */
class AppContainer(val app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    val prefs = Prefs(app)
    val settings: StateFlow<AppSettings> = prefs.settings.stateIn(scope, SharingStarted.Eagerly, AppSettings())
    val settingsLoaded = MutableStateFlow(false)
    val api = Api(http)
    val events = Events(http, scope)
    val queue = CaptureQueue(app, api, scope)
    val discovery = Discovery(app)
    val models = ModelStore(app, http, scope)
    val mic = Mic(app)
    val route = AudioRoute(app)
    val asr = LocalAsr(models)
    val vad = SpeechDetector(models)
    val tts = LocalTts(models)
    val voice = VoiceController(scope, models, asr, vad, tts, mic, route, api, events, settings)
    val live = LiveSession(http, api, events, scope, mic, route)
    val failover = Failover(api, prefs, settings, events, scope)

    /** Debug builds only: commands sent with `adb shell am broadcast` (see src/debug). */
    val debugCommands = kotlinx.coroutines.flow.MutableSharedFlow<String>(extraBufferCapacity = 4)

    init {
        scope.launch {
            prefs.settings.collect { s ->
                api.baseUrl = s.serverUrl
                api.token = s.token
                settingsLoaded.value = true
                if (s.paired) {
                    events.start(s.serverUrl, s.token, s.deviceName)
                    queue.flush()
                } else {
                    events.stop()
                }
            }
        }
        scope.launch {
            events.link.collect { if (it == Link.Online) queue.flush() }
        }
        failover.start()
        val cm = app.getSystemService(ConnectivityManager::class.java)
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                events.nudge()
                queue.flush()
                failover.onNetworkChanged()
            }
        })
    }
}
