package app.oboard.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.oboard.data.Link

@Composable
fun OIconButton(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, tint: Color = O.Text2, enabled: Boolean = true, size: Dp = 44.dp, background: Color = Color.Transparent) {
    Box(
        modifier
            .size(size)
            .clip(RoundedCornerShape(11.dp))
            .background(background)
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = label, interactionSource = remember { MutableInteractionSource() }, indication = ripple()) { onClick() }
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, Modifier.size(21.dp), tint = if (enabled) tint else tint.copy(alpha = 0.35f))
    }
}

enum class BtnKind { Primary, Secondary, Ghost, Danger }

@Composable
fun OButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, kind: BtnKind = BtnKind.Secondary, icon: ImageVector? = null, enabled: Boolean = true, loading: Boolean = false) {
    val (bg, fg, border) = when (kind) {
        BtnKind.Primary -> Triple(O.Accent, O.Bg, O.Accent)
        BtnKind.Secondary -> Triple(O.Surface, O.Text, O.Border)
        BtnKind.Ghost -> Triple(Color.Transparent, O.Text2, Color.Transparent)
        BtnKind.Danger -> Triple(Color(0x22C0605E), O.DangerText, Color(0x55C0605E))
    }
    Row(
        modifier
            .heightIn(min = 46.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (enabled) bg else bg.copy(alpha = 0.4f))
            .border(1.dp, border, RoundedCornerShape(12.dp))
            .clickable(enabled = enabled && !loading, role = Role.Button) { onClick() }
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(16.dp), color = fg, strokeWidth = 2.dp)
            Spacer(Modifier.width(10.dp))
        } else if (icon != null) {
            Icon(icon, null, Modifier.size(18.dp), tint = fg)
            Spacer(Modifier.width(8.dp))
        }
        Text(text, style = MaterialTheme.typography.labelLarge, color = fg, maxLines = 1, softWrap = false)
    }
}

@Composable
fun OCard(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, padding: PaddingValues = PaddingValues(16.dp), content: @Composable () -> Unit) {
    Box(
        modifier
            .clip(RoundedCornerShape(16.dp))
            .background(O.Bg2)
            .border(1.dp, O.Border, RoundedCornerShape(16.dp))
            .then(if (onClick != null) Modifier.clickable(role = Role.Button) { onClick() } else Modifier)
            .padding(padding),
    ) { content() }
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(), modifier.padding(top = 18.dp, bottom = 8.dp), style = MaterialTheme.typography.labelSmall, color = O.Text3)
}

@Composable
fun ConnectionBadge(link: Link, tvOnline: Boolean, queued: Int, modifier: Modifier = Modifier) {
    val (color, text) = when {
        link == Link.Unauthorized -> O.Danger to "Not paired"
        link != Link.Online -> O.Warn to (if (queued > 0) "Offline · $queued waiting" else if (link == Link.Connecting) "Connecting" else "Offline")
        queued > 0 -> O.Accent to "Sending $queued"
        tvOnline -> O.Ok to "TV on"
        else -> O.Text3 to "TV off"
    }
    Row(modifier.semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(7.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = O.Text2)
    }
}

@Composable
fun Segmented(options: List<String>, selected: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier
            .clip(RoundedCornerShape(12.dp))
            .background(O.Bg2)
            .border(1.dp, O.Border, RoundedCornerShape(12.dp))
            .padding(3.dp),
    ) {
        options.forEachIndexed { i, label ->
            val on = i == selected
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 38.dp)
                    .clip(RoundedCornerShape(9.dp))
                    .background(if (on) O.Surface else Color.Transparent)
                    .clickable(role = Role.Tab) { onSelect(i) },
                contentAlignment = Alignment.Center,
            ) {
                Text(label, style = MaterialTheme.typography.labelLarge, color = if (on) O.Text else O.Text2)
            }
        }
    }
}

@Composable
fun OTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    singleLine: Boolean = false,
    minLines: Int = 1,
    maxLines: Int = 6,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    textStyle: TextStyle = MaterialTheme.typography.bodyLarge,
    framed: Boolean = true,
) {
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier,
        singleLine = singleLine,
        minLines = minLines,
        maxLines = if (singleLine) 1 else maxLines,
        textStyle = textStyle.copy(color = O.Text),
        cursorBrush = SolidColor(O.AccentHi),
        keyboardOptions = keyboardOptions,
        keyboardActions = keyboardActions,
        decorationBox = { inner ->
            Box(
                Modifier.fillMaxWidth().then(if (framed) Modifier.clip(RoundedCornerShape(12.dp)).background(O.Bg).border(1.dp, O.Border, RoundedCornerShape(12.dp)).padding(horizontal = 14.dp, vertical = 12.dp) else Modifier),
            ) {
                if (value.isEmpty()) Text(placeholder, style = textStyle, color = O.Text3)
                inner()
            }
        },
    )
}

@Composable
fun RowItem(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    icon: ImageVector? = null,
    onClick: (() -> Unit)? = null,
    trailing: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(RoundedCornerShape(12.dp))
            .then(if (onClick != null) Modifier.clickable(role = Role.Button) { onClick() } else Modifier)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Box(Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(O.Surface), contentAlignment = Alignment.Center) {
                Icon(icon, null, Modifier.size(19.dp), tint = O.Text2)
            }
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = O.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = O.Text2, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        trailing()
    }
}

