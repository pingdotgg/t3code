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
  private var proxyPort: UInt16?
  private var environmentId: String?
  private var pendingUrl: String?
  private var requestedUrl: URL?
  /// A link that failed before its page committed leaves the old page current, so retry it.
  private var failedUrl: URL?
  private var observations: [NSKeyValueObservation] = []
  private var reportedScrollY: CGFloat = 0
  private var tallestTopInset: CGFloat = 0
  private var topInset: CGFloat = 0

  /// JavaScript remounts the view for another environment, so only the first one counts.
  func setEnvironment(_ environmentId: String) {
    guard self.environmentId == nil else { return }
    self.environmentId = environmentId
    T3EnvironmentProxy.forEnvironment(environmentId).attach(self) { [weak self] port in
      self?.proxyPort = port
      self?.attachWebView()
    }
  }

  private func attachWebView() {
    guard webView == nil, let proxyPort, let environmentId else { return }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = T3EnvironmentProxy.forEnvironment(environmentId)
      .store(proxyPort: proxyPort)
    let webView = WKWebView(frame: bounds, configuration: configuration)
    webView.navigationDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    // The page scrolls under the browser bar, like Safari; `topInset` keeps its top clear.
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.isOpaque = false
    applyTopInset(to: webView)
    webView.isInspectable = true
    addSubview(webView)
    self.webView = webView
    observations = [
      webView.observe(\.url) { [weak self] _, _ in self?.reportNavigation() },
      webView.observe(\.title) { [weak self] _, _ in self?.reportNavigation() },
      webView.observe(\.isLoading) { [weak self] _, _ in self?.reportNavigation() },
      webView.observe(\.canGoBack) { [weak self] _, _ in self?.reportNavigation() },
      webView.observe(\.canGoForward) { [weak self] _, _ in self?.reportNavigation() },
      webView.observe(\.themeColor) { [weak self] _, _ in self?.reportNavigation() },
      webView.observe(\.underPageBackgroundColor) { [weak self] _, _ in self?.reportNavigation() },
      webView.scrollView.observe(\.contentOffset) { [weak self] scrollView, _ in
        self?.reportScroll(scrollView)
      },
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
    guard let target = URL(string: url).map(T3Loopback.standIn), webView.url != target else {
      return
    }
    requestedUrl = target
    webView.load(URLRequest(url: target))
  }

  /// Opens `url`, even when it is the address already showing.
  func navigate(_ url: String) {
    guard let webView else {
      pendingUrl = url
      return
    }
    guard let target = URL(string: url).map(T3Loopback.standIn) else { return }
    requestedUrl = target
    webView.load(URLRequest(url: target))
  }

  func setTopInset(_ inset: CGFloat) {
    guard inset != topInset else { return }
    topInset = inset
    tallestTopInset = max(tallestTopInset, inset)
    if let webView { applyTopInset(to: webView) }
  }

  /// A page resting at its top stays there when the bar grows or shrinks.
  private func applyTopInset(to webView: WKWebView) {
    let scrollView = webView.scrollView
    let atTop = scrollView.contentOffset.y <= -scrollView.contentInset.top + 1
    scrollView.contentInset.top = topInset
    scrollView.verticalScrollIndicatorInsets.top = topInset
    if atTop { scrollView.contentOffset.y = -topInset }
  }

  func goBack() { webView?.goBack() }
  func goForward() { webView?.goForward() }
  // After a failed load the webview may show no page or the previous one, so retry what failed.
  func reload() {
    guard let webView else { return }
    if let target = failedUrl ?? (webView.url == nil ? requestedUrl : nil) {
      failedUrl = nil
      webView.load(URLRequest(url: target))
    } else {
      webView.reload()
    }
  }

  /// Reports the page's scroll position in steps, enough for the bar to follow its direction.
  private func reportScroll(_ scrollView: UIScrollView) {
    // Measured from the tallest bar, so the bar resizing itself never reads as a scroll.
    let y = max(0, scrollView.contentOffset.y + tallestTopInset)
    guard abs(y - reportedScrollY) >= 24 || (y == 0 && reportedScrollY != 0) else { return }
    reportedScrollY = y
    onPageScroll(["y": y])
  }

  private func reportNavigation() {
    guard let webView else { return }
    onNavigationChange([
      "url": webView.url.map(T3Loopback.shown)?.absoluteString ?? "",
      "title": webView.title ?? "",
      "loading": webView.isLoading,
      "canGoBack": webView.canGoBack,
      "canGoForward": webView.canGoForward,
      // What Safari tints its bar with: the page's theme-color, else its background.
      "pageColor": Self.hex(webView.themeColor ?? webView.underPageBackgroundColor) ?? "",
    ])
  }

  private static func hex(_ color: UIColor?) -> String? {
    var (red, green, blue, alpha): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
    guard let color, color.getRed(&red, green: &green, blue: &blue, alpha: &alpha), alpha > 0
    else { return nil }
    let byte = { (value: CGFloat) in Int((min(max(value, 0), 1) * 255).rounded()) }
    return String(format: "#%02x%02x%02x", byte(red), byte(green), byte(blue))
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    let nsError = error as NSError
    if !(nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled) {
      let failing = nsError.userInfo[NSURLErrorFailingURLStringErrorKey] as? String
      failedUrl = failing.flatMap(URL.init(string:)) ?? requestedUrl
    }
    reportError(error)
  }

  /// Links and redirects to loopback go to the stand-in host, which is the one the proxy carries.
  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
  ) {
    let url = navigationAction.request.url
    guard let url, navigationAction.targetFrame?.isMainFrame ?? true,
      T3Loopback.standIn(url) != url
    else { return decisionHandler(.allow) }
    decisionHandler(.cancel)
    navigate(url.absoluteString)
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    failedUrl = nil
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    reportError(error)
  }

  private func reportError(_ error: Error) {
    let error = error as NSError
    if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
    let failingUrl = (error.userInfo[NSURLErrorFailingURLStringErrorKey] as? String)
      .flatMap(URL.init(string:)).map(T3Loopback.shown)?.absoluteString
    onLoadError([
      "code": error.code,
      "description": error.localizedDescription,
      "url": failingUrl ?? "",
      "debug": "\(error.domain) \(error.code), port \(proxyPort.map(String.init) ?? "none"), " + T3TunnelDiagnostics.shared.summary,
    ])
  }
}

