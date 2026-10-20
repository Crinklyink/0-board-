package app.oboard.ui

import android.Manifest
import android.app.Application
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.oboard.OBoardApp
import app.oboard.data.AiSettings
import app.oboard.data.ApiException
import app.oboard.data.BoardInfo
import app.oboard.data.BoardObject
import app.oboard.data.ChatMessage
import app.oboard.data.DeviceInfo
import app.oboard.data.ImagePrep
import app.oboard.data.Link
import app.oboard.data.PendingConfirm
import app.oboard.data.ApiKeyInfo
import app.oboard.data.ServerEvent
import app.oboard.voice.LiveState
import app.oboard.voice.ModelCatalog
import app.oboard.voice.VoiceState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.io.OutputStream

enum class Tab { Capture, Boards, Remote }
enum class SettingsPage { Main, Connection, Voice, Models, Assistant, ApiKeys, Backup, About }

sealed interface Overlay {
    data class Canvas(val boardId: String) : Overlay
    data class Settings(val page: SettingsPage = SettingsPage.Main) : Overlay
}

enum class Who { User, Assistant, Capture, Notice }

data class ThreadItem(
    val id: String,
    val who: Who,
    val text: String,
    val ts: Long,
    val pending: Boolean = false,
    val error: String? = null,
    val files: Int = 0,
    val status: String? = null,
)

data class Streaming(val turnId: String, val boardId: String?, val text: String = "", val status: String = "Thinking")

class AppViewModel(app: Application) : AndroidViewModel(app) {
    val c = (app as OBoardApp).container
    val settings = c.settings
    val settingsLoaded = c.settingsLoaded
    val link = c.events.link
    val display = c.events.display
    val clients = c.events.clients
    val tvOnline: StateFlow<Boolean> = clients.map { l -> l.any { it.role == "display" } }.stateIn(viewModelScope, SharingStarted.Eagerly, false)
    val queued = c.queue.items
    val receipts = c.queue.receipts
    val voiceState: StateFlow<VoiceState> = c.voice.state
    val voiceMetrics = c.voice.metrics
    val liveState: StateFlow<LiveState> = c.live.state
    val liveUser = c.live.userText
    val liveAi = c.live.aiText

    private val _boards = MutableStateFlow<List<BoardInfo>>(emptyList())
    val boards: StateFlow<List<BoardInfo>> = _boards
    val tab = MutableStateFlow(Tab.Capture)
    val overlay = MutableStateFlow<Overlay?>(null)
    val composer = MutableStateFlow("")
    val attachments = MutableStateFlow<List<Uri>>(emptyList())
    val confirms = MutableStateFlow<List<PendingConfirm>>(emptyList())
    val messages = MutableStateFlow<List<ChatMessage>>(emptyList())
    val streaming = MutableStateFlow<Streaming?>(null)
    val thoughts = MutableStateFlow<List<BoardObject>>(emptyList())
    val thoughtsLoading = MutableStateFlow(false)
    val sending = MutableStateFlow(false)
    val lastUndo = MutableStateFlow<Pair<String, Int>?>(null) // boardId, changes
    private val _notices = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val notices: SharedFlow<String> = _notices.asSharedFlow()

    /** The board the assistant works on: whatever the TV shows, unless the user picked one here. */
    val pinnedAiBoard = MutableStateFlow<String?>(null)
    val aiBoard: StateFlow<String?> = combine(pinnedAiBoard, display, _boards) { pinned, d, list ->
        pinned?.takeIf { id -> list.isEmpty() || list.any { it.id == id } } ?: d?.boardId ?: settings.value.lastBoard.ifBlank { null } ?: list.firstOrNull { it.kind == "space" }?.id
    }.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    private val optimistic = MutableStateFlow<List<ThreadItem>>(emptyList())

