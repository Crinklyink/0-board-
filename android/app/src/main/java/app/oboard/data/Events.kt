package app.oboard.data

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.math.pow

data class ClientInfo(val id: String, val role: String, val name: String)

/** One long-lived WebSocket to the Pi: connection state, TV presence, AI events and the shared display state. */
class Events(httpClient: OkHttpClient, private val scope: CoroutineScope) {
    private val http = httpClient.newBuilder().pingInterval(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()

    private val _link = MutableStateFlow(Link.Offline)
    val link: StateFlow<Link> = _link.asStateFlow()
    private val _display = MutableStateFlow<DisplayState?>(null)
    val display: StateFlow<DisplayState?> = _display.asStateFlow()
    private val _clients = MutableStateFlow<List<ClientInfo>>(emptyList())
    val clients: StateFlow<List<ClientInfo>> = _clients.asStateFlow()
    private val _boards = MutableStateFlow<List<BoardInfo>>(emptyList())
    val boards: StateFlow<List<BoardInfo>> = _boards.asStateFlow()
    private val _events = MutableSharedFlow<ServerEvent>(extraBufferCapacity = 128)
    val events: SharedFlow<ServerEvent> = _events.asSharedFlow()
    private val _boardsChanged = MutableSharedFlow<Unit>(extraBufferCapacity = 4)
    val boardsChanged: SharedFlow<Unit> = _boardsChanged.asSharedFlow()

    val tvOnline: Boolean get() = _clients.value.any { it.role == "display" }

    private var socket: WebSocket? = null
    private var job: Job? = null
    private var attempt = 0
    private var cfg: Triple<String, String, String>? = null

    fun start(baseUrl: String, token: String, name: String) {
        val next = Triple(baseUrl, token, name)
        if (cfg == next && job?.isActive == true) return
        stop()
        cfg = next
        job = scope.launch { loop(next) }
    }

    fun stop() {
        job?.cancel()
        job = null
        socket?.cancel()
        socket = null
        cfg = null
        _link.value = Link.Offline
        _clients.value = emptyList()
    }

    /** Called when the OS reports the network is back, so we do not wait out a backoff delay. */
    fun nudge() {
        if (_link.value != Link.Online && cfg != null) {
            attempt = 0
            val c = cfg ?: return
            job?.cancel()
            job = scope.launch { loop(c) }
        }
    }

    private suspend fun loop(c: Triple<String, String, String>) {
        while (true) {
            _link.value = if (_link.value == Link.Online) Link.Offline else Link.Connecting
            val closed = kotlinx.coroutines.CompletableDeferred<Int>()
            val url = c.first.trimEnd('/').replaceFirst("http", "ws") + "/ws?token=" + java.net.URLEncoder.encode(c.second, "UTF-8") + "&name=" + java.net.URLEncoder.encode(c.third, "UTF-8")
            val ws = http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) { attempt = 0 }
                override fun onMessage(webSocket: WebSocket, text: String) { handle(text) }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { closed.complete(code) }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    closed.complete(response?.code ?: -1)
                }
            })
            socket = ws
            val code = closed.await()
            _clients.value = emptyList()
            if (code == 401) { _link.value = Link.Unauthorized; return }
            _link.value = Link.Offline
            val wait = min(10_000.0, 400 * 1.7.pow(attempt++)) * (0.75 + Math.random() * 0.5)
            delay(wait.toLong())
        }
    }

    private fun handle(text: String) {
        val o = runCatching { AppJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        when (o["t"]?.jsonPrimitive?.contentOrNull) {
            "welcome" -> {
                _link.value = Link.Online
                o["display"]?.let { _display.value = AppJson.decodeFromJsonElement(DisplayState.serializer(), it) }
                (o["boards"] as? JsonArray)?.let { arr ->
                    _boards.value = arr.map { AppJson.decodeFromJsonElement(BoardInfo.serializer(), it) }
                }
            }
            "display" -> o["display"]?.let { _display.value = AppJson.decodeFromJsonElement(DisplayState.serializer(), it) }
            "presence" -> _clients.value = (o["clients"] as? JsonArray)?.map {
                val c = it.jsonObject
                ClientInfo(c["id"]?.jsonPrimitive?.contentOrNull ?: "", c["role"]?.jsonPrimitive?.contentOrNull ?: "", c["name"]?.jsonPrimitive?.contentOrNull ?: "")
            } ?: emptyList()
            "boards" -> _boardsChanged.tryEmit(Unit)
            "ai" -> _events.tryEmit(
                ServerEvent.Ai(
                    ev = o["ev"]?.jsonPrimitive?.contentOrNull ?: "",
                    turnId = o["turnId"]?.jsonPrimitive?.contentOrNull,
                    boardId = o["boardId"]?.jsonPrimitive?.contentOrNull,
                    text = o["text"]?.jsonPrimitive?.contentOrNull,
                    message = o["message"]?.jsonPrimitive?.contentOrNull,
                    changed = o["changed"]?.jsonPrimitive?.intOrNull ?: 0,
                    name = o["name"]?.jsonPrimitive?.contentOrNull,
                ),
            )
            "msg" -> o["message"]?.let { _events.tryEmit(ServerEvent.Message(AppJson.decodeFromJsonElement(ChatMessage.serializer(), it))) }
            "pending" -> o["pending"]?.let { _events.tryEmit(ServerEvent.Confirm(AppJson.decodeFromJsonElement(PendingConfirm.serializer(), it))) }
            "pending.resolved" -> _events.tryEmit(ServerEvent.ConfirmResolved(o["id"]?.jsonPrimitive?.contentOrNull ?: ""))
            "secrets" -> _events.tryEmit(ServerEvent.Keys(o["name"]?.jsonPrimitive?.contentOrNull))
            else -> Unit
        }
    }

    private fun send(obj: JsonObject): Boolean = socket?.send(AppJson.encodeToString(JsonObject.serializer(), obj)) ?: false

    /** Remote-control the TV (board, camera, selection, focus mode, presentation slide). */
    fun sendDisplay(patch: JsonObject): Boolean = send(buildJsonObject { put("t", "display"); put("patch", patch) })

    /** Subtitles for the TV while a conversation is going on. */
    fun sendCaption(text: String, role: String, final: Boolean) {
        send(buildJsonObject { put("t", "caption"); put("text", text); put("role", role); put("final", final) })
    }

    fun sendTts(obj: JsonObject) { send(JsonObject(obj + ("t" to JsonPrimitive("tts")))) }

    fun log(msg: String) = Log.d("OBoardEvents", msg)
}
