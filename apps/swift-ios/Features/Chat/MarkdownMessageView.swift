import SwiftUI
import UIKit

struct MarkdownImageContext: Equatable, @unchecked Sendable {
    let threadID: String
    let workspaceRoot: String
    let resolver: any FeatureWorkspaceAssetResolving
    var sourceFilePath: String? = nil

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.threadID == rhs.threadID
            && lhs.workspaceRoot == rhs.workspaceRoot
            && lhs.sourceFilePath == rhs.sourceFilePath
            && ObjectIdentifier(lhs.resolver) == ObjectIdentifier(rhs.resolver)
    }
}

/// Native chat Markdown with block-aware layout and Foundation inline parsing.
struct MarkdownMessageView: View {
    private struct RenderRequest: Hashable {
        let revision: MarkdownContentRevision
        let isStreaming: Bool
    }

    private let source: String
    private let revision: MarkdownContentRevision
    private let isStreaming: Bool
    private let copyActionTitle: String
    private let imageContext: MarkdownImageContext?
    private let skills: [FeatureProviderSkill]
    @State private var selectionSource: MarkdownSelectionSource
    @State private var renderedDocument: MarkdownRenderedDocument?
    @State private var streamingRenderer = StreamingMarkdownRenderer()

    init(
        _ source: String,
        isStreaming: Bool = false,
        copyActionTitle: String = "Copy message",
        imageContext: MarkdownImageContext? = nil,
        skills: [FeatureProviderSkill] = []
    ) {
        self.source = source
        self.isStreaming = isStreaming
        self.copyActionTitle = copyActionTitle
        self.imageContext = imageContext
        self.skills = skills
        _selectionSource = State(initialValue: MarkdownSelectionSource(source))
        let revision = MarkdownContentRevision(source)
        self.revision = revision
        let initialDocument = if isStreaming {
            MarkdownRenderCache.shared.cachedDocument(for: revision)
        } else {
            MarkdownRenderCache.shared.documentImmediately(for: revision)
        }
        _renderedDocument = State(
            initialValue: initialDocument
        )
    }

    var body: some View {
        let selectionContext = selectionContext
        Group {
            if let displayDocument {
                MarkdownBlocksView(
                    blocks: displayDocument.blocks,
                    continuousSelection: !isStreaming,
                    selectionContext: selectionContext,
                    imageContext: imageContext
                )
            } else {
                // Parsing waits briefly so token-by-token streaming cancels stale revisions
                // instead of scheduling work for content the user will never see.
                Text(verbatim: source)
                    .font(T3Typography.threadBody)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityAction(named: copyActionTitle) {
            UIPasteboard.general.string = source
        }
        .task(id: RenderRequest(revision: revision, isStreaming: isStreaming)) {
            if !isStreaming {
                streamingRenderer.cancel()
                // Streaming -> complete usually keeps the final text; promote
                // the last streamed render instead of reparsing synchronously.
                if let renderedDocument, renderedDocument.revision == revision {
                    MarkdownRenderCache.shared.promote(renderedDocument)
                    return
                }
                renderedDocument = MarkdownRenderCache.shared.documentImmediately(for: revision)
                return
            }

            if let cached = MarkdownRenderCache.shared.cachedDocument(for: revision) {
                renderedDocument = cached
                return
            }

            // Hand the revision to a renderer that outlives this task. The
            // task modifier cancels on every revision, so rendering inside it
            // starves as soon as parsing is slower than the publish cadence;
            // the renderer instead keeps one render running and always picks
            // up the newest revision when it finishes (latest wins).
            streamingRenderer.submit(revision) { renderedDocument = $0 }
        }
        .onDisappear {
            streamingRenderer.cancel()
        }
    }

    private var displayDocument: MarkdownRenderedDocument? {
        if let renderedDocument, renderedDocument.revision == revision {
            return renderedDocument
        }
        // While streaming, a slightly stale document is better than flashing
        // back to plain text between renders. Streamed content only appends,
        // so require the stale document to be a prefix of the current source:
        // that accepts earlier snapshots of this message and rejects leftovers
        // from a recycled cell showing a different message.
        if isStreaming {
            if let renderedDocument,
               renderedDocument.revision.utf8Count <= revision.utf8Count,
               source.utf8.starts(with: renderedDocument.revision.source.utf8) {
                return renderedDocument
            }
            return nil
        }
        return MarkdownRenderCache.shared.documentImmediately(for: revision)
    }

    private var selectionContext: MarkdownSelectionContext {
        selectionSource.text = source
        return MarkdownSelectionContext(
            source: selectionSource,
            copyActionTitle: copyActionTitle,
            skills: skills
        )
    }
}

/// Renders streaming revisions outside SwiftUI's task lifecycle so a render
/// in progress is never cancelled by the next revision arriving. One render
/// runs at a time; newer revisions replace the pending slot (latest wins) and
/// a 150ms throttle bounds the render cadence.
@MainActor
private final class StreamingMarkdownRenderer {
    private let throttle: Duration = .milliseconds(150)
    private var pending: MarkdownContentRevision?
    private var deliver: ((MarkdownRenderedDocument) -> Void)?
    private var renderTask: Task<Void, Never>?
    private var generation = 0
    private var lastRenderAt: Date?

    func submit(
        _ revision: MarkdownContentRevision,
        deliver: @escaping (MarkdownRenderedDocument) -> Void
    ) {
        pending = revision
        self.deliver = deliver
        guard renderTask == nil else { return }
        generation += 1
        let generation = generation
        renderTask = Task { [weak self] in
            await self?.drain(generation: generation)
        }
    }

    func cancel() {
        generation += 1
        renderTask?.cancel()
        renderTask = nil
        pending = nil
        deliver = nil
    }

    private func drain(generation: Int) async {
        // A cancelled drain can unwind after a replacement was already
        // started; only the current generation may clear the shared slot or
        // deliver, so two drains can never race or regress the document.
        defer {
            if self.generation == generation { renderTask = nil }
        }
        while self.generation == generation, let revision = pending {
            pending = nil
            if let lastRenderAt {
                let elapsed = Duration.seconds(-lastRenderAt.timeIntervalSinceNow)
                if elapsed < throttle {
                    try? await Task.sleep(for: throttle - elapsed)
                }
            }
            guard !Task.isCancelled else { return }
            // Render the newest revision available after the throttle wait.
            let target = pending ?? revision
            pending = nil
            guard let document = await MarkdownRenderCache.shared.document(
                for: target,
                isIntermediate: true
            ) else { continue }
            guard !Task.isCancelled, self.generation == generation else { return }
            lastRenderAt = .now
            deliver?(document)
        }
    }
}

private final class MarkdownSelectionSource: @unchecked Sendable {
    var text: String

    init(_ text: String) {
        self.text = text
    }
}

private struct MarkdownSelectionContext: Equatable, Sendable {
    let source: MarkdownSelectionSource
    let copyActionTitle: String
    let skills: [FeatureProviderSkill]

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.source === rhs.source
            && lhs.copyActionTitle == rhs.copyActionTitle
            && lhs.skills == rhs.skills
    }
}

private enum MarkdownTextColor: Equatable, Sendable {
    case primary
    case secondary

