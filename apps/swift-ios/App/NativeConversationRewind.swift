import Foundation

enum NativeConversationRewind {
    enum Target: Equatable, Sendable {
        case legacy(turnCount: Int)
        case checkpoint(OrchestrationV2Commands.ConversationRollbackTarget)

        var turnCount: Int {
            switch self {
            case let .legacy(count): count
            case let .checkpoint(target): target.appRunOrdinal
            }
        }

        var runID: String? {
            switch self {
            case .legacy: nil
            case let .checkpoint(target): target.runID
            }
        }

        func command(threadID: String) -> JSONValue {
            switch self {
            case let .legacy(count):
                OrchestrationCommands.revertConversation(threadID: threadID, turnCount: count)
            case let .checkpoint(target):
                OrchestrationV2Commands.rollback(threadID: threadID, scopeID: target.scopeID,
                    checkpointID: target.checkpointID, restoreFiles: false)
            }
        }
    }

    /// Older loaded V2 messages can lack run/checkpoint controls. Allow local user
    /// messages here, then resolve their checkpoint with a full read on invocation.
    static func canRewind(before messageID: String, in thread: OrchestrationThread) -> Bool {
        guard let control = thread.orchestrationV2Control else {
            return turnCount(before: messageID, in: thread) != nil
        }
        guard let message = thread.messages.first(where: { $0.id == messageID }), message.role == "user",
              !message.streaming, !message.id.hasPrefix("v2-inherited:"),
              let runID = message.turnId, !runID.hasPrefix("v2-inherited:"),
              !(control["thread"]?["creationSource"]?.stringValue == "provider"
                && control["thread"]?["lineage"]?["relationshipToParent"]?.stringValue == "subagent") else { return false }
        let runs = control["runs"]?.v2Array ?? []
        guard !runs.contains(where: {
            ["queued", "preparing", "starting", "running", "waiting"].contains($0["status"]?.stringValue ?? "")
        }) else { return false }
        if let run = runs.first(where: { $0["id"]?.stringValue == runID }) {
            return ["completed", "interrupted", "failed", "cancelled"].contains(run["status"]?.stringValue ?? "")
                && run["providerThreadId"] == control["thread"]?["activeProviderThreadId"]
        }
        return true
    }

    static func target(before messageID: String, in thread: OrchestrationThread) throws -> Target {
        if let control = thread.orchestrationV2Control {
            guard canRewind(before: messageID, in: thread),
                  let runID = thread.messages.first(where: { $0.id == messageID })?.turnId else {
                throw FeatureConversationRewindError(message: "This message cannot be rewound. Wait for this thread's work to finish.")
            }
            return .checkpoint(try OrchestrationV2Commands.conversationRollbackTarget(
                beforeRunID: runID, projection: control
            ))
        }
        guard let count = turnCount(before: messageID, in: thread) else {
            throw FeatureConversationRewindError(message: "Wait for this turn to finish before rewinding.")
        }
        return .legacy(turnCount: count)
    }

    /// V1 uses checkpoint counts, not visible message indexes. Pages and steering messages
    /// do not each represent one completed provider turn.
    static func turnCount(before messageID: String, in thread: OrchestrationThread) -> Int? {
        guard let index = thread.messages.firstIndex(where: { $0.id == messageID }),
              thread.messages[index].role == "user" else { return nil }
        let checkpoints = Dictionary(
            thread.checkpoints.compactMap { checkpoint in
                checkpoint.assistantMessageId.map { ($0, checkpoint.checkpointTurnCount) }
            },
            uniquingKeysWith: max
        )
        for message in thread.messages.dropFirst(index + 1) {
            if message.role == "user" { return nil }
            if let count = checkpoints[message.id] { return max(0, count - 1) }
        }
        return nil
    }

