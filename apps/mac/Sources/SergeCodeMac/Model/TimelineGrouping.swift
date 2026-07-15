import Foundation
import T3Kit

// Render-level condensing over `TimelineItem`: once the agent has moved past
// a burst of tool work (it said something afterwards), that burst reads as
// noise, so the timeline shows one summary row instead. The underlying
// timeline array is untouched — grouping is recomputed per render.

public enum TimelineDisplayItem: Identifiable, Equatable, Sendable {
    case single(TimelineItem)
    /// A finished run of consecutive tool/reasoning rows, condensed behind
    /// one disclosure ("Ran 6 tools · edited 3 files").
    case toolGroup(id: String, items: [TimelineItem], summary: ToolGroupSummary)
    case daySeparator(id: String, label: String)

    public var id: String {
        switch self {
        case .single(let item): item.id
        case .toolGroup(let id, _, _): id
        case .daySeparator(let id, _): id
        }
    }

    public var at: Date? {
        switch self {
        case .single(let item): item.at
        case .toolGroup(_, let items, _): items.first?.at
        case .daySeparator: nil
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
    /// Id of the one decision card that owns the Approve/Deny/Submit/Implement/
    /// Wait/Dismiss keyboard shortcuts, or nil when nothing is actionable.
    ///
    /// Approve/Deny/Submit/Implement/Wait/Dismiss gain keyboard shortcuts
    /// (ApprovalCard, UserInputCard, PlanCard, UsageLimitCard), but only the
    /// single most-recent actionable card across all kinds should own them — a
    /// scrollback full of historical cards must never let a keystroke resolve
    /// the wrong one. Approvals and user-input requests are removed from the
    /// timeline once resolved (AppModel.resolveInteraction), while usage-limit
    /// notices and already-implemented plans can remain alongside newer pending
    /// cards. Scan from the end and stop at the nearest card that still has an
    /// action, regardless of its kind.
    ///
    /// Resolved once per render and handed to rows as a value, so no card row
    /// has to observe the whole timeline to know whether it is the active one.
    public var activeDecisionCardID: String? {
        for item in reversed() {
            switch item {
            case .approval, .userInput, .usageLimit:
                return item.id
            case .plan(let plan) where !plan.isImplemented:
                return item.id
            default:
                continue
            }
        }
        return nil
    }
}

private func formattedTimelineDate(
    _ date: Date,
    calendar: Calendar,
    style: Date.FormatStyle
) -> String {
    var style = style
    style.calendar = calendar
    style.timeZone = calendar.timeZone
    return date.formatted(style)
}

/// Human-readable label for a calendar-day separator. The relative date and
/// calendar are explicit so grouping and its labels remain deterministic in
/// tests and across time zones.
func separatorLabel(for date: Date, relativeTo now: Date, calendar: Calendar) -> String {
    if calendar.isDate(date, inSameDayAs: now) {
        return "Today"
    }

    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
        calendar.isDate(date, inSameDayAs: yesterday)
    {
        return "Yesterday"
    }

    let dateYear = calendar.component(.year, from: date)
    let nowYear = calendar.component(.year, from: now)
    if dateYear != nowYear {
        return formattedTimelineDate(
            date,
            calendar: calendar,
            style: .dateTime.month(.abbreviated).day().year())
    }

    let dateDay = calendar.startOfDay(for: date)
    let nowDay = calendar.startOfDay(for: now)
    if let dayDistance = calendar.dateComponents([.day], from: dateDay, to: nowDay).day,
        (2...6).contains(dayDistance)
    {
        return formattedTimelineDate(
            date,
            calendar: calendar,
            style: .dateTime.weekday(.wide))
    }

    return formattedTimelineDate(
        date,
        calendar: calendar,
        style: .dateTime.month(.abbreviated).day())
}

/// Time-only label used when a same-day pause separates two transcript items.
func separatorTimeLabel(for date: Date, calendar: Calendar) -> String {
    formattedTimelineDate(date, calendar: calendar, style: .dateTime.hour().minute())
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
        threadIsSettled: Bool = false,
        now: Date = Date(),
        calendar: Calendar = .current,
        includeSeparators: Bool = true
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

        func separatorForItem(_ item: TimelineItem, previousAt: Date?) -> String? {
            guard let currentAt = item.at, let previousAt else { return nil }
            guard currentAt >= previousAt else { return nil }
            if !calendar.isDate(currentAt, inSameDayAs: previousAt) {
                return separatorLabel(
                    for: currentAt, relativeTo: now, calendar: calendar)
            }
            guard currentAt.timeIntervalSince(previousAt) > 60 * 60 else { return nil }
            return separatorTimeLabel(for: currentAt, calendar: calendar)
        }

        var previousAt: Date?

        for (index, item) in self.enumerated() {
            if includeSeparators, let label = separatorForItem(item, previousAt: previousAt) {
                flush(somethingFollows: true)
                result.append(.daySeparator(id: "day-separator:\(item.id)", label: label))
                // Separators are visual chrome over no source items: an empty
                // range keeps the ranges array parallel with the result rows.
                ranges.append(index..<index)
            }

            switch item {
            case .toolEvent, .reasoning:
                run.append((index, item))
            default:
                flush(somethingFollows: true)
                result.append(.single(item))
                ranges.append(index..<(index + 1))
            }

            if let at = item.at, previousAt.map({ at > $0 }) ?? true {
                previousAt = at
            }
        }
        flush(somethingFollows: false)
        return (result, ranges)
    }

    @MainActor
    public func groupedForDisplay(
        threadIsSettled: Bool = false,
        now: Date = Date(),
        calendar: Calendar = .current,
        includeSeparators: Bool = true
    ) -> [TimelineDisplayItem] {
        groupedForDisplayWithRanges(
            threadIsSettled: threadIsSettled,
            now: now,
            calendar: calendar,
            includeSeparators: includeSeparators
        ).items
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
/// grouping pass. Structure identity includes the calendar day so a stale
/// Today/Yesterday label cannot survive midnight. One entry per thread —
/// only the latest key/value pair is kept.
@MainActor
enum TimelineDisplayCache {
    private struct StructureKey: Equatable {
        var threadID: String
        var structureVersion: Int
        var threadIsSettled: Bool
        var relativeDay: Date
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
        let now = Date()
        let calendar = Calendar.current
        let structureKey = StructureKey(
            threadID: threadID,
            structureVersion: structureVersion,
            threadIsSettled: threadIsSettled,
            relativeDay: calendar.startOfDay(for: now))

        func fullPassAndStore() -> [TimelineDisplayItem] {
            let result = fullPass(
                items: items, threadIsSettled: threadIsSettled, now: now, calendar: calendar)
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
            if case .daySeparator = cached { return range.isEmpty }
            guard !range.isEmpty, range.upperBound <= items.count else { return false }
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
            case .daySeparator:
                return range.isEmpty
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
        // Rebuild only the rows whose underlying items actually changed. A
        // streaming delta touches exactly one row; every other row keeps its
        // cached value verbatim (same string/array storage), so the row view's
        // `Equatable` check short-circuits and SwiftUI skips its body. Handing
        // back freshly constructed values for all N rows instead made every
        // realized row re-render ~30x/second for the whole run.
        var rebuiltRows = 0
        let refreshed = zip(entry.items, entry.ranges).map { cached, range -> TimelineDisplayItem in
            switch cached {
            case .single(let cachedItem):
                let item = items[range.lowerBound]
                guard item != cachedItem else { return cached }
                rebuiltRows += 1
                return .single(item)
            case .toolGroup(let id, let cachedItems, let summary):
                guard !items[range].elementsEqual(cachedItems) else { return cached }
                rebuiltRows += 1
                return .toolGroup(id: id, items: Array(items[range]), summary: summary)
            case .daySeparator:
                // Label freshness is guaranteed by relativeDay in the
                // structure key; content refreshes reuse it as-is.
                return cached
            }
        }
        PerfMetrics.count("grouping.rowsRebuilt", by: rebuiltRows)
        storage[threadID] = Entry(
            structureKey: structureKey,
            timelineVersion: version,
            items: refreshed,
            ranges: entry.ranges)
        return refreshed
    }

    private static func fullPass(
        items: [TimelineItem], threadIsSettled: Bool, now: Date, calendar: Calendar
    ) -> (items: [TimelineDisplayItem], ranges: [Range<Int>]) {
        fullPassCount += 1
        PerfMetrics.count("grouping.fullPass")
        return PerfSignpost.interval("grouping") {
            PerfMetrics.measure("grouping") {
                items.groupedForDisplayWithRanges(
                    threadIsSettled: threadIsSettled, now: now, calendar: calendar)
            }
        }
    }

    private static func rangesCoverAllItems(_ ranges: [Range<Int>], itemCount: Int) -> Bool {
        var nextIndex = 0
        for range in ranges {
            guard range.lowerBound == nextIndex, range.upperBound <= itemCount
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
