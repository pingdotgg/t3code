import Foundation

public struct OrchestrationV2ApplyResult: Equatable, Sendable {
    public internal(set) var changed = false
    public internal(set) var synchronized = false
    public internal(set) var refreshRequired = false
    public internal(set) var changedItemIDs: Set<String> = []
    /// Structural changes need native timeline reconciliation; text/tool updates do not.
    public internal(set) var requiresTimelineRebuild = false
}

/// A thread's V2 state is independent of the shared native display records. Feed
/// committed stream frames in batches, then publish one normalized replacement.
public struct OrchestrationV2ThreadState: Sendable {
    public private(set) var projection: OrchestrationV2ThreadProjection
    public private(set) var snapshotSequence: Int
    public private(set) var historyCursor: String?
    public private(set) var hasMoreHistory: Bool
    public private(set) var latestLocalTurnOrdinal: Int?
    public private(set) var payloadBudgetExceeded: Bool
    private var partialTimeline: Bool
    private var visibility: V2Visibility
    private var itemIndices: [String: Int] = [:]
    private var visibleIndices: [String: Int] = [:]
    private var displayRows: [String: OrchestrationV2DisplayRow] = [:]

    public init(snapshot: JSONValue) throws {
        try self.init(decoded: snapshot.decode(OrchestrationV2ThreadSnapshot.self))
    }

    public init(decoded: OrchestrationV2ThreadSnapshot) throws {
        guard decoded.snapshotSequence >= 0,
              decoded.hasMoreHistory != true || decoded.historyCursor != nil else {
            throw OrchestrationV2StateError.invalidPayload("snapshot cursor")
        }
        projection = decoded.projection
        visibility = V2Visibility(decoded.projection)
        snapshotSequence = decoded.snapshotSequence
        historyCursor = decoded.historyCursor
        hasMoreHistory = decoded.hasMoreHistory ?? false
        latestLocalTurnOrdinal = decoded.latestLocalTurnOrdinal
        payloadBudgetExceeded = decoded.payloadBudgetExceeded ?? false
        partialTimeline = decoded.hasMoreHistory == true || decoded.historyCursor != nil
        try validateRows()
        rebuildIndices()
        filterVisibleItems()
        rebuildDisplayRows()
    }

    /// Unknown event types consume their sequence. A bad known event stops the
    /// batch before consuming its sequence so the caller can refresh and resume.
    public mutating func apply(_ items: [JSONValue]) -> OrchestrationV2ApplyResult {
        var result = OrchestrationV2ApplyResult()
        var dirtyIDs: Set<String> = []
        for frame in items {
            do {
                guard let kind = frame["kind"]?.stringValue else {
                    throw OrchestrationV2StateError.invalidPayload("stream kind")
                }
                switch kind {
                case "synchronized": result.synchronized = true
                case "snapshot":
                    let incomingSequence = frame["snapshotSequence"]?.v2Int
                    if let incomingSequence, incomingSequence < snapshotSequence { continue }
                    let replacement = try Self(snapshot: frame)
                    guard replacement.projection.thread.id == projection.thread.id else {
                        throw OrchestrationV2StateError.wrongThread
                    }
                    self = replacement
                    result.changed = true
                    result.requiresTimelineRebuild = true
                    dirtyIDs.removeAll()
                case "event", "unknown-event":
                    guard let sequence = frame["sequence"]?.v2Int, sequence >= 0 else {
                        throw OrchestrationV2StateError.invalidPayload("sequence")
                    }
                    if sequence <= snapshotSequence { continue }
                    if kind == "unknown-event" {
                        guard frame["eventType"]?.stringValue != nil else {
                            throw OrchestrationV2StateError.invalidPayload("eventType")
                        }
                        snapshotSequence = sequence
                        continue
                    }
                    let event = try frame.v2Required("event")
                    guard let type = event["type"]?.stringValue else {
                        throw OrchestrationV2StateError.invalidPayload("event.type")
                    }
                    if !Self.knownEventTypes.contains(type) {
                        snapshotSequence = sequence
                        continue
                    }
                    guard event["id"]?.stringValue != nil,
                          let threadID = event["threadId"]?.stringValue,
                          let occurredAt = event["occurredAt"]?.stringValue else {
                        throw OrchestrationV2StateError.invalidPayload("event envelope")
                    }
                    guard threadID == projection.thread.id else { throw OrchestrationV2StateError.wrongThread }
                    let payload = try event.v2Required("payload")
                    let mutation = try reduce(type: type, payload: payload, occurredAt: occurredAt)
                    snapshotSequence = sequence
                    result.changed = result.changed || mutation.changed
                    result.requiresTimelineRebuild = result.requiresTimelineRebuild || mutation.requiresTimelineRebuild
                    result.changedItemIDs.formUnion(mutation.changedItemIDs)
                    dirtyIDs.formUnion(mutation.changedItemIDs)
                    // Control changes invalidate only their own rows. Provider usage,
                    // session and metadata updates do not remap timeline content.
                    if mutation.changed {
                        let related = dependentItemIDs(eventType: type, payload: payload)
                        dirtyIDs.formUnion(related)
                        result.changedItemIDs.formUnion(related)
                    }
                default: throw OrchestrationV2StateError.invalidPayload("stream kind: \(kind)")
                }
            } catch {
                result.refreshRequired = true
                break
            }
        }
        for id in dirtyIDs {
            if let index = visibleIndices[id] {
                let row = projection.visibleTurnItems[index]
                displayRows[row.id] = OrchestrationV2Presentation.displayRow(row, projection: projection)
            }
        }
        if result.requiresTimelineRebuild {
            let retained = Set(projection.visibleTurnItems.map(\.id))
            displayRows = displayRows.filter { retained.contains($0.key) }
        }
        return result
    }

