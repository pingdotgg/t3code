import Foundation
import Markdown
import SwiftUI

// MARK: - Markdown intermediate representation

/// The block-level representation used by both the chat renderer and the
/// conversation-wide Select Text sheet. Code blocks remain blocks here rather
/// than being split out before parsing, so an unterminated streaming fence is
/// represented exactly like a completed fence.
enum MarkdownBlock: Equatable {
    case paragraph(AttributedString)
    case heading(level: Int, text: AttributedString)
    case bulletItem(indent: Int, text: AttributedString)
    case orderedItem(indent: Int, number: String, text: AttributedString)
    case taskItem(indent: Int, checked: Bool, text: AttributedString)
    case quote([AttributedString])
    case rule
    case codeBlock(language: String?, code: String)
    case table(MarkdownTable)
}

struct MarkdownTable: Equatable {
    var columnAlignments: [TextAlignment?]
    var header: [AttributedString]
    var rows: [[AttributedString]]
}

struct ParsedMarkdownDocument {
    let blocks: [MarkdownBlock]
    let blockKeys: [String]
}

@MainActor
final class MarkdownBlockCacheStore {
    private var storage: [String: [MarkdownBlock]] = [:]
    private(set) var hits = 0
    private(set) var misses = 0

    func value(for key: String?) -> [MarkdownBlock]? {
        guard let key else { return nil }
        guard let value = storage[key] else {
            misses += 1
            return nil
        }
        hits += 1
        return value
    }

    func insert(_ value: [MarkdownBlock], for key: String?) {
        guard let key else { return }
        if storage.count >= 512, storage[key] == nil {
            storage.removeAll(keepingCapacity: true)
        }
        storage[key] = value
    }

    func reset() {
        storage.removeAll(keepingCapacity: true)
        hits = 0
        misses = 0
    }
}

@MainActor
enum MarkdownBlockCache {
    struct Statistics: Equatable {
        let hits: Int
        let misses: Int
        let entryCount: Int
    }

    private static let store = MarkdownBlockCacheStore()

    static func document(for markdown: String) -> ParsedMarkdownDocument {
        MarkdownASTParser(markdown: markdown).parse(using: store)
    }

    static var statistics: Statistics {
        Statistics(hits: store.hits, misses: store.misses, entryCount: store.entryCount)
    }

    static func resetForTesting() {
        store.reset()
    }
}

private extension MarkdownBlockCacheStore {
    var entryCount: Int { storage.count }
}

/// Parse the complete Markdown document with swift-markdown/cmark-gfm.
func parseMarkdownDocument(_ markdown: String) -> ParsedMarkdownDocument {
    MarkdownASTParser(markdown: markdown).parse()
}

/// Kept as the parser entry point used by older consumers. It now accepts a
/// complete Markdown document, including fenced code blocks.
func parseMarkdownBlocks(_ markdown: String) -> [MarkdownBlock] {
    parseMarkdownDocument(markdown).blocks
}

private struct MarkdownASTParser {
    let markdown: String

    func parse() -> ParsedMarkdownDocument {
        let document = Document(parsing: markdown)
        let bytes = Array(markdown.utf8)
        let lineStarts = lineStartOffsets(in: bytes)
        var blocks: [MarkdownBlock] = []
        var blockKeys: [String] = []
        for (index, markup) in document.children.enumerated() {
            let parsed = parseBlock(markup, listIndent: 0)
            blocks.append(contentsOf: parsed)
            blockKeys.append(contentsOf: repeatElement(
                sourceKey(for: markup, bytes: bytes, lineStarts: lineStarts)
                    ?? fallbackKey(for: index),
                count: parsed.count))
        }
        return ParsedMarkdownDocument(blocks: blocks, blockKeys: blockKeys)
    }

    @MainActor
    func parse(using cache: MarkdownBlockCacheStore) -> ParsedMarkdownDocument {
        let document = Document(parsing: markdown)
        let bytes = Array(markdown.utf8)
        let lineStarts = lineStartOffsets(in: bytes)
        var blocks: [MarkdownBlock] = []
        var blockKeys: [String] = []

        for (index, markup) in document.children.enumerated() {
            let key = sourceKey(for: markup, bytes: bytes, lineStarts: lineStarts)
            let parsed: [MarkdownBlock]
            if let key {
                if let cached = cache.value(for: key) {
                    parsed = cached
                } else {
                    parsed = parseBlock(markup, listIndent: 0)
                    cache.insert(parsed, for: key)
                }
            } else {
                parsed = parseBlock(markup, listIndent: 0)
            }
            blocks.append(contentsOf: parsed)
            blockKeys.append(contentsOf: repeatElement(
                key ?? fallbackKey(for: index), count: parsed.count))
        }

        return ParsedMarkdownDocument(blocks: blocks, blockKeys: blockKeys)
    }

    private func lineStartOffsets(in bytes: [UInt8]) -> [Int] {
        var lineStarts = [0]
        lineStarts.reserveCapacity(1 + bytes.count / 40)
        for (index, byte) in bytes.enumerated() where byte == 10 {
            lineStarts.append(index + 1)
        }
        return lineStarts
    }

    private func sourceKey(
        for markup: Markup,
        bytes: [UInt8],
        lineStarts: [Int]
    ) -> String? {
        guard let range = markup.range,
            let start = sourceByteOffset(
                for: range.lowerBound, lineStarts: lineStarts, byteCount: bytes.count),
            let end = sourceByteOffset(
                for: range.upperBound, lineStarts: lineStarts, byteCount: bytes.count),
            start <= end
        else {
            return nil
        }

        guard start <= bytes.count, end <= bytes.count else {
            return nil
        }
        return String(decoding: bytes[start..<end], as: UTF8.self)
    }

