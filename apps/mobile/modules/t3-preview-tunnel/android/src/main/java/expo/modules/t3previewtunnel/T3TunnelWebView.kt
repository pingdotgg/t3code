package expo.modules.t3previewtunnel

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ProfileStore
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.abs

/**
 * A webview whose loopback is another environment's: `localhost` requests go to a SOCKS listener
 * in this process, which carries each connection over the environment's tunnel.
 *
 * Android's proxy override applies to every WebView in the app, so it is set while this view is
 * attached and cleared when it detaches. Other webviews here never load loopback pages. Each
 * environment gets its own WebView profile, so one environment's localhost cookies and storage
 * never reach another's.
 */
@SuppressLint("SetJavaScriptEnabled")
class T3TunnelWebView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  private val onAccessRequest by EventDispatcher()
  private val onNavigationChange by EventDispatcher()
  private val onLoadError by EventDispatcher()
  private val onPageScroll by EventDispatcher()
  private val main = Handler(Looper.getMainLooper())
  private var webView: WebView? = null
  private var listener: SocksListener? = null
  private var proxied = false
  private var pendingUrl: String? = null
  private var loading = false
  private var environmentId: String? = null
  private var reportedScrollY = 0f

  fun setEnvironment(environmentId: String) {
    if (environmentId == this.environmentId) return
    // A different environment never reuses this WebView or its profile.
    destroyWebView()
    this.environmentId = environmentId
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
      fail("This WebView cannot keep environments apart. Update Android System WebView.")
      return
    }
    val profile = "t3-preview-tunnel-$environmentId"
    ProfileStore.getInstance().getOrCreateProfile(profile)
    val webView = WebView(context)
    // The profile must be set before anything else touches this WebView.
    WebViewCompat.setProfile(webView, profile)
    webView.settings.javaScriptEnabled = true
    webView.settings.domStorageEnabled = true
    webView.webViewClient = object : WebViewClient() {
      override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) = report(true)
      override fun onPageFinished(view: WebView, url: String?) = report(false)
      override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) =
        report(null)

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError
      ) {
        if (request.isForMainFrame) fail(error.description.toString(), request.url.toString())
      }
    }
    webView.webChromeClient = object : WebChromeClient() {
      override fun onReceivedTitle(view: WebView, title: String?) = report(null)
    }
    webView.setOnScrollChangeListener { _, _, scrollY, _, _ -> reportScroll(scrollY) }
    addView(webView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    this.webView = webView
    pendingUrl?.let { loadUrl(it) }
  }

  private fun fail(description: String, url: String = "") {
    onLoadError(mapOf("code" to -1, "description" to description, "url" to url))
  }

  /** Reports the page's scroll position in steps, enough for the bar to follow its direction. */
  private fun reportScroll(scrollY: Int) {
    val y = scrollY / resources.displayMetrics.density
    val moved = abs(y - reportedScrollY) >= SCROLL_STEP_DP
    if (!moved && !(y == 0f && reportedScrollY != 0f)) return
    reportedScrollY = y
    onPageScroll(mapOf("y" to y))
  }

  private fun report(nowLoading: Boolean?) {
    val webView = webView ?: return
    if (nowLoading != null) loading = nowLoading
    onNavigationChange(
      mapOf(
        "url" to (webView.url ?: ""),
        "title" to (webView.title ?: ""),
        "loading" to loading,
        "canGoBack" to webView.canGoBack(),
        "canGoForward" to webView.canGoForward()
      )
    )
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
      fail("This WebView cannot route localhost.")
      return
    }
    val listener = SocksListener {
      TunnelAccess.request { requestId ->
        main.post { onAccessRequest(mapOf("requestId" to requestId)) }
      }
    }
    this.listener = listener
    val onSet = Runnable {
      main.post {
        // Detached before the override applied; onDetachedFromWindow already cleared it.
        if (this.listener !== listener) return@post
        proxied = true
        pendingUrl?.let { loadUrl(it) }
      }
    }
    // `*` loads everything directly, and the implicit-rule removal after it takes loopback back
    // out of that bypass, the same split the desktop app makes with `*,<-loopback>`.
    // Older WebViews reject `socks5://`; their `socks://` is SOCKS4, which the listener speaks too.
    for (scheme in listOf("socks5", "socks")) {
      val config = ProxyConfig.Builder()
        .addProxyRule("$scheme://127.0.0.1:${listener.port}")
        .addBypassRule("*")
        .removeImplicitRules()
        .build()
      val set = runCatching {
        ProxyController.getInstance().setProxyOverride(config, { it.run() }, onSet)
      }
      if (set.isSuccess) return
    }
    fail("This WebView cannot route localhost.")
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    // Cleared even when the override has not applied yet, so it never outlives this view.
    if (listener != null) {
      ProxyController.getInstance().clearProxyOverride({ it.run() }) {}
    }
    listener?.close()
    listener = null
    proxied = false
  }

  /** Called when React removes the view; a detach alone keeps the page for a reattach. */
  fun destroyWebView() {
    webView?.let {
      removeView(it)
      it.destroy()
    }
    webView = null
  }

  /** Opens `url`, even when it is the address already showing. */
  fun loadUrl(url: String) {
    val webView = webView
    if (!proxied || webView == null) {
      pendingUrl = url
      return
    }
    pendingUrl = null
    webView.loadUrl(url)
  }

  fun goBack() = main.post { webView?.goBack() }
  fun goForward() = main.post { webView?.goForward() }
  fun reload() = main.post { webView?.reload() }

  private companion object {
    const val SCROLL_STEP_DP = 24f
  }
}
