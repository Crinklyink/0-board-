package app.oboard.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Full-screen canvas for one board. On the unfolded Fold the conversation docks beside it. */
@Composable
fun CanvasScreen(vm: AppViewModel, boardId: String, onClose: () -> Unit) {
    val s by vm.settings.collectAsState()
    val boards by vm.boards.collectAsState()
    val link by vm.link.collectAsState()
    val tvOnline by vm.tvOnline.collectAsState()
    val queued by vm.queued.collectAsState()
    val voice by vm.voiceState.collectAsState()
    val live by vm.liveState.collectAsState()
    val sending by vm.sending.collectAsState()
    val level by vm.c.mic.level.collectAsState()
    val controller = remember { WebController() }
    val expanded = LocalConfiguration.current.screenWidthDp >= 760
    var panel by rememberSaveable { mutableStateOf(true) }
    var menu by remember { mutableStateOf(false) }
    var currentBoard by rememberSaveable { mutableStateOf(boardId) }
    val density = LocalDensity.current
    val topInset = with(density) { WindowInsets.statusBars.getTop(this).toDp().value.toInt() }
    val bottomInset = with(density) { WindowInsets.navigationBars.getBottom(this).toDp().value.toInt() }
    val name = boards.find { it.id == currentBoard }?.name ?: ""
    val startMic = rememberMicPermission(vm) { vm.micStart() }
    val liveMode = s.voiceEngine == "live"

    BackHandler { onClose() }
    // While this board is open, the assistant works on it.
    DisposableEffect(currentBoard) {
        val before = vm.pinnedAiBoard.value
        vm.pinnedAiBoard.value = currentBoard
        onDispose { vm.pinnedAiBoard.value = before }
    }

    Row(Modifier.fillMaxSize().background(O.Bg)) {
        Box(Modifier.weight(1f).fillMaxHeight()) {
            BoardWebView(
                mode = "edit", boardId = currentBoard, serverUrl = s.serverUrl, token = s.token, deviceName = s.deviceName,
                controller = controller, modifier = Modifier.fillMaxSize(),
            ) { e ->
                when (e.type) {
                    "ready" -> controller.insets(topInset + 56, bottomInset)
                    "board" -> e.data.optString("id").takeIf { it.isNotBlank() }?.let { currentBoard = it }
                }
            }
            // top bar
            Row(
                Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.statusBars).padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OIconButton(OIcons.Back, "Back", onClose, background = O.Bg2.copy(alpha = 0.92f))
                Spacer(Modifier.width(8.dp))
                Column(
                    Modifier.weight(1f, fill = false).clip(RoundedCornerShape(12.dp)).background(O.Bg2.copy(alpha = 0.92f)).border(1.dp, O.Border, RoundedCornerShape(12.dp)).padding(horizontal = 12.dp, vertical = 6.dp),
                ) {
                    Text(name, style = MaterialTheme.typography.titleSmall, color = O.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    ConnectionBadge(link, tvOnline, queued.size)
                }
                Spacer(Modifier.weight(1f))
                Box {
                    OIconButton(OIcons.More, "More", { menu = true }, background = O.Bg2.copy(alpha = 0.92f))
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = O.Bg2) {
                        DropdownMenuItem(text = { Text("Show on TV", color = O.Text) }, onClick = { menu = false; vm.showOnTv(currentBoard) })
                        DropdownMenuItem(text = { Text("Search", color = O.Text) }, onClick = { menu = false; controller.search() })
                        DropdownMenuItem(text = { Text("Fit everything", color = O.Text) }, onClick = { menu = false; controller.fit() })
                        DropdownMenuItem(text = { Text("Add image or file", color = O.Text) }, onClick = { menu = false; controller.pickFile() })
                        if (expanded) DropdownMenuItem(text = { Text(if (panel) "Hide conversation" else "Show conversation", color = O.Text) }, onClick = { menu = false; panel = !panel })
                    }
                }
            }
            // voice: listening/transcript overlay and the mic
            Column(
                Modifier.align(Alignment.BottomEnd).windowInsetsPadding(WindowInsets.safeDrawing).padding(end = 14.dp, bottom = 74.dp),
                horizontalAlignment = Alignment.End,
            ) {
                Box(Modifier.width(320.dp).clip(RoundedCornerShape(14.dp)).background(O.Bg2.copy(alpha = 0.94f))) { VoiceStrip(vm) }
                Spacer(Modifier.size(10.dp))
                MicButton(
                    look = micLook(voice, live, liveMode, sending), level = level,
                    onStart = startMic,
                    onStop = { if (liveMode) vm.toggleLive() else vm.micStop(talk = true) },
                    onCancel = { vm.micCancel() },
                    onInterrupt = { vm.interruptVoice() },
                )
            }
        }
        AnimatedVisibility(expanded && panel) {
            Column(Modifier.width(380.dp).fillMaxHeight().background(O.Bg).windowInsetsPadding(WindowInsets.safeDrawing).imePadding()) {
                Row(Modifier.fillMaxWidth().padding(16.dp, 12.dp, 8.dp, 0.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Conversation", style = MaterialTheme.typography.titleSmall, color = O.Text, modifier = Modifier.weight(1f))
                    OIconButton(OIcons.Close, "Hide conversation", { panel = false })
                }
                CaptureScreen(vm, Modifier.weight(1f), showHeader = false)
            }
        }
    }
}