    private func sourceByteOffset(
        for location: SourceLocation,
        lineStarts: [Int],
        byteCount: Int
    ) -> Int? {
        guard location.line >= 1, location.column >= 1 else { return nil }
        let lineIndex = location.line - 1
        guard lineStarts.indices.contains(lineIndex) else { return nil }
        return min(byteCount, lineStarts[lineIndex] + location.column - 1)
    }

    private func fallbackKey(for index: Int) -> String {
        "\u{0}\(index)"
    }

    private func parseBlock(_ markup: Markup, listIndent: Int) -> [MarkdownBlock] {
        switch markup {
        case let paragraph as Markdown.Paragraph:
            return [.paragraph(inlineAttributed(children: paragraph.children))]

        case let heading as Markdown.Heading:
            return [
                .heading(
                    level: heading.level,
                    text: inlineAttributed(children: heading.children))
            ]

        case let codeBlock as Markdown.CodeBlock:
            return [
                .codeBlock(language: codeBlock.language, code: normalizedCode(codeBlock.code))
            ]

        case is Markdown.ThematicBreak:
            return [.rule]

        case let blockQuote as Markdown.BlockQuote:
            return [.quote(quoteParagraphs(in: blockQuote))]

        case let unorderedList as Markdown.UnorderedList:
            return parseUnorderedList(unorderedList, indent: listIndent)

        case let orderedList as Markdown.OrderedList:
            return parseOrderedList(orderedList, indent: listIndent)

        case let table as Markdown.Table:
            return [.table(parseTable(table))]

        case let html as Markdown.HTMLBlock:
            return [.paragraph(linkifiedPlainText(html.rawHTML))]

        default:
            // Unsupported block extensions are uncommon in assistant output.
            // Preserve their literal text instead of dropping content.
            let text = plainTextFallback(for: markup)
            if !text.isEmpty {
                return [.paragraph(linkifiedPlainText(text))]
            }
            return []
        }
    }