    val thread: StateFlow<List<ThreadItem>> = combine(messages, optimistic, queued, receipts, streaming) { msgs, opt, q, rec, st ->
        val items = ArrayList<ThreadItem>()
        msgs.forEach { m -> items += ThreadItem(m.id, if (m.role == "user") Who.User else Who.Assistant, m.text, m.ts) }
        val seen = msgs.filter { it.role == "user" }.map { it.text.trim() }.toSet()
        opt.filter { it.text.trim() !in seen }.forEach { items += it }
        q.forEach { items += ThreadItem(it.id, Who.Capture, it.text ?: "", it.createdAt, pending = it.error == null || it.attempts < 100, error = it.error, files = it.files.size) }
        rec.forEach { items += ThreadItem(it.id, Who.Capture, it.text ?: "", it.at, files = it.fileCount, status = "Saved to Thoughts") }
        items.sortBy { it.ts }
        if (st != null) items += ThreadItem("stream-${st.turnId}", Who.Assistant, st.text, Long.MAX_VALUE, pending = true, status = st.status)
        items
    }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    init {
        viewModelScope.launch {
            c.events.boards.collect { list ->
                if (list.isEmpty()) return@collect
                // The live list has no thumbnails: keep the ones we have, then fetch fresh ones.
                val old = _boards.value.associateBy { it.id }
                _boards.value = list.map { b -> b.copy(preview = old[b.id]?.preview) }
                refreshBoards()
            }
        }
        viewModelScope.launch { c.events.boardsChanged.collect { refreshBoards() } }
        viewModelScope.launch {
            link.collect { if (it == Link.Online) { refreshBoards(); loadThread(); loadApiKeys() } }
        }
        viewModelScope.launch { aiBoard.map { it }.distinctUntilChanged().collect { loadThread() } }
        viewModelScope.launch { c.events.events.collect { onEvent(it) } }
        viewModelScope.launch { receipts.collect { if (tab.value == Tab.Boards) loadThoughts() } }
        c.voice.onUtterance = { text -> viewModelScope.launch { ask(text, viaVoice = true) } }
        c.voice.warmUp()
        viewModelScope.launch {
            c.debugCommands.collect { cmd ->
                when (cmd) {
                    "selftest" -> runSelfTest()
                    "conversation" -> runConversationTest()
                    "interrupt" -> runInterruptTest()
                    "engine:live" -> c.prefs.update { it.voiceEngine("live") }
                    "engine:local" -> c.prefs.update { it.voiceEngine("local") }
                    "live:start" -> if (!c.live.active) toggleLive()
                    "live:stop" -> if (c.live.active) toggleLive()
                    "tts:kokoro" -> c.prefs.update { it.ttsEngine("kokoro"); it.voiceId(3) }
                    "tts:supertonic" -> c.prefs.update { it.ttsEngine("supertonic"); it.voiceId(0) }
                    "capture" -> { composer.value = "Debug capture ${System.currentTimeMillis()}"; captureComposer() }
                    "netchange" -> c.failover.onNetworkChanged()
                    // Test A: speech in (synthesised, fed through the real recogniser) -> editable text in the composer.
                    "dictate" -> deliverTranscript(c.voice.simulateSpokenInput("Add a note about the gripper pads."), talk = false)
                    // Failover tests: act as if the phone had been paired through another address of the same Pi.
                    else -> if (cmd.startsWith("url:")) cmd.removePrefix("url:").let { u -> c.prefs.update { it.serverUrl(u); it.altUrls(listOf(u)) } }
                }
            }
        }
    }

    fun notice(text: String) { _notices.tryEmit(text) }

    // ------------------------------------------------------------------------- server events