    var uiColor: UIColor {
        switch self {
        case .primary: T3Colors.uiTextPrimary
        case .secondary: T3Colors.uiTextSecondary
        }
    }
}

private struct MarkdownBlocksView: View {
    let blocks: [MarkdownRenderedBlock]
    var continuousSelection = false
    let selectionContext: MarkdownSelectionContext
    let imageContext: MarkdownImageContext?
    var spacing: CGFloat = 12
    var textColor: MarkdownTextColor = .primary

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(selectionGroups, id: \.lowerBound) { range in
                if continuousSelection, MarkdownContinuousSelection.supports(blocks[range.lowerBound]) {
                    MarkdownInlineText(
                        prose: Array(blocks[range]),
                        selectionContext: selectionContext,
                        textColor: textColor
                    )
                } else {
                    // Keep the existing per-block cache and layout while streaming.
                    MarkdownBlockView(
                        block: blocks[range.lowerBound],
                        selectionContext: selectionContext,
                        imageContext: imageContext,
                        textColor: textColor
                    )
                    .equatable()
                }
            }
        }
    }

    private var selectionGroups: [Range<Int>] {
        continuousSelection
            ? MarkdownContinuousSelection.groups(in: blocks)
            : blocks.indices.map { $0..<($0 + 1) }
    }
}

private struct MarkdownBlockView: View, Equatable {
    let block: MarkdownRenderedBlock
    let selectionContext: MarkdownSelectionContext
    let imageContext: MarkdownImageContext?
    let textColor: MarkdownTextColor

    @ViewBuilder
    var body: some View {
        switch block {
        case let .paragraph(inline):
            MarkdownInlineText(
                inline,
                selectionContext: selectionContext,
                lineSpacing: 4,
                textColor: textColor
            )

        case let .image(image):
            MarkdownImageView(image: image, context: imageContext)

        case let .heading(level, inline):
            MarkdownInlineText(
                inline,
                selectionContext: selectionContext,
                textColor: textColor
            )
                .padding(.top, level <= 2 ? 3 : 1)

        case let .unorderedList(items):
            MarkdownListView(
                items: items,
                start: nil,
                selectionContext: selectionContext,
                imageContext: imageContext,
                textColor: textColor
            )

        case let .orderedList(start, items):
            MarkdownListView(
                items: items,
                start: start,
                selectionContext: selectionContext,
                imageContext: imageContext,
                textColor: textColor
            )

        case let .blockquote(blocks):
            MarkdownBlocksView(
                blocks: blocks,
                selectionContext: selectionContext,
                imageContext: imageContext,
                spacing: 9,
                textColor: .secondary
            )
                .foregroundStyle(T3Colors.textSecondary)
                .padding(.leading, 14)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(T3Colors.textTertiary)
                        .frame(width: 2)
                }

        case let .table(table):
            MarkdownTableView(
                table: table,
                selectionContext: selectionContext,
                textColor: textColor
            )

        case let .codeBlock(language, code, renderedCode):
            MarkdownCodeBlockView(
                language: language,
                code: code,
                renderedCode: renderedCode,
                selectionContext: selectionContext
            )

        case let .artifactTemplate(template):
            CodexArtifactTemplateView(template: template)

        case .thematicBreak:
            Rectangle()
                .fill(T3Colors.separator)
                .frame(height: 1)
                .padding(.vertical, 2)
                .accessibilityHidden(true)
        }
    }
}

private struct MarkdownTableView: View {
    let table: MarkdownRenderedTable
    let selectionContext: MarkdownSelectionContext
    let textColor: MarkdownTextColor

    private var columnWidths: [CGFloat] { table.columnWidths }