    private func parseUnorderedList(
        _ list: Markdown.UnorderedList,
        indent: Int
    ) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        for item in list.listItems {
            blocks.append(contentsOf: parseListItem(item, indent: indent, number: nil))
        }
        return blocks
    }

    private func parseOrderedList(
        _ list: Markdown.OrderedList,
        indent: Int
    ) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        for (index, item) in list.listItems.enumerated() {
            let number = String(list.startIndex + UInt(index))
            blocks.append(contentsOf: parseListItem(item, indent: indent, number: number))
        }
        return blocks
    }

    private func parseListItem(
        _ item: Markdown.ListItem,
        indent: Int,
        number: String?
    ) -> [MarkdownBlock] {
        let text = listItemText(item)
        let itemBlock: MarkdownBlock
        if let checkbox = item.checkbox {
            let checked: Bool
            switch checkbox {
            case .checked: checked = true
            case .unchecked: checked = false
            }
            itemBlock = .taskItem(indent: indent, checked: checked, text: text)
        } else if let number {
            itemBlock = .orderedItem(indent: indent, number: number, text: text)
        } else {
            itemBlock = .bulletItem(indent: indent, text: text)
        }

        return [itemBlock] + parseListItemChildren(in: item, indent: indent + 1)
    }

    /// Emits every child after the leading inline run in its original source
    /// order. A list item can contain any block-level Markdown node, not only
    /// nested lists, so using one post-pass for lists loses both order and
    /// unsupported content.
    private func parseListItemChildren(in item: Markdown.ListItem, indent: Int) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var isLeadingInlineRun = true
        for child in item.children {
            if isLeadingInlineRun, inlineListItemText(for: child) != nil {
                continue
            }
            isLeadingInlineRun = false

            // parseBlock preserves code, quote, paragraph, list, and heading
            // nodes, and its default case retains plain-text fallbacks.
            blocks.append(contentsOf: parseBlock(child, listIndent: indent))
        }
        return blocks
    }

    private func listItemText(_ item: Markdown.ListItem) -> AttributedString {
        var result = AttributedString()
        var needsSeparator = false

        for child in item.children {
            guard let text = inlineListItemText(for: child) else { break }
            if needsSeparator { result.append(AttributedString("\n")) }
            result.append(text)
            needsSeparator = true
        }

        return result
    }

    private func inlineListItemText(for child: Markup) -> AttributedString? {
        switch child {
        case let paragraph as Markdown.Paragraph:
            return inlineAttributed(children: paragraph.children)
        case let heading as Markdown.Heading:
            return inlineAttributed(children: heading.children)
        default:
            return nil
        }
    }

    private func quoteParagraphs(in blockQuote: Markdown.BlockQuote) -> [AttributedString] {
        var paragraphs: [AttributedString] = []
        for child in blockQuote.children {
            paragraphs.append(contentsOf: quoteParagraphs(for: child, listIndent: 0))
        }
        return paragraphs
    }

    private func quoteParagraphs(for markup: Markup, listIndent: Int) -> [AttributedString] {
        switch markup {
        case let paragraph as Markdown.Paragraph:
            return [inlineAttributed(children: paragraph.children)]
        case let heading as Markdown.Heading:
            return [inlineAttributed(children: heading.children)]
        case let nestedQuote as Markdown.BlockQuote:
            var paragraphs: [AttributedString] = []
            for child in nestedQuote.children {
                paragraphs.append(contentsOf: quoteParagraphs(for: child, listIndent: listIndent))
            }
            return paragraphs
        case let unordered as Markdown.UnorderedList:
            return quoteListParagraphs(in: unordered, indent: listIndent)
        case let ordered as Markdown.OrderedList:
            return quoteListParagraphs(in: ordered, indent: listIndent)
        case let codeBlock as Markdown.CodeBlock:
            return [attributedCode(codeBlock.code)]
        default:
            let text = plainTextFallback(for: markup)
            if !text.isEmpty {
                return [linkifiedPlainText(text)]
            }
            return []
        }
    }

    /// Keep text from block extensions that do not conform to
    /// PlainTextConvertibleMarkup (for example, custom containers). Known
    /// block kinds are handled above; this is only the lossless fallback for
    /// nodes the renderer does not otherwise understand.
    private func plainTextFallback(for markup: Markup) -> String {
        if let plainText = (markup as? any PlainTextConvertibleMarkup)?.plainText,
            !plainText.isEmpty
        {
            return plainText
        }

        return markup.children
            .map { plainTextFallback(for: $0) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
    }

    private func quoteListParagraphs(
        in list: Markdown.UnorderedList,
        indent: Int
    ) -> [AttributedString] {
        var paragraphs: [AttributedString] = []
        for item in list.listItems {
            let markerAndText = quotedListItemMarkerAndText(item, defaultMarker: "•")
            paragraphs.append(
                quotedListItem(
                    text: markerAndText.text, marker: markerAndText.marker, indent: indent))
            paragraphs.append(contentsOf: quoteListItemChildren(in: item, indent: indent + 1))
        }
        return paragraphs
    }

    private func quoteListParagraphs(
        in list: Markdown.OrderedList,
        indent: Int
    ) -> [AttributedString] {
        var paragraphs: [AttributedString] = []
        for (index, item) in list.listItems.enumerated() {
            let markerAndText = quotedListItemMarkerAndText(
                item, defaultMarker: "\(list.startIndex + UInt(index)).")
            paragraphs.append(
                quotedListItem(
                    text: markerAndText.text, marker: markerAndText.marker, indent: indent))
            paragraphs.append(contentsOf: quoteListItemChildren(in: item, indent: indent + 1))
        }
        return paragraphs
    }

    private func quoteListItemChildren(
        in item: Markdown.ListItem,
        indent: Int
    ) -> [AttributedString] {
        var paragraphs: [AttributedString] = []
        var isLeadingInlineRun = true
        for child in item.children {
            if isLeadingInlineRun, inlineListItemText(for: child) != nil {
                continue
            }
            isLeadingInlineRun = false
            paragraphs.append(contentsOf: quoteParagraphs(for: child, listIndent: indent))
        }
        return paragraphs
    }

    private func quotedListItem(
        text: AttributedString,
        marker: String,
        indent: Int
    ) -> AttributedString {
        let prefix = String(repeating: "  ", count: indent) + "\(marker) "
        var result = styled(AttributedString(prefix), foregroundColor: .secondary)
        result.append(text)
        return result
    }

    private func quotedListItemMarkerAndText(
        _ item: Markdown.ListItem,
        defaultMarker: String
    ) -> (marker: String, text: AttributedString) {
        let text = listItemText(item)
        if let checkbox = item.checkbox {
            switch checkbox {
            case .checked: return ("☑", text)
            case .unchecked: return ("☐", text)
            }
        }

        // cmark-gfm can leave a task marker literal when the task list is
        // nested inside a block quote. Keep quote serialization faithful to
        // the source even when the AST did not populate ListItem.checkbox.
        let plainText = String(text.characters)
        let literalMarker = String(plainText.prefix(4))
        let marker: String
        switch literalMarker {
        case "[x] ", "[X] ": marker = "☑"
        case "[ ] ": marker = "☐"
        default: return (defaultMarker, text)
        }

        let characters = text.characters
        let contentStart = characters.index(characters.startIndex, offsetBy: 4)
        var content = AttributedString()
        content.append(text[contentStart..<characters.endIndex])
        return (marker, content)
    }

    private func parseTable(_ table: Markdown.Table) -> MarkdownTable {
        let columnCount = table.maxColumnCount
        let alignments = table.columnAlignments.map { alignment -> TextAlignment? in
            switch alignment {
            case .left: return .leading
            case .center: return .center
            case .right: return .trailing
            case .none: return nil
            }
        } + Array(repeating: nil, count: max(0, columnCount - table.columnAlignments.count))

        func cells(in row: Markup) -> [AttributedString] {
            var values = row.children.compactMap { child -> AttributedString? in
                guard let cell = child as? Markdown.Table.Cell else { return nil }
                return inlineAttributed(children: cell.children)
            }
            if values.count < columnCount {
                values.append(contentsOf: Array(
                    repeating: AttributedString(),
                    count: columnCount - values.count))
            }
            return Array(values.prefix(columnCount))
        }

        let header = cells(in: table.head)
        let rows = table.body.rows.map { cells(in: $0) }
        return MarkdownTable(
            columnAlignments: Array(alignments.prefix(columnCount)),
            header: header,
            rows: Array(rows))
    }

    private func normalizedCode(_ code: String) -> String {
        // cmark-gfm includes the line ending that terminates a fenced code
        // block. The old segment parser joined content lines without that
        // delimiter, so preserve the renderer's established code value.
        code.hasSuffix("\n") ? String(code.dropLast()) : code
    }
}

// MARK: - Inline AST rendering

