package app.oboard.voice

import android.util.Base64
import android.util.Log
import app.oboard.data.Api
import app.oboard.data.AppJson
import app.oboard.data.Events
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit

sealed interface LiveState {
    data object Idle : LiveState
    data object Connecting : LiveState
    data object Listening : LiveState
    data object Speaking : LiveState
    data object Reconnecting : LiveState
    data class Failed(val message: String) : LiveState
}

/**
 * Gemini Live voice mode. Audio goes straight from the phone to Google (lowest latency, native expressive voice);
 * the Pi only mints a short-lived single-use token and executes tool calls, so the API key never reaches the phone
 * and every board change is still validated and saved on the Pi.
 */
class LiveSession(
    http: OkHttpClient,
    private val api: Api,
    private val events: Events,
    private val scope: CoroutineScope,
    private val mic: Mic,
    private val route: AudioRoute,
) {
    private val http = http.newBuilder().pingInterval(20, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    private val _state = MutableStateFlow<LiveState>(LiveState.Idle)
    val state: StateFlow<LiveState> = _state.asStateFlow()
    private val _userText = MutableStateFlow("")
    val userText: StateFlow<String> = _userText.asStateFlow()
    private val _aiText = MutableStateFlow("")
    val aiText: StateFlow<String> = _aiText.asStateFlow()
    val level get() = mic.level

    private var ws: WebSocket? = null
    private var player: PcmPlayer? = null
    private var handle: String? = null
    private var sessionId = ""
    private var boardId = ""
    private var wanted = false
    private var reconnects = 0
    private var job: Job? = null
    private val pending = ByteBuffer.allocate(640 * 2).order(ByteOrder.LITTLE_ENDIAN)
    private var connectedAt = 0L

    val active get() = wanted

    fun start(board: String) {
        if (wanted) return
        wanted = true
        boardId = board
        handle = null
        reconnects = 0
        route.enterConversation()
        player = PcmPlayer(24000, voiceComm = true).also { p -> p.onDrained = { if (_state.value == LiveState.Speaking) _state.value = LiveState.Listening } }
        connect()
    }

    fun stop() {
        wanted = false
        job?.cancel()
        mic.stop()
        ws?.close(1000, "bye")
        ws = null
        player?.release(); player = null
        route.exitConversation()
        flushTranscripts(final = true)
        _state.value = LiveState.Idle
    }

    private fun connect() {
        _state.value = if (handle == null) LiveState.Connecting else LiveState.Reconnecting
        job = scope.launch(Dispatchers.IO) {
            try {
                val start = api.liveToken(boardId)
                sessionId = start.sessionId
                var setup = start.setup
                handle?.let { h -> setup = JsonObject(setup + ("sessionResumption" to buildJsonObject { put("handle", h) })) }
                val first = buildJsonObject { put("setup", setup) }
                ws = http.newWebSocket(Request.Builder().url(start.wsUrl).build(), object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        webSocket.send(AppJson.encodeToString(JsonObject.serializer(), first))
                    }
                    override fun onMessage(webSocket: WebSocket, text: String) = handle(text)
                    override fun onMessage(webSocket: WebSocket, bytes: ByteString) = handle(bytes.utf8())
                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = lost("closed ($code) $reason")
                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = lost(t.message ?: "connection failed")
                })
            } catch (e: Exception) {
                lost(e.message ?: "Could not start Gemini Live")
            }
        }
    }

    private fun lost(why: String) {
        Log.w("LiveSession", "connection lost: $why")
        mic.stop()
        if (!wanted) return
        if (reconnects++ < 3) {
            scope.launch { delay(600L * reconnects); if (wanted) connect() }
        } else {
            wanted = false
            route.exitConversation()
            _state.value = LiveState.Failed(why)
        }
    }

    private fun handle(text: String) {
        val o = runCatching { AppJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        when {
            "setupComplete" in o -> {
                reconnects = 0
                connectedAt = System.currentTimeMillis()
                _state.value = LiveState.Listening
                startMic()
            }
            "serverContent" in o -> serverContent(o["serverContent"]!!.jsonObject)
            "toolCall" in o -> toolCall(o["toolCall"]!!.jsonObject)
            "sessionResumptionUpdate" in o -> {
                val u = o["sessionResumptionUpdate"]!!.jsonObject
                if (u["resumable"]?.jsonPrimitive?.booleanOrNull == true) u["newHandle"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }?.let { handle = it }
            }
            "goAway" in o -> {
                // The server will drop this connection soon; move to a fresh one, carrying the conversation over.
                ws?.close(1000, "goAway")
            }
            "error" in o -> Log.w("LiveSession", "server error: $text")
        }
    }

    private fun startMic() {
        if (mic.isRunning) return
        mic.start(comm = true) { frame ->
            synchronized(pending) {
                for (s in frame) {
                    pending.putShort(s)
                    if (!pending.hasRemaining()) {
                        val b64 = Base64.encodeToString(pending.array(), Base64.NO_WRAP)
                        pending.clear()
                        ws?.send("""{"realtimeInput":{"audio":{"data":"$b64","mimeType":"audio/pcm;rate=16000"}}}""")
                    }
                }
            }
        }
    }

    private fun serverContent(sc: JsonObject) {
        (sc["modelTurn"] as? JsonObject)?.get("parts")?.let { parts ->
            for (p in parts as JsonArray) {
                val inline = (p as? JsonObject)?.get("inlineData") as? JsonObject ?: continue
                val data = inline["data"]?.jsonPrimitive?.contentOrNull ?: continue
                val bytes = Base64.decode(data, Base64.DEFAULT)
                val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
                val pcm = FloatArray(bytes.size / 2) { bb.short / 32768f }
                player?.let { it.enqueue(pcm, it.generation) }
                _state.value = LiveState.Speaking
            }
        }
        (sc["inputTranscription"] as? JsonObject)?.get("text")?.jsonPrimitive?.contentOrNull?.let {
            _userText.value += it
            events.sendCaption(_userText.value, "user", false)
        }
        (sc["outputTranscription"] as? JsonObject)?.get("text")?.jsonPrimitive?.contentOrNull?.let {
            _aiText.value += it
            events.sendCaption(_aiText.value, "assistant", false)
        }
        if (sc["interrupted"]?.jsonPrimitive?.booleanOrNull == true) {
            player?.stop()
            _state.value = LiveState.Listening
        }
        if (sc["turnComplete"]?.jsonPrimitive?.booleanOrNull == true) flushTranscripts(final = true)
    }

    private fun flushTranscripts(final: Boolean) {
        val u = _userText.value.trim()
        val a = _aiText.value.trim()
        if (u.isEmpty() && a.isEmpty()) return
        _userText.value = ""
        _aiText.value = ""
        if (a.isNotEmpty() && final) events.sendCaption(a, "assistant", true)
        val board = boardId
        val sid = sessionId
        scope.launch(Dispatchers.IO) {
            runCatching {
                if (u.isNotEmpty()) api.liveTranscript(board, "user", u, sid)
                if (a.isNotEmpty()) api.liveTranscript(board, "assistant", a, sid)
            }
        }
    }

    private fun toolCall(tc: JsonObject) {
        val calls = tc["functionCalls"] as? JsonArray ?: return
        scope.launch(Dispatchers.IO) {
            val responses = buildJsonArray {
                for (c in calls) {
                    val call = c.jsonObject
                    val name = call["name"]?.jsonPrimitive?.contentOrNull ?: continue
                    val id = call["id"]?.jsonPrimitive?.contentOrNull
                    val result = runCatching { api.liveTool(boardId, name, call["args"], sessionId) }.getOrElse { e ->
                        buildJsonObject { put("result", buildJsonObject { put("ok", false); put("error", e.message ?: "tool failed") }) }
                    }
                    result["boardId"]?.jsonPrimitive?.contentOrNull?.let { boardId = it }
                    add(buildJsonObject {
                        id?.let { put("id", it) }
                        put("name", name)
                        put("response", result["result"] ?: JsonObject(emptyMap()))
                    })
                }
            }
            ws?.send(AppJson.encodeToString(JsonObject.serializer(), buildJsonObject { put("toolResponse", buildJsonObject { put("functionResponses", responses) }) }))
        }
    }

    /** Send an image into the live conversation ("look at this"). */
    fun sendImage(jpeg: ByteArray) {
        val b64 = Base64.encodeToString(jpeg, Base64.NO_WRAP)
        ws?.send(AppJson.encodeToString(JsonObject.serializer(), buildJsonObject {
            put("realtimeInput", buildJsonObject { put("video", buildJsonObject { put("data", b64); put("mimeType", JsonPrimitive("image/jpeg")) }) })
        }))
    }
}
