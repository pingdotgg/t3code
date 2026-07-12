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
    public func groupedForDisplay(
        threadIsSettled: Bool = false,
        now: Date = Date(),
        calendar: Calendar = .current,
        includeSeparators: Bool = true
    ) -> [TimelineDisplayItem] {
        var result: [TimelineDisplayItem] = []
        var run: [TimelineItem] = []

        func flush(somethingFollows: Bool) {
            defer { run.removeAll() }
            guard !run.isEmpty else { return }
            let tools = run.compactMap { item -> ToolCall? in
                guard case .toolEvent(_, _, let detail, let kind, let status, _, _, _) = item else {
                    return nil
                }
                return ToolCall(detail: detail, kind: kind, status: status)
            }
            let allFinished = threadIsSettled || tools.allSatisfy { $0.status != .running }
            guard somethingFollows, allFinished, tools.count >= 2 else {
                result.append(contentsOf: run.map { .single($0) })
                return
            }
            result.append(
                .toolGroup(
                    // Keyed to the first row: stable while lifecycle upserts
                    // rewrite members in place, so the disclosure state and
                    // row identity survive re-grouping.
                    id: "toolgroup:\(run[0].id)",
                    items: run,
                    summary: ToolGroupSummary(
                        toolCount: tools.count,
                        editedFileCount: Self.editedFileCount(of: tools),
                        failedCount: tools.count { $0.status == .failed })))
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

        for item in self {
            if includeSeparators, let label = separatorForItem(item, previousAt: previousAt) {
                flush(somethingFollows: true)
                result.append(.daySeparator(id: "day-separator:\(item.id)", label: label))
            }

            switch item {
            case .toolEvent, .reasoning:
                run.append(item)
            default:
                flush(somethingFollows: true)
                result.append(.single(item))
            }

            if let at = item.at, previousAt.map({ at > $0 }) ?? true {
                previousAt = at
            }
        }
        flush(somethingFollows: false)
        return result
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
/// details. Cache keyed on (threadID, version, settled, current calendar day)
/// so body re-evals with an unchanged timeline reuse the last grouping without
/// leaving a stale Today/Yesterday label across midnight. One entry per
/// thread — only the latest key/value pair is kept.
@MainActor
enum TimelineDisplayCache {
    private struct Key: Equatable {
        var threadID: String
        var version: Int
        var threadIsSettled: Bool
        var relativeDay: Date
    }

    private static var storage: [String: (key: Key, value: [TimelineDisplayItem])] = [:]

    static func grouped(
        items: [TimelineItem],
        threadID: String,
        version: Int,
        threadIsSettled: Bool
    ) -> [TimelineDisplayItem] {
        let now = Date()
        let calendar = Calendar.current
        let key = Key(
            threadID: threadID,
            version: version,
            threadIsSettled: threadIsSettled,
            relativeDay: calendar.startOfDay(for: now))
        if let entry = storage[threadID], entry.key == key {
            return entry.value
        }
        let value = items.groupedForDisplay(
            threadIsSettled: threadIsSettled,
            now: now,
            calendar: calendar)
        storage[threadID] = (key, value)
        return value
    }

    /// Drop a thread's memo entry (timeline release / eviction / removal).
    static func evict(threadID: String) {
        storage.removeValue(forKey: threadID)
    }
}
