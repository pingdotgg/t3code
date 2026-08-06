import Foundation
import SwiftUI

/// An exact content revision with a cheap, deterministic hash for SwiftUI task identity.
/// Source equality remains the final check, so a fingerprint collision cannot return stale text.
struct MarkdownContentRevision: Hashable, Sendable {
    let source: String
    let fingerprint: UInt64
    let utf8Count: Int

    init(_ source: String) {
        self.source = source
        utf8Count = source.utf8.count

        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in source.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        fingerprint = hash
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.fingerprint == rhs.fingerprint
            && lhs.utf8Count == rhs.utf8Count
            && lhs.source == rhs.source
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(fingerprint)
        hasher.combine(utf8Count)
    }
}

enum MarkdownInlineStyle: String, Hashable, Sendable {
    case body
    case heading1
    case heading2
    case heading3
    case heading4
    case tableHeader
    case tableCell

    var font: Font {
        switch self {
        case .body: T3Typography.threadBody
        case .heading1: T3Typography.threadHeading1
        case .heading2: T3Typography.threadHeading2
        case .heading3: T3Typography.threadHeading3
        case .heading4: T3Typography.threadHeading4
        case .tableHeader: T3Typography.threadBody.weight(.semibold)
        case .tableCell: T3Typography.threadBody
        }
    }

    static func heading(level: Int) -> Self {
        switch level {
        case 1: .heading1
        case 2: .heading2
        case 3: .heading3
        default: .heading4
        }
    }
}

/// Reference semantics let consecutive streaming revisions share unchanged inline runs.
final class MarkdownRenderedInline: @unchecked Sendable {
    let attributedText: AttributedString
    let style: MarkdownInlineStyle

    init(attributedText: AttributedString, style: MarkdownInlineStyle) {
        self.attributedText = attributedText
        self.style = style
    }
}

struct MarkdownRenderedListItem: @unchecked Sendable {
    let task: MarkdownTaskState?
    let blocks: [MarkdownRenderedBlock]
}

struct MarkdownRenderedTable: @unchecked Sendable {
    let header: [MarkdownRenderedInline]
    let alignments: [MarkdownTableAlignment]
    let rows: [[MarkdownRenderedInline]]
}

indirect enum MarkdownRenderedBlock: @unchecked Sendable {
    case paragraph(MarkdownRenderedInline)
    case heading(level: Int, inline: MarkdownRenderedInline)
    case unorderedList([MarkdownRenderedListItem])
    case orderedList(start: Int, items: [MarkdownRenderedListItem])
    case blockquote([MarkdownRenderedBlock])
    case table(MarkdownRenderedTable)
    case codeBlock(language: String?, code: String)
    case thematicBreak
}

/// Immutable render plans are safe to reuse every time SwiftUI reconstructs a message row.
final class MarkdownRenderedDocument: @unchecked Sendable {
    let revision: MarkdownContentRevision
    let blocks: [MarkdownRenderedBlock]

    init(revision: MarkdownContentRevision, blocks: [MarkdownRenderedBlock]) {
        self.revision = revision
        self.blocks = blocks
    }
}

private final class MarkdownRenderedInlineBox: NSObject {
    let value: MarkdownRenderedInline

    init(_ value: MarkdownRenderedInline) {
        self.value = value
    }
}

/// Bounded, process-local caches keep history navigation and SwiftUI diffing from reparsing
/// unchanged messages. Cache misses are rendered by a detached task and duplicate requests
/// for the same revision share one in-flight render.
final class MarkdownRenderCache: @unchecked Sendable {
    static let shared = MarkdownRenderCache()

    private let documents = NSCache<NSString, MarkdownRenderedDocument>()
    private let inlineRuns = NSCache<NSString, MarkdownRenderedInlineBox>()
    private let inFlightQueue = DispatchQueue(label: "codes.t3.native.markdown-render-cache")
    private struct InFlightRender {
        let task: Task<MarkdownRenderedDocument?, Never>
        var waiters: Set<UUID>
    }
    private var inFlight: [MarkdownContentRevision: InFlightRender] = [:]

