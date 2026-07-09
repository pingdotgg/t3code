import Foundation

public enum T3SubagentTaskState: String, Sendable, Equatable {
    case running, completed, failed, stopped
}

/// One progress update for a subagent task. Consecutive identical
/// (toolName, text) pairs are dropped by the aggregator.
public struct T3SubagentTaskProgressEntry: Sendable, Equatable {
    public var at: Date
    public var toolName: String?
    public var text: String

    public init(at: Date, toolName: String?, text: String) {
        self.at = at
        self.toolName = toolName
        self.text = text
    }
}

/// Aggregated view of Claude Agent SDK task lifecycle telemetry. One item is
/// keyed by `taskId`; start/progress/completion events update that item in
/// place so UIs can keep the row anchored at the original spawn position.
public struct T3SubagentTaskItem: Sendable, Equatable {
    /// Soft cap on retained progress entries; oldest dropped first.
    public static let maxProgressLogEntries = 200

    public var taskId: String
    public var taskType: String?
    public var description: String?
    public var state: T3SubagentTaskState
    public var latestProgress: String?
    public var lastToolName: String?
    public var startedAt: Date
    public var completedAt: Date?
    public var completionSummary: String?
    /// Ordered progress updates (oldest first). Rebuild replays events in
    /// sequence so this matches incremental apply.
    public var progressLog: [T3SubagentTaskProgressEntry]

    public var id: String { "subagent-task:\(taskId)" }

    public var duration: TimeInterval? {
        guard let completedAt else { return nil }
        return max(0, completedAt.timeIntervalSince(startedAt))
    }

    public init(
        taskId: String,
        taskType: String?,
        description: String?,
        state: T3SubagentTaskState,
        latestProgress: String?,
        lastToolName: String?,
        startedAt: Date,
        completedAt: Date?,
        completionSummary: String?,
        progressLog: [T3SubagentTaskProgressEntry] = []
    ) {
        self.taskId = taskId
        self.taskType = taskType
        self.description = description
        self.state = state
        self.latestProgress = latestProgress
        self.lastToolName = lastToolName
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.completionSummary = completionSummary
        self.progressLog = progressLog
    }
}

public struct T3SubagentTaskActivityState: Sendable, Equatable {
    private var tasksByID: [String: T3SubagentTaskItem] = [:]
    private var order: [String] = []
    private var activeTaskIDsStorage: Set<String> = []
    private var startedTaskIDs: Set<String> = []

    public init() {}

    public var activeTaskIDs: Set<String> {
        activeTaskIDsStorage
    }

    public var activeTaskCount: Int {
        activeTaskIDsStorage.count
    }

    public var items: [T3SubagentTaskItem] {
        order.compactMap { tasksByID[$0] }
    }

    public mutating func clearActiveTasks() {
        for taskId in activeTaskIDsStorage {
            guard var item = tasksByID[taskId] else { continue }
            item.state = .stopped
            item.completedAt = item.completedAt ?? Date()
            tasksByID[taskId] = item
        }
        activeTaskIDsStorage.removeAll()
    }

    @discardableResult
    public mutating func apply(
        activity: OrchestrationThreadActivity, at: Date
    ) -> T3SubagentTaskItem? {
        switch activity.kind {
        case ActivityKind.taskStarted:
            let payload = activity.decodePayload(TaskStartedActivityPayload.self)
            guard let taskId = nonEmpty(payload?.taskId) ?? nonEmptyTaskIDFallback(activity)
            else { return nil }
            var item = existingOrNew(taskId: taskId, at: at)
            startedTaskIDs.insert(taskId)
            item.taskType = nonEmpty(payload?.taskType) ?? item.taskType
            item.description = nonEmpty(payload?.description) ?? item.description
            item.startedAt = min(item.startedAt, at)
            if item.completedAt == nil {
                item.state = .running
            }
            store(item)
            return item

        case ActivityKind.taskProgress:
            let payload = activity.decodePayload(TaskProgressActivityPayload.self)
            guard
                let taskId =
                    nonEmpty(payload?.taskId) ?? latestRunningStartedTaskID()
                    ?? nonEmptyTaskIDFallback(activity)
            else { return nil }
            var item = existingOrNew(taskId: taskId, at: at)
            item.taskType = nonEmpty(payload?.taskType) ?? item.taskType
            item.description = nonEmpty(payload?.description) ?? item.description
            item.lastToolName = nonEmpty(payload?.lastToolName) ?? item.lastToolName
            item.latestProgress =
                progressLine(lastToolName: payload?.lastToolName, summary: payload?.summary)
                ?? nonEmpty(payload?.detail)
                ?? item.latestProgress
            appendProgress(
                to: &item,
                at: at,
                toolName: payload?.lastToolName,
                text: nonEmpty(payload?.summary) ?? nonEmpty(payload?.detail))
            if item.completedAt == nil {
                item.state = .running
            }
            store(item)
            return item

        case ActivityKind.taskCompleted:
            let payload = activity.decodePayload(TaskCompletedActivityPayload.self)
            guard
                let taskId =
                    nonEmpty(payload?.taskId) ?? latestRunningStartedTaskID()
                    ?? nonEmptyTaskIDFallback(activity)
            else { return nil }
            var item = existingOrNew(taskId: taskId, at: at)
            item.taskType = nonEmpty(payload?.taskType) ?? item.taskType
            item.description = nonEmpty(payload?.description) ?? item.description
            item.lastToolName = nonEmpty(payload?.lastToolName) ?? item.lastToolName
            item.completionSummary =
                nonEmpty(payload?.summary) ?? nonEmpty(payload?.detail) ?? item.completionSummary
            item.latestProgress = item.completionSummary ?? item.latestProgress
            // Completion summary is task-level (unbadged unless payload carries lastToolName).
            // Dedupe by text alone so a prior tool-badged line with the same text is not repeated.
            let completionText = nonEmpty(item.completionSummary)
            let lastLogText = item.progressLog.last.map(\.text)
            if completionText != nil, completionText != lastLogText {
                appendProgress(
                    to: &item,
                    at: at,
                    toolName: payload?.lastToolName,
                    text: item.completionSummary)
            }
            item.completedAt = at
            item.state = state(forStatus: payload?.status)
            store(item)
            return item

        default:
            return nil
        }
    }

