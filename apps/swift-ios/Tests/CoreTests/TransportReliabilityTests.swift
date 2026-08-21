import XCTest
@testable import T3Code

@MainActor
final class TransportReliabilityTests: XCTestCase {
    func testHTTPPolicyOffersGzipWithoutOverwritingCallerPreference() {
        var request = URLRequest(url: URL(string: "https://studio.example/api")!)
        let prepared = HTTPRequestPolicy.prepare(request)
        XCTAssertEqual(prepared.value(forHTTPHeaderField: "Accept-Encoding"), "gzip")
        XCTAssertEqual(prepared.value(forHTTPHeaderField: "Accept"), "application/json")

        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        XCTAssertEqual(
            HTTPRequestPolicy.prepare(request).value(forHTTPHeaderField: "Accept-Encoding"),
            "identity"
        )
    }

    func testEnvironmentAPIDecodesURLSessionDecompressedGzipResponse() async throws {
        let transport = RecordingHTTPTransport { request in
            let body = """
            {
              "environmentId": "environment-1",
              "label": "Studio",
              "platform": {"os": "darwin", "arch": "arm64"},
              "serverVersion": "1.0.0",
              "capabilities": {"repositoryIdentity": true}
            }
            """
            return (
                Data(body.utf8),
                transportResponse(
                    request,
                    headers: [
                        "Content-Type": "application/json",
                        // URLSession retains this response header while
                        // returning the already decompressed body.
                        "Content-Encoding": "gzip",
                    ]
                )
            )
        }
        let api = EnvironmentAPI(
            transport: transport,
            credentials: InMemoryCredentialStore()
        )

        let descriptor = try await api.descriptor(
            at: URL(string: "https://studio.example")!
        )
        XCTAssertEqual(descriptor.environmentId, "environment-1")
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept-Encoding"), "gzip")
    }

    func testShellSnapshotAppliesBoundedStartupTimeout() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(
            credentials: [
                environment.id: EnvironmentCredential(accessToken: "access-token"),
            ]
        )
        let transport = RecordingHTTPTransport { request in
            let body = #"{"snapshotSequence":0,"projects":[],"threads":[],"updatedAt":"2026-08-05T12:00:00.000Z"}"#
            return (Data(body.utf8), transportResponse(request))
        }
        let api = EnvironmentAPI(transport: transport, credentials: credentials)

