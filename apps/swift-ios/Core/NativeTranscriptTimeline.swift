import Foundation

/// Consecutive tool events share a compact group, including distinct calls.
/// Text, notices and turn changes close the group; later events append below them.
@MainActor
struct NativeTranscriptTimeline {
    var messages: [FeatureMessage] = []
    var indexByID: [String: Int] = [:]
    var changedIDs: Set<String> = []
    private var activityIDs: Set<String> = []
    private var tail: (id: String, turn: String?, log: NativeWorkLogAccumulator)?

    init() {}

    init(messages: [FeatureMessage], activities: [OrchestrationActivity], sessionIsLive: Bool) {
        self.init()
        // Messages have no event sequence. Exact cross-kind timestamp ties are
        // ambiguous in snapshots: keep message wire order, then activity sequence.
        // Live batches instead append in received event order, including ties.
        let sortedActivities = activities.enumerated().map {
            (index: $0.offset, date: NativeTimestampParser.parse($0.element.createdAt) ?? .distantPast,
             activity: $0.element)
        }.sorted { lhs, rhs in
            if lhs.date != rhs.date { return lhs.date < rhs.date }
            let a = lhs.activity.sequence ?? Int.max
            let b = rhs.activity.sequence ?? Int.max
            return a != b ? a < b : lhs.index < rhs.index
        }
        var events: [(date: Date, message: FeatureMessage?, activity: OrchestrationActivity?)] =
            messages.map { ($0.createdAt, $0, nil) }
        events += sortedActivities.map {
            ($0.date, nil, $0.activity)
        }
        for event in events.enumerated().sorted(by: {
            $0.element.date != $1.element.date
                ? $0.element.date < $1.element.date : $0.offset < $1.offset
        }) {
            if let message = event.element.message { append(message) }
            if let activity = event.element.activity { append(activity) }
        }
        if !sessionIsLive { finishActiveWork() }
    }

    mutating func append(_ message: FeatureMessage) {
        closeTail()
        upsert(message)
    }

    mutating func append(_ activity: OrchestrationActivity) {
        guard activityIDs.insert(activity.id).inserted else { return }
        let date = NativeTimestampParser.parse(activity.createdAt) ?? .distantPast
        if let notice = NativeActivityNotice.message(activity, createdAt: date) {
            append(notice)
            return
        }
        let answers = NativeQuestionAnswerHistory.messages(activity, createdAt: date)
        if !answers.isEmpty {
            for answer in answers { append(answer) }
            return
        }
        guard NativeWorkLogAccumulator.accepts(activity) else { return }
        let canCoalesce = tail?.turn == activity.turnId && tail != nil
            && messages.last?.id == tail?.id
        if !canCoalesce {
            closeTail()
            tail = ("work-log-\(activity.id)", activity.turnId, NativeWorkLogAccumulator())
        }
        guard var current = tail else { return }
        let detail = activity.payload["detail"]?.stringValue
        let preview = detail.flatMap { $0.isEmpty ? nil : $0 }
        current.log.append(activity, preview: preview, createdAt: date)
        tail = current
        if current.log.hasContent { upsert(current.log.message(groupID: String(current.id.dropFirst(9)))) }
    }

    mutating func finishActiveWork() { closeTail() }

    mutating func rebuildIndexes() {
        indexByID = messages.enumerated().reduce(into: [:]) { $0[$1.element.id] = $1.offset }
    }

    private mutating func closeTail() {
        guard var current = tail else { return }
        current.log.freeze()
        if current.log.hasContent {
            upsert(current.log.message(groupID: String(current.id.dropFirst(9))))
        }
        tail = nil
    }

    private mutating func upsert(_ message: FeatureMessage) {
        changedIDs.insert(message.id)
        if let index = indexByID[message.id] {
            messages[index] = message
        } else {
            indexByID[message.id] = messages.count
            messages.append(message)
        }
    }
}

struct NativeWorkLogAccumulator {
    private static let terminalKinds = Set([
        "tool.completed", "task.completed", "turn.plan.updated",
    ])
    private static let activeKinds = Set(["tool.started", "tool.updated"])
    private static let imageExtensions = Set([
        "avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff", "webp",
    ])

    private(set) var count = 0
    private var callOrder: [String] = []
    private var callLabels: [String: String] = [:]
    private var callDetails: [String: [String]] = [:]
    private var createdAt = Date.distantPast
    private var title = "Tool activity"
    private var activeEntries: [String: String] = [:]
    private var activeOrder: [String] = []
    private var imagePaths: [String] = []
    private var toolPresentation: ToolActivityPresentation?
    private var activePresentations: [String: ToolActivityPresentation] = [:]

    var hasActiveWork: Bool { !activeEntries.isEmpty }
    var hasContent: Bool { count > 0 || hasActiveWork || !callOrder.isEmpty || !imagePaths.isEmpty }

    static func accepts(_ activity: OrchestrationActivity) -> Bool {
        activeKinds.contains(activity.kind)
            || (activity.tone != "error" && terminalKinds.contains(activity.kind))
    }

