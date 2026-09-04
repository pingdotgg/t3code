import XCTest
@testable import T3Code

@MainActor
final class T3ClientServerConfigTests: XCTestCase {
    func testBootstrapAndListenerShareSubscriptionThenReplayFoldedCatalog() async throws {
        let connection = ServerConfigTestConnection(mode: .snapshot)
        let client = makeClient(connection: connection)
        let events = await client.serverConfigEvents()
        async let bootstrap = client.serverConfig()
        var iterator = events.makeAsyncIterator()

        guard case let .snapshot(first)? = try await iterator.next() else {
            return XCTFail("Expected the subscription snapshot.")
        }
        XCTAssertEqual(first.threadSnapshotPagination, true)
        let bootstrapped = try await bootstrap
        XCTAssertEqual(bootstrapped.providers.first?.instanceId, "codex-old")
        let initialTags = await connection.tags()
        XCTAssertEqual(initialTags, ["subscribeServerConfig"])

        try await connection.pushProviderStatus(id: "codex-new")
        guard case .providerStatuses? = try await iterator.next() else {
            return XCTFail("Expected the provider status delta.")
        }
        let folded = try await client.serverConfig()
        XCTAssertEqual(folded.providers.first?.instanceId, "codex-new")
        XCTAssertEqual(folded.settings?.newWorktreesStartFromOrigin, false)
        XCTAssertEqual(folded.threadSnapshotPagination, true)
        XCTAssertEqual(folded.threadResumeCompletionMarker, true)
        XCTAssertEqual(folded.environment?.environmentId, "environment-1")

        let replay = await client.serverConfigEvents()
        var replayIterator = replay.makeAsyncIterator()
        guard case let .snapshot(replayed)? = try await replayIterator.next() else {
            return XCTFail("Expected a cached snapshot replay.")
        }
        XCTAssertEqual(replayed, folded)
        let replayTags = await connection.tags()
        XCTAssertEqual(replayTags, ["subscribeServerConfig"])
        await client.disconnect()
    }

