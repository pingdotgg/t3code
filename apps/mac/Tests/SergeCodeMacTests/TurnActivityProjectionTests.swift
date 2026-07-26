import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Turn activity projection")
struct TurnActivityProjectionTests {
    private let epoch = Date(timeIntervalSince1970: 1_000)

    @Test("events before the first user message belong to turn 1")
    func leadingEventsFormTurnOne() {
        let timeline: [TimelineItem] = [
            tool("t1", name: "Read"),
            tool("t2", name: "Edit", kind: .fileChange, detail: "a.swift"),
        ]

        let turn = TurnActivityProjection.currentTurn(timeline: timeline, checkpoints: [])

        #expect(turn.turnNumber == 1)
        #expect(turn.prompt == nil)
        #expect(turn.startedAt == nil)
        #expect(turn.events.map(\.id) == ["t1", "t2"])
        #expect(turn.filesTouched == ["a.swift"])
    }

    @Test("a user message opens a new turn and resets the activity")
    func userMessageStartsNewTurn() {
        let timeline: [TimelineItem] = [
            user("u1", text: "first request", at: epoch),
            tool("t1", name: "Read"),
            user("u2", text: "second request\nwith details", at: epoch.addingTimeInterval(60)),
            tool("t2", name: "Bash"),
            tool("t3", name: "Edit", kind: .fileChange, detail: "b.swift"),
        ]

        let turn = TurnActivityProjection.currentTurn(timeline: timeline, checkpoints: [])

        #expect(turn.turnNumber == 2)
        #expect(turn.prompt == "second request")
        #expect(turn.startedAt == epoch.addingTimeInterval(60))
        #expect(turn.events.map(\.id) == ["t2", "t3"])
        #expect(turn.toolCount == 2)
        #expect(turn.filesTouched == ["b.swift"])
    }

    @Test("files touched are unique in first-touch order")
    func filesTouchedAreUnique() {
        let timeline: [TimelineItem] = [
            user("u1", text: "work", at: epoch),
            tool("t1", name: "Edit", kind: .fileChange, detail: "b.swift"),
            tool("t2", name: "Edit", kind: .fileChange, detail: "a.swift"),
            tool("t3", name: "Edit", kind: .fileChange, detail: "b.swift"),
            tool("t4", name: "Read", kind: .fileRead, detail: "c.swift"),
        ]

        let turn = TurnActivityProjection.currentTurn(timeline: timeline, checkpoints: [])

        #expect(turn.filesTouched == ["b.swift", "a.swift"])
    }

    @Test("failed events are counted")
    func failedEventsAreCounted() {
        let timeline: [TimelineItem] = [
            user("u1", text: "work", at: epoch),
            tool("t1", name: "Bash", status: .failed),
            tool("t2", name: "Bash", status: .succeeded),
            tool("t3", name: "Edit", status: .running),
        ]

        let turn = TurnActivityProjection.currentTurn(timeline: timeline, checkpoints: [])

        #expect(turn.failedCount == 1)
        #expect(turn.toolCount == 3)
    }

    @Test("turn number falls back to checkpoints when no user message exists")
    func checkpointFallbackNumbering() {
        let checkpoints = [
            checkpoint(turnCount: 3),
            checkpoint(turnCount: 5),
        ]

        let turn = TurnActivityProjection.currentTurn(timeline: [], checkpoints: checkpoints)

        #expect(turn.turnNumber == 6)
    }

    // MARK: - Fixtures

    private func user(_ id: String, text: String, at: Date) -> TimelineItem {
        .userMessage(id: id, text: text, attachments: [], at: at)
    }

    private func tool(
        _ id: String,
        name: String,
        kind: ToolEventKind = .command,
        detail: String = "",
        status: ToolEventStatus = .succeeded
    ) -> TimelineItem {
        .toolEvent(
            id: id, name: name, detail: detail, kind: kind, status: status,
            at: epoch, output: nil, outputIsError: false)
    }

    private func checkpoint(turnCount: Int) -> Checkpoint {
        Checkpoint(id: "cp-\(turnCount)", threadID: "thread", label: "Turn \(turnCount)",
                   createdAt: epoch, turnCount: turnCount)
    }
}
