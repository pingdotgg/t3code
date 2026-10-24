import Foundation
import Testing
@testable import T3Code

@MainActor
struct FeatureFileSearchTests {
    private func request(_ query: String, environment: String = "one", root: String = "/worktree") -> FeatureFileSearchState.Request {
        .init(threadID: "\(environment):thread", workspaceRoot: root, query: query)
    }

    @Test func recursiveResultsKeepFullPathsAndServerTruncation() async {
        let search = FeatureFileSearchState()
        let nested = FeatureFileEntry(path: "src/deep/worker.swift", name: "worker.swift", kind: .file)
        await search.search(request("  src/deep  "), debounce: {}) { query, limit in
            #expect(query == "src/deep")
            #expect(limit == 200)
            return .init(entries: [nested], isTruncated: true)
        }
        #expect(search.result?.entries == [nested])
        #expect(search.result?.isTruncated == true)
        #expect(!search.isLoading)
        #expect(search.errorMessage == nil)
    }

    @Test func clearingQueryDropsResultsAndRejectsLateResponse() async {
        let search = FeatureFileSearchState()
        let held = HeldFileSearch()
        let old = Task {
            await search.search(request("swift"), debounce: {}) { _, _ in try await held.fetch() }
        }
        await held.waitUntilRequested()
        await search.search(request("  "), debounce: { Issue.record("Empty queries must not debounce") }) { _, _ in
            Issue.record("Empty queries must not fetch")
            return .init(entries: [])
        }
        held.finish(.success(.init(entries: [], isTruncated: true)))
        await old.value
        #expect(search.result == nil)
        #expect(!search.isLoading)
        #expect(search.request?.query == "")
    }

    @Test func newEnvironmentAndWorktreeRejectOlderError() async {
        let search = FeatureFileSearchState()
        let held = HeldFileSearch()
        let old = Task {
            await search.search(request("swift"), debounce: {}) { _, _ in try await held.fetch() }
        }
        await held.waitUntilRequested()
        let current = request("swift", environment: "two", root: "/other")
        await search.search(current, debounce: {}) { _, _ in .init(entries: []) }
        held.finish(.failure(URLError(.notConnectedToInternet)))
        await old.value
        #expect(search.request == current)
        #expect(search.result?.entries == [])
        #expect(search.errorMessage == nil)
    }

    @Test func canceledDebounceNeverSendsARequest() async {
        let search = FeatureFileSearchState()
        let debounce = HeldFileSearch()
        var fetches = 0
        let task = Task {
            await search.search(request("swift"), debounce: { _ = try await debounce.fetch() }) { _, _ in
                fetches += 1
                return .init(entries: [])
            }
        }
        await debounce.waitUntilRequested()
        task.cancel()
        debounce.finish(.success(.init(entries: [])))
        await task.value
        #expect(fetches == 0)
        #expect(search.errorMessage == nil)
        #expect(!search.isLoading)
    }

    @Test func canceledInFlightSearchCannotPublish() async {
        let search = FeatureFileSearchState()
        let held = HeldFileSearch()
        let task = Task {
            await search.search(request("swift"), debounce: {}) { _, _ in try await held.fetch() }
        }
        await held.waitUntilRequested()
        task.cancel()
        held.finish(.success(.init(entries: [], isTruncated: true)))
        await task.value
        #expect(search.result == nil)
        #expect(search.errorMessage == nil)
        #expect(!search.isLoading)
    }

    @Test func searchCanRetryAfterAnErrorAndBoundsTheQuery() async {
        let search = FeatureFileSearchState()
        let request = request(String(repeating: "a", count: 300))
        await search.search(request, debounce: {}) { _, _ in throw URLError(.notConnectedToInternet) }
        #expect(search.errorMessage != nil)
        await search.search(request, debounce: {}) { query, _ in
            #expect(query.count == 256)
            return .init(entries: [])
        }
        #expect(search.errorMessage == nil)
        #expect(search.result?.entries == [])
    }

    @Test func searchMappingUsesTheServerPathStyleAndKeepsIgnoredAndHiddenMetadata() {
        let windows = FeatureFileSearchMapping.entry(
            .init(path: #".config\nested\settings.json"#, kind: .file, ignored: true),
            workspaceRoot: #"D:\worktrees\task"#
        )
        #expect(windows.path == ".config/nested/settings.json")
        #expect(windows.name == "settings.json")
        #expect(windows.isHidden)
        #expect(windows.isIgnored)
        let posix = FeatureFileSearchMapping.entry(
            .init(path: #"src/back\slash.swift"#, kind: .file), workspaceRoot: "/worktree"
        )
        #expect(posix.path == #"src/back\slash.swift"#)
        #expect(posix.name == #"back\slash.swift"#)
        #expect(!posix.isHidden)
    }
}

@MainActor
private final class HeldFileSearch {
    private var continuation: CheckedContinuation<FeatureFileSearchResult, Error>?
    private var waiter: CheckedContinuation<Void, Never>?

    func fetch() async throws -> FeatureFileSearchResult {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            waiter?.resume()
            waiter = nil
        }
    }

    func waitUntilRequested() async {
        if continuation != nil { return }
        await withCheckedContinuation { waiter = $0 }
    }

    func finish(_ result: Result<FeatureFileSearchResult, Error>) {
        continuation?.resume(with: result)
        continuation = nil
    }
}
