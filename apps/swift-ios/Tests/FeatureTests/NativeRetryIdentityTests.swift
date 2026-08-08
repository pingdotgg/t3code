import Foundation
import XCTest
@testable import T3Code

@MainActor
final class NativeRetryIdentityTests: XCTestCase {
    func testConcurrentBootstrapRetriesKeepIndependentStableIdentities() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-native-concurrent-retry-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let environment = Environment(
            id: "environment-concurrent-retry",
            label: "Concurrent retry",
            httpBaseURL: URL(string: "https://concurrent-retry.example")!,
            webSocketBaseURL: URL(string: "wss://concurrent-retry.example")!
        )
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save([environment])
        try await store.setActiveEnvironment(id: environment.id)
        let transport = ConcurrentBootstrapHTTPTransport(shell: retryShellSnapshot())
        let connection = ConcurrentBootstrapWebSocketConnection()
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(
                credentials: [environment.id: EnvironmentCredential(accessToken: "token")]
            ),
            httpTransport: transport,
            webSocketConnector: ConcurrentBootstrapWebSocketConnector(connection: connection)
        )
        let client = NativeFeatureClient(
            runtime: runtime,
            settingsStore: UserDefaults(
                suiteName: "t3-native-concurrent-retry-\(UUID().uuidString)"
            )!
        )
        _ = try await client.initialSnapshot()
        await connection.waitUntilConnected()
        await transport.rejectShellReads()

        async let firstAttempt = failedBootstrap(client: client, prompt: "First task")
        async let secondAttempt = failedBootstrap(client: client, prompt: "Second task")
        _ = await (firstAttempt, secondAttempt)
        await connection.waitUntilDispatchCount(2)

        await failedBootstrap(client: client, prompt: "First task")
        await failedBootstrap(client: client, prompt: "Second task")

        let commands = await connection.dispatchCommands()
        XCTAssertEqual(commands.count, 4)
        for prompt in ["First task", "Second task"] {
            let matching = commands.filter {
                $0["message"]?["text"]?.stringValue == prompt
            }
            XCTAssertEqual(matching.count, 2, "Expected an initial attempt and one retry.")
            XCTAssertEqual(matching.first?["threadId"], matching.last?["threadId"])
            XCTAssertEqual(matching.first?["commandId"], matching.last?["commandId"])
            XCTAssertEqual(
                matching.first?["message"]?["messageId"],
                matching.last?["message"]?["messageId"]
            )
        }
        await client.disconnect()
    }

    func testTurnRetriesStayStableAndConfirmedBootstrapFailureResetsIdentity() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-native-retry-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let environment = Environment(
            id: "environment-retry",
            label: "Retry",
            httpBaseURL: URL(string: "https://retry.example")!,
            webSocketBaseURL: URL(string: "wss://retry.example")!
        )
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save([environment])
        try await store.setActiveEnvironment(id: environment.id)

        let connection = AmbiguousDispatchWebSocketConnection()
        let transport = RetryIdentityHTTPTransport(shell: retryShellSnapshot())
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(
                credentials: [
                    environment.id: EnvironmentCredential(accessToken: "token"),
                ]
            ),
            httpTransport: transport,
            webSocketConnector: RetryIdentityWebSocketConnector(connection: connection)
        )
        let settings = UserDefaults(
            suiteName: "t3-native-retry-\(UUID().uuidString)"
        )!
        let client = NativeFeatureClient(runtime: runtime, settingsStore: settings)
        let initial = try await client.initialSnapshot()
        XCTAssertEqual(initial.threads.first?.runtimeMode, .automatic)
        XCTAssertEqual(initial.threads.first?.interactionMode, .standard)
        await connection.waitUntilConnected()

        let turnIdentity = FeatureSubmissionIdentity(
            threadID: "thread-existing",
            commandID: "persisted-turn-command",
            messageID: "persisted-turn-message",
            createdAt: Date(timeIntervalSince1970: 1_750_000_000)
        )
        for _ in 0..<2 {
            do {
                try await client.sendMessage(
                    threadID: "thread-existing",
                    text: "Retry without duplicating",
                    selection: nil,
                    attachments: [],
                    identity: turnIdentity
                )
                XCTFail("The synthetic dispatch should fail ambiguously.")
            } catch {}
        }

        for _ in 0..<2 {
            do {
                _ = try await client.createThreadAndSend(
                    projectID: "project-1",
                    prompt: "Create exactly one task",
                    selection: FeatureSelection(providerID: "codex", modelID: "gpt-5.4"),
                    runtimeMode: .autoAcceptEdits,
                    interactionMode: .plan,
                    attachments: []
                )
                XCTFail("The synthetic bootstrap should fail ambiguously.")
            } catch {}
        }

        let commands = await connection.dispatchCommands()
            + transport.dispatchCommands()
        XCTAssertEqual(commands.count, 4)
        let turnCommands = commands.filter {
            $0["message"]?["text"]?.stringValue == "Retry without duplicating"
        }
        XCTAssertEqual(turnCommands.count, 2)
        let initialTurn = try XCTUnwrap(turnCommands.first)
        let retriedTurn = try XCTUnwrap(turnCommands.dropFirst().first)
        assertStableIdentity(initialTurn, retriedTurn, includesThreadID: false)
        XCTAssertEqual(initialTurn["commandId"]?.stringValue, turnIdentity.commandID)
        XCTAssertEqual(
            initialTurn["message"]?["messageId"]?.stringValue,
            turnIdentity.messageID
        )
        let bootstrapCommands = commands.filter {
            $0["message"]?["text"]?.stringValue == "Create exactly one task"
        }
        XCTAssertEqual(bootstrapCommands.count, 2)
        let initialBootstrap = try XCTUnwrap(bootstrapCommands.first)
        let retriedBootstrap = try XCTUnwrap(bootstrapCommands.dropFirst().first)
        XCTAssertNotEqual(initialBootstrap["commandId"], retriedBootstrap["commandId"])
        XCTAssertNotEqual(
            initialBootstrap["message"]?["messageId"],
            retriedBootstrap["message"]?["messageId"]
        )
        XCTAssertNotEqual(initialBootstrap["threadId"], retriedBootstrap["threadId"])
        for command in commands {
            XCTAssertEqual(command["runtimeMode"]?.stringValue, "full-access")
            XCTAssertEqual(command["interactionMode"]?.stringValue, "default")
        }
        await client.disconnect()
    }

    func testPartialBootstrapRecoversBySendingOnlyTheStableFinalTurn() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-native-partial-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let environment = Environment(
            id: "environment-partial",
            label: "Partial",
            httpBaseURL: URL(string: "https://partial.example")!,
            webSocketBaseURL: URL(string: "wss://partial.example")!
        )
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save([environment])
        try await store.setActiveEnvironment(id: environment.id)

        let connection = PartialBootstrapWebSocketConnection()
        let transport = PartialBootstrapHTTPTransport(shell: retryShellSnapshot())
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(
                credentials: [
                    environment.id: EnvironmentCredential(accessToken: "token"),
                ]
            ),
            httpTransport: transport,
            webSocketConnector: PartialBootstrapWebSocketConnector(connection: connection)
        )
        let settings = UserDefaults(
            suiteName: "t3-native-partial-\(UUID().uuidString)"
        )!
        let client = NativeFeatureClient(runtime: runtime, settingsStore: settings)
        _ = try await client.initialSnapshot()
        await connection.waitUntilConnected()

        let identity = FeatureSubmissionIdentity(
            threadID: "persisted-bootstrap-thread",
            commandID: "persisted-bootstrap-command",
            messageID: "persisted-bootstrap-message",
            createdAt: Date(timeIntervalSince1970: 1_750_000_000)
        )
        let created = try await client.createThreadAndSend(
            projectID: "project-1",
            prompt: "Recover the first turn",
            selection: FeatureSelection(providerID: "codex", modelID: "gpt-5.4"),
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            workspaceMode: .local,
            branch: nil,
            worktreePath: nil,
            startFromOrigin: false,
            attachments: [],
            identity: identity
        )

        let commands = await connection.dispatchCommands()
            + transport.dispatchCommands()
        XCTAssertEqual(commands.count, 2)
        let bootstrap = try XCTUnwrap(commands.first { $0["bootstrap"] != nil })
        let finalTurn = try XCTUnwrap(commands.first { $0["bootstrap"] == nil })
        assertStableIdentity(bootstrap, finalTurn, includesThreadID: true)
        XCTAssertEqual(bootstrap["threadId"]?.stringValue, identity.threadID)
        XCTAssertEqual(bootstrap["commandId"]?.stringValue, identity.commandID)
        XCTAssertEqual(
            bootstrap["message"]?["messageId"]?.stringValue,
            identity.messageID
        )
        let wireID = try XCTUnwrap(bootstrap["threadId"]?.stringValue)
        XCTAssertEqual(created.wireID, wireID)
        XCTAssertEqual(
            created.id,
            FeatureScopedID.thread(environmentID: environment.id, wireID: wireID)
        )
        await client.disconnect()
    }

    private func assertStableIdentity(
        _ first: JSONValue,
        _ second: JSONValue,
        includesThreadID: Bool
    ) {
        XCTAssertEqual(first["commandId"], second["commandId"])
        XCTAssertEqual(first["message"]?["messageId"], second["message"]?["messageId"])
        XCTAssertEqual(first["createdAt"], second["createdAt"])
        if includesThreadID {
            XCTAssertEqual(first["threadId"], second["threadId"])
        }
    }

    private func failedBootstrap(client: NativeFeatureClient, prompt: String) async {
        do {
            _ = try await client.createThreadAndSend(
                projectID: "project-1",
                prompt: prompt,
                selection: FeatureSelection(providerID: "codex", modelID: "gpt-5.4"),
                runtimeMode: .fullAccess,
                interactionMode: .standard,
                attachments: []
            )
            XCTFail("The synthetic dispatch should fail ambiguously.")
        } catch {}
    }
}

