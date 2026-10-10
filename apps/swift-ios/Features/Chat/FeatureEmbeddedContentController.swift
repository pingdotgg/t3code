import Combine
import Foundation
import SwiftUI
import UIKit
import WebKit

/// One controller owns one document. All callbacks are bound to its native item identity.
@MainActor
final class FeatureEmbeddedContentController: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    struct Confirmation: Identifiable {
        let id = UUID()
        let title: String
        let detail: String
        let answer: (Bool) -> Void
    }
    struct SharedFiles: Identifiable { let id = UUID(); let urls: [URL] }
    @Published var webView: WKWebView?
    @Published var failure: String?
    @Published var confirmation: Confirmation?
    @Published var sharedFiles: SharedFiles?
    @Published var fullscreen = false
    @Published var closed = false
    let item: FeatureV2WorkItem
    let reference: FeatureEmbeddedContent
    var context: FeatureEmbeddedContentContext
    private(set) var documentID = UUID().uuidString
    private var signedAsset: ResolvedAssetURL?
    private var recoveredLoad = false
    private var recoveredCrash = false
    private var requests: [Int: Task<Void, Never>] = [:]
    private var loadTask: Task<Void, Never>?
    private var downloadNames: [String]?
    private var pendingDownloadURLs: [URL] = []
    private var temporaryDirectory: URL?
    private var changingMode = false
    private var active = true
    private var visible = true
    private var contentObservation: NSKeyValueObservation?

    init(item: FeatureV2WorkItem, reference: FeatureEmbeddedContent, context: FeatureEmbeddedContentContext) {
        self.item = item; self.reference = reference; self.context = context
        super.init()
    }

    static let themeVariables: [String: String] = [
        "--background": "#000000", "--foreground": "#ffffff", "--muted": "#171717",
        "--muted-foreground": "#a3a3a3", "--card": "#101010", "--card-foreground": "#ffffff",
        "--popover": "#171717", "--popover-foreground": "#ffffff", "--secondary": "#262626",
        "--secondary-foreground": "#ffffff", "--border": "#303030", "--input": "#303030",
        "--ring": "#60a5fa", "--primary": "#ffffff", "--primary-foreground": "#000000",
        "--accent": "#60a5fa", "--accent-foreground": "#000000", "--accent-surface": "#172554",
        "--accent-surface-foreground": "#bfdbfe", "--destructive": "#ef4444",
        "--destructive-foreground": "#fca5a5", "--destructive-surface": "#450a0a",
        "--warning": "#f59e0b", "--warning-foreground": "#fcd34d", "--warning-surface": "#451a03",
        "--success": "#10b981", "--success-foreground": "#34d399", "--info": "#3b82f6",
        "--info-foreground": "#60a5fa", "--code-background": "#171717", "--code-foreground": "#ffffff",
        "--chart-1": "#60a5fa", "--chart-2": "#2dd4bf", "--chart-3": "#fbbf24",
        "--chart-4": "#c084fc", "--chart-5": "#fb7185", "--chart-6": "#a3e635",
        "--radius": "0.625rem", "--font-sans": "-apple-system, system-ui, sans-serif",
        "--font-mono": "SFMono-Regular, Menlo, monospace",
    ]

    func start(refresh: Bool = false) {
        guard visible, webView == nil, loadTask == nil else { return }
        active = true
        loadTask?.cancel()
        let token = documentID
        failure = nil; closed = false
        loadTask = Task { [weak self] in
            guard let self else { return }
            defer { if self.isCurrent(token) { self.loadTask = nil } }
            do {
                let asset: ResolvedAssetURL
                if !refresh, let cached = signedAsset, Self.canReuseAsset(cached, now: Date()) { asset = cached }
                else {
                    asset = try await context.client.embeddedAsset(threadID: context.threadID,
                        resource: .attachment(id: reference.attachmentID, fileName: reference.fileName,
                                              mimeType: "text/html", disposition: .inline))
                }
                guard isCurrent(token), !Task.isCancelled else { return }
                signedAsset = asset
                let url = asset.url
                var appConfiguration: JSONValue?
                if case let .mcp(app) = reference {
                    let full = try await context.client.embeddedItem(threadID: context.threadID, source: item.source)
                    guard FeatureEmbeddedContent.reference(raw: full) == reference else {
                        throw RPCError.protocolViolation("App result changed. Reload the thread.")
                    }
                    guard let storedResult = full["output"]?["result"], case .object = storedResult else {
                        throw RPCError.protocolViolation("App tool result is unavailable")
                    }
                    let info = try? await context.client.embeddedRequest(threadID: context.threadID,
                        source: item.source, operation: .toolInfo, payload: .object(["name": .string(app.tool)]))
                    var config: [String: JSONValue] = [
                        "documentID": .string(token), "url": .string(url.absoluteString), "app": app.raw,
                        "input": full["input"] ?? .object([:]),
                        "result": storedResult,
                        "fullscreen": .bool(fullscreen), "locale": .string(Locale.current.identifier),
                        "timeZone": .string(TimeZone.current.identifier),
                        "variables": .object(Self.themeVariables.mapValues(JSONValue.string)),
                    ]
                    config["tool"] = info?["tool"]
                    appConfiguration = .object(config)
                }
                guard isCurrent(token), !Task.isCancelled else { return }
                try mount(url: url, configuration: appConfiguration)
            } catch {
                guard isCurrent(token), !Task.isCancelled else { return }
                failure = "Content could not load. Reload to try again."
            }
        }
    }

    private func mount(url: URL, configuration: JSONValue?) throws {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        if let configuration {
            guard let scriptURL = Bundle.main.url(forResource: "T3EmbeddedContent", withExtension: "js") else {
                throw RPCError.protocolViolation("App host resource is missing")
            }
            let script = try String(contentsOf: scriptURL, encoding: .utf8)
            let data = try JSONEncoder().encode(configuration)
            let json = String(decoding: data, as: UTF8.self)
            config.userContentController.add(self, name: "embedded")
            config.userContentController.addUserScript(WKUserScript(
                source: script + "\nwindow.t3Embedded.start(" + json + ");",
                injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        let view = EmbeddedSizedWebView(frame: .zero, configuration: config)
        view.onLayout = { [weak self] view in self?.updateScroll(view) }
        view.isOpaque = false; view.backgroundColor = .black
        view.scrollView.backgroundColor = .black
        view.scrollView.bounces = false
        view.scrollView.showsVerticalScrollIndicator = false
        view.navigationDelegate = self; view.uiDelegate = self
        webView = view
        if configuration != nil {
            view.scrollView.isScrollEnabled = false
            view.loadHTMLString("<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}</style></head><body></body></html>", baseURL: nil)
        } else {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let theme = try JSONEncoder().encode(JSONValue.object([
                "appearance": .string("dark"), "variables": .object(Self.themeVariables.mapValues(JSONValue.string)),
            ]))
            let encoded = String(decoding: theme, as: UTF8.self).addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
            components?.percentEncodedFragment = "t3-theme=" + encoded
            view.load(URLRequest(url: components?.url ?? url))
            contentObservation = view.scrollView.observe(\.contentSize, options: [.new]) { [weak self, weak view] _, _ in
                Task { @MainActor in
                    guard let self, let view, view === self.webView else { return }
                    self.updateScroll(view)
                }
            }
        }
    }

    func updateScroll(_ view: WKWebView) {
        if case .html = reference {
            view.scrollView.isScrollEnabled = fullscreen || view.scrollView.contentSize.height > view.bounds.height + 2
        }
    }

    func appear() {
        visible = true
        if webView == nil, !closed, failure == nil { start() }
    }

    func disappear() async {
        visible = false
        clearSharedFiles()
        await teardown()
    }

    func reload() async {
        guard !changingMode else { return }
        changingMode = true
        defer { changingMode = false }
        await teardown()
        recoveredLoad = false; recoveredCrash = false
        start(refresh: true)
    }

    func changeMode(fullscreen requested: Bool) async {
        guard visible, !changingMode, requested != fullscreen, !requested || context.canEnterFullscreen else { return }
        changingMode = true
        await teardown()
        fullscreen = requested && visible
        changingMode = false
    }

    func close() async {
        guard !changingMode else { return }
        changingMode = true
        defer { changingMode = false }
        await teardown()
        closed = true
        fullscreen = false
    }

    func teardown() async {
        let previous = detach()
        await dispose(previous)
    }

    /// Invalidate the document before yielding, so a reappearing row can mount its replacement.
    private func detach() -> WKWebView? {
        active = false
        documentID = UUID().uuidString
        loadTask?.cancel(); loadTask = nil
        confirmation?.answer(false); confirmation = nil
        for task in requests.values { task.cancel() }
        requests.removeAll(); downloadNames = nil
        contentObservation = nil
        let previous = webView
        webView = nil
        previous?.configuration.userContentController.removeScriptMessageHandler(forName: "embedded")
        previous?.navigationDelegate = nil; previous?.uiDelegate = nil
        return previous
    }

    private func dispose(_ previous: WKWebView?) async {
        // The shared host waits up to two seconds for the app's teardown acknowledgement.
        if case .mcp = reference {
            _ = try? await previous?.callAsyncJavaScript("await window.t3Embedded?.teardown()", arguments: [:], in: nil, contentWorld: .page)
        }
        previous?.stopLoading()
    }

    func isCurrent(_ token: String) -> Bool { active && token == documentID }

    static func acceptsBridge(isMainFrame: Bool, documentID: String, expectedID: String,
                              operation: String, byteCount: Int) -> Bool {
        let allowed = ["toolInfo", "callTool", "readResource", "updateModelContext", "openLink", "sendMessage", "displayMode", "download", "close", "failure"]
        return isMainFrame && documentID == expectedID && allowed.contains(operation)
            && byteCount <= (operation == "download" ? 36 * 1024 * 1024 : 256 * 1024)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === webView, active,
              let bytes = try? JSONSerialization.data(withJSONObject: message.body),
              let body = try? JSONDecoder().decode(JSONValue.self, from: bytes),
              let token = body["documentID"]?.stringValue,
              let number = body["id"]?.embeddedNumber, let id = Int(exactly: number),
              let operation = body["operation"]?.stringValue,
              Self.acceptsBridge(isMainFrame: message.frameInfo.isMainFrame, documentID: token,
                                 expectedID: documentID, operation: operation, byteCount: bytes.count) else { return }
        // Teardown notifications must still invalidate a saturated bridge.
        if operation == "failure" || operation == "close" {
            if operation == "failure" { failure = "The app navigated to another page. Reload to reopen it." }
            Task { await close() }
            return
        }
        guard requests[id] == nil, requests.count < 16 else { return }
        let payload = body["payload"] ?? .object([:])
        requests[id] = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await handle(operation: operation, payload: payload, token: token)
                guard isCurrent(token), !Task.isCancelled else { return }
                await reply(token: token, id: id, result: result, error: nil)
                // Reply to the old host before replacing its document.
                if operation == "displayMode", let mode = result.stringValue {
                    requests[id] = nil
                    await changeMode(fullscreen: mode == "fullscreen")
                    return
                }
                if operation == "close" { requests[id] = nil; await close(); return }
            } catch {
                guard isCurrent(token), !Task.isCancelled else { return }
                await reply(token: token, id: id, result: .null, error: "Request declined or unavailable.")
            }
            requests[id] = nil
        }
    }

    private func reply(token: String, id: Int, result: JSONValue, error: String?) async {
        guard isCurrent(token), let data = try? JSONEncoder().encode(result),
              let object = try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) else { return }
        _ = try? await webView?.callAsyncJavaScript(
            "window.t3Embedded.reply(documentID, id, result, error)",
            arguments: ["documentID": token, "id": id, "result": object, "error": error as Any? ?? NSNull()],
            in: nil, contentWorld: .page)
    }

    private func confirm(_ title: String, detail: String, token: String) async throws {
        guard isCurrent(token), confirmation == nil else { throw CancellationError() }
        let approved = await withCheckedContinuation { continuation in
            confirmation = Confirmation(title: title, detail: detail) { continuation.resume(returning: $0) }
        }
        confirmation = nil
        guard approved, isCurrent(token), !Task.isCancelled else { throw CancellationError() }
    }

    func answerConfirmation(_ approved: Bool) {
        let pending = confirmation
        confirmation = nil
        pending?.answer(approved)
    }

    private func rpc(_ operation: FeatureMCPOperation, _ payload: JSONValue, token: String) async throws -> JSONValue {
        guard isCurrent(token), !Task.isCancelled else { throw CancellationError() }
        return try await context.client.embeddedRequest(threadID: context.threadID, source: item.source,
                                                       operation: operation, payload: payload)
    }

    func handle(operation: String, payload: JSONValue, token: String) async throws -> JSONValue {
        guard isCurrent(token), !Task.isCancelled else { throw CancellationError() }
        switch operation {
        case "toolInfo": return try await rpc(.toolInfo, payload, token: token)
        case "callTool":
            let info = try await rpc(.toolInfo, payload, token: token)
            guard info["callable"]?.boolValue == true else { throw CancellationError() }
            if info["readOnly"]?.boolValue != true {
                let arguments = String(decoding: try JSONEncoder().encode(payload["arguments"] ?? .object([:])), as: UTF8.self)
                try await confirm("Run \(payload["name"]?.stringValue ?? "tool")?", detail: arguments, token: token)
            }
            return try await rpc(.callTool, payload, token: token)
        case "readResource": return try await rpc(.readResource, payload, token: token)
        case "updateModelContext": return try await rpc(.updateModelContext, payload, token: token)
        case "sendMessage":
            guard let text = payload["text"]?.stringValue else { throw CancellationError() }
            try await confirm("Send message?", detail: text, token: token)
            try await context.sendMessage(text)
        case "openLink":
            guard let text = payload["url"]?.stringValue, let url = Self.externalURL(text) else { throw CancellationError() }
            try await confirm("Open link?", detail: text, token: token)
            await UIApplication.shared.open(url)
        case "displayMode":
            guard let mode = payload["mode"]?.stringValue, ["inline", "fullscreen"].contains(mode),
                  mode != "fullscreen" || context.canEnterFullscreen else { throw CancellationError() }
            return .string(mode)
        case "download":
            switch payload["phase"]?.stringValue {
            case "confirm":
                guard downloadNames == nil, case let .array(values) = payload["names"] else { throw CancellationError() }
                let names = values.compactMap(\.stringValue)
                guard names.count == values.count, !names.isEmpty, names.count <= 32 else { throw CancellationError() }
                try await confirm("Share files?", detail: names.joined(separator: "\n"), token: token)
                clearSharedFiles()
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                temporaryDirectory = directory
                downloadNames = names
            case "file":
                guard let names = downloadNames, let directory = temporaryDirectory,
                      let number = payload["index"]?.embeddedNumber, let index = Int(exactly: number),
                      index == pendingDownloadURLs.count, names.indices.contains(index),
                      payload["name"]?.stringValue == names[index],
                      let encoded = payload["base64"]?.stringValue, let data = Data(base64Encoded: encoded),
                      data.count <= 25 * 1024 * 1024 else { throw CancellationError() }
                let rawName = names[index].components(separatedBy: CharacterSet(charactersIn: "/\\").union(.controlCharacters)).joined(separator: "_")
                let name = String(rawName.prefix(160))
                let url = directory.appendingPathComponent("\(index)-\(name.isEmpty ? "download" : name)")
                try data.write(to: url, options: .atomic)
                pendingDownloadURLs.append(url)
            case "share":
                guard let names = downloadNames, pendingDownloadURLs.count == names.count else { throw CancellationError() }
                downloadNames = nil
                sharedFiles = SharedFiles(urls: pendingDownloadURLs)
                pendingDownloadURLs = []
            case "cancel": clearSharedFiles()
            default: throw CancellationError()
            }
        case "close": break
        case "failure":
            failure = "The app navigated to another page. Reload to reopen it."
            await close()
        default: throw CancellationError()
        }
        return .object([:])
    }

    func clearSharedFiles() {
        sharedFiles = nil
        downloadNames = nil
        pendingDownloadURLs = []
        if let temporaryDirectory { try? FileManager.default.removeItem(at: temporaryDirectory) }
        temporaryDirectory = nil
    }

    static func externalURL(_ text: String) -> URL? {
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(),
              ["https", "http"].contains(scheme), url.host != nil else { return nil }
        return url
    }

    private static func documentURL(_ url: URL?) -> URL? {
        guard let url else { return nil }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.fragment = nil
        return components?.url
    }

    static func canReuseAsset(_ asset: ResolvedAssetURL, now: Date) -> Bool {
        // Leave time for the new document to fetch its resource before the signature expires.
        asset.expiresAt.timeIntervalSince(now) > 60
    }

    static func isFailedDocumentResponse(_ response: URLResponse, isMainFrame: Bool, assetURL: URL?) -> Bool {
        guard let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) else { return false }
        // The MCP host is about:blank; its signed asset loads in a sandboxed iframe.
        return isMainFrame || (assetURL != nil && documentURL(response.url) == documentURL(assetURL))
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        guard webView === self.webView else { decisionHandler(.cancel); return }
        guard Self.isFailedDocumentResponse(response.response, isMainFrame: response.isForMainFrame,
                                            assetURL: signedAsset?.url) else { decisionHandler(.allow); return }
        // Handle the HTTP failure before cancelling: WebKit may then report only a cancellation.
        loadFailed(webView, error: URLError(.badServerResponse))
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard webView === self.webView else { decisionHandler(.cancel); return }
        if action.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        if action.targetFrame == nil, case .html = reference { decisionHandler(.allow); return }
        if case .mcp = reference {
            decisionHandler(action.request.url?.absoluteString == "about:blank" && action.navigationType == .other ? .allow : .cancel)
        } else {
            decisionHandler(Self.documentURL(action.request.url) == Self.documentURL(signedAsset?.url) ? .allow : .cancel)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard webView === self.webView, case .html = reference,
              let url = action.request.url, let external = Self.externalURL(url.absoluteString) else { return nil }
        // A confirmation also protects WebKit variants which classify window.open as .other.
        let token = documentID
        Task { [weak self] in
            guard let self else { return }
            do { try await confirm("Open link?", detail: external.absoluteString, token: token); await UIApplication.shared.open(external) }
            catch {}
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        updateScroll(webView)
        guard case .html = reference else { return }
        Task {
            _ = try? await webView.callAsyncJavaScript(
                "window.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme:'dark',styles:{variables}}}, '*')",
                arguments: ["variables": Self.themeVariables], in: nil, contentWorld: .page)
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { loadFailed(webView, error: error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { loadFailed(webView, error: error) }
    private func loadFailed(_ view: WKWebView, error: any Error) {
        guard view === webView, (error as NSError).code != NSURLErrorCancelled else { return }
        guard !recoveredLoad else { failure = "Content could not load. Reload to try again."; return }
        recoveredLoad = true
        signedAsset = nil
        recoverDocument(refresh: true)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        guard !recoveredCrash else { failure = "Content stopped. Reload to try again."; return }
        recoveredCrash = true
        recoverDocument(refresh: false)
    }

    private func recoverDocument(refresh: Bool) {
        let previous = detach()
        let token = documentID
        Task {
            await dispose(previous)
            // A disappearance or another teardown owns any newer document.
            guard documentID == token else { return }
            start(refresh: refresh)
        }
    }
}

@MainActor
private final class EmbeddedSizedWebView: WKWebView {
    var onLayout: ((WKWebView) -> Void)?
    override func layoutSubviews() { super.layoutSubviews(); onLayout?(self) }
}