    public static func rebuild(
        from activities: [OrchestrationThreadActivity]
    ) -> T3SubagentTaskActivityState {
        var state = T3SubagentTaskActivityState()
        for activity in activities.sorted(by: activitySort) {
            guard let at = WireDate.parse(activity.createdAt) else { continue }
            _ = state.apply(activity: activity, at: at)
        }
        return state
    }

    private mutating func existingOrNew(taskId: String, at: Date) -> T3SubagentTaskItem {
        if let existing = tasksByID[taskId] {
            return existing
        }
        order.append(taskId)
        return T3SubagentTaskItem(
            taskId: taskId, taskType: nil, description: nil, state: .running,
            latestProgress: nil, lastToolName: nil, startedAt: at, completedAt: nil,
            completionSummary: nil, progressLog: [])
    }

    private mutating func store(_ item: T3SubagentTaskItem) {
        tasksByID[item.taskId] = item
        switch item.state {
        case .running:
            activeTaskIDsStorage.insert(item.taskId)
        case .completed, .failed, .stopped:
            activeTaskIDsStorage.remove(item.taskId)
        }
    }

    private func latestRunningStartedTaskID() -> String? {
        order.reversed().first { taskId in
            startedTaskIDs.contains(taskId) && activeTaskIDsStorage.contains(taskId)
        }
    }

    private static func activitySort(
        _ lhs: OrchestrationThreadActivity, _ rhs: OrchestrationThreadActivity
    ) -> Bool {
        let lhsDate = WireDate.parse(lhs.createdAt) ?? .distantPast
        let rhsDate = WireDate.parse(rhs.createdAt) ?? .distantPast
        if lhsDate != rhsDate { return lhsDate < rhsDate }
        return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
    }
}

/// Append a progress entry when text is non-empty and differs from the last
/// entry's (toolName, text) pair. Caps at `maxProgressLogEntries`.
private func appendProgress(
    to item: inout T3SubagentTaskItem,
    at: Date,
    toolName: String?,
    text: String?
) {
    guard let text = nonEmpty(text) else { return }
    let tool = nonEmpty(toolName)
    if let last = item.progressLog.last, last.toolName == tool, last.text == text {
        return
    }
    item.progressLog.append(
        T3SubagentTaskProgressEntry(at: at, toolName: tool, text: text))
    let max = T3SubagentTaskItem.maxProgressLogEntries
    if item.progressLog.count > max {
        item.progressLog.removeFirst(item.progressLog.count - max)
    }
}

private func progressLine(lastToolName: String?, summary: String?) -> String? {
    if let tool = nonEmpty(lastToolName) {
        return "Using \(tool)..."
    }
    return nonEmpty(summary)
}

private func state(forStatus status: String?) -> T3SubagentTaskState {
    switch status {
    case "failed", "error": .failed
    case "stopped", "interrupted", "cancelled", "canceled": .stopped
    default: .completed
    }
}

private func nonEmptyTaskIDFallback(_ activity: OrchestrationThreadActivity) -> String? {
    activity.kind.hasPrefix("task.") ? nonEmpty(activity.id) : nil
}

private func nonEmpty(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
        !trimmed.isEmpty
    else { return nil }
    return trimmed
}
