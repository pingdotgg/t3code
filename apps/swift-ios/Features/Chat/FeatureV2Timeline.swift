import Foundation

public struct FeatureV2WorkItem: Identifiable, Codable, Equatable, Hashable, Sendable {
    public var source: OrchestrationV2TimelineMetadata
    public let raw: JSONValue
    /// Derived from `raw` once, because both checks parse JSON and run regexes
    /// and render paths ask for them many times. Not encoded.
    let indicatesFailure: Bool
    let hasEmbeddedContent: Bool
    public var id: String { source.projectedID }

    init(source: OrchestrationV2TimelineMetadata, raw: JSONValue) {
        self.source = source
        self.raw = raw
        indicatesFailure = FeatureV2ItemDetail.indicatesFailure(raw)
        hasEmbeddedContent = FeatureEmbeddedContent.reference(raw: raw) != nil
    }

    private enum CodingKeys: String, CodingKey { case source, raw }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(source: try container.decode(OrchestrationV2TimelineMetadata.self, forKey: .source),
                  raw: try container.decode(JSONValue.self, forKey: .raw))
    }

    public var title: String {
        raw["title"]?.stringValue ?? raw["toolName"]?.stringValue
            ?? source.itemType.replacingOccurrences(of: "_", with: " ").capitalized
    }

    /// Local rows use live controls across all runs. Inherited and unloaded agents keep their projected identity.
    func threadAgent(environmentID: String, agents: [FeatureThreadAgent]) -> FeatureThreadAgent? {
        guard source.itemType == "subagent" else { return nil }
        if source.visibility == "local",
           let agent = agents.first(where: { $0.id == raw["subagentId"]?.stringValue }) {
            return agent
        }
        guard let item = try? raw.decode(OrchestrationV2TurnItem.self) else { return nil }
        let projected = OrchestrationV2ProjectedTurnItem(
            position: source.position, visibility: source.visibility,
            sourceThreadId: source.sourceThreadID, sourceItemId: source.itemID, item: item
        )
        return FeatureThreadAgent(projectedItem: projected, environmentID: environmentID)
    }

    var isStandaloneContent: Bool {
        source.itemType == "secret_request" || hasEmbeddedContent
    }

    var groupingKey: GroupingKey? {
        guard ["command_execution", "dynamic_tool", "file_change", "file_search", "web_search", "reasoning"].contains(source.itemType),
              !isStandaloneContent, !indicatesFailure else { return nil }
        return GroupingKey(sourceThreadID: source.sourceThreadID, visibility: source.visibility,
                           runID: source.runID, providerTurnID: source.providerTurnID, attemptID: source.attemptID)
    }

    struct GroupingKey: Equatable {
        var sourceThreadID: String
        var visibility: String
        var runID: String?
        var providerTurnID: String?
        var attemptID: String?
    }
}

/// Keeps the projected sequence intact. A content update replaces its row or
/// adjacent work group; only structural changes rebuild the grouping plan.
final class FeatureV2TimelineRenderer {
    private enum Slot {
        case message(String)
        case work(String, [String])
        var id: String {
            switch self {
            case let .message(id), let .work(id, _): id
            }
        }
    }

    private var timeline: [OrchestrationV2TimelineRow]?
    private var rawMessages: [String: OrchestrationMessage] = [:]
    private var items: [String: FeatureV2WorkItem] = [:]
    private var activityByRow: [String: String] = [:]
    private var mapped: [String: FeatureMessage] = [:]
    private var slots: [Slot] = []
    private var groupByActivity: [String: String] = [:]
    private var slotByID: [String: Int] = [:]
    private var wasLive = false
    private var controlNotices: [String: FeatureMessage] = [:]
    private var controlNoticeOrder: [String] = []
    private(set) var changedMessageIDs: Set<String> = []
    private(set) var rebuilt = false
    private(set) var messageIndexByID: [String: Int] = [:]
    private(set) var messages: [FeatureMessage] = []
    var hasTimeline: Bool { timeline != nil }