private struct ConcurrentBootstrapWebSocketConnector: WebSocketConnecting {
    let connection: ConcurrentBootstrapWebSocketConnection

    func connect(to _: URL) -> any WebSocketConnection {
        connection
    }
}

private actor ConcurrentBootstrapWebSocketConnection: WebSocketConnection {
    private var commands: [JSONValue] = []
    private var initialFailures: [CheckedContinuation<Void, Error>] = []
    private var dispatchWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var didConnect = false
    private var connectionWaiters: [CheckedContinuation<Void, Never>] = []
    private var queuedResponses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?

    func send(_ data: Data) async throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        if !didConnect {
            didConnect = true
            connectionWaiters.forEach { $0.resume() }
            connectionWaiters.removeAll()
        }
        if request["tag"]?.stringValue == RPCMethod.serverGetConfig.rawValue,
           let response = try retryConfigResponse(for: request) {
            enqueue(response)
            return
        }
        guard request["tag"]?.stringValue == RPCMethod.dispatchCommand.rawValue,
              let payload = request["payload"] else {
            return
        }
        commands.append(payload)
        let ready = dispatchWaiters.filter { commands.count >= $0.0 }
        dispatchWaiters.removeAll { commands.count >= $0.0 }
        ready.forEach { $0.1.resume() }
        guard commands.count <= 2 else {
            throw URLError(.networkConnectionLost)
        }
        return try await withCheckedThrowingContinuation { continuation in
            initialFailures.append(continuation)
            guard initialFailures.count == 2 else { return }
            let failures = initialFailures
            initialFailures.removeAll()
            failures.forEach { $0.resume(throwing: URLError(.networkConnectionLost)) }
        }
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

    func waitUntilConnected() async {
        guard !didConnect else { return }
        await withCheckedContinuation { continuation in
            connectionWaiters.append(continuation)
        }
    }

    func waitUntilDispatchCount(_ count: Int) async {
        guard commands.count < count else { return }
        await withCheckedContinuation { continuation in
            dispatchWaiters.append((count, continuation))
        }
    }

    func dispatchCommands() -> [JSONValue] {
        commands
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

private actor ConcurrentBootstrapHTTPTransport: HTTPTransport {
    private let shellData: Data
    private var acceptsShellReads = true

    init(shell: OrchestrationShellSnapshot) {
        shellData = try! JSONEncoder.t3.encode(shell)
    }

    func rejectShellReads() {
        acceptsShellReads = false
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        switch request.url?.path {
        case "/api/orchestration/shell" where acceptsShellReads:
            (shellData, retryHTTPResponse(request))
        case "/api/auth/websocket-ticket":
            (
                Data(
                    "{\"ticket\":\"ticket\",\"expiresAt\":\"2026-08-01T12:05:00.000Z\"}".utf8
                ),
                retryHTTPResponse(request)
            )
        default:
            throw URLError(.networkConnectionLost)
        }
    }
}

private func retryShellSnapshot() -> OrchestrationShellSnapshot {
    let timestamp = "2026-07-30T12:00:00.000Z"
    let model = ModelSelection(instanceId: "codex", model: "gpt-5.4")
    return OrchestrationShellSnapshot(
        snapshotSequence: 1,
        projects: [
            OrchestrationProject(
                id: "project-1",
                title: "T3 Code",
                workspaceRoot: "/work/t3",
                repositoryIdentity: nil,
                defaultModelSelection: model,
                scripts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                deletedAt: nil
            ),
        ],
        threads: [
            OrchestrationThreadShell(
                id: "thread-existing",
                projectId: "project-1",
                title: "Existing",
                modelSelection: model,
                runtimeMode: .approvalRequired,
                interactionMode: .plan,
                branch: nil,
                worktreePath: nil,
                latestTurn: nil,
                createdAt: timestamp,
                updatedAt: timestamp,
                archivedAt: nil,
                settledOverride: nil,
                settledAt: nil,
                snoozedUntil: nil,
                snoozedAt: nil,
                pinnedAt: nil,
                session: nil,
                latestUserMessageAt: nil,
                hasPendingApprovals: false,
                hasPendingUserInput: false,
                hasActionableProposedPlan: false
            ),
        ],
        updatedAt: timestamp
    )
}

private actor RetryIdentityHTTPTransport: HTTPTransport {
    private let shellData: Data
    private var commands: [JSONValue] = []

    init(shell: OrchestrationShellSnapshot) {
        shellData = try! JSONEncoder.t3.encode(shell)
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""
        if path == "/api/orchestration/shell" {
            return (shellData, retryHTTPResponse(request))
        }
        if path == "/api/auth/websocket-ticket" {
            return (
                Data(
                    """
                    {
                      "ticket": "ticket",
                      "expiresAt": "2026-07-30T12:05:00.000Z"
                    }
                    """.utf8
                ),
                retryHTTPResponse(request)
            )
        }
        if path.hasPrefix("/api/orchestration/threads/") {
            throw URLError(.networkConnectionLost)
        }
        if path == "/api/orchestration/dispatch" {
            commands.append(try retryDispatchCommand(from: request))
            throw URLError(.networkConnectionLost)
        }
        throw URLError(.unsupportedURL)
    }

    func dispatchCommands() -> [JSONValue] {
        commands
    }
}

private struct RetryIdentityWebSocketConnector: WebSocketConnecting {
    let connection: AmbiguousDispatchWebSocketConnection

    func connect(to _: URL) async throws -> any WebSocketConnection {
        connection
    }
}

private actor PartialBootstrapHTTPTransport: HTTPTransport {
    private let shellData: Data
    private var commands: [JSONValue] = []

    init(shell: OrchestrationShellSnapshot) {
        shellData = try! JSONEncoder.t3.encode(shell)
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""
        if path == "/api/orchestration/shell" {
            return (shellData, retryHTTPResponse(request))
        }
        if path == "/api/auth/websocket-ticket" {
            return (
                Data(
                    """
                    {
                      "ticket": "ticket",
                      "expiresAt": "2026-07-30T12:05:00.000Z"
                    }
                    """.utf8
                ),
                retryHTTPResponse(request)
            )
        }
        if path.hasPrefix("/api/orchestration/threads/") {
            let threadID = request.url?.lastPathComponent.removingPercentEncoding ?? "thread"
            let snapshot = retryEmptyThreadDetail(id: threadID)
            return (try JSONEncoder.t3.encode(snapshot), retryHTTPResponse(request))
        }
        if path == "/api/orchestration/dispatch" {
            commands.append(try retryDispatchCommand(from: request))
            return (
                Data("{\"sequence\":42}".utf8),
                retryHTTPResponse(request)
            )
        }
        throw URLError(.unsupportedURL)
    }

    func dispatchCommands() -> [JSONValue] {
        commands
    }
}

private struct PartialBootstrapWebSocketConnector: WebSocketConnecting {
    let connection: PartialBootstrapWebSocketConnection

    func connect(to _: URL) async throws -> any WebSocketConnection {
        connection
    }
}

private actor AmbiguousDispatchWebSocketConnection: WebSocketConnection {
    private var commands: [JSONValue] = []
    private var queuedResponses: [Data] = []
    private var didConnect = false
    private var connectionWaiters: [CheckedContinuation<Void, Never>] = []
    private var receiver: CheckedContinuation<Data, Error>?

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        if !didConnect {
            didConnect = true
            connectionWaiters.forEach { $0.resume() }
            connectionWaiters.removeAll()
        }
        if request["tag"]?.stringValue == RPCMethod.serverGetConfig.rawValue,
           let response = try retryConfigResponse(for: request) {
            enqueue(response)
            return
        }
        if request["tag"]?.stringValue == RPCMethod.dispatchCommand.rawValue,
           let payload = request["payload"] {
            commands.append(payload)
            throw URLError(.networkConnectionLost)
        }
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

    func waitUntilConnected() async {
        guard !didConnect else { return }
        await withCheckedContinuation { continuation in
            connectionWaiters.append(continuation)
        }
    }

    func dispatchCommands() -> [JSONValue] {
        commands
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

private actor PartialBootstrapWebSocketConnection: WebSocketConnection {
    private var commands: [JSONValue] = []
    private var queuedResponses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?
    private var didConnect = false
    private var connectionWaiters: [CheckedContinuation<Void, Never>] = []

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        if !didConnect {
            didConnect = true
            connectionWaiters.forEach { $0.resume() }
            connectionWaiters.removeAll()
        }
        guard request["tag"]?.stringValue == RPCMethod.dispatchCommand.rawValue,
              let payload = request["payload"] else {
            if request["tag"]?.stringValue == RPCMethod.serverGetConfig.rawValue,
               let response = try retryConfigResponse(for: request) {
                enqueue(response)
            }
            return
        }
        commands.append(payload)
        if payload["bootstrap"] != nil {
            throw URLError(.networkConnectionLost)
        }
        guard case let .number(requestID) = request["id"] else { return }
        let response = JSONValue.object([
            "_tag": .string("Exit"),
            "requestId": .number(requestID),
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

    func waitUntilConnected() async {
        guard !didConnect else { return }
        await withCheckedContinuation { continuation in
            connectionWaiters.append(continuation)
        }
    }

    func dispatchCommands() -> [JSONValue] {
        commands
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

private func retryConfigResponse(for request: JSONValue) throws -> Data? {
    guard case let .number(requestID)? = request["id"] else { return nil }
    return try JSONEncoder.t3.encode(
        JSONValue.object([
            "_tag": .string("Exit"),
            "requestId": .number(requestID),
            "exit": .object([
                "_tag": .string("Success"),
                "value": .object(["providers": .array([])]),
            ]),
        ])
    )
}

private func retryEmptyThreadDetail(id: String) -> OrchestrationThreadDetailSnapshot {
    let timestamp = "2026-07-30T12:00:00.000Z"
    return OrchestrationThreadDetailSnapshot(
        snapshotSequence: 2,
        thread: OrchestrationThread(
            id: id,
            projectId: "project-1",
            title: "Recover the first turn",
            modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.4"),
            runtimeMode: .fullAccess,
            interactionMode: .default,
            branch: nil,
            worktreePath: nil,
            latestTurn: nil,
            createdAt: timestamp,
            updatedAt: timestamp,
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
    )
}

private func retryHTTPResponse(_ request: URLRequest) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
    )!
}

private func retryDispatchCommand(from request: URLRequest) throws -> JSONValue {
    guard let body = request.httpBody else {
        throw URLError(.cannotDecodeContentData)
    }
    return try JSONDecoder.t3.decode(JSONValue.self, from: body)
}