    var body: some View {
        ScrollView(.horizontal) {
            Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                tableRow(table.header, isHeader: true)
                ForEach(table.rows.indices, id: \.self) { rowIndex in
                    tableRow(table.rows[rowIndex], isHeader: false)
                }
            }
            // A horizontal ScrollView still proposes the viewport width to its child.
            // Preserve the grid's measured column widths so it overflows and scrolls
            // instead of compressing prose columns into unreadable slivers.
            .fixedSize(horizontal: true, vertical: true)
            .background(T3Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(T3Colors.border, lineWidth: 1)
            }
        }
        .scrollIndicators(.visible)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Table with \(table.header.count) columns and \(table.rows.count) rows")
    }

    private func tableRow(
        _ cells: [MarkdownRenderedInline],
        isHeader: Bool
    ) -> some View {
        GridRow(alignment: .top) {
            ForEach(cells.indices, id: \.self) { columnIndex in
                MarkdownInlineText(
                    cells[columnIndex],
                    selectionContext: selectionContext,
                    lineSpacing: 3,
                    textColor: textColor
                )
                    .frame(
                        width: columnWidths[columnIndex],
                        alignment: alignment(for: columnIndex)
                    )
                    .frame(
                        minHeight: 44,
                        maxHeight: .infinity,
                        alignment: alignment(for: columnIndex)
                    )
                    .padding(.horizontal, 11)
                    .padding(.vertical, 8)
                    .overlay(alignment: .trailing) {
                        if columnIndex < cells.count - 1 {
                            Rectangle()
                                .fill(T3Colors.separator)
                                .frame(width: 1)
                        }
                    }
            }
        }
        .background(isHeader ? T3Colors.surfaceRaised : T3Colors.surface)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(T3Colors.separator)
                .frame(height: 1)
        }
    }

    private func alignment(for columnIndex: Int) -> Alignment {
        guard table.alignments.indices.contains(columnIndex) else { return .leading }
        return switch table.alignments[columnIndex] {
        case .natural, .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

}

private struct MarkdownListView: View {
    let items: [MarkdownRenderedListItem]
    let start: Int?
    let selectionContext: MarkdownSelectionContext
    let imageContext: MarkdownImageContext?
    let textColor: MarkdownTextColor

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(items.indices, id: \.self) { offset in
                let item = items[offset]
                HStack(alignment: .top, spacing: 8) {
                    marker(for: item, offset: offset)
                        .frame(width: 24, height: 24, alignment: .trailing)
                    MarkdownBlocksView(
                        blocks: item.blocks,
                        selectionContext: selectionContext,
                        imageContext: imageContext,
                        spacing: 7,
                        textColor: textColor
                    )
                }
                .accessibilityElement(children: .contain)
            }
        }
    }

    @ViewBuilder
    private func marker(for item: MarkdownRenderedListItem, offset: Int) -> some View {
        if let task = item.task {
            Image(systemName: task == .complete ? "checkmark.square.fill" : "square")
                .font(T3Typography.control)
                .foregroundStyle(
                    task == .complete ? T3Colors.success : T3Colors.textSecondary
                )
                .accessibilityLabel(task == .complete ? "Completed" : "Not completed")
        } else if let start {
            Text("\(start + offset).")
                .font(T3Typography.supporting.monospaced())
                .foregroundStyle(T3Colors.textSecondary)
                .accessibilityLabel("Item \(start + offset)")
        } else {
            Text("•")
                .font(T3Typography.threadBody.weight(.semibold))
                .foregroundStyle(T3Colors.textSecondary)
                .accessibilityHidden(true)
        }
    }
}

private struct MarkdownImageView: View {
    private struct Request: Equatable {
        let image: MarkdownImage
        let context: MarkdownImageContext?
        let maximumPixelSize: Int
    }

    let image: MarkdownImage
    let context: MarkdownImageContext?

    @SwiftUI.Environment(\.openURL) private var openURL
    @SwiftUI.Environment(\.displayScale) private var displayScale
    @State private var loadedImage: MarkdownDecodedImage?
    @State private var activeRequest: Request?
    @State private var knownSize: CGSize?
    @State private var previewURL: URL?
    @State private var failed = false

    private var request: Request {
        Request(image: image, context: context, maximumPixelSize: min(2_048, max(512, Int(ceil(480 * displayScale)))))
    }

    private var classifiedSource: MarkdownImageSource {
        let basePath = context?.sourceFilePath.map {
            let isWindows = $0.contains("\\")
            let normalized = $0.replacingOccurrences(of: "\\", with: "/")
            let parent = (normalized as NSString).deletingLastPathComponent
            return isWindows ? parent.replacingOccurrences(of: "/", with: "\\") : parent
        } ?? context?.workspaceRoot
        return MarkdownImageSource.classify(image.source, workspaceRoot: basePath)
    }