    /// A page belongs to the cursor that requested it, not to the live stream
    /// sequence. Keep live copies and never advance the resume cursor from a page.
    @discardableResult
    public mutating func appendHistory(_ json: JSONValue, beforeCursor: String) throws -> Bool {
        guard beforeCursor == historyCursor else { return false }
        return try appendHistory(json.decode(OrchestrationV2ThreadHistoryPage.self), beforeCursor: beforeCursor)
    }

    @discardableResult
    public mutating func appendHistory(_ page: OrchestrationV2ThreadHistoryPage, beforeCursor: String) throws -> Bool {
        guard beforeCursor == historyCursor else { return false }
        guard page.snapshotSequence >= 0,
              !page.hasMoreHistory || (page.nextCursor != nil && page.nextCursor != beforeCursor) else {
            throw OrchestrationV2StateError.invalidHistoryPage
        }
        var keys = Set(projection.visibleTurnItems.map(\.id))
        var prepended: [OrchestrationV2ProjectedTurnItem] = []
        for var row in page.items {
            try Self.validate(row, threadID: projection.thread.id)
            guard !keys.contains(row.id) else { continue }
            if row.isLocal || row.sourceThreadId == projection.thread.id {
                if let index = itemIndices[row.sourceItemId] {
                    let current = projection.turnItems[index]
                    guard current.type == "run_interrupt_request", visibility.contains(current) else { continue }
                    row.item = current
                }
                // Runs can roll back while a history request is in flight.
                guard visibility.contains(row.item) else { continue }
            }
            keys.insert(row.id)
            prepended.append(row)
        }
        for row in prepended where row.isLocal || row.sourceThreadId == projection.thread.id {
            if itemIndices[row.sourceItemId] == nil {
                itemIndices[row.sourceItemId] = projection.turnItems.count
                projection.turnItems.append(row.item)
            }
        }
        projection.visibleTurnItems = prepended + projection.visibleTurnItems
        renumberAndIndexVisible()
        for row in prepended {
            displayRows[row.id] = OrchestrationV2Presentation.displayRow(row, projection: projection)
        }
        historyCursor = page.nextCursor
        hasMoreHistory = page.hasMoreHistory
        partialTimeline = hasMoreHistory || historyCursor != nil
        visibility = V2Visibility(projection)
        // Keep the watermark; it is used only while more history remains.
        return true
    }

    public func normalizedSnapshot() -> OrchestrationThreadDetailSnapshot {
        OrchestrationV2Presentation.detailSnapshot(
            projection: projection,
            sequence: snapshotSequence,
            historyCursor: historyCursor,
            hasMoreHistory: hasMoreHistory,
            rows: projection.visibleTurnItems.compactMap { displayRows[$0.id] }
        )
    }

