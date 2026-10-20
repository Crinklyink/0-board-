package app.oboard.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

@Composable
fun AppRoot(vm: AppViewModel, pairPrefill: Pair<String, String>?) {
    val s by vm.settings.collectAsState()
    val loaded by vm.settingsLoaded.collectAsState()
    OBoardTheme {
        Box(Modifier.fillMaxSize().background(O.Bg)) {
            when {
                !loaded -> Unit
                !s.paired -> PairScreen(vm, pairPrefill)
                else -> MainScaffold(vm)
            }
            Toasts(vm, Modifier.align(Alignment.TopCenter))
        }
    }
}

private data class Dest(val tab: Tab, val label: String, val icon: ImageVector)

private val DESTS = listOf(
    Dest(Tab.Capture, "Capture", OIcons.Mic),
    Dest(Tab.Boards, "Boards", OIcons.Layers),
    Dest(Tab.Remote, "TV", OIcons.Tv),
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MainScaffold(vm: AppViewModel) {
    val tab by vm.tab.collectAsState()
    val overlay by vm.overlay.collectAsState()
    val link by vm.link.collectAsState()
    val tvOnline by vm.tvOnline.collectAsState()
    val queued by vm.queued.collectAsState()
    val s by vm.settings.collectAsState()
    val aiBoard by vm.aiBoard.collectAsState()
    val expanded = LocalConfiguration.current.screenWidthDp >= 760
    var selectedBoard by rememberSaveable { mutableStateOf<String?>(null) }

    when (val o = overlay) {
        is Overlay.Canvas -> { CanvasScreen(vm, o.boardId) { vm.overlay.value = null }; return }
        is Overlay.Settings -> { SettingsScreen(vm, o.page, { p -> vm.overlay.value = Overlay.Settings(p) }) { vm.overlay.value = null }; return }
        null -> Unit
    }

    val content: @Composable (Modifier) -> Unit = { mod ->
        when (tab) {
            Tab.Capture -> if (expanded) {
                Row(mod) {
                    CaptureScreen(vm, Modifier.width(380.dp).fillMaxHeight().imePadding())
                    Box(Modifier.weight(1f).fillMaxHeight().padding(8.dp).clip(RoundedCornerShape(16.dp)).border(1.dp, O.Border, RoundedCornerShape(16.dp))) {
                        val board = aiBoard
                        if (board != null) BoardWebView("edit", board, s.serverUrl, s.token, s.deviceName, remember { WebController() }, Modifier.fillMaxSize(), fitOnOpen = true)
                    }
                }
            } else CaptureScreen(vm, mod.imePadding())
            Tab.Boards -> if (expanded) {
                Row(mod) {
                    // A tap on a list row previews the board on the right; "Open" buttons open it full screen.
                    BoardsScreen(vm, onOpen = { selectedBoard = it }, Modifier.width(340.dp).fillMaxHeight(), selected = selectedBoard, onOpenFull = { vm.openCanvas(it) })
                    val sel = selectedBoard ?: aiBoard
                    Box(Modifier.weight(1f).fillMaxHeight().padding(8.dp).clip(RoundedCornerShape(16.dp)).border(1.dp, O.Border, RoundedCornerShape(16.dp))) {
                        if (sel != null) {
                            BoardWebView("edit", sel, s.serverUrl, s.token, s.deviceName, remember { WebController() }, Modifier.fillMaxSize(), fitOnOpen = true)
                            Row(Modifier.align(Alignment.TopEnd).padding(10.dp)) {
                                OIconButton(OIcons.Tv, "Show on TV", { vm.showOnTv(sel) }, background = O.Bg2)
                                Spacer(Modifier.width(6.dp))
                                OIconButton(OIcons.Fit, "Open full screen", { vm.openCanvas(sel) }, background = O.Bg2)
                            }
                        }
                    }
                }
            } else BoardsScreen(vm, onOpen = { vm.openCanvas(it) }, mod)
            Tab.Remote -> RemoteScreen(vm, mod)
        }
    }

    if (expanded) {
        Row(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
            Column(Modifier.width(84.dp).fillMaxHeight().padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                DESTS.forEach { d -> RailItem(d, tab == d.tab) { vm.tab.value = d.tab } }
                Spacer(Modifier.weight(1f))
                ConnectionDot(link, tvOnline, queued.size)
                Spacer(Modifier.height(10.dp))
                OIconButton(OIcons.Settings, "Settings", { vm.overlay.value = Overlay.Settings() })
            }
            Column(Modifier.weight(1f).fillMaxHeight()) {
                Header(DESTS.first { it.tab == tab }.label, link, tvOnline, queued.size, showSettings = false) { vm.overlay.value = Overlay.Settings() }
                if (tab != Tab.Capture) KeyRequestBar(vm, Modifier.padding(horizontal = 4.dp)) // Capture shows it right above its message box
                Box(Modifier.weight(1f)) {
                    content(Modifier.fillMaxSize())
                    ConfirmBar(vm, Modifier.align(Alignment.BottomCenter))
                }
            }
        }
    } else {
        // While typing, the keyboard replaces the bottom bar (so the composer sits right on top of the keyboard).
        val typing = WindowInsets.isImeVisible
        Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.statusBars)) {
            Header(DESTS.first { it.tab == tab }.label, link, tvOnline, queued.size, showSettings = true) { vm.overlay.value = Overlay.Settings() }
            if (tab != Tab.Capture) KeyRequestBar(vm, Modifier.padding(horizontal = 4.dp)) // Capture shows it right above its message box
            Box(Modifier.weight(1f)) {
                content(Modifier.fillMaxSize())
                ConfirmBar(vm, Modifier.align(Alignment.BottomCenter))
            }
            if (!typing) {
                Row(
                    Modifier.fillMaxWidth().background(O.Bg).windowInsetsPadding(WindowInsets.navigationBars).height(64.dp).padding(horizontal = 12.dp),
                    horizontalArrangement = Arrangement.SpaceAround, verticalAlignment = Alignment.CenterVertically,
                ) {
                    DESTS.forEach { d -> BottomItem(d, tab == d.tab, Modifier.weight(1f)) { vm.tab.value = d.tab } }
                }
            }
        }
    }
}

