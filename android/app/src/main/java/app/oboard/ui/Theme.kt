package app.oboard.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.oboard.R

/** Same tokens as web/css/app.css so the phone and the TV feel like one product. */
object O {
    val Bg = Color(0xFF05070C)
    val Bg2 = Color(0xFF091321)
    val Surface = Color(0xFF101E30)
    val SurfaceHi = Color(0xFF16293F)
    val Border = Color(0xFF203348)
    val BorderHi = Color(0xFF2D4660)
    val Text = Color(0xFFE5EDF5)
    val Text2 = Color(0xFF8D9FB4)
    val Text3 = Color(0xFF5C6F85)
    val Accent = Color(0xFF5689BA)
    val AccentHi = Color(0xFF6FA0D1)
    val AccentSoft = Color(0x2E5689BA)
    val Danger = Color(0xFFC0605E)
    val DangerText = Color(0xFFF2B1AF)
    val Ok = Color(0xFF4E9E7A)
    val Warn = Color(0xFFC79A4A)
}

val Inter = FontFamily(
    Font(R.font.inter_variable, FontWeight.W400),
    Font(R.font.inter_variable, FontWeight.W500),
    Font(R.font.inter_variable, FontWeight.W600),
    Font(R.font.inter_variable, FontWeight.W700),
)

private fun style(size: Int, weight: Int, line: Int, track: Double = 0.0) = TextStyle(
    fontFamily = Inter, fontSize = size.sp, fontWeight = FontWeight(weight), lineHeight = line.sp, letterSpacing = track.sp,
)

val OTypography = Typography(
    headlineSmall = style(24, 650, 30, -0.3),
    titleLarge = style(20, 650, 26, -0.2),
    titleMedium = style(17, 600, 23, -0.1),
    titleSmall = style(15, 600, 20),
    bodyLarge = style(16, 450, 24),
    bodyMedium = style(15, 450, 22),
    bodySmall = style(13, 450, 18),
    labelLarge = style(14, 560, 18),
    labelMedium = style(13, 550, 16),
    labelSmall = style(11, 650, 14, 0.7),
)

@Composable
fun OBoardTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = O.Accent, onPrimary = O.Bg, primaryContainer = O.AccentSoft, onPrimaryContainer = O.AccentHi,
            secondary = O.Text2, onSecondary = O.Bg,
            background = O.Bg, onBackground = O.Text, surface = O.Bg2, onSurface = O.Text, surfaceVariant = O.Surface,
            onSurfaceVariant = O.Text2, surfaceContainer = O.Bg2, surfaceContainerHigh = O.Surface, surfaceContainerHighest = O.SurfaceHi,
            surfaceContainerLow = O.Bg2, surfaceContainerLowest = O.Bg, outline = O.Border, outlineVariant = O.Border,
            error = O.Danger, onError = O.Bg, scrim = Color(0xCC020408),
        ),
        typography = OTypography,
        shapes = Shapes(
            extraSmall = RoundedCornerShape(6.dp), small = RoundedCornerShape(9.dp), medium = RoundedCornerShape(12.dp),
            large = RoundedCornerShape(16.dp), extraLarge = RoundedCornerShape(22.dp),
        ),
        content = content,
    )
}
