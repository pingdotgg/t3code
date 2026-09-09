import Foundation

/// Tool updates may replace only the current row for the same explicit call.
/// Text, notices and other calls close that row; later updates start a continuation.
@MainActor
struct NativeTranscriptTimeline {
    var messages: [FeatureMessage] = []
    var indexByID: [String: Int] = [:]
    var changedIDs: Set<String> = []
    private var activityIDs: Set<String> = []
    private var tail: (id: String, call: String?, turn: String?, log: NativeWorkLogAccumulator)?

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
        let call = activity.payload["toolCallId"]?.stringValue
            ?? activity.payload["data"]?["toolCallId"]?.stringValue
        let canCoalesce = call?.isEmpty == false && tail?.call == call
            && tail?.turn == activity.turnId && messages.last?.id == tail?.id
            && date >= (messages.last?.createdAt ?? .distantPast)
        if !canCoalesce {
            closeTail()
            tail = ("work-log-\(activity.id)", call, activity.turnId, NativeWorkLogAccumulator())
        }
        guard var current = tail else { return }
        let detail = activity.payload["detail"]?.stringValue
        let compact = detail?.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let preview = compact.flatMap { $0.isEmpty ? nil : String($0.prefix(160)) }
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
        } else if let last = messages.last, last.createdAt > message.createdAt {
            messages.append(message)
            messages = messages.enumerated().sorted {
                $0.element.createdAt != $1.element.createdAt
                    ? $0.element.createdAt < $1.element.createdAt : $0.offset < $1.offset
            }.map(\.element)
            rebuildIndexes()
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
    private var visibleLines: [String] = []
    private var createdAt = Date.distantPast
    private var title = "Tool activity"
    private var activeEntries: [String: String] = [:]
    private var activeOrder: [String] = []
    private var imagePaths: [String] = []
    private var toolPresentation: ToolActivityPresentation?
    private var activePresentations: [String: ToolActivityPresentation] = [:]

    var hasActiveWork: Bool { !activeEntries.isEmpty }
    var hasContent: Bool { count > 0 || hasActiveWork || !visibleLines.isEmpty || !imagePaths.isEmpty }

    static func accepts(_ activity: OrchestrationActivity) -> Bool {
        activeKinds.contains(activity.kind)
            || (activity.tone != "error" && terminalKinds.contains(activity.kind))
    }

    mutating func append(
        _ activity: OrchestrationActivity,
        preview: String?,
        createdAt: Date
    ) {
        self.createdAt = createdAt
        let key = Self.lifecycleKey(activity)
        toolPresentation = ToolActivityPresentation(payload: activity.payload) ?? activePresentations[key]
        let label = activity.payload["title"]?.stringValue ?? activity.summary
        title = label
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
            visibleLines.append("• \(preview ?? activity.summary)")
            if visibleLines.count > 40 {
                visibleLines.removeFirst(visibleLines.count - 40)
            }
        }
        if let path = Self.viewedImagePath(activity), !imagePaths.contains(path) {
            imagePaths.append(path)
            if imagePaths.count > 8 { imagePaths.removeFirst(imagePaths.count - 8) }
        }
    }

    /// A closed row records its last observation, rather than continuing to look live.
    mutating func freeze() {
        for key in activeOrder {
            if let label = activeEntries[key] { visibleLines.append("• \(label)") }
        }
        clearActiveWork()
    }

    mutating func clearActiveWork() {
        activeEntries.removeAll(keepingCapacity: true)
        activePresentations.removeAll(keepingCapacity: true)
        activeOrder.removeAll(keepingCapacity: true)
    }

    func message(groupID: String) -> FeatureMessage {
        var lines: [String] = []
        if count > visibleLines.count {
            lines.append("\(count - visibleLines.count) earlier updates hidden")
        }
        lines.append(contentsOf: visibleLines)
        var message = FeatureMessage(
            id: "work-log-\(groupID)",
            role: .tool,
            text: lines.joined(separator: "\n"),
            createdAt: createdAt,
            state: .complete,
            toolName: title,
            workLogImagePaths: imagePaths.isEmpty ? nil : imagePaths,
            activeWorkLabel: activeOrder.last.flatMap { activeEntries[$0] }
        )
        message.toolPresentation = activeOrder.last.flatMap { activePresentations[$0] } ?? toolPresentation
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
