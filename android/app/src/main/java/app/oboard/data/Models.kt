package app.oboard.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

val AppJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    isLenient = true
}

@Serializable
data class ServerInfo(
    val app: String = "",
    val serverId: String = "",
    val version: String = "",
    val protocol: Int = 0,
    val paired: Boolean = false,
    val gemini: Boolean = false,
)

@Serializable
data class PairResponse(
    val deviceId: String,
    val token: String,
    val serverId: String,
    val version: String = "",
    val protocol: Int = 0,
)

@Serializable
data class BoardInfo(
    val id: String,
    val name: String,
    val kind: String,
    val pinned: Boolean = false,
    val archived: Boolean = false,
    val rev: Long = 0,
    val count: Int = 0,
    val updatedAt: Long = 0,
    val openedAt: Long = 0,
    val preview: BoardPreview? = null,
) {
    val isThoughts get() = kind == "thoughts"
}

/** A tiny sketch of a board: boxes as [x, y, w, h, kind, color] in 0..1 of the content, and its aspect ratio. */
@Serializable
data class BoardPreview(val a: Float = 1f, val b: List<List<Float>> = emptyList())

@Serializable
data class Cam(val x: Double, val y: Double, val z: Double)

@Serializable
data class Viewport(val w: Int = 1920, val h: Int = 1080)

@Serializable
data class DisplayState(
    val boardId: String = "",
    val cam: Cam? = null,
    val viewport: Viewport = Viewport(),
    val selection: List<String> = emptyList(),
    val mode: String = "normal",
    val focusIds: List<String> = emptyList(),
    val slide: Int = 0,
    val audio: Boolean = false,
)

@Serializable
data class ChatMessage(
    val id: String,
    val boardId: String = "",
    val role: String,
    val text: String,
    val source: String? = null,
    val attachments: List<String>? = null,
    val turnId: String? = null,
    val ts: Long = 0,
)

@Serializable
data class BoardObject(
    val id: String,
    val type: String,
    val text: String? = null,
    val title: String? = null,
    val url: String? = null,
    val alt: String? = null,
    val asset: String? = null,
    val name: String? = null,
    val tag: String? = null,
    val origin: String? = null,
    val t: Long = 0,
    val x: Double = 0.0,
    val y: Double = 0.0,
) {
    val label: String get() = text ?: title ?: alt ?: name ?: url ?: type
}

@Serializable
data class AssetInfo(
    val id: String,
    val mime: String,
    val filename: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val caption: String? = null,
)

@Serializable
data class LiveStart(
    val sessionId: String,
    val token: String,
    val expiresAt: Long = 0,
    val model: String = "",
    val wsUrl: String,
    val setup: JsonObject,
)

@Serializable
data class AiSettings(
    val textModel: String = "",
    val liveModel: String = "",
    val thinkingLevel: String = "low",
    val liveVoice: String = "Kore",
    val voiceEngine: String = "local",
    val extraInstructions: String = "",
    val autoCaptionImages: Boolean = true,
)

@Serializable
data class DeviceInfo(val id: String, val name: String, val role: String, val createdAt: Long = 0, val lastSeen: Long = 0)

/** An API key for widgets, as the Pi describes it. The key itself never leaves the Pi. */
@Serializable
data class ApiKeyInfo(
    val name: String,
    val host: String,
    val service: String = "",
    val signupUrl: String = "",
    val why: String = "",
    val set: Boolean = false,
    val createdAt: Long = 0,
    val updatedAt: Long? = null,
    val requestedAt: Long? = null,
) {
    val label: String get() = service.ifBlank { name }
}

@Serializable
data class PendingConfirm(val id: String, val boardId: String = "", val summary: String, val expiresAt: Long = 0)

@Serializable
data class SearchHit(val boardId: String, val board: String, val `object`: BoardObject)

/** Events pushed by the server over the WebSocket that the app cares about. */
sealed interface ServerEvent {
    data class Ai(val ev: String, val turnId: String?, val boardId: String?, val text: String?, val message: String?, val changed: Int, val name: String?) : ServerEvent
    data class Message(val message: ChatMessage) : ServerEvent
    data class Confirm(val pending: PendingConfirm) : ServerEvent
    data class ConfirmResolved(val id: String) : ServerEvent
    /** API keys changed on the Pi (one was saved, removed, or the assistant asked for one). */
    data class Keys(val name: String?) : ServerEvent
}

enum class Link { Connecting, Online, Offline, Unauthorized }
