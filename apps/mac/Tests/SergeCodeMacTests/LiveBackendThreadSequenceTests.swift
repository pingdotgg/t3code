import Foundation
import T3Kit
import Testing

@testable import SergeCodeMac

@Suite("LiveBackend thread sequence dedupe")
struct LiveBackendThreadSequenceTests {
    private let threadID = "thread-sequence"
    private let messageID = "assistant-sequence"
    private let timestamp = "2026-07-27T12:00:00.000Z"

    @Test("snapshot overlap is ignored while the next live delta is applied")
    func snapshotOverlapDoesNotDuplicateAssistantText() async throws {
        let backend = LiveBackend()

        try await backend.debugHandleThreadItem(
            threadID: threadID,
            item: decodeItem(
                snapshotJSON(sequence: 100, assistantText: "Hello")))

        // This delta was captured by the server's live buffer before its
        // snapshot query completed, so the snapshot already includes it.
        try await backend.debugHandleThreadItem(
            threadID: threadID,
            item: decodeItem(
                eventJSON(sequence: 100, eventID: "overlap", delta: "lo")))
        #expect(
            await backend.debugAssistantText(threadID: threadID, messageID: messageID)
                == "Hello")

        // A genuinely newer live event still advances the same assistant row.
        try await backend.debugHandleThreadItem(
            threadID: threadID,
            item: decodeItem(
                eventJSON(sequence: 101, eventID: "live", delta: "!")))
        #expect(
            await backend.debugAssistantText(threadID: threadID, messageID: messageID)
                == "Hello!")

        // Replaying the newest event is idempotent too.
        try await backend.debugHandleThreadItem(
            threadID: threadID,
            item: decodeItem(
                eventJSON(sequence: 101, eventID: "live-replay", delta: "!")))
        #expect(
            await backend.debugAssistantText(threadID: threadID, messageID: messageID)
                == "Hello!")
    }

    private func decodeItem(_ json: String) throws -> OrchestrationThreadStreamItem {
        try JSONDecoder().decode(
            OrchestrationThreadStreamItem.self, from: Data(json.utf8))
    }

    private func snapshotJSON(sequence: Int, assistantText: String) -> String {
        """
        {
          "kind": "snapshot",
          "snapshot": {
            "snapshotSequence": \(sequence),
            "thread": {
              "id": "\(threadID)",
              "projectId": "project-sequence",
              "title": "Sequence test",
              "modelSelection": {
                "instanceId": "codex",
                "model": "gpt-5.5"
              },
              "createdAt": "\(timestamp)",
              "updatedAt": "\(timestamp)",
              "messages": [
                {
                  "id": "\(messageID)",
                  "role": "assistant",
                  "text": "\(assistantText)",
                  "streaming": true,
                  "createdAt": "\(timestamp)",
                  "updatedAt": "\(timestamp)"
                }
              ],
              "activities": [],
              "checkpoints": []
            }
          }
        }
        """
    }

    private func eventJSON(sequence: Int, eventID: String, delta: String) -> String {
        """
        {
          "kind": "event",
          "event": {
            "sequence": \(sequence),
            "eventId": "\(eventID)",
            "aggregateKind": "thread",
            "aggregateId": "\(threadID)",
            "occurredAt": "\(timestamp)",
            "metadata": {},
            "type": "thread.message-sent",
            "payload": {
              "threadId": "\(threadID)",
              "messageId": "\(messageID)",
              "role": "assistant",
              "text": "\(delta)",
              "streaming": true,
              "createdAt": "\(timestamp)",
              "updatedAt": "\(timestamp)"
            }
          }
        }
        """
    }
}