    var body: some View {
        if classifiedSource != .blocked {
            let currentRequest = activeRequest == request
            let decoded = currentRequest ? loadedImage : nil
            MarkdownImageLayout(sourceSize: decoded?.sourceSize ?? (currentRequest ? knownSize : nil)) {
                if let decoded {
                    Image(uiImage: decoded.image)
                        .resizable()
                        .scaledToFit()
                } else {
                    Image(systemName: currentRequest && failed ? "exclamationmark.triangle" : "photo")
                        .font(.title2)
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(T3Colors.surfaceRaised)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityLabel(image.alternativeText.isEmpty ? "Image" : image.alternativeText)
            .accessibilityAddTraits(.isButton)
            .contentShape(Rectangle())
            .onTapGesture {
                if currentRequest, let previewURL { openURL(previewURL) }
            }
            .task(id: request) {
                await loadImage()
            }
        }
    }

    @MainActor
    private func loadImage() async {
        let loadingRequest = request
        activeRequest = loadingRequest
        loadedImage = nil
        knownSize = nil
        failed = false
        previewURL = nil
        do {
            let url: URL
            switch classifiedSource {
            case let .direct(directURL):
                url = directURL
                if directURL.scheme == "http" || directURL.scheme == "https" {
                    previewURL = directURL
                }
            case let .workspaceFile(path):
                guard let context else { return }
                var components = URLComponents()
                components.scheme = "t3code"
                components.host = "media-preview"
                components.path = "/open"
                components.queryItems = [
                    URLQueryItem(name: "path", value: path),
                    URLQueryItem(name: "kind", value: "image"),
                ]
                previewURL = components.url
                let asset = try await context.resolver.mediaAsset(
                    threadID: context.threadID,
                    path: path
                )
                try Task.checkCancellation()
                knownSize = MarkdownImageGeometry.sourceSize(asset.imageDimensions)
                url = asset.url
            case .blocked:
                return
            }
            let decoded = try await MarkdownImageLoader.load(url, maximumPixelSize: loadingRequest.maximumPixelSize)
            try Task.checkCancellation()
            loadedImage = decoded
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            failed = true
        }
    }
}

private struct CodexArtifactTemplateView: View {
    let template: CodexArtifactTemplate
    @SwiftUI.Environment(\.openURL) private var openURL

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(template.displayName)
                    .font(T3Typography.threadBody.weight(.medium))
                    .foregroundStyle(T3Colors.textPrimary)
                Text(template.kind.label)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            Spacer(minLength: 8)
            Button("Use") {
                if let url = template.useURL { openURL(url) }
            }
            .buttonStyle(.bordered)
        }
        .padding(.vertical, 4)
    }
}

@MainActor
private enum MarkdownImageLoader {
    private final class CachedImage {
        let decoded: MarkdownDecodedImage
        init(_ decoded: MarkdownDecodedImage) { self.decoded = decoded }
    }

    private static let cache: NSCache<NSString, CachedImage> = {
        let cache = NSCache<NSString, CachedImage>()
        cache.countLimit = 64
        cache.totalCostLimit = 32 * 1_024 * 1_024
        return cache
    }()

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        return URLSession(configuration: configuration)
    }()

    static func load(_ url: URL, maximumPixelSize: Int) async throws -> MarkdownDecodedImage {
        let cacheKey = "\(url.absoluteString)#\(maximumPixelSize)" as NSString
        if let cached = cache.object(forKey: cacheKey) {
            return cached.decoded
        }

        let data: Data
        if url.scheme?.lowercased() == "data" {
            guard let comma = url.absoluteString.firstIndex(of: ","),
                  url.absoluteString[..<comma].lowercased().contains(";base64"),
                  let decoded = Data(base64Encoded: String(url.absoluteString[url.absoluteString.index(after: comma)...])) else {
                throw MarkdownImageLoadingError.invalidImage
            }
            data = decoded
        } else {
            let response: URLResponse
            (data, response) = try await session.data(from: url)
            if let httpResponse = response as? HTTPURLResponse,
               !(200...299).contains(httpResponse.statusCode) {
                throw MarkdownImageLoadingError.invalidResponse
            }
        }
        try Task.checkCancellation()
        let decoded = try await Task.detached(priority: .utility) {
            try MarkdownImageDecoder.decode(data, maximumPixelSize: maximumPixelSize)
        }.value
        try Task.checkCancellation()
        let cost = decoded.image.cgImage.map { $0.bytesPerRow * $0.height } ?? data.count
        cache.setObject(CachedImage(decoded), forKey: cacheKey, cost: cost)
        return decoded
    }
}

private struct MarkdownCodeBlockView: View {
    let language: String?
    let code: String
    let renderedCode: MarkdownRenderedInline
    let selectionContext: MarkdownSelectionContext
    @State private var wrapOverride: Bool?

    private var wrapsLines: Bool {
        wrapOverride ?? MarkdownCodeBlockWrapping.wrapsByDefault(language: language)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if let language, !language.isEmpty {
                    Text(language.uppercased())
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textTertiary)
                } else {
                    Text("CODE")
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textTertiary)
                }
                Spacer(minLength: 8)
                Button {
                    wrapOverride = !wrapsLines
                } label: {
                    Label("Wrap", systemImage: "arrow.turn.down.left")
                        .font(T3Typography.control)
                        .foregroundStyle(wrapsLines ? T3Colors.accent : T3Colors.textSecondary)
                        .frame(minHeight: 32)
                }
                .buttonStyle(.plain)
                .accessibilityValue(wrapsLines ? "On" : "Off")
                .accessibilityHint("Toggles line wrapping for this code block")
                Button {
                    UIPasteboard.general.string = code
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                        .font(T3Typography.control)
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(minHeight: 32)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Copies this code block")
            }
            .padding(.horizontal, 13)
            .frame(minHeight: 40)

            Rectangle()
                .fill(T3Colors.separator)
                .frame(height: 1)

            Group {
                if wrapsLines {
                    MarkdownInlineText(
                        code: renderedCode,
                        language: language,
                        selectionContext: selectionContext,
                        lineSpacing: 3,
                        wrapsLines: true
                    )
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(13)
                } else {
                    ScrollView(.horizontal) {
                        MarkdownInlineText(
                            code: renderedCode,
                            language: language,
                            selectionContext: selectionContext,
                            lineSpacing: 3,
                            wrapsLines: false
                        )
                            .fixedSize(horizontal: true, vertical: true)
                            .padding(13)
                    }
                    .scrollIndicators(.hidden)
                }
            }
            .t3CodeTextSize()
        }
        .background(T3Colors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(T3Colors.border, lineWidth: 1)
        }
    }
}

