import Foundation
import XCTest
@testable import T3Code

@MainActor
final class DualOrchestrationClientTests: XCTestCase {
    func testRepeatedPassiveReadsReuseDiscovery() async throws {
        let transport = try DualProtocolHTTPTransport()
        let client = makeClient(host: "v2.example", transport: transport)
        for _ in 0..<3 { _ = try await client.shellSnapshot() }
        let requests = await transport.requests
        XCTAssertEqual(requests.filter { $0.url?.path == "/.well-known/t3/environment" }.count, 1)
        XCTAssertEqual(requests.filter { $0.url?.path == "/api/orchestration/shell" }.count, 3)
    }

    func testSocketBindingTracksHandshakeGenerationAcrossRediscovery() async throws {
        let transport = try DualProtocolHTTPTransport()
        let connection = OrchestrationConnection(environment: environment(host: "v1.example"),
            api: EnvironmentAPI(transport: transport, credentials: InMemoryCredentialStore()))
        let first = try await connection.selection()
        try await connection.bindSocket(to: first)
        await transport.setVersion(2, host: "v1.example")
        let next = try await connection.selection(maximumAge: .zero)
        let oldSocket = await connection.socketGeneration
        XCTAssertNotEqual(oldSocket, next.generation)
        try await connection.bindSocket(to: next)
        let newSocket = await connection.socketGeneration
        XCTAssertEqual(newSocket, next.generation)
    }

    func testMixedServersUseIndependentProtocolsAndHTTPHeaders() async throws {
        let transport = try DualProtocolHTTPTransport()
        let v1 = makeClient(host: "v1.example", transport: transport)
        let v2 = makeClient(host: "v2.example", transport: transport)
        let old = try await v1.shellSnapshot()
        let new = try await v2.shellSnapshot()
        XCTAssertEqual(old.threads.first?.id, "thread-fixture")
        XCTAssertEqual(new.threads.first?.id, "thread-v2")
        XCTAssertNil(old.orchestrationProtocolVersion)
        XCTAssertEqual(new.orchestrationProtocolVersion, 2)
        let reads = await transport.requests.filter { $0.url?.path == "/api/orchestration/shell" }
        XCTAssertNil(reads.first?.value(forHTTPHeaderField: "x-t3-orchestration-protocol"))
        XCTAssertEqual(reads.last?.value(forHTTPHeaderField: "x-t3-orchestration-protocol"), "2")
        XCTAssertEqual(reads.last?.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-token")
    }

    func testServerUpgradeReplacesLegacySequenceWithV2Sequence() async throws {
        let transport = try DualProtocolHTTPTransport()
        let client = makeClient(host: "v1.example", transport: transport)
        let old = try await client.shellSnapshot()
        XCTAssertEqual(old.threads.first?.id, "thread-fixture")
        await transport.setVersion(2, host: "v1.example")
        let new = try await client.shellSnapshot()
        XCTAssertEqual(new.orchestrationProtocolVersion, 2)
        XCTAssertEqual(new.threads.first?.id, "thread-v2")
        await transport.setVersion(1, host: "v1.example")
        let restored = try await client.shellSnapshot()
        XCTAssertEqual(restored.threads.first?.id, "thread-fixture")
        XCTAssertNil(restored.orchestrationProtocolVersion)
    }

    func testForcedMismatchNeverReadsOrDispatchesLegacyData() async throws {
        let transport = try DualProtocolHTTPTransport()
        let client = makeClient(host: "v2.example", transport: transport, preference: .v1)
        do {
            _ = try await client.shellSnapshot()
            XCTFail("A forced mismatch must fail before reading orchestration data")
        } catch let error as OrchestrationProtocolError {
            XCTAssertEqual(error, .preferenceMismatch(preference: .v1, serverVersion: .v2))
        }
        let requests = await transport.requests
        XCTAssertEqual(requests.map { $0.url!.path }, ["/.well-known/t3/environment"])
    }

    func testFailedRediscoveryDoesNotReusePreviouslySelectedProtocol() async throws {
        let transport = try DualProtocolHTTPTransport()
        let environment = environment(host: "v2.example")
        let api = EnvironmentAPI(transport: transport, credentials: InMemoryCredentialStore())
        let connection = OrchestrationConnection(environment: environment, api: api)
        let first = try await connection.selection()
        XCTAssertEqual(first.version, .v2)
        await transport.setDiscoveryFailure(true)
        do {
            _ = try await connection.selection(refresh: true)
            XCTFail("Failed discovery must propagate")
        } catch is URLError {}
        do {
            _ = try await connection.selection()
            XCTFail("A failed refresh must not unlock the old cached selection")
        } catch is URLError {}
        await transport.setDiscoveryFailure(false)
        await transport.setVersion(1, host: "v2.example")
        let next = try await connection.selection()
        XCTAssertEqual(next.version, .v1)
        XCTAssertEqual(next.generation, first.generation + 1)
    }

    func testV2HistoryUsesOpaqueCursorAndRetainsTheCurrentProjection() async throws {
        let transport = try DualProtocolHTTPTransport()
        let client = makeClient(host: "v2.example", transport: transport)
        let first = try await client.threadSnapshot(id: "thread-v2")
        XCTAssertEqual(first.orchestrationProtocolVersion, 2)
        XCTAssertTrue(first.page?.hasMore == true)
        let cursor = try XCTUnwrap(first.page?.beforeCursor)
        let expanded = try await client.threadSnapshot(id: "thread-v2", beforeCursor: cursor)
        XCTAssertFalse(expanded.page?.hasMore ?? true)
        XCTAssertEqual(expanded.snapshotSequence, first.snapshotSequence)
        XCTAssertGreaterThan(try XCTUnwrap(expanded.thread.orchestrationV2Revision),
                             try XCTUnwrap(first.thread.orchestrationV2Revision))
        XCTAssertGreaterThan(expanded.thread.messages.count, first.thread.messages.count)
        let requests = await transport.requests
        let history = try XCTUnwrap(requests.last)
        XCTAssertEqual(history.url?.path, "/api/orchestration/threads/thread-v2/history")
        XCTAssertEqual(URLComponents(url: history.url!, resolvingAgainstBaseURL: false)?.queryItems,
                       [URLQueryItem(name: "cursor", value: cursor)])
        XCTAssertEqual(history.value(forHTTPHeaderField: "x-t3-orchestration-protocol"), "2")
    }

    private func environment(host: String, preference: OrchestrationProtocolPreference = .auto) -> Environment {
        Environment(id: host, label: host, httpBaseURL: URL(string: "https://\(host)")!,
                    webSocketBaseURL: URL(string: "wss://\(host)")!,
                    orchestrationProtocolPreference: preference)
    }

    private func makeClient(
        host: String, transport: DualProtocolHTTPTransport,
        preference: OrchestrationProtocolPreference = .auto
    ) -> T3Client {
        T3Client(environment: environment(host: host, preference: preference),
                 credentialStore: InMemoryCredentialStore(credentials: [host: .init(accessToken: "fixture-token")]),
                 httpTransport: transport)
    }
}

private actor DualProtocolHTTPTransport: HTTPTransport {
    private(set) var requests: [URLRequest] = []
    private var versions = ["v1.example": 1, "v2.example": 2]
    private var discoveryFails = false
    private let fixtures: [String: Data]

    init() throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Fixtures/Wire")
        fixtures = try Dictionary(uniqueKeysWithValues: [
            "shell-snapshot", "v2-shell-snapshot", "v2-thread-bounded-snapshot", "v2-thread-older-history",
        ].map { ($0, try Data(contentsOf: directory.appendingPathComponent($0 + ".json"))) })
    }

