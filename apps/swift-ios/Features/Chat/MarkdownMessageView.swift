import SwiftUI
import UIKit

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
    @State private var selectionSource: MarkdownSelectionSource
    @State private var renderedDocument: MarkdownRenderedDocument?
    @State private var streamingRenderer = StreamingMarkdownRenderer()

    init(
        _ source: String,
        isStreaming: Bool = false,
        copyActionTitle: String = "Copy message"
    ) {
        self.source = source
        self.isStreaming = isStreaming
        self.copyActionTitle = copyActionTitle
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
                    selectionContext: selectionContext
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
            copyActionTitle: copyActionTitle
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

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.source === rhs.source && lhs.copyActionTitle == rhs.copyActionTitle
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
    let selectionContext: MarkdownSelectionContext
    var spacing: CGFloat = 12
    var textColor: MarkdownTextColor = .primary

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(blocks.indices, id: \.self) { index in
                // Unchanged blocks share inline runs by reference across
                // streaming revisions, so equatable comparison skips their
                // body and layout entirely; only the changed tail re-renders.
                MarkdownBlockView(
                    block: blocks[index],
                    selectionContext: selectionContext,
                    textColor: textColor
                )
                    .equatable()
            }
        }
    }
}

private struct MarkdownBlockView: View, Equatable {
    let block: MarkdownRenderedBlock
    let selectionContext: MarkdownSelectionContext
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
                textColor: textColor
            )

        case let .orderedList(start, items):
            MarkdownListView(
                items: items,
                start: start,
                selectionContext: selectionContext,
                textColor: textColor
            )

        case let .blockquote(blocks):
            MarkdownBlocksView(
                blocks: blocks,
                selectionContext: selectionContext,
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

            if wrapsLines {
                MarkdownInlineText(
                    renderedCode,
                    selectionContext: selectionContext,
                    lineSpacing: 3,
                    wrapsLines: true
                )
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(13)
            } else {
                ScrollView(.horizontal) {
                    MarkdownInlineText(
                        renderedCode,
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

private struct MarkdownInlineText: UIViewRepresentable {
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @SwiftUI.Environment(\.openURL) private var openURL

    let rendered: MarkdownRenderedInline
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
        self.rendered = rendered
        self.selectionContext = selectionContext
        self.lineSpacing = lineSpacing
        self.textColor = textColor
        self.wrapsLines = wrapsLines
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
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
            from: rendered,
            lineSpacing: lineSpacing,
            textColor: textColor,
            dynamicTypeSize: dynamicTypeSize,
            wrapsLines: wrapsLines
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
        }

        private struct SizeKey: Hashable {
            let proposedWidth: CGFloat
            let wrapsLines: Bool
        }

        var selectionContext = MarkdownSelectionContext(
            source: MarkdownSelectionSource(""),
            copyActionTitle: "Copy message"
        )
        var onOpenURL: ((URL) -> Void)?
        private var cacheKey: CacheKey?
        private var cachedRendered: MarkdownRenderedInline?
        private var cachedAttributedText: NSAttributedString?
        private var cachedSizes: [SizeKey: CGSize] = [:]
        private var lastAppliedAttributedText: NSAttributedString?
        private var cachedAccessibilityTitle: String?
        private var cachedAccessibilityActions: [UIAccessibilityCustomAction] = []

        func attributedText(
            from rendered: MarkdownRenderedInline,
            lineSpacing: CGFloat,
            textColor: MarkdownTextColor,
            dynamicTypeSize: DynamicTypeSize,
            wrapsLines: Bool
        ) -> NSAttributedString {
            let key = CacheKey(
                lineSpacing: lineSpacing,
                textColor: textColor,
                dynamicTypeSize: dynamicTypeSize,
                wrapsLines: wrapsLines
            )
            if cachedRendered === rendered, key == cacheKey, let cachedAttributedText {
                return cachedAttributedText
            }
            let attributedText = MarkdownSelectableTextAttributes.make(
                from: rendered,
                lineSpacing: lineSpacing,
                foregroundColor: textColor.uiColor,
                dynamicTypeSize: dynamicTypeSize,
                wrapsLines: wrapsLines
            )
            cacheKey = key
            cachedRendered = rendered
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

enum MarkdownSelectableTextAttributes {
    @MainActor
    static func make(
        from rendered: MarkdownRenderedInline,
        lineSpacing: CGFloat,
        foregroundColor: UIColor = T3Colors.uiTextPrimary,
        dynamicTypeSize: DynamicTypeSize = .large,
        wrapsLines: Bool = true
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.lineSpacing = lineSpacing
        paragraphStyle.lineBreakMode = wrapsLines ? .byWordWrapping : .byClipping

        for run in rendered.attributedText.runs {
            let intent = run.inlinePresentationIntent
            var attributes: [NSAttributedString.Key: Any] = [
                .font: font(
                    for: rendered.style,
                    intent: intent,
                    dynamicTypeSize: dynamicTypeSize
                ),
                .foregroundColor: foregroundColor,
                .paragraphStyle: paragraphStyle,
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
            result.append(
                NSAttributedString(
                    string: String(rendered.attributedText[run.range].characters),
                    attributes: attributes
                )
            )
        }

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