@Composable
fun ToggleRow(title: String, subtitle: String?, checked: Boolean, onChange: (Boolean) -> Unit, enabled: Boolean = true) {
    RowItem(title, subtitle = subtitle, onClick = if (enabled) ({ onChange(!checked) }) else null) {
        Spacer(Modifier.width(12.dp))
        Switch(
            checked = checked, onCheckedChange = if (enabled) onChange else null, enabled = enabled,
            colors = SwitchDefaults.colors(
                checkedThumbColor = O.Bg, checkedTrackColor = O.Accent, uncheckedThumbColor = O.Text2,
                uncheckedTrackColor = O.Surface, uncheckedBorderColor = O.Border,
            ),
        )
    }
}

@Composable
fun ProgressBar(fraction: Float, modifier: Modifier = Modifier) {
    val f by animateFloatAsState(fraction.coerceIn(0f, 1f), tween(250), label = "progress")
    Box(modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(O.Surface)) {
        Box(Modifier.fillMaxWidth(f).height(4.dp).clip(RoundedCornerShape(2.dp)).background(O.Accent))
    }
}

enum class MicLook { Idle, Listening, Busy, Speaking, Live, Disabled }

/**
 * Hold to talk, or tap once to start and again to stop. Sliding up while holding cancels.
 * While the assistant is speaking, a tap interrupts it.
 */
@Composable
fun MicButton(
    look: MicLook,
    level: Float,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onCancel: () -> Unit,
    onInterrupt: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 64.dp,
) {
    val haptics = LocalHapticFeedback.current
    val start by rememberUpdatedState(onStart)
    val stop by rememberUpdatedState(onStop)
    val cancel by rememberUpdatedState(onCancel)
    val interrupt by rememberUpdatedState(onInterrupt)
    val currentLook by rememberUpdatedState(look)
    val ring by animateFloatAsState(if (look == MicLook.Listening || look == MicLook.Live) 1f + level * 0.55f else 1f, tween(90), label = "ring")
    val bg = when (look) {
        MicLook.Listening, MicLook.Live -> O.AccentHi
        MicLook.Disabled -> O.Surface
        MicLook.Speaking -> O.Surface
        else -> O.Accent
    }
    val desc = when (look) {
        MicLook.Listening -> "Listening. Release to send."
        MicLook.Speaking -> "Stop the assistant"
        MicLook.Live -> "End live conversation"
        MicLook.Busy -> "Working"
        else -> "Hold to talk"
    }
    Box(
        modifier
            .size(size)
            .drawBehind {
                if (ring > 1.01f) drawCircle(O.AccentHi.copy(alpha = 0.18f), radius = this.size.minDimension / 2 * ring)
            }
            .clip(CircleShape)
            .background(bg)
            .semantics {
                contentDescription = desc
                onClick { if (currentLook == MicLook.Listening) stop() else if (currentLook == MicLook.Speaking) interrupt() else start(); true }
            }
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown()
                    val l = currentLook
                    if (l == MicLook.Disabled) return@awaitEachGesture
                    if (l == MicLook.Speaking) { interrupt(); haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove); return@awaitEachGesture }
                    if (l == MicLook.Listening || l == MicLook.Live) { stop(); haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove); return@awaitEachGesture }
                    val t0 = System.currentTimeMillis()
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    start()
                    var cancelled = false
                    val y0 = down.position.y
                    while (true) {
                        val ev = awaitPointerEvent()
                        val ch = ev.changes.firstOrNull { it.id == down.id } ?: break
                        if (y0 - ch.position.y > 140.dp.toPx()) cancelled = true
                        ch.consume()
                        if (!ch.pressed) break
                    }
                    val held = System.currentTimeMillis() - t0
                    when {
                        cancelled -> { cancel(); haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove) }
                        held < 280 -> Unit // a tap: keep listening until the next tap
                        else -> stop()
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        when (look) {
            MicLook.Busy -> CircularProgressIndicator(Modifier.size(size * 0.38f), color = O.Bg, strokeWidth = 2.5.dp)
            MicLook.Speaking -> Icon(OIcons.Stop, null, Modifier.size(size * 0.36f), tint = O.Text)
            MicLook.Live -> Icon(OIcons.Wave, null, Modifier.size(size * 0.4f), tint = O.Bg)
            else -> Icon(OIcons.Mic, null, Modifier.size(size * 0.4f), tint = if (look == MicLook.Disabled) O.Text3 else O.Bg)
        }
    }
}

@Composable
fun EmptyState(title: String, body: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Column(modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = O.Text2)
        Spacer(Modifier.height(6.dp))
        Text(body, style = MaterialTheme.typography.bodyMedium, color = O.Text3, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        if (action != null) { Spacer(Modifier.height(16.dp)); action() }
    }
}

@Composable
fun Pill(text: String, modifier: Modifier = Modifier, color: Color = O.Text2, bg: Color = O.Surface) {
    Text(
        text,
        modifier.clip(RoundedCornerShape(8.dp)).background(bg).padding(horizontal = 8.dp, vertical = 3.dp),
        style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.W600),
        color = color,
    )
}
