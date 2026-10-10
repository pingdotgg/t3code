import SwiftUI
import UIKit
import WebKit

struct FeatureAttachmentDocumentView: View {
    let source: FeatureMediaPreviewSource
    let kind: FeatureAttachmentContentKind
    let fileName: String
    var mimeType: String? = nil
    var resolveURL: (@MainActor () async throws -> URL)? = nil
    var openNative: (() -> Void)? = nil

    private struct Content: Sendable {
        let text: FeatureAttachmentText
        let lines: [FeatureSourceLine]
        let table: FeatureDelimitedPreview?
    }
    private struct Request: Equatable {
        let source: FeatureMediaPreviewSource
        let needsText: Bool
        let revision: Int
    }

    @State private var content: Content?
    @State private var errorMessage: String?
    @State private var rendered = true
    @State private var wrapsLines = false
    @State private var revision = 0
    @State private var loadedRequest: Request?

    private var delimiter: Unicode.Scalar? {
        FeatureAttachmentContentKind.delimiter(name: fileName, mimeType: mimeType)
    }
    private var hasRenderedMode: Bool { kind == .markdown || kind == .html || delimiter != nil }
    private var needsText: Bool { kind != .html || !rendered }

    var body: some View {
        VStack(spacing: 0) {
            if kind == .html, rendered, case let .file(url) = source {
                FeatureBrowserPreviewView(url: url)
                    .environment(\.openURL, OpenURLAction { url in
                        FeatureAttachmentLinkPolicy.allowsExternal(url) ? .systemAction : .discarded
                    })
            } else if let errorMessage {
                ContentUnavailableView {
                    Label("Source unavailable", systemImage: "doc.badge.ellipsis")
                } description: { Text(errorMessage) } actions: {
                    Button("Try again") { revision += 1 }
                }
            } else if let content {
                if content.text.isTruncated {
                    notice("Preview limited to the first 1 MB. Share the file to read it in full.")
                }
                if rendered, let table = content.table {
                    if table.isTruncated {
                        notice("Table limited to 100 rows, 30 columns, and 2,000 characters per cell. Source shows the captured text.")
                    }
                    tableView(table)
                } else if rendered, kind == .markdown {
                    ScrollView {
                        // Captured Markdown has no workspace authority. Only direct web
                        // media and external links can open from this document.
                        MarkdownMessageView(content.text.text, copyActionTitle: "Copy file contents")
                            .environment(\.openURL, OpenURLAction { url in
                                FeatureAttachmentLinkPolicy.allowsExternal(url) ? .systemAction : .discarded
                            })
                            .frame(maxWidth: T3Metrics.readingWidth, alignment: .leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(16)
                    }
                } else {
                    FeatureAttachmentSourceView(lines: content.lines, wrapsLines: wrapsLines)
                }
            } else {
                Text("Loading file…")
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(T3Colors.background)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if hasRenderedMode {
                        Picker("View", selection: $rendered) {
                            Text(delimiter == nil ? "Preview" : "Table").tag(true)
                            Text("Source").tag(false)
                        }
                    }
                    if !rendered || !hasRenderedMode {
                        Toggle("Wrap lines", isOn: $wrapsLines)
                    }
                    if let content {
                        Button("Copy file contents", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = content.text.text
                        }
                    }
                    if let openNative {
                        Button("Open in file viewer", systemImage: "doc") { openNative() }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("File options")
            }
        }
        .task(id: Request(source: source, needsText: needsText, revision: revision)) {
            let request = Request(source: source, needsText: needsText, revision: revision)
            guard needsText, loadedRequest != request else { return }
            content = nil
            errorMessage = nil
            do {
                let text: FeatureAttachmentText
                switch source {
                case let .file(url): text = try await FeatureAttachmentText.read(url)
                case let .remote(url): text = try await FeatureAttachmentText.read(try await resolveURL?() ?? url)
                case let .localImage(data): text = try FeatureAttachmentText.decode(data)
                }
                let delimiter = delimiter
                let language = FeatureAttachmentContentKind.sourceLanguage(name: fileName)
                let loaded = await Task.detached(priority: .userInitiated) {
                    Content(
                        text: text,
                        lines: FeatureSourceHighlighter.lines(text: text.text, language: language),
                        table: delimiter.map { FeatureDelimitedPreview(text: text.text, delimiter: $0) }
                    )
                }.value
                if kind == .markdown {
                    _ = await MarkdownRenderCache.shared.document(for: MarkdownContentRevision(text.text))
                }
                try Task.checkCancellation()
                content = loaded
                loadedRequest = request
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = error.localizedDescription
            }
        }
    }

    private func notice(_ text: String) -> some View {
        Text(text)
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
    }

    private func tableView(_ table: FeatureDelimitedPreview) -> some View {
        ScrollView([.horizontal, .vertical]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(table.rows.indices, id: \.self) { rowIndex in
                    HStack(alignment: .top, spacing: 0) {
                        ForEach(table.rows[rowIndex].indices, id: \.self) { columnIndex in
                            Text(verbatim: table.rows[rowIndex][columnIndex])
                                .font(rowIndex == 0 ? T3Typography.supportingStrong : T3Typography.supporting)
                                .frame(width: 168, alignment: .leading)
                                .padding(12)
                                .frame(maxHeight: .infinity, alignment: .topLeading)
                                .overlay { Rectangle().stroke(T3Colors.border, lineWidth: 0.5) }
                        }
                    }
                    .background(rowIndex == 0 ? T3Colors.surfaceRaised : Color.clear)
                }
            }
            .textSelection(.enabled)
        }
        .accessibilityLabel("File table")
    }
}

private struct FeatureAttachmentSourceView: View {
    let lines: [FeatureSourceLine]
    let wrapsLines: Bool