/** Your phone as the TV's remote: a live mirror of what the TV shows, plus presentation and focus controls. */
@Composable
fun RemoteScreen(vm: AppViewModel, modifier: Modifier = Modifier) {
    val s by vm.settings.collectAsState()
    val boards by vm.boards.collectAsState()
    val display by vm.display.collectAsState()
    val tvOnline by vm.tvOnline.collectAsState()
    val voice by vm.voiceState.collectAsState()
    val live by vm.liveState.collectAsState()
    val sending by vm.sending.collectAsState()
    val level by vm.c.mic.level.collectAsState()
    val controller = remember { WebController() }
    var overview by rememberSaveable { mutableStateOf(false) }
    var boardMenu by remember { mutableStateOf(false) }
    val presenting = display?.mode == "present"
    val focused = display?.mode == "focus"
    val startMic = rememberMicPermission(vm) { vm.micStart() }
    val liveMode = s.voiceEngine == "live"
    val expanded = LocalConfiguration.current.screenWidthDp >= 760

    val controls: @Composable () -> Unit = {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            OIconButton(OIcons.Fit, "Show the whole board", { vm.tvFit() }, background = O.Bg2)
            OIconButton(OIcons.Focus, "Focus the TV on what I tapped", { vm.tvFocusSelection() }, background = if (focused) O.AccentSoft else O.Bg2, tint = if (focused) O.AccentHi else O.Text2)
            if (focused) OIconButton(OIcons.Close, "Stop focusing", { vm.tvClearFocus() }, background = O.Bg2)
            OIconButton(OIcons.Present, if (presenting) "Stop presenting" else "Present sections as slides", { vm.tvPresent(!presenting) }, background = if (presenting) O.AccentSoft else O.Bg2, tint = if (presenting) O.AccentHi else O.Text2)
            if (presenting) {
                OIconButton(OIcons.Prev, "Previous slide", { vm.tvSlide(-1) }, background = O.Bg2)
                OIconButton(OIcons.Next, "Next slide", { vm.tvSlide(1) }, background = O.Bg2)
            }
            Spacer(Modifier.weight(1f))
            MicButton(
                look = micLook(voice, live, liveMode, sending), level = level, size = 56.dp,
                onStart = startMic,
                onStop = { if (liveMode) vm.toggleLive() else vm.micStop(talk = true) },
                onCancel = { vm.micCancel() },
                onInterrupt = { vm.interruptVoice() },
            )
        }
    }

    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) {
                RowItem(boards.find { it.id == display?.boardId }?.name ?: "No board", subtitle = if (tvOnline) "Showing on the TV · tap to switch" else "TV not connected · changes apply when it is", icon = OIcons.Tv, onClick = { boardMenu = true })
                DropdownMenu(expanded = boardMenu, onDismissRequest = { boardMenu = false }, containerColor = O.Bg2) {
                    boards.forEach { b -> DropdownMenuItem(text = { Text(b.name, color = O.Text) }, onClick = { boardMenu = false; vm.showOnTv(b.id) }) }
                }
            }
            OIconButton(OIcons.Layers, if (overview) "Back to the TV's view" else "Overview of the whole board", {
                overview = !overview; controller.setOverview(overview)
            }, background = if (overview) O.AccentSoft else O.Bg2, tint = if (overview) O.AccentHi else O.Text2)
        }
        Row(Modifier.weight(1f).fillMaxWidth()) {
            Box(
                Modifier.weight(1f).fillMaxHeight().padding(horizontal = 12.dp, vertical = 6.dp).clip(RoundedCornerShape(16.dp)).border(1.dp, O.Border, RoundedCornerShape(16.dp)),
            ) {
                BoardWebView(mode = "remote", boardId = null, serverUrl = s.serverUrl, token = s.token, deviceName = "${s.deviceName} remote", controller = controller, modifier = Modifier.fillMaxSize())
                Text(
                    if (overview) "Drag to move the TV's view · pinch to zoom it" else "Drag to pan the TV · pinch to zoom · tap to select · double-tap to edit",
                    Modifier.align(Alignment.BottomCenter).padding(8.dp).clip(RoundedCornerShape(8.dp)).background(O.Bg.copy(alpha = 0.8f)).padding(horizontal = 10.dp, vertical = 5.dp),
                    style = MaterialTheme.typography.bodySmall, color = O.Text3,
                )
            }
            if (expanded) Column(Modifier.width(300.dp).padding(12.dp)) { VoiceStrip(vm) }
        }
        if (!expanded) VoiceStrip(vm)
        Box(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) { controls() }
    }
}