    func testDisconnectCancelsPendingBootstrapAndRejectsStaleStreamCallbacks() async throws {
        let connection = ServerConfigTestConnection(mode: .silent)
        let client = makeClient(connection: connection)
        let pending = Task { try await client.serverConfig() }
        await connection.waitForRequestCount(1)
        await client.disconnect()

        do {
            _ = try await pending.value
            XCTFail("Disconnect must finish the pending bootstrap.")
        } catch let error as RPCError {
            guard case .disconnected = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
        try await connection.pushSnapshot(id: "stale")
        let tags = await connection.tags()
        XCTAssertEqual(tags, ["subscribeServerConfig"])
    }

    func testSilentSubscriptionBootstrapTimesOutAndCancellationDoesNotLeaveAWaiter() async {
        let connection = ServerConfigTestConnection(mode: .silent)
        let client = makeClient(connection: connection, waitTimeout: .milliseconds(20))
        let cancelled = Task { try await client.serverConfig() }
        await connection.waitForRequestCount(1)
        cancelled.cancel()
        do {
            _ = try await cancelled.value
            XCTFail("Cancellation must finish the bootstrap wait.")
        } catch is CancellationError {
        } catch {
            XCTFail("Unexpected cancellation error: \(error)")
        }

        do {
            _ = try await client.serverConfig()
            XCTFail("A silent config subscription must have a bounded wait.")
        } catch let error as RPCError {
            guard case .responseTimedOut = error else {
                await client.disconnect()
                return XCTFail("Unexpected error: \(error)")
            }
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
        await client.disconnect()
    }

    func testOnlyExplicitUnsupportedMethodFallsBackToUnaryConfig() async throws {
        let unsupported = ServerConfigTestConnection(
            mode: .failure("Unsupported method subscribeServerConfig")
        )
        let legacyClient = makeClient(connection: unsupported)
        let legacyConfig = try await legacyClient.serverConfig()
        XCTAssertEqual(legacyConfig.providers.first?.instanceId, "codex-old")
        let unsupportedTags = await unsupported.tags()
        XCTAssertEqual(unsupportedTags, ["subscribeServerConfig", "server.getConfig"])
        await legacyClient.disconnect()

        let auth = ServerConfigTestConnection(
            mode: .failure("Unsupported authentication scheme for subscribeServerConfig")
        )
        let authClient = makeClient(connection: auth)
        do {
            _ = try await authClient.serverConfig()
            XCTFail("Authentication errors must not use the legacy config fallback.")
        } catch let error as RPCError {
            guard case .remote = error else { return XCTFail("Unexpected error: \(error)") }
        }
        let authTags = await auth.tags()
        XCTAssertEqual(authTags, ["subscribeServerConfig"])
        await authClient.disconnect()
    }

    private func makeClient(
        connection: ServerConfigTestConnection,
        waitTimeout: Duration = .seconds(4)
    ) -> T3Client {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        return T3Client(
            environment: environment,
            credentialStore: InMemoryCredentialStore(credentials: [
                environment.id: EnvironmentCredential(accessToken: "token"),
            ]),
            httpTransport: ServerConfigTicketTransport(),
            webSocketConnector: ServerConfigTestConnector(connection: connection),
            rpcConnectionWaitTimeout: waitTimeout
        )
    }
}

private struct ServerConfigTicketTransport: HTTPTransport {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let data = Data(#"{"ticket":"ticket","expiresAt":"2026-09-01T12:05:00.000Z"}"#.utf8)
        return (data, HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!)
    }
}

private struct ServerConfigTestConnector: WebSocketConnecting {
    let connection: ServerConfigTestConnection
    func connect(to _: URL) async throws -> any WebSocketConnection { connection }
}

private actor ServerConfigTestConnection: WebSocketConnection {
    enum Mode { case snapshot, silent, failure(String) }

    private let mode: Mode
    private var requestTags: [String] = []
    private var subscriptionRequestID: Int?
    private var responses: [Data] = []
    private var receiver: CheckedContinuation<Data, any Error>?
    private var requestWaiters: [CheckedContinuation<Void, Never>] = []

    init(mode: Mode) { self.mode = mode }

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard let tag = request["tag"]?.stringValue,
              case let .number(rawID) = request["id"] else { return }
        let id = Int(rawID)
        requestTags.append(tag)
        requestWaiters.forEach { $0.resume() }
        requestWaiters.removeAll()
        switch tag {
        case "subscribeServerConfig":
            subscriptionRequestID = id
            switch mode {
            case .snapshot: try enqueue(chunk(id: id, value: snapshot(id: "codex-old")))
            case .silent: break
            case let .failure(message): try enqueue(failure(id: id, message: message))
            }
        case "server.getConfig":
            try enqueue(success(id: id, value: config(id: "codex-old")))
        default: break
        }
    }

    func receive() async throws -> Data {
        if !responses.isEmpty { return responses.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func close() {
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }

    func tags() -> [String] { requestTags }

    func waitForRequestCount(_ count: Int) async {
        if requestTags.count >= count { return }
        await withCheckedContinuation { requestWaiters.append($0) }
    }

    func pushProviderStatus(id: String) throws {
        guard let subscriptionRequestID else { return }
        try enqueue(chunk(id: subscriptionRequestID, value: .object([
            "type": .string("providerStatuses"),
            "payload": .object(["providers": .array([provider(id: id)])]),
        ])))
    }

    func pushSnapshot(id: String) throws {
        guard let subscriptionRequestID else { return }
        try enqueue(chunk(id: subscriptionRequestID, value: snapshot(id: id)))
    }

    private func snapshot(id: String) -> JSONValue {
        .object(["type": .string("snapshot"), "config": config(id: id)])
    }

    private func config(id: String) -> JSONValue {
        .object([
            "providers": .array([provider(id: id)]),
            "settings": .object([
                "defaultThreadEnvMode": .string("worktree"),
                "newWorktreesStartFromOrigin": .bool(false),
            ]),
            "threadSnapshotPagination": .bool(true),
            "threadResumeCompletionMarker": .bool(true),
            "environment": .object([
                "environmentId": .string("environment-1"),
                "label": .string("Studio"),
                "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
                "serverVersion": .string("1.0.0"),
                "capabilities": .object([:]),
            ]),
        ])
    }

    private func provider(id: String) -> JSONValue {
        .object([
            "instanceId": .string(id), "driver": .string("codex"),
            "enabled": .bool(true), "installed": .bool(true), "status": .string("ready"),
            "auth": .object(["status": .string("authenticated")]),
            "checkedAt": .string("2026-09-01T12:00:00.000Z"), "models": .array([]),
        ])
    }

    private func chunk(id: Int, value: JSONValue) throws -> Data {
        try JSONEncoder.t3.encode(JSONValue.object([
            "_tag": .string("Chunk"), "requestId": .number(Double(id)), "values": .array([value]),
        ]))
    }

    private func success(id: Int, value: JSONValue) throws -> Data {
        try JSONEncoder.t3.encode(JSONValue.object([
            "_tag": .string("Exit"), "requestId": .number(Double(id)),
            "exit": .object(["_tag": .string("Success"), "value": value]),
        ]))
    }

    private func failure(id: Int, message: String) throws -> Data {
        try JSONEncoder.t3.encode(JSONValue.object([
            "_tag": .string("Exit"), "requestId": .number(Double(id)),
            "exit": .object([
                "_tag": .string("Failure"),
                "cause": .array([.object([
                    "_tag": .string("Fail"), "error": .object(["message": .string(message)]),
                ])]),
            ]),
        ]))
    }

    private func enqueue(_ data: Data) {
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            responses.append(data)
        }
    }
}
