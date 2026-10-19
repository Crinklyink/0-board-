package app.oboard.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

data class PreparedFile(val bytes: ByteArray, val mime: String, val name: String)

/**
 * Turns whatever the user picked (camera photo, gallery image, document) into bytes that are sensible to send to
 * the Pi: photos are rotated upright, scaled to at most 2048 px on the long side and re-encoded as JPEG.
 */
object ImagePrep {
    private const val MAX_SIDE = 2048
    private const val MAX_BYTES = 40L * 1024 * 1024

    fun prepare(ctx: Context, uri: Uri): PreparedFile {
        val cr = ctx.contentResolver
        val mime = cr.getType(uri) ?: guessMime(uri.toString())
        val name = displayName(ctx, uri) ?: "file"
        if (mime.startsWith("image/") && mime != "image/gif") {
            val src = ImageDecoder.createSource(cr, uri)
            val bmp = ImageDecoder.decodeBitmap(src) { decoder, info, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                val w = info.size.width
                val h = info.size.height
                val scale = MAX_SIDE.toFloat() / max(w, h)
                if (scale < 1f) decoder.setTargetSize((w * scale).roundToInt(), (h * scale).roundToInt())
            }
            val out = ByteArrayOutputStream()
            val png = mime == "image/png" && bmp.width * bmp.height < 1_500_000
            bmp.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 86, out)
            bmp.recycle()
            val base = name.substringBeforeLast('.')
            return PreparedFile(out.toByteArray(), if (png) "image/png" else "image/jpeg", if (png) "$base.png" else "$base.jpg")
        }
        val bytes = cr.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream()
            val buf = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                total += n
                if (total > MAX_BYTES) throw IllegalArgumentException("That file is larger than 40 MB")
                out.write(buf, 0, n)
            }
            out.toByteArray()
        } ?: throw IllegalArgumentException("Could not read that file")
        return PreparedFile(bytes, normalizeMime(mime), name)
    }

    fun displayName(ctx: Context, uri: Uri): String? = runCatching {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }.getOrNull() ?: uri.lastPathSegment

    private fun normalizeMime(m: String) = when (m) {
        "audio/x-m4a", "audio/m4a" -> "audio/mp4"
        "audio/x-wav" -> "audio/wav"
        else -> m
    }

    private fun guessMime(s: String) = when (s.substringAfterLast('.').lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"; "png" -> "image/png"; "webp" -> "image/webp"; "pdf" -> "application/pdf"
        "txt" -> "text/plain"; "md" -> "text/markdown"; "m4a" -> "audio/mp4"; "mp3" -> "audio/mpeg"
        else -> "application/octet-stream"
    }
}