enum MarkdownCodeBlockWrapping {
    private static let proseLanguages: Set<String> = [
        "markdown",
        "md",
        "plain",
        "plaintext",
        "text",
        "text/plain",
        "txt",
    ]

    static func wrapsByDefault(language: String?) -> Bool {
        guard let language else { return false }
        return proseLanguages.contains(language.lowercased())
    }
}

private enum MarkdownTextContent: Equatable {
    case inline(MarkdownRenderedInline)
    case code(MarkdownRenderedInline, language: String?)
    case prose([MarkdownRenderedBlock])
}

private struct MarkdownInlineText: UIViewRepresentable {
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @SwiftUI.Environment(\.openURL) private var openURL

    let content: MarkdownTextContent
    let selectionContext: MarkdownSelectionContext
    let lineSpacing: CGFloat
    let textColor: MarkdownTextColor
    let wrapsLines: Bool

    init(
        _ rendered: MarkdownRenderedInline,
        selectionContext: MarkdownSelectionContext,
        lineSpacing: CGFloat = 0,
        textColor: MarkdownTextColor = .primary,
        wrapsLines: Bool = true
    ) {
        self.content = .inline(rendered)
        self.selectionContext = selectionContext
        self.lineSpacing = lineSpacing
        self.textColor = textColor
        self.wrapsLines = wrapsLines
    }

    init(
        code: MarkdownRenderedInline,
        language: String?,
        selectionContext: MarkdownSelectionContext,
        lineSpacing: CGFloat,
        wrapsLines: Bool
    ) {
        self.content = .code(code, language: language)
        self.selectionContext = selectionContext
        self.lineSpacing = lineSpacing
        self.textColor = .primary
        self.wrapsLines = wrapsLines
    }

