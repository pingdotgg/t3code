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

    @Test("manual order keeps saved rows stable and puts new rows first")
    func manualOrderMergesNewRows() {
        let threads = [
            makeThread(id: "newest", at: 3),
            makeThread(id: "saved-first", at: 2),
            makeThread(id: "saved-second", at: 1),
        ]

        let ordered = AppModel.manuallyOrdered(
            threads, order: ["saved-second", "saved-first"])

        #expect(ordered.map(\.id) == ["newest", "saved-second", "saved-first"])
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
