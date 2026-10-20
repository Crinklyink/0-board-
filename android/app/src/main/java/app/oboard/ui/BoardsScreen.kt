package app.oboard.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.oboard.data.BoardInfo
import app.oboard.data.BoardObject
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

@Composable
fun BoardsScreen(vm: AppViewModel, onOpen: (String) -> Unit, modifier: Modifier = Modifier, selected: String? = null) {
    var section by rememberSaveable { mutableIntStateOf(0) }
    Column(modifier.fillMaxSize()) {
        Segmented(listOf("Home", "Thoughts", "Spaces"), section, { section = it }, Modifier.padding(horizontal = 16.dp, vertical = 8.dp).fillMaxWidth())
        when (section) {
            0 -> HomeSection(vm, onOpen, selected)
            1 -> ThoughtsSection(vm, onOpen)
            else -> SpacesSection(vm, onOpen, selected)
        }
    }
}

@Composable
private fun HomeSection(vm: AppViewModel, onOpen: (String) -> Unit, selected: String?) {
    val boards by vm.boards.collectAsState()
    val display by vm.display.collectAsState()
    val tvOnline by vm.tvOnline.collectAsState()
    val onTv = boards.find { it.id == display?.boardId }
    val pinned = boards.filter { it.pinned }
    val recent = boards.filter { !it.pinned }.sortedByDescending { maxOf(it.updatedAt, it.openedAt) }.take(8)
    LaunchedEffect(Unit) { vm.refreshBoards() } // fresh thumbnails each time Home is shown
    LazyColumn(contentPadding = PaddingValues(16.dp, 4.dp, 16.dp, 24.dp)) {
        item {
            OCard(Modifier.fillMaxWidth()) {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(OIcons.Tv, null, Modifier.size(18.dp), tint = if (tvOnline) O.Ok else O.Text3)
                        Spacer(Modifier.width(8.dp))
                        Text(if (tvOnline) "On the TV now" else "TV is off or not connected", style = MaterialTheme.typography.labelMedium, color = O.Text2)
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(onTv?.name ?: "—", style = MaterialTheme.typography.titleLarge, color = O.Text)
                    if (onTv != null) Text("${onTv.count} items", style = MaterialTheme.typography.bodySmall, color = O.Text3)
                    if (onTv != null) {
                        Spacer(Modifier.height(12.dp))
                        BoardThumb(onTv.preview, Modifier.fillMaxWidth().height(132.dp))
                    }
                    Spacer(Modifier.height(14.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OButton("Open", { onTv?.let { onOpen(it.id) } }, enabled = onTv != null, icon = OIcons.Canvas)
                        OButton("Remote", { vm.tab.value = Tab.Remote }, kind = BtnKind.Ghost, icon = OIcons.Tv)
                    }
                }
            }
        }
        if (pinned.isNotEmpty()) {
            item { SectionLabel("Pinned") }
            items(pinned, key = { "p" + it.id }) { b -> BoardRow(vm, b, onOpen, b.id == selected) }
        }
        item { SectionLabel("Recent") }
        items(recent, key = { "r" + it.id }) { b -> BoardRow(vm, b, onOpen, b.id == selected) }
    }
}

@Composable
private fun ThoughtsSection(vm: AppViewModel, onOpen: (String) -> Unit) {
    val thoughts by vm.thoughts.collectAsState()
    val loading by vm.thoughtsLoading.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { vm.loadThoughts() }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("${thoughts.size} unsorted", style = MaterialTheme.typography.labelMedium, color = O.Text2, modifier = Modifier.weight(1f))
            OButton("Organize", {
                vm.pinnedAiBoard.value = "thoughts"
                scope.launch { vm.ask("Organize my Thoughts board: group related notes into titled sections. Keep my wording.", viaVoice = false) }
                vm.notice("Asked the assistant to organize Thoughts")
            }, kind = BtnKind.Ghost)
            OButton("Open", { onOpen("thoughts") }, icon = OIcons.Canvas)
        }
        if (thoughts.isEmpty() && !loading) {
            EmptyState("Nothing here yet", "Anything you Save from Capture, share from another app, or say lands here first.", Modifier.fillMaxWidth())
        }
        if (loading && thoughts.isEmpty()) Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp), color = O.Text3, strokeWidth = 2.dp) }
        LazyColumn(contentPadding = PaddingValues(12.dp, 0.dp, 12.dp, 24.dp)) {
            items(thoughts, key = { it.id }) { t -> ThoughtRow(t) { onOpen("thoughts") } }
        }
    }
}

