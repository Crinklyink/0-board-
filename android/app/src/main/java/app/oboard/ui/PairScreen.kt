package app.oboard.ui

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/** First run: find the Pi (or type its address) and enter the 8-digit code the TV shows. */
@Composable
fun PairScreen(vm: AppViewModel, prefill: Pair<String, String>?) {
    val found by vm.c.discovery.found.collectAsState()
    val searching by vm.c.discovery.searching.collectAsState()
    var address by rememberSaveable { mutableStateOf(prefill?.first ?: "") }
    var code by rememberSaveable { mutableStateOf(prefill?.second ?: "") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val codeFocus = remember { FocusRequester() }

    DisposableEffect(Unit) {
        vm.c.discovery.start()
        onDispose { vm.c.discovery.stop() }
    }
    LaunchedEffect(found) { if (address.isBlank() && found.size == 1) address = found[0].url.removePrefix("http://") }

    fun submit() {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            error = vm.pair(address, code)
            busy = false
        }
    }
    LaunchedEffect(prefill) { if (prefill != null && prefill.second.length == 8) submit() }

    Box(Modifier.fillMaxSize().background(O.Bg).windowInsetsPadding(WindowInsets.safeDrawing).imePadding(), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 440.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("O Board", style = MaterialTheme.typography.headlineSmall, color = O.Text)
            Text("Pair this phone with the Raspberry Pi that runs your TV board.", style = MaterialTheme.typography.bodyLarge, color = O.Text2)
            Spacer(Modifier.height(6.dp))

            SectionLabel("1  Find the Pi")
            if (found.isNotEmpty()) {
                OCard(padding = androidx.compose.foundation.layout.PaddingValues(4.dp)) {
                    Column {
                        found.forEach { s ->
                            RowItem(s.name, subtitle = s.url.removePrefix("http://"), icon = OIcons.Tv, onClick = { address = s.url.removePrefix("http://") }) {
                                if (address == s.url.removePrefix("http://")) androidx.compose.material3.Icon(OIcons.Check, null, Modifier.size(20.dp), tint = O.Accent)
                            }
                        }
                    }
                }
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (searching) CircularProgressIndicator(Modifier.size(14.dp), color = O.Text3, strokeWidth = 2.dp)
                    Spacer(Modifier.size(10.dp))
                    Text(if (searching) "Looking on your Wi-Fi…" else "Not found automatically. Type the address shown on the TV.", style = MaterialTheme.typography.bodySmall, color = O.Text3)
                }
            }
            OTextField(
                address, { address = it.trim() }, "192.168.1.20 or oboard.local",
                Modifier.fillMaxWidth(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                keyboardActions = KeyboardActions(onNext = { codeFocus.requestFocus() }),
            )

            SectionLabel("2  Enter the code on the TV")
            OTextField(
                code, { v -> code = v.filter { it.isDigit() }.take(8) }, "0000 0000",
                Modifier.fillMaxWidth().focusRequester(codeFocus),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                textStyle = MaterialTheme.typography.headlineSmall.copy(letterSpacing = 6.sp),
            )
            error?.let { Text(it, color = O.DangerText, style = MaterialTheme.typography.bodySmall) }
            Spacer(Modifier.height(4.dp))
            OButton("Pair", { submit() }, Modifier.fillMaxWidth(), kind = BtnKind.Primary, loading = busy, enabled = address.isNotBlank() && code.length == 8)
            Text(
                "Away from home? Install Tailscale on the Pi and this phone, then use the Pi's Tailscale name or 100.x address.",
                style = MaterialTheme.typography.bodySmall, color = O.Text3,
            )
        }
    }
}
