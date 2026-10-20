package app.oboard.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import app.oboard.data.BoardTemplate
import app.oboard.data.DiagnosticReport
import app.oboard.voice.ModelCatalog
import app.oboard.voice.ModelState
import kotlinx.coroutines.launch

@Composable
fun DiagnosticsPage(vm: AppViewModel, onPage: (SettingsPage) -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var report by remember { mutableStateOf<DiagnosticReport?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var key by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var microphone by remember { mutableStateOf(ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) }
    val askMic = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { microphone = it }
    val runCheck: (Boolean) -> Unit = { test ->
        busy = true; error = null
        scope.launch {
            try {
                if (test) vm.c.api.testGemini()
                report = vm.c.api.diagnostics()
                microphone = ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            } catch (e: Exception) { error = e.message ?: "Could not reach the Pi" }
            finally { busy = false }
        }
    }
    LaunchedEffect(Unit) { runCheck(false) }
    Text("Check this phone and the Pi in one place. Connection tests check API access; use the voice self-test to exercise speech recognition and playback.", Modifier.padding(vertical = 10.dp), style = MaterialTheme.typography.bodySmall, color = O.Text2)
    error?.let { Text(it, Modifier.padding(vertical = 8.dp), color = O.DangerText) }
    report?.checks?.forEach { c -> DiagnosticCard(c.name, c.status, c.detail, c.action) }
    DiagnosticCard("Microphone permission", if (microphone) "pass" else "warn", if (microphone) "Microphone access is allowed." else "Allow microphone access to use voice.")
    if (!microphone) OButton("Allow microphone", { askMic.launch(Manifest.permission.RECORD_AUDIO) }, Modifier.fillMaxWidth())
    SectionLabel("On-device voice models")
    ModelCatalog.ESSENTIAL.forEach { model ->
        val state by vm.c.models.state(model).collectAsState()
        DiagnosticCard(model.title, if (state is ModelState.Ready) "pass" else "warn", when (state) {
            is ModelState.Ready -> "Installed on this phone."
            is ModelState.Failed -> "Download failed. Open Voice models to retry."
            else -> "Not ready. Open Voice models to install or check progress."
        })
    }
    Row(Modifier.padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OButton("Voice models", { onPage(SettingsPage.Models) })
        OButton("Voice self-test", { onPage(SettingsPage.Voice) })
    }
    SectionLabel("Gemini API key")
    Text("Paste your key here to save it on the Pi. The phone does not retain it. It is excluded from backups, exports and conversations.", style = MaterialTheme.typography.bodySmall, color = O.Text2)
    Spacer(Modifier.height(8.dp))
    OTextField(key, { key = it.take(4000) }, "Gemini API key", Modifier.fillMaxWidth(), singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), visualTransformation = PasswordVisualTransformation())
    Spacer(Modifier.height(8.dp))
    OButton("Save key on Pi", {
        busy = true; error = null
        scope.launch {
            try { vm.c.api.saveGeminiKey(key); key = ""; report = vm.c.api.diagnostics(); vm.loadAiSettings() }
            catch (e: Exception) { error = e.message ?: "Could not save key" }
            finally { busy = false }
        }
    }, Modifier.fillMaxWidth(), kind = BtnKind.Primary, enabled = key.isNotBlank() && !busy)
    Spacer(Modifier.height(12.dp))
    OButton("Test Gemini connection", { runCheck(true) }, Modifier.fillMaxWidth(), loading = busy, enabled = !busy)
    Spacer(Modifier.height(8.dp))
    OButton("Refresh checks", { runCheck(false) }, Modifier.fillMaxWidth(), enabled = !busy)
    Spacer(Modifier.height(8.dp))
    OButton("Assistant model settings", { onPage(SettingsPage.Assistant) }, Modifier.fillMaxWidth())
}

@Composable
private fun DiagnosticCard(name: String, status: String, detail: String, action: String = "") {
    val color = when (status) { "pass" -> O.Ok; "fail" -> O.DangerText; else -> O.Warn }
    OCard(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text("${if (status == "pass") "✓" else if (status == "fail") "×" else "!"} $name", style = MaterialTheme.typography.titleSmall, color = color)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = O.Text2)
            if (action.isNotBlank()) Text(action, style = MaterialTheme.typography.bodySmall, color = O.Text3)
        }
    }
}

@Composable
fun NewBoardDialog(vm: AppViewModel, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf("") }
    var templates by remember { mutableStateOf(listOf(BoardTemplate("blank", "Blank board", "A clear space for your own layout."))) }
    var template by remember { mutableStateOf("blank") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        runCatching { vm.c.api.boardTemplates() }.onSuccess { templates = it }.onFailure { error = "Templates unavailable. You can still create a blank board." }
    }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() }, containerColor = O.Bg2,
        title = { Text("New space", color = O.Text) },
        text = {
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OTextField(name, { name = it.take(80) }, "Name", singleLine = true)
                SectionLabel("Start with")
                templates.forEach { t -> RowItem(t.name, subtitle = t.description, onClick = { template = t.id }) {
                    Text(if (t.id == template) "✓" else "", color = O.AccentHi)
                } }
                error?.let { Text(it, color = O.DangerText, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = { TextButton(enabled = name.isNotBlank() && !busy, onClick = {
            busy = true; error = null
            scope.launch {
                try { val board = vm.c.api.createBoard(name.trim(), template); vm.refreshBoards().join(); onDismiss(); vm.openCanvas(board.id) }
                catch (e: Exception) { error = e.message ?: "Could not create board" }
                finally { busy = false }
            }
        }) { Text(if (busy) "Creating…" else "Create", color = O.AccentHi) } },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("Cancel", color = O.Text2) } },
    )
}
