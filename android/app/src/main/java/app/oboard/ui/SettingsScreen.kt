package app.oboard.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import app.oboard.BuildConfig
import app.oboard.data.Link
import app.oboard.voice.ModelCatalog
import app.oboard.voice.ModelSpec
import app.oboard.voice.ModelState
import app.oboard.voice.TtsEngine
import app.oboard.voice.Voices
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Composable
fun SettingsScreen(vm: AppViewModel, page: SettingsPage, onPage: (SettingsPage) -> Unit, onClose: () -> Unit) {
    BackHandler { if (page == SettingsPage.Main) onClose() else onPage(SettingsPage.Main) }
    val title = when (page) {
        SettingsPage.Main -> "Settings"; SettingsPage.Connection -> "Connection"; SettingsPage.Voice -> "Voice"
        SettingsPage.Models -> "Voice models"; SettingsPage.Assistant -> "Assistant"; SettingsPage.Backup -> "Backup & export"
        SettingsPage.ApiKeys -> "API keys"
        SettingsPage.Diagnostics -> "Setup & diagnostics"
        SettingsPage.About -> "About"
    }
    Column(Modifier.fillMaxSize().background(O.Bg).windowInsetsPadding(WindowInsets.safeDrawing).imePadding()) {
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OIconButton(OIcons.Back, "Back", { if (page == SettingsPage.Main) onClose() else onPage(SettingsPage.Main) })
            Spacer(Modifier.width(4.dp))
            Text(title, style = MaterialTheme.typography.titleLarge, color = O.Text)
        }
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            Column(Modifier.widthIn(max = 640.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 32.dp)) {
                when (page) {
                    SettingsPage.Main -> MainPage(vm, onPage)
                    SettingsPage.Diagnostics -> DiagnosticsPage(vm, onPage)
                    SettingsPage.Connection -> ConnectionPage(vm)
                    SettingsPage.Voice -> VoicePage(vm, onPage)
                    SettingsPage.Models -> ModelsPage(vm)
                    SettingsPage.Assistant -> AssistantPage(vm)
                    SettingsPage.ApiKeys -> ApiKeysPage(vm)
                    SettingsPage.Backup -> BackupPage(vm)
                    SettingsPage.About -> AboutPage()
                }
            }
        }
    }
}

