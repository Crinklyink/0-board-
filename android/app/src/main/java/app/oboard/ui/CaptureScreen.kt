package app.oboard.ui

import android.Manifest
import android.graphics.ImageDecoder
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import app.oboard.data.Link
import app.oboard.voice.LiveState
import app.oboard.voice.VoiceState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.text.DateFormat
import java.util.Date

/** Phone default: capture thoughts instantly or talk them through with the assistant. */
@Composable
fun CaptureScreen(vm: AppViewModel, modifier: Modifier = Modifier, showHeader: Boolean = true) {
    val thread by vm.thread.collectAsState()
    val boards by vm.boards.collectAsState()
    val aiBoard by vm.aiBoard.collectAsState()
    val pinned by vm.pinnedAiBoard.collectAsState()
    val display by vm.display.collectAsState()
    val undo by vm.lastUndo.collectAsState()
    val listState = rememberLazyListState()

    LaunchedEffect(thread.size, thread.lastOrNull()?.text?.length) {
        if (thread.isNotEmpty()) listState.animateScrollToItem(thread.size - 1)
    }

    Column(modifier.fillMaxSize()) {
        if (showHeader) {
            var menu by remember { mutableStateOf(false) }
            val name = boards.find { it.id == aiBoard }?.name ?: "Choose a board"
            Box(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                Row(
                    Modifier.clip(RoundedCornerShape(10.dp)).clickable { menu = true }.padding(horizontal = 4.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Talking about ", style = MaterialTheme.typography.bodySmall, color = O.Text3)
                    Text(name, style = MaterialTheme.typography.labelLarge, color = O.Text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 220.dp))
                    if (pinned == null && display?.boardId == aiBoard) { Spacer(Modifier.width(6.dp)); Pill("on TV", color = O.AccentHi, bg = O.AccentSoft) }
                    Icon(OIcons.ChevronDown, null, Modifier.size(16.dp), tint = O.Text3)
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = O.Bg2) {
                    DropdownMenuItem(text = { Text("Whatever the TV shows", color = O.Text) }, onClick = { vm.pinnedAiBoard.value = null; menu = false })
                    boards.forEach { b ->
                        DropdownMenuItem(text = { Text(b.name, color = O.Text) }, onClick = { vm.pinnedAiBoard.value = b.id; menu = false })
                    }
                }
            }
        }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (thread.isEmpty()) {
                EmptyState(
                    "Say or type anything",
                    "Hold the mic to talk. Save keeps a thought in Thoughts right away, even offline. Ask sends it to the assistant, who can work on the board.",
                    Modifier.align(Alignment.Center),
                )
            } else {
                LazyColumn(state = listState, modifier = Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp, 8.dp)) {
                    items(thread, key = { it.id }) { item -> ThreadRow(item, onDiscard = { vm.deleteQueued(item.id) }) }
                }
            }
        }

        undo?.let { (_, n) ->
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.Center) {
                OButton("Undo the assistant's $n change${if (n > 1) "s" else ""}", { vm.undoAi() }, icon = OIcons.Undo)
                Spacer(Modifier.width(8.dp))
                OIconButton(OIcons.Close, "Dismiss", { vm.lastUndo.value = null })
            }
        }
        KeyRequestBar(vm, Modifier.fillMaxWidth().wrapContentWidth())
        VoiceStrip(vm)
        Composer(vm)
    }
}

@Composable
private fun ThreadRow(item: ThreadItem, onDiscard: () -> Unit) {
    val time = remember(item.ts) { if (item.ts == Long.MAX_VALUE) "" else DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(item.ts)) }
    when (item.who) {
        Who.User -> Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.End) {
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    item.text,
                    Modifier.widthIn(max = 320.dp).clip(RoundedCornerShape(16.dp, 16.dp, 4.dp, 16.dp)).background(O.Surface).padding(horizontal = 14.dp, vertical = 10.dp),
                    style = MaterialTheme.typography.bodyMedium, color = O.Text,
                )
                if (item.files > 0) Text("${item.files} attachment${if (item.files > 1) "s" else ""}", style = MaterialTheme.typography.bodySmall, color = O.Text3)
            }
        }
        Who.Assistant -> Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
            if (item.pending && item.text.isEmpty()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(14.dp), color = O.AccentHi, strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text(item.status ?: "Thinking", style = MaterialTheme.typography.bodySmall, color = O.Text2)
                }
            } else {
                Text(item.text, style = MaterialTheme.typography.bodyLarge, color = O.Text)
                if (item.pending && !item.status.isNullOrBlank()) Text(item.status, style = MaterialTheme.typography.bodySmall, color = O.Text3)
            }
        }
        Who.Capture -> Row(
            Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(RoundedCornerShape(12.dp)).border(1.dp, O.Border, RoundedCornerShape(12.dp)).padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(if (item.error != null) OIcons.WifiOff else if (item.pending) OIcons.Inbox else OIcons.Check, null, Modifier.size(18.dp), tint = if (item.error != null) O.Danger else if (item.pending) O.Warn else O.Ok)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(item.text.ifBlank { "${item.files} file${if (item.files == 1) "" else "s"}" }, style = MaterialTheme.typography.bodyMedium, color = O.Text, maxLines = 3, overflow = TextOverflow.Ellipsis)
                Text(
                    when {
                        item.error != null -> "Not saved: ${item.error}"
                        item.pending -> "Saved on the phone · sends when the Pi is reachable"
                        else -> "${item.status ?: "Saved"} · $time"
                    },
                    style = MaterialTheme.typography.bodySmall, color = if (item.error != null) O.DangerText else O.Text3,
                )
            }
            if (item.error != null) OIconButton(OIcons.Trash, "Discard", onDiscard, size = 36.dp)
        }
        Who.Notice -> Text(item.text, Modifier.padding(vertical = 6.dp), style = MaterialTheme.typography.bodySmall, color = O.Text3)
    }
}

