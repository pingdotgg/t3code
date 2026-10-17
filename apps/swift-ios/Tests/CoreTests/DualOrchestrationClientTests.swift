import Foundation
import XCTest
@testable import T3Code

@MainActor
final class V2OrchestrationClientTests: XCTestCase {
    func testRepeatedPassiveReadsReuseDiscoveryAndSendV2Headers() async throws {
        let transport = try V2ClientHTTPTransport()
        let client = makeClient(transport: transport)
        for _ in 0..<3 {
            let snapshot = try await client.shellSnapshot()
            XCTAssertEqual(snapshot.orchestrationProtocolVersion, 2)
            XCTAssertEqual(snapshot.threads.first?.id, "thread-v2")
        }
        let requests = await transport.requests
        XCTAssertEqual(requests.filter { $0.url?.path == "/.well-known/t3/environment" }.count, 1)
        let reads = requests.filter { $0.url?.path == "/api/orchestration/shell" }
        XCTAssertEqual(reads.count, 3)
        XCTAssertTrue(reads.allSatisfy { $0.value(forHTTPHeaderField: "x-t3-orchestration-protocol") == "2" })
        XCTAssertTrue(reads.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token" })
    }

    func testUnsupportedDescriptorsBlockBeforeReadingCredentials() async throws {
        for version in [nil, 1, 3] as [Int?] {
            let transport = try V2ClientHTTPTransport(version: version)
            let credentials = V2ClientCredentialSpy()
            let client = T3Client(environment: environment, credentialStore: credentials, httpTransport: transport)
            do {
                _ = try await client.shellSnapshot()
                XCTFail("An incompatible descriptor must block the read")
            } catch let error as OrchestrationProtocolError {
                XCTAssertEqual(error, (version ?? 0) < 2 ? .hostUpdateRequired : .unsupportedServerVersion(version!))
            }
            let reads = await credentials.reads
            XCTAssertEqual(reads, 0)
            let requests = await transport.requests
            XCTAssertEqual(requests.map { $0.url?.path }, ["/.well-known/t3/environment"])
            XCTAssertNil(requests.first?.value(forHTTPHeaderField: "Authorization"))
        }
    }

    func testFailedRediscoveryCannotReuseCachedDescriptorAndCanRecover() async throws {
        let transport = try V2ClientHTTPTransport()
        let connection = OrchestrationConnection(environment: environment,
            api: EnvironmentAPI(transport: transport, credentials: InMemoryCredentialStore()))
        let first = try await connection.descriptor()
        await transport.setVersion(1)
        for refresh in [true, false] {
            do {
                _ = try await connection.descriptor(refresh: refresh)
                XCTFail("Old hosts must not reuse a cached V2 descriptor")
            } catch let error as OrchestrationProtocolError {
                XCTAssertEqual(error, .hostUpdateRequired)
            }
        }
        await transport.setVersion(2)
        let recovered = try await connection.descriptor()
        XCTAssertEqual(recovered, first)
    }

    func testNewConnectionRevalidatesInsteadOfTrustingSavedDescriptor() async throws {
        let transport = try V2ClientHTTPTransport()
        let first = OrchestrationConnection(environment: environment,
            api: EnvironmentAPI(transport: transport, credentials: InMemoryCredentialStore()))
        var saved = environment
        saved.descriptor = try await first.descriptor()
        await transport.setVersion(1)
        let reconnected = OrchestrationConnection(environment: saved,
            api: EnvironmentAPI(transport: transport, credentials: InMemoryCredentialStore()))
        do {
            _ = try await reconnected.descriptor()
            XCTFail("A saved descriptor must not bypass fresh discovery")
        } catch let error as OrchestrationProtocolError {
            XCTAssertEqual(error, .hostUpdateRequired)
        }
    }

    func testV2HistoryUsesOpaqueCursorAndRetainsCurrentProjection() async throws {
        let transport = try V2ClientHTTPTransport()
        let client = makeClient(transport: transport)
        let first = try await client.threadSnapshot(id: "thread-v2")
        XCTAssertEqual(first.orchestrationProtocolVersion, 2)
        XCTAssertTrue(first.page?.hasMore == true)
        let cursor = try XCTUnwrap(first.page?.beforeCursor)
        let expanded = try await client.threadSnapshot(id: "thread-v2", beforeCursor: cursor)
        XCTAssertFalse(expanded.page?.hasMore ?? true)
        XCTAssertEqual(expanded.snapshotSequence, first.snapshotSequence)
        XCTAssertGreaterThan(expanded.thread.messages.count, first.thread.messages.count)
        let requests = await transport.requests
        let history = try XCTUnwrap(requests.last)
        XCTAssertEqual(history.url?.path, "/api/orchestration/threads/thread-v2/history")
        XCTAssertEqual(URLComponents(url: history.url!, resolvingAgainstBaseURL: false)?.queryItems,
                       [URLQueryItem(name: "cursor", value: cursor)])
        XCTAssertEqual(history.value(forHTTPHeaderField: "x-t3-orchestration-protocol"), "2")
    }

    func testV2ConnectionSendsCanonicalLaunchCommand() async throws {
        let transport = try V2ClientHTTPTransport()
        let socket = V2ClientCommandSocket()
        let client = T3Client(environment: environment,
            credentialStore: InMemoryCredentialStore(credentials: [environment.id: .init(accessToken: "fixture-token")]),
            httpTransport: transport, webSocketConnector: V2ClientConnector(socket: socket))
        _ = try await client.createThreadAndSend(threadID: "new-thread", projectID: "project-v2",
            title: "New task", text: "Start here", model: .init(instanceId: "codex", model: "gpt-5.4"),
            runtimeMode: .fullAccess, commandID: "stable-command", messageID: "stable-message")
        let commands = await socket.commands
        XCTAssertEqual(commands.count, 1)
        XCTAssertEqual(commands.first?["tag"], .string("orchestration.launchThread"))
        XCTAssertEqual(commands.first?["payload"]?["threadId"], .string("new-thread"))
        XCTAssertEqual(commands.first?["payload"]?["initialMessage"]?["messageId"], .string("stable-message"))
        let urls = await socket.urls
        let query = URLComponents(url: try XCTUnwrap(urls.first), resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(query?.first { $0.name == "orchestrationProtocol" }?.value, "2")
        await client.disconnect()
    }

    private var environment: Environment {
        Environment(id: "v2.example", label: "V2 host", httpBaseURL: URL(string: "https://v2.example")!,
                    webSocketBaseURL: URL(string: "wss://v2.example/ws")!)
    }

    private func makeClient(transport: V2ClientHTTPTransport) -> T3Client {
        T3Client(environment: environment,
                 credentialStore: InMemoryCredentialStore(credentials: [environment.id: .init(accessToken: "fixture-token")]),
                 httpTransport: transport)
    }
}

private actor V2ClientHTTPTransport: HTTPTransport {
    private(set) var requests: [URLRequest] = []
    private var version: Int?
    private let fixtures: [String: Data]

    init(version: Int? = 2) throws {
        self.version = version
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Fixtures/Wire")
        fixtures = try Dictionary(uniqueKeysWithValues: [
            "v2-shell-snapshot", "v2-thread-bounded-snapshot", "v2-thread-older-history",
        ].map { ($0, try Data(contentsOf: directory.appendingPathComponent($0 + ".json"))) })
    }

    func setVersion(_ version: Int?) { self.version = version }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let url = try XCTUnwrap(request.url)
        let body: Data
        switch url.path {
        case "/.well-known/t3/environment":
            var value: [String: JSONValue] = [
                "environmentId": .string("v2.example"), "label": .string("V2 host"),
                "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
                "serverVersion": .string("fixture"), "capabilities": .object([:]),
            ]
            if let version { value["orchestrationProtocolVersion"] = .number(Double(version)) }
            body = try JSONEncoder.t3.encode(JSONValue.object(value))
        case "/api/auth/websocket-ticket":
            body = Data(#"{"ticket":"fixture","expiresAt":"2099-01-01T00:00:00Z"}"#.utf8)
        case "/api/orchestration/shell": body = fixtures["v2-shell-snapshot"]!
        case "/api/orchestration/threads/thread-v2/bounded": body = fixtures["v2-thread-bounded-snapshot"]!
        case "/api/orchestration/threads/thread-v2/history": body = fixtures["v2-thread-older-history"]!
        default: throw URLError(.unsupportedURL)
        }
        return (body, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

private actor V2ClientCredentialSpy: CredentialStore {
    private(set) var reads = 0
    func credential(for environmentID: String) -> EnvironmentCredential? { reads += 1; return .init(accessToken: "fixture") }
    func setCredential(_ credential: EnvironmentCredential, for environmentID: String) {}
    func removeCredential(for environmentID: String) {}
    func swapCredential(_ credential: EnvironmentCredential, for environmentID: String) -> EnvironmentCredential? { nil }
    func replaceCredential(_ credential: EnvironmentCredential, ifMatching expected: EnvironmentCredential?, for environmentID: String) -> Bool { false }
    func removeCredential(ifMatching expected: EnvironmentCredential, for environmentID: String) -> Bool { false }
}


private struct V2ClientConnector: WebSocketConnecting {
    let socket: V2ClientCommandSocket
    func connect(to url: URL) async -> any WebSocketConnection { await socket.record(url); return socket }
}

private actor V2ClientCommandSocket: WebSocketConnection {
    private(set) var commands: [JSONValue] = []
    private(set) var urls: [URL] = []
    private var pending: [Data] = []
    private var receiver: CheckedContinuation<Data, any Error>?
    func record(_ url: URL) { urls.append(url) }
    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard let id = request["id"], request["tag"]?.stringValue == "orchestration.launchThread" else { return }
        commands.append(request)
        let response = try JSONEncoder.t3.encode(JSONValue.object([
            "_tag": .string("Exit"), "requestId": id,
            "exit": .object(["_tag": .string("Success"), "value": v2LaunchFixture(request["payload"]!)]),
        ]))
        if let receiver { self.receiver = nil; receiver.resume(returning: response) }
        else { pending.append(response) }
    }
    func receive() async throws -> Data {
        if !pending.isEmpty { return pending.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }
    func close() { receiver?.resume(throwing: CancellationError()); receiver = nil }
}
