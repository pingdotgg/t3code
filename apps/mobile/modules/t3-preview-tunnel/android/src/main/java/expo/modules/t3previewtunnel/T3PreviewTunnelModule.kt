package expo.modules.t3previewtunnel

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class T3PreviewTunnelModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3PreviewTunnel")

    Function("resolveAccess") { requestId: String, url: String? ->
      TunnelAccess.resolve(requestId, url)
    }

    View(T3TunnelWebView::class) {
      Events("onAccessRequest", "onNavigationChange", "onLoadError", "onPageScroll")

      OnViewDestroys { view: T3TunnelWebView -> view.destroyWebView() }

      Prop("environmentId") { view: T3TunnelWebView, environmentId: String ->
        view.setEnvironment(environmentId)
      }
      Prop("url") { view: T3TunnelWebView, url: String -> view.loadUrl(url) }

      AsyncFunction("loadUrl") { view: T3TunnelWebView, url: String ->
        view.post { view.loadUrl(url) }
      }

      AsyncFunction("goBack") { view: T3TunnelWebView -> view.goBack() }
      AsyncFunction("goForward") { view: T3TunnelWebView -> view.goForward() }
      AsyncFunction("reload") { view: T3TunnelWebView -> view.reload() }
    }
  }
}

/**
 * Pending asks for a tunnel URL. JavaScript owns the environment's credentials and the route in
 * use, so every connection asks it for a freshly ticketed URL.
 */
internal object TunnelAccess {
  private val pending = ConcurrentHashMap<String, CompletableFuture<String?>>()
  private val nextId = AtomicInteger()

  /** Blocks the calling connection thread until JavaScript answers or 15 seconds pass. */
  fun request(ask: (String) -> Unit): String? {
    val requestId = "preview-tunnel-${nextId.incrementAndGet()}"
    val answer = CompletableFuture<String?>()
    pending[requestId] = answer
    return try {
      ask(requestId)
      answer.get(15, TimeUnit.SECONDS)
    } catch (_: Exception) {
      null
    } finally {
      pending.remove(requestId)
    }
  }

  fun resolve(requestId: String, url: String?) {
    pending[requestId]?.complete(url)
  }
}