        _ = try await api.shellSnapshot(for: environment, timeoutInterval: 6)

        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.timeoutInterval, 6)
    }

    func testThreadSnapshotSendsPaginationWindowAndDecodesCursor() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(credentials: [
            environment.id: EnvironmentCredential(accessToken: "access-token"),
        ])
        let body = try JSONEncoder.t3.encode(
            OrchestrationThreadDetailSnapshot(
                snapshotSequence: 42,
                thread: paginationThreadFixture(),
                page: OrchestrationThreadDetailPage(
                    beforeCursor: "next-cursor",
                    hasMore: true,
                    snapshotSequence: 42,
                    threadSequence: 40
                )
            )
        )
        let transport = RecordingHTTPTransport { request in
            (body, transportResponse(request))
        }
        let api = EnvironmentAPI(transport: transport, credentials: credentials)

        let snapshot = try await api.threadSnapshot(
            id: "thread-1",
            environment: environment,
            turnLimit: 20,
            beforeCursor: "current-cursor"
        )

        XCTAssertEqual(snapshot.page?.beforeCursor, "next-cursor")
        XCTAssertEqual(snapshot.page?.threadSequence, 40)
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        let query = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            .queryItems
        XCTAssertEqual(
            Dictionary(uniqueKeysWithValues: (query ?? []).compactMap { item in
                item.value.map { (item.name, $0) }
            }),
            ["turnLimit": "20", "beforeCursor": "current-cursor"]
        )
    }

    func testWebSocketHandshakeOffersPerMessageDeflate() {
        let url = URL(string: "wss://studio.example/ws?wsTicket=secret")!
        let compressed = WebSocketHandshakeRequest.make(url: url)
        XCTAssertEqual(
            compressed.value(forHTTPHeaderField: "Sec-WebSocket-Extensions"),
            "permessage-deflate; client_max_window_bits"
        )
        XCTAssertNil(
            WebSocketHandshakeRequest.make(
                url: url,
                offersPerMessageDeflate: false
            ).value(forHTTPHeaderField: "Sec-WebSocket-Extensions")
        )
    }

    func testBootstrapUsesCanonicalWebSocketRPCDispatch() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(
            credentials: [
                environment.id: EnvironmentCredential(accessToken: "access-token"),
            ]
        )
        let transport = RecordingHTTPTransport { request in
            let body = """
            {
              "ticket": "websocket-ticket",
              "expiresAt": "2026-07-30T12:05:00.000Z"
            }
            """
            return (Data(body.utf8), transportResponse(request))
        }
        let connection = RecordingWebSocketConnection()
        let client = T3Client(
            environment: environment,
            credentialStore: credentials,
            httpTransport: transport,
            webSocketConnector: StaticWebSocketConnector(connection: connection)
        )

        let result = try await client.createThreadAndSend(
            threadID: "thread-first-send",
            projectID: "project-1",
            title: "Native first send",
            text: "Start from this message",
            model: ModelSelection(instanceId: "codex", model: "gpt-5.4"),
            runtimeMode: .fullAccess,
            commandID: "stable-command",
            messageID: "stable-message",
            createdAt: "2026-07-30T12:00:00.000Z"
        )
        await client.disconnect()

        XCTAssertEqual(result.sequence, 42)
        let requests = await connection.requests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?["tag"]?.stringValue, "orchestration.dispatchCommand")
        XCTAssertEqual(
            requests.first?["payload"]?["bootstrap"]?["createThread"]?["projectId"]?.stringValue,
            "project-1"
        )
        XCTAssertEqual(requests.first?["payload"]?["commandId"]?.stringValue, "stable-command")
        XCTAssertEqual(
            requests.first?["payload"]?["message"]?["messageId"]?.stringValue,
            "stable-message"
        )

        let httpRequests = await transport.requests
        XCTAssertEqual(httpRequests.map(\.url?.path), ["/api/auth/websocket-ticket"])
    }

    func testUnsentCommandsFallBackToHTTPButBootstrapDoesNot() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            webSocketBaseURL: URL(string: "wss://studio.example")!
        )
        let credentials = InMemoryCredentialStore(
            credentials: [
                environment.id: EnvironmentCredential(accessToken: "access-token"),
            ]
        )
        let transport = RecordingHTTPTransport { request in
            let body = if request.url?.path == "/api/auth/websocket-ticket" {
                """
                {
                  "ticket": "websocket-ticket",
                  "expiresAt": "2026-07-30T12:05:00.000Z"
                }
                """
            } else {
                """
                {"sequence": 9}
                """
            }
            return (Data(body.utf8), transportResponse(request))
        }
        let client = T3Client(
            environment: environment,
            credentialStore: credentials,
            httpTransport: transport,
            webSocketConnector: FailingWebSocketConnector(),
            rpcConnectionWaitTimeout: .milliseconds(30)
        )

        let rename = try await client.rename(threadID: "thread-1", title: "Renamed")
        XCTAssertEqual(rename.sequence, 9)

        do {
            _ = try await client.createThreadAndSend(
                threadID: "thread-first-send",
                projectID: "project-1",
                title: "Native first send",
                text: "Start from this message",
                model: ModelSelection(instanceId: "codex", model: "gpt-5.4"),
                runtimeMode: .fullAccess
            )
            XCTFail("Bootstrap must not use the HTTP endpoint that cannot expand it.")
        } catch let error as RPCError {
            guard case .connectionUnavailable = error else {
                return XCTFail("Unexpected RPC error: \(error)")
            }
        }
        await client.disconnect()

        let requests = await transport.requests
        let dispatchRequests = requests.filter {
            $0.url?.path == "/api/orchestration/dispatch"
        }
        XCTAssertEqual(dispatchRequests.count, 1)
        let command = try JSONDecoder.t3.decode(
            JSONValue.self,
            from: try XCTUnwrap(dispatchRequests.first?.httpBody)
        )
        XCTAssertEqual(command["type"]?.stringValue, "thread.meta.update")
    }

    /// Set `T3_SWIFT_WS_DEFLATE_ECHO_URL` to a WebSocket endpoint that rejects
    /// non-deflate handshakes and echoes binary frames. This is intentionally
    /// opt-in because XCTest does not own a Node process. A successful round
    /// trip proves URLSession accepted the server's compressed frame.
    func testLivePerMessageDeflateRoundTripWhenConfigured() async throws {
        guard let value = ProcessInfo.processInfo.environment[
            "T3_SWIFT_WS_DEFLATE_ECHO_URL"
        ], let url = URL(string: value) else {
            throw XCTSkip("Set T3_SWIFT_WS_DEFLATE_ECHO_URL for live compression proof.")
        }
        let connection = try await URLSessionWebSocketConnector().connect(to: url)
        defer { Task { await connection.close() } }
        let payload = Data(repeating: 0x54, count: 64 * 1024)
        try await connection.send(payload)
        let echoed = try await connection.receive()
        XCTAssertEqual(echoed, payload)
    }

    func testPairingInputParsesClipboardQRHostedAndLooseFormats() throws {
        let direct = try PairingURL.parseFields(
            " https://studio.example:3773/pair#token=N735%4BQXJ "
        )
        XCTAssertEqual(direct.host, "https://studio.example:3773")
        XCTAssertEqual(direct.pairingCode, "N735KQXJ")

        let hosted = try PairingURL.parseFields(
            "https://app.t3.codes/pair?host=http%3A%2F%2F192.168.1.7%3A18773"
                + "&label=Big%20O#token=PAIRING"
        )
        XCTAssertEqual(hosted.host, "http://192.168.1.7:18773")
        XCTAssertEqual(hosted.pairingCode, "PAIRING")
        XCTAssertEqual(hosted.label, "Big O")

        let loose = try PairingURL.parseFields("192.168.1.7:18773 N735KQXJ5SJW")
        XCTAssertEqual(loose.host, "https://192.168.1.7:18773")
        XCTAssertEqual(loose.pairingCode, "N735KQXJ5SJW")

        let wrapped = try PairingURL.pairingURL(
            fromQRCode: "t3code://pair?pairingUrl=https%3A%2F%2Fstudio.example"
                + "%2Fpair%23token%3DQR-CODE"
        )
        XCTAssertEqual(wrapped, "https://studio.example/pair#token=QR-CODE")
        XCTAssertEqual(try PairingURL.parseFields(wrapped).pairingCode, "QR-CODE")
    }

    func testSplitPairingFieldsAcceptCompleteURLInHostField() throws {
        let target = try PairingURL.resolve(
            host: "http://192.168.1.7:18773/pair#token=FROM-URL",
            pairingCode: ""
        )
        XCTAssertEqual(target.credential, "FROM-URL")
        XCTAssertEqual(target.httpBaseURL.absoluteString, "http://192.168.1.7:18773/")
        XCTAssertEqual(target.webSocketBaseURL.absoluteString, "ws://192.168.1.7:18773/")
    }

    func testLocalNetworkProbeClassificationDistinguishesFailureModes() {
        XCTAssertTrue(LocalNetworkProbe.isLocalHost("192.168.20.4"))
        XCTAssertTrue(LocalNetworkProbe.isLocalHost("studio.local"))
        XCTAssertFalse(LocalNetworkProbe.isLocalHost("app.t3.codes"))

        let denied = NSError(
            domain: NSURLErrorDomain,
            code: URLError.notConnectedToInternet.rawValue,
            userInfo: [
                NSUnderlyingErrorKey: NSError(
                    domain: NSPOSIXErrorDomain,
                    code: 13
                ),
            ]
        )
        XCTAssertEqual(
            LocalNetworkProbe.classify(denied, host: "192.168.20.4", isLocal: true),
            .likelyLocalNetworkDenied("192.168.20.4")
        )
        XCTAssertEqual(
            LocalNetworkProbe.classify(
                URLError(.timedOut),
                host: "studio.local",
                isLocal: true
            ),
            .timeout("studio.local")
        )
        XCTAssertEqual(
            LocalNetworkProbe.classify(
                URLError(.cannotConnectToHost),
                host: "studio.local",
                isLocal: true
            ),
            .unavailableHost("studio.local")
        )
    }

    func testLocalNetworkProbeAcceptsWebSocketPairingSchemes() async throws {
        let transport = RecordingHTTPTransport { request in
            let body = """
            {
              "environmentId": "environment-1",
              "label": "Studio",
              "platform": {"os": "darwin", "arch": "arm64"},
              "serverVersion": "1.0.0",
              "capabilities": {}
            }
            """
            return (Data(body.utf8), transportResponse(request))
        }
        let result = try await LocalNetworkProbe(transport: transport).probe(
            address: "wss://studio.example"
        )

        XCTAssertEqual(result.baseURL.absoluteString, "https://studio.example/")
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.url?.scheme, "https")
        XCTAssertEqual(request.url?.path, "/.well-known/t3/environment")
    }

}