@Composable
private fun MainPage(vm: AppViewModel, onPage: (SettingsPage) -> Unit) {
    val s by vm.settings.collectAsState()
    val link by vm.link.collectAsState()
    Spacer(Modifier.height(8.dp))
    RowItem("Setup & diagnostics", subtitle = "Check the Pi, TV, assistant and phone voice", icon = OIcons.Check, onClick = { onPage(SettingsPage.Diagnostics) }) { Icon(OIcons.ChevronRight, null, Modifier.size(18.dp), tint = O.Text3) }
    RowItem("Connection", subtitle = "${s.serverUrl.removePrefix("http://")} · ${if (link == Link.Online) "connected" else "offline"}", icon = OIcons.Tv, onClick = { onPage(SettingsPage.Connection) }) { Icon(OIcons.ChevronRight, null, Modifier.size(18.dp), tint = O.Text3) }
    val engine = TtsEngine.of(s.ttsEngine)
    val voiceName = Voices.forEngine(engine).find { it.sid == s.voiceId }?.label ?: ""
    RowItem("Voice", subtitle = if (s.voiceEngine == "live") "Gemini Live · ${s.liveVoice}" else "On-device · ${engine.label} · $voiceName", icon = OIcons.Speaker, onClick = { onPage(SettingsPage.Voice) }) { Icon(OIcons.ChevronRight, null, Modifier.size(18.dp), tint = O.Text3) }
    RowItem("Voice models", subtitle = if (vm.voiceReady) "Installed" else "Not downloaded yet", icon = OIcons.Download, onClick = { onPage(SettingsPage.Models) }) { Icon(OIcons.ChevronRight, null, Modifier.size(18.dp), tint = O.Text3) }
    RowItem("Assistant", subtitle = "Gemini models and behaviour (stored on the Pi)", icon = OIcons.Bulb, onClick = { onPage(SettingsPage.Assistant) }) { Icon(OIcons.ChevronRight, null, Modifier.size(18.dp), tint = O.Text3) }
    val keys by vm.apiKeys.collectAsState()
    val keysNeeded = keys.count { !it.set }
    RowItem("API keys", subtitle = if (keysNeeded > 0) "$keysNeeded needed by widgets" else if (keys.isEmpty()) "For widgets that use outside services" else "${keys.size} saved on the Pi", icon = OIcons.Key, onClick = { onPage(SettingsPage.ApiKeys) }) { Icon(OIcons.ChevronRight, null, Modifier.size(18.dp), tint = O.Text3) }
    RowItem("Backup & export", subtitle = "Copy everything off the Pi", icon = OIcons.Inbox, onClick = { onPage(SettingsPage.Backup) }) { Icon(OIcons.ChevronRight, null, Modifier.size(18.dp), tint = O.Text3) }
    RowItem("About", subtitle = "Version ${BuildConfig.VERSION_NAME}", icon = OIcons.Doc, onClick = { onPage(SettingsPage.About) }) { Icon(OIcons.ChevronRight, null, Modifier.size(18.dp), tint = O.Text3) }
}

@Composable
private fun ConnectionPage(vm: AppViewModel) {
    val s by vm.settings.collectAsState()
    val link by vm.link.collectAsState()
    val devices by vm.devices.collectAsState()
    var code by remember { mutableStateOf<String?>(null) }
    var name by remember(s.deviceName) { mutableStateOf(s.deviceName) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { vm.loadDevices() }
    SectionLabel("This phone")
    RowItem(s.serverUrl.removePrefix("http://"), subtitle = when (link) { Link.Online -> "Connected"; Link.Unauthorized -> "This phone was removed. Pair again."; else -> "Can't reach the Pi right now" }, icon = OIcons.Tv)
    OTextField(name, { name = it.take(60) }, "Device name", singleLine = true)
    Spacer(Modifier.height(8.dp))
    OButton("Save name", { vm.updatePrefs { it.deviceName(name.trim().ifEmpty { "Phone" }) } }, enabled = name != s.deviceName)
    SectionLabel("Paired devices")
    devices.forEach { d ->
        RowItem(d.name, subtitle = d.role, icon = if (d.role == "display") OIcons.Tv else OIcons.Mic) {
            if (d.role != "display") OIconButton(OIcons.Trash, "Remove ${d.name}", { vm.revokeDevice(d.id) }, size = 38.dp)
        }
    }
    Spacer(Modifier.height(8.dp))
    OButton("Pair another device", { scope.launch { code = vm.newPairingCode() } }, icon = OIcons.Plus)
    code?.let { Text("Code: ${it.chunked(4).joinToString(" ")} (valid for 10 minutes)", Modifier.padding(top = 10.dp), style = MaterialTheme.typography.titleMedium, color = O.AccentHi) }
    SectionLabel("Away from home")
    Text(
        "Install Tailscale on the Pi and this phone and sign both into the same account. While you are home the app learns the Pi's Tailscale address, and when you leave it switches to it by itself. No need to pair again. Traffic is end-to-end encrypted by WireGuard.",
        style = MaterialTheme.typography.bodySmall, color = O.Text2,
    )
    val others = s.altUrls.filter { it != s.serverUrl.trimEnd('/') && !it.contains(".local:") }
    if (others.isNotEmpty()) {
        Spacer(Modifier.height(8.dp))
        Text(
            "Also reachable at: " + others.joinToString(", ") { it.removePrefix("http://") },
            style = MaterialTheme.typography.bodySmall, color = O.Text3,
        )
    }
    Spacer(Modifier.height(24.dp))
    OButton("Forget this Pi", { vm.forgetPairing() }, kind = BtnKind.Danger)
}

@Composable
private fun VoicePage(vm: AppViewModel, onPage: (SettingsPage) -> Unit) {
    val s by vm.settings.collectAsState()
    val metrics by vm.voiceMetrics.collectAsState()
    var report by remember { mutableStateOf<String?>(null) }
    var running by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    SectionLabel("How the assistant speaks")
    EngineCard(
        "On-device voice", "Recommended", "Speech recognition (Qwen3-ASR) and the voice (Kokoro) run on this phone. Only text goes to Gemini. Private, works the same on any network, reply audio starts within about a second.",
        s.voiceEngine == "local",
    ) { vm.updatePrefs { it.voiceEngine("local") } }
    Spacer(Modifier.height(8.dp))
    EngineCard(
        "Gemini Live", null, "Your voice streams to Gemini, which answers with its own natural voice and can be interrupted mid-sentence. Needs internet; uses your Gemini quota. Best with headphones.",
        s.voiceEngine == "live",
    ) { vm.updatePrefs { it.voiceEngine("live") } }

    if (s.voiceEngine == "local") {
        val engine = TtsEngine.of(s.ttsEngine)
        val engineState by vm.c.models.state(engine.spec).collectAsState()
        SectionLabel("Voice model")
        Segmented(
            listOf("Kokoro · most natural", "Supertonic · fastest"), if (engine == TtsEngine.Kokoro) 0 else 1,
            { i ->
                val e = if (i == 0) TtsEngine.Kokoro else TtsEngine.Supertonic
                vm.updatePrefs { it.ttsEngine(e.id); it.voiceId(if (e == TtsEngine.Kokoro) 3 else 0) }
            },
            Modifier.fillMaxWidth(),
        )
        Text(
            if (engine == TtsEngine.Kokoro) "Measured: about 0.4× real time on 4 CPU cores; answers start ~1 s after the assistant's first words."
            else "Measured: about 0.17× real time; answers start ~0.6 s after the assistant's first words.",
            Modifier.padding(top = 6.dp), style = MaterialTheme.typography.bodySmall, color = O.Text3,
        )
        if (engineState !is ModelState.Ready) {
            Spacer(Modifier.height(10.dp))
            OButton(
                "Download ${engine.label} (${engine.spec.downloadBytes / 1_048_576} MB)",
                { vm.c.models.install(engine.spec); onPage(SettingsPage.Models) }, kind = BtnKind.Primary, icon = OIcons.Download,
            )
        }
        if (!vm.voiceReady && engineState is ModelState.Ready) {
            Spacer(Modifier.height(10.dp))
            OButton("Download speech recognition", { onPage(SettingsPage.Models) }, icon = OIcons.Download)
        }
        SectionLabel("Voice")
        Voices.forEngine(engine).forEach { v ->
            RowItem(v.label, subtitle = if (engine == TtsEngine.Kokoro) "${v.accent} · ${v.gender}" else "Preset style ${v.sid + 1}", onClick = { vm.updatePrefs { it.voiceId(v.sid) } }) {
                if (s.voiceId == v.sid) Icon(OIcons.Check, "Selected", Modifier.size(18.dp), tint = O.Accent)
                OIconButton(OIcons.Play, "Preview ${v.label}", { vm.updatePrefs { it.voiceId(v.sid) }; vm.previewVoice(v.sid) }, size = 40.dp, enabled = engineState is ModelState.Ready)
            }
        }
        SectionLabel("Speaking speed · ${"%.2f".format(s.speed)}×")
        Slider(
            value = s.speed, onValueChange = { v -> vm.updatePrefs { it.speed((v * 20).toInt() / 20f) } }, valueRange = 0.8f..1.3f,
            colors = SliderDefaults.colors(thumbColor = O.AccentHi, activeTrackColor = O.Accent, inactiveTrackColor = O.Surface),
        )
    } else {
        SectionLabel("Gemini Live voice")
        var menu by remember { mutableStateOf(false) }
        Box {
            RowItem(s.liveVoice, subtitle = "Set on the Pi; applies to new conversations", icon = OIcons.Speaker, onClick = { menu = true })
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = O.Bg2) {
                Voices.LIVE.forEach { v ->
                    DropdownMenuItem(text = { Text(v, color = O.Text) }, onClick = {
                        menu = false
                        vm.updatePrefs { it.liveVoice(v) }
                        vm.saveAiSettings(buildJsonObject { put("liveVoice", v) })
                    })
                }
            }
        }
    }

    SectionLabel("Conversation")
    ToggleRow("Send when I let go", "Off: your words land in the text box so you can fix them first.", s.talkMode, { v -> vm.updatePrefs { it.talkMode(v) } })
    ToggleRow("Interrupt by speaking", "In hands-free mode, talking over the assistant stops it. Works best with headphones.", s.bargeIn, { v -> vm.updatePrefs { it.bargeIn(v) } })
    ToggleRow("Play replies on the TV (beta)", "On-device voice only. Push-to-talk recommended to avoid echo.", s.tvAudio, { v -> vm.tvAudio(v) })

    SectionLabel("Diagnostics")
    Text(
        buildString {
            appendLine("Model load: speech recognition ${metrics.asrLoadMs} ms, voice ${metrics.ttsLoadMs} ms")
            appendLine("Last recognition: ${metrics.lastAsrMs} ms (real-time factor ${"%.2f".format(metrics.lastAsrRtf)})")
            appendLine("Voice speed: real-time factor ${"%.2f".format(metrics.lastTtsRtf)}")
            appendLine("Reply text to first sound: ${metrics.replyToVoiceMs} ms")
            append("Mic release to first sound: ${metrics.releaseToVoiceMs} ms")
        },
        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = O.Text2,
    )
    Spacer(Modifier.height(10.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OButton("Voice self-test", {
            running = true
            scope.launch { report = vm.runSelfTest(); running = false }
        }, loading = running, enabled = vm.voiceReady && !running)
        OButton("Conversation test", {
            running = true
            scope.launch { report = vm.runConversationTest(); running = false }
        }, enabled = vm.voiceReady && !running)
    }
    Text("Self-test: the voice speaks a sentence and speech recognition writes it down. Conversation test: the same, then it goes to the assistant and the reply is spoken.", Modifier.padding(top = 6.dp), style = MaterialTheme.typography.bodySmall, color = O.Text3)
    report?.let { Text(it, Modifier.padding(top = 10.dp), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = O.Text) }
}

@Composable
private fun EngineCard(title: String, badge: String?, body: String, selected: Boolean, onClick: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(if (selected) O.AccentSoft else O.Bg2)
            .border(1.dp, if (selected) O.Accent else O.Border, RoundedCornerShape(14.dp)).clickable { onClick() }.padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = O.Text, modifier = Modifier.weight(1f))
            if (badge != null) Pill(badge, color = O.AccentHi, bg = O.Bg2)
            if (selected) { Spacer(Modifier.width(8.dp)); Icon(OIcons.Check, "Selected", Modifier.size(18.dp), tint = O.AccentHi) }
        }
        Spacer(Modifier.height(4.dp))
        Text(body, style = MaterialTheme.typography.bodySmall, color = O.Text2)
    }
}