    private fun onEvent(e: ServerEvent) {
        val board = aiBoard.value
        when (e) {
            is ServerEvent.Message -> if (e.message.boardId == board && messages.value.none { it.id == e.message.id }) {
                messages.value = (messages.value + e.message).takeLast(200)
                if (e.message.role == "user") optimistic.value = optimistic.value.filterNot { it.text.trim() == e.message.text.trim() }
            }
            is ServerEvent.Ai -> {
                if (e.boardId != null && e.boardId != board) return
                val turn = e.turnId ?: return
                when (e.ev) {
                    "start" -> streaming.value = Streaming(turn, e.boardId)
                    "delta" -> streaming.value = (streaming.value?.takeIf { it.turnId == turn } ?: Streaming(turn, e.boardId)).let { it.copy(text = it.text + (e.text ?: ""), status = "") }
                    "tool" -> streaming.value = streaming.value?.takeIf { it.turnId == turn }?.copy(status = toolLabel(e.name))
                    "done" -> {
                        streaming.value = null
                        if (e.changed > 0 && e.boardId != null) lastUndo.value = e.boardId to e.changed
                    }
                    "error" -> { streaming.value = null; notice(e.message ?: "The assistant hit a problem") }
                    "cancelled" -> if (streaming.value?.turnId == turn) streaming.value = null
                }
            }
            is ServerEvent.Confirm -> confirms.value = confirms.value.filterNot { it.id == e.pending.id } + e.pending
            is ServerEvent.ConfirmResolved -> confirms.value = confirms.value.filterNot { it.id == e.id }
            is ServerEvent.Keys -> loadApiKeys()
        }
    }

    private fun toolLabel(name: String?) = when (name) {
        "add_notes" -> "Adding notes"; "create_diagram" -> "Drawing a diagram"; "organize_objects" -> "Organizing"
        "move_objects" -> "Moving things"; "connect_objects" -> "Connecting"; "edit_object" -> "Editing"
        "delete_objects" -> "Checking what to delete"; "search_board", "read_board", "read_objects" -> "Reading the board"
        "focus_tv" -> "Moving the TV view"; "recall" -> "Remembering"; "view_images" -> "Looking at images"
        "create_widget" -> "Building a widget"; "update_widget" -> "Fixing the widget"; "read_widget_logs" -> "Checking the widget"
        "request_api_key" -> "Asking for an API key"; "list_api_keys" -> "Checking API keys"
        "create_section", "group_into_section" -> "Grouping"; "resize_object" -> "Resizing"; "switch_board", "create_board" -> "Switching boards"
        "undo_ai_change" -> "Undoing"; "restore_version", "list_versions" -> "Finding the earlier version"
        else -> "Working"
    }

    // ------------------------------------------------------------------------------- pairing

    suspend fun pair(address: String, code: String): String? {
        val url = normalizeUrl(address) ?: return "Enter the Pi's address, like 192.168.1.20 or oboard.local"
        val digits = code.filter { it.isDigit() }
        if (digits.length != 8) return "The code has 8 digits"
        return try {
            val info = c.api.info(url)
            if (info.app != "oboard") return "That address isn't an O Board server"
            val r = c.api.pair(url, digits, settings.value.deviceName)
            c.prefs.savePairing(url, r.serverId, r.token)
            null
        } catch (e: ApiException) {
            e.message
        } catch (e: IOException) {
            "Can't reach $url. Check the address and that the phone is on the same network (or Tailscale)."
        }
    }

    fun normalizeUrl(input: String): String? {
        var s = input.trim().removeSuffix("/").removeSuffix(":")
        if (s.isEmpty()) return null
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        val uri = Uri.parse(s)
        if (uri.host.isNullOrBlank()) return null
        if (uri.port == -1) s = "${uri.scheme}://${uri.host}:8080"
        return s
    }

    fun forgetPairing() = viewModelScope.launch {
        c.live.stop(); c.voice.stopHandsFree()
        c.prefs.forgetPairing()
        overlay.value = null
    }

    // ------------------------------------------------------------------------------- boards

    fun refreshBoards() = viewModelScope.launch {
        runCatching { c.api.boards() }
            .onSuccess { (list, _) -> _boards.value = list }
            .onFailure { android.util.Log.w("OBoard", "Could not load boards", it) }
    }

    fun loadThread() = viewModelScope.launch {
        val board = aiBoard.value ?: return@launch
        runCatching { c.api.conversation(board, 60) }.onSuccess { messages.value = it }
    }

    fun loadThoughts() = viewModelScope.launch {
        thoughtsLoading.value = true
        runCatching { c.api.boardObjects("thoughts") }.onSuccess { list ->
            thoughts.value = list.filter { it.type in setOf("note", "link", "image", "file", "text") }.sortedByDescending { it.t }
        }
        thoughtsLoading.value = false
    }

