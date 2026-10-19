package app.oboard.voice

import android.content.Context
import android.os.StatFs
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext

sealed interface ModelState {
    data object Missing : ModelState
    data class Downloading(val done: Long, val total: Long) : ModelState {
        val fraction get() = if (total > 0) done.toFloat() / total else 0f
    }
    data class Unpacking(val files: Int) : ModelState
    data object Ready : ModelState
    data class Failed(val message: String) : ModelState
}

/**
 * Downloads speech models after install (they are far too big for the APK), resumes interrupted downloads with
 * HTTP Range, verifies SHA-256, and unpacks archives. A model only counts as installed once a `.ready` marker exists,
 * so a crash halfway through never leaves a half-model that the engine tries to load.
 */
class ModelStore(private val ctx: Context, http: OkHttpClient, private val scope: CoroutineScope) {
    private val http = http.newBuilder().readTimeout(60, TimeUnit.SECONDS).callTimeout(0, TimeUnit.MILLISECONDS).build()
    private val root = File(ctx.filesDir, "models").apply { mkdirs() }
    private val states = ModelCatalog.ALL.associate { it.id to MutableStateFlow(initial(it)) }
    private val jobs = mutableMapOf<String, Job>()

    init {
        // Housekeeping: remove models from older app versions that the catalog no longer uses.
        val known = ModelCatalog.ALL.map { it.id }.toSet()
        root.listFiles()?.filter { it.isDirectory && !it.name.startsWith(".") && it.name !in known }?.forEach { it.deleteRecursively() }
        File(root, ".dl").listFiles()?.filter { f -> known.none { f.name.startsWith(it) } }?.forEach { it.deleteRecursively() }
    }

    fun dir(spec: ModelSpec) = File(root, spec.id)

    /** Bytes already on disk from an interrupted download (for a "Resume" button). */
    fun partialBytes(spec: ModelSpec): Long {
        if (spec.archive != null) return File(root, ".dl/${spec.id}.tar.bz2").length()
        val target = dir(spec)
        return spec.files.sumOf { f ->
            val done = File(target, f.path)
            if (done.exists()) done.length() else File(root, ".dl/${spec.id}/${f.path}").length()
        }
    }
    fun state(spec: ModelSpec): StateFlow<ModelState> = states.getValue(spec.id).asStateFlow()
    fun isReady(spec: ModelSpec) = File(dir(spec), ".ready").exists()

    private fun initial(spec: ModelSpec): ModelState = if (File(File(root, spec.id), ".ready").exists()) ModelState.Ready else ModelState.Missing

    fun freeBytes(): Long = StatFs(ctx.filesDir.path).availableBytes

    fun install(spec: ModelSpec) {
        if (jobs[spec.id]?.isActive == true || isReady(spec)) return
        val flow = states.getValue(spec.id)
        jobs[spec.id] = scope.launch(Dispatchers.IO) {
            try {
                val need = spec.downloadBytes * (if (spec.archive != null) 2 else 1)
                if (freeBytes() < need + 200L * 1024 * 1024) throw IOException("Not enough storage: needs about ${need / 1_048_576} MB free")
                val target = dir(spec).apply { mkdirs() }
                if (spec.archive != null) {
                    val tmp = File(root, ".dl/${spec.id}.tar.bz2")
                    download(spec.archive.url, tmp, spec.archive.size, spec.archive.sha256) { d -> flow.value = ModelState.Downloading(d, spec.archive.size) }
                    flow.value = ModelState.Unpacking(0)
                    untar(tmp, target, spec.archive.strip) { n -> flow.value = ModelState.Unpacking(n) }
                    tmp.delete()
                } else {
                    var base = 0L
                    for (f in spec.files) {
                        val out = File(target, f.path)
                        if (!(out.exists() && out.length() == f.size)) {
                            val part = File(root, ".dl/${spec.id}/${f.path}")
                            download(f.url, part, f.size, f.sha256) { d -> flow.value = ModelState.Downloading(base + d, spec.downloadBytes) }
                            out.parentFile?.mkdirs()
                            if (!part.renameTo(out)) { part.copyTo(out, overwrite = true); part.delete() }
                        }
                        base += f.size
                    }
                }
                File(target, ".ready").writeText(spec.id)
                flow.value = ModelState.Ready
            } catch (e: Exception) {
                coroutineContext.ensureActive()
                Log.w("ModelStore", "install ${spec.id} failed", e)
                flow.value = ModelState.Failed(e.message ?: "Download failed")
            }
        }
    }

