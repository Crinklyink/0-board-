package app.oboard

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.oboard.ui.AppRoot
import app.oboard.ui.AppViewModel

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()
    private var pairPrefill by mutableStateOf<Pair<String, String>?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) handleIntent(intent)
        setContent { AppRoot(vm, pairPrefill) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onStop() {
        super.onStop()
        // Never keep listening once the app is out of sight.
        if (!isChangingConfigurations) vm.releaseMic()
    }

    private fun handleIntent(intent: Intent?) {
        when (intent?.action) {
            Intent.ACTION_VIEW -> {
                val data = intent.data ?: return
                if (data.scheme == "oboard" && data.host == "pair") {
                    val h = data.getQueryParameter("h").orEmpty()
                    val c = data.getQueryParameter("c").orEmpty()
                    if (h.isNotBlank()) pairPrefill = h to c
                }
            }
            Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> vm.captureShared(intent)
        }
    }
}