    fun createBoard(name: String, open: Boolean = true) = viewModelScope.launch {
        try {
            val b = c.api.createBoard(name)
            refreshBoards()
            if (open) openCanvas(b.id)
        } catch (e: Exception) { notice(e.message ?: "Couldn't create the board") }
    }

    fun renameBoard(id: String, name: String) = viewModelScope.launch { runCatching { c.api.updateBoard(id, name = name) }.onFailure { notice(it.message ?: "Rename failed") }; refreshBoards() }
    fun pinBoard(id: String, pinned: Boolean) = viewModelScope.launch { runCatching { c.api.updateBoard(id, pinned = pinned) }; refreshBoards() }
    fun archiveBoard(id: String) = viewModelScope.launch { runCatching { c.api.updateBoard(id, archived = true) }.onSuccess { notice("Archived") }; refreshBoards() }

    fun openCanvas(id: String) {
        overlay.value = Overlay.Canvas(id)
        viewModelScope.launch { c.prefs.update { it.lastBoard(id) } }
    }

    fun showOnTv(id: String) {
        if (!c.events.sendDisplay(buildJsonObject { put("boardId", id) })) notice("Not connected to the Pi")
    }

    // ------------------------------------------------------------------------------- capture

    fun addAttachments(uris: List<Uri>) { attachments.value = (attachments.value + uris).distinct().take(8) }
    fun removeAttachment(uri: Uri) { attachments.value = attachments.value - uri }

    /** Save what's in the composer to Thoughts right now (works offline; delivered when back online). */
    fun captureComposer() {
        val text = composer.value.trim()
        val files = attachments.value
        if (text.isEmpty() && files.isEmpty()) return
        composer.value = ""
        attachments.value = emptyList()
        viewModelScope.launch {
            try {
                c.queue.add("thoughts", text, files, "capture")
            } catch (e: Exception) {
                composer.value = text
                notice(e.message ?: "Couldn't save that")
            }
        }
    }

