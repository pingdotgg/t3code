import Foundation
import T3Kit

// Render-level condensing over `TimelineItem`: once the agent has moved past
// a burst of tool work (it said something afterwards), that burst reads as
// noise, so the timeline shows one summary row instead. The underlying
// timeline array is untouched — grouping is recomputed per render.

public enum TimelineDisplayItem: Identifiable, Sendable {
    case single(TimelineItem)
    /// A finished run of consecutive tool/reasoning rows, condensed behind
    /// one disclosure ("Ran 6 tools · edited 3 files").
    case toolGroup(id: String, items: [TimelineItem], summary: ToolGroupSummary)

    public var id: String {
        switch self {
        case .single(let item): item.id
        case .toolGroup(let id, _, _): id
        }
    }
}

/// Headline numbers for a condensed tool run.
public struct ToolGroupSummary: Hashable, Sendable {
    public var toolCount: Int
    public var editedFileCount: Int
    public var failedCount: Int

    public init(toolCount: Int, editedFileCount: Int, failedCount: Int) {
        self.toolCount = toolCount
        self.editedFileCount = editedFileCount
        self.failedCount = failedCount
    }
}

extension Array where Element == TimelineItem {
    /// Collapses each maximal run of consecutive tool-event/reasoning rows
    /// into a `toolGroup` when the run is over: at least two tools, none
    /// still running, and a later item already follows it (the agent has
    /// responded and moved on). The trailing run of a live turn stays as
    /// individual rows so the user can watch work happen.
    ///
    /// `threadIsSettled`: providers don't always close every tool's
    /// lifecycle, so once the thread has settled a row still marked running
    /// counts as finished (mirrors ToolEventRow's settled display state).
    ///
    /// MainActor: routes file-change parsing through `ToolDetailParseCache`.
    @MainActor
    func groupedForDisplayWithRanges(
        threadIsSettled: Bool = false
    ) -> (items: [TimelineDisplayItem], ranges: [Range<Int>]) {
        var result: [TimelineDisplayItem] = []
        var ranges: [Range<Int>] = []
        var run: [(index: Int, item: TimelineItem)] = []

        func flush(somethingFollows: Bool) {
            defer { run.removeAll() }
            guard !run.isEmpty else { return }
            let tools = run.compactMap { entry -> ToolCall? in
                guard case .toolEvent(_, _, let detail, let kind, let status, _, _, _) = entry.item else {
                    return nil
                }
                return ToolCall(detail: detail, kind: kind, status: status)
            }
            let allFinished = threadIsSettled || tools.allSatisfy { $0.status != .running }
            guard somethingFollows, allFinished, tools.count >= 2 else {
                result.append(contentsOf: run.map { .single($0.item) })
                ranges.append(contentsOf: run.map { $0.index..<$0.index + 1 })
                return
            }
            let sourceRange = run[0].index..<(run[run.count - 1].index + 1)
            result.append(
                .toolGroup(
                    // Keyed to the first row: stable while lifecycle upserts
                    // rewrite members in place, so the disclosure state and
                    // row identity survive re-grouping.
                    id: "toolgroup:\(run[0].item.id)",
                    items: run.map { $0.item },
                    summary: ToolGroupSummary(
                        toolCount: tools.count,
                        editedFileCount: Self.editedFileCount(of: tools),
                        failedCount: tools.count { $0.status == .failed })))
            ranges.append(sourceRange)
        }

        for (index, item) in self.enumerated() {
            switch item {
            case .toolEvent, .reasoning:
                run.append((index, item))
            default:
                flush(somethingFollows: true)
                result.append(.single(item))
                ranges.append(index..<(index + 1))
            }
        }
        flush(somethingFollows: false)
        return (result, ranges)
    }

    @MainActor
    public func groupedForDisplay(threadIsSettled: Bool = false) -> [TimelineDisplayItem] {
        groupedForDisplayWithRanges(threadIsSettled: threadIsSettled).items
    }

    private struct ToolCall {
        var detail: String
        var kind: ToolEventKind
        var status: ToolEventStatus
    }

    /// Distinct files touched by the run's file-change tools, keyed on the
    /// path parsed out of the edit payload so repeated edits to one file
    /// count once. Unparseable payloads (the server truncates long inputs)
    /// fall back to the raw detail string as the dedup key.
    @MainActor
    private static func editedFileCount(of tools: [ToolCall]) -> Int {
        let keys = tools.lazy
            .filter { $0.kind == .fileChange }
            .map { tool -> String in
                if case .fileChange(let path, _) = ToolDetailParseCache.parsed(
                    detail: tool.detail, itemType: "file_change")
                {
                    return path
                }
                return tool.detail
            }
        return Set(keys).count
    }
}

