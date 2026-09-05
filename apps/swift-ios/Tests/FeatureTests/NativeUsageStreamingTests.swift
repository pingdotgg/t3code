import Foundation
import XCTest
@testable import T3Code

@MainActor
final class NativeUsageStreamingTests: XCTestCase {
    func testFastUsageAppearsWhileAnotherComputerIsPendingAndSurvivesItsFailure() async throws {
        let fixture = try await UsageStreamingFixture.make()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        var requests = fixture.connector.requests.makeAsyncIterator()
        var updates = fixture.client.usageSummaryUpdates(
            UsageSummaryInput(sinceDay: "2026-09-01", untilDay: "2026-09-05", timeZone: "UTC"),
            refreshPricing: false
        ).makeAsyncIterator()

        let initial = try await updates.next()
        XCTAssertEqual(initial?.map(\.environmentID), ["fast", "slow"])
        XCTAssertTrue(initial?.allSatisfy(\.isPending) == true)
        let firstRequest = await requests.next()
        let first = try XCTUnwrap(firstRequest)
        let secondRequest = await requests.next()
        let second = try XCTUnwrap(secondRequest)
        let fast = first.host == "fast.example" ? first : second
        let slow = first.host == "slow.example" ? first : second
        XCTAssertEqual(fast.tag, "server.getUsageSummary")
        XCTAssertEqual(slow.tag, "server.getUsageSummary")

        try await fast.succeed(.object([
            "contractVersion": .number(5),
            "readAt": .string("2026-09-05T12:00:00.000Z"),
            "timeZone": .string("UTC"),
            "sinceDay": .string("2026-09-01"),
            "untilDay": .string("2026-09-05"),
            "buckets": .array([]), "sources": .array([]),
            "pricing": .object([
                "status": .string("fresh"), "source": .string("LiteLLM"),
                "knownModels": .number(1),
            ]),
            "scanDurationMs": .number(1),
        ]))
        let partial = try await updates.next()
        XCTAssertNotNil(partial?.first?.summary)
        XCTAssertEqual(partial?.first?.isPending, false)
        XCTAssertEqual(partial?.last?.isPending, true)

        try await slow.fail("The computer is offline.")
        let final = try await updates.next()
        XCTAssertNotNil(final?.first?.summary)
        XCTAssertNotNil(final?.last?.errorMessage)
        XCTAssertTrue(final?.allSatisfy { !$0.isPending } == true)
        let completed = try await updates.next()
        XCTAssertNil(completed)
    }

    func testCreditRedemptionUsesTheChosenComputerEvenWithSharedProviderIDs() async throws {
        let fixture = try await UsageStreamingFixture.make()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        var requests = fixture.connector.requests.makeAsyncIterator()
        let redemption = Task {
            try await fixture.client.consumeResetCredit(environmentID: "slow", instanceID: "codex")
        }
        let nextRequest = await requests.next()
        let request = try XCTUnwrap(nextRequest)
        XCTAssertEqual(request.host, "slow.example")
        XCTAssertEqual(request.tag, "provider.consumeResetCredit")
        XCTAssertEqual(request.payload, .object(["instanceId": .string("codex")]))
        try await request.succeed(.object(["outcome": .string("alreadyRedeemed")]))
        let result = try await redemption.value
        XCTAssertEqual(result.outcome, .alreadyRedeemed)
        await fixture.client.disconnect()
        await fixture.connector.closeConnections()
    }
}

private struct UsageStreamingFixture {
    let directory: URL
    let client: NativeFeatureClient
    let connector: UsageStreamingConnector

    @MainActor
    static func make() async throws -> Self {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-usage-stream-\(UUID().uuidString)", isDirectory: true)
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        let environments = ["fast", "slow"].map { id in
            Environment(
                id: id, label: id,
                httpBaseURL: URL(string: "https://\(id).example")!,
                webSocketBaseURL: URL(string: "wss://\(id).example")!
            )
        }
        try await store.save(environments)
        let connector = UsageStreamingConnector()
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(credentials: [
                "fast": EnvironmentCredential(accessToken: "test-fast"),
                "slow": EnvironmentCredential(accessToken: "test-slow"),
            ]),
            httpTransport: UsageStreamingHTTPTransport(),
            webSocketConnector: connector
        )
        return Self(directory: directory, client: NativeFeatureClient(runtime: runtime), connector: connector)
    }
}

private struct UsageStreamingHTTPTransport: HTTPTransport {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard let url = request.url, url.path == "/api/auth/websocket-ticket" else {
            throw URLError(.unsupportedURL)
        }
        let data = try JSONEncoder.t3.encode(JSONValue.object([
            "ticket": .string("test-ticket"),
            "expiresAt": .string("2026-09-05T23:59:00.000Z"),
        ]))
        return (data, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

private struct UsageStreamingRequest: Sendable {
    let host: String
    let tag: String
    let payload: JSONValue
    let id: Int
    let connection: UsageStreamingConnection

    func succeed(_ value: JSONValue) async throws {
        try await connection.deliver(.object([
            "_tag": .string("Exit"), "requestId": .number(Double(id)),
            "exit": .object(["_tag": .string("Success"), "value": value]),
        ]))
    }

    func fail(_ message: String) async throws {
        try await connection.deliver(.object([
            "_tag": .string("Exit"), "requestId": .number(Double(id)),
            "exit": .object([
                "_tag": .string("Failure"),
                "cause": .array([.object([
                    "_tag": .string("Fail"), "error": .object(["message": .string(message)]),
                ])]),
            ]),
        ]))
    }
}

private actor UsageStreamingConnector: WebSocketConnecting {
    nonisolated let requests: AsyncStream<UsageStreamingRequest>
    private let continuation: AsyncStream<UsageStreamingRequest>.Continuation
    private var connections: [UsageStreamingConnection] = []

    init() {
        let pair = AsyncStream<UsageStreamingRequest>.makeStream()
        requests = pair.stream
        continuation = pair.continuation
    }

    func connect(to url: URL) -> any WebSocketConnection {
        let connection = UsageStreamingConnection(host: url.host ?? "", continuation: continuation)
        connections.append(connection)
        return connection
    }

    func closeConnections() async {
        for connection in connections { await connection.close() }
        continuation.finish()
    }
}

private actor UsageStreamingConnection: WebSocketConnection {
    private let host: String
    private let continuation: AsyncStream<UsageStreamingRequest>.Continuation
    private var responses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?
    private var closed = false

    init(host: String, continuation: AsyncStream<UsageStreamingRequest>.Continuation) {
        self.host = host
        self.continuation = continuation
    }

    func send(_ data: Data) throws {
        guard !closed else { throw RPCError.disconnected }
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard request["_tag"]?.stringValue == "Request",
              let tag = request["tag"]?.stringValue,
              case let .number(id)? = request["id"] else { return }
        continuation.yield(UsageStreamingRequest(
            host: host, tag: tag, payload: request["payload"] ?? .object([:]),
            id: Int(id), connection: self
        ))
    }

    func receive() async throws -> Data {
        guard !closed else { throw RPCError.disconnected }
        if !responses.isEmpty { return responses.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func deliver(_ value: JSONValue) throws {
        let data = try JSONEncoder.t3.encode(value)
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            responses.append(data)
        }
    }

    func close() {
        closed = true
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }
}