@Composable
private fun ModelsPage(vm: AppViewModel) {
    val free = remember { vm.c.models.freeBytes() }
    Text("Voice models download once, over Wi-Fi ideally, and stay on the phone. Every file is checked against its published SHA-256 before use.", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodySmall, color = O.Text2)
    Text("Free space on this phone: ${"%.1f".format(free / 1_073_741_824.0)} GB", Modifier.padding(top = 4.dp), style = MaterialTheme.typography.bodySmall, color = O.Text3)
    Spacer(Modifier.height(10.dp))
    val total = ModelCatalog.ESSENTIAL.sumOf { it.downloadBytes }
    OButton("Download everything needed (about ${"%.1f".format(total / 1_073_741_824.0)} GB)", { vm.installModels() }, kind = BtnKind.Primary, icon = OIcons.Download, enabled = !vm.voiceReady)
    ModelCatalog.ALL.forEach { spec -> ModelRow(vm, spec) }
}

@Composable
private fun ModelRow(vm: AppViewModel, spec: ModelSpec) {
    val st by vm.c.models.state(spec).collectAsState()
    SectionLabel(spec.title)
    Text(spec.description, style = MaterialTheme.typography.bodySmall, color = O.Text2)
    val mb = spec.downloadBytes / 1_048_576.0
    Text("${if (mb < 10) "%.1f".format(mb) else mb.toInt()} MB · ${spec.license}${if (spec == ModelCatalog.SUPERTONIC) " · optional" else ""}", style = MaterialTheme.typography.bodySmall, color = O.Text3)
    Spacer(Modifier.height(8.dp))
    when (val s = st) {
        ModelState.Missing -> {
            val partial = remember(st) { vm.c.models.partialBytes(spec) }
            OButton(
                if (partial > 0) "Resume (${partial / 1_048_576} of ${spec.downloadBytes / 1_048_576} MB)" else "Download",
                { vm.c.models.install(spec) }, icon = OIcons.Download,
            )
        }
        is ModelState.Downloading -> {
            ProgressBar(s.fraction)
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("${s.done / 1_048_576} of ${s.total / 1_048_576} MB", style = MaterialTheme.typography.bodySmall, color = O.Text2, modifier = Modifier.weight(1f))
                OButton("Pause", { vm.c.models.cancel(spec) }, kind = BtnKind.Ghost)
            }
        }
        is ModelState.Unpacking -> Text("Unpacking… ${s.files} files", style = MaterialTheme.typography.bodySmall, color = O.Text2)
        ModelState.Ready -> Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(OIcons.Check, null, Modifier.size(18.dp), tint = O.Ok)
            Spacer(Modifier.width(8.dp))
            Text("Installed", style = MaterialTheme.typography.labelLarge, color = O.Text2, modifier = Modifier.weight(1f))
            OButton("Remove", { vm.c.models.delete(spec) }, kind = BtnKind.Ghost)
        }
        is ModelState.Failed -> Column {
            Text(s.message, style = MaterialTheme.typography.bodySmall, color = O.DangerText)
            Spacer(Modifier.height(6.dp))
            OButton("Try again (resumes)", { vm.c.models.install(spec) })
        }
    }
}

