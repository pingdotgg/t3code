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
    @State private var renderedDocument: MarkdownRenderedDocument?
    @State private var isSelectingText = false

    init(_ source: String, isStreaming: Bool = false) {
        self.source = source
        self.isStreaming = isStreaming
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
        Group {
            if let displayDocument {
                MarkdownBlocksView(blocks: displayDocument.blocks)
            } else {
                // Parsing waits briefly so token-by-token streaming cancels stale revisions
                // instead of scheduling work for content the user will never see.
                Text(verbatim: source)
                    .font(T3Typography.threadBody)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .modifier(MarkdownTextSelectionModifier(isEnabled: isSelectingText))
        .contextMenu {
            Button {
                isSelectingText.toggle()
            } label: {
                Label(
                    isSelectingText ? "Done selecting" : "Select text",
                    systemImage: isSelectingText ? "checkmark" : "text.cursor"
                )
            }
            Button {
                UIPasteboard.general.string = source
            } label: {
                Label("Copy message", systemImage: "doc.on.doc")
            }
        }
        .accessibilityAction(named: "Copy message") {
            UIPasteboard.general.string = source
        }
        .task(id: RenderRequest(revision: revision, isStreaming: isStreaming)) {
            if !isStreaming {
                renderedDocument = MarkdownRenderCache.shared.documentImmediately(for: revision)
                return
            }

            if let cached = MarkdownRenderCache.shared.cachedDocument(for: revision) {
                renderedDocument = cached
                return
            }

            do {
                try await Task.sleep(for: .milliseconds(200))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }

            guard let rendered = await MarkdownRenderCache.shared.document(for: revision),
                  !Task.isCancelled,
                  rendered.revision == revision else {
                return
            }
            renderedDocument = rendered
        }
    }

    private var displayDocument: MarkdownRenderedDocument? {
        if let renderedDocument, renderedDocument.revision == revision {
            return renderedDocument
        }
        guard !isStreaming else { return nil }
        return MarkdownRenderCache.shared.documentImmediately(for: revision)
    }
}

private struct MarkdownTextSelectionModifier: ViewModifier {
    let isEnabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if isEnabled {
            content.textSelection(.enabled)
        } else {
            content
        }
    }
}

private struct MarkdownBlocksView: View {
    let blocks: [MarkdownRenderedBlock]
    var spacing: CGFloat = 12

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(blocks.indices, id: \.self) { index in
                MarkdownBlockView(block: blocks[index])
            }
        }
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownRenderedBlock

    @ViewBuilder
    var body: some View {
        switch block {
        case let .paragraph(inline):
            MarkdownInlineText(inline)
                .lineSpacing(4)

        case let .heading(level, inline):
            MarkdownInlineText(inline)
                .padding(.top, level <= 2 ? 3 : 1)

        case let .unorderedList(items):
            MarkdownListView(items: items, start: nil)

        case let .orderedList(start, items):
            MarkdownListView(items: items, start: start)

        case let .blockquote(blocks):
            MarkdownBlocksView(blocks: blocks, spacing: 9)
                .foregroundStyle(T3Colors.textSecondary)
                .padding(.leading, 14)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(T3Colors.textTertiary)
                        .frame(width: 2)
                }

        case let .table(table):
            MarkdownTableView(table: table)

        case let .codeBlock(language, code):
            MarkdownCodeBlockView(language: language, code: code)

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
    private let columnWidths: [CGFloat]

    init(table: MarkdownRenderedTable) {
        self.table = table
        columnWidths = Self.measureColumnWidths(table)
    }

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
                MarkdownInlineText(cells[columnIndex])
                    .lineSpacing(3)
                    .frame(
                        width: columnWidths[columnIndex],
                        alignment: alignment(for: columnIndex)
                    )
                    .frame(minHeight: 44, alignment: alignment(for: columnIndex))
                    .padding(.horizontal, 11)
                    .padding(.vertical, 8)
                    .overlay(alignment: .trailing) {
                        if columnIndex < cells.count - 1 {
                            Rectangle()
                                .fill(T3Colors.separator)
                                .frame(width: 1)
                        }
                    }
                    .accessibilityElement(children: .combine)
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

    private static func measureColumnWidths(_ table: MarkdownRenderedTable) -> [CGFloat] {
        let cells = [table.header] + table.rows
        return table.header.indices.map { columnIndex in
            let longestLine = cells
                .compactMap { row -> Int? in
                    guard row.indices.contains(columnIndex) else { return nil }
                    return String(row[columnIndex].attributedText.characters)
                        .split(separator: "\n", omittingEmptySubsequences: false)
                        .map(\.count)
                        .max()
                }
                .max() ?? 0

            // This is deliberately an estimate rather than text measurement. Exact widths
            // would require laying every cell out twice, which is expensive in long threads.
            return min(300, max(140, CGFloat(longestLine) * 8.25))
        }
    }
}

private struct MarkdownListView: View {
    let items: [MarkdownRenderedListItem]
    let start: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(items.indices, id: \.self) { offset in
                let item = items[offset]
                HStack(alignment: .top, spacing: 8) {
                    marker(for: item, offset: offset)
                        .frame(width: 24, height: 24, alignment: .trailing)
                    MarkdownBlocksView(blocks: item.blocks, spacing: 7)
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
                Text(verbatim: code)
                    .font(T3Typography.code)
                    .foregroundStyle(T3Colors.textPrimary.opacity(0.94))
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(13)
            } else {
                ScrollView(.horizontal) {
                    Text(verbatim: code)
                        .font(T3Typography.code)
                        .foregroundStyle(T3Colors.textPrimary.opacity(0.94))
                        .lineSpacing(3)
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

private struct MarkdownInlineText: View {
    private let attributedText: AttributedString
    private let font: Font

    init(_ rendered: MarkdownRenderedInline) {
        attributedText = rendered.attributedText
        font = rendered.style.font
    }

    var body: some View {
        Text(attributedText)
            .font(font)
            .fixedSize(horizontal: false, vertical: true)
    }
}

enum MarkdownInlineFormatter {
    static func format(_ source: String, baseFont: Font = .body) -> AttributedString {
        var attributed = (
            try? AttributedString(
                markdown: source,
                options: AttributedString.MarkdownParsingOptions(
                    interpretedSyntax: .inlineOnlyPreservingWhitespace,
                    failurePolicy: .returnPartiallyParsedIfPossible
                )
            )
        ) ?? AttributedString(source)

        let styles = attributed.runs.map { run in
            (run.range, run.inlinePresentationIntent, run.link)
        }
        for (range, intent, link) in styles {
            if intent?.contains(.code) == true {
                attributed[range].font = baseFont.monospaced()
                attributed[range].foregroundColor = T3Colors.textPrimary.opacity(0.9)
                attributed[range].backgroundColor = T3Colors.surfaceRaised
            }
            if link != nil {
                attributed[range].foregroundColor = T3Colors.accent
            }
        }
        return attributed
    }
}
