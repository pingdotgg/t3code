import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Native integration modernization")
struct NativeIntegrationModernizationTests {
    @Test
    func cancellingV2WatchOnlyThreadUnwatchesInsteadOfInterruptingCompletedRun() async throws {
        try await withClient { client, transport in
            let snapshot = try await client.backgroundSnapshot()
            let thread = try #require(snapshot.threads.first)
            #expect(thread.pullRequests?.first?.isWatched == true)

            try await client.cancelTurn(threadID: thread.id)

            let commands = await transport.commands
            #expect(commands.count == 1)
            let command = try #require(commands.first)
            #expect(command["type"] == .string("thread.pull-request.watch"))
            #expect(command["threadId"] == .string("thread-v2"))
            #expect(command["host"] == .string("github.com"))
            #expect(command["repository"] == .string("example/repo"))
            #expect(command["number"] == .number(1))
            #expect(command["watching"] == .bool(false))
            #expect(command["turnId"] == nil)
            #expect(command["runId"] == nil)
        }
    }

    @Test
    func cancellingV1StillSendsTheLatestTurnID() async throws {
        try await withClient(version: 1) { client, transport in
            let snapshot = try await client.backgroundSnapshot()
            let thread = try #require(snapshot.threads.first)

            try await client.cancelTurn(threadID: thread.id)

            let commands = await transport.commands
            #expect(commands.count == 1)
            #expect(commands.first?["type"] == .string("thread.turn.interrupt"))
            #expect(commands.first?["threadId"] == .string("thread-fixture"))
            #expect(commands.first?["turnId"] == .string("completed-run"))
        }
    }

    @Test
    func goalUpdatesAndClearsInNativeShellAndDetailMapping() async throws {
        try await withClient { client, transport in
            let active: JSONValue = .object([
                "objective": .string("Finish the task"), "status": .string("active"),
            ])
            let complete = V2Fixture.patch(active, [
                "objective": .string("Task finished"), "status": .string("complete"),
            ])
            for goal in [active, complete, .null] {
                try await transport.setGoal(goal)
                let snapshot = try await client.backgroundSnapshot()
                let thread = try #require(snapshot.threads.first)
                let detail = try await client.loadThread(id: thread.id, fresh: true)

                #expect(thread.goal?.objective == goal["objective"]?.stringValue)
                #expect(thread.goal?.status.rawValue == goal["status"]?.stringValue)
                #expect(detail.thread.goal == thread.goal)
            }
        }
    }

    private func withClient(
        version: Int = 2,
        _ body: (NativeFeatureClient, ModernizationTransport) async throws -> Void
    ) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = "native-modernization-\(UUID().uuidString)"
        let settings = try #require(UserDefaults(suiteName: suite))
        defer {
            try? FileManager.default.removeItem(at: directory)
            settings.removePersistentDomain(forName: suite)
        }
        let environment = Environment(
            id: "modernization", label: "Modernization",
            httpBaseURL: URL(string: "https://modernization.example")!,
            webSocketBaseURL: URL(string: "wss://modernization.example/ws")!
        )
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        try await store.save([environment])
        try await store.setActiveEnvironment(id: environment.id)
        let transport = try ModernizationTransport(version: version)
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(credentials: [environment.id: .init(accessToken: "fixture-token")]),
            httpTransport: transport,
            webSocketConnector: ModernizationConnector(transport: transport)
        )
        let client = NativeFeatureClient(runtime: runtime, settingsStore: settings)
        do {
            try await body(client, transport)
            await client.disconnect()
        } catch {
            await client.disconnect()
            throw error
        }
    }
}