    private mutating func reduce(type: String, payload: JSONValue, occurredAt: String) throws -> OrchestrationV2ApplyResult {
        var result = OrchestrationV2ApplyResult()
        result.changed = true
        switch type {
        case let value where Self.threadEventTypes.contains(value):
            let thread = try OrchestrationV2AppThread(json: payload)
            guard thread.id == projection.thread.id else { throw OrchestrationV2StateError.wrongThread }
            projection.thread = thread
        case "run.created", "run.updated":
            let run = try OrchestrationV2Run(json: payload)
            guard run.threadId == projection.thread.id else { throw OrchestrationV2StateError.wrongThread }
            upsert(run, into: &projection.runs)
            result.requiresTimelineRebuild = filterVisibleItems()
        case "run.background-work-cancelled":
            guard let id = payload["runId"]?.stringValue,
                  let work = payload["restartCancelledBackgroundWork"]?.v2Array else {
                throw OrchestrationV2StateError.invalidPayload("background work")
            }
            if let index = projection.runs.firstIndex(where: { $0.id == id }) {
                var fields = projection.runs[index].raw.v2Object
                fields["restartCancelledBackgroundWork"] = .array(work)
                projection.runs[index] = try OrchestrationV2Run(json: .object(fields))
            }
        case "run-attempt.created", "run-attempt.updated":
            upsert(try OrchestrationV2RunAttempt(json: payload), into: &projection.attempts)
            result.requiresTimelineRebuild = filterVisibleItems()
        case "node.updated": upsert(try OrchestrationV2ExecutionNode(json: payload), into: &projection.nodes)
        case "subagent.updated": upsert(try OrchestrationV2Subagent(json: payload), into: &projection.subagents)
        case "provider-session.attached", "provider-session.updated":
            upsert(try OrchestrationV2ProviderSession(json: payload), into: &projection.providerSessions)
        case "provider-session.detached":
            guard let id = payload["providerSessionId"]?.stringValue,
                  payload["detachedAt"]?.stringValue != nil else {
                throw OrchestrationV2StateError.invalidPayload("detached session")
            }
            projection.providerSessions.removeAll { $0.id == id }
        case "provider-thread.updated": upsert(try OrchestrationV2ProviderThread(json: payload), into: &projection.providerThreads)
        case "provider-turn.updated":
            var turn = try OrchestrationV2ProviderTurn(json: payload)
            if turn.tokenUsage == nil,
               let previous = projection.providerTurns.first(where: { $0.id == turn.id })?.tokenUsage {
                var fields = turn.raw.v2Object
                fields["tokenUsage"] = previous.raw
                turn = try OrchestrationV2ProviderTurn(json: .object(fields))
            }
            upsert(turn, into: &projection.providerTurns)
        case "runtime-request.updated": upsert(try OrchestrationV2RuntimeRequest(json: payload), into: &projection.runtimeRequests)
        case "message.updated": upsert(try OrchestrationV2ConversationMessage(json: payload), into: &projection.messages)
        case "plan.updated": upsert(try OrchestrationV2PlanArtifact(json: payload), into: &projection.plans)
        case "checkpoint-scope.created": upsert(try OrchestrationV2CheckpointScope(json: payload), into: &projection.checkpointScopes)
        case "checkpoint.captured": upsert(try OrchestrationV2Checkpoint(json: payload), into: &projection.checkpoints)
        case "context-handoff.updated": upsert(try OrchestrationV2ContextHandoff(json: payload), into: &projection.contextHandoffs)
        case "context-transfer.created", "context-transfer.updated": upsert(try OrchestrationV2ContextTransfer(json: payload), into: &projection.contextTransfers)
        case "checkpoint.rollback-requested":
            guard payload["checkpointId"]?.stringValue != nil, payload["scopeId"]?.stringValue != nil,
                  payload["requestedAt"]?.stringValue != nil else {
                throw OrchestrationV2StateError.invalidPayload("rollback request")
            }
        case "turn-item.updated":
            guard let itemType = payload["type"]?.stringValue else {
                throw OrchestrationV2StateError.invalidPayload("turn item type")
            }
            guard OrchestrationV2TurnItem.isKnownType(itemType) else {
                result.changed = false
                return result
            }
            let item = try OrchestrationV2TurnItem(json: payload)
            guard item.threadId == projection.thread.id else { throw OrchestrationV2StateError.wrongThread }
            if partialTimeline && itemIndices[item.id] == nil && shouldDropMissing(item) {
                result.changed = false
                return result
            }
            let previous = itemIndices[item.id].map { projection.turnItems[$0] }
            if let index = itemIndices[item.id] { projection.turnItems[index] = item }
            else {
                itemIndices[item.id] = projection.turnItems.count
                projection.turnItems.append(item)
            }
            if item.type == "run_interrupt_request" || previous?.type == "run_interrupt_request" {
                result.requiresTimelineRebuild = filterVisibleItems()
            }
            if visibility.contains(item) {
                if let index = visibleIndices[item.id] {
                    let previousRow = projection.visibleTurnItems[index]
                    if previousRow.isLocal && previousRow.item.ordinal == item.ordinal {
                        projection.visibleTurnItems[index].item = item
                    } else {
                        projection.visibleTurnItems.remove(at: index)
                        insertVisible(item)
                        result.requiresTimelineRebuild = true
                    }
                } else if !(partialTimeline && shouldDropMissing(item)) {
                    insertVisible(item)
                    result.requiresTimelineRebuild = true
                }
            } else if let index = visibleIndices[item.id] {
                projection.visibleTurnItems.remove(at: index)
                renumberAndIndexVisible()
                result.requiresTimelineRebuild = true
            }
            if partialTimeline && item.ordinal > (latestLocalTurnOrdinal ?? -1) {
                latestLocalTurnOrdinal = item.ordinal
            }
            result.changedItemIDs.insert(item.id)
        default: return OrchestrationV2ApplyResult()
        }
        if type != "thread.visited" && type != "thread.marked-unread" { projection.updatedAt = occurredAt }
        return result
    }