    func setVersion(_ version: Int, host: String) { versions[host] = version }
    func setDiscoveryFailure(_ failing: Bool) { discoveryFails = failing }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let url = try XCTUnwrap(request.url)
        let version = versions[url.host ?? ""] ?? 1
        let body: Data
        switch url.path {
        case "/.well-known/t3/environment":
            if discoveryFails { throw URLError(.notConnectedToInternet) }
            var value: [String: JSONValue] = [
                "environmentId": .string(url.host!), "label": .string(url.host!),
                "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
                "serverVersion": .string("fixture"), "capabilities": .object([:]),
            ]
            if version != 1 { value["orchestrationProtocolVersion"] = .number(Double(version)) }
            body = try JSONEncoder.t3.encode(JSONValue.object(value))
        case "/api/orchestration/shell":
            if version == 2, request.value(forHTTPHeaderField: "x-t3-orchestration-protocol") != "2" {
                return (Data(#"{"message":"Missing orchestration protocol header"}"#.utf8),
                        HTTPURLResponse(url: url, statusCode: 400, httpVersion: "HTTP/1.1", headerFields: nil)!)
            }
            body = fixtures[version == 2 ? "v2-shell-snapshot" : "shell-snapshot"]!
        case "/api/orchestration/threads/thread-v2/bounded":
            body = fixtures["v2-thread-bounded-snapshot"]!
        case "/api/orchestration/threads/thread-v2/history":
            body = fixtures["v2-thread-older-history"]!
        default:
            throw URLError(.unsupportedURL)
        }
        return (body, HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!)
    }
}