    fun captureShared(intent: Intent) {
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()
        @Suppress("DEPRECATION")
        val uris: List<Uri> = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM))
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
            else -> emptyList()
        }
        if (text.isNullOrBlank() && uris.isEmpty()) return
        viewModelScope.launch {
            try {
                c.queue.add("thoughts", text, uris, "share")
                notice("Saved to Thoughts")
                tab.value = Tab.Capture
            } catch (e: Exception) { notice(e.message ?: "Couldn't save that") }
        }
    }

    /** Send text (typed or spoken) to the assistant, about the current AI board. */
    suspend fun ask(text: String, viaVoice: Boolean, files: List<Uri> = emptyList()) {
        val t = text.trim()
        if (t.isEmpty() && files.isEmpty()) return
        val board = aiBoard.value ?: run { notice("Pick a board first"); return }
        if (link.value != Link.Online) {
            c.queue.add("thoughts", t, files, if (viaVoice) "voice" else "capture")
            notice("Offline, so I saved that to Thoughts instead")
            return
        }
        sending.value = true
        optimistic.value = optimistic.value + ThreadItem("opt-${System.nanoTime()}", Who.User, t.ifEmpty { "(photo)" }, System.currentTimeMillis(), pending = true, files = files.size)
        try {
            val assetIds = withContext(Dispatchers.IO) {
                files.map { u -> val p = ImagePrep.prepare(getApplication(), u); c.api.upload(p.bytes, p.mime, p.name).id }
            }
            val turn = c.api.aiMessage(board, t.ifEmpty { "Look at this." }, if (viaVoice) "voice" else "text", assetIds)
            if (viaVoice && turn.isNotEmpty() && settings.value.voiceEngine == "local") c.voice.expectTurn(turn, board)
        } catch (e: Exception) {
            optimistic.value = optimistic.value.filterNot { it.text == t }
            notice(e.message ?: "Couldn't reach the assistant")
        } finally {
            sending.value = false
        }
    }

    fun askComposer() {
        val text = composer.value
        val files = attachments.value
        composer.value = ""
        attachments.value = emptyList()
        viewModelScope.launch { ask(text, viaVoice = false, files = files) }
    }

    fun stopAssistant() {
        c.voice.interrupt()
        val turn = streaming.value?.turnId
        viewModelScope.launch { runCatching { c.api.aiCancel(turnId = turn, boardId = aiBoard.value) } }
        streaming.value = null
    }

    fun resolveConfirm(id: String, accept: Boolean) = viewModelScope.launch {
        runCatching { c.api.confirm(id, accept) }.onFailure { notice(it.message ?: "Failed") }
        confirms.value = confirms.value.filterNot { it.id == id }
    }

    fun undoAi() = viewModelScope.launch {
        val (board, _) = lastUndo.value ?: return@launch
        lastUndo.value = null
        runCatching { c.api.undoAi(board) }.onSuccess { notice("Undone") }.onFailure { notice(it.message ?: "Undo failed") }
    }

    fun deleteQueued(id: String) = viewModelScope.launch { c.queue.discard(id) }

    // --------------------------------------------------------------------------------- voice

    fun hasMicPermission() = ContextCompat.checkSelfPermission(getApplication(), Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    val voiceReady get() = c.voice.ready

    /** Mic pressed. [talk] = send straight to the assistant on release (otherwise the text lands in the composer). */
    fun micStart(): Boolean {
        if (settings.value.voiceEngine == "live") { toggleLive(); return false }
        if (!c.voice.ready) {
            notice("Download the voice models first (about 1.1 GB, once)")
            overlay.value = Overlay.Settings(SettingsPage.Models)
            return false
        }
        streaming.value?.let { stopAssistant() }
        return c.voice.startListening()
    }

    fun micStop(talk: Boolean) = viewModelScope.launch { deliverTranscript(c.voice.stopListening(), talk) }

    /** "Send when I let go" sends straight away; otherwise the words land in the text box to be fixed first. */
    private suspend fun deliverTranscript(text: String, talk: Boolean) {
        if (text.isBlank()) { notice("I didn't catch that"); return }
        if (talk) ask(text, viaVoice = true) else composer.value = listOf(composer.value.trim(), text).filter { it.isNotEmpty() }.joinToString(" ")
    }

    fun micCancel() = c.voice.cancelListening()

    fun interruptVoice() {
        c.voice.interrupt()
        streaming.value = null
    }

    fun toggleHandsFree() {
        if (c.voice.handsFree) c.voice.stopHandsFree()
        else if (!c.voice.ready) { notice("Download the voice models first"); overlay.value = Overlay.Settings(SettingsPage.Models) }
        else c.voice.startHandsFree()
    }

    val handsFreeOn get() = c.voice.handsFree

    fun toggleLive() {
        if (c.live.active) { c.live.stop(); return }
        val board = aiBoard.value ?: run { notice("Pick a board first"); return }
        if (link.value != Link.Online) { notice("Gemini Live needs the Pi to be reachable"); return }
        c.voice.interrupt()
        c.live.start(board)
    }

    /** Stop anything that holds the microphone. Called when the app goes to the background. */
    fun releaseMic() {
        c.voice.cancelListening()
        c.voice.stopHandsFree()
        if (c.live.active) c.live.stop()
    }

    fun previewVoice(sid: Int) = c.voice.preview(sid, settings.value.speed)

    suspend fun runSelfTest(): String = c.voice.selfTest()

    /**
     * Interruption check: ask for a long spoken answer, cut it off once it starts talking, and verify that audio
     * stops right away, no stale speech resumes, and the server cancelled the turn.
     */
    suspend fun runInterruptTest(): String {
        if (!c.voice.ready) return "Voice models not downloaded."
        val board = aiBoard.value ?: return "No board"
        var cancelled = false
        val collector = viewModelScope.launch { c.events.events.collect { e -> if (e is ServerEvent.Ai && e.ev == "cancelled" && e.boardId == board) cancelled = true } }
        val heard = c.voice.simulateSpokenInput("Explain how the robot arm works.")
        ask(heard, viaVoice = true)
        val deadline = System.currentTimeMillis() + 30_000
        while (c.voice.state.value !is VoiceState.Speaking && System.currentTimeMillis() < deadline) kotlinx.coroutines.delay(50)
        if (c.voice.state.value !is VoiceState.Speaking) { collector.cancel(); return "Never started speaking" }
        kotlinx.coroutines.delay(700) // let it get a few words out
        val t0 = System.nanoTime()
        interruptVoice()
        var silentAfterMs = -1L
        while ((System.nanoTime() - t0) / 1_000_000 < 2000) {
            if (silentAfterMs < 0 && !c.voice.isPlaying) silentAfterMs = (System.nanoTime() - t0) / 1_000_000
            kotlinx.coroutines.delay(5)
        }
        // Stale speech must not come back on its own.
        kotlinx.coroutines.delay(3000)
        val resumed = c.voice.isPlaying || c.voice.state.value is VoiceState.Speaking
        collector.cancel()
        val report = buildString {
            appendLine("Interrupt test")
            appendLine("Heard: \"$heard\"")
            appendLine("Audio stopped ${silentAfterMs} ms after interrupting")
            appendLine("Server turn cancelled: ${if (cancelled) "yes" else "no (reply had already finished)"}")
            append("Stale speech resumed afterwards: ${if (resumed) "YES (bug)" else "no"}")
        }
        android.util.Log.i("VoiceSelfTest", report)
        return report
    }

    /**
     * Full voice loop without a microphone: synthesized speech -> on-device ASR -> assistant on the Pi -> spoken reply.
     * Reports what was heard, the reply, and the latencies the app measured along the way.
     */
    suspend fun runConversationTest(sentence: String = "Put a note on the board about mounting a camera above the robot arm."): String {
        if (!c.voice.ready) return "Voice models not downloaded."
        val t0 = System.currentTimeMillis()
        val heard = c.voice.simulateSpokenInput(sentence)
        if (heard.isBlank()) return "Nothing was recognised."
        val asrDone = System.currentTimeMillis()
        val board = aiBoard.value ?: return "No board"
        var reply = ""
        val collector = viewModelScope.launch {
            c.events.events.collect { e -> if (e is ServerEvent.Ai && e.ev == "done" && e.boardId == board) reply = e.text ?: "" }
        }
        ask(heard, viaVoice = true)
        // Wait for the reply to be spoken (or give up after 40 s).
        val deadline = System.currentTimeMillis() + 40_000
        var spoke = false
        while (System.currentTimeMillis() < deadline) {
            kotlinx.coroutines.delay(200)
            val st = c.voice.state.value
            if (st is VoiceState.Speaking) spoke = true
            if (spoke && st is VoiceState.Idle && reply.isNotEmpty()) break
            if (st is VoiceState.Problem) break
        }
        collector.cancel()
        val m = c.voice.metrics.value
        val report = buildString {
            appendLine("Conversation test")
            appendLine("Said: \"$sentence\"")
            appendLine("Heard: \"$heard\" (${asrDone - t0} ms incl. synthesis of the test speech)")
            appendLine("Assistant: \"${reply.ifBlank { "(no reply)" }}\"")
            appendLine("Spoken: ${if (spoke) "yes" else "no"}")
            appendLine("Reply text to first sound: ${m.replyToVoiceMs} ms")
            append("Mic release to first sound: ${m.releaseToVoiceMs} ms")
        }
        android.util.Log.i("VoiceSelfTest", report)
        return report
    }

    // ------------------------------------------------------------------------- TV remote

    fun display(patch: kotlinx.serialization.json.JsonObject) {
        if (!c.events.sendDisplay(patch)) notice("Not connected to the Pi")
    }

    fun tvSlide(delta: Int) {
        val d = display.value ?: return
        display(buildJsonObject { put("mode", "present"); put("slide", (d.slide + delta).coerceAtLeast(0)) })
    }

    fun tvPresent(on: Boolean) = display(buildJsonObject { put("mode", if (on) "present" else "normal"); put("slide", 0) })
    fun tvClearFocus() = display(buildJsonObject { put("mode", "normal"); put("selection", JsonArray(emptyList())); put("focusIds", JsonArray(emptyList())) })
    fun tvFit() = display(buildJsonObject { put("fit", true) })
    fun tvFocusSelection() {
        val sel = display.value?.selection.orEmpty()
        if (sel.isEmpty()) { notice("Tap something on the board first"); return }
        display(buildJsonObject { put("fit", true); put("fitIds", JsonArray(sel.map { JsonPrimitive(it) })); put("mode", "focus"); put("focusIds", JsonArray(sel.map { JsonPrimitive(it) })) })
    }
    fun tvAudio(on: Boolean) {
        viewModelScope.launch { c.prefs.update { it.tvAudio(on) } }
        display(buildJsonObject { put("audio", on) })
    }

    // ------------------------------------------------------------------------- settings

    fun updatePrefs(block: (app.oboard.data.Prefs.MutablePrefs) -> Unit) = viewModelScope.launch { c.prefs.update(block) }

    val aiSettings = MutableStateFlow<AiSettings?>(null)
    val geminiReady = MutableStateFlow<Boolean?>(null)
    val models = MutableStateFlow<List<String>>(emptyList())
    val devices = MutableStateFlow<List<DeviceInfo>>(emptyList())

    /** API keys for widgets (names and websites only). Missing ones the assistant asked for show as a card. */
    val apiKeys = MutableStateFlow<List<ApiKeyInfo>>(emptyList())
    val dismissedKeyRequests = MutableStateFlow<Set<String>>(emptySet())

    fun loadApiKeys() = viewModelScope.launch { runCatching { c.api.apiKeys() }.onSuccess { apiKeys.value = it } }

    /** Returns null on success, or a message to show. */
    suspend fun saveApiKey(name: String, value: String, host: String? = null, service: String? = null): String? {
        val r = runCatching { c.api.saveApiKey(name.trim(), value.trim(), host?.trim()?.ifBlank { null }, service?.trim()?.ifBlank { null }) }
        loadApiKeys()
        return r.exceptionOrNull()?.let { it.message ?: "Couldn't save the key" }
    }

    fun deleteApiKey(name: String) = viewModelScope.launch { runCatching { c.api.deleteApiKey(name) }; loadApiKeys() }

    fun loadAiSettings() = viewModelScope.launch {
        runCatching { c.api.aiSettings() }.onSuccess { (s, ok) -> aiSettings.value = s; geminiReady.value = ok }
        runCatching { c.api.aiModels() }.onSuccess { models.value = it }
    }

    fun saveAiSettings(patch: kotlinx.serialization.json.JsonObject) = viewModelScope.launch {
        runCatching { c.api.putAiSettings(patch) }.onSuccess { aiSettings.value = it; notice("Saved") }.onFailure { notice(it.message ?: "Couldn't save") }
    }

    fun loadDevices() = viewModelScope.launch { runCatching { c.api.devices() }.onSuccess { devices.value = it } }
    fun revokeDevice(id: String) = viewModelScope.launch { runCatching { c.api.revokeDevice(id) }; loadDevices() }

    suspend fun newPairingCode(): String? = runCatching { c.api.newPairingCode()["code"]?.let { (it as JsonPrimitive).content } }.getOrNull()

    fun installModels() { ModelCatalog.ESSENTIAL.forEach { c.models.install(it) } }

    suspend fun backupTo(out: OutputStream): String = try {
        val n = withContext(Dispatchers.IO) { out.use { c.api.downloadFullBackup(it) } }
        "Backup saved (${n / 1_048_576} MB)"
    } catch (e: Exception) { e.message ?: "Backup failed" }

    suspend fun exportBoardTo(id: String, out: OutputStream): String = try {
        withContext(Dispatchers.IO) { out.use { it.write(c.api.exportBoard(id)) } }
        "Board exported"
    } catch (e: Exception) { e.message ?: "Export failed" }

    fun backupOnPi() = viewModelScope.launch { runCatching { c.api.createBackup() }.onSuccess { notice("Backup created on the Pi") }.onFailure { notice(it.message ?: "Backup failed") } }
}