    private func dependentItemIDs(eventType: String, payload: JSONValue) -> Set<String> {
        let affected: (OrchestrationV2TurnItem) -> Bool
        switch eventType {
        case "run.created", "run.updated":
            let runID = payload["id"]?.stringValue
            affected = { $0.runId == runID }
        case "runtime-request.updated":
            let requestID = payload["id"]?.stringValue
            affected = { $0.requestID == requestID }
        case "subagent.updated":
            let agentID = payload["id"]?.stringValue
            affected = { item in
                if case let .subagent(id, _, _, _, _) = item.content { return id == agentID }
                return false
            }
        case "context-handoff.updated":
            let handoffID = payload["id"]?.stringValue
            affected = { item in
                if case let .handoff(id, _) = item.content { return id == handoffID }
                return false
            }
        default: return []
        }
        return Set(projection.visibleTurnItems.lazy.filter { $0.isLocal && affected($0.item) }.map(\.sourceItemId))
    }

    private func shouldDropMissing(_ item: OrchestrationV2TurnItem) -> Bool {
        if visibleIndices[item.id] != nil { return false }
        if let latestLocalTurnOrdinal, item.ordinal <= latestLocalTurnOrdinal { return true }
        let oldest = projection.visibleTurnItems.lazy.filter(\.isLocal).map(\.item.ordinal).min()
        return oldest.map { item.ordinal < $0 } ?? false
    }

    private mutating func insertVisible(_ item: OrchestrationV2TurnItem) {
        let row = OrchestrationV2ProjectedTurnItem(position: 0, visibility: "local", sourceThreadId: item.threadId, sourceItemId: item.id, item: item)
        let index = projection.visibleTurnItems.firstIndex {
            $0.isLocal && ($0.item.ordinal > item.ordinal || ($0.item.ordinal == item.ordinal && $0.item.id > item.id))
        } ?? projection.visibleTurnItems.count
        projection.visibleTurnItems.insert(row, at: index)
        renumberAndIndexVisible()
    }

    @discardableResult
    private mutating func filterVisibleItems() -> Bool {
        visibility = V2Visibility(projection)
        let currentVisibility = visibility
        let previousCount = projection.visibleTurnItems.count
        projection.visibleTurnItems.removeAll { $0.isLocal && !currentVisibility.contains($0.item) }
        guard previousCount != projection.visibleTurnItems.count else { return false }
        renumberAndIndexVisible()
        return true
    }