    var body: some View {
        GeometryReader { geometry in
            ScrollView(wrapsLines ? [.vertical] : [.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(lines) { line in
                        HStack(alignment: .top, spacing: 10) {
                            Text("\(line.number)")
                                .foregroundStyle(T3Colors.textTertiary)
                                .frame(width: 44, alignment: .trailing)
                                .accessibilityHidden(true)
                            highlighted(line)
                                .fixedSize(horizontal: !wrapsLines, vertical: true)
                                .frame(maxWidth: wrapsLines ? .infinity : nil, alignment: .leading)
                        }
                        .frame(minHeight: 22, alignment: .topLeading)
                    }
                }
                .frame(width: wrapsLines ? max(0, geometry.size.width - 14) : nil, alignment: .leading)
                .frame(minWidth: max(0, geometry.size.width - 14), alignment: .leading)
                .padding(.vertical, 10)
                .padding(.trailing, 14)
                .font(T3Typography.code)
                .t3CodeTextSize()
                .textSelection(.enabled)
            }
        }
        .accessibilityLabel("Source file")
    }

    private func highlighted(_ line: FeatureSourceLine) -> Text {
        line.spans.reduce(Text(line.spans.isEmpty ? " " : "")) { text, span in
            let color: Color = switch span.kind {
            case .plain: T3Colors.textPrimary
            case .comment: T3Colors.textTertiary
            case .keyword: T3Colors.syntaxKeyword
            case .literal: T3Colors.syntaxLiteral
            case .number: T3Colors.syntaxNumber
            case .property: T3Colors.syntaxProperty
            }
            return text + Text(verbatim: span.text).foregroundColor(color)
        }
    }
}

enum FeatureAttachmentLinkPolicy {
    static func allowsExternal(_ url: URL) -> Bool {
        ["https", "http", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "")
    }
}

struct FeatureBrowserPreviewView: View {
    let url: URL
    var resolveURL: (@MainActor () async throws -> URL)? = nil
    @State private var resolvedURL: URL?
    @State private var errorMessage: String?
    @State private var revision = 0
    @SwiftUI.Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if let errorMessage {
                ContentUnavailableView {
                    Label("Preview unavailable", systemImage: "doc.badge.ellipsis")
                } description: { Text(errorMessage) } actions: {
                    Button("Try again") { revision += 1 }
                }
            } else if let resolvedURL {
                FeatureHTMLPreviewView(url: resolvedURL) { errorMessage = $0 }
            } else {
                Text("Loading preview…").foregroundStyle(T3Colors.textSecondary)
            }
        }
        .task(id: revision) {
            resolvedURL = nil
            errorMessage = nil
            do {
                let resolved = try await resolveURL?() ?? url
                try Task.checkCancellation()
                resolvedURL = resolved
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = error.localizedDescription
            }
        }
        .onChange(of: url) { _, _ in revision += 1 }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, resolveURL != nil { revision += 1 }
        }
    }
}

/// Captured HTML has access only to its own file. Workspace documents keep their signed
/// remote URL so their relative assets resolve on the host, without client session cookies.
private struct FeatureHTMLPreviewView: UIViewRepresentable {
    let url: URL
    let onFailure: (String) -> Void
    @SwiftUI.Environment(\.openURL) private var openURL

    func makeCoordinator() -> Coordinator { Coordinator(url: url, openURL: openURL, onFailure: onFailure) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.backgroundColor = .black
        view.navigationDelegate = context.coordinator
        load(view)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.url != url else { return }
        context.coordinator.url = url
        load(view)
    }

    private func load(_ view: WKWebView) {
        if url.isFileURL { view.loadFileURL(url, allowingReadAccessTo: url) }
        else { view.load(URLRequest(url: url)) }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var url: URL
        let openURL: OpenURLAction
        let onFailure: (String) -> Void
        init(url: URL, openURL: OpenURLAction, onFailure: @escaping (String) -> Void) {
            self.url = url
            self.openURL = openURL
            self.onFailure = onFailure
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { onFailure(error.localizedDescription) }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { onFailure(error.localizedDescription) }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor response: WKNavigationResponse,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
        ) {
            if response.isForMainFrame, let http = response.response as? HTTPURLResponse,
               !(200...299).contains(http.statusCode) {
                onFailure(FeatureMediaPreviewError.httpStatus(http.statusCode).localizedDescription)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor action: WKNavigationAction,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
        ) {
            guard let target = action.request.url else { decisionHandler(.cancel); return }
            if target.isFileURL, target.standardizedFileURL.path == url.standardizedFileURL.path {
                decisionHandler(.allow)
                return
            }
            if !url.isFileURL, ["http", "https"].contains(target.scheme?.lowercased() ?? ""),
               target.scheme == url.scheme, target.host == url.host, target.port == url.port {
                decisionHandler(.allow)
                return
            }
            if action.navigationType == .linkActivated, FeatureAttachmentLinkPolicy.allowsExternal(target) {
                openURL(target)
            }
            decisionHandler(.cancel)
        }
    }
}
