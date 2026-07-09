import Foundation
import Testing

@testable import SergeCodeMac

@Suite("MockBackend scoped diff")
struct MockBackendDiffTests {
    @Test("full diff has multiple files including long-line and paired")
    func fullDiffParity() async throws {
        let backend = MockBackend()
        await backend.start()
        let files = try await backend.diff(threadID: "thread-1")
        #expect(files.count >= 3)
        #expect(files.contains(where: { $0.path.contains("SidebarView") }))
        #expect(files.contains(where: { $0.path.contains("Constants.swift") }))
        #expect(files.contains(where: { $0.path.contains("Colors.swift") }))

        let longFile = files.first { $0.path.contains("Constants.swift") }
        let longText = longFile?.hunks.first?.lines.first { $0.kind == .deletion }?.text ?? ""
        #expect(longText.count > 120)

        let paired = files.first { $0.path.contains("Colors.swift") }
        let hunkLines = paired?.hunks.first?.lines ?? []
        #expect(hunkLines.contains(where: { $0.kind == .deletion && $0.text.contains("red") }))
        #expect(hunkLines.contains(where: { $0.kind == .addition && $0.text.contains("orange") }))
    }

    @Test("scoped turn diffs return subsets")
    func scopedDiffs() async throws {
        let backend = MockBackend()
        await backend.start()

        let first = try await backend.diff(threadID: "thread-1", fromTurn: 0, toTurn: 1)
        #expect(!first.isEmpty)
        #expect(first.allSatisfy { $0.path.contains("SidebarView") })

        let second = try await backend.diff(threadID: "thread-1", fromTurn: 1, toTurn: 2)
        #expect(second.contains(where: { $0.path.contains("AppModel") || $0.path.contains("Constants") }))

        let third = try await backend.diff(threadID: "thread-1", fromTurn: 2, toTurn: 3)
        #expect(third.contains(where: { $0.path.contains("Colors") }))
    }

    @Test("checkpoints include turnCount status and files")
    func checkpointParity() async throws {
        let backend = MockBackend()
        await backend.start()
        let checkpoints = try await backend.checkpoints(threadID: "thread-1")
        #expect(checkpoints.count >= 3)
        #expect(checkpoints.contains(where: { $0.status == .missing }))
        #expect(checkpoints.allSatisfy { $0.turnCount > 0 })
        #expect(checkpoints.contains(where: { !$0.files.isEmpty }))
        let multi = checkpoints.first { $0.files.count > 6 }
        #expect(multi != nil)
    }

    @Test("restoreCheckpoint accepts turnCount")
    func restoreByTurn() async throws {
        let backend = MockBackend()
        await backend.start()
        try await backend.restoreCheckpoint(threadID: "thread-1", turnCount: 1)
        // Should not throw; mock emits a notice via events stream.
    }
}
