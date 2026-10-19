package app.oboard.data

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Keeps the phone on the same Pi as it moves between networks.
 *
 * While connected, the phone learns every address the Pi answers on (its home-network IP, its Tailscale address, ...).
 * When the current address stops answering, all of them are probed at once and the most preferred one that proves to be
 * the same Pi (same serverId) becomes the active address. The device token is per Pi, not per address, so nothing needs
 * to be paired again. When the phone joins a new network, a preferred address (home Wi-Fi over Tailscale) is retried.
 */
class Failover(
    private val api: Api,
    private val prefs: Prefs,
    private val settings: StateFlow<AppSettings>,
    private val events: Events,
    private val scope: CoroutineScope,
) {
    private var preferJob: Job? = null

    fun start() {
        scope.launch {
            events.link.map { state(it) }.distinctUntilChanged().collectLatest { st ->
                when (st) {
                    State.Up -> learn()
                    State.Down -> {
                        delay(3_000)
                        var wait = 5_000L
                        while (isActive && !probe()) {
                            delay(wait)
                            wait = (wait * 2).coerceAtMost(60_000)
                        }
                    }
                    State.Revoked -> Unit
                }
            }
        }
    }

    /** The phone joined a different network: if a more preferred address now answers, move to it. */
    fun onNetworkChanged() {
        preferJob?.cancel()
        preferJob = scope.launch { delay(1_500); probe() }
    }

    private enum class State { Up, Down, Revoked }

    private fun state(l: Link) = when (l) {
        Link.Online -> State.Up
        Link.Unauthorized -> State.Revoked
        else -> State.Down
    }

    private suspend fun learn() {
        val s = settings.value
        if (!s.paired) return
        val reported = runCatching { api.addresses() }.getOrNull() ?: return
        // The address the phone was paired with stays first: it is the one the user chose.
        val first = s.altUrls.firstOrNull() ?: s.serverUrl
        val merged = (listOf(first) + reported + s.altUrls + s.serverUrl).map { it.trimEnd('/') }.filter { it.isNotBlank() }.distinct().take(12)
        if (merged != s.altUrls) prefs.update { it.altUrls(merged) }
    }

    /** Returns true when some address answered (switching to it if it is not the current one). */
    private suspend fun probe(): Boolean {
        val s = settings.value
        if (!s.paired || s.serverId.isBlank()) return false
        val candidates = (s.altUrls + s.serverUrl).map { it.trimEnd('/') }.distinct()
        val answers = coroutineScope {
            candidates.map { url ->
                async { url to withTimeoutOrNull(3_500) { runCatching { api.info(url) }.getOrNull() } }
            }.awaitAll()
        }
        val best = answers.firstOrNull { (_, info) -> info?.serverId == s.serverId }?.first ?: return false
        if (best != s.serverUrl.trimEnd('/')) {
            Log.i(TAG, "Pi reachable at $best; switching from ${s.serverUrl}")
            prefs.update { it.serverUrl(best) } // settings flow restarts the socket and the canvas on the new address
        } else {
            events.nudge()
        }
        return true
    }

    private companion object { const val TAG = "OBoardFailover" }
}
