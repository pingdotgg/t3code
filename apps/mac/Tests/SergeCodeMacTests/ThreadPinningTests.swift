import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Thread pinning")
@MainActor
struct ThreadPinningTests {
    @Test("pinned rows retain their relative order and precede unpinned rows")
    func pinnedRowsComeFirst() {
        let threads = [
            makeThread(id: "newest", at: 3),
            makeThread(id: "pinned-later", at: 2),
            makeThread(id: "pinned-earlier", at: 1),
        ]

        let ordered = AppModel.pinnedFirst(
            threads, pinnedIDs: ["pinned-later", "pinned-earlier"])

        #expect(ordered.map(\.id) == ["pinned-later", "pinned-earlier", "newest"])
    }

    private func makeThread(id: String, at timestamp: TimeInterval) -> ChatThread {
        ChatThread(
            id: id,
            projectID: "project",
            title: id,
            provider: .codex,
            status: .idle,
            updatedAt: Date(timeIntervalSince1970: timestamp))
    }
}
