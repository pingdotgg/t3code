import Foundation

enum NativeConversationRewind {
    struct Target: Equatable, Sendable {
        let checkpoint: OrchestrationV2Commands.ConversationRollbackTarget

        var runID: String { checkpoint.runID }

        func command(threadID: String) -> JSONValue {
            OrchestrationV2Commands.rollback(threadID: threadID, scopeID: checkpoint.scopeID,
                checkpointID: checkpoint.checkpointID, restoreFiles: false)
        }
    }

    /// Older loaded V2 messages can lack run/checkpoint controls. Allow local user
    /// messages here, then resolve their checkpoint with a full read on invocation.
    static func canRewind(before messageID: String, in thread: OrchestrationThread) -> Bool {
        guard let control = thread.orchestrationV2Control else { return false }
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
        guard let control = thread.orchestrationV2Control,
              canRewind(before: messageID, in: thread),
              let runID = thread.messages.first(where: { $0.id == messageID })?.turnId else {
            throw FeatureConversationRewindError(message: "This message cannot be rewound. Wait for this thread's work to finish.")
        }
        return Target(checkpoint: try OrchestrationV2Commands.conversationRollbackTarget(
            beforeRunID: runID, projection: control
        ))
    }

    static func isComplete(
        _ thread: OrchestrationThread, messageID: String, rollbackRunID: String? = nil
    ) -> Bool {
        guard let rollbackRunID else { return false }
        return !thread.messages.contains(where: { $0.id == messageID })
            && (thread.orchestrationV2Control?["runs"]?.v2Array ?? []).contains {
                $0["id"]?.stringValue == rollbackRunID && $0["status"]?.stringValue == "rolled_back"
            }
    }

    /// Command acceptance precedes provider rollback. Wait for its completion event
    /// or an authoritative replacement snapshot, including while another thread is open.
    static func waitForCompletion(
        batches: AsyncThrowingStream<[ThreadStreamItem], Error>,
        threadID: String,
        messageID: String,
        afterSequence: Int,
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
                            if isComplete(snapshot.thread, messageID: messageID, rollbackRunID: rollbackRunID) {
                                return snapshot.snapshotSequence
                            }
                        case .event:
                            continue
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
