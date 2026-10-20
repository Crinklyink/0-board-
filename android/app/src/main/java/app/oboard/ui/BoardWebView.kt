package app.oboard.ui

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import app.oboard.BuildConfig
import org.json.JSONObject

/** What the web canvas tells the native app. */
data class WebEvent(val type: String, val data: JSONObject)

/** Lets native UI drive the canvas (tools, undo, board switches). */
class WebController {
    internal var view: WebView? = null
    fun js(code: String) { view?.evaluateJavascript("window.oboard && (function(){ $code })()", null) }
    fun setTool(t: String) = js("oboard.setTool('$t')")
    fun undo() = js("oboard.undo()")
    fun redo() = js("oboard.redo()")
    fun fit() = js("oboard.fit()")
    fun openBoard(id: String) = js("oboard.openBoard(${JSONObject.quote(id)})")
    fun setOverview(on: Boolean) = js("oboard.setOverview($on)")
    fun pickFile() = js("oboard.pickFile()")
    fun search() = js("oboard.openSearch()")
    fun memory() = js("oboard.openMemory()")
    fun addTask() = js("oboard.addTask()")
    fun tasks() = js("oboard.openTasks()")
    fun closeOverlay() = js("oboard.closeOverlay()")
    fun insets(top: Int, bottom: Int) = js("oboard.insetsChanged($top,$bottom)")
}

private class WebBridge(private val ctx: Context, private val config: String, private val onEvent: (WebEvent) -> Unit) {
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun postMessage(json: String) {
        val o = runCatching { JSONObject(json) }.getOrNull() ?: return
        main.post { onEvent(WebEvent(o.optString("type"), o)) }
    }

    @JavascriptInterface
    fun getConfig(): String = config

    @JavascriptInterface
    fun openUrl(url: String) {
        val u = Uri.parse(url)
        if (u.scheme != "http" && u.scheme != "https") return
        main.post {
            try { ctx.startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: ActivityNotFoundException) {}
        }
    }
}

/**
 * The canvas UI is the exact same code that runs on the TV, bundled in the APK (assets/web) and served from a
 * private origin through WebViewAssetLoader. It talks to the Pi directly over HTTP/WebSocket with this phone's token.
 */
// onRenderProcessGone is implemented below. androidx.webkit's lint rule flags every `WebViewClient()` constructor
// call, which includes the one in Kotlin's `object : WebViewClient()`, so it cannot see that.
@SuppressLint("SetJavaScriptEnabled", "MissingOnRenderProcessGone")
@Composable
fun BoardWebView(
    mode: String,
    boardId: String?,
    serverUrl: String,
    token: String,
    deviceName: String,
    controller: WebController,
    modifier: Modifier = Modifier,
    onEvent: (WebEvent) -> Unit = {},
) {
    val event by rememberUpdatedState(onEvent)
    var fileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        fileCallback?.onReceiveValue(uris.toTypedArray())
        fileCallback = null
    }
    val currentBoard by rememberUpdatedState(boardId)
    // Bumped when Android kills or crashes the page's renderer, to build a fresh WebView in place of the dead one.
    var renderEpoch by remember { mutableIntStateOf(0) }

    // A new address (the phone moved from home Wi-Fi to Tailscale) or a new pairing rebuilds the page against it.
    // Unsent edits survive: the page keeps them in its offline outbox.
    key(serverUrl, token, renderEpoch) {
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
            val loader = WebViewAssetLoader.Builder()
                .setDomain("appassets.androidplatform.net")
                .setHttpAllowed(true)
                .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(ctx))
                .build()
            WebView(ctx).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                setBackgroundColor(O.Bg.toArgb())
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false
                overScrollMode = WebView.OVER_SCROLL_NEVER
                settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    mediaPlaybackRequiresUserGesture = false
                    allowFileAccess = false
                    allowContentAccess = false
                    builtInZoomControls = false
                    displayZoomControls = false
                    setSupportZoom(false)
                    cacheMode = WebSettings.LOAD_DEFAULT
                    offscreenPreRaster = true
                }
                val cfg = JSONObject().put("token", token).put("host", serverUrl).put("mode", mode).toString()
                addJavascriptInterface(WebBridge(ctx, cfg) { e -> event(e) }, "OBoardHost")
                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                        if (request.url.host == "appassets.androidplatform.net") {
                            loader.shouldInterceptRequest(request.url)?.also { r ->
                                // Widget frames have an opaque origin; fonts load in CORS mode, so let them use the board's typeface.
                                if (request.url.path?.endsWith(".woff2") == true) r.responseHeaders = (r.responseHeaders ?: emptyMap()) + ("Access-Control-Allow-Origin" to "*")
                            }
                        } else null

                    // The renderer died: it crashed, or Android reclaimed its memory (more likely with many widgets open).
                    // Without this the whole app would crash. The dead view must not be used again; a new key builds
                    // a fresh one, and edits not yet sent come back from the page's offline outbox.
                    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                        android.util.Log.w("OBoard", "Board renderer gone (crashed=${detail.didCrash()}); rebuilding the board view")
                        if (controller.view === view) controller.view = null
                        renderEpoch++
                        event(WebEvent("renderer-gone", JSONObject().put("crashed", detail.didCrash())))
                        return true
                    }

                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        // Never navigate the canvas away; open external links in the browser.
                        if (request.url.host == "appassets.androidplatform.net") return false
                        runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                        return true
                    }
                }
                webChromeClient = object : WebChromeClient() {
                    override fun onShowFileChooser(webView: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                        fileCallback?.onReceiveValue(null)
                        fileCallback = callback
                        picker.launch(if (params.acceptTypes.any { it.startsWith("image") } && params.acceptTypes.size == 1) "image/*" else "*/*")
                        return true
                    }

                    override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                        if (BuildConfig.DEBUG) android.util.Log.d("Canvas", "${m.messageLevel()}: ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                        return true
                    }
                }
                val q = "mode=$mode&host=${Uri.encode(serverUrl)}&name=${Uri.encode(deviceName)}" + (boardId?.let { "&board=${Uri.encode(it)}" } ?: "")
                loadUrl("http://appassets.androidplatform.net/assets/web/index.html?$q#t=${Uri.encode(token)}")
                controller.view = this
            }
        },
        update = { view ->
            controller.view = view
        },
        onRelease = { view ->
            if (controller.view === view) controller.view = null
            // A view whose renderer is gone can throw here; it only needs to be let go.
            runCatching { view.stopLoading() }
            runCatching { view.destroy() }
        },
    )
    }

    // Switch boards inside the already-loaded page instead of reloading it.
    var lastBoard by remember { mutableStateOf(boardId) }
    if (currentBoard != lastBoard && currentBoard != null && mode == "edit") {
        lastBoard = currentBoard
        controller.openBoard(currentBoard!!)
    }

    DisposableEffect(Unit) { onDispose { fileCallback?.onReceiveValue(null) } }
}
