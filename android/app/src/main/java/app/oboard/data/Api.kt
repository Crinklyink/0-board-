package app.oboard.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.io.OutputStream
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class ApiException(val status: Int, message: String) : IOException(message) {
    val unauthorized get() = status == 401
}

/** REST client for the Pi. Every call except info() and pair() carries the per-device bearer token. */
class Api(private val http: OkHttpClient) {
    @Volatile var baseUrl: String = ""
    @Volatile var token: String = ""

    private val jsonType = "application/json; charset=utf-8".toMediaType()

    private suspend fun exec(req: Request): Response = suspendCancellableCoroutine { cont ->
        val call: Call = http.newCall(req)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { if (cont.isActive) cont.resumeWithException(e) }
            override fun onResponse(call: Call, response: Response) { cont.resume(response) }
        })
    }

    private fun req(base: String, method: String, path: String, body: RequestBody?, auth: Boolean, token: String = this.token): Request {
        val b = Request.Builder().url(base.trimEnd('/') + path)
        if (auth) b.header("Authorization", "Bearer $token")
        b.method(method, body ?: if (method == "GET" || method == "DELETE") null else ByteArray(0).toRequestBody())
        return b.build()
    }

    // Response bodies are read on the IO dispatcher: the coroutine resumes on the caller's (often the main) thread, and
    // a body bigger than OkHttp's first buffer would otherwise be read from the socket there.
    private suspend fun call(method: String, path: String, body: JsonElement? = null, auth: Boolean = true, base: String = baseUrl, token: String = this.token): JsonObject = withContext(Dispatchers.IO) {
        val rb = body?.let { AppJson.encodeToString(JsonElement.serializer(), it).toRequestBody(jsonType) }
        exec(req(base, method, path, rb, auth, token)).use { res ->
            val text = res.body?.string().orEmpty()
            val json = runCatching { AppJson.parseToJsonElement(text) }.getOrNull() as? JsonObject
            if (!res.isSuccessful) throw ApiException(res.code, json?.get("error")?.jsonPrimitive?.contentOrNull ?: "Request failed (${res.code})")
            json ?: JsonObject(emptyMap())
        }
    }

    private suspend fun <T> call(method: String, path: String, body: JsonElement?, ser: KSerializer<T>, key: String? = null, auth: Boolean = true): T {
        val obj = call(method, path, body, auth)
        val el: JsonElement = if (key != null) obj[key] ?: JsonNull else obj
        return AppJson.decodeFromJsonElement(ser, el)
    }

    // -------------------------------------------------------------------- unauthenticated

    suspend fun info(base: String): ServerInfo = AppJson.decodeFromJsonElement(ServerInfo.serializer(), call("GET", "/api/info", auth = false, base = base))

    suspend fun pair(base: String, code: String, name: String): PairResponse {
        val body = buildJsonObject { put("code", code); put("name", name); put("role", "phone") }
        return AppJson.decodeFromJsonElement(PairResponse.serializer(), call("POST", "/api/pair", body, auth = false, base = base))
    }

    /** Every address the Pi answers on (home network, Tailscale, ...), best first. */
    suspend fun addresses(): List<String> =
        (call("GET", "/api/me")["addresses"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()

    // ------------------------------------------------------------------------- widget API keys

    suspend fun apiKeys(): List<ApiKeyInfo> = call("GET", "/api/secrets", null, ListSerializer(ApiKeyInfo.serializer()), "secrets")

    suspend fun saveApiKey(name: String, value: String, host: String? = null, service: String? = null): ApiKeyInfo {
        val body = buildJsonObject { put("value", value); host?.let { put("host", it) }; service?.let { put("service", it) } }
        return call("PUT", "/api/secrets/$name", body, ApiKeyInfo.serializer(), "secret")
    }

    suspend fun deleteApiKey(name: String) { call("DELETE", "/api/secrets/$name") }

    // ------------------------------------------------------------------------- boards

    suspend fun boards(): Pair<List<BoardInfo>, DisplayState?> {
        val o = call("GET", "/api/boards?preview=1")
        val boards = AppJson.decodeFromJsonElement(ListSerializer(BoardInfo.serializer()), o["boards"] ?: JsonArray(emptyList()))
        val display = o["display"]?.let { runCatching { AppJson.decodeFromJsonElement(DisplayState.serializer(), it) }.getOrNull() }
        return boards to display
    }

    suspend fun createBoard(name: String, template: String = "blank"): BoardInfo = call("POST", "/api/boards", buildJsonObject { put("name", name); put("template", template) }, BoardInfo.serializer(), "board")

    suspend fun boardTemplates(): List<BoardTemplate> = call("GET", "/api/board-templates", null, ListSerializer(BoardTemplate.serializer()), "templates")
    suspend fun diagnostics(): DiagnosticReport = AppJson.decodeFromJsonElement(DiagnosticReport.serializer(), call("GET", "/api/diagnostics"))
    suspend fun saveGeminiKey(key: String) { call("PUT", "/api/setup/gemini-key", buildJsonObject { put("key", key) }) }
    suspend fun testGemini(): DiagnosticReport = AppJson.decodeFromJsonElement(DiagnosticReport.serializer(), call("POST", "/api/diagnostics/gemini", JsonObject(emptyMap())))

    suspend fun updateBoard(id: String, name: String? = null, pinned: Boolean? = null, archived: Boolean? = null): BoardInfo {
        val body = buildJsonObject { name?.let { put("name", it) }; pinned?.let { put("pinned", it) }; archived?.let { put("archived", it) } }
        return call("PATCH", "/api/boards/$id", body, BoardInfo.serializer(), "board")
    }

    suspend fun boardObjects(id: String): List<BoardObject> {
        val o = call("GET", "/api/boards/$id")
        return AppJson.decodeFromJsonElement(ListSerializer(BoardObject.serializer()), o["objects"] ?: JsonArray(emptyList()))
    }

    suspend fun undoAi(boardId: String): JsonObject = call("POST", "/api/boards/$boardId/undo-ai", JsonObject(emptyMap()))

    // ------------------------------------------------------------------ capture & assets

    suspend fun capture(boardId: String, text: String?, assetIds: List<String>, clientId: String, source: String): JsonObject {
        val body = buildJsonObject {
            put("boardId", boardId)
            text?.let { put("text", it) }
            put("assetIds", JsonArray(assetIds.map { JsonPrimitive(it) }))
            put("clientId", clientId)
            put("source", source)
        }
        return call("POST", "/api/capture", body)
    }

    suspend fun upload(bytes: ByteArray, mime: String, filename: String): AssetInfo {
        val rb = bytes.toRequestBody(mime.toMediaType())
        val r = Request.Builder().url("${baseUrl.trimEnd('/')}/api/assets").header("Authorization", "Bearer $token")
            .header("x-filename", java.net.URLEncoder.encode(filename, "UTF-8").replace("+", "%20")).post(rb).build()
        return withContext(Dispatchers.IO) {
            exec(r).use { res ->
                val text = res.body?.string().orEmpty()
                val json = runCatching { AppJson.parseToJsonElement(text).jsonObject }.getOrNull()
                if (!res.isSuccessful) throw ApiException(res.code, json?.get("error")?.jsonPrimitive?.contentOrNull ?: "Upload failed (${res.code})")
                AppJson.decodeFromJsonElement(AssetInfo.serializer(), json!!["asset"]!!)
            }
        }
    }

    // ----------------------------------------------------------------------------- AI

    suspend fun aiMessage(boardId: String, text: String, source: String, attachments: List<String> = emptyList(), selection: List<String> = emptyList()): String {
        val body = buildJsonObject {
            put("boardId", boardId); put("text", text); put("source", source)
            put("attachments", JsonArray(attachments.map { JsonPrimitive(it) }))
            put("selection", JsonArray(selection.map { JsonPrimitive(it) }))
        }
        return call("POST", "/api/ai/message", body)["turnId"]?.jsonPrimitive?.contentOrNull ?: ""
    }

    suspend fun aiCancel(turnId: String? = null, boardId: String? = null) {
        call("POST", "/api/ai/cancel", buildJsonObject { turnId?.let { put("turnId", it) }; boardId?.let { put("boardId", it) } })
    }

    suspend fun confirm(id: String, accept: Boolean): JsonObject = call("POST", "/api/ai/confirm", buildJsonObject { put("id", id); put("accept", accept) })

    suspend fun conversation(boardId: String, limit: Int = 60): List<ChatMessage> {
        val o = call("GET", "/api/conversation/$boardId?limit=$limit")
        return AppJson.decodeFromJsonElement(ListSerializer(ChatMessage.serializer()), o["messages"] ?: JsonArray(emptyList()))
    }

    // ------------------------------------------------------------------------ display

    suspend fun display(patch: JsonObject): DisplayState =
        call("POST", "/api/display", patch, DisplayState.serializer(), "display")

    // ---------------------------------------------------------------------- Gemini Live

    suspend fun liveToken(boardId: String, selection: List<String> = emptyList()): LiveStart {
        val body = buildJsonObject { put("boardId", boardId); put("selection", JsonArray(selection.map { JsonPrimitive(it) })) }
        return call("POST", "/api/live/token", body, LiveStart.serializer())
    }

    suspend fun liveTool(boardId: String, name: String, args: JsonElement?, sessionId: String): JsonObject {
        val body = buildJsonObject { put("boardId", boardId); put("name", name); put("args", args ?: JsonObject(emptyMap())); put("sessionId", sessionId) }
        return call("POST", "/api/live/tool", body)
    }

    suspend fun liveTranscript(boardId: String, role: String, text: String, sessionId: String) {
        call("POST", "/api/live/transcript", buildJsonObject { put("boardId", boardId); put("role", role); put("text", text); put("sessionId", sessionId) })
    }

    // ------------------------------------------------------------------ settings & admin

    suspend fun aiSettings(): Pair<AiSettings, Boolean> {
        val o = call("GET", "/api/settings")
        return AppJson.decodeFromJsonElement(AiSettings.serializer(), o["settings"]!!) to (o["gemini"]?.jsonPrimitive?.contentOrNull == "true")
    }

    suspend fun putAiSettings(patch: JsonObject): AiSettings = call("PUT", "/api/settings", patch, AiSettings.serializer(), "settings")

    suspend fun aiModels(): List<String> {
        val o = call("GET", "/api/ai/models")
        return (o["models"] as? JsonArray)?.mapNotNull { it.jsonObject["name"]?.jsonPrimitive?.contentOrNull } ?: emptyList()
    }

    suspend fun devices(): List<DeviceInfo> {
        val o = call("GET", "/api/devices")
        return AppJson.decodeFromJsonElement(ListSerializer(DeviceInfo.serializer()), o["devices"] ?: JsonArray(emptyList()))
    }

    suspend fun revokeDevice(id: String) { call("DELETE", "/api/devices/$id") }

    suspend fun newPairingCode(): JsonObject = call("GET", "/api/pair/new")

    suspend fun createBackup(): JsonObject = call("POST", "/api/backups", JsonObject(emptyMap()))

    suspend fun search(q: String): List<SearchHit> {
        val o = call("GET", "/api/search?q=" + java.net.URLEncoder.encode(q, "UTF-8"))
        return AppJson.decodeFromJsonElement(ListSerializer(SearchHit.serializer()), o["objects"] ?: JsonArray(emptyList()))
    }

    /** Stream the full backup (.tar with database and every uploaded file) into [out]. Returns bytes written. */
    suspend fun downloadFullBackup(out: OutputStream): Long {
        val r = Request.Builder().url("${baseUrl.trimEnd('/')}/api/backup/full").header("Authorization", "Bearer $token").build()
        return withContext(Dispatchers.IO) {
            exec(r).use { res ->
                if (!res.isSuccessful) throw ApiException(res.code, "Backup failed (${res.code})")
                res.body!!.byteStream().use { it.copyTo(out) }
            }
        }
    }

    suspend fun exportBoard(id: String): ByteArray {
        val r = Request.Builder().url("${baseUrl.trimEnd('/')}/api/boards/$id/export").header("Authorization", "Bearer $token").build()
        return withContext(Dispatchers.IO) {
            exec(r).use { res ->
                if (!res.isSuccessful) throw ApiException(res.code, "Export failed (${res.code})")
                res.body!!.bytes()
            }
        }
    }
}
