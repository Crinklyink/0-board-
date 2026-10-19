package app.oboard.data

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.Executors

data class FoundServer(val name: String, val url: String)

/**
 * Finds the Pi on the home network. The Pi advertises "_oboard._tcp" over mDNS (Avahi, set up by pi/install.sh),
 * so in the common case the user never types an address.
 */
class Discovery(private val ctx: Context) {
    private val nsd = ctx.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val _found = MutableStateFlow<List<FoundServer>>(emptyList())
    val found: StateFlow<List<FoundServer>> = _found.asStateFlow()
    private val _searching = MutableStateFlow(false)
    val searching: StateFlow<Boolean> = _searching.asStateFlow()
    private var listener: NsdManager.DiscoveryListener? = null
    private var lock: WifiManager.MulticastLock? = null
    private val executor = Executors.newSingleThreadExecutor()

    fun start() {
        if (listener != null) return
        _found.value = emptyList()
        lock = (ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
            .createMulticastLock("oboard-discovery").apply { setReferenceCounted(false); acquire() }
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) { _searching.value = true }
            override fun onDiscoveryStopped(serviceType: String) { _searching.value = false }
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { _searching.value = false }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceLost(service: NsdServiceInfo) {
                _found.value = _found.value.filterNot { it.name == service.serviceName }
            }
            override fun onServiceFound(service: NsdServiceInfo) = resolve(service)
        }
        listener = l
        runCatching { nsd.discoverServices("_oboard._tcp", NsdManager.PROTOCOL_DNS_SD, l) }
    }

    @Suppress("DEPRECATION")
    private fun resolve(service: NsdServiceInfo) {
        val onResolved = { info: NsdServiceInfo ->
            val host = if (Build.VERSION.SDK_INT >= 34) info.hostAddresses.firstOrNull { it is java.net.Inet4Address }?.hostAddress else info.host?.hostAddress
            if (host != null) {
                val url = "http://$host:${info.port}"
                _found.value = (_found.value.filterNot { it.url == url } + FoundServer(info.serviceName, url)).sortedBy { it.name }
            }
        }
        if (Build.VERSION.SDK_INT >= 34) {
            nsd.registerServiceInfoCallback(service, executor, object : NsdManager.ServiceInfoCallback {
                override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {}
                override fun onServiceUpdated(serviceInfo: NsdServiceInfo) { onResolved(serviceInfo); runCatching { nsd.unregisterServiceInfoCallback(this) } }
                override fun onServiceLost() {}
                override fun onServiceInfoCallbackUnregistered() {}
            })
        } else {
            nsd.resolveService(service, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}
                override fun onServiceResolved(serviceInfo: NsdServiceInfo) { onResolved(serviceInfo) }
            })
        }
    }

    fun stop() {
        listener?.let { runCatching { nsd.stopServiceDiscovery(it) } }
        listener = null
        lock?.let { runCatching { it.release() } }
        lock = null
        _searching.value = false
    }
}
