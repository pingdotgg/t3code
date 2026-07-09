import Foundation
import T3Kit

/// Pure mapping from wire checkpoint summaries into UI `Checkpoint` entities.
/// Kept free of actor state so unit tests can cover the field-preserving map
/// without standing up LiveBackend.
enum CheckpointMapping {
    static func checkpoint(
        from summary: OrchestrationCheckpointSummary, threadID: String, at: Date? = nil
    ) -> Checkpoint {
        let createdAt = at ?? WireDate.parse(summary.completedAt) ?? Date()
        return Checkpoint(
            id: summary.checkpointRef,
            threadID: threadID,
            label: "Turn \(summary.checkpointTurnCount)",
            createdAt: createdAt,
            turnCount: summary.checkpointTurnCount,
            status: status(from: summary.status),
            files: summary.files.map(file(from:)),
            assistantMessageId: summary.assistantMessageId
        )
    }

    static func checkpoint(
        from payload: ThreadTurnDiffCompletedPayload, threadID: String, at: Date? = nil
    ) -> Checkpoint {
        let createdAt = at ?? WireDate.parse(payload.completedAt) ?? Date()
        return Checkpoint(
            id: payload.checkpointRef,
            threadID: threadID,
            label: "Turn \(payload.checkpointTurnCount)",
            createdAt: createdAt,
            turnCount: payload.checkpointTurnCount,
            status: status(from: payload.status),
            files: payload.files.map(file(from:)),
            assistantMessageId: payload.assistantMessageId
        )
    }

    static func status(from wire: OrchestrationCheckpointStatus) -> CheckpointStatus {
        switch wire {
        case .ready: .ready
        case .missing: .missing
        case .error: .error
        }
    }

    static func file(from wire: OrchestrationCheckpointFile) -> CheckpointFile {
        CheckpointFile(
            path: wire.path, kind: wire.kind, additions: wire.additions, deletions: wire.deletions)
    }

    /// Decode a summary JSON blob (for unit tests without importing T3Kit).
    static func checkpoint(fromSummaryJSON json: String, threadID: String) throws -> Checkpoint {
        let summary = try JSONDecoder().decode(
            OrchestrationCheckpointSummary.self, from: Data(json.utf8))
        return checkpoint(from: summary, threadID: threadID)
    }

    /// Decode a turn-diff-completed payload JSON blob (unit tests).
    static func checkpoint(fromPayloadJSON json: String, threadID: String) throws -> Checkpoint {
        let payload = try JSONDecoder().decode(
            ThreadTurnDiffCompletedPayload.self, from: Data(json.utf8))
        return checkpoint(from: payload, threadID: threadID)
    }
}