private actor ModernizationTransport: HTTPTransport {
    private let version: Int
    private var shell: JSONValue
    private var detail: JSONValue
    private(set) var commands: [JSONValue] = []

    init(version: Int) throws {
        self.version = version
        let original = try V2Fixture.load(version == 2 ? "v2-shell-snapshot" : "shell-snapshot")
        let originalThread = try #require(original["threads"]?.v2Array?.first)
        let watched = V2Fixture.watchedPullRequest()
        let shellThread = V2Fixture.patch(originalThread, version == 2 ? [
            "latestRunId": .string("completed-run"), "status": .string("completed"),
            "latestRunCompletedAt": .string(V2Fixture.now),
            "activeRunId": .null, "activityRunStatus": .null, "activityRunStartedAt": .null,
            "activeProviderThreadId": .null, "pendingRuntimeRequest": .null,
            "pendingBackgroundTasks": .array([]), "pullRequests": .array([watched]),
        ] : [
            "latestTurn": .object([
                "turnId": .string("completed-run"), "state": .string("completed"),
                "requestedAt": .string(V2Fixture.now), "startedAt": .string(V2Fixture.now),
                "completedAt": .string(V2Fixture.now), "assistantMessageId": .null,
            ]),
        ])
        shell = V2Fixture.patch(original, ["threads": .array([shellThread])])
        // Keep the completed run in both reads: forwarding its shell ID would
        // bypass the adapter's watch-only fallback and send run.interrupt.
        detail = V2Fixture.snapshot(fields: [
            "thread": V2Fixture.patch(V2Fixture.thread, [
                "id": .string("thread-v2"), "projectId": .string("project-v2"),
                "pullRequests": .array([watched]),
            ]),
            "runs": .array([V2Fixture.patch(V2Fixture.run("completed-run", status: "completed"), [
                "threadId": .string("thread-v2"), "completedAt": .string(V2Fixture.now),
            ])]),
        ])
    }

    func setGoal(_ goal: JSONValue) throws {
        let thread = try #require(shell["threads"]?.v2Array?.first)
        let sequence = (shell["snapshotSequence"]?.v2Int ?? 0) + 1
        shell = V2Fixture.patch(shell, [
            "snapshotSequence": .number(Double(sequence)),
            "threads": .array([V2Fixture.patch(thread, ["goal": goal])]),
        ])
        let fixture = try V2Fixture.load("v2-thread-bounded-snapshot")
        let provider = try #require(fixture["projection"]?["providerThreads"]?.v2Array?.first)
        detail = V2Fixture.projectionPatch(detail, [
            "thread": V2Fixture.patch(try #require(detail["projection"]?["thread"]), [
                "activeProviderThreadId": provider["id"] ?? .null,
            ]),
            "providerThreads": .array([V2Fixture.patch(provider, [
                "goal": goal, "pendingBackgroundTasks": .array([]),
            ])]),
        ])
        detail = V2Fixture.patch(detail, ["snapshotSequence": .number(Double(sequence))])
    }

    func dispatch(_ command: JSONValue) -> JSONValue {
        commands.append(command)
        return .object(["sequence": .number(200)])
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let url = try #require(request.url)
        let value: JSONValue
        switch url.path {
        case "/.well-known/t3/environment":
            value = .object([
                "environmentId": .string("modernization"), "label": .string("Modernization"),
                "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
                "serverVersion": .string("fixture"), "capabilities": .object([:]),
                "orchestrationProtocolVersion": .number(Double(version)),
            ])
        case "/api/auth/session":
            value = try JSONValue.encode(AuthSessionState(
                authenticated: true, scopes: ["orchestration:read", "orchestration:operate"],
                sessionMethod: "bearer", permissions: ["orchestration:read", "orchestration:operate"]
            ))
        case "/api/auth/websocket-ticket":
            value = .object(["ticket": .string("fixture-ticket"), "expiresAt": .string("2099-01-01T00:00:00Z")])
        case "/api/orchestration/shell": value = shell
        case "/api/orchestration/threads/thread-v2/bounded": value = detail
        case "/api/orchestration/dispatch":
            value = dispatch(try JSONDecoder.t3.decode(JSONValue.self, from: #require(request.httpBody)))
        default: throw URLError(.unsupportedURL)
        }
        return (try JSONEncoder.t3.encode(value), try #require(HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: nil, headerFields: nil
        )))
    }
}

private struct ModernizationConnector: WebSocketConnecting {
    let transport: ModernizationTransport
    func connect(to _: URL) -> any WebSocketConnection { ModernizationSocket(transport: transport) }
}

private actor ModernizationSocket: WebSocketConnection {
    let transport: ModernizationTransport
    private var responses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?
    private var closed = false

    init(transport: ModernizationTransport) { self.transport = transport }

    func send(_ data: Data) async throws {
        guard !closed else { throw URLError(.networkConnectionLost) }
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard let id = request["id"], let tag = request["tag"]?.stringValue else { return }
        let value: JSONValue
        switch tag {
        case RPCMethod.dispatchCommand.rawValue:
            value = await transport.dispatch(try #require(request["payload"]))
        case RPCMethod.serverGetConfig.rawValue:
            value = .object(["providers": .array([]), "threadResumeCompletionMarker": .bool(true)])
        case RPCMethod.subscribeServerConfig.rawValue:
            try enqueue(.object([
                "_tag": .string("Chunk"), "requestId": id,
                "values": .array([.object([
                    "type": .string("snapshot"), "config": .object([
                        "providers": .array([]), "threadResumeCompletionMarker": .bool(true),
                    ]),
                ])]),
            ]))
            return
        case RPCMethod.subscribeThread.rawValue:
            try enqueue(.object([
                "_tag": .string("Chunk"), "requestId": id,
                "values": .array([.object(["kind": .string("synchronized")])]),
            ]))
            return
        default: return
        }
        try enqueue(.object([
            "_tag": .string("Exit"), "requestId": id,
            "exit": .object(["_tag": .string("Success"), "value": value]),
        ]))
    }

    func receive() async throws -> Data {
        guard !closed else { throw URLError(.networkConnectionLost) }
        if !responses.isEmpty { return responses.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func close() {
        closed = true
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }

    private func enqueue(_ value: JSONValue) throws {
        let data = try JSONEncoder.t3.encode(value)
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            responses.append(data)
        }
    }
}
