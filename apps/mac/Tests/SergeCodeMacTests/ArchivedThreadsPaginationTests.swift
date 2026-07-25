import Foundation
import Testing
import T3Kit

@testable import SergeCodeMac

// The Archive settings tab paginates: refresh loads only the first page,
// load-more appends subsequent pages and clears the cursor at the end.

@Suite("Archived threads pagination")
@MainActor
struct ArchivedThreadsPaginationTests {
    private func archivedThread(_ index: Int) -> ChatThread {
        ChatThread(
            id: "archived-\(index)", projectID: "proj-1", title: "Archived \(index)",
            provider: .claude, status: .archived,
            updatedAt: Date(timeIntervalSince1970: TimeInterval(1_000_000 + index)))
    }

    @Test("refresh loads the first page; load-more appends and clears the cursor")
    func paginatesArchivedThreads() async {
        let backend = MockBackend()
        await backend.insertThreads((0..<120).map(archivedThread))
        let model = AppModel(backend: backend)

        await model.refreshArchivedThreads()
        #expect(model.archivedThreads.count == AppModel.archivedThreadsPageSize)
        #expect(model.archivedThreadsTotal == 120)
        #expect(model.archivedThreadsNextCursor == AppModel.archivedThreadsPageSize)
        #expect(model.archivedThreadsError == nil)

        await model.loadMoreArchivedThreads()
        #expect(model.archivedThreads.count == 100)
        #expect(model.archivedThreadsTotal == 120)
        #expect(model.archivedThreadsNextCursor == 100)

        await model.loadMoreArchivedThreads()
        #expect(model.archivedThreads.count == 120)
        #expect(model.archivedThreadsNextCursor == nil)

        // End of list: load-more is a no-op.
        await model.loadMoreArchivedThreads()
        #expect(model.archivedThreads.count == 120)

        // No duplicate entries across pages.
        #expect(Set(model.archivedThreads.map(\.id)).count == 120)

        // Refresh returns to the first page only.
        await model.refreshArchivedThreads()
        #expect(model.archivedThreads.count == AppModel.archivedThreadsPageSize)
        #expect(model.archivedThreadsNextCursor == AppModel.archivedThreadsPageSize)
        #expect(model.archivedThreadsTotal == 120)
    }

    @Test("fewer archived threads than a page reports no next cursor")
    func shortListHasNoNextCursor() async {
        let backend = MockBackend()
        await backend.insertThreads((0..<3).map(archivedThread))
        let model = AppModel(backend: backend)

        await model.refreshArchivedThreads()
        // MockBackend's demo seed may contribute its own archived threads;
        // whatever the total, a single short page must not offer a cursor.
        #expect(model.archivedThreads.count == model.archivedThreadsTotal)
        #expect(model.archivedThreadsNextCursor == nil)
        #expect(model.archivedThreads.contains { $0.id == "archived-0" })
    }
}