@Composable
private fun AssistantPage(vm: AppViewModel) {
    val ai by vm.aiSettings.collectAsState()
    val ok by vm.geminiReady.collectAsState()
    val models by vm.models.collectAsState()
    LaunchedEffect(Unit) { vm.loadAiSettings() }
    val a = ai ?: run { Text("Loading…", Modifier.padding(16.dp), color = O.Text3); return }
    var extra by remember(a.extraInstructions) { mutableStateOf(a.extraInstructions) }
    if (ok == false) {
        OCard(Modifier.fillMaxWidth().padding(top = 8.dp)) {
            Text("The Pi has no Gemini API key yet. Open Settings → Setup & diagnostics to add it from this phone. It is saved only on the Pi.", style = MaterialTheme.typography.bodySmall, color = O.Warn)
        }
    }
    SectionLabel("Text and vision model")
    ModelPicker(a.textModel, models.filter { !it.contains("live") && !it.contains("tts") && !it.contains("embedding") }) { m -> vm.saveAiSettings(buildJsonObject { put("textModel", m) }) }
    SectionLabel("Live voice model")
    ModelPicker(a.liveModel, models.filter { it.contains("live") || it.contains("native-audio") }) { m -> vm.saveAiSettings(buildJsonObject { put("liveModel", m) }) }
    SectionLabel("Thinking")
    val levels = listOf("low", "medium", "high")
    Segmented(listOf("Quick", "Balanced", "Thorough"), levels.indexOf(a.thinkingLevel).coerceAtLeast(0), { i -> vm.saveAiSettings(buildJsonObject { put("thinkingLevel", levels[i]) }) }, Modifier.fillMaxWidth())
    Text("Quick replies sooner; Thorough is better for planning and big reorganizations.", Modifier.padding(top = 6.dp), style = MaterialTheme.typography.bodySmall, color = O.Text3)
    SectionLabel("Things the assistant should know about you")
    OTextField(extra, { extra = it.take(2000) }, "e.g. I'm an engineer; keep notes short; I prefer metric units.", minLines = 3)
    Spacer(Modifier.height(8.dp))
    OButton("Save", { vm.saveAiSettings(buildJsonObject { put("extraInstructions", extra) }) }, enabled = extra != a.extraInstructions)
    SectionLabel("Images")
    ToggleRow("Describe uploaded images", "So you can find them later by what they show.", a.autoCaptionImages, { v -> vm.saveAiSettings(buildJsonObject { put("autoCaptionImages", v) }) })
}

