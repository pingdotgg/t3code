import SwiftUI
import WebKit

@MainActor
final class RemoteDeviceStreamController {
    fileprivate weak var webView: WKWebView?

    func send(_ command: RemoteDeviceStreamCommand) {
        webView?.evaluateJavaScript(command.javaScript, completionHandler: nil)
    }

    func stop() {
        webView?.evaluateJavaScript("window.T3DeviceStream?.stop(); true;", completionHandler: nil)
    }
}

/// Uses the RN viewer's shared media/input transport. No polling screenshots or
/// independent copy of the hub's input and video protocols lives in this app.
struct RemoteDeviceStreamWebView: UIViewRepresentable {
    let connection: FeatureRemoteDeviceConnection
    let controller: RemoteDeviceStreamController
    let onMessage: (RemoteDeviceStreamMessage) -> Void
    let onProcessTerminated: () -> Void
    let onShake: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        // Match RN's allowUniversalAccessFromFileURLs: the bundled document
        // primes the authenticated iOS helper with an absolute HTTP request.
        configuration.setValue(true, forKey: "allowUniversalAccessFromFileURLs")
        configuration.userContentController.add(context.coordinator, name: "deviceStream")
        let view = ShakeWebView(frame: .zero, configuration: configuration)
        view.onShake = onShake
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.backgroundColor = .black
        view.scrollView.isScrollEnabled = false
        view.scrollView.bounces = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.allowsBackForwardNavigationGestures = false
        controller.webView = view
        context.coordinator.webView = view
        context.coordinator.load(view)
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.parent = self
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        coordinator.active = false
        coordinator.bootstrapTask?.cancel()
        uiView.evaluateJavaScript("window.T3DeviceStream?.stop(); true;", completionHandler: nil)
        uiView.stopLoading()
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "deviceStream")
        uiView.navigationDelegate = nil
        // Navigating away tears down open media bodies and sockets even if JS stopped responding.
        uiView.loadHTMLString("", baseURL: nil)
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: RemoteDeviceStreamWebView
        weak var webView: WKWebView?
        var active = true
        var failed = false
        var bootstrapTask: Task<Void, Never>?

        init(_ parent: RemoteDeviceStreamWebView) { self.parent = parent }

        func load(_ view: WKWebView) {
            do {
                guard let url = Bundle.main.url(forResource: "T3DeviceStream", withExtension: "js") else {
                    throw RemoteDeviceError.missingStreamResource
                }
                let script = try String(contentsOf: url, encoding: .utf8)
                let document = try RemoteDeviceStreamDocument.html(connection: parent.connection, script: script)
                // Match RN's iOS document origin. Media and sockets use absolute
                // environment URLs with tickets; no local host address is baked in.
                view.loadHTMLString(document, baseURL: URL(string: "file:///"))
                bootstrapTask = Task { @MainActor [weak self] in
                    do { try await Task.sleep(for: .seconds(15)) } catch { return }
                    self?.fail("Device viewer could not start. Reconnect to try again.")
                }
            } catch {
                // UIViewRepresentable must not change observed state during creation.
                Task { @MainActor [weak self] in self?.fail(error.localizedDescription) }
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard active, !failed, message.frameInfo.isMainFrame,
                  let data = message.body as? String,
                  let event = RemoteDeviceStreamMessage(data: data) else { return }
            if case let .status(status, detail) = event {
                bootstrapTask?.cancel()
                if status == .error {
                    fail(detail ?? "Device stream failed.")
                    return
                }
            }
            parent.onMessage(event)
        }

        func fail(_ message: String) {
            guard active, !failed else { return }
            failed = true
            bootstrapTask?.cancel()
            webView?.evaluateJavaScript("window.T3DeviceStream?.stop(); true;", completionHandler: nil)
            parent.onMessage(.status(.error, message))
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.becomeFirstResponder()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            fail("Device viewer could not load. Reconnect to try again.")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            fail("Device viewer could not load. Reconnect to try again.")
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            guard active, !failed else { return }
            bootstrapTask?.cancel()
            parent.onProcessTerminated()
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            let url = navigationAction.request.url?.absoluteString
            decisionHandler(url == "about:blank" || url == "file:///" ? .allow : .cancel)
        }
    }

    private final class ShakeWebView: WKWebView {
        var onShake: (() -> Void)?
        override var canBecomeFirstResponder: Bool { true }

        override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
            if motion == .motionShake { onShake?() }
            else { super.motionEnded(motion, with: event) }
        }
    }
}