    init(
        documentCountLimit: Int = 512,
        documentCostLimit: Int = 12 * 1_024 * 1_024,
        inlineCountLimit: Int = 2_048,
        inlineCostLimit: Int = 8 * 1_024 * 1_024
    ) {
        documents.countLimit = documentCountLimit
        documents.totalCostLimit = documentCostLimit
        inlineRuns.countLimit = inlineCountLimit
        inlineRuns.totalCostLimit = inlineCostLimit
    }

    /// Keys use the precomputed fingerprint instead of the full source so each
    /// lookup avoids bridging and hashing the entire message body. The stored
    /// document's revision equality check below makes collisions safe.
    private func cacheKey(for revision: MarkdownContentRevision) -> NSString {
        "\(revision.fingerprint):\(revision.utf8Count)" as NSString
    }

    func cachedDocument(for revision: MarkdownContentRevision) -> MarkdownRenderedDocument? {
        let document = documents.object(forKey: cacheKey(for: revision))
        return document?.revision == revision ? document : nil
    }

    /// Completed transcript rows must have their final geometry on first display.
    /// Prefetching normally makes this a cache hit; the synchronous fallback prevents
    /// a visible plain-text-to-Markdown layout swap when UIKit misses a prefetch window.
    func documentImmediately(
        for revision: MarkdownContentRevision
    ) -> MarkdownRenderedDocument? {
        if let cached = cachedDocument(for: revision) {
            return cached
        }
        guard let document = renderDocument(revision) else { return nil }
        documents.setObject(
            document,
            forKey: cacheKey(for: revision),
            cost: documentCost(document)
        )
        return document
    }

    /// Set `isIntermediate` for in-progress streaming revisions: they are
    /// superseded within milliseconds, and inserting each one would churn
    /// completed messages out of the bounded document cache. Unchanged inline
    /// runs are still shared through the inline cache either way.
    func document(
        for revision: MarkdownContentRevision,
        isIntermediate: Bool = false
    ) async -> MarkdownRenderedDocument? {
        guard !Task.isCancelled else { return nil }
        if let cached = cachedDocument(for: revision) {
            return cached
        }

        let waiterID = UUID()
        let task = inFlightTask(for: revision, waiterID: waiterID)
        let document = await withTaskCancellationHandler {
            let document = await task.value
            releaseWaiter(for: revision, waiterID: waiterID, cancelIfLast: false)
            return document
        } onCancel: { [self] in
            releaseWaiter(for: revision, waiterID: waiterID, cancelIfLast: true)
        }
        guard !Task.isCancelled, let document else { return nil }
        if !isIntermediate {
            documents.setObject(
                document,
                forKey: cacheKey(for: revision),
                cost: documentCost(document)
            )
        }
        return document
    }

    /// Adopts a document that was rendered as a streaming intermediate. Called
    /// when its message completes so the final revision becomes a durable
    /// cache entry without reparsing on the main thread.
    func promote(_ document: MarkdownRenderedDocument) {
        guard cachedDocument(for: document.revision) == nil else { return }
        documents.setObject(
            document,
            forKey: cacheKey(for: document.revision),
            cost: documentCost(document)
        )
    }

    func removeAll() {
        documents.removeAllObjects()
        inlineRuns.removeAllObjects()
        let tasks = inFlightQueue.sync {
            let tasks = inFlight.values.map(\.task)
            inFlight.removeAll(keepingCapacity: true)
            return tasks
        }
        tasks.forEach { $0.cancel() }
    }

    private func inFlightTask(
        for revision: MarkdownContentRevision,
        waiterID: UUID
    ) -> Task<MarkdownRenderedDocument?, Never> {
        inFlightQueue.sync {
            if var existing = inFlight[revision] {
                existing.waiters.insert(waiterID)
                inFlight[revision] = existing
                return existing.task
            }

            let task = Task.detached(priority: .userInitiated) { [self] in
                renderDocument(revision)
            }
            inFlight[revision] = InFlightRender(task: task, waiters: [waiterID])
            return task
        }
    }

    private func releaseWaiter(
        for revision: MarkdownContentRevision,
        waiterID: UUID,
        cancelIfLast: Bool
    ) {
        let taskToCancel: Task<MarkdownRenderedDocument?, Never>? = inFlightQueue.sync {
            guard var render = inFlight[revision],
                  render.waiters.remove(waiterID) != nil else {
                return nil
            }
            guard render.waiters.isEmpty else {
                inFlight[revision] = render
                return nil
            }
            inFlight.removeValue(forKey: revision)
            return cancelIfLast ? render.task : nil
        }
        taskToCancel?.cancel()
    }