    private mutating func rebuildIndices() {
        itemIndices = Dictionary(projection.turnItems.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { _, last in last })
        renumberAndIndexVisible()
    }
    private mutating func renumberAndIndexVisible() {
        visibleIndices.removeAll(keepingCapacity: true)
        for index in projection.visibleTurnItems.indices {
            projection.visibleTurnItems[index].position = index
            // Inherited rows must never be overwritten by local events.
            if projection.visibleTurnItems[index].isLocal {
                visibleIndices[projection.visibleTurnItems[index].sourceItemId] = index
            }
        }
    }
    private mutating func rebuildDisplayRows() {
        displayRows.removeAll(keepingCapacity: true)
        for row in projection.visibleTurnItems {
            displayRows[row.id] = OrchestrationV2Presentation.displayRow(row, projection: projection)
        }
    }
    private func validateRows() throws {
        var ids: Set<String> = []
        for row in projection.visibleTurnItems {
            try Self.validate(row, threadID: projection.thread.id)
            guard ids.insert(row.id).inserted else { throw OrchestrationV2StateError.invalidPayload("duplicate visible item") }
        }
        guard Set(projection.turnItems.map(\.id)).count == projection.turnItems.count else {
            throw OrchestrationV2StateError.invalidPayload("duplicate turn item")
        }
    }
    private static func validate(_ row: OrchestrationV2ProjectedTurnItem, threadID: String) throws {
        guard row.position >= 0, ["local", "inherited", "synthetic"].contains(row.visibility),
              row.sourceItemId == row.item.id,
              !row.isLocal || (row.sourceThreadId == threadID && row.item.threadId == threadID) else {
            throw OrchestrationV2StateError.invalidPayload("visible item")
        }
    }

    static let threadEventTypes: Set<String> = [
        "thread.created", "thread.archived", "thread.unarchived", "thread.deleted",
        "thread.settled", "thread.unsettled", "thread.snoozed", "thread.unsnoozed",
        "thread.auto-settle-set", "thread.pinned", "thread.unpinned", "thread.pin-reordered",
        "thread.active-reordered", "thread.metadata-updated", "thread.pull-request-synced",
        "thread.runtime-mode-updated", "thread.interaction-mode-updated", "thread.model-selection-updated",
        "thread.provider-switched", "thread.visited", "thread.marked-unread",
    ]
    static let knownEventTypes = threadEventTypes.union([
        "run.created", "run.updated", "run.background-work-cancelled", "run-attempt.created", "run-attempt.updated",
        "node.updated", "subagent.updated", "provider-session.attached", "provider-session.updated", "provider-session.detached",
        "provider-thread.updated", "provider-turn.updated", "runtime-request.updated", "message.updated", "plan.updated",
        "turn-item.updated", "checkpoint-scope.created", "checkpoint.captured", "checkpoint.rollback-requested",
        "context-handoff.updated", "context-transfer.created", "context-transfer.updated",
    ])
}

private func upsert<T: Identifiable>(_ item: T, into items: inout [T]) where T.ID == String {
    if let index = items.firstIndex(where: { $0.id == item.id }) { items[index] = item }
    else { items.append(item) }
}

/// Matches shared/orchestrationV2Timeline.ts. Failed attempt output remains useful;
/// only rollback, cancelled queued input and superseded plain-steer results hide.
private struct V2Visibility {
    let statuses: [String: String]
    let supersededRoots: [String: Set<String>]
    let interruptRuns: Set<String>

    init(_ projection: OrchestrationV2ThreadProjection) {
        statuses = Dictionary(projection.runs.map { ($0.id, $0.status) }, uniquingKeysWith: { _, last in last })
        var roots: [String: Set<String>] = [:]
        for attempt in projection.attempts where attempt.status == "superseded" {
            roots[attempt.runId, default: []].insert(attempt.rootNodeId)
        }
        supersededRoots = roots
        interruptRuns = Set(projection.turnItems.filter { $0.type == "run_interrupt_request" }.compactMap(\.runId))
    }
    func contains(_ item: OrchestrationV2TurnItem) -> Bool {
        guard let runID = item.runId else { return true }
        if statuses[runID] == "rolled_back" { return false }
        if statuses[runID] == "cancelled" && item.type == "user_message" && item.inputIntent == "queued_turn" { return false }
        if item.type == "run_interrupt_result", let nodeID = item.nodeId,
           supersededRoots[runID]?.contains(nodeID) == true, !interruptRuns.contains(runID) { return false }
        return true
    }
}