    init(
        prose: [MarkdownRenderedBlock],
        selectionContext: MarkdownSelectionContext,
        textColor: MarkdownTextColor
    ) {
        self.content = .prose(prose)
        self.selectionContext = selectionContext
        self.lineSpacing = 4
        self.textColor = textColor
        self.wrapsLines = true
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = MarkdownSelectionTextView(frame: .zero, textContainer: nil)
        textView.backgroundColor = .clear
        textView.isEditable = false
        textView.isSelectable = true
        textView.isScrollEnabled = false
        textView.showsHorizontalScrollIndicator = false
        textView.showsVerticalScrollIndicator = false
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.textContainer.widthTracksTextView = true
        textView.textContainer.lineBreakMode = wrapsLines ? .byWordWrapping : .byClipping
        textView.adjustsFontForContentSizeCategory = true
        textView.linkTextAttributes = [
            .foregroundColor: T3Colors.uiAccent,
            .underlineStyle: 0,
        ]
        textView.accessibilityTraits = .staticText
        textView.delegate = context.coordinator
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        textView.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        let attributedText = context.coordinator.attributedText(
            from: content,
            lineSpacing: lineSpacing,
            textColor: textColor,
            dynamicTypeSize: dynamicTypeSize,
            wrapsLines: wrapsLines,
            skills: selectionContext.skills,
            traits: textView.traitCollection
        )
        if context.coordinator.shouldApply(attributedText) {
            let previousText = context.coordinator.lastAppliedText
            let previousSelection = textView.selectedRange
            textView.attributedText = attributedText
            textView.selectedRange = MarkdownSelectionRestoration.range(
                previousText: previousText,
                previousRange: previousSelection,
                newText: attributedText.string
            )
            context.coordinator.didApply(attributedText)
        }
        context.coordinator.selectionContext = selectionContext
        context.coordinator.onOpenURL = { url in
            openURL(url)
        }
        textView.accessibilityCustomActions = context.coordinator.accessibilityActions(
            title: selectionContext.copyActionTitle
        )
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: UITextView,
        context: Context
    ) -> CGSize? {
        guard let proposedWidth = proposal.width,
            proposedWidth.isFinite,
            proposedWidth > 0
        else {
            return wrapsLines ? nil : context.coordinator.unwrappedSize(for: uiView)
        }
        return context.coordinator.size(
            for: uiView,
            proposedWidth: proposedWidth,
            wrapsLines: wrapsLines
        )
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        private struct CacheKey: Equatable {
            let lineSpacing: CGFloat
            let textColor: MarkdownTextColor
            let dynamicTypeSize: DynamicTypeSize
            let wrapsLines: Bool
            let skills: [FeatureProviderSkill]
            let userInterfaceStyle: UIUserInterfaceStyle
        }

        private struct SizeKey: Hashable {
            let proposedWidth: CGFloat
            let wrapsLines: Bool
        }

        var selectionContext = MarkdownSelectionContext(
            source: MarkdownSelectionSource(""),
            copyActionTitle: "Copy message",
            skills: []
        )
        var onOpenURL: ((URL) -> Void)?
        private var cacheKey: CacheKey?
        private var cachedContent: MarkdownTextContent?
        private var cachedAttributedText: NSAttributedString?
        private var cachedSizes: [SizeKey: CGSize] = [:]
        private var lastAppliedAttributedText: NSAttributedString?
        private var cachedAccessibilityTitle: String?
        private var cachedAccessibilityActions: [UIAccessibilityCustomAction] = []

        func attributedText(
            from content: MarkdownTextContent,
            lineSpacing: CGFloat,
            textColor: MarkdownTextColor,
            dynamicTypeSize: DynamicTypeSize,
            wrapsLines: Bool,
            skills: [FeatureProviderSkill],
            traits: UITraitCollection
        ) -> NSAttributedString {
            let key = CacheKey(
                lineSpacing: lineSpacing,
                textColor: textColor,
                dynamicTypeSize: dynamicTypeSize,
                wrapsLines: wrapsLines,
                skills: skills,
                userInterfaceStyle: traits.userInterfaceStyle
            )
            if cachedContent == content, key == cacheKey, let cachedAttributedText {
                return cachedAttributedText
            }
            let attributedText: NSAttributedString
            switch content {
            case let .inline(rendered), let .code(rendered, _):
                let inlineText = NSMutableAttributedString(attributedString: MarkdownSelectableTextAttributes.make(
                    from: rendered,
                    lineSpacing: lineSpacing,
                    foregroundColor: textColor.uiColor,
                    dynamicTypeSize: dynamicTypeSize,
                    wrapsLines: wrapsLines,
                    skills: skills,
                    traits: traits
                ))
                if case let .code(_, language) = content {
                    inlineText.addAttribute(.markdownCopyBlock, value: MarkdownCopyBlock(.code(language: language)), range: NSRange(location: 0, length: inlineText.length))
                }
                attributedText = inlineText
            case let .prose(blocks):
                attributedText = MarkdownContinuousSelection.attributedText(
                    blocks: blocks,
                    foregroundColor: textColor.uiColor,
                    dynamicTypeSize: dynamicTypeSize,
                    skills: skills,
                    traits: traits
                )
            }
            cacheKey = key
            cachedContent = content
            cachedAttributedText = attributedText
            cachedSizes.removeAll(keepingCapacity: true)
            return attributedText
        }

        var lastAppliedText: String {
            lastAppliedAttributedText?.string ?? ""
        }

        func shouldApply(_ attributedText: NSAttributedString) -> Bool {
            lastAppliedAttributedText !== attributedText
        }

        func didApply(_ attributedText: NSAttributedString) {
            lastAppliedAttributedText = attributedText
        }

        func size(
            for textView: UITextView,
            proposedWidth: CGFloat,
            wrapsLines: Bool
        ) -> CGSize {
            let key = SizeKey(proposedWidth: proposedWidth, wrapsLines: wrapsLines)
            if let cached = cachedSizes[key] {
                return cached
            }
            let bounds = textView.attributedText.boundingRect(
                with: CGSize(width: proposedWidth, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                context: nil
            )
            let width = min(proposedWidth, max(1, ceil(bounds.width)))
            let fittingSize = textView.sizeThatFits(
                CGSize(width: width, height: .greatestFiniteMagnitude)
            )
            let size = CGSize(width: width, height: max(1, ceil(fittingSize.height)))
            cachedSizes[key] = size
            return size
        }

        func unwrappedSize(for textView: UITextView) -> CGSize {
            let key = SizeKey(proposedWidth: .infinity, wrapsLines: false)
            if let cached = cachedSizes[key] {
                return cached
            }
            let longestLineLength = textView.attributedText.string
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map(\.utf16.count)
                .max() ?? 0
            var largestFontPointSize: CGFloat = 0
            textView.attributedText.enumerateAttribute(
                .font,
                in: NSRange(location: 0, length: textView.attributedText.length)
            ) { value, _, _ in
                largestFontPointSize = max(
                    largestFontPointSize,
                    (value as? UIFont)?.pointSize ?? 0
                )
            }
            let perCharacterWidth = max(16, largestFontPointSize * 1.5)
            let maximumWidth = max(2_048, CGFloat(longestLineLength) * perCharacterWidth)
            let bounds = textView.attributedText.boundingRect(
                with: CGSize(width: maximumWidth, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                context: nil
            )
            let fittingSize = textView.sizeThatFits(
                CGSize(width: max(1, ceil(bounds.width)), height: .greatestFiniteMagnitude)
            )
            let size = CGSize(
                width: max(1, ceil(bounds.width)),
                height: max(1, ceil(fittingSize.height))
            )
            cachedSizes[key] = size
            return size
        }

        func accessibilityActions(title: String) -> [UIAccessibilityCustomAction] {
            if cachedAccessibilityTitle == title {
                return cachedAccessibilityActions
            }
            cachedAccessibilityTitle = title
            cachedAccessibilityActions = [
                UIAccessibilityCustomAction(
                    name: title
                ) { [weak self] _ in
                    self?.copyMessage()
                    return true
                },
            ]
            return cachedAccessibilityActions
        }

        func textView(
            _ textView: UITextView,
            editMenuForTextIn range: NSRange,
            suggestedActions: [UIMenuElement]
        ) -> UIMenu? {
            let copyMessage = UIAction(
                title: selectionContext.copyActionTitle,
                image: UIImage(systemName: "doc.on.doc")
            ) { [weak self] _ in
                self?.copyMessage()
            }
            return UIMenu(children: suggestedActions + [copyMessage])
        }

        func textView(
            _ textView: UITextView,
            primaryActionFor textItem: UITextItem,
            defaultAction: UIAction
        ) -> UIAction? {
            guard case let .link(url) = textItem.content else { return defaultAction }
            return UIAction { [weak self] _ in
                self?.onOpenURL?(url)
            }
        }

        private func copyMessage() {
            UIPasteboard.general.string = selectionContext.source.text
        }
    }
}

/// Completed prose and code share a text view so native selection crosses block
/// boundaries. Other rich blocks keep their specialized views; streaming keeps its
/// per-block rendering until the response finishes.
enum MarkdownContinuousSelection {
    static func supports(_ block: MarkdownRenderedBlock) -> Bool {
        switch block {
        case .paragraph, .heading, .codeBlock:
            return true
        case let .unorderedList(items), let .orderedList(_, items):
            return !items.isEmpty && items.allSatisfy { item in
                guard item.task == nil, let first = item.blocks.first else { return false }
                switch first {
                case .paragraph, .heading: return item.blocks.allSatisfy(supports)
                default: return false
                }
            }
        default:
            return false
        }
    }

    static func groups(in blocks: [MarkdownRenderedBlock]) -> [Range<Int>] {
        var groups: [Range<Int>] = []
        for index in blocks.indices {
            if supports(blocks[index]), let previous = groups.last,
               supports(blocks[previous.lowerBound]) {
                groups[groups.count - 1] = previous.lowerBound..<(index + 1)
            } else {
                groups.append(index..<(index + 1))
            }
        }
        return groups
    }

    private struct Paragraph {
        let inline: MarkdownRenderedInline
        var prefix = ""
        var indent: CGFloat = 0
        var firstLineIndent: CGFloat = 0
        var spacingBefore: CGFloat = 12
        var lineSpacing: CGFloat = 4
        var copyKind: MarkdownCopyBlock.Kind = .paragraph
        var codeCard: MarkdownCodeCard?
    }

    private static func paragraphs(
        _ blocks: [MarkdownRenderedBlock],
        indent: CGFloat = 0,
        spacing: CGFloat = 12
    ) -> [Paragraph] {
        var result: [Paragraph] = []
        for block in blocks {
            switch block {
            case let .paragraph(inline):
                result.append(Paragraph(
                    inline: inline, indent: indent, firstLineIndent: indent, spacingBefore: spacing
                ))
            case let .heading(level, inline):
                result.append(Paragraph(
                    inline: inline, indent: indent, firstLineIndent: indent,
                    spacingBefore: spacing + (level <= 2 ? 3 : 1), lineSpacing: 0, copyKind: .heading(level)
                ))
            case let .codeBlock(language, code, inline):
                result.append(Paragraph(
                    inline: inline, indent: indent + MarkdownCodeCard.padding,
                    firstLineIndent: indent + MarkdownCodeCard.padding,
                    spacingBefore: spacing, lineSpacing: 3, copyKind: .code(language: language),
                    codeCard: MarkdownCodeCard(code: code, language: language, indent: indent)
                ))
            case let .unorderedList(items):
                appendList(items, start: nil, indent: indent, spacing: spacing, to: &result)
            case let .orderedList(start, items):
                appendList(items, start: start, indent: indent, spacing: spacing, to: &result)
            default:
                break
            }
        }
        return result
    }

    private static func appendList(
        _ items: [MarkdownRenderedListItem],
        start: Int?,
        indent: CGFloat,
        spacing: CGFloat,
        to result: inout [Paragraph]
    ) {
        for (index, item) in items.enumerated() {
            var children = paragraphs(item.blocks, indent: indent + 32, spacing: 7)
            guard !children.isEmpty else { continue }
            children[0].prefix = start.map { "\($0 + index).\t" } ?? "•\t"
            children[0].copyKind = .listItem(marker: start.map { "\($0 + index)." } ?? "-", depth: Int(indent / 32))
            children[0].firstLineIndent = indent
            children[0].spacingBefore = index == 0 ? spacing : 8
            result.append(contentsOf: children)
        }
    }

    @MainActor
    static func attributedText(
        blocks: [MarkdownRenderedBlock],
        foregroundColor: UIColor = T3Colors.uiTextPrimary,
        dynamicTypeSize: DynamicTypeSize = .large,
        skills: [FeatureProviderSkill] = [],
        traits: UITraitCollection = .current
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        for paragraph in paragraphs(blocks) {
            let text = NSMutableAttributedString(attributedString: MarkdownSelectableTextAttributes.make(
                from: paragraph.inline,
                lineSpacing: paragraph.lineSpacing,
                foregroundColor: foregroundColor,
                dynamicTypeSize: dynamicTypeSize,
                skills: skills,
                traits: traits
            ))
            if !paragraph.prefix.isEmpty {
                text.insert(NSAttributedString(string: paragraph.prefix, attributes: [
                    .font: MarkdownInlineStyle.body.uiFont(dynamicTypeSize: dynamicTypeSize),
                    .foregroundColor: foregroundColor,
                    .markdownCopyDecoration: true,
                ]), at: 0)
            }
            guard text.length > 0 else { continue }
            let style = NSMutableParagraphStyle()
            style.lineSpacing = paragraph.lineSpacing
            style.headIndent = paragraph.indent
            style.firstLineHeadIndent = paragraph.firstLineIndent
            style.tabStops = [NSTextTab(textAlignment: .left, location: paragraph.indent)]
            text.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: text.length))
            paragraph.codeCard?.decorate(text)
            text.addAttribute(.markdownCopyBlock, value: MarkdownCopyBlock(
                paragraph.copyKind, separator: paragraph.spacingBefore < 12 ? "\n" : "\n\n"
            ), range: NSRange(location: 0, length: text.length))
            if result.length > 0 {
                var separatorAttributes = result.attributes(at: result.length - 1, effectiveRange: nil)
                separatorAttributes.removeValue(forKey: .markdownCopyBlock)
                separatorAttributes.removeValue(forKey: .markdownCodeCard)
                separatorAttributes.removeValue(forKey: .attachment)
                result.append(NSAttributedString(string: "\n", attributes: separatorAttributes))
                let firstStyle = NSMutableParagraphStyle()
                firstStyle.setParagraphStyle(text.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle ?? style)
                firstStyle.paragraphSpacingBefore = paragraph.spacingBefore
                text.addAttribute(.paragraphStyle, value: firstStyle, range: (text.string as NSString).paragraphRange(
                    for: NSRange(location: 0, length: 0)
                ))
            }
            result.append(text)
        }
        return result
    }
}

