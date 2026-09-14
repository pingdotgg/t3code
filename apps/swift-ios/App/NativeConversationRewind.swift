import Foundation

enum NativeConversationRewind {
    /// Use checkpoint counts, not visible message indexes. Pages and steering messages
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

    static func isComplete(_ thread: OrchestrationThread, messageID: String, turnCount: Int) -> Bool {
        !thread.messages.contains(where: { $0.id == messageID })
            && thread.checkpoints.allSatisfy { $0.checkpointTurnCount <= turnCount }
            && (turnCount == 0
                ? thread.latestTurn == nil
                : thread.checkpoints.contains { $0.turnId == thread.latestTurn?.turnId })
    }

    /// Command acceptance precedes provider rollback. Wait for its completion event
    /// or an authoritative replacement snapshot, including while another thread is open.
    static func waitForCompletion(
        events: AsyncThrowingStream<ThreadStreamItem, Error>,
        threadID: String,
        messageID: String,
        turnCount: Int,
        afterSequence: Int,
        previousFailureIDs: Set<String>,
        timeout: Duration = .seconds(120)
    ) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                for try await item in events {
                    switch item {
                    case .synchronized:
                        continue
                    case let .snapshot(snapshot):
                        guard snapshot.thread.id == threadID,
                              snapshot.snapshotSequence > afterSequence else { continue }
                        if let failure = snapshot.thread.activities.last(where: {
                            $0.kind == "checkpoint.revert.failed" && !previousFailureIDs.contains($0.id)
                        }) {
                            throw FeatureConversationRewindError(
                                message: failure.payload["detail"]?.stringValue ?? failure.summary
                            )
                        }
                        if isComplete(snapshot.thread, messageID: messageID, turnCount: turnCount) { return }
                    case let .event(event):
                        guard event["payload"]?["threadId"]?.stringValue == threadID,
                              case let .number(sequence)? = event["sequence"],
                              sequence > Double(afterSequence) else { continue }
                        if event["type"]?.stringValue == "thread.activity-appended",
                           let activity = event["payload"]?["activity"],
                           activity["kind"]?.stringValue == "checkpoint.revert.failed" {
                            throw FeatureConversationRewindError(
                                message: activity["payload"]?["detail"]?.stringValue
                                    ?? activity["summary"]?.stringValue ?? "Conversation rewind failed."
                            )
                        }
                        if event["type"]?.stringValue == "thread.reverted",
                           event["payload"]?["turnCount"] == .number(Double(turnCount)) { return }
                    }
                }
                throw FeatureConversationRewindError(message: "The connection closed before rewind finished. Reload the thread before trying again.")
            }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw FeatureConversationRewindError(message: "Timed out waiting for rewind. Reload the thread before trying again.")
            }
            defer { group.cancelAll() }
            _ = try await group.next()
        }
    }
}
