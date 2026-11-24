import SwiftUI
import WebKit

struct SandboxedPage: UIViewRepresentable {
    let url: URL
    let title: String
    let session: ThreadMcpApp?
    let fullscreen: Bool
    let onFailure: () -> Void

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        if session != nil {
            configuration.userContentController.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "connApp")
        }
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.scrollView.backgroundColor = .clear
        view.accessibilityLabel = title
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.url != url else { return }
        context.coordinator.onFailure = onFailure
        context.coordinator.allowsOuterDocument = true
        context.coordinator.url = url
        context.coordinator.session = session
        let src = url.absoluteString.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "<", with: "&lt;")
        // Only the outer document may relay to native. The signed child retains its server CSP and opaque origin.
        view.loadHTMLString("""
        <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>:root{color-scheme:light dark}body{margin:0}iframe{display:block;border:0;width:100vw;height:100vh}</style>
        <iframe id="app" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" src="\(src)"></iframe>
        \(session == nil ? "" : Self.host(fullscreen: fullscreen))
        """, baseURL: nil)
    }

    private static func host(fullscreen: Bool) -> String {
        """
        <script>
        const frame=document.querySelector('iframe');
        const post=m=>frame.contentWindow.postMessage({jsonrpc:'2.0',...m},'*');
        const request=(method,params)=>window.webkit.messageHandlers.connApp.postMessage({method,params});
        let initialized=false;
        addEventListener('message',async event=>{
          const m=event.data;
          if(event.source!==frame.contentWindow || !m || m.jsonrpc!=='2.0') return;
          try {
            if(m.method==='ui/initialize') {
              post({id:m.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'Conn iOS',version:'1'},
                hostCapabilities:{serverTools:{},serverResources:{}},hostContext:{platform:'mobile',
                displayMode:'\(fullscreen ? "fullscreen" : "inline")',theme:matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'}}});
            } else if(m.method==='ui/notifications/initialized' && !initialized) {
              initialized=true;
              const call=JSON.parse(await request('initial',{}));
              post({method:'ui/notifications/tool-input',params:{arguments:call.arguments || {}}});
              if(call.result) {
                const result={content:call.result.content || []};
                for(const key of ['structuredContent','isError','_meta']) if(call.result[key]!=null) result[key]=call.result[key];
                post({method:'ui/notifications/tool-result',params:result});
              }
            } else if(m.id!=null) {
              if(initialized && ['tools/call','resources/read'].includes(m.method)) {
                post({id:m.id,result:JSON.parse(await request(m.method,m.params || {}))});
              } else post({id:m.id,error:{code:-32601,message:'Unsupported host method'}});
            }
          } catch(e) { if(m.id!=null) post({id:m.id,error:{code:-32000,message:String(e)}}); }
        });
        </script>
        """
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
        var url: URL?
        var session: ThreadMcpApp?
        var onFailure: (() -> Void)?
        var allowsOuterDocument = true
        var pending = 0
        var confirmation: CheckedContinuation<Bool, Never>?
        weak var alert: UIAlertController?

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            // A new child document must never inherit the original app's RPC rights.
            if action.targetFrame?.isMainFrame == true, allowsOuterDocument, action.request.url?.absoluteString == "about:blank" {
                allowsOuterDocument = false
                decisionHandler(.allow)
            } else if action.targetFrame?.isMainFrame == false, action.request.url == url {
                decisionHandler(.allow)
            } else { decisionHandler(.cancel) }
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            if response.isForMainFrame {
                return response.response.url?.absoluteString == "about:blank" ? .allow : .cancel
            }
            guard response.response.url == url, let http = response.response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                session = nil
                onFailure?()
                return .cancel
            }
            return .allow
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                                   replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
            guard message.frameInfo.isMainFrame, let session, let request = message.body as? [String: Any],
                  let method = request["method"] as? String, let params = request["params"] as? [String: Any],
                  pending < 8 else { replyHandler(nil, "Request unavailable"); return }
            pending += 1
            Task { @MainActor in
                defer { pending -= 1 }
                do {
                    let result: String
                    switch method {
                    case "initial": result = session.toolPayload()
                    case "resources/read":
                        guard let uri = params["uri"] as? String else { throw URLError(.badURL) }
                        result = try await session.readResource(uri: uri)
                    case "tools/call":
                        guard let name = params["name"] as? String,
                              let arguments = (params["arguments"] ?? [:]) as? [String: Any] else { throw URLError(.badServerResponse) }
                        let bytes = try JSONSerialization.data(withJSONObject: arguments, options: [.prettyPrinted, .sortedKeys])
                        guard bytes.count <= 256 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
                        let args = String(decoding: bytes, as: UTF8.self)
                        let info = try await session.toolInfo(name: name)
                        var confirmed = false
                        if !info.readOnly {
                            guard let view = message.webView, self.session === session else { throw CancellationError() }
                            confirmed = await confirm(info.title, arguments: args, in: view)
                            guard confirmed else { throw CancellationError() }
                        }
                        guard self.session === session else { throw CancellationError() }
                        result = try await session.callTool(name: name, arguments: args, confirmed: confirmed)
                    default: throw URLError(.unsupportedURL)
                    }
                    guard self.session === session else { throw CancellationError() }
                    replyHandler(result, nil)
                } catch { replyHandler(nil, error.localizedDescription) }
            }
        }

        private func confirm(_ tool: String, arguments: String, in view: WKWebView) async -> Bool {
            guard confirmation == nil, var presenter = view.window?.rootViewController else { return false }
            while let next = presenter.presentedViewController { presenter = next }
            let dialog = UIAlertController(title: "Allow this app to run \(tool)?", message: arguments, preferredStyle: .alert)
            dialog.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in self.finishConfirmation(false) })
            dialog.addAction(UIAlertAction(title: "Allow", style: .default) { _ in self.finishConfirmation(true) })
            return await withCheckedContinuation {
                confirmation = $0
                alert = dialog
                presenter.present(dialog, animated: true)
            }
        }

        func finishConfirmation(_ allowed: Bool) {
            confirmation?.resume(returning: allowed)
            confirmation = nil
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.session = nil
        coordinator.finishConfirmation(false)
        coordinator.alert?.dismiss(animated: false)
        view.configuration.userContentController.removeScriptMessageHandler(forName: "connApp", contentWorld: .page)
        view.stopLoading()
    }
}
