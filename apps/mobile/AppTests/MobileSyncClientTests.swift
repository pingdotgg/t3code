import Foundation
import Testing
import T3MobileProtocol
@testable import T3Mobile

struct MobileSyncClientTests {
    @Test func parsesMobilePairingQRCodePayload() throws {
        let configuration = try MobilePairingPayload.configuration(
            from: "t3code://mobile/pair?v=1&server=http%3A%2F%2F192.168.1.44%3A3773&token=pairing-token"
        )

        #expect(configuration.baseURL.absoluteString == "http://192.168.1.44:3773")
        #expect(configuration.bootstrapCredential == "pairing-token")
    }

    @Test func rejectsNonT3PairingQRCodePayload() {
        #expect(throws: MobilePairingPayloadError.unsupportedPayload) {
            try MobilePairingPayload.configuration(from: "https://example.com/pair?token=nope")
        }
    }

    @Test func notConfiguredSummaryExplainsPairing() {
        let summary = MobileConnectionState.notConfigured.summary

        #expect(summary.contains("Pair"))
        #expect(summary.contains("T3 Code server"))
    }

    @Test func loadsInitialShellThroughHTTPAuthAndWebSocketHandshake() async throws {
        let baseURL = try #require(URL(string: "https://fixture.example"))
        let urlSession = URLSession(configuration: .mobileFixture)
        let webSocketSession = FakeMobileWebSocketSession(inbound: [
            fixtureData("server/hello.json"),
            fixtureData("server/shell-snapshot.json"),
        ])
        let client = MobileSyncClient(
            httpClient: MobileHTTPClient(urlSession: urlSession),
            webSocketTransport: FakeMobileWebSocketTransport(session: webSocketSession)
        )

        let result = try await client.loadInitialShell(
            MobileServerConfiguration(
                baseURL: baseURL,
                bearerSessionToken: "session-fixture"
            )
        )

        #expect(result.environment.id == "environment-fixture")
        #expect(result.shellState.snapshotSequence == 5)
        #expect(result.shellState.projects.first?.title == "Fixture Project")
        #expect(result.shellState.threads.first?.title == "Fixture Thread")

        let connectedURL = await webSocketSession.connectedURL
        #expect(connectedURL?.scheme == "wss")
        #expect(connectedURL?.query?.contains("wsToken=ws-fixture") == true)

        let sentMessages = try await webSocketSession.sentJSONValues()
        #expect(sentMessages.count == 2)
        #expect(sentMessages.first?.objectValue?["type"]?.stringValue == "hello")
        #expect(sentMessages.last?.objectValue?["method"]?.stringValue == "orchestration.subscribeShell")
        await result.session.webSocket.close()
    }

    @Test @MainActor func shellViewModelAppliesInitialSyncResult() async throws {
        let baseURL = try #require(URL(string: "https://fixture.example"))
        let urlSession = URLSession(configuration: .mobileFixture)
        let webSocketSession = FakeMobileWebSocketSession(inbound: [
            fixtureData("server/hello.json"),
            fixtureData("server/shell-snapshot.json"),
        ])
        let client = MobileSyncClient(
            httpClient: MobileHTTPClient(urlSession: urlSession),
            webSocketTransport: FakeMobileWebSocketTransport(session: webSocketSession)
        )
        let viewModel = ShellViewModel(
            environments: [],
            projects: [],
            threads: []
        )

        await viewModel.loadInitialSync(
            configuration: MobileServerConfiguration(
                baseURL: baseURL,
                bearerSessionToken: "session-fixture"
            ),
            client: client
        )

        #expect(viewModel.connectionState == .connected)
        #expect(viewModel.environments.first?.title == "Fixture Mac")
        #expect(viewModel.projects.first?.workspaceRoot == "/tmp/fixture-project")
        #expect(viewModel.threadSections.first?.threads.first?.id == "thread-fixture")
        await viewModel.stopSync()
    }

    @Test @MainActor func shellViewModelRecordsDiagnosticsForConfigurationFailure() async throws {
        let viewModel = ShellViewModel(environments: [], projects: [], threads: [])

        await viewModel.loadInitialSync(configuration: nil)

        #expect(viewModel.connectionState == .notConfigured)
        #expect(viewModel.diagnosticsSnapshot.connectionState.contains("Pair this iPhone"))
        #expect(viewModel.diagnosticsSnapshot.recentEvents.last?.level == .warning)
        #expect(viewModel.diagnosticsSnapshot.exportText.contains("T3 Code Mobile Diagnostics"))
    }

    @Test @MainActor func shellViewModelDispatchesInteractiveChatCommands() async throws {
        let baseURL = try #require(URL(string: "https://fixture.example"))
        let urlSession = URLSession(configuration: .mobileFixture)
        let webSocketSession = FakeMobileWebSocketSession(inbound: [
            fixtureData("server/hello.json"),
            fixtureData("server/shell-snapshot.json"),
            fixtureData("server/thread-snapshot.json"),
            fixtureData("server/command-accepted.json"),
            commandAcceptedFixture(id: "dispatch-2"),
        ])
        let client = MobileSyncClient(
            httpClient: MobileHTTPClient(urlSession: urlSession),
            webSocketTransport: FakeMobileWebSocketTransport(session: webSocketSession)
        )
        let viewModel = ShellViewModel(environments: [], projects: [], threads: [])

        await viewModel.loadInitialSync(
            configuration: MobileServerConfiguration(
                baseURL: baseURL,
                bearerSessionToken: "session-fixture"
            ),
            client: client
        )
        viewModel.composerDraft = "Continue from iPhone"
        await viewModel.sendMessage()
        await viewModel.interruptSelectedThread()

        let sentMessages = try await webSocketSession.sentJSONValues()
        let dispatches = sentMessages.filter {
            $0.objectValue?["method"]?.stringValue == "orchestration.dispatchCommand"
        }
        #expect(dispatches.count == 2)
        #expect(dispatches.first?.objectValue?["payload"]?.objectValue?["type"]?.stringValue == "thread.turn.start")
        #expect(dispatches.last?.objectValue?["payload"]?.objectValue?["type"]?.stringValue == "thread.turn.interrupt")
        await viewModel.stopSync()
    }

    @Test @MainActor func sendMessageClearsDraftOnlyAfterAcceptedReceipt() async throws {
        let baseURL = try #require(URL(string: "https://fixture.example"))
        let urlSession = URLSession(configuration: .mobileFixture)
        let webSocketSession = FakeMobileWebSocketSession(inbound: [
            fixtureData("server/hello.json"),
            fixtureData("server/shell-snapshot.json"),
            fixtureData("server/thread-snapshot.json"),
            commandAcceptedFixture(id: "dispatch-1"),
        ])
        let client = MobileSyncClient(
            httpClient: MobileHTTPClient(urlSession: urlSession),
            webSocketTransport: FakeMobileWebSocketTransport(session: webSocketSession)
        )
        let viewModel = ShellViewModel(environments: [], projects: [], threads: [])

        await viewModel.loadInitialSync(
            configuration: MobileServerConfiguration(
                baseURL: baseURL,
                bearerSessionToken: "session-fixture"
            ),
            client: client
        )
        viewModel.composerDraft = "Continue from iPhone"
        await viewModel.sendMessage()

        #expect(viewModel.composerDraft == "")
        #expect(viewModel.diagnosticsSnapshot.recentEvents.contains { $0.message.contains("Message command accepted") })
        await viewModel.stopSync()
    }

    @Test @MainActor func sendMessagePreservesDraftWhenReceiptIsNotAccepted() async throws {
        let baseURL = try #require(URL(string: "https://fixture.example"))
        let urlSession = URLSession(configuration: .mobileFixture)
        let webSocketSession = FakeMobileWebSocketSession(inbound: [
            fixtureData("server/hello.json"),
            fixtureData("server/shell-snapshot.json"),
            fixtureData("server/thread-snapshot.json"),
            commandFailedFixture(id: "dispatch-1"),
        ])
        let client = MobileSyncClient(
            httpClient: MobileHTTPClient(urlSession: urlSession),
            webSocketTransport: FakeMobileWebSocketTransport(session: webSocketSession)
        )
        let viewModel = ShellViewModel(environments: [], projects: [], threads: [])

        await viewModel.loadInitialSync(
            configuration: MobileServerConfiguration(
                baseURL: baseURL,
                bearerSessionToken: "session-fixture"
            ),
            client: client
        )
        viewModel.composerDraft = "Retry me"
        await viewModel.sendMessage()

        #expect(viewModel.composerDraft == "Retry me")
        await viewModel.stopSync()
    }

    @Test @MainActor func approvalResponseIsMarkedRespondedAfterAcceptedReceipt() async throws {
        let baseURL = try #require(URL(string: "https://fixture.example"))
        let urlSession = URLSession(configuration: .mobileFixture)
        let webSocketSession = FakeMobileWebSocketSession(inbound: [
            fixtureData("server/hello.json"),
            fixtureData("server/shell-snapshot.json"),
            fixtureData("server/thread-snapshot.json"),
            commandAcceptedFixture(id: "dispatch-1"),
        ])
        let client = MobileSyncClient(
            httpClient: MobileHTTPClient(urlSession: urlSession),
            webSocketTransport: FakeMobileWebSocketTransport(session: webSocketSession)
        )
        let viewModel = ShellViewModel(environments: [], projects: [], threads: [])

        await viewModel.loadInitialSync(
            configuration: MobileServerConfiguration(
                baseURL: baseURL,
                bearerSessionToken: "session-fixture"
            ),
            client: client
        )
        await viewModel.respondToApproval(requestID: "approval-1", decision: "accept")
        await viewModel.respondToApproval(requestID: "approval-1", decision: "reject")

        let sentMessages = try await webSocketSession.sentJSONValues()
        let dispatches = sentMessages.filter {
            $0.objectValue?["method"]?.stringValue == "orchestration.dispatchCommand"
        }
        #expect(viewModel.respondedRequestIDs == ["approval-1"])
        #expect(dispatches.count == 1)
        #expect(dispatches.first?.objectValue?["payload"]?.objectValue?["type"]?.stringValue == "thread.approval.respond")
        await viewModel.stopSync()
    }

    @Test @MainActor func loadDiffRequestsCheckpointScopedTurnRange() async throws {
        let baseURL = try #require(URL(string: "https://fixture.example"))
        let urlSession = URLSession(configuration: .mobileFixture)
        let webSocketSession = FakeMobileWebSocketSession(inbound: [
            fixtureData("server/hello.json"),
            fixtureData("server/shell-snapshot.json"),
            fixtureData("server/thread-snapshot.json"),
            fixtureData("server/turn-diff.json"),
        ])
        let client = MobileSyncClient(
            httpClient: MobileHTTPClient(urlSession: urlSession),
            webSocketTransport: FakeMobileWebSocketTransport(session: webSocketSession)
        )
        let viewModel = ShellViewModel(environments: [], projects: [], threads: [])

        await viewModel.loadInitialSync(
            configuration: MobileServerConfiguration(
                baseURL: baseURL,
                bearerSessionToken: "session-fixture"
            ),
            client: client
        )
        await viewModel.loadDiff(
            for: MobileCheckpointSummary(
                id: "turn-50:50",
                turnID: "turn-50",
                turnCount: 50,
                status: "Completed",
                completedAt: "2026-05-10T00:00:03.000Z",
                files: []
            )
        )

        let sentMessages = try await webSocketSession.sentJSONValues()
        let diffRequest = try #require(
            sentMessages.first { $0.objectValue?["method"]?.stringValue == "orchestration.getTurnDiff" }
        )
        let payload = diffRequest.objectValue?["payload"]?.objectValue
        #expect(payload?["fromTurnCount"]?.intValue == 49)
        #expect(payload?["toTurnCount"]?.intValue == 50)
        await viewModel.stopSync()
    }

    @Test func webSocketClientDecodesReplayDiffAndCommandReceipts() async throws {
        let webSocketSession = FakeMobileWebSocketSession(inbound: [
            fixtureData("server/replay-complete.json"),
            fixtureData("server/turn-diff.json"),
            fixtureData("server/command-accepted.json"),
        ])
        let client = MobileWebSocketClient(session: webSocketSession)

        let replay = try await client.replay(fromSequenceExclusive: 5)
        #expect(replay.status == "complete")
        #expect(replay.events.count == 1)

        let diff = try await client.getTurnDiff(
            threadID: "thread-fixture",
            fromTurnCount: 0,
            toTurnCount: 1
        )
        #expect(diff.diff.contains("Fixture change"))

        let receipt = try await client.dispatchCommand(
            ThreadSessionStopCommand(
                commandId: "mobile-command-1",
                threadId: "thread-fixture",
                createdAt: "2026-05-10T00:00:04.000Z"
            )
        )
        #expect(receipt.status == "accepted")
        #expect(receipt.sequence == 7)
        await client.close()
    }

    @Test func webSocketClientCorrelatesResponsesWhenStreamMessagesInterleave() async throws {
        let webSocketSession = FakeMobileWebSocketSession(inbound: [
            fixtureData("server/shell-snapshot.json"),
            fixtureData("server/shell-snapshot.json"),
            fixtureData("server/replay-complete.json"),
        ])
        let client = MobileWebSocketClient(session: webSocketSession)

        let shell = try await client.subscribeShell()
        #expect(shell.payload.kind == "snapshot")

        let replay = try await client.replay(fromSequenceExclusive: 5)
        #expect(replay.status == "complete")
        await client.close()
    }
}