/// Compatibility helper for callers that need to render inline Markdown.
/// Unlike the old implementation this never round-trips through
/// `AttributedString(markdown:)`; it parses and walks swift-markdown nodes.
func inlineAttributed(_ text: String) -> AttributedString {
    guard !text.isEmpty else { return AttributedString() }
    let document = Document(parsing: text)
    guard let paragraph = document.children.compactMap({ $0 as? Markdown.Paragraph }).first,
        document.childCount == 1
    else {
        return linkifiedPlainText(text)
    }
    return inlineAttributed(children: paragraph.children)
}

private func linkifiedPlainText(_ text: String) -> AttributedString {
    linkifyFilePaths(in: AttributedString(text))
}

private func inlineAttributed(children: MarkupChildren) -> AttributedString {
    var result = AttributedString()
    for child in children {
        result.append(inlineAttributed(markup: child))
    }
    return linkifyFilePaths(in: result)
}

private func inlineAttributed(markup: Markup) -> AttributedString {
    switch markup {
    case let text as Markdown.Text:
        return AttributedString(text.string)

    case let emphasis as Markdown.Emphasis:
        var result = inlineAttributed(children: emphasis.children)
        result.inlinePresentationIntent = .emphasized
        return result

    case let strong as Markdown.Strong:
        var result = inlineAttributed(children: strong.children)
        result.inlinePresentationIntent = .stronglyEmphasized
        return result

    case let inlineCode as Markdown.InlineCode:
        var result = AttributedString(inlineCode.code)
        result.inlinePresentationIntent = .code
        result.font = .system(.body, design: .monospaced)
        return result

    case let link as Markdown.Link:
        var result = inlineAttributed(children: link.children)
        if let destination = link.destination, let url = URL(string: destination) {
            result.link = url
        }
        return result

    case let strikethrough as Markdown.Strikethrough:
        var result = inlineAttributed(children: strikethrough.children)
        result.strikethroughStyle = .single
        return result

    case is Markdown.SoftBreak:
        return AttributedString(" ")

    case is Markdown.LineBreak:
        return AttributedString("\n")

    case let html as Markdown.InlineHTML:
        return AttributedString(html.rawHTML)

    case let image as Markdown.Image:
        return inlineAttributed(children: image.children)

    case let custom as Markdown.CustomInline:
        return AttributedString(custom.text)

    case let symbolLink as Markdown.SymbolLink:
        return AttributedString(symbolLink.destination ?? "")

    case let attributes as Markdown.InlineAttributes:
        return inlineAttributed(children: attributes.children)

    default:
        if let text = (markup as? any PlainTextConvertibleMarkup)?.plainText {
            return AttributedString(text)
        }
        return AttributedString()
    }
}

// MARK: - Assistant message view

/// Full-width assistant message body: an AST-backed block list plus a
/// streaming indicator. Content stays unframed and opaque for long-form
/// reading; only the hover action chip floats above it.
private struct MarkdownRenderedBlock: Identifiable {
    let id: String
    let block: MarkdownBlock
}

@MainActor
struct AssistantMarkdownView: View {
    // The mac client has no editor picker yet; Cursor is first in the shared
    // EDITORS ordering and therefore matches the existing client default.
    private static let defaultEditor: ExternalEditor = .cursor

    let markdown: String
    let isStreaming: Bool
    let threadID: String
    let model: AppModel
    let style: MarkdownRenderStyle
    // Parsing belongs in init, not body: body is evaluated for every timeline
    // mutation while the view value can remain otherwise unchanged.
    private let blocks: [MarkdownBlock]
    private let renderedBlocks: [MarkdownRenderedBlock]

    init(
        markdown: String,
        isStreaming: Bool,
        threadID: String,
        model: AppModel,
        style: MarkdownRenderStyle = .assistant
    ) {
        self.markdown = markdown
        self.isStreaming = isStreaming
        self.threadID = threadID
        self.model = model
        self.style = style
        let document = MarkdownBlockCache.document(for: markdown)
        self.blocks = document.blocks
        self.renderedBlocks = Self.renderedBlocks(from: document)
    }