@Composable
private fun ModelPicker(current: String, options: List<String>, onPick: (String) -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Box {
        RowItem(current, subtitle = if (options.isEmpty()) "Model list unavailable" else "Tap to change", onClick = { if (options.isNotEmpty()) menu = true }) { Icon(OIcons.ChevronDown, null, Modifier.size(18.dp), tint = O.Text3) }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = O.Bg2) {
            options.forEach { m -> DropdownMenuItem(text = { Text(m, color = if (m == current) O.AccentHi else O.Text) }, onClick = { menu = false; onPick(m) }) }
        }
    }
}

@Composable
private fun BackupPage(vm: AppViewModel) {
    val ctx = LocalContext.current
    val boards by vm.boards.collectAsState()
    val scope = rememberCoroutineScope()
    var status by remember { mutableStateOf<String?>(null) }
    var exportId by remember { mutableStateOf<String?>(null) }
    val saveBackup = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/x-tar")) { uri ->
        if (uri != null) scope.launch { status = "Downloading…"; status = vm.backupTo(ctx.contentResolver.openOutputStream(uri)!!) }
    }
    val saveExport = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val id = exportId
        if (uri != null && id != null) scope.launch { status = vm.exportBoardTo(id, ctx.contentResolver.openOutputStream(uri)!!) }
    }
    Text("The Pi keeps automatic database backups every 6 hours (the last 14). Download a full copy here to keep one off the Pi.", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodySmall, color = O.Text2)
    Spacer(Modifier.height(12.dp))
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OButton("Back up now on the Pi", { vm.backupOnPi() }, Modifier.fillMaxWidth())
        OButton("Download full backup (.tar)", { saveBackup.launch("oboard-backup.tar") }, Modifier.fillMaxWidth(), icon = OIcons.Download)
    }
    status?.let { Text(it, Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodySmall, color = O.Text2) }
    SectionLabel("Export one board")
    boards.forEach { b ->
        RowItem(b.name, subtitle = "${b.count} items", icon = OIcons.Layers, onClick = { exportId = b.id; saveExport.launch("${b.name}.oboard.json") })
    }
}

@Composable
private fun AboutPage() {
    Spacer(Modifier.height(8.dp))
    Text("O Board ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.titleMedium, color = O.Text)
    Text("Your boards live on your Raspberry Pi. Speech recognition and the on-device voice run on this phone. Text and images you send to the assistant go to Google's Gemini API through your Pi using your own key.", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodySmall, color = O.Text2)
    SectionLabel("Open-source components")
    listOf(
        "sherpa-onnx (Apache-2.0)", "ONNX Runtime (MIT)", "Qwen3-ASR 0.6B (Apache-2.0)", "Kokoro-82M (Apache-2.0)",
        "Supertonic 3, optional download (OpenRAIL-M model, MIT code)", "Silero VAD (MIT)", "Chart.js, for widgets (MIT)",
        "espeak-ng data (GPL-3.0, used as data by sherpa-onnx)", "Inter typeface (SIL OFL 1.1)", "OkHttp (Apache-2.0)",
        "Apache Commons Compress (Apache-2.0)", "Jetpack Compose and AndroidX (Apache-2.0)", "Kotlin coroutines/serialization (Apache-2.0)",
    ).forEach { Text(it, Modifier.padding(vertical = 3.dp), style = MaterialTheme.typography.bodySmall, color = O.Text2) }
}
