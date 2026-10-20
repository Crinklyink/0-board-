package app.oboard.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.oboard.data.ApiKeyInfo
import kotlinx.coroutines.launch

/** Identifies one request, so closing it does not hide a later request for the same key. */
fun keyRequestId(k: ApiKeyInfo) = "${k.name}@${k.requestedAt ?: 0}"

/**
 * The assistant asked for an API key a widget needs. A slim banner that sits in the page flow (it never covers
 * anything); the key box opens only when asked for. The key goes straight to the Pi and is never part of the
 * conversation (so Gemini never sees it). "Not now" is remembered; Settings → API keys still lists the request.
 */
@Composable
fun KeyRequestBar(vm: AppViewModel, modifier: Modifier = Modifier) {
    val keys by vm.apiKeys.collectAsState()
    val s by vm.settings.collectAsState()
    val req = keys.filter { !it.set && it.requestedAt != null && keyRequestId(it) !in s.dismissedKeys }.maxByOrNull { it.requestedAt ?: 0 }
    var open by remember(req?.name) { mutableStateOf(false) }
    AnimatedVisibility(req != null, modifier, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
        if (req != null) {
            Column(
                Modifier.padding(horizontal = 12.dp, vertical = 6.dp).widthIn(max = 560.dp).fillMaxWidth().clip(RoundedCornerShape(14.dp))
                    .background(O.Bg2).border(1.dp, O.BorderHi, RoundedCornerShape(14.dp)).padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(30.dp).clip(RoundedCornerShape(9.dp)).background(O.AccentSoft), contentAlignment = Alignment.Center) {
                        Icon(OIcons.Key, null, Modifier.size(16.dp), tint = O.AccentHi)
                    }
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text("${req.label} key needed", style = MaterialTheme.typography.titleSmall, color = O.Text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(req.why.ifBlank { "For a widget on your board" }, style = MaterialTheme.typography.bodySmall, color = O.Text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (!open) { Spacer(Modifier.width(8.dp)); OButton("Add key", { open = true }, kind = BtnKind.Secondary) }
                    OIconButton(OIcons.Close, "Not now", { vm.dismissKeyRequest(req) }, size = 40.dp)
                }
                AnimatedVisibility(open) {
                    Column(Modifier.padding(top = 8.dp, end = 8.dp, bottom = 4.dp)) { KeyEntry(vm, req, onSaved = { open = false }) }
                }
            }
        }
    }
}

/** Paste box + Save for one key, with where to get it and where it will be used. */
@Composable
private fun KeyEntry(vm: AppViewModel, key: ApiKeyInfo, onSaved: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var value by remember(key.name) { mutableStateOf("") }
    var error by remember(key.name) { mutableStateOf<String?>(null) }
    var saving by remember(key.name) { mutableStateOf(false) }
    val save = {
        if (value.isNotBlank() && !saving) {
            saving = true
            scope.launch {
                error = vm.saveApiKey(key.name, value)
                saving = false
                if (error == null) { value = ""; onSaved(); vm.notice("${key.label} key saved. The widget is starting.") }
            }
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        OTextField(
            value, { value = it.trim(); error = null }, "Paste the ${key.label} key", Modifier.weight(1f), singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = ImeAction.Done),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { save() }),
            visualTransformation = PasswordVisualTransformation(),
        )
        Spacer(Modifier.width(8.dp))
        OButton("Save", { save() }, enabled = value.isNotBlank(), kind = BtnKind.Primary, loading = saving)
    }
    Spacer(Modifier.height(6.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            error ?: "Kept only on your Pi. Sent only to ${key.host}.",
            style = MaterialTheme.typography.bodySmall, color = if (error != null) O.DangerText else O.Text3, modifier = Modifier.weight(1f),
        )
        if (key.signupUrl.isNotBlank()) {
            OButton("Get a free key", { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(key.signupUrl))) } }, kind = BtnKind.Ghost)
        }
    }
}

/** Settings → API keys: what is saved (never the keys themselves), what the assistant asked for, and adding one by hand. */
@Composable
fun ApiKeysPage(vm: AppViewModel) {
    val keys by vm.apiKeys.collectAsState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { vm.loadApiKeys() }
    Text(
        "Widgets on your board can use services that need a key, such as stock prices or weather. Keys are stored only on your Pi, " +
            "each is sent only to its own website, and they are never shown again or shared with the assistant.",
        Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodySmall, color = O.Text2,
    )
    val missing = keys.filter { !it.set }
    val saved = keys.filter { it.set }
    if (missing.isNotEmpty()) {
        SectionLabel("Needed by widgets")
        missing.forEach { k ->
            Column(Modifier.fillMaxWidth().padding(vertical = 6.dp).clip(RoundedCornerShape(14.dp)).background(O.Surface).padding(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(k.label, style = MaterialTheme.typography.titleSmall, color = O.Text)
                        Text(k.why.ifBlank { "For ${k.host}" }, style = MaterialTheme.typography.bodySmall, color = O.Text2)
                    }
                    OIconButton(OIcons.Trash, "Forget this request", { vm.deleteApiKey(k.name) }, size = 36.dp)
                }
                Spacer(Modifier.height(8.dp))
                KeyEntry(vm, k, onSaved = {})
            }
        }
    }
    SectionLabel("Saved")
    if (saved.isEmpty()) Text("None yet.", style = MaterialTheme.typography.bodyMedium, color = O.Text3)
    saved.forEach { k ->
        RowItem(k.label, subtitle = "${k.name} · used only for ${k.host}", icon = OIcons.Key) {
            OIconButton(OIcons.Trash, "Remove ${k.label} key", { vm.deleteApiKey(k.name) }, size = 38.dp)
        }
    }

    SectionLabel("Add a key yourself")
    var name by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("") }
    var value by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OTextField(name, { name = it.uppercase().replace(Regex("[^A-Z0-9_]"), "_").take(48); error = null }, "Name, e.g. FINNHUB_KEY", singleLine = true)
        OTextField(host, { host = it.trim(); error = null }, "Website it is for, e.g. finnhub.io", singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false))
        OTextField(value, { value = it.trim(); error = null }, "The key", singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
            visualTransformation = PasswordVisualTransformation())
        error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = O.DangerText) }
        OButton("Save key", {
            scope.launch {
                error = vm.saveApiKey(name, value, host)
                if (error == null) { name = ""; host = ""; value = "" }
            }
        }, enabled = name.length >= 2 && host.contains('.') && value.isNotBlank(), kind = BtnKind.Primary, icon = OIcons.Key)
        Text("Then ask the assistant to use it, for example: \"track NVDA with my Finnhub key\".", style = MaterialTheme.typography.bodySmall, color = O.Text3)
    }
}