    @UIState private var isHovering = false
    @Environment(\.openSelectText) private var openSelectText

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(renderedBlocks.enumerated()), id: \.element.id) { index, entry in
                markdownBlockView(
                    entry.block,
                    allowsHighlight: style == .assistant
                        && !(isStreaming && index == renderedBlocks.count - 1))
                    .padding(.top, blockGap(at: index))
            }
            if style == .assistant && isStreaming {
                Image(systemName: "ellipsis")
                    .symbolEffect(.variableColor.iterative, isActive: !Motion.reduceMotion)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Assistant is responding")
                    .transition(.opacity)
                    .padding(.top, streamingIndicatorGap)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .topTrailing) {
            if style == .assistant && !isStreaming {
                // Copies the raw markdown, not the rendered text — pasted
                // content survives round-trips into editors and issues.
                MessageActionChip {
                    CopyActionButton(text: markdown)
                }
                .opacity(isHovering ? 1 : 0)
                .allowsHitTesting(isHovering)
                .accessibilityHidden(!isHovering)
                .padding(.top, 2)
                .padding(.trailing, 2)
            }
        }
        .onHover { isHovering = $0 }
        .animation(Motion.fade, value: isHovering)
        .animation(Motion.fade, value: isStreaming)
        .contextMenu {
            Button("Copy as Markdown") { Pasteboard.copy(markdown) }
            if let openSelectText {
                Divider()
                Button("Select Text…") { openSelectText() }
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme?.lowercased() == "sergecode-file" else { return .systemAction }
            guard let target = parseFileLinkURL(url) else { return .handled }
            // The launcher API does not accept a line yet; keep it in the URL
            // contract so a future RPC extension can preserve the location.
            _ = target.line
            Task {
                await model.openInEditor(
                    threadID: threadID, subpath: target.path, editor: Self.defaultEditor)
            }
            return .handled
        })
    }

    private static func renderedBlocks(from document: ParsedMarkdownDocument) -> [MarkdownRenderedBlock] {
        var occurrences: [String: Int] = [:]
        return document.blocks.indices.map { index in
            let sourceKey = document.blockKeys[index]
            let occurrence = occurrences[sourceKey, default: 0]
            occurrences[sourceKey] = occurrence + 1
            // One top-level Markdown node can expand into several blocks. Keep
            // its stable source key while disambiguating those siblings.
            return MarkdownRenderedBlock(
                id: "\(sourceKey)\u{0}\(occurrence)", block: document.blocks[index])
        }
    }

    private func blockGap(at index: Int) -> CGFloat {
        let before = MarkdownTheme.kind(of: renderedBlocks[index].block)
        let after = index > 0
            ? MarkdownTheme.kind(of: renderedBlocks[index - 1].block)
            : nil
        return MarkdownTheme.gap(after: after, before: before)
    }

    private var streamingIndicatorGap: CGFloat {
        guard let last = renderedBlocks.last else {
            return MarkdownTheme.gap(after: .paragraph, before: .paragraph)
        }
        return MarkdownTheme.gap(
            after: MarkdownTheme.kind(of: last.block), before: .paragraph)
    }

    @ViewBuilder
    private func markdownBlockView(_ block: MarkdownBlock, allowsHighlight: Bool) -> some View {
        switch block {
        case .paragraph(let text):
            if style == .userBubble {
                MarkdownUserInlineText(attributed: text)
            } else {
                MarkdownProseText(attributed: text)
            }
        case .heading(let level, let text):
            MarkdownHeadingView(level: level, text: text, style: style)
        case .bulletItem(let indent, let text):
            MarkdownListRow(level: indent, marker: .bullet, text: text, style: style)
        case .orderedItem(let indent, let number, let text):
            MarkdownListRow(
                level: indent, marker: .ordered(number), text: text, style: style)
        case .taskItem(let indent, let checked, let text):
            MarkdownListRow(
                level: indent, marker: .task(checked: checked), text: text, style: style)
        case .quote(let paragraphs):
            MarkdownQuoteView(paragraphs: paragraphs, style: style)
        case .rule:
            if style == .userBubble {
                Rectangle()
                    .fill(MarkdownTheme.tokens(for: style).rule.color)
                    .frame(height: 1)
                    .padding(.horizontal, 2)
            } else {
                Rectangle()
                    .fill(.separator)
                    .opacity(0.6)
                    .frame(height: 1)
                    .padding(.horizontal, 2)
            }
        case .codeBlock(let language, let code):
            if MarkdownTheme.blockRendering(for: .code, style: style) == .plainPanel {
                MarkdownPlainCodePanel(text: code)
            } else {
                MarkdownCodeBlock(
                    language: language,
                    code: code,
                    allowsHighlight: allowsHighlight)
            }
        case .table(let table):
            if MarkdownTheme.blockRendering(for: .table, style: style) == .plainPanel {
                MarkdownPlainCodePanel(text: plainTableText(table))
            } else {
                MarkdownTableView(table: table)
            }
        }
    }
}

private struct MarkdownHeadingView: View {
    let level: Int
    let text: AttributedString
    let style: MarkdownRenderStyle

    var body: some View {
        VStack(alignment: .leading, spacing: MarkdownTheme.headingHasRule(level) ? 6 : 0) {
            if style == .userBubble {
                MarkdownUserInlineText(
                    attributed: text,
                    font: MarkdownTheme.headingFont(level))
            } else {
                Text(text)
                    .font(MarkdownTheme.headingFont(level))
                    .foregroundStyle(MarkdownTheme.headingForeground(level))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if MarkdownTheme.headingHasRule(level) {
                if style == .userBubble {
                    Rectangle()
                        .fill(MarkdownTheme.tokens(for: style).headingRule.color)
                        .frame(height: 1)
                } else {
                    Rectangle()
                        .fill(.separator)
                        .opacity(0.5)
                        .frame(height: 1)
                }
            }
        }
    }
}

private struct MarkdownListRow: View {
    enum Marker {
        case bullet
        case ordered(String)
        case task(checked: Bool)
    }

    let level: Int
    let marker: Marker
    let text: AttributedString
    let style: MarkdownRenderStyle

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            markerView
                .frame(width: MarkdownTheme.listMarkerColumnWidth, alignment: .trailing)
            if style == .userBubble {
                MarkdownUserInlineText(
                    attributed: text,
                    foreground: MarkdownTheme.tokens(for: style).checkedTaskTextForeground)
            } else {
                Text(text)
                    .foregroundStyle(textForeground)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.leading, MarkdownTheme.listIndent(level: level))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var markerView: some View {
        switch marker {
        case .bullet:
            Text(MarkdownTheme.bulletGlyph(depth: level))
                .font(.body)
                .foregroundStyle(markerForeground)
        case .ordered(let number):
            Text("\(number).")
                .font(.body.monospacedDigit())
                .foregroundStyle(markerForeground)
        case .task(let checked):
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .font(.body)
                .foregroundStyle(taskMarkerForeground(checked: checked))
        }
    }