    static func isComplete(
        _ thread: OrchestrationThread, messageID: String, turnCount: Int, rollbackRunID: String? = nil
    ) -> Bool {
        if let rollbackRunID {
            return !thread.messages.contains(where: { $0.id == messageID })
                && (thread.orchestrationV2Control?["runs"]?.v2Array ?? []).contains {
                    $0["id"]?.stringValue == rollbackRunID && $0["status"]?.stringValue == "rolled_back"
                }
        }
        return !thread.messages.contains(where: { $0.id == messageID })
            && thread.checkpoints.allSatisfy { $0.checkpointTurnCount <= turnCount }
            && (turnCount == 0
                ? thread.latestTurn == nil
                : thread.checkpoints.contains { $0.turnId == thread.latestTurn?.turnId })
    }

    /// Command acceptance precedes provider rollback. Wait for its completion event
    /// or an authoritative replacement snapshot, including while another thread is open.
    static func waitForCompletion(
        batches: AsyncThrowingStream<[ThreadStreamItem], Error>,
        threadID: String,
        messageID: String,
        turnCount: Int,
        afterSequence: Int,
        previousFailureIDs: Set<String>,
        rollbackRequestID: String? = nil,
        rollbackRunID: String? = nil,
        timeout: Duration = .seconds(120)
    ) async throws -> Int {
        try await withThrowingTaskGroup(of: Int.self) { group in
            group.addTask {
                for try await batch in batches {
                    for item in batch {
                        switch item {
                        case .synchronized:
                            continue
                        case let .snapshot(snapshot), let .projection(snapshot):
                            guard snapshot.thread.id == threadID,
                                  snapshot.snapshotSequence > afterSequence else { continue }
                            if let rollbackRequestID,
                               let failure = snapshot.thread.orchestrationV2Control?["thread"]?["rollbackFailure"],
                               failure["requestId"]?.stringValue == rollbackRequestID {
                                throw FeatureConversationRewindError(
                                    message: failure["message"]?.stringValue ?? "Conversation rewind failed.",
                                    didNotRevert: true
                                )
                            }
                            if isComplete(snapshot.thread, messageID: messageID, turnCount: turnCount, rollbackRunID: rollbackRunID) {
                                return snapshot.snapshotSequence
                            }
                            if let failure = snapshot.thread.activities.last(where: {
                                $0.kind == "checkpoint.revert.failed" && !previousFailureIDs.contains($0.id)
                                    && (rollbackRunID == nil
                                        ? $0.payload["turnCount"] == .number(Double(turnCount))
                                        : rollbackRequestID != nil && $0.payload["requestId"]?.stringValue == rollbackRequestID)
                            }) {
                                throw FeatureConversationRewindError(
                                    message: failure.payload["detail"]?.stringValue ?? failure.summary,
                                    didNotRevert: true
                                )
                            }
                        case let .event(event):
                            guard event["payload"]?["threadId"]?.stringValue == threadID,
                                  case let .number(sequence)? = event["sequence"],
                                  sequence > Double(afterSequence) else { continue }
                            if event["type"]?.stringValue == "thread.activity-appended",
                               let activity = event["payload"]?["activity"],
                               activity["kind"]?.stringValue == "checkpoint.revert.failed",
                               (rollbackRunID == nil
                                ? activity["payload"]?["turnCount"] == .number(Double(turnCount))
                                : rollbackRequestID != nil && activity["payload"]?["requestId"]?.stringValue == rollbackRequestID) {
                                throw FeatureConversationRewindError(
                                    message: activity["payload"]?["detail"]?.stringValue
                                        ?? activity["summary"]?.stringValue ?? "Conversation rewind failed.",
                                    didNotRevert: true
                                )
                            }
                            if rollbackRunID == nil, event["type"]?.stringValue == "thread.reverted",
                               event["payload"]?["turnCount"] == .number(Double(turnCount)) { return Int(sequence) }
                        }
                    }
                }
                throw FeatureConversationRewindError(message: "The connection closed before rewind finished. Reload the thread before trying again.")
            }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw FeatureConversationRewindError(message: "Timed out waiting for rewind. Reload the thread before trying again.")
            }
            defer { group.cancelAll() }
            guard let sequence = try await group.next() else { throw CancellationError() }
            return sequence
        }
    }
}