private final class MobileFixtureURLProtocol: URLProtocol {
    nonisolated(unsafe) private static let encoder = JSONEncoder()

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "fixture.example"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: MobileSyncError.invalidEndpoint("missing URL"))
            return
        }
        let path = url.path
        let data: Data
        switch path {
        case "/mobile/v1":
            data = fixtureData("server/descriptor.json")
        case "/mobile/v1/auth/session":
            data = Data(
                """
                {
                  "protocolVersion": "mobile.v1",
                  "serverCapabilities": ["auth.bearer-bootstrap", "auth.ws-token", "orchestration.shell", "orchestration.thread-detail", "orchestration.replay-envelope", "orchestration.command-receipts", "diff.turn", "diff.full-thread"],
                  "result": {
                    "authenticated": true,
                    "role": "client",
                    "sessionMethod": "bearer-session-token",
                    "expiresAt": "2026-05-10T01:00:00.000Z"
                  }
                }
                """.utf8
            )
        case "/mobile/v1/auth/ws-token":
            data = Data(
                """
                {
                  "protocolVersion": "mobile.v1",
                  "serverCapabilities": ["auth.bearer-bootstrap", "auth.ws-token", "orchestration.shell", "orchestration.thread-detail", "orchestration.replay-envelope", "orchestration.command-receipts", "diff.turn", "diff.full-thread"],
                  "result": {
                    "token": "ws-fixture",
                    "expiresAt": "2026-05-10T01:00:00.000Z"
                  }
                }
                """.utf8
            )
        default:
            client?.urlProtocol(self, didFailWithError: MobileSyncError.invalidEndpoint(path))
            return
        }
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["content-type": "application/json"]
        )
        if let response {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        }
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private extension URLSessionConfiguration {
    static var mobileFixture: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MobileFixtureURLProtocol.self]
        return configuration
    }
}

