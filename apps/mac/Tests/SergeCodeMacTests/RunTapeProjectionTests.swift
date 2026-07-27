import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Run tape projection")
struct RunTapeProjectionTests {
    private let epoch = Date(timeIntervalSince1970: 1_000)

    @Test("a user message opens a cell; signals follow dominance")
    func cellsPerTurnWithDominance() {
        let timeline: [TimelineItem] = [
            user("u1", text: "look around"),
            tool("t1", kind: .fileRead, detail: "a/b.swift"),
            user("u2", text: "edit it"),
            tool("t2", kind: .fileChange, detail: "a/b.swift"),
            tool("t3", kind: .command),
            user("u3", text: "why broken"),
            tool("t4", kind: .fileChange, detail: "a/b.swift"),
            tool("t5", kind: .command, status: .failed),
            user("u4", text: "thanks"),
        ]

        let cells = RunTapeProjection.tape(timeline: timeline)

        #expect(cells.map(\.id) == ["u1", "u2", "u3", "u4"])
        #expect(cells.map(\.turnNumber) == [1, 2, 3, 4])
        #expect(cells.map(\.signal) == [.work, .edit, .fail, .talk])
    }

    @Test("leading items before the first user message form their own cell")
    func leadingTurnCell() {
        let timeline: [TimelineItem] = [
            tool("t1", kind: .command),
            user("u1", text: "hello"),
        ]

        let cells = RunTapeProjection.tape(timeline: timeline)

        #expect(cells.count == 2)
        #expect(cells[0].id == "runtape-leading-turn")
        #expect(cells[0].signal == .work)
        #expect(cells[1].id == "u1")
    }

    @Test("an empty leading segment produces no cell")
    func noEmptyLeadingCell() {
        let timeline: [TimelineItem] = [
            user("u1", text: "hello"),
            tool("t1", kind: .command),
        ]

        let cells = RunTapeProjection.tape(timeline: timeline)

        #expect(cells.map(\.id) == ["u1"])
    }

    @Test("edited files dedup on the raw detail string")
    func editedFileDedup() {
        let timeline: [TimelineItem] = [
            user("u1", text: "edit"),
            tool("t1", kind: .fileChange, detail: "a.swift"),
            tool("t2", kind: .fileChange, detail: "a.swift"),
            tool("t3", kind: .fileChange, detail: "b.swift"),
        ]

        let cells = RunTapeProjection.tape(timeline: timeline)

        #expect(cells[0].editedFileCount == 2)
        #expect(cells[0].toolCount == 3)
    }

    @Test("a running tool marks the cell live; failure still dominates the signal")
    func runningToolMarksLive() {
        let timeline: [TimelineItem] = [
            user("u1", text: "go"),
            tool("t1", kind: .command, status: .failed),
            tool("t2", kind: .command, status: .running),
        ]

        let cells = RunTapeProjection.tape(timeline: timeline)

        #expect(cells[0].hasRunningTool)
        #expect(cells[0].signal == .fail)
    }

    @Test("summary line reports tools, files, failures")
    func summaryLine() {
        let cell = RunTapeCell(
            id: "u1", turnNumber: 1, signal: .fail, toolCount: 6, failedCount: 1,
            editedFileCount: 2, hasRunningTool: false)

        #expect(cell.summaryLine == "6 tools · 2 files · 1 failed")

        let quiet = RunTapeCell(
            id: "u2", turnNumber: 2, signal: .talk, toolCount: 0, failedCount: 0,
            editedFileCount: 0, hasRunningTool: false)

        #expect(quiet.summaryLine == "no tools")
    }

    // MARK: - Fixtures

    private func user(_ id: String, text: String) -> TimelineItem {
        .userMessage(id: id, text: text, attachments: [], at: epoch)
    }

    private func tool(
        _ id: String,
        kind: ToolEventKind = .command,
        detail: String = "",
        status: ToolEventStatus = .succeeded
    ) -> TimelineItem {
        .toolEvent(
            id: id, name: "Tool", detail: detail, kind: kind, status: status,
            at: epoch, output: nil, outputIsError: false)
    }
}

@Suite("Run tape cache", .serialized)
@MainActor
struct RunTapeCacheTests {
    private let epoch = Date(timeIntervalSince1970: 1_000)

    @Test("same structure version returns the memoized cells")
    func memoizesOnStructureVersion() {
        RunTapeCache.resetForTesting()
        defer { RunTapeCache.resetForTesting() }
        let timeline: [TimelineItem] = [
            .userMessage(id: "u1", text: "go", attachments: [], at: epoch)
        ]

        let first = RunTapeCache.tape(
            timeline: timeline, threadID: "runtape-cache-t1", structureVersion: 1)
        // Same version: the (empty-timeline) recompute must NOT happen —
        // cached cells come back even though the input differs.
        let second = RunTapeCache.tape(
            timeline: [], threadID: "runtape-cache-t1", structureVersion: 1)

        #expect(first == second)
        #expect(second.map(\.id) == ["u1"])
    }

    @Test("a structure bump recomputes; eviction drops the entry")
    func recomputesOnBumpAndEvicts() {
        RunTapeCache.resetForTesting()
        defer { RunTapeCache.resetForTesting() }
        let timeline: [TimelineItem] = [
            .userMessage(id: "u1", text: "go", attachments: [], at: epoch)
        ]

        _ = RunTapeCache.tape(
            timeline: timeline, threadID: "runtape-cache-t2", structureVersion: 1)
        let bumped = RunTapeCache.tape(
            timeline: [], threadID: "runtape-cache-t2", structureVersion: 2)
        #expect(bumped.isEmpty)

        RunTapeCache.evict(threadID: "runtape-cache-t2")
        let fresh = RunTapeCache.tape(
            timeline: timeline, threadID: "runtape-cache-t2", structureVersion: 2)
        #expect(fresh.map(\.id) == ["u1"])
    }
}