/** What the voice pipeline is doing right now, shown just above the composer. */
@Composable
fun VoiceStrip(vm: AppViewModel) {
    val voice by vm.voiceState.collectAsState()
    val live by vm.liveState.collectAsState()
    val liveUser by vm.liveUser.collectAsState()
    val liveAi by vm.liveAi.collectAsState()
    val (label, text) = when {
        live !is LiveState.Idle -> when (live) {
            LiveState.Connecting -> "Connecting to Gemini Live…" to ""
            LiveState.Reconnecting -> "Reconnecting…" to ""
            LiveState.Listening -> "Live · listening" to (liveAi.ifBlank { liveUser })
            LiveState.Speaking -> "Live" to liveAi
            is LiveState.Failed -> "Live stopped" to (live as LiveState.Failed).message
            else -> "" to ""
        }
        voice is VoiceState.Listening -> (if ((voice as VoiceState.Listening).handsFree) "Hands-free · listening" else "Listening… release to finish, slide up to cancel") to (voice as VoiceState.Listening).partial
        voice is VoiceState.Transcribing -> "Transcribing…" to ""
        voice is VoiceState.Preparing -> (voice as VoiceState.Preparing).what to ""
        voice is VoiceState.Problem -> "Voice" to (voice as VoiceState.Problem).message
        else -> "" to ""
    }
    AnimatedVisibility(label.isNotEmpty(), enter = fadeIn(), exit = fadeOut()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = if (voice is VoiceState.Problem) O.DangerText else O.AccentHi)
            if (text.isNotBlank()) Text(text, style = MaterialTheme.typography.titleMedium, color = O.Text, maxLines = 4, overflow = TextOverflow.Ellipsis)
        }
    }
    LaunchedEffect(voice) { if (voice is VoiceState.Problem) { kotlinx.coroutines.delay(4000); vm.c.voice.clearProblem() } }
}

fun micLook(voice: VoiceState, live: LiveState, liveMode: Boolean, sending: Boolean): MicLook = when {
    liveMode && live !is LiveState.Idle && live !is LiveState.Failed -> MicLook.Live
    voice is VoiceState.Listening && !voice.handsFree -> MicLook.Listening
    voice is VoiceState.Speaking -> MicLook.Speaking
    voice is VoiceState.Transcribing || voice is VoiceState.Thinking || sending -> MicLook.Busy
    else -> MicLook.Idle
}

@Composable
fun rememberMicPermission(vm: AppViewModel, then: () -> Unit): () -> Unit {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) then() else vm.notice("Microphone permission is needed for voice")
    }
    return { if (vm.hasMicPermission()) then() else launcher.launch(Manifest.permission.RECORD_AUDIO) }
}