/// Each environment keeps one listener on one port for the app's life, restarted there if iOS tore
/// it down, and one in-memory data store pointed at it, so cookies survive closing or maximizing a
/// page and never reach another environment's pages. A store saved on disk kept an old launch's
/// proxy port on devices. Access requests go to the newest live view. Main thread only.
private final class T3EnvironmentProxy {
  nonisolated(unsafe) private static var proxies: [String: T3EnvironmentProxy] = [:]

  static func forEnvironment(_ environmentId: String) -> T3EnvironmentProxy {
    if let proxy = proxies[environmentId] { return proxy }
    let proxy = T3EnvironmentProxy()
    proxies[environmentId] = proxy
    return proxy
  }

  private var views: [WeakView] = []
  private var listener: T3SocksListener?
  private var port: UInt16?
  private var waiting: [(UInt16) -> Void] = []
  private var dataStore: WKWebsiteDataStore?

  func store(proxyPort: UInt16) -> WKWebsiteDataStore {
    if let dataStore { return dataStore }
    let store = WKWebsiteDataStore.nonPersistent()
    var proxy = ProxyConfiguration(
      socksv5Proxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: proxyPort)!)
    )
    // Only the stand-in host belongs to the environment; everything else loads directly.
    proxy.matchDomains = [T3Loopback.standInHost]
    proxy.allowFailover = false
    store.proxyConfigurations = [proxy]
    dataStore = store
    return store
  }

  func attach(_ view: T3TunnelWebView, onReady: @escaping (UInt16) -> Void) {
    views = views.filter { $0.view != nil } + [WeakView(view: view)]
    if let port, listener?.isListening == true { return onReady(port) }
    waiting.append(onReady)
    guard waiting.count == 1 else { return }
    listener?.stop()
    let listener = T3SocksListener { [weak self] completion in
      T3TunnelAccess.shared.request(
        ask: { requestId in
          DispatchQueue.main.async {
            guard let view = self?.views.last(where: { $0.view != nil })?.view else {
              return T3TunnelAccess.shared.resolve(requestId: requestId, url: nil)
            }
            view.onAccessRequest(["requestId": requestId])
          }
        },
        completion: completion
      )
    }
    self.listener = listener
    listener.start(port: port) { [weak self] port in
      DispatchQueue.main.async { self?.ready(port) }
    }
  }

  private func ready(_ port: UInt16) {
    self.port = port
    let waiting = self.waiting
    self.waiting = []
    for onReady in waiting { onReady(port) }
  }
}

private struct WeakView {
  weak var view: T3TunnelWebView?
}

/// Real iPhones never send loopback addresses to a webview's proxy (the simulator does), so the
/// view loads them under a stand-in host the proxy does carry, and shows `localhost` instead.
/// It is as long as `localhost`, so the proxy can swap the two in plain HTTP without
/// changing a message's length.
enum T3Loopback {
  static let standInHost = "t3lo.test"

  static func isLoopbackHost(_ host: String) -> Bool {
    let host = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    if host == "localhost" || host.hasSuffix(".localhost") { return true }
    if let address = IPv4Address(host) { return address.rawValue.first == 127 }
    if let address = IPv6Address(host) { return address.isLoopback }
    return false
  }

  static func standIn(_ url: URL) -> URL {
    guard let host = url.host(percentEncoded: false), isLoopbackHost(host) else { return url }
    return replacingHost(url, with: standInHost)
  }

  static func shown(_ url: URL) -> URL {
    guard url.host(percentEncoded: false)?.lowercased() == standInHost else { return url }
    return replacingHost(url, with: "localhost")
  }

  private static func replacingHost(_ url: URL, with host: String) -> URL {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return url
    }
    components.host = host
    return components.url ?? url
  }
}