    func update(
        thread: OrchestrationThread,
        changedMessages: [OrchestrationMessage]?,
        changedActivities: [OrchestrationActivity]?,
        mapMessage: (OrchestrationMessage) -> FeatureMessage,
        date: (String) -> Date
    ) -> [FeatureMessage] {
        let rows = thread.v2Timeline ?? []
        let structureChanged = timeline != rows
        let full = structureChanged || changedMessages == nil || changedActivities == nil
        var rebuild = structureChanged
        var dirtyIDs: Set<String> = []
        let controlActivities = (full ? thread.activities : (changedActivities ?? [])).filter { $0.v2Timeline == nil }
        if full {
            let retained = Set(controlActivities.map { "activity-\($0.id)" })
            if controlNoticeOrder.contains(where: { !retained.contains($0) }) { rebuild = true }
            controlNotices = controlNotices.filter { retained.contains($0.key) }
            controlNoticeOrder.removeAll { !retained.contains($0) }
        }
        for activity in controlActivities {
            guard let notice = NativeActivityNotice.message(activity, createdAt: date(activity.createdAt)) else { continue }
            if controlNotices[notice.id] == nil { controlNoticeOrder.append(notice.id); rebuild = true }
            if controlNotices[notice.id] != notice { dirtyIDs.insert(notice.id) }
            controlNotices[notice.id] = notice
        }
        for raw in full ? thread.messages : (changedMessages ?? []) {
            guard rawMessages[raw.id] != raw else { continue }
            rawMessages[raw.id] = raw
            var message = mapMessage(raw)
            message.v2Timeline = raw.v2Timeline
            mapped[raw.id] = message
            dirtyIDs.insert(raw.id)
        }
        for activity in full ? thread.activities : (changedActivities ?? []) {
            guard let source = activity.v2Timeline, let raw = activity.v2Item else { continue }
            // Subagent rows also emit task controls. Their tool row owns display.
            if activity.kind.hasPrefix("task.") { continue }
            // A resolved question may have a second activity for its answer.
            // Both describe one projected item; the raw record includes the answer.
            if let existing = activityByRow[source.projectedID], existing != activity.id { continue }
            activityByRow[source.projectedID] = activity.id
            let item = FeatureV2WorkItem(source: source, raw: raw)
            let old = items[activity.id]
            guard old != item else { continue }
            if old == nil || old?.groupingKey != item.groupingKey { rebuild = true }
            items[activity.id] = item
            if let group = groupByActivity[activity.id] { dirtyIDs.insert(group) }
        }
        let live = thread.session?.status == "starting" || thread.session?.status == "running"
        if rebuild {
            timeline = rows
            slots.removeAll(keepingCapacity: true)
            groupByActivity.removeAll(keepingCapacity: true)
            var pending: [String] = []
            var key: FeatureV2WorkItem.GroupingKey?
            func flush() {
                guard let first = pending.first, let item = items[first] else { return }
                let id = "v2-work:\(item.id)"
                slots.append(.work(id, pending))
                for activityID in pending { groupByActivity[activityID] = id }
                pending.removeAll(keepingCapacity: true)
                key = nil
            }
            for row in rows {
                if let messageID = row.messageID {
                    flush()
                    slots.append(.message(messageID))
                } else if let activityID = row.activityIDs.first(where: { items[$0] != nil }),
                          let item = items[activityID] {
                    if item.groupingKey == nil || key != item.groupingKey { flush() }
                    key = item.groupingKey
                    pending.append(activityID)
                    if key == nil { flush() }
                } else {
                    flush()
                }
            }
            flush()
            slotByID = Dictionary(slots.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { _, last in last })
            let retainedMessages = Set(rows.compactMap(\.messageID))
            let retainedActivities = Set(rows.flatMap(\.activityIDs))
            rawMessages = rawMessages.filter { retainedMessages.contains($0.key) }
            items = items.filter { retainedActivities.contains($0.key) }
            let retainedRows = Set(rows.map(\.projectedID))
            activityByRow = activityByRow.filter { retainedRows.contains($0.key) }
            mapped = mapped.filter { slotByID[$0.key] != nil }
        }
        for slot in slots {
            guard case let .work(id, activityIDs) = slot,
                  rebuild || dirtyIDs.contains(id) || live != wasLive else { continue }
            let work = activityIDs.compactMap { items[$0] }
            guard let first = work.first else { continue }
            let active = live ? work.last {
                $0.source.visibility == "local" && ["pending", "running", "waiting"].contains($0.raw["status"]?.stringValue ?? $0.source.status)
            } : nil
            var message = FeatureMessage(
                id: id, role: .tool, text: work.map(\.title).joined(separator: "\n"),
                createdAt: date(first.raw["startedAt"]?.stringValue ?? first.source.updatedAt),
                toolName: work.count == 1 ? first.title : "Work log · \(work.count)",
                workLogImagePaths: work.compactMap { $0.raw["viewedImagePath"]?.stringValue },
                activeWorkLabel: active?.title
            )
            message.v2Timeline = first.source
            message.v2WorkItems = work
            message.toolPresentation = ToolActivityPresentation(payload: work.last?.raw ?? first.raw)
            mapped[id] = message
            dirtyIDs.insert(id)
        }
        if rebuild || messages.count != slots.count + controlNoticeOrder.count {
            messages = slots.compactMap { mapped[$0.id] } + controlNoticeOrder.compactMap { controlNotices[$0] }
            messageIndexByID = Dictionary(messages.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { _, last in last })
        } else {
            for id in dirtyIDs {
                if let index = messageIndexByID[id], messages.indices.contains(index), let message = mapped[id] ?? controlNotices[id] {
                    messages[index] = message
                }
            }
        }
        wasLive = live
        rebuilt = rebuild
        changedMessageIDs = dirtyIDs
        return messages
    }
}