    private var markerForeground: Color {
        if style == .userBubble {
            return MarkdownTheme.tokens(for: style).listMarkerForeground.color
        }
        return .secondary
    }

    private func taskMarkerForeground(checked: Bool) -> Color {
        if style == .userBubble {
            return MarkdownTheme.tokens(for: style).taskCheckboxForeground.color
        }
        return checked ? Color.accentColor : .secondary
    }

    private var textForeground: Color {
        if style == .userBubble {
            return MarkdownTheme.tokens(for: style).proseForeground.color
        }
        switch marker {
        case .task(let checked) where checked:
            return .secondary
        default:
            return .primary
        }
    }
}

private struct MarkdownQuoteView: View {
    let paragraphs: [AttributedString]
    let style: MarkdownRenderStyle

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: MarkdownTheme.quoteCornerRadius)
                .fill(quoteBarColor)
                .frame(width: MarkdownTheme.quoteBarWidth)
                .frame(maxHeight: .infinity)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, paragraph in
                    if style == .userBubble {
                        MarkdownUserInlineText(
                            attributed: paragraph,
                            foreground: MarkdownTheme.tokens(for: style).quoteText,
                            italic: true)
                    } else {
                        Text(paragraph)
                            .foregroundStyle(.secondary)
                            .italic()
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 2)
        .background(quoteFillColor, in: RoundedRectangle(cornerRadius: 6))
    }

    private var quoteBarColor: Color {
        MarkdownTheme.tokens(for: style).quoteBar.color
    }

    private var quoteFillColor: Color {
        MarkdownTheme.tokens(for: style).quoteFill.color
    }
}

private struct MarkdownProseText: View {
    let attributed: AttributedString