@Composable
private fun Composer(vm: AppViewModel) {
    val ctx = LocalContext.current
    val text by vm.composer.collectAsState()
    val files by vm.attachments.collectAsState()
    val settings by vm.settings.collectAsState()
    val voice by vm.voiceState.collectAsState()
    val live by vm.liveState.collectAsState()
    val sending by vm.sending.collectAsState()
    val link by vm.link.collectAsState()
    val level by vm.c.mic.level.collectAsState()
    var addMenu by remember { mutableStateOf(false) }
    var cameraUri by remember { mutableStateOf<Uri?>(null) }

    val pickPhotos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(8)) { vm.addAttachments(it) }
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { vm.addAttachments(it) }
    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> if (ok) cameraUri?.let { vm.addAttachments(listOf(it)) } }
    val startMic = rememberMicPermission(vm) { vm.micStart() }
    val liveMode = settings.voiceEngine == "live"

    Column(Modifier.fillMaxWidth().background(O.Bg).padding(horizontal = 12.dp, vertical = 8.dp)) {
        if (files.isNotEmpty()) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 8.dp)) {
                items(files, key = { it.toString() }) { uri -> AttachmentChip(uri) { vm.removeAttachment(uri) } }
            }
        }
        Row(verticalAlignment = Alignment.Bottom) {
            Box {
                OIconButton(OIcons.Plus, "Add photo or file", { addMenu = true }, background = O.Bg2)
                DropdownMenu(expanded = addMenu, onDismissRequest = { addMenu = false }, containerColor = O.Bg2) {
                    DropdownMenuItem(text = { Text("Take photo", color = O.Text) }, leadingIcon = { Icon(OIcons.Camera, null, tint = O.Text2) }, onClick = {
                        addMenu = false
                        val dir = File(ctx.cacheDir, "camera").apply { mkdirs() }
                        val f = File(dir, "photo-${System.currentTimeMillis()}.jpg")
                        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", f)
                        cameraUri = uri
                        takePhoto.launch(uri)
                    })
                    DropdownMenuItem(text = { Text("Photos", color = O.Text) }, leadingIcon = { Icon(OIcons.Image, null, tint = O.Text2) }, onClick = {
                        addMenu = false
                        pickPhotos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    })
                    DropdownMenuItem(text = { Text("File", color = O.Text) }, leadingIcon = { Icon(OIcons.Attach, null, tint = O.Text2) }, onClick = {
                        addMenu = false
                        pickFiles.launch(arrayOf("image/*", "application/pdf", "text/*", "audio/*", "application/json"))
                    })
                }
            }
            Spacer(Modifier.width(8.dp))
            OTextField(
                text, { vm.composer.value = it }, if (liveMode) "Type, or tap the mic for a live conversation" else "A thought, a question, a link…",
                Modifier.weight(1f).heightIn(min = 44.dp), maxLines = 6,
            )
            Spacer(Modifier.width(8.dp))
            MicButton(
                look = micLook(voice, live, liveMode, sending),
                level = level,
                onStart = startMic,
                onStop = { if (liveMode) vm.toggleLive() else vm.micStop(talk = settings.talkMode) },
                onCancel = { vm.micCancel() },
                onInterrupt = { vm.interruptVoice() },
                size = 52.dp,
            )
        }
        // Narrow panes (the unfolded split view, the cover screen) get the short label so Save and Ask always fit.
        BoxWithConstraints(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        val roomy = maxWidth >= 390.dp
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (!liveMode) {
                Row(
                    Modifier.clip(RoundedCornerShape(8.dp)).clickable { vm.updatePrefs { it.talkMode(!settings.talkMode) } }.padding(horizontal = 6.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(14.dp).clip(RoundedCornerShape(4.dp)).background(if (settings.talkMode) O.Accent else O.Bg2).border(1.dp, if (settings.talkMode) O.Accent else O.BorderHi, RoundedCornerShape(4.dp)), contentAlignment = Alignment.Center) {
                        if (settings.talkMode) Icon(OIcons.Check, null, Modifier.size(11.dp), tint = O.Bg)
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(if (roomy) "Send when I let go" else "Auto-send", style = MaterialTheme.typography.labelMedium, color = O.Text2, maxLines = 1, softWrap = false)
                }
                OIconButton(OIcons.Wave, if (vm.handsFreeOn) "Stop hands-free" else "Hands-free conversation", { vm.toggleHandsFree() }, size = 36.dp, tint = if (vm.handsFreeOn) O.AccentHi else O.Text3)
            } else {
                Text(if (roomy) "Gemini Live voice" else "Live", style = MaterialTheme.typography.labelMedium, color = O.Text3, maxLines = 1, softWrap = false)
            }
            Spacer(Modifier.weight(1f))
            val canSend = text.isNotBlank() || files.isNotEmpty()
            OButton("Save", { vm.captureComposer() }, enabled = canSend, kind = BtnKind.Secondary, icon = OIcons.Inbox)
            Spacer(Modifier.width(8.dp))
            OButton("Ask", { vm.askComposer() }, enabled = canSend && link == Link.Online && !sending, kind = BtnKind.Primary, icon = OIcons.Send, loading = sending)
        }
        }
    }
}

@Composable
private fun AttachmentChip(uri: Uri, onRemove: () -> Unit) {
    val ctx = LocalContext.current
    val thumb by produceState<ImageBitmap?>(null, uri) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                val type = ctx.contentResolver.getType(uri) ?: ""
                if (!type.startsWith("image/")) null
                else ImageDecoder.decodeBitmap(ImageDecoder.createSource(ctx.contentResolver, uri)) { d, _, _ -> d.setTargetSize(128, 128) }.asImageBitmap()
            }.getOrNull()
        }
    }
    Box(Modifier.size(64.dp).clip(RoundedCornerShape(10.dp)).background(O.Surface).border(1.dp, O.Border, RoundedCornerShape(10.dp))) {
        val t = thumb
        if (t != null) Image(t, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        else Icon(OIcons.Doc, null, Modifier.size(24.dp).align(Alignment.Center), tint = O.Text2)
        Box(
            Modifier.align(Alignment.TopEnd).padding(3.dp).size(20.dp).clip(RoundedCornerShape(10.dp)).background(O.Bg.copy(alpha = 0.8f)).clickable { onRemove() },
            contentAlignment = Alignment.Center,
        ) { Icon(OIcons.Close, "Remove attachment", Modifier.size(12.dp), tint = O.Text) }
    }
}