private struct FakeMobileWebSocketTransport: MobileWebSocketTransport {
    let session: FakeMobileWebSocketSession

    func connect(to url: URL) async throws -> any MobileWebSocketSession {
        await session.setConnectedURL(url)
        return session
    }
}

private actor FakeMobileWebSocketSession: MobileWebSocketSession {
    private var inbound: [Data]
    private var sent: [Data] = []
    private var receiveContinuation: CheckedContinuation<Data, Error>?
    private var isClosed = false
    private(set) var connectedURL: URL?

    init(inbound: [Data]) {
        self.inbound = inbound
    }

    func setConnectedURL(_ url: URL) {
        connectedURL = url
    }

    func send(_ data: Data) async throws {
        sent.append(data)
    }

    func receive() async throws -> Data {
        if !inbound.isEmpty {
            return inbound.removeFirst()
        }
        if isClosed {
            throw MobileSyncError.webSocketClosed("Fake WebSocket closed.")
        }
        return try await withCheckedThrowingContinuation { continuation in
            receiveContinuation = continuation
        }
    }

    func ping() async throws {}

    func close() async {
        isClosed = true
        receiveContinuation?.resume(throwing: MobileSyncError.webSocketClosed("Fake WebSocket closed."))
        receiveContinuation = nil
    }

    func sentJSONValues() throws -> [JSONValue] {
        try sent.map { try JSONDecoder().decode(JSONValue.self, from: $0) }
    }
}