private func paginationThreadFixture() -> OrchestrationThread {
    OrchestrationThread(
        id: "thread-1",
        projectId: "project-1",
        title: "Long native thread",
        modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
        runtimeMode: .fullAccess,
        interactionMode: .default,
        branch: "main",
        worktreePath: nil,
        latestTurn: nil,
        createdAt: "2026-08-06T12:00:00.000Z",
        updatedAt: "2026-08-06T12:00:00.000Z",
        archivedAt: nil,
        settledOverride: nil,
        settledAt: nil,
        snoozedUntil: nil,
        snoozedAt: nil,
        pinnedAt: nil,
        deletedAt: nil,
        messages: [],
        activities: [],
        checkpoints: [],
        session: nil
    )
}

private func transportResponse(
    _ request: URLRequest,
    status: Int = 200,
    headers: [String: String] = ["Content-Type": "application/json"]
) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!,
        statusCode: status,
        httpVersion: "HTTP/1.1",
        headerFields: headers
    )!
}

private actor RecordingHTTPTransport: HTTPTransport {
    typealias Handler = @Sendable (URLRequest) throws -> (Data, HTTPURLResponse)

    private(set) var requests: [URLRequest] = []
    private let handler: Handler

    init(handler: @escaping Handler) {
        self.handler = handler
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        return try handler(request)
    }
}