// MARK: - Grouped-display cache

/// `groupedForDisplay` walks the whole timeline and re-parses file-change
/// details. The cache separates structure identity from content identity so
/// in-place assistant streaming can refresh rows without repeating the full
/// grouping pass. One entry per thread — only the latest key/value pair is
/// kept.
@MainActor
enum TimelineDisplayCache {
    private struct StructureKey: Equatable {
        var threadID: String
        var structureVersion: Int
        var threadIsSettled: Bool
    }

    private struct Entry {
        var structureKey: StructureKey
        var timelineVersion: Int
        var items: [TimelineDisplayItem]
        var ranges: [Range<Int>]
    }

    private static var storage: [String: Entry] = [:]
    private(set) static var fullPassCount = 0
    private(set) static var contentRefreshCount = 0

    static func grouped(
        items: [TimelineItem],
        threadID: String,
        version: Int,
        structureVersion: Int,
        threadIsSettled: Bool
    ) -> [TimelineDisplayItem] {
        let structureKey = StructureKey(
            threadID: threadID,
            structureVersion: structureVersion,
            threadIsSettled: threadIsSettled)

        func fullPassAndStore() -> [TimelineDisplayItem] {
            let result = fullPass(items: items, threadIsSettled: threadIsSettled)
            storage[threadID] = Entry(
                structureKey: structureKey,
                timelineVersion: version,
                items: result.items,
                ranges: result.ranges)
            return result.items
        }

        guard let entry = storage[threadID] else {
            return fullPassAndStore()
        }
        guard entry.structureKey == structureKey else {
            return fullPassAndStore()
        }
        if entry.timelineVersion == version {
            return entry.items
        }
        guard version > entry.timelineVersion else {
            return fullPassAndStore()
        }

        let rangeSpanCount = entry.ranges.reduce(0) { total, range in total + range.count }
        guard entry.items.count == entry.ranges.count,
            items.count == rangeSpanCount,
            Self.rangesCoverAllItems(entry.ranges, itemCount: items.count)
        else {
            return fullPassAndStore()
        }

        let boundariesMatch = zip(entry.items, entry.ranges).allSatisfy { cached, range in
            let firstID = items[range.lowerBound].id
            let lastID = items[range.upperBound - 1].id
            switch cached {
            case .single(let cachedItem):
                return range.count == 1 && firstID == cachedItem.id && lastID == cachedItem.id
            case .toolGroup(_, let cachedItems, _):
                guard let first = cachedItems.first, let last = cachedItems.last else { return false }
                return range.count == cachedItems.count
                    && firstID == first.id
                    && lastID == last.id
            }
        }
#if DEBUG
        assert(
            boundariesMatch,
            "Timeline display cache structure changed without a structureVersion bump")
#endif
        guard boundariesMatch else {
            return fullPassAndStore()
        }

        contentRefreshCount += 1
        PerfMetrics.count("grouping.contentRefresh")
        let refreshed = zip(entry.items, entry.ranges).map { cached, range -> TimelineDisplayItem in
            switch cached {
            case .single:
                return .single(items[range.lowerBound])
            case .toolGroup(let id, _, let summary):
                return .toolGroup(
                    id: id, items: Array(items[range]), summary: summary)
            }
        }
        storage[threadID] = Entry(
            structureKey: structureKey,
            timelineVersion: version,
            items: refreshed,
            ranges: entry.ranges)
        return refreshed
    }

    private static func fullPass(
        items: [TimelineItem], threadIsSettled: Bool
    ) -> (items: [TimelineDisplayItem], ranges: [Range<Int>]) {
        fullPassCount += 1
        PerfMetrics.count("grouping.fullPass")
        return PerfSignpost.interval("grouping") {
            PerfMetrics.measure("grouping") {
                items.groupedForDisplayWithRanges(threadIsSettled: threadIsSettled)
            }
        }
    }

    private static func rangesCoverAllItems(_ ranges: [Range<Int>], itemCount: Int) -> Bool {
        var nextIndex = 0
        for range in ranges {
            guard !range.isEmpty, range.lowerBound == nextIndex,
                range.upperBound <= itemCount
            else { return false }
            nextIndex = range.upperBound
        }
        return nextIndex == itemCount
    }

    /// Reset the cache and its counters between isolated cache tests.
    static func resetForTesting() {
        storage.removeAll(keepingCapacity: true)
        fullPassCount = 0
        contentRefreshCount = 0
    }

    /// Drop a thread's memo entry (timeline release / eviction / removal).
    static func evict(threadID: String) {
        storage.removeValue(forKey: threadID)
    }
}
