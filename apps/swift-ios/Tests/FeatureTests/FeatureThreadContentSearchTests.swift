import Foundation
import Testing
@testable import T3Code

@MainActor
struct FeatureThreadContentSearchTests {
    private func match(_ environment: String, thread: String = "thread", snippet: String = "Older needle") -> FeatureThreadContentMatch {
        FeatureThreadContentMatch(environmentID: environment, threadID: thread, projectID: "project", snippet: snippet)
    }

    private func snapshot() -> FeatureSnapshot {
        FeatureSnapshot(
            environments: ["a", "b"].map {
                FeatureEnvironment(id: $0, name: $0, endpoint: "https://\($0).test", connectionState: .connected)
            },
            projects: ["a", "b"].map {
                FeatureProject(id: match($0).projectID, environmentID: $0, name: "Repo", path: "/repo")
            },
            threads: ["a", "b"].map {
                FeatureThread(id: match($0).threadID, projectID: match($0).projectID, environmentID: $0, title: "Task")
            }
        )
    }

    @Test func unknownWireSourcesDoNotDiscardValidContentMatches() throws {
        let response: JSONValue = .object(["matches": .array(["user", "tool", "assistant"].map { source in
            .object([
                "threadId": .string(source), "projectId": .string("project"),
                "source": .string(source), "snippet": .string("A \(source) needle"),
            ])
        })])
        let result = try response.decode(ThreadContentSearchResult.self)
        #expect(result.matches.map(\.source) == ["user", "tool", "assistant"])
        let matches = result.featureMatches(environmentID: "remote")
        #expect(matches.map(\.threadID) == ["user", "assistant"].map {
            FeatureScopedID.thread(environmentID: "remote", wireID: $0)
        })
        #expect(matches.map(\.snippet) == ["A user needle", "A assistant needle"])
    }

    @Test func contentMatchesMergeWithOfflineLocalMatchesAndStayScoped() {
        var snapshot = snapshot()
        snapshot.environments[1].connectionState = .disconnected
        snapshot.threads[1].preview = "Local needle"
        let request = FeatureThreadSearchRequest(query: " needle ", snapshot: snapshot, projectID: nil)
        #expect(request.environmentIDs == ["a", "b"])
        #expect(request.connectedEnvironmentIDs == ["a"])
        let presentation = HomePresentation(
            snapshot: snapshot, query: request.query, projectID: nil, now: .now,
            contentMatches: [match("a"), match("a", thread: "missing"), match("c")],
            searchEnvironmentIDs: request.environmentIDs
        )
        #expect(Set(presentation.searchResults.map(\.id)) == Set(snapshot.threads.map(\.id)))
        #expect(presentation.rowContexts[match("a").threadID]?.searchSnippet == "Older needle")
        #expect(presentation.rowContexts[match("b").threadID]?.searchSnippet == nil)

        // Identical wire IDs from b must not admit a's unrelated conversation.
        snapshot.threads[1].preview = nil
        let scoped = HomePresentation(
            snapshot: snapshot, query: "needle", projectID: nil, now: .now, contentMatches: [match("b")]
        )
        #expect(scoped.searchResults.map(\.id) == [match("b").threadID])
    }

    @Test func projectAndEnvironmentChangesInvalidateCachedContentAndSnippets() {
        let snapshot = snapshot()
        let cache = HomePresentationCache()
        func present(_ matches: [FeatureThreadContentMatch], environments: [String], projectID: String? = nil) -> HomePresentation {
            cache.presentation(
                snapshot: snapshot, revision: 1, rowRevision: 1, query: "needle", projectID: projectID,
                now: .distantPast, contentMatches: matches, searchEnvironmentIDs: environments
            )
        }
        #expect(present([], environments: ["a", "b"]).searchResults.isEmpty)
        #expect(present([match("a")], environments: ["a", "b"]).searchResults.map(\.id) == [match("a").threadID])
        #expect(present([match("a", snippet: "Changed")], environments: ["a", "b"])
            .rowContexts[match("a").threadID]?.searchSnippet == "Changed")
        #expect(present([match("a")], environments: ["b"]).searchResults.isEmpty)
        #expect(present([match("a"), match("b")], environments: ["a", "b"], projectID: match("a").projectID)
            .searchResults.map(\.id) == [match("a").threadID])
        #expect(present([], environments: ["a", "b"]).rowContexts[match("a").threadID]?.searchSnippet == nil)
    }

    @Test func selectedScopeIncludesOfflineButExcludesDisabledEnvironments() {
        var snapshot = snapshot()
        snapshot.environments[0].isEnabled = false
        snapshot.environments[1].connectionState = .disconnected
        let request = FeatureThreadSearchRequest(query: "needle", snapshot: snapshot, projectID: nil)
        #expect(request.environmentIDs == ["b"])
        #expect(!request.canSearchContent)
        snapshot.environments[1].connectionState = .connected
        let connected = FeatureThreadSearchRequest(query: "needle", snapshot: snapshot, projectID: nil)
        #expect(connected != request)
        #expect(connected.canSearchContent)
        let filtered = FeatureThreadSearchRequest(query: "needle", snapshot: snapshot, projectID: match("a").projectID)
        #expect(filtered.environmentIDs.isEmpty)
        snapshot.environments[1].connectionState = nil
        let unknown = FeatureThreadSearchRequest(query: "needle", snapshot: snapshot, projectID: nil)
        #expect(!unknown.canSearchContent)
        #expect(unknown != connected)
    }

    @Test func invalidQueriesDoNotReachTheClient() async {
        let client = SearchProbe()
        let search = FeatureThreadContentSearch(debounce: {})
        for query in ["", " a ", String(repeating: "a", count: 201)] {
            let request = FeatureThreadSearchRequest(query: query, environmentIDs: ["a"])
            await search.search(request, using: client)
            #expect(search.matches(for: request).isEmpty)
            #expect(!search.isSearching)
        }
        #expect(client.startedCount == 0)
        #expect(FeatureThreadSearchRequest(query: " aa ", environmentIDs: ["b", "a", "a"])
            == FeatureThreadSearchRequest(query: "aa", environmentIDs: ["a", "b"]))
    }

    @Test func olderResponseCannotReplaceANewerGenerationOfTheSameQuery() async throws {
        let client = SearchProbe()
        var calls = client.calls.makeAsyncIterator()
        let search = FeatureThreadContentSearch(debounce: {})
        let request = FeatureThreadSearchRequest(query: "needle", environmentIDs: ["a"])
        let old = Task { await search.search(request, using: client) }
        let oldCall = try #require(await calls.next())
        let changed = FeatureThreadSearchRequest(query: "different", environmentIDs: ["b"])
        #expect(search.matches(for: changed).isEmpty)
        await search.search(changed, using: nil)
        let current = Task { await search.search(request, using: client) }
        let currentCall = try #require(await calls.next())
        client.finish(currentCall, matches: [match("a", snippet: "Current"), match("b")])
        await current.value
        client.finish(oldCall, matches: [match("a", snippet: "Stale")])
        await old.value
        #expect(search.matches(for: request).map(\.snippet) == ["Current"])
    }

    @Test func cancellationAndUnsupportedServersLeaveLocalSearchAvailable() async throws {
        let client = SearchProbe()
        var calls = client.calls.makeAsyncIterator()
        let search = FeatureThreadContentSearch(debounce: {})
        let request = FeatureThreadSearchRequest(query: "needle", environmentIDs: ["a"])
        let cancelled = Task { await search.search(request, using: client) }
        let call = try #require(await calls.next())
        cancelled.cancel()
        client.finish(call, matches: [match("a")])
        await cancelled.value
        #expect(search.matches(for: request).isEmpty)
        let failed = Task { await search.search(request, using: client) }
        client.fail(try #require(await calls.next()))
        await failed.value
        #expect(search.matches(for: request).isEmpty)
        #expect(!search.isSearching)
        var snapshot = snapshot()
        snapshot.threads[0].title = "A needle"
        let presentation = HomePresentation(
            snapshot: snapshot, query: request.query, projectID: nil, now: .now,
            contentMatches: search.matches(for: request)
        )
        #expect(presentation.searchResults.map(\.id) == [match("a").threadID])
    }

    @Test func supersededDebounceDoesNotStartAnRPC() async throws {
        let gate = SearchDebounceGate()
        var waits = gate.waits.makeAsyncIterator()
        let client = SearchProbe()
        var calls = client.calls.makeAsyncIterator()
        let search = FeatureThreadContentSearch(debounce: { await gate.wait() })
        let old = Task { await search.search(.init(query: "old", environmentIDs: ["a"]), using: client) }
        let firstWait = try #require(await waits.next())
        let current = Task { await search.search(.init(query: "new", environmentIDs: ["a"]), using: client) }
        let nextWait = try #require(await waits.next())
        gate.resume(firstWait)
        await old.value
        #expect(client.startedCount == 0)
        gate.resume(nextWait)
        let call = try #require(await calls.next())
        #expect(call.query == "new")
        client.finish(call, matches: [])
        await current.value
    }

    @Test func fanoutIsBoundedAndOneFailureKeepsOtherServerMatches() async throws {
        let client = SearchProbe()
        var calls = client.calls.makeAsyncIterator()
        let task = Task {
            await FeatureThreadSearchFanout.search(environmentIDs: ["a", "b", "c", "d", "d"]) { id in
                try await client.searchThreadContent(query: "needle", environmentIDs: [id])
            }
        }
        var initial: [SearchProbe.Call] = []
        for _ in 0..<3 { initial.append(try #require(await calls.next())) }
        #expect(client.startedCount == 3)
        #expect(client.inFlight == 3)
        client.fail(initial[0])
        let last = try #require(await calls.next())
        #expect(last.environmentIDs == ["d"])
        #expect(client.maximumInFlight == 3)
        for call in initial.dropFirst() { client.finish(call, matches: [match(call.environmentIDs[0])]) }
        client.finish(last, matches: [match("d")])
        let matches = await task.value
        #expect(matches.count == 3)
        #expect(!matches.contains { $0.environmentID == initial[0].environmentIDs[0] })
        #expect(client.startedCount == 4)
    }

    @Test func cancelledFanoutDoesNotStartQueuedEnvironments() async throws {
        let client = SearchProbe()
        var calls = client.calls.makeAsyncIterator()
        let task = Task {
            await FeatureThreadSearchFanout.search(environmentIDs: ["a", "b", "c", "d"]) { id in
                try await client.searchThreadContent(query: "needle", environmentIDs: [id])
            }
        }
        var initial: [SearchProbe.Call] = []
        for _ in 0..<3 { initial.append(try #require(await calls.next())) }
        task.cancel()
        for call in initial { client.finish(call, matches: [match(call.environmentIDs[0])]) }
        #expect(await task.value == [])
        #expect(client.startedCount == 3)
    }
}

@MainActor
private final class SearchProbe: FeatureThreadContentSearching {
    struct Call: Sendable {
        let id: Int
        let query: String
        let environmentIDs: [String]
    }
    private enum Failure: Error { case unsupported }
    let calls: AsyncStream<Call>
    private let continuation: AsyncStream<Call>.Continuation
    private var pending: [Int: CheckedContinuation<[FeatureThreadContentMatch], any Error>] = [:]
    private(set) var startedCount = 0
    private(set) var maximumInFlight = 0
    var inFlight: Int { pending.count }

    init() {
        let stream = AsyncStream<Call>.makeStream()
        calls = stream.stream
        continuation = stream.continuation
    }

    func searchThreadContent(query: String, environmentIDs: [String]) async throws -> [FeatureThreadContentMatch] {
        startedCount += 1
        let call = Call(id: startedCount, query: query, environmentIDs: environmentIDs)
        return try await withCheckedThrowingContinuation {
            pending[call.id] = $0
            maximumInFlight = max(maximumInFlight, inFlight)
            continuation.yield(call)
        }
    }

    func finish(_ call: Call, matches: [FeatureThreadContentMatch]) {
        pending.removeValue(forKey: call.id)?.resume(returning: matches)
    }

    func fail(_ call: Call) {
        pending.removeValue(forKey: call.id)?.resume(throwing: Failure.unsupported)
    }
}

@MainActor
private final class SearchDebounceGate {
    let waits: AsyncStream<Int>
    private let continuation: AsyncStream<Int>.Continuation
    private var pending: [Int: CheckedContinuation<Void, Never>] = [:]
    private var nextID = 0

    init() {
        let stream = AsyncStream<Int>.makeStream()
        waits = stream.stream
        continuation = stream.continuation
    }

    func wait() async {
        nextID += 1
        let id = nextID
        await withCheckedContinuation {
            pending[id] = $0
            continuation.yield(id)
        }
    }

    func resume(_ id: Int) { pending.removeValue(forKey: id)?.resume() }
}
