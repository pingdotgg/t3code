import Foundation
import Testing
@testable import T3Code

@MainActor
struct HomePresentationCacheTests {
    private func presentation(
        _ cache: HomePresentationCache, _ snapshot: FeatureSnapshot, rowRevision: UInt64, query: String = ""
    ) -> HomePresentation {
        cache.presentation(
            snapshot: snapshot, revision: 1, rowRevision: rowRevision, query: query,
            projectID: nil, now: .distantPast, pullRequestsByThreadID: [:]
        )
    }

    @Test func previewUpdatesChangeSearchResultsWithoutAnOrderChange() {
        let cache = HomePresentationCache()
        var snapshot = FeatureSnapshot(threads: [FeatureThread(
            id: "thread", projectID: "project", title: "Task", preview: "Before"
        )])
        #expect(presentation(cache, snapshot, rowRevision: 1, query: "needle").searchResults.isEmpty)
        let previousOrder = HomeOrderKey(snapshot.threads[0])
        snapshot.threads[0].preview = "Found the needle"
        #expect(HomeOrderKey(snapshot.threads[0]) == previousOrder)
        #expect(presentation(cache, snapshot, rowRevision: 2, query: "needle").searchResults.map(\.id) == ["thread"])
        snapshot.threads[0].preview = "No match"
        #expect(presentation(cache, snapshot, rowRevision: 3, query: "needle").searchResults.isEmpty)
    }

    @Test func sessionProviderChangeRefreshesTheRowContext() {
        let cache = HomePresentationCache()
        var snapshot = FeatureSnapshot(threads: [FeatureThread(
            id: "thread", projectID: "project", environmentID: "computer", title: "Task", providerID: "codex"
        )])
        #expect(presentation(cache, snapshot, rowRevision: 1).rowContexts["thread"]?.providerID == "codex")
        snapshot.threads[0].sessionProviderID = "codex-work"
        let updated = presentation(cache, snapshot, rowRevision: 2)
        #expect(updated.rowContexts["thread"]?.providerID == "codex-work")
        #expect(updated.active.map(\.id) == ["thread"])
    }
}