    var body: some View {
        Text(attributed)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// User-bubble prose is made from individual attributed runs so inline code
/// can get a small rounded chip while the whole paragraph still wraps at the
/// bubble's width. Assistant prose intentionally keeps the single Text path
/// above unchanged.
private struct MarkdownUserInlineText: View {
    let attributed: AttributedString
    var foreground: MarkdownTheme.ForegroundToken? = nil
    var font: Font? = nil
    var italic = false

    private var tokens: MarkdownTheme.StyleTokens {
        MarkdownTheme.tokens(for: .userBubble)
    }

    var body: some View {
        MarkdownInlineFlow {
            ForEach(Array(attributed.runs.enumerated()), id: \.offset) { _, run in
                let segment = AttributedString(attributed[run.range])
                let isCode = run.inlinePresentationIntent?.contains(.code) == true
                let isLink = run.link != nil && tokens.linksAreUnderlined
                let foregroundColor = isLink
                    ? tokens.proseForeground.color
                    : (foreground ?? tokens.proseForeground).color
                Text(segment)
                    .font(isCode ? .system(.body, design: .monospaced) : font)
                    .foregroundStyle(foregroundColor)
                    .italic(italic && !isCode)
                    .underline(isLink, color: tokens.proseForeground.color)
                    .padding(.horizontal, isCode ? 4 : 0)
                    .padding(.vertical, isCode ? 1 : 0)
                    .background(
                        isCode
                            ? (tokens.inlineCodeBackground?.color ?? Color.clear)
                            : Color.clear,
                        in: RoundedRectangle(cornerRadius: 4))
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A small wrapping layout for user-bubble inline runs. Keeping code spans as
/// separate subviews is what allows their rounded background without turning
/// prose into a full-width panel.
private struct MarkdownInlineFlow: Layout {
    private struct Line {
        var indices: [Int] = []
        var sizes: [CGSize] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    typealias Cache = ()

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout Cache
    ) -> CGSize {
        let width = finiteWidth(from: proposal.width)
        let lines = makeLines(subviews: subviews, maxWidth: width)
        let contentWidth = lines.map(\.width).max() ?? 0
        let contentHeight = lines.reduce(0) { total, line in
            total + line.height
        } + CGFloat(max(0, lines.count - 1)) * 2
        let resultWidth = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? contentWidth
        return CGSize(width: resultWidth, height: contentHeight)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout Cache
    ) {
        let lines = makeLines(subviews: subviews, maxWidth: bounds.width)
        var y = bounds.minY
        for line in lines {
            var x = bounds.minX
            for (offset, index) in line.indices.enumerated() {
                let size = line.sizes[offset]
                subviews[index].place(
                    at: CGPoint(x: x, y: y),
                    anchor: .topLeading,
                    proposal: ProposedViewSize(width: size.width, height: size.height))
                x += size.width
            }
            y += line.height + 2
        }
    }

    private func finiteWidth(from proposedWidth: CGFloat?) -> CGFloat {
        guard let proposedWidth, proposedWidth.isFinite else { return .infinity }
        return max(0, proposedWidth)
    }

    private func makeLines(subviews: Subviews, maxWidth: CGFloat) -> [Line] {
        var lines: [Line] = []
        var current = Line()

        for index in subviews.indices {
            let intrinsic = subviews[index].sizeThatFits(.unspecified)
            let size: CGSize
            if maxWidth.isFinite && intrinsic.width > maxWidth {
                size = subviews[index].sizeThatFits(
                    ProposedViewSize(width: maxWidth, height: nil))
            } else {
                size = intrinsic
            }

            if !current.indices.isEmpty && current.width + size.width > maxWidth {
                lines.append(current)
                current = Line()
            }
            current.indices.append(index)
            current.sizes.append(size)
            current.width += size.width
            current.height = max(current.height, size.height)
        }

        if !current.indices.isEmpty {
            lines.append(current)
        }
        return lines
    }
}

// MARK: - Selectable transcript serialization
// Serialization-only: keep plain-text markers and separators stable.

/// Stitches parsed blocks into one attributed string for multi-line selection
/// within a prose run and for the conversation-wide Select Text overlay.
func attributedMarkdownProse(_ blocks: [MarkdownBlock]) -> AttributedString {
    var result = AttributedString()

    for (index, block) in blocks.enumerated() {
        if index > 0 {
            result.append(AttributedString(blockSeparator(after: blocks[index - 1], before: block)))
        }
        result.append(attributedBlock(block))
    }

    return result
}

/// Full assistant Markdown as one attributed document for the conversation-
/// wide Select Text overlay. Tables use tab-separated rows.
func attributedMarkdownDocument(_ markdown: String) -> AttributedString {
    attributedMarkdownProse(parseMarkdownBlocks(markdown))
}

private func blockSeparator(after previous: MarkdownBlock, before next: MarkdownBlock) -> String {
    switch (previous, next) {
    case (.bulletItem, .bulletItem),
         (.orderedItem, .orderedItem),
         (.taskItem, .taskItem),
         (.quote, .quote):
        return "\n"
    default:
        return "\n\n"
    }
}

private func attributedBlock(_ block: MarkdownBlock) -> AttributedString {
    switch block {
    case .paragraph(let text):
        return text
    case .heading(let level, let text):
        return styled(text, font: headingFont(level))
    case .bulletItem(let indent, let text):
        return listAttributed(marker: "•", text: text, indent: indent)
    case .orderedItem(let indent, let number, let text):
        return listAttributed(marker: "\(number).", text: text, indent: indent)
    case .taskItem(let indent, let checked, let text):
        return listAttributed(marker: checked ? "☑" : "☐", text: text, indent: indent)
    case .quote(let paragraphs):
        var result = AttributedString()
        for (index, paragraph) in paragraphs.enumerated() {
            if index > 0 { result.append(AttributedString("\n")) }
            result.append(quotedAttributed(paragraph))
        }
        return result
    case .rule:
        // Selection has no divider primitive, so use a neutral separator glyph
        // while the chat renderer uses a real Divider view.
        return styled(AttributedString(String(repeating: "─", count: 24)), foregroundColor: .secondary)
    case .codeBlock(_, let code):
        return attributedCode(code)
    case .table(let table):
        return attributedTable(table)
    }
}

private func attributedTable(_ table: MarkdownTable) -> AttributedString {
    var lines: [AttributedString] = []
    lines.append(joinedTableCells(table.header))
    lines.append(contentsOf: table.rows.map(joinedTableCells))

    var result = AttributedString()
    for (index, line) in lines.enumerated() {
        if index > 0 { result.append(AttributedString("\n")) }
        result.append(line)
    }
    return result
}

private func joinedTableCells(_ cells: [AttributedString]) -> AttributedString {
    var result = AttributedString()
    for (index, cell) in cells.enumerated() {
        if index > 0 { result.append(AttributedString("\t")) }
        result.append(cell)
    }
    return result
}

private func attributedCode(_ code: String) -> AttributedString {
    // Fenced code intentionally stays unlinked. Inline code is linkified by
    // inlineAttributed(children:) before it reaches a MarkdownBlock.
    var result = AttributedString(code)
    result.font = .system(.body, design: .monospaced)
    result.backgroundColor = Color(nsColor: .textBackgroundColor)
    return result
}

private func quotedAttributed(_ paragraph: AttributedString) -> AttributedString {
    var result = styled(AttributedString("> "), foregroundColor: .secondary)
    result.append(styled(paragraph, foregroundColor: .secondary))
    return result
}

private func listAttributed(marker: String, text: AttributedString, indent: Int) -> AttributedString {
    let indentPrefix = String(repeating: "  ", count: indent)
    let markerPrefix = "\(indentPrefix)\(marker) "
    let continuationPrefix = String(repeating: " ", count: markerPrefix.count)
    let continuationAlignedText = hangingIndentedText(text, prefix: continuationPrefix)

    var attributed = styled(AttributedString(markerPrefix), foregroundColor: .secondary)
    attributed.append(continuationAlignedText)
    return attributed
}

private func hangingIndentedText(_ text: AttributedString, prefix: String) -> AttributedString {
    guard text.characters.contains("\n") else { return text }

    let characters = text.characters
    var result = AttributedString()
    var segmentStart = characters.startIndex
    var searchStart = characters.startIndex

    while let newline = characters[searchStart...].firstIndex(of: "\n") {
        let segmentEnd = characters.index(after: newline)
        result.append(AttributedString(text[segmentStart..<segmentEnd]))
        if segmentEnd < characters.endIndex {
            result.append(AttributedString(prefix))
        }
        segmentStart = segmentEnd
        searchStart = segmentEnd
    }

    if segmentStart < characters.endIndex {
        result.append(AttributedString(text[segmentStart..<characters.endIndex]))
    }
    return result
}

private func styled(
    _ attributed: AttributedString,
    font: Font? = nil,
    foregroundColor: Color? = nil
) -> AttributedString {
    var copy = attributed
    if let font {
        copy.font = font
    }
    if let foregroundColor {
        copy.foregroundColor = foregroundColor
    }
    return copy
}

private func headingFont(_ level: Int) -> Font {
    switch level {
    case 1: .title2.weight(.bold)
    case 2: .title3.weight(.semibold)
    case 3: .headline
    default: .subheadline.weight(.semibold)
    }
}

// MARK: - Basic code/table views (refined in the rendering commit)

/// Deliberately minimal code/table treatment for user bubbles. It has no
/// language header, copy/wrap controls, or asynchronous syntax highlighting.
private struct MarkdownPlainCodePanel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(.callout, design: .monospaced))
            .foregroundStyle(.white)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .background(
                Color.white.opacity(0.12),
                in: RoundedRectangle(cornerRadius: 6))
    }
}

private func plainTableText(_ table: MarkdownTable) -> String {
    let lines = [table.header] + table.rows
    return lines.map { row in
        row.map { String($0.characters) }.joined(separator: "\t")
    }.joined(separator: "\n")
}

private struct MarkdownCodeHighlightTaskID: Equatable {
    let code: String
    let language: String?
    let dark: Bool
    let allowsHighlight: Bool
}

private struct MarkdownCodeBlock: View {
    let language: String?
    let code: String
    let allowsHighlight: Bool

    @UIState private var isHovering = false
    @UIState private var isWrapped = false
    @UIState private var displayedText: AttributedString
    @Environment(\.colorScheme) private var colorScheme

    init(language: String?, code: String, allowsHighlight: Bool) {
        self.language = language
        self.code = code
        self.allowsHighlight = allowsHighlight
        _displayedText = UIState(initialValue: Self.plainCode(code))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(languageLabel)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                if isHovering {
                    MessageActionButton(
                        systemImage: isWrapped ? "arrow.left.and.right" : "arrow.down.right.and.line.horizontal.and.line.vertical.and.arrow.down",
                        help: isWrapped ? "Disable word wrap" : "Enable word wrap"
                    ) {
                        withAnimation(Motion.fade) { isWrapped.toggle() }
                    }
                    .transition(.opacity)
                }
                CopyActionButton(text: code)
                    .opacity(isHovering ? 1 : 0.55)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity)
            .background(Color.secondary.opacity(0.06))
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(.separator)
                    .frame(height: 0.5)
            }

            codeContent
                .padding(10)
        }
        .onHover { isHovering = $0 }
        .animation(Motion.fade, value: isHovering)
        .animation(Motion.fade, value: isWrapped)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Solid opaque fill — code blocks live inside long-form assistant
        // text, so no glass/material here per Liquid Glass content rules.
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator, lineWidth: 1))
        .task(id: highlightTaskID) {
            guard allowsHighlight,
                let highlighted = await CodeHighlighter.shared.highlighted(
                    code: code,
                    language: language,
                    dark: colorScheme == .dark)
            else { return }
            // Keep the state write out of an AppKit layout transaction. The
            // macOS 27 SDK can trap when measured Text content changes while
            // its hosting view is still laying out.
            try? await Task.sleep(for: .milliseconds(1))
            guard !Task.isCancelled else { return }
            withAnimation(Motion.fade) {
                displayedText = highlighted
            }
        }
    }

    @ViewBuilder
    private var codeContent: some View {
        if isWrapped {
            Text(displayedText)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(displayedText)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize()
            }
        }
    }

    private var highlightTaskID: MarkdownCodeHighlightTaskID {
        MarkdownCodeHighlightTaskID(
            code: code,
            language: language,
            dark: colorScheme == .dark,
            allowsHighlight: allowsHighlight)
    }

    private var languageLabel: String {
        guard let language = language?.trimmingCharacters(in: .whitespacesAndNewlines),
            !language.isEmpty
        else { return "Code" }
        return language.capitalized
    }

    private static func plainCode(_ code: String) -> AttributedString {
        var result = AttributedString(code)
        result.font = .system(.body, design: .monospaced)
        return result
    }
}