    mutating func append(
        _ activity: OrchestrationActivity,
        preview: String?,
        createdAt: Date
    ) {
        self.createdAt = max(self.createdAt, createdAt)
        let key = Self.lifecycleKey(activity)
        toolPresentation = ToolActivityPresentation(payload: activity.payload) ?? activePresentations[key]
        let label = activity.payload["title"]?.stringValue ?? activity.summary
        title = label
        if callLabels[key] == nil { callOrder.append(key) }
        callLabels[key] = label
        if let preview, callDetails[key]?.last != preview {
            if callDetails[key, default: []].count == 2 {
                callDetails[key]?[1] = preview
            } else {
                callDetails[key, default: []].append(preview)
            }
        }
        let lifecycleStatus = activity.payload["status"]?.stringValue
        let isTerminalUpdate = activity.kind == "tool.updated"
            && lifecycleStatus.map { $0 != "inProgress" && $0 != "in_progress" } == true
        if Self.activeKinds.contains(activity.kind) && !isTerminalUpdate
            && activity.tone != "error" {
            activeEntries[key] = label
            activePresentations[key] = toolPresentation
            activeOrder.removeAll { $0 == key }
            activeOrder.append(key)
        } else {
            activeEntries[key] = nil
            activePresentations[key] = nil
            activeOrder.removeAll { $0 == key }
            guard activity.tone != "error" else { return }
            count += 1
        }
        if let path = Self.viewedImagePath(activity), !imagePaths.contains(path) {
            imagePaths.append(path)
            if imagePaths.count > 8 { imagePaths.removeFirst(imagePaths.count - 8) }
        }
    }

    /// A closed row records its last observation, rather than continuing to look live.
    mutating func freeze() {
        clearActiveWork()
    }

    mutating func clearActiveWork() {
        activeEntries.removeAll(keepingCapacity: true)
        activePresentations.removeAll(keepingCapacity: true)
        activeOrder.removeAll(keepingCapacity: true)
    }

    func message(groupID: String) -> FeatureMessage {
        let lines = callOrder.map { key in
            (["• \(callLabels[key] ?? "Tool activity")"] + (callDetails[key] ?? []))
                .joined(separator: "\n")
        }
        var message = FeatureMessage(
            id: "work-log-\(groupID)",
            role: .tool,
            text: lines.joined(separator: "\n"),
            createdAt: createdAt,
            state: .complete,
            toolName: callOrder.count > 1 ? "\(callOrder.count) tool calls" : title,
            workLogImagePaths: imagePaths.isEmpty ? nil : imagePaths,
            activeWorkLabel: activeOrder.last.flatMap { activeEntries[$0] }
        )
        if callOrder.count == 1 {
            message.toolPresentation = activeOrder.last.flatMap { activePresentations[$0] } ?? toolPresentation
        }
        return message
    }

    private static func lifecycleKey(_ activity: OrchestrationActivity) -> String {
        if let id = activity.payload["toolCallId"]?.stringValue
            ?? activity.payload["data"]?["toolCallId"]?.stringValue {
            return "id:\(id)"
        }
        let itemType = activity.payload["itemType"]?.stringValue ?? ""
        let title = activity.payload["title"]?.stringValue ?? activity.summary
        let detail = activity.payload["detail"]?.stringValue ?? ""
        return "fallback:\([itemType, title, detail].map(normalizedLifecycleText).joined(separator: "|"))"
    }

    private static func normalizedLifecycleText(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(
                of: #"\s+(complete|completed)$"#,
                with: "",
                options: .regularExpression
            )
    }

    private static func viewedImagePath(_ activity: OrchestrationActivity) -> String? {
        let itemType = normalizedLifecycleText(activity.payload["itemType"]?.stringValue ?? "")
        let title = normalizedLifecycleText(activity.payload["title"]?.stringValue ?? activity.summary)
        let qualifies = activity.payload["requestKind"]?.stringValue == "file-read"
            || itemType == "image_view"
            || (itemType == "dynamic_tool_call" && title == "read file")
        guard qualifies,
              let detail = activity.payload["detail"]?.stringValue,
              !detail.contains("\n"), !detail.contains("\r") else { return nil }
        let path = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let ext = path.split(separator: ".").last?.lowercased(),
              imageExtensions.contains(String(ext)) else { return nil }
        return path
    }
}

/// Compact elapsed age and its next visible change, shared by all tool labels.
enum NativeToolRelativeAge {
    static func text(since date: Date, now: Date) -> String {
        guard date > .distantPast, date.timeIntervalSinceReferenceDate.isFinite else { return "—" }
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 10 { return "just now" }
        if seconds < 60 { return "\(Int(seconds))s ago" }
        if seconds < 3_600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86_400 { return "\(Int(seconds / 3_600))h ago" }
        return "\(Int(seconds / 86_400))d ago"
    }

    static func nextChange(since date: Date, now: Date) -> Date? {
        guard date > .distantPast, date.timeIntervalSinceReferenceDate.isFinite else { return nil }
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 10 { return date.addingTimeInterval(10) }
        let step: Double = seconds < 60 ? 1 : seconds < 3_600 ? 60 : seconds < 86_400 ? 3_600 : 86_400
        return date.addingTimeInterval((floor(seconds / step) + 1) * step)
    }
}

/// Preserve already observed event order when adding history or local notices.
enum NativeTranscriptOrder {
    static func prependHistory(_ older: [FeatureMessage], to current: [FeatureMessage]) -> [FeatureMessage] {
        let loadedIDs = Set(current.map(\.id))
        return older.filter { !loadedIDs.contains($0.id) } + current
    }

    static func insertingFeedback(_ feedback: [FeatureMessage], into current: [FeatureMessage]) -> [FeatureMessage] {
        var result = current
        for message in feedback {
            let index = result.firstIndex { $0.createdAt > message.createdAt } ?? result.endIndex
            result.insert(message, at: index)
        }
        return result
    }
}
