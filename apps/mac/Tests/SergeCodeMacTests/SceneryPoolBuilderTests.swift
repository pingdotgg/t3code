// SceneryPoolBuilderTests.swift
// `buildFromLocations` sits on the new-thread path (SceneryStore.start ->
// createSceneThread), so it fans its per-location searches out instead of
// running them back to back. These pin both halves of that change: the fan-out
// is real and bounded, and the resulting pool is byte-for-byte what the serial
// build produced — same order, same curated names, same dedup.

import Foundation
import Testing

@testable import SergeCodeMac

// MARK: - Stub transport

/// Overlap counters. A `let`-held box rather than `static var`s, which Swift 6
/// strict concurrency rejects as unprotected global mutable state.
private final class StubCounters: @unchecked Sendable {
    private let lock = NSLock()
    private var inFlight = 0
    private var peakInFlight = 0
    private var totalRequests = 0

    func reset() {
        lock.withLock {
            inFlight = 0
            peakInFlight = 0
            totalRequests = 0
        }
    }

    func began() {
        lock.withLock {
            inFlight += 1
            totalRequests += 1
            peakInFlight = max(peakInFlight, inFlight)
        }
    }

    func ended() {
        lock.withLock { inFlight -= 1 }
    }

    var peak: Int { lock.withLock { peakInFlight } }
    var requests: Int { lock.withLock { totalRequests } }
}

/// Serves one deterministic photo per query and records how many requests
/// overlapped. Queries containing "shared" all resolve to the same photo id so
/// the dedup path can be exercised.
private final class SceneryStubProtocol: URLProtocol, @unchecked Sendable {
    static let counters = StubCounters()

    static func reset() { counters.reset() }
    static var peakConcurrency: Int { counters.peak }
    static var requestCount: Int { counters.requests }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.counters.began()
        let query =
            URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "query" })?.value ?? ""
        // Held open briefly: a stub that answers synchronously would report a
        // peak of 1 even for a genuinely concurrent builder, so the fan-out
        // assertion would prove nothing.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self else { return }
            Self.counters.ended()
            let response = HTTPURLResponse(
                url: self.request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: Self.body(forQuery: query))
            self.client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}

    private static func body(forQuery query: String) -> Data {
        let id =
            query.lowercased().contains("shared")
            ? "photo-shared"
            : "photo-\(query.replacingOccurrences(of: " ", with: "-"))"
        let json = """
            {"results":[{
              "id":"\(id)",
              "color":"#123456",
              "urls":{
                "raw":"https://example.invalid/\(id)/raw",
                "regular":"https://example.invalid/\(id)/regular",
                "thumb":"https://example.invalid/\(id)/thumb"
              },
              "user":{"name":"Stub Photographer"}
            }]}
            """
        return Data(json.utf8)
    }
}

private func makeStubClient() -> UnsplashClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SceneryStubProtocol.self]
    return UnsplashClient(accessKey: "stub-key", session: URLSession(configuration: configuration))!
}

// MARK: - Tests

@Suite("SceneryPoolBuilder", .serialized)
struct SceneryPoolBuilderTests {
    private func locations(_ count: Int) -> [SceneryLocation] {
        (0..<count).map { SceneryLocation(name: "Place \($0)", query: "query \($0)") }
    }

    @Test("photos come back in location order under the curated names")
    func preservesLocationOrderAndNames() async throws {
        SceneryStubProtocol.reset()
        let input = locations(8)

        let result = try await SceneryPoolBuilder.buildFromLocations(
            client: makeStubClient(), locations: input)

        #expect(result.photos.map(\.name) == input.map(\.name))
        #expect(result.photos.map(\.id) == input.map { "photo-\($0.query.replacingOccurrences(of: " ", with: "-"))" })
        #expect(result.sceneNames == input.map(\.name))
    }

    @Test("searches overlap, but never more than searchConcurrency at once")
    func fansOutWithinTheConcurrencyCap() async throws {
        SceneryStubProtocol.reset()
        let input = locations(SceneryPoolBuilder.searchConcurrency * 2)

        _ = try await SceneryPoolBuilder.buildFromLocations(
            client: makeStubClient(), locations: input)

        #expect(SceneryStubProtocol.requestCount == input.count)
        #expect(SceneryStubProtocol.peakConcurrency > 1)
        #expect(SceneryStubProtocol.peakConcurrency <= SceneryPoolBuilder.searchConcurrency)
    }

    @Test("a photo shared by two locations is kept only for the earlier one")
    func dedupesAcrossLocationsInOrder() async throws {
        SceneryStubProtocol.reset()
        let input = [
            SceneryLocation(name: "First", query: "shared alpha"),
            SceneryLocation(name: "Distinct", query: "query distinct"),
            SceneryLocation(name: "Second", query: "shared beta"),
        ]

        let result = try await SceneryPoolBuilder.buildFromLocations(
            client: makeStubClient(), locations: input)

        // Completion order is nondeterministic; the surviving name is not.
        #expect(result.photos.map(\.name) == ["First", "Distinct"])
    }

    @Test("an empty query costs no request and skips its location")
    func skipsEmptyQueries() async throws {
        SceneryStubProtocol.reset()
        let input = [
            SceneryLocation(name: "Blank", query: "   "),
            SceneryLocation(name: "Real", query: "query real"),
        ]

        let result = try await SceneryPoolBuilder.buildFromLocations(
            client: makeStubClient(), locations: input)

        #expect(SceneryStubProtocol.requestCount == 1)
        #expect(result.photos.map(\.name) == ["Real"])
    }

    @Test("progress ends at the location count")
    func reportsProgressToCompletion() async throws {
        SceneryStubProtocol.reset()
        let input = locations(5)
        let observed = ProgressRecorder()

        _ = try await SceneryPoolBuilder.buildFromLocations(
            client: makeStubClient(), locations: input,
            onProgress: { completed, total in await observed.record(completed, total) })

        #expect(await observed.last?.completed == input.count)
        #expect(await observed.last?.total == input.count)
    }
}

private actor ProgressRecorder {
    private(set) var last: (completed: Int, total: Int)?

    func record(_ completed: Int, _ total: Int) {
        last = (completed, total)
    }
}
