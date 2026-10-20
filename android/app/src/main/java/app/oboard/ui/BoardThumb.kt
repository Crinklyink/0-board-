package app.oboard.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import app.oboard.data.BoardPreview

// Same order as PREVIEW_KINDS on the server and the board palette in web/js/theme.js.
private val KINDS = listOf("note", "text", "shape", "frame", "image", "widget", "link", "file", "draw")
private val FILL = listOf(0xFF101E30, 0xFF12263D, 0xFF0F2B30, 0xFF112B20, 0xFF2B2511, 0xFF2F1E12, 0xFF2E1718, 0xFF201B35, 0xFF0C1624)
private val STROKE = listOf(0xFF2A4160, 0xFF3F6E9E, 0xFF34858C, 0xFF3F7F5C, 0xFFA68B3B, 0xFFB46D3B, 0xFFB45150, 0xFF7D61B2, 0xFF3B4B60)

/** A small drawing of a board's layout: what is where, in its colours. Empty boards show a quiet dotted grid. */
@Composable
fun BoardThumb(preview: BoardPreview?, modifier: Modifier = Modifier) {
    Box(modifier.clip(RoundedCornerShape(10.dp)).background(O.Bg).border(1.dp, O.Border, RoundedCornerShape(10.dp))) {
        Canvas(Modifier.matchParentSize()) {
            val pad = 6.dp.toPx()
            val aw = size.width - pad * 2
            val ah = size.height - pad * 2
            if (preview == null || preview.b.isEmpty()) {
                val step = 9.dp.toPx()
                var y = pad
                while (y < size.height - pad / 2) {
                    var x = pad
                    while (x < size.width - pad / 2) { drawCircle(O.Border, 0.9.dp.toPx(), Offset(x, y)); x += step }
                    y += step
                }
                return@Canvas
            }
            // Fit the content's aspect ratio inside the thumbnail and centre it.
            val aspect = preview.a.coerceIn(0.2f, 6f)
            val w: Float; val h: Float
            if (aw / ah > aspect) { h = ah; w = ah * aspect } else { w = aw; h = aw / aspect }
            val ox = pad + (aw - w) / 2
            val oy = pad + (ah - h) / 2
            val r = CornerRadius(2.dp.toPx())
            for (box in preview.b) {
                if (box.size < 6) continue
                val tl = Offset(ox + box[0] * w, oy + box[1] * h)
                val sz = Size((box[2] * w).coerceAtLeast(1.5f), (box[3] * h).coerceAtLeast(1.5f))
                val kind = KINDS.getOrElse(box[4].toInt()) { "note" }
                val c = box[5].toInt().coerceIn(0, FILL.lastIndex)
                when (kind) {
                    "frame" -> drawRoundRect(Color(STROKE[8]).copy(alpha = 0.7f), tl, sz, CornerRadius(3.dp.toPx()), style = Stroke(1.dp.toPx()))
                    "widget" -> {
                        drawRoundRect(Color(0xFF0B1626), tl, sz, r)
                        drawRoundRect(O.Accent.copy(alpha = 0.8f), tl, sz, r, style = Stroke(1.dp.toPx()))
                    }
                    "image" -> drawRoundRect(Color(0xFF2A3A50), tl, sz, r)
                    "text" -> drawRoundRect(Color(STROKE[c]).copy(alpha = 0.45f), Offset(tl.x, tl.y + sz.height * 0.3f), Size(sz.width, sz.height * 0.4f), r)
                    "draw" -> drawRoundRect(Color(STROKE[c]).copy(alpha = 0.35f), tl, sz, r, style = Stroke(1.dp.toPx()))
                    else -> {
                        drawRoundRect(Color(FILL[c]), tl, sz, r)
                        drawRoundRect(Color(STROKE[c]), tl, sz, r, style = Stroke(0.8.dp.toPx()))
                    }
                }
            }
        }
    }
}
