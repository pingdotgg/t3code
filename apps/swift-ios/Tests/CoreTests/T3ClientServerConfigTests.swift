import XCTest
@testable import T3Code

@MainActor
final class T3ClientServerConfigTests: XCTestCase {
    func testUnknownUsageUnavailableReasonKeepsTheProviderInConfig() throws {
        let config = try JSONDecoder.t3.decode(ServerConfigSnapshot.self, from: Data(
            #"""
            {
              "providers": [{
                "instanceId": "codex-work", "driver": "codex",
                "enabled": true, "installed": true, "status": "ready",
                "auth": {"status": "authenticated"},
                "checkedAt": "2026-09-05T12:00:00.000Z", "models": [],
                "usageLimits": {
                  "checkedAt": "2026-09-05T12:00:00.000Z",
                  "windows": [{"id":"primary","kind":"session","label":"Session","usedPercent":25}],
                  "unavailable": {"reason":"future-reason"}
                }
              }]
            }
            """#.utf8
        ))

        XCTAssertEqual(config.providers.map(\.instanceId), ["codex-work"])
        let limits = try XCTUnwrap(config.providers.first?.usageLimits)
        XCTAssertEqual(limits.windows.map(\.id), ["primary"])
        XCTAssertNil(limits.unavailable)
    }

    func testBootstrapAndListenerShareSubscriptionThenReplayFoldedConfig() async throws {
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
        XCTAssertEqual(bootstrapped.providers.first?.usageLimits?.windows.map(\.id), ["primary"])
        XCTAssertEqual(bootstrapped.environment?.capabilities.usageLimitSources, true)
        let initialTags = await connection.tags()
        XCTAssertEqual(initialTags, ["subscribeServerConfig"])
        let subscriptionPayloads = await connection.payloads(for: "subscribeServerConfig")
        XCTAssertEqual(subscriptionPayloads, [.object(["usageLimitSources": .bool(true)])])

        try await connection.pushUsageLimitSources(ids: ["proxy"])
        guard case let .usageLimitSourcesUpdated(sources)? = try await iterator.next() else {
            return XCTFail("Expected the usage limit source update.")
        }
        XCTAssertEqual(sources.map(\.id), ["proxy"])

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
        XCTAssertEqual(folded.usageLimitSources, sources)

        try await connection.pushSettings(continueAfterUpdate: true)
        guard case .settingsUpdated? = try await iterator.next() else {
            return XCTFail("Expected the settings update.")
        }
        let updated = try await client.serverConfig()
        XCTAssertEqual(updated.settings?.continueThreadsAfterServerUpdate, true)
        XCTAssertEqual(updated.usageLimitSources, sources)

        let replay = await client.serverConfigEvents()
        var replayIterator = replay.makeAsyncIterator()
        guard case let .snapshot(replayed)? = try await replayIterator.next() else {
            return XCTFail("Expected a cached snapshot replay.")
        }
        XCTAssertEqual(replayed, updated)
        let replayTags = await connection.tags()
        XCTAssertEqual(replayTags, ["subscribeServerConfig"])
        await client.disconnect()
    }

    func testSourceUpdatesReplaceTheFullSetIncludingEmpty() async throws {
        let connection = ServerConfigTestConnection(mode: .snapshot)
        let client = makeClient(connection: connection)
        var iterator = await client.serverConfigEvents().makeAsyncIterator()
        _ = try await iterator.next()

        try await connection.pushUsageLimitSources(ids: ["first", "second"], includeFutureSource: true)
        guard case let .usageLimitSourcesUpdated(initial)? = try await iterator.next() else {
            return XCTFail("Expected the initial sources.")
        }
        XCTAssertEqual(initial.map(\.id), ["first", "second"])

        try await connection.pushUsageLimitSources(ids: ["replacement"])
        _ = try await iterator.next()
        let replaced = try await client.serverConfig()
        XCTAssertEqual(replaced.usageLimitSources.map(\.id), ["replacement"])

        try await connection.pushUsageLimitSources(ids: [])
        guard case let .usageLimitSourcesUpdated(removed)? = try await iterator.next() else {
            return XCTFail("Expected the empty source update.")
        }
        XCTAssertTrue(removed.isEmpty)
        let cleared = try await client.serverConfig()
        XCTAssertTrue(cleared.usageLimitSources.isEmpty)

        var replay = await client.serverConfigEvents().makeAsyncIterator()
        guard case let .snapshot(replayed)? = try await replay.next() else {
            return XCTFail("Expected the cached config.")
        }
        XCTAssertTrue(replayed.usageLimitSources.isEmpty)
        await client.disconnect()
    }

    func testCapableSnapshotPreservesSourcesUntilAnExplicitUpdate() async throws {
        let connection = ServerConfigTestConnection(mode: .snapshot)
        let client = makeClient(connection: connection)
        var iterator = await client.serverConfigEvents().makeAsyncIterator()
        _ = try await iterator.next()
        try await connection.pushUsageLimitSources(ids: ["proxy"])
        _ = try await iterator.next()

        try await connection.pushSnapshot(id: "refreshed")
        guard case let .snapshot(snapshot)? = try await iterator.next() else {
            return XCTFail("Expected the replacement snapshot.")
        }
        XCTAssertEqual(snapshot.providers.first?.instanceId, "refreshed")
        XCTAssertEqual(snapshot.usageLimitSources.map(\.id), ["proxy"])
        let cached = try await client.serverConfig()
        XCTAssertEqual(cached, snapshot)
        await client.disconnect()
    }

    func testReconnectToOlderServerClearsSources() async throws {
        let original = ServerConfigTestConnection(mode: .snapshot)
        let older = ServerConfigTestConnection(mode: .snapshot, supportsUsageLimitSources: nil)
        let client = makeClient(connection: original, reconnectConnection: older)
        var iterator = await client.serverConfigEvents().makeAsyncIterator()
        _ = try await iterator.next()
        try await original.pushUsageLimitSources(ids: ["proxy"])
        _ = try await iterator.next()
        let originalConnectionID = await client.currentConnectionID()
        XCTAssertNotNil(originalConnectionID)

        await client.reconnect()
        guard case let .snapshot(snapshot)? = try await iterator.next() else {
            return XCTFail("Expected the older server's snapshot.")
        }
        XCTAssertNil(snapshot.environment?.capabilities.usageLimitSources)
        XCTAssertTrue(snapshot.usageLimitSources.isEmpty)
        let cached = try await client.serverConfig()
        XCTAssertEqual(cached, snapshot)
        let currentConnectionID = await client.currentConnectionID()
        XCTAssertNotNil(currentConnectionID)
        XCTAssertNotEqual(currentConnectionID, originalConnectionID)
        let payloads = await older.payloads(for: "subscribeServerConfig")
        XCTAssertEqual(payloads, [.object(["usageLimitSources": .bool(true)])])
        await client.disconnect()
    }

    func testLateSourceUpdatesAreNotPublishedWithoutTheCapability() async throws {
        let unsupportedCapabilities: [Bool?] = [nil, false]
        for capability in unsupportedCapabilities {
            let connection = ServerConfigTestConnection(
                mode: .snapshot,
                supportsUsageLimitSources: capability
            )
            let client = makeClient(connection: connection)
            var iterator = await client.serverConfigEvents().makeAsyncIterator()
            _ = try await iterator.next()

            try await connection.pushUsageLimitSources(ids: ["late-source"])
            try await connection.pushProviderStatus(id: "after-source-update")
            guard case let .providerStatuses(providers)? = try await iterator.next() else {
                await client.disconnect()
                return XCTFail("Unsupported source updates must not reach listeners.")
            }
            XCTAssertEqual(providers.first?.instanceId, "after-source-update")
            let config = try await client.serverConfig()
            XCTAssertTrue(config.usageLimitSources.isEmpty)
            await client.disconnect()
        }
    }

    func testRefreshPreservesSourceAndSettingsUpdatesReceivedDuringTheRequest() async throws {
        let connection = ServerConfigTestConnection(mode: .snapshot)
        let client = makeClient(connection: connection)
        var iterator = await client.serverConfigEvents().makeAsyncIterator()
        _ = try await iterator.next()
        try await connection.pushUsageLimitSources(ids: ["original"])
        _ = try await iterator.next()

        let refresh = Task {
            try await client.refreshProviders(cwd: "/repo", instanceID: "codex-old", refreshModels: false)
        }
        await connection.waitForRequestCount(2)
        try await connection.pushUsageLimitSources(ids: ["latest"])
        _ = try await iterator.next()
        try await connection.pushSettings(continueAfterUpdate: true)
        _ = try await iterator.next()
        try await connection.finishRefresh(id: "codex-refreshed")

        let refreshed = try await refresh.value
        XCTAssertEqual(refreshed.providers.first?.instanceId, "codex-refreshed")
        XCTAssertEqual(refreshed.usageLimitSources.map(\.id), ["latest"])
        XCTAssertEqual(refreshed.settings?.continueThreadsAfterServerUpdate, true)
        XCTAssertEqual(refreshed.threadSnapshotPagination, true)
        XCTAssertEqual(refreshed.threadResumeCompletionMarker, true)
        XCTAssertEqual(refreshed.environment?.environmentId, "environment-1")
        guard case let .snapshot(emitted)? = try await iterator.next() else {
            return XCTFail("Expected the refreshed config.")
        }
        XCTAssertEqual(emitted, refreshed)
        let payloads = await connection.payloads(for: "server.refreshProviders")
        XCTAssertEqual(payloads, [.object([
            "refreshModels": .bool(false),
            "cwd": .string("/repo"),
            "instanceId": .string("codex-old"),
        ])])
        await client.disconnect()
    }

    func testResetCreditUsesTheSelectedInstance() async throws {
        let connection = ServerConfigTestConnection(mode: .snapshot)
        let client = makeClient(connection: connection)
        let result = try await client.consumeResetCredit(instanceID: "codex-work")
        XCTAssertEqual(result.outcome, .reset)
        let payloads = await connection.payloads(for: "provider.consumeResetCredit")
        XCTAssertEqual(payloads, [.object(["instanceId": .string("codex-work")])])
        let tags = await connection.tags()
        XCTAssertEqual(tags, ["provider.consumeResetCredit"])
        await client.disconnect()
    }

    func testResetCreditIsNotReplayedAfterASocketFailure() async throws {
        let original = ServerConfigTestConnection(mode: .snapshot, failResetCreditSend: true)
        let recovered = ServerConfigTestConnection(mode: .snapshot)
        let client = makeClient(connection: original, reconnectConnection: recovered)
        var iterator = await client.serverConfigEvents().makeAsyncIterator()
        _ = try await iterator.next()

        do {
            _ = try await client.consumeResetCredit(instanceID: "codex-work")
            XCTFail("An uncertain reset must fail without retrying.")
        } catch let error as RPCError {
            guard case .disconnected = error else {
                await client.disconnect()
                return XCTFail("Unexpected reset error: \(error)")
            }
        }

        guard case .snapshot? = try await iterator.next() else {
            return XCTFail("Expected the config subscription to reconnect.")
        }
        let originalTags = await original.tags()
        XCTAssertEqual(originalTags, ["subscribeServerConfig", "provider.consumeResetCredit"])
        let recoveredTags = await recovered.tags()
        XCTAssertEqual(recoveredTags, ["subscribeServerConfig"])
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
        reconnectConnection: ServerConfigTestConnection? = nil,
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
            webSocketConnector: ServerConfigTestConnector(
                connections: [connection] + (reconnectConnection.map { [$0] } ?? [])
            ),
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

private actor ServerConfigTestConnector: WebSocketConnecting {
    private var connections: [ServerConfigTestConnection]

    init(connections: [ServerConfigTestConnection]) { self.connections = connections }

    func connect(to _: URL) throws -> any WebSocketConnection {
        guard !connections.isEmpty else { throw RPCError.connectionUnavailable }
        return connections.removeFirst()
    }
}

private actor ServerConfigTestConnection: WebSocketConnection {
    enum Mode { case snapshot, silent, failure(String) }

    private let mode: Mode
    private let supportsUsageLimitSources: Bool?
    private let failResetCreditSend: Bool
    private var requestTags: [String] = []
    private var requestPayloads: [String: [JSONValue]] = [:]
    private var subscriptionRequestID: Int?
    private var refreshRequestID: Int?
    private var responses: [Data] = []
    private var receiver: CheckedContinuation<Data, any Error>?
    private var requestWaiters: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []

    init(mode: Mode, supportsUsageLimitSources: Bool? = true, failResetCreditSend: Bool = false) {
        self.mode = mode
        self.supportsUsageLimitSources = supportsUsageLimitSources
        self.failResetCreditSend = failResetCreditSend
    }

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard let tag = request["tag"]?.stringValue,
              case let .number(rawID) = request["id"] else { return }
        let id = Int(rawID)
        requestTags.append(tag)
        requestPayloads[tag, default: []].append(request["payload"] ?? .null)
        for waiter in requestWaiters where requestTags.count >= waiter.count {
            waiter.continuation.resume()
        }
        requestWaiters.removeAll { requestTags.count >= $0.count }
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
        case "server.refreshProviders":
            refreshRequestID = id
        case "provider.consumeResetCredit":
            if failResetCreditSend { throw RPCError.disconnected }
            try enqueue(success(id: id, value: .object(["outcome": .string("reset")])))
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
    func payloads(for tag: String) -> [JSONValue] { requestPayloads[tag] ?? [] }

    func waitForRequestCount(_ count: Int) async {
        if requestTags.count >= count { return }
        await withCheckedContinuation { requestWaiters.append((count, $0)) }
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

    func pushUsageLimitSources(ids: [String], includeFutureSource: Bool = false) throws {
        guard let subscriptionRequestID else { return }
        var sources = ids.map(source)
        if includeFutureSource {
            sources.append(.object(["id": .string("future"), "kind": .string("future-source")]))
        }
        try enqueue(chunk(id: subscriptionRequestID, value: .object([
            "type": .string("usageLimitSourcesUpdated"),
            "payload": .object(["sources": .array(sources)]),
        ])))
    }

    func pushSettings(continueAfterUpdate: Bool) throws {
        guard let subscriptionRequestID else { return }
        try enqueue(chunk(id: subscriptionRequestID, value: .object([
            "type": .string("settingsUpdated"),
            "payload": .object(["settings": .object([
                "continueThreadsAfterServerUpdate": .bool(continueAfterUpdate),
            ])]),
        ])))
    }

    func finishRefresh(id: String) throws {
        guard let refreshRequestID else { return }
        self.refreshRequestID = nil
        try enqueue(success(id: refreshRequestID, value: .object([
            "providers": .array([provider(id: id)]),
        ])))
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
                "capabilities": .object(supportsUsageLimitSources.map {
                    ["usageLimitSources": .bool($0)]
                } ?? [:]),
            ]),
        ])
    }

    private func provider(id: String) -> JSONValue {
        .object([
            "instanceId": .string(id), "driver": .string("codex"),
            "enabled": .bool(true), "installed": .bool(true), "status": .string("ready"),
            "auth": .object(["status": .string("authenticated")]),
            "checkedAt": .string("2026-09-01T12:00:00.000Z"), "models": .array([]),
            "usageLimits": .object([
                "checkedAt": .string("2026-09-01T12:00:00.000Z"),
                "windows": .array([
                    .object([
                        "id": .string("primary"), "kind": .string("session"),
                        "label": .string("Session"), "usedPercent": .number(25),
                    ]),
                    .object([
                        "id": .string("future"), "kind": .string("future-window"),
                        "label": .string("Future"), "usedPercent": .number(50),
                    ]),
                ]),
            ]),
        ])
    }

    private func source(id: String) -> JSONValue {
        .object([
            "id": .string(id), "kind": .string("cliproxy"), "label": .string(id),
            "checkedAt": .string("2026-09-01T12:00:00.000Z"), "accounts": .array([]),
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