private func fixtureData(_ relativePath: String) -> Data {
    try! Data(contentsOf: fixtureURL(relativePath))
}

private func commandAcceptedFixture(id: String) -> Data {
    Data(
        """
        {
          "protocolVersion": "mobile.v1",
          "serverCapabilities": ["auth.bearer-bootstrap", "auth.ws-token", "orchestration.shell", "orchestration.thread-detail", "orchestration.replay-envelope", "orchestration.command-receipts", "diff.turn", "diff.full-thread"],
          "id": "\(id)",
          "type": "response",
          "payload": {
            "status": "accepted",
            "commandId": "mobile-command-fixture",
            "payloadHash": "hash-fixture",
            "acceptedAt": "2026-05-10T00:00:05.000Z",
            "sequence": 8
          }
        }
        """.utf8
    )
}

private func commandFailedFixture(id: String) -> Data {
    Data(
        """
        {
          "protocolVersion": "mobile.v1",
          "serverCapabilities": ["auth.bearer-bootstrap", "auth.ws-token", "orchestration.shell", "orchestration.thread-detail", "orchestration.replay-envelope", "orchestration.command-receipts", "diff.turn", "diff.full-thread"],
          "id": "\(id)",
          "type": "response",
          "payload": {
            "status": "failed",
            "commandId": "mobile-command-fixture",
            "payloadHash": "hash-fixture",
            "acceptedAt": "2026-05-10T00:00:05.000Z",
            "sequence": 8
          }
        }
        """.utf8
    )
}

private func fixtureURL(_ relativePath: String) -> URL {
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures/mobile-v1")
        .appendingPathComponent(relativePath)
}
