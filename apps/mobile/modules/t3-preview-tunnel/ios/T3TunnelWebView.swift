import CryptoKit
import ExpoModulesCore
import Network
import WebKit

/// A webview whose loopback is another environment's: `localhost` requests go to a SOCKS
/// listener in this process, which carries each connection over the environment's tunnel.
final class T3TunnelWebView: ExpoView, WKNavigationDelegate {
  let onAccessRequest = EventDispatcher()
  let onNavigationChange = EventDispatcher()
  let onLoadError = EventDispatcher()
  let onPageScroll = EventDispatcher()

  private var webView: WKWebView?
  private var listener: T3SocksListener?
  private var proxyPort: UInt16?
  private var environmentId: String?
  private var pendingUrl: String?
  private var requestedUrl: URL?
  private var observations: [NSKeyValueObservation] = []
  private var reportedScrollY: CGFloat = 0

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
      DispatchQueue.main.async {
        self?.proxyPort = port
        self?.attachWebView()
      }
    }
  }

  deinit {
    listener?.stop()
  }

  /// JavaScript remounts the view for another environment, so only the first one counts.
  func setEnvironment(_ environmentId: String) {
    guard self.environmentId == nil else { return }
    self.environmentId = environmentId
    attachWebView()
  }

  private func attachWebView() {
    guard webView == nil, let proxyPort, let environmentId else { return }
    // One lasting store per environment, so its cookies survive closing or maximizing the page
    // and never reach another environment's pages.
    let store = WKWebsiteDataStore(forIdentifier: Self.storeIdentifier(environmentId))
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
      webView.scrollView.observe(\.contentOffset) { [weak self] scrollView, _ in
        self?.reportScroll(scrollView)
      },
    ]
    if let pendingUrl { load(pendingUrl) }
  }

  private static func storeIdentifier(_ environmentId: String) -> UUID {
    var bytes = Array(SHA256.hash(data: Data("t3-preview-tunnel:\(environmentId)".utf8)).prefix(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x50
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    return NSUUID(uuidBytes: bytes) as UUID
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

  /// Reports the page's scroll position in steps, enough for the bar to follow its direction.
  private func reportScroll(_ scrollView: UIScrollView) {
    let y = max(0, scrollView.contentOffset.y + scrollView.adjustedContentInset.top)
    guard abs(y - reportedScrollY) >= 24 || (y == 0 && reportedScrollY != 0) else { return }
    reportedScrollY = y
    onPageScroll(["y": y])
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
