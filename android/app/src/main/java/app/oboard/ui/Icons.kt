package app.oboard.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/** Single-weight line icons on a 24 px grid, matching web/js/icons.js. */
object OIcons {
    private fun icon(name: String, vararg paths: String, stroke: Float = 1.7f): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
            for (d in paths) {
                addPath(
                    pathData = PathParser().parsePathString(d).toNodes(),
                    stroke = SolidColor(Color.White),
                    strokeLineWidth = stroke,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()

    private fun circle(cx: Float, cy: Float, r: Float) = "M${cx - r},${cy}a$r,$r 0 1,0 ${2 * r},0a$r,$r 0 1,0 ${-2 * r},0"
    private fun rrect(x: Float, y: Float, w: Float, h: Float, r: Float) =
        "M${x + r},${y}h${w - 2 * r}a$r,$r 0 0 1 $r,$r v${h - 2 * r}a$r,$r 0 0 1 ${-r},$r h${-(w - 2 * r)}a$r,$r 0 0 1 ${-r},${-r} v${-(h - 2 * r)}a$r,$r 0 0 1 $r,${-r}z"

    val Mic = icon("mic", rrect(9f, 3.5f, 6f, 11f, 3f), "M6 11.5a6 6 0 0012 0M12 17.5v3M9 20.5h6")
    val Send = icon("send", "M12 19V5M6 11l6-6 6 6")
    val Plus = icon("plus", "M12 5v14M5 12h14")
    val Camera = icon("camera", "M4 8.5a2 2 0 012-2h2l1.5-2h5L16 6.5h2a2 2 0 012 2V17a2 2 0 01-2 2H6a2 2 0 01-2-2z", circle(12f, 12.8f, 3.2f))
    val Image = icon("image", rrect(3.5f, 4.5f, 17f, 15f, 2.5f), circle(9f, 10f, 1.6f), "M20.5 16l-5-5L7 19.5")
    val Attach = icon("attach", "M19.5 11.2l-7.6 7.6a4.8 4.8 0 01-6.8-6.8l8-8a3.2 3.2 0 014.6 4.6l-8 8a1.6 1.6 0 01-2.3-2.3l7.3-7.3")
    val Close = icon("close", "M6 6l12 12M18 6L6 18")
    val Check = icon("check", "M5 12.5l4.5 4.5L19 7.5")
    val Back = icon("back", "M15 5l-7 7 7 7")
    val ChevronRight = icon("chevron-right", "M10 6l6 6-6 6")
    val ChevronDown = icon("chevron-down", "M7 10l5 5 5-5")
    val Search = icon("search", circle(10.5f, 10.5f, 6.5f), "M15.5 15.5L20 20")
    val Settings = icon("settings", "M4 7h9M17 7h3M4 17h3M11 17h9", circle(15f, 7f, 2f), circle(9f, 17f, 2f))
    val Tv = icon("tv", rrect(3f, 5f, 18f, 12f, 2f), "M9 20h6M12 17v3")
    val Layers = icon("layers", "M12 4l8.5 4.5L12 13 3.5 8.5z", "M3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5")
    val Inbox = icon("inbox", "M4 13l2.5-7.5h11L20 13v5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 18z", "M4 13h4.5l1 2h5l1-2H20")
    val Home = icon("home", "M4 11l8-6.5 8 6.5V19a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 19z", "M9.5 20.5v-6h5v6")
    val Bulb = icon("bulb", "M9 18h6M10 21h4", "M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0012 3z")
    val More = icon("more", circle(6f, 12f, 0.9f), circle(12f, 12f, 0.9f), circle(18f, 12f, 0.9f), stroke = 2.2f)
    val Trash = icon("trash", "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7")
    val Undo = icon("undo", "M9 14L4 9l5-5", "M4 9h9.5a6 6 0 010 12H10")
    val Stop = icon("stop", rrect(7f, 7f, 10f, 10f, 2f))
    val Play = icon("play", "M8 5.5v13l10-6.5z")
    val Speaker = icon("speaker", "M4 9.5h3l4.5-4v13L7 14.5H4z", "M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11")
    val Pin = icon("pin", "M9 4h6l-1 5 3 3H7l3-3z", "M12 15v5")
    val Download = icon("download", "M12 4v11M7 10l5 5 5-5M5 20h14")
    val Wave = icon("wave", "M3 12h2M7 8.5v7M11 5v14M15 8.5v7M19 11v2")
    val Fit = icon("fit", "M4 9V5.5A1.5 1.5 0 015.5 4H9M15 4h3.5A1.5 1.5 0 0120 5.5V9M20 15v3.5a1.5 1.5 0 01-1.5 1.5H15M9 20H5.5A1.5 1.5 0 014 18.5V15")
    val Focus = icon("focus", circle(12f, 12f, 3f), "M12 3v3M12 18v3M3 12h3M18 12h3")
    val Edit = icon("edit", "M4 20l1-4.2L16.2 4.6a2 2 0 012.8 0l.4.4a2 2 0 010 2.8L8.2 19z", "M14 7l3 3")
    val Present = icon("present", rrect(3f, 4f, 18f, 12f, 2f), "M12 16v4M8 20h8", "M10 8l4 2-4 2z")
    val Prev = icon("prev", "M15 6l-6 6 6 6")
    val Next = icon("next", "M9 6l6 6-6 6")
    val WifiOff = icon("wifi-off", "M3 3l18 18M8.5 16.5a5 5 0 017 0M5 12.5a10 10 0 015.2-2.8M14.6 9.9A10 10 0 0119 12.5M2 9a15 15 0 015.6-3.4M12 20h.01")
    val Link = icon("link", "M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1", "M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1")
    val Doc = icon("doc", "M6 3.5h8l4 4v13H6z", "M14 3.5v4h4M9 12h6M9 16h6")
    val Canvas = icon("canvas", rrect(3.5f, 3.5f, 17f, 17f, 2.5f), "M7.5 9.5h5M7.5 13h9M7.5 16.5h6")
    val Sparse = icon("dot", circle(12f, 12f, 1.5f))
    val Key = icon("key", circle(8f, 15.5f, 3.5f), "M10.6 13L19 4.5M15.5 8l2.5 2.5M13.3 10.2l2 2")
    val Widget = icon("widget", rrect(3.5f, 4.5f, 17f, 15f, 2.5f), "M7 15.5l3-3.5 2.5 2 4.5-5.5")
}
