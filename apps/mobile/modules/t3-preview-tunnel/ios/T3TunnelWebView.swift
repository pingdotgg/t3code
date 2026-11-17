import ExpoModulesCore
import Network
import WebKit

/// A webview whose loopback is another environment's: `localhost` requests go to a SOCKS
/// listener in this process, which carries each connection over the environment's tunnel.
final class T3TunnelWebView: ExpoView, WKNavigationDelegate {
  let onAccessRequest = EventDispatcher()
  let onNavigationChange = EventDispatcher()
  let onLoadError = EventDispatcher()

  private var webView: WKWebView?
  private var listener: T3SocksListener?
  private var pendingUrl: String?
  private var requestedUrl: URL?
  private var observations: [NSKeyValueObservation] = []

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    let listener = T3SocksListener { [weak self] completion in
      T3TunnelAccess.shared.request(
        ask: { requestId in
          DispatchQueue.main.async { self?.onAccessRequest(["requestId": requestId]) }
        },
        completion: completion
      )
    }
    self.listener = listener
    listener.start { [weak self] port in
      DispatchQueue.main.async { self?.attachWebView(proxyPort: port) }
    }
  }

  deinit {
    listener?.stop()
  }

  private func attachWebView(proxyPort: UInt16) {
    let store = WKWebsiteDataStore.nonPersistent()
    var proxy = ProxyConfiguration(
      socksv5Proxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: proxyPort)!)
    )
    // Only loopback belongs to the environment; everything else loads directly.
    proxy.matchDomains = ["localhost", "127.0.0.1", "::1"]
    proxy.allowFailover = false
    store.proxyConfigurations = [proxy]
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = store
    let webView = WKWebView(frame: bounds, configuration: configuration)
    webView.navigationDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    webView.isInspectable = true
    addSubview(webView)
    self.webView = webView
    observations = [
      webView.observe(\.url) { [weak self] _, _ in self?.reportNavigation() },
      webView.observe(\.title) { [weak self] _, _ in self?.reportNavigation() },
      webView.observe(\.isLoading) { [weak self] _, _ in self?.reportNavigation() },
      webView.observe(\.canGoBack) { [weak self] _, _ in self?.reportNavigation() },
      webView.observe(\.canGoForward) { [weak self] _, _ in self?.reportNavigation() },
    ]
    if let pendingUrl { load(pendingUrl) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    webView?.frame = bounds
  }

  func load(_ url: String) {
    guard let webView else {
      pendingUrl = url
      return
    }
    pendingUrl = nil
    guard let target = URL(string: url), webView.url != target else { return }
    requestedUrl = target
    webView.load(URLRequest(url: target))
  }

  /// Opens `url`, even when it is the address already showing.
  func navigate(_ url: String) {
    guard let webView else {
      pendingUrl = url
      return
    }
    guard let target = URL(string: url) else { return }
    requestedUrl = target
    webView.load(URLRequest(url: target))
  }

  func goBack() { webView?.goBack() }
  func goForward() { webView?.goForward() }
  // After a failed load the webview has no URL to reload, so retry the one asked for.
  func reload() {
    guard let webView else { return }
    if webView.url == nil, let requestedUrl {
      webView.load(URLRequest(url: requestedUrl))
    } else {
      webView.reload()
    }
  }

  private func reportNavigation() {
    guard let webView else { return }
    onNavigationChange([
      "url": webView.url?.absoluteString ?? "",
      "title": webView.title ?? "",
      "loading": webView.isLoading,
      "canGoBack": webView.canGoBack,
      "canGoForward": webView.canGoForward,
    ])
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    reportError(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    reportError(error)
  }

  private func reportError(_ error: Error) {
    let error = error as NSError
    if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
    let failingUrl = error.userInfo[NSURLErrorFailingURLStringErrorKey] as? String
    onLoadError([
      "code": error.code,
      "description": error.localizedDescription,
      "url": failingUrl ?? "",
    ])
  }
}