enum MarkdownSelectableTextAttributes {
    @MainActor
    static func make(
        from rendered: MarkdownRenderedInline,
        lineSpacing: CGFloat,
        foregroundColor: UIColor = T3Colors.uiTextPrimary,
        dynamicTypeSize: DynamicTypeSize = .large,
        wrapsLines: Bool = true,
        skills: [FeatureProviderSkill] = [],
        traits: UITraitCollection = .current
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.lineSpacing = lineSpacing
        paragraphStyle.lineBreakMode = wrapsLines ? .byWordWrapping : .byClipping

        for run in rendered.attributedText.runs {
            let intent = run.inlinePresentationIntent
            var copyTraits: MarkdownCopyTraits = []
            if intent?.contains(.stronglyEmphasized) == true { copyTraits.insert(.bold) }
            if intent?.contains(.emphasized) == true { copyTraits.insert(.italic) }
            if intent?.contains(.strikethrough) == true { copyTraits.insert(.strike) }
            if intent?.contains(.code) == true { copyTraits.insert(.code) }
            var attributes: [NSAttributedString.Key: Any] = [
                .font: font(
                    for: rendered.style,
                    intent: intent,
                    dynamicTypeSize: dynamicTypeSize
                ),
                .foregroundColor: foregroundColor,
                .paragraphStyle: paragraphStyle,
                .markdownInlineTraits: copyTraits.rawValue,
            ]
            if intent?.contains(.code) == true {
                attributes[.backgroundColor] = T3Colors.uiSurfaceRaised
            }
            if intent?.contains(.strikethrough) == true {
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            }
            if let link = run.link {
                attributes[.link] = link
            }
            let runText = String(rendered.attributedText[run.range].characters)
            let hasLeadingBoundary = run.range.lowerBound == rendered.attributedText.startIndex
                || rendered.attributedText.characters[
                    rendered.attributedText.characters.index(before: run.range.lowerBound)
                ].isWhitespace
            let hasTrailingBoundary = run.range.upperBound == rendered.attributedText.endIndex
                || rendered.attributedText.characters[run.range.upperBound].isWhitespace
            let runLength = (runText as NSString).length
            let descriptors = rendered.style == .code
                || intent?.contains(.code) == true
                || run.link != nil
                ? []
                : FeatureInlineSkillParser.descriptors(
                    in: runText,
                    skills: skills,
                    allowsEndBoundary: true
                ).filter { descriptor in
                    (descriptor.range.location > 0 || hasLeadingBoundary)
                        && (NSMaxRange(descriptor.range) < runLength || hasTrailingBoundary)
                }
            result.append(
                FeatureInlineSkillPillRenderer.attributedText(
                    source: runText,
                    descriptors: descriptors,
                    baseAttributes: attributes,
                    font: attributes[.font] as? UIFont
                        ?? rendered.style.uiFont(dynamicTypeSize: dynamicTypeSize),
                    traits: traits
                )
            )
        }

        let kind: MarkdownCopyBlock.Kind
        switch rendered.style {
        case .heading1: kind = .heading(1)
        case .heading2: kind = .heading(2)
        case .heading3: kind = .heading(3)
        case .heading4: kind = .heading(4)
        case .code: kind = .code(language: nil)
        default: kind = .paragraph
        }
        result.addAttribute(.markdownCopyBlock, value: MarkdownCopyBlock(kind), range: NSRange(location: 0, length: result.length))

        return result
    }