private struct MarkdownTableView: View {
    let table: MarkdownTable

    private var columnCount: Int {
        max(table.header.count, table.rows.map(\.count).max() ?? 0)
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    tableCells(table.header, isHeader: true)
                }
                Rectangle()
                    .fill(.separator)
                    .opacity(0.5)
                    .frame(height: 1)
                    .gridCellColumns(max(columnCount, 1))
                ForEach(Array(table.rows.enumerated()), id: \.offset) { rowIndex, row in
                    GridRow {
                        tableCells(row, isHeader: false, rowIndex: rowIndex)
                    }
                }
            }
            .padding(8)
        }
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator, lineWidth: 1))
    }

    @ViewBuilder
    private func tableCells(
        _ cells: [AttributedString],
        isHeader: Bool,
        rowIndex: Int = 0
    ) -> some View {
        ForEach(0..<columnCount, id: \.self) { index in
            let cell = index < cells.count ? cells[index] : AttributedString()
            let columnAlignment = table.columnAlignments.indices.contains(index)
                ? table.columnAlignments[index] : nil
            Text(cell)
                .font(isHeader ? .body.weight(.semibold) : .body)
                .textSelection(.enabled)
                .multilineTextAlignment(columnAlignment ?? .leading)
                .frame(minWidth: 72, alignment: alignment(columnAlignment))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(cellBackground(isHeader: isHeader, rowIndex: rowIndex))
        }
    }

    private func cellBackground(isHeader: Bool, rowIndex: Int) -> Color {
        if isHeader {
            return MarkdownTheme.tableHeaderFill
        }
        return rowIndex.isMultiple(of: 2) ? MarkdownTheme.tableOddRowFill : .clear
    }

    private func alignment(_ alignment: TextAlignment?) -> Alignment {
        switch alignment {
        case .center: return .center
        case .trailing: return .trailing
        default: return .leading
        }
    }
}
