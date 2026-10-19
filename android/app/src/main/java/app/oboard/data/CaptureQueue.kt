package app.oboard.data

import android.content.Context
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import java.io.File
import java.io.IOException
import java.util.UUID

@Serializable
data class QueuedFile(val path: String, val mime: String, val name: String)

@Serializable
data class QueuedCapture(
    val id: String,
    val boardId: String,
    val text: String? = null,
    val files: List<QueuedFile> = emptyList(),
    val source: String = "capture",
    val createdAt: Long = System.currentTimeMillis(),
    val attempts: Int = 0,
    val error: String? = null,
)

/** A capture that reached the Pi, kept briefly so the capture screen can show "saved". */
data class CaptureReceipt(val id: String, val boardId: String, val text: String?, val fileCount: Int, val at: Long, val objectIds: List<String>)

/**
 * Quick Capture never waits on the network. Every capture is written to disk first (files copied into app storage),
 * then delivered in the background. If the Pi is unreachable the item simply stays queued and is retried when the
 * connection comes back. Delivery is idempotent: the server dedupes on the capture id.
 */
class CaptureQueue(private val ctx: Context, private val api: Api, private val scope: CoroutineScope) {
    private val dir = File(ctx.filesDir, "capture-queue").apply { mkdirs() }
    private val filesDir = File(dir, "files").apply { mkdirs() }
    private val lock = Mutex()
    private val _items = MutableStateFlow(load())
    val items: StateFlow<List<QueuedCapture>> = _items.asStateFlow()
    private val _receipts = MutableStateFlow<List<CaptureReceipt>>(emptyList())
    val receipts: StateFlow<List<CaptureReceipt>> = _receipts.asStateFlow()
    @Volatile private var flushing = false

    private fun load(): List<QueuedCapture> = dir.listFiles { f -> f.extension == "json" }.orEmpty().mapNotNull { f ->
        runCatching { AppJson.decodeFromString(QueuedCapture.serializer(), f.readText()) }.getOrNull()
    }.sortedBy { it.createdAt }

    private fun persist(item: QueuedCapture) {
        val tmp = File(dir, "${item.id}.json.tmp")
        tmp.writeText(AppJson.encodeToString(QueuedCapture.serializer(), item))
        tmp.renameTo(File(dir, "${item.id}.json"))
    }

    /** Save locally right now; returns as soon as the capture is safe on disk. */
    suspend fun add(boardId: String, text: String?, uris: List<Uri>, source: String): QueuedCapture = withContext(Dispatchers.IO) {
        val id = "cap-" + UUID.randomUUID().toString().replace("-", "").take(20)
        val files = uris.mapIndexed { i, uri ->
            val p = ImagePrep.prepare(ctx, uri)
            val f = File(filesDir, "$id-$i")
            f.writeBytes(p.bytes)
            QueuedFile(f.absolutePath, p.mime, p.name)
        }
        val item = QueuedCapture(id = id, boardId = boardId, text = text?.trim()?.takeIf { it.isNotEmpty() }, files = files, source = source)
        lock.withLock {
            persist(item)
            _items.value = _items.value + item
        }
        flush()
        item
    }

    /** Deliver queued captures. Safe to call often; only one flush runs at a time. */
    fun flush() {
        if (flushing || api.token.isBlank()) return
        flushing = true
        scope.launch(Dispatchers.IO) {
            try {
                for (item in _items.value.toList()) {
                    if (!deliver(item)) break
                }
            } finally {
                flushing = false
            }
        }
    }

    private suspend fun deliver(item: QueuedCapture): Boolean {
        return try {
            val assetIds = item.files.map { f ->
                val file = File(f.path)
                if (!file.exists()) throw IllegalStateException("Attachment missing")
                api.upload(file.readBytes(), f.mime, f.name).id
            }
            val res = api.capture(item.boardId, item.text, assetIds, item.id, item.source)
            val created = (res["created"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull {
                (it as? kotlinx.serialization.json.JsonObject)?.get("id")?.let { id -> (id as kotlinx.serialization.json.JsonPrimitive).content }
            } ?: emptyList()
            remove(item)
            _receipts.value = (listOf(CaptureReceipt(item.id, item.boardId, item.text, item.files.size, System.currentTimeMillis(), created)) + _receipts.value).take(30)
            true
        } catch (e: ApiException) {
            if (e.status == 401 || e.status == 429 || e.status >= 500) { mark(item, e.message); false }
            else {
                // The Pi rejected this capture for good (e.g. unsupported file). Keep it visible with the reason; skip it.
                mark(item, e.message, attemptsBump = 100)
                true
            }
        } catch (e: IOException) {
            mark(item, null)
            false // offline; try again later
        } catch (e: Exception) {
            Log.w("CaptureQueue", "capture failed", e)
            mark(item, e.message, attemptsBump = 100)
            true
        }
    }

    private suspend fun mark(item: QueuedCapture, error: String?, attemptsBump: Int = 1) = lock.withLock {
        val updated = item.copy(attempts = item.attempts + attemptsBump, error = error)
        persist(updated)
        _items.value = _items.value.map { if (it.id == item.id) updated else it }
    }

    private suspend fun remove(item: QueuedCapture) = lock.withLock {
        File(dir, "${item.id}.json").delete()
        item.files.forEach { File(it.path).delete() }
        _items.value = _items.value.filterNot { it.id == item.id }
    }

    suspend fun discard(id: String) {
        _items.value.find { it.id == id }?.let { remove(it) }
    }
}