    private func renderDocument(_ revision: MarkdownContentRevision) -> MarkdownRenderedDocument? {
        guard !Task.isCancelled else { return nil }
        let document = MarkdownDocument(parsing: revision.source)
        guard !Task.isCancelled, let blocks = renderBlocks(document.blocks) else { return nil }
        return MarkdownRenderedDocument(
            revision: revision,
            blocks: blocks
        )
    }

    private func renderBlocks(_ blocks: [MarkdownBlock]) -> [MarkdownRenderedBlock]? {
        var renderedBlocks: [MarkdownRenderedBlock] = []
        renderedBlocks.reserveCapacity(blocks.count)
        for block in blocks {
            guard !Task.isCancelled else { return nil }
            let rendered: MarkdownRenderedBlock
            switch block {
            case let .paragraph(source):
                guard let inline = renderInline(source, style: .body) else { return nil }
                rendered = .paragraph(inline)

            case let .heading(level, source):
                guard let inline = renderInline(source, style: .heading(level: level)) else {
                    return nil
                }
                rendered = .heading(
                    level: level,
                    inline: inline
                )

            case let .unorderedList(items):
                guard let items = renderItems(items) else { return nil }
                rendered = .unorderedList(items)

            case let .orderedList(start, items):
                guard let items = renderItems(items) else { return nil }
                rendered = .orderedList(start: start, items: items)

            case let .blockquote(document):
                guard let blocks = renderBlocks(document.blocks) else { return nil }
                rendered = .blockquote(blocks)

            case let .table(table):
                guard let table = renderTable(table) else { return nil }
                rendered = .table(table)

            case let .codeBlock(language, code):
                rendered = .codeBlock(language: language, code: code)

            case .thematicBreak:
                rendered = .thematicBreak
            }
            renderedBlocks.append(rendered)
        }
        return renderedBlocks
    }

    private func renderTable(_ table: MarkdownTable) -> MarkdownRenderedTable? {
        var header: [MarkdownRenderedInline] = []
        header.reserveCapacity(table.header.count)
        for cell in table.header {
            guard let inline = renderInline(cell, style: .tableHeader) else { return nil }
            header.append(inline)
        }

        var rows: [[MarkdownRenderedInline]] = []
        rows.reserveCapacity(table.rows.count)
        for sourceRow in table.rows {
            guard !Task.isCancelled else { return nil }
            var row: [MarkdownRenderedInline] = []
            row.reserveCapacity(sourceRow.count)
            for cell in sourceRow {
                guard let inline = renderInline(cell, style: .tableCell) else { return nil }
                row.append(inline)
            }
            rows.append(row)
        }

        return MarkdownRenderedTable(
            header: header,
            alignments: table.alignments,
            rows: rows
        )
    }

    private func renderItems(_ items: [MarkdownListItem]) -> [MarkdownRenderedListItem]? {
        var renderedItems: [MarkdownRenderedListItem] = []
        renderedItems.reserveCapacity(items.count)
        for item in items {
            guard !Task.isCancelled, let blocks = renderBlocks(item.blocks) else { return nil }
            renderedItems.append(MarkdownRenderedListItem(task: item.task, blocks: blocks))
        }
        return renderedItems
    }

    private func renderInline(
        _ source: String,
        style: MarkdownInlineStyle
    ) -> MarkdownRenderedInline? {
        guard !Task.isCancelled else { return nil }
        let key = "\(style.rawValue)\u{0}\(source)" as NSString
        if let cached = inlineRuns.object(forKey: key) {
            return cached.value
        }

        let inline = MarkdownRenderedInline(
            attributedText: MarkdownInlineFormatter.format(source, baseFont: style.font),
            style: style
        )
        guard !Task.isCancelled else { return nil }
        inlineRuns.setObject(
            MarkdownRenderedInlineBox(inline),
            forKey: key,
            cost: max(64, source.utf8.count * 2)
        )
        return inline
    }

    private func documentCost(_ document: MarkdownRenderedDocument) -> Int {
        max(256, document.revision.utf8Count * 3)
    }
}