    @MainActor
    private static func font(
        for style: MarkdownInlineStyle,
        intent: InlinePresentationIntent?,
        dynamicTypeSize: DynamicTypeSize
    ) -> UIFont {
        var font = style.uiFont(dynamicTypeSize: dynamicTypeSize)
        if intent?.contains(.code) == true, style != .code {
            font = UIFont.monospacedSystemFont(
                ofSize: font.pointSize,
                weight: .regular
            )
        }

        let addsBold = intent?.contains(.stronglyEmphasized) == true
        let addsItalic = intent?.contains(.emphasized) == true
        guard addsBold || addsItalic else { return font }

        var traits = font.fontDescriptor.symbolicTraits
        if addsBold {
            traits.insert(.traitBold)
        }
        if addsItalic {
            traits.insert(.traitItalic)
        }
        if let descriptor = font.fontDescriptor.withSymbolicTraits(traits) {
            font = UIFont(descriptor: descriptor, size: 0)
        }
        return font
    }
}

enum MarkdownSelectionRestoration {
    static func range(
        previousText: String,
        previousRange: NSRange,
        newText: String
    ) -> NSRange {
        guard newText.utf16.starts(with: previousText.utf16),
            NSMaxRange(previousRange) <= (newText as NSString).length
        else {
            return NSRange(location: 0, length: 0)
        }
        return previousRange
    }
}

enum MarkdownInlineFormatter {
    static func format(_ source: String) -> AttributedString {
        (
            try? AttributedString(
                markdown: source,
                options: AttributedString.MarkdownParsingOptions(
                    interpretedSyntax: .inlineOnlyPreservingWhitespace,
                    failurePolicy: .returnPartiallyParsedIfPossible
                )
            )
        ) ?? AttributedString(source)
    }
}
