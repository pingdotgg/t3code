import Foundation
import T3Kit
import Testing

@testable import SergeCodeMac

/// The shell resume path: `lastShellSequence` is the cursor passed back as
/// `subscribeShell(afterSequence:)` on reconnect, and the dedup gate for the
/// replay/live overlap the server's buffer-before-read design produces.
@Suite("LiveBackend shell resume")
struct LiveBackendShellResumeTests {
    private let timestamp = "2026-07-27T12:00:00.000Z"

    @Test("shell snapshot seeds the resume cursor and events advance it")
    func snapshotSeedsCursorAndEventsAdvanceIt() async throws {
        let backend = LiveBackend()

        await backend.debugHandleShellItem(try decodeItem(snapshotJSON(sequence: 10)))
        #expect(await backend.debugLastShellSequence() == 10)

        await backend.debugHandleShellItem(
            try decodeItem(threadUpsertedJSON(sequence: 11, threadID: "thread-live")))
        #expect(await backend.debugLastShellSequence() == 11)
        #expect(await backend.debugThreadIDs().contains("thread-live"))
    }

    @Test("shell events at or below the cursor are dropped")
    func staleShellEventsAreDropped() async throws {
        let backend = LiveBackend()

        await backend.debugHandleShellItem(try decodeItem(snapshotJSON(sequence: 10)))
        // Replay/live overlap: the same event can arrive twice on a resumed
        // subscription; the second copy must not re-apply.
        await backend.debugHandleShellItem(
            try decodeItem(threadUpsertedJSON(sequence: 10, threadID: "thread-stale")))

        #expect(await backend.debugLastShellSequence() == 10)
        #expect(!(await backend.debugThreadIDs().contains("thread-stale")))
    }

    @Test("thread resume cursor requires intact timeline state")
    func threadResumeCursorRequiresIntactState() async throws {
        let backend = LiveBackend()
        let threadID = "thread-resume"

        // No state at all: a fresh open must take the full snapshot.
        #expect(await backend.debugThreadResumeCursor(threadID: threadID) == nil)

        await backend.debugHandleThreadItem(
            threadID: threadID,
            item: try decodeThreadItem(threadSnapshotJSON(threadID: threadID, sequence: 42)))

        // Snapshot applied: the in-memory timeline is intact, resume in place.
        #expect(await backend.debugThreadResumeCursor(threadID: threadID) == 42)
    }

    private func decodeItem(_ json: String) throws -> OrchestrationShellStreamItem {
        try JSONDecoder().decode(OrchestrationShellStreamItem.self, from: Data(json.utf8))
    }

    private func decodeThreadItem(_ json: String) throws -> OrchestrationThreadStreamItem {
        try JSONDecoder().decode(OrchestrationThreadStreamItem.self, from: Data(json.utf8))
    }

    private func snapshotJSON(sequence: Int) -> String {
        """
        {
          "kind": "snapshot",
          "snapshot": {
            "snapshotSequence": \(sequence),
            "projects": [],
            "threads": [],
            "updatedAt": "\(timestamp)"
          }
        }
        """
    }

    private func threadUpsertedJSON(sequence: Int, threadID: String) -> String {
        """
        {
          "kind": "thread-upserted",
          "sequence": \(sequence),
          "thread": {
            "id": "\(threadID)",
            "projectId": "project-resume",
            "title": "Shell resume test",
            "modelSelection": { "instanceId": "codex", "model": "gpt-5.5" },
            "createdAt": "\(timestamp)",
            "updatedAt": "\(timestamp)",
            "hasPendingApprovals": false,
            "hasPendingUserInput": false,
            "hasActionableProposedPlan": false
          }
        }
        """
    }

    private func threadSnapshotJSON(threadID: String, sequence: Int) -> String {
        """
        {
          "kind": "snapshot",
          "snapshot": {
            "snapshotSequence": \(sequence),
            "thread": {
              "id": "\(threadID)",
              "projectId": "project-resume",
              "title": "Thread resume test",
              "modelSelection": { "instanceId": "codex", "model": "gpt-5.5" },
              "createdAt": "\(timestamp)",
              "updatedAt": "\(timestamp)",
              "messages": [],
              "activities": [],
              "checkpoints": []
            }
          }
        }
        """
    }
}
