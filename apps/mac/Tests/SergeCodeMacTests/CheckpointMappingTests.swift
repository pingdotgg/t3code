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

    // MARK: - toolCounts

    private func tool(
        _ id: String, at: Date = Date(timeIntervalSince1970: 0)
    ) -> TimelineItem {
        .toolEvent(
            id: id, name: "bash", detail: "ls", kind: .command,
            status: .succeeded, at: at, output: nil, outputIsError: false)
    }

    private func assistant(
        _ id: String, at: Date = Date(timeIntervalSince1970: 0)
    ) -> TimelineItem {
        .assistantMessage(id: id, markdown: "done", isStreaming: false, at: at)
    }

    private func user(
        _ id: String, at: Date = Date(timeIntervalSince1970: 0)
    ) -> TimelineItem {
        .userMessage(id: id, text: "go", at: at)
    }

    private func checkpoint(
        id: String, assistantMessageId: String?, turnCount: Int = 1
    ) -> Checkpoint {
        Checkpoint(
            id: id, threadID: "t", label: "Turn \(turnCount)",
            createdAt: Date(timeIntervalSince1970: 0), turnCount: turnCount,
            assistantMessageId: assistantMessageId)
    }

    @Test("attributes tool events across two turns")
    func toolCountsTwoTurns() {
        let ck1 = checkpoint(id: "c1", assistantMessageId: "a1", turnCount: 1)
        let ck2 = checkpoint(id: "c2", assistantMessageId: "a2", turnCount: 2)
        let timeline: [TimelineItem] = [
            user("u1"),
            tool("t1"), tool("t2"),
            assistant("a1"),
            user("u2"),
            tool("t3"), tool("t4"), tool("t5"), tool("t6"),
            assistant("a2"),
        ]
        let counts = CheckpointMapping.toolCounts(
            timeline: timeline, checkpoints: [ck1, ck2])
        #expect(counts["c1"] == 2)
        #expect(counts["c2"] == 4)
        #expect(counts.count == 2)
    }

    @Test("skips checkpoint with nil assistantMessageId")
    func toolCountsNilAssistant() {
        let ck = checkpoint(id: "c1", assistantMessageId: nil)
        let timeline: [TimelineItem] = [
            user("u1"),
            tool("t1"), tool("t2"),
            assistant("a1"),
        ]
        let counts = CheckpointMapping.toolCounts(
            timeline: timeline, checkpoints: [ck])
        #expect(counts.isEmpty)
    }

    @Test("ignores tool events after the last assistant message")
    func toolCountsTrailingToolsIgnored() {
        let ck = checkpoint(id: "c1", assistantMessageId: "a1")
        let timeline: [TimelineItem] = [
            user("u1"),
            tool("t1"),
            assistant("a1"),
            tool("t2"), tool("t3"),
        ]
        let counts = CheckpointMapping.toolCounts(
            timeline: timeline, checkpoints: [ck])
        #expect(counts["c1"] == 1)
        #expect(counts.count == 1)
    }

    @Test("userMessage resets the running tool counter")
    func toolCountsUserMessageResets() {
        // Tools after a1 but before u2 would belong to an unmapped turn;
        // userMessage must clear them so they do not bleed into c2.
        let ck1 = checkpoint(id: "c1", assistantMessageId: "a1", turnCount: 1)
        let ck2 = checkpoint(id: "c2", assistantMessageId: "a2", turnCount: 2)
        let timeline: [TimelineItem] = [
            user("u1"),
            tool("t1"), tool("t2"),
            assistant("a1"),
            tool("orphan1"), tool("orphan2"),
            user("u2"),
            tool("t3"),
            assistant("a2"),
        ]
        let counts = CheckpointMapping.toolCounts(
            timeline: timeline, checkpoints: [ck1, ck2])
        #expect(counts["c1"] == 2)
        #expect(counts["c2"] == 1)
    }

    @Test("empty timeline yields empty counts")
    func toolCountsEmptyTimeline() {
        let ck = checkpoint(id: "c1", assistantMessageId: "a1")
        let counts = CheckpointMapping.toolCounts(
            timeline: [], checkpoints: [ck])
        #expect(counts.isEmpty)
    }
}