@Composable
private fun ThoughtRow(t: BoardObject, onClick: () -> Unit) {
    val icon = when (t.type) { "image" -> OIcons.Image; "link" -> OIcons.Link; "file" -> OIcons.Doc; else -> OIcons.Bulb }
    val time = remember(t.t) { if (t.t > 0) DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(t.t)) else "" }
    RowItem(t.label, subtitle = time, icon = icon, onClick = onClick)
}

@Composable
private fun SpacesSection(vm: AppViewModel, onOpen: (String) -> Unit, selected: String?) {
    val boards by vm.boards.collectAsState()
    var creating by remember { mutableStateOf(false) }
    val spaces = boards.filter { it.kind == "space" }.sortedWith(compareByDescending<BoardInfo> { it.pinned }.thenByDescending { it.updatedAt })
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("${spaces.size} spaces", style = MaterialTheme.typography.labelMedium, color = O.Text2, modifier = Modifier.weight(1f))
            OButton("New space", { creating = true }, kind = BtnKind.Primary, icon = OIcons.Plus)
        }
        LazyColumn(contentPadding = PaddingValues(12.dp, 0.dp, 12.dp, 24.dp)) {
            items(spaces, key = { it.id }) { b -> BoardRow(vm, b, onOpen, b.id == selected) }
        }
    }
    if (creating) NameDialog("New space", "Name", "", onDismiss = { creating = false }) { name -> creating = false; vm.createBoard(name) }
}

@Composable
private fun BoardRow(vm: AppViewModel, b: BoardInfo, onOpen: (String) -> Unit, selected: Boolean) {
    var menu by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    val updated = remember(b.updatedAt) { if (b.updatedAt > 0) DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(b.updatedAt)) else "" }
    Box {
        RowItem(
            b.name,
            subtitle = "${b.count} items · $updated",
            icon = if (b.isThoughts) OIcons.Bulb else OIcons.Layers,
            onClick = { onOpen(b.id) },
            leading = { BoardThumb(b.preview, Modifier.size(width = 68.dp, height = 46.dp)) },
            modifier = if (selected) Modifier.padding(0.dp) else Modifier,
        ) {
            if (b.pinned) Icon(OIcons.Pin, "Pinned", Modifier.size(16.dp), tint = O.Text3)
            OIconButton(OIcons.More, "More for ${b.name}", { menu = true }, size = 40.dp)
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = O.Bg2) {
            DropdownMenuItem(text = { Text("Show on TV", color = O.Text) }, onClick = { menu = false; vm.showOnTv(b.id) })
            if (!b.isThoughts) {
                DropdownMenuItem(text = { Text(if (b.pinned) "Unpin" else "Pin to Home", color = O.Text) }, onClick = { menu = false; vm.pinBoard(b.id, !b.pinned) })
                DropdownMenuItem(text = { Text("Rename", color = O.Text) }, onClick = { menu = false; renaming = true })
                DropdownMenuItem(text = { Text("Archive", color = O.DangerText) }, onClick = { menu = false; vm.archiveBoard(b.id) })
            }
        }
    }
    if (renaming) NameDialog("Rename", "Name", b.name, onDismiss = { renaming = false }) { name -> renaming = false; vm.renameBoard(b.id, name) }
}

@Composable
fun NameDialog(title: String, label: String, initial: String, onDismiss: () -> Unit, onDone: (String) -> Unit) {
    var name by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = O.Bg2,
        title = { Text(title, color = O.Text, style = MaterialTheme.typography.titleMedium) },
        text = { OTextField(name, { name = it.take(80) }, label, singleLine = true) },
        confirmButton = { TextButton(onClick = { if (name.isNotBlank()) onDone(name.trim()) }, enabled = name.isNotBlank()) { Text("Done", color = O.AccentHi) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = O.Text2) } },
    )
}