    fun cancel(spec: ModelSpec) {
        jobs.remove(spec.id)?.cancel()
        states.getValue(spec.id).value = if (isReady(spec)) ModelState.Ready else ModelState.Missing
    }

    fun delete(spec: ModelSpec) {
        cancel(spec)
        dir(spec).deleteRecursively()
        File(root, ".dl/${spec.id}").deleteRecursively()
        File(root, ".dl/${spec.id}.tar.bz2").delete()
        states.getValue(spec.id).value = ModelState.Missing
    }

    /** Resumable download into [dest]; verifies size and (if known) SHA-256 over the complete file. */
    private suspend fun download(url: String, dest: File, size: Long, sha256: String?, progress: (Long) -> Unit) {
        dest.parentFile?.mkdirs()
        if (dest.exists() && dest.length() > size) dest.delete()
        var have = if (dest.exists()) dest.length() else 0L
        if (have < size) {
            val req = Request.Builder().url(url).apply { if (have > 0) header("Range", "bytes=$have-") }.build()
            http.newCall(req).execute().use { res ->
                if (res.code == 200 && have > 0) { have = 0; dest.delete() } // server ignored Range; start over
                if (!(res.code == 200 || res.code == 206)) throw IOException("Download failed (HTTP ${res.code})")
                val body = res.body ?: throw IOException("Empty response")
                RandomAccessFile(dest, "rw").use { raf ->
                    raf.seek(have)
                    val buf = ByteArray(256 * 1024)
                    var last = 0L
                    body.byteStream().use { input ->
                        while (true) {
                            coroutineContext.ensureActive()
                            val n = input.read(buf)
                            if (n < 0) break
                            raf.write(buf, 0, n)
                            have += n
                            if (have - last > 1_048_576) { progress(have); last = have }
                        }
                    }
                }
            }
        }
        progress(have)
        if (dest.length() != size) throw IOException("Download incomplete (${dest.length()} of $size bytes); try again to resume")
        if (sha256 != null) {
            val md = MessageDigest.getInstance("SHA-256")
            dest.inputStream().buffered(1 shl 20).use { input ->
                val buf = ByteArray(1 shl 20)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                }
            }
            val got = md.digest().joinToString("") { "%02x".format(it) }
            if (!got.equals(sha256, ignoreCase = true)) {
                dest.delete()
                throw IOException("Checksum mismatch; the file was corrupted in transit. Try again.")
            }
        }
    }

    private suspend fun untar(archive: File, target: File, strip: String, progress: (Int) -> Unit) {
        var count = 0
        TarArchiveInputStream(BZip2CompressorInputStream(BufferedInputStream(archive.inputStream(), 1 shl 20))).use { tar ->
            while (true) {
                coroutineContext.ensureActive()
                val e = tar.nextEntry ?: break
                var name = e.name.removePrefix("./")
                if (name.startsWith("$strip/")) name = name.removePrefix("$strip/")
                if (name.isEmpty()) continue
                val out = File(target, name).canonicalFile
                if (!out.path.startsWith(target.canonicalPath)) throw IOException("Unsafe path in archive")
                if (e.isDirectory) { out.mkdirs(); continue }
                out.parentFile?.mkdirs()
                FileOutputStream(out).use { tar.copyTo(it, 1 shl 16) }
                if (++count % 20 == 0) progress(count)
            }
        }
        progress(count)
    }
}
