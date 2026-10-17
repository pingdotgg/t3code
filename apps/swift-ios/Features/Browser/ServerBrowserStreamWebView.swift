import SwiftUI
import WebKit

@MainActor
final class ServerBrowserStreamController {
    fileprivate weak var webView: WKWebView?

    func send(_ command: ServerBrowserStreamCommand, state: ServerBrowserStreamState) {
        guard state.permits(command) else { return }
        webView?.evaluateJavaScript(command.javaScript, completionHandler: nil)
    }

    func stop() { webView?.evaluateJavaScript("window.T3BrowserStream?.stop(); true;", completionHandler: nil) }
}

/// Loads only the bundled viewer. The remote page runs in server Chromium.
struct ServerBrowserStreamWebView: UIViewRepresentable {
    let connection: FeatureServerBrowserConnection
    let controller: ServerBrowserStreamController
    let onMessage: (ServerBrowserStreamMessage) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setValue(true, forKey: "allowUniversalAccessFromFileURLs")
        configuration.userContentController.add(context.coordinator, name: "browserStream")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.backgroundColor = .black
        view.scrollView.isScrollEnabled = false
        view.scrollView.bounces = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        controller.webView = view
        context.coordinator.webView = view
        context.coordinator.load(view)
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) { context.coordinator.parent = self }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        coordinator.active = false
        uiView.evaluateJavaScript("window.T3BrowserStream?.stop(); true;", completionHandler: nil)
        uiView.stopLoading()
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "browserStream")
        uiView.navigationDelegate = nil
        // Tear down sockets even if the WebKit process no longer answers JS.
        uiView.loadHTMLString("", baseURL: nil)
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: ServerBrowserStreamWebView
        weak var webView: WKWebView?
        var active = true
        var failed = false

        init(_ parent: ServerBrowserStreamWebView) { self.parent = parent }

        func load(_ view: WKWebView) {
            do {
                guard let url = Bundle.main.url(forResource: "T3BrowserStream", withExtension: "js") else {
                    throw ServerBrowserError.missingResource
                }
                let document = try ServerBrowserStreamDocument.html(
                    connection: parent.connection, script: String(contentsOf: url, encoding: .utf8)
                )
                view.loadHTMLString(document, baseURL: URL(string: "file:///"))
            } catch {
                Task { @MainActor [weak self] in self?.fail(error.localizedDescription) }
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard active, !failed, message.frameInfo.isMainFrame,
                  let data = message.body as? String,
                  let event = ServerBrowserStreamMessage(data: data) else { return }
            parent.onMessage(event)
            switch event {
            case .hostSetup, .gone, .unauthorized, .status(.error, _):
                failed = true
                webView?.evaluateJavaScript("window.T3BrowserStream?.stop(); true;", completionHandler: nil)
            default: break
            }
        }

        func fail(_ detail: String) {
            guard active, !failed else { return }
            failed = true
            webView?.evaluateJavaScript("window.T3BrowserStream?.stop(); true;", completionHandler: nil)
            parent.onMessage(.status(.error, detail))
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            fail("Browser viewer stopped. Reconnect to try again.")
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            fail("Browser viewer could not load. Reconnect to try again.")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            fail("Browser viewer could not load. Reconnect to try again.")
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            let url = navigationAction.request.url?.absoluteString
            decisionHandler(url == "about:blank" || url == "file:///" ? .allow : .cancel)
        }
    }
}
