import Foundation
import Testing

@testable import SergeCodeMac

@Suite("CheckpointMapping")
struct CheckpointMappingTests {
    @Test("maps OrchestrationCheckpointSummary fields")
    func mapsSummary() throws {
        let json = """
            {
              "turnId": "turn-9",
              "checkpointTurnCount": 9,
              "checkpointRef": "ckpt-ref-9",
              "status": "missing",
              "files": [
                {"path": "Sources/A.swift", "kind": "modified", "additions": 3, "deletions": 1},
                {"path": "Sources/B.swift", "kind": "added", "additions": 10, "deletions": 0}
              ],
              "assistantMessageId": "msg-9",
              "completedAt": "2024-06-01T12:00:00.000Z"
            }
            """
        let checkpoint = try CheckpointMapping.checkpoint(fromSummaryJSON: json, threadID: "thread-x")
        #expect(checkpoint.id == "ckpt-ref-9")
        #expect(checkpoint.threadID == "thread-x")
        #expect(checkpoint.turnCount == 9)
        #expect(checkpoint.label == "Turn 9")
        #expect(checkpoint.status == .missing)
        #expect(checkpoint.assistantMessageId == "msg-9")
        #expect(checkpoint.files.count == 2)
        #expect(checkpoint.files[0].path == "Sources/A.swift")
        #expect(checkpoint.files[0].kind == "modified")
        #expect(checkpoint.files[0].additions == 3)
        #expect(checkpoint.files[0].deletions == 1)
        #expect(checkpoint.files[1].kind == "added")
    }

    @Test("maps ThreadTurnDiffCompletedPayload")
    func mapsPayload() throws {
        let json = """
            {
              "threadId": "t1",
              "turnId": "tu",
              "checkpointTurnCount": 2,
              "checkpointRef": "ref-2",
              "status": "error",
              "files": [
                {"path": "a.ts", "kind": "deleted", "additions": 0, "deletions": 4}
              ],
              "completedAt": "2024-01-01T00:00:00.000Z"
            }
            """
        let checkpoint = try CheckpointMapping.checkpoint(fromPayloadJSON: json, threadID: "t1")
        #expect(checkpoint.turnCount == 2)
        #expect(checkpoint.status == .error)
        #expect(checkpoint.files.first?.deletions == 4)
        #expect(checkpoint.assistantMessageId == nil)
    }

    @Test("maps ready status")
    func mapsReady() throws {
        let json = """
            {
              "turnId": "t",
              "checkpointTurnCount": 1,
              "checkpointRef": "r",
              "status": "ready",
              "files": [],
              "completedAt": "2024-01-01T00:00:00.000Z"
            }
            """
        let checkpoint = try CheckpointMapping.checkpoint(fromSummaryJSON: json, threadID: "t")
        #expect(checkpoint.status == .ready)
        #expect(checkpoint.files.isEmpty)
    }
}