private struct StaticWebSocketConnector: WebSocketConnecting {
    let connection: RecordingWebSocketConnection

    func connect(to _: URL) async throws -> any WebSocketConnection {
        connection
    }
}

private struct FailingWebSocketConnector: WebSocketConnecting {
    func connect(to _: URL) async throws -> any WebSocketConnection {
        throw URLError(.cannotConnectToHost)
    }
}

private actor RecordingWebSocketConnection: WebSocketConnection {
    private var recordedRequests: [JSONValue] = []
    private var queuedResponses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        recordedRequests.append(request)
        guard case let .number(rawID) = request["id"] else { return }
        let response = JSONValue.object([
            "_tag": .string("Exit"),
            "requestId": .number(rawID),
            "exit": .object([
                "_tag": .string("Success"),
                "value": .object(["sequence": .number(42)]),
            ]),
        ])
        enqueue(try JSONEncoder.t3.encode(response))
    }

    func receive() async throws -> Data {
        if !queuedResponses.isEmpty {
            return queuedResponses.removeFirst()
        }
        return try await withCheckedThrowingContinuation { continuation in
            receiver = continuation
        }
    }

    func close() {
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }

    func requests() -> [JSONValue] {
        recordedRequests
    }

    private func enqueue(_ data: Data) {
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            queuedResponses.append(data)
        }
    }
}
