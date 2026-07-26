import Foundation
import Testing
import T3Kit

@testable import SergeCodeMac

// Bulk archive (the sidebar's "archive all settled" affordance) must archive
// every requested thread, leave the rest untouched, and refresh the archived
// list once so the Archive settings tab reflects the result immediately.

@Suite("Bulk archive")
@MainActor
struct AppModelBulkArchiveTests {
    private func makeThread(id: String, status: ThreadStatus) -> ChatThread {
        var thread = ChatThread(
            id: id, projectID: "proj-1", title: "Thread \(id)", provider: .claudex,
            status: status, updatedAt: Date(),
            sessionStatus: "idle")
        if status == .settled {
            thread.settledOverride = "settled"
            thread.settledAt = Date()
        }
        return thread
    }

    @Test("archives every requested thread and refreshes the archived list once")
    func archivesAllRequestedThreads() async throws {
        let backend = MockBackend()
        let model = AppModel(backend: backend)
        let settledA = makeThread(id: "t-settled-a", status: .settled)
        let settledB = makeThread(id: "t-settled-b", status: .settled)
        let active = makeThread(id: "t-active", status: .idle)
        // Seed the mock backend's store — `archiveThread(id:)` is a no-op for
        // unknown IDs.
        await backend.insertThreads([settledA, settledB, active])

        await model.archiveThreads([settledA, settledB])

        // The archived list refresh happens inside archiveThreads, so these
        // are deterministic without polling.
        #expect(model.archivedThreadsTotal == 2)
        #expect(Set(model.archivedThreads.map(\.id)) == [settledA.id, settledB.id])
        #expect(model.lastError == nil)

        // Backend-side, exactly the two requested threads are archived; the
        // active one is untouched.
        let archived = try await backend.archivedThreadsPage(cursor: nil, limit: 10)
        #expect(Set(archived.threads.map(\.id)) == [settledA.id, settledB.id])
    }

    @Test("archiving an empty list is a no-op beyond the refresh")
    func archivesEmptyList() async {
        let backend = MockBackend()
        let model = AppModel(backend: backend)

        await model.archiveThreads([])

        #expect(model.archivedThreadsTotal == 0)
        #expect(model.lastError == nil)
    }
}