@Composable
private fun Header(title: String, link: app.oboard.data.Link, tvOnline: Boolean, queued: Int, showSettings: Boolean, onSettings: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(56.dp).padding(start = 20.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.titleLarge, color = O.Text, modifier = Modifier.weight(1f))
        ConnectionBadge(link, tvOnline, queued)
        if (showSettings) { Spacer(Modifier.width(4.dp)); OIconButton(OIcons.Settings, "Settings", onSettings) }
    }
}

@Composable
private fun ConnectionDot(link: app.oboard.data.Link, tvOnline: Boolean, queued: Int) {
    val color = when {
        link != app.oboard.data.Link.Online -> O.Warn
        queued > 0 -> O.Accent
        tvOnline -> O.Ok
        else -> O.Text3
    }
    Box(Modifier.size(8.dp).clip(RoundedCornerShape(4.dp)).background(color))
}

@Composable
private fun RailItem(d: Dest, selected: Boolean, onClick: () -> Unit) {
    Column(
        Modifier.padding(vertical = 6.dp).clip(RoundedCornerShape(14.dp)).clickable(role = Role.Tab) { onClick() }.semantics { this.selected = selected }.padding(horizontal = 10.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(width = 52.dp, height = 32.dp).clip(RoundedCornerShape(10.dp)).background(if (selected) O.AccentSoft else androidx.compose.ui.graphics.Color.Transparent), contentAlignment = Alignment.Center) {
            Icon(d.icon, null, Modifier.size(21.dp), tint = if (selected) O.AccentHi else O.Text2)
        }
        Spacer(Modifier.height(4.dp))
        Text(d.label, style = MaterialTheme.typography.labelMedium, color = if (selected) O.Text else O.Text2)
    }
}

@Composable
private fun BottomItem(d: Dest, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Column(
        modifier.clip(RoundedCornerShape(14.dp)).clickable(role = Role.Tab) { onClick() }.semantics { this.selected = selected }.padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(width = 56.dp, height = 30.dp).clip(RoundedCornerShape(10.dp)).background(if (selected) O.AccentSoft else androidx.compose.ui.graphics.Color.Transparent), contentAlignment = Alignment.Center) {
            Icon(d.icon, null, Modifier.size(21.dp), tint = if (selected) O.AccentHi else O.Text2)
        }
        Text(d.label, style = MaterialTheme.typography.labelMedium, color = if (selected) O.Text else O.Text2)
    }
}

/** Destructive AI actions wait here for an explicit yes. */
@Composable
private fun ConfirmBar(vm: AppViewModel, modifier: Modifier) {
    val confirms by vm.confirms.collectAsState()
    val c = confirms.lastOrNull()
    AnimatedVisibility(c != null, modifier, enter = slideInVertically { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut()) {
        if (c != null) {
            Row(
                Modifier.padding(12.dp).widthIn(max = 560.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(O.Bg2).border(1.dp, O.BorderHi, RoundedCornerShape(16.dp)).padding(14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("The assistant wants to", style = MaterialTheme.typography.labelMedium, color = O.Text3)
                    Text(c.summary, style = MaterialTheme.typography.titleSmall, color = O.Text)
                }
                Spacer(Modifier.width(8.dp))
                OButton("Cancel", { vm.resolveConfirm(c.id, false) }, kind = BtnKind.Ghost)
                Spacer(Modifier.width(6.dp))
                OButton("Confirm", { vm.resolveConfirm(c.id, true) }, kind = BtnKind.Primary)
            }
        }
    }
}

@Composable
private fun Toasts(vm: AppViewModel, modifier: Modifier) {
    val items = remember { mutableStateListOf<Pair<Long, String>>() }
    LaunchedEffect(Unit) {
        vm.notices.collect { text ->
            val id = System.nanoTime()
            items.add(id to text)
            if (items.size > 3) items.removeAt(0)
        }
    }
    Column(modifier.windowInsetsPadding(WindowInsets.statusBars).padding(top = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        items.forEach { (id, text) ->
            LaunchedEffect(id) { delay(3200); items.removeAll { it.first == id } }
            Text(
                text,
                Modifier.padding(4.dp).widthIn(max = 460.dp).clip(RoundedCornerShape(12.dp)).background(O.Bg2).border(1.dp, O.BorderHi, RoundedCornerShape(12.dp)).padding(horizontal = 14.dp, vertical = 10.dp),
                style = MaterialTheme.typography.bodyMedium, color = O.Text,
            )
        }
    }
}
