import Foundation
import Testing
@testable import T3Code

@Suite("Terminal permission boundaries")
@MainActor
struct TerminalPermissionTests {
    @Test func readOnlySessionObservesWithoutAnyPTYMutation() async throws {
        let fixture = try await TerminalPermissionFixture.make()
        defer { fixture.cleanUp() }
        let snapshot = try await fixture.client.initialSnapshot()
        let thread = try #require(snapshot.threads.first { $0.environmentID == "two" })
        let initial = try await fixture.client.terminalSnapshot(threadID: thread.id, terminalID: "default")
        #expect(initial.state == .stopped)
        var sessions = fixture.client.terminalSessions(threadID: thread.id).makeAsyncIterator()
        #expect(await sessions.next()?.first?.threadID == thread.id)
        var events = fixture.client.terminalEvents(threadID: thread.id, terminalID: "default").makeAsyncIterator()
        let observed = try #require(await events.next())
        #expect(observed.buffer == "$ existing output\r\n")
        #expect(observed.state == .running)
        #expect(observed.threadID == thread.id)
        let calls = await fixture.server.terminalRequests
        #expect(calls.map(\.method) == ["subscribeTerminalMetadata", "terminal.observe"])
        #expect(calls.allSatisfy { $0.host == "two.example" })
        #expect(calls.last?.payload == .object([
            "threadId": .string("thread"), "terminalId": .string("default"),
        ]))
        await fixture.client.disconnect()
    }

    @Test func everyPTYActionRechecksTheOwningEnvironmentAfterRevocation() async throws {
        let fixture = try await TerminalPermissionFixture.make()
        defer { fixture.cleanUp() }
        await fixture.server.setPermissions(["terminal:read", "terminal:operate"], host: "two.example")
        let snapshot = try await fixture.client.initialSnapshot()
        let thread = try #require(snapshot.threads.first { $0.environmentID == "two" })
        _ = try await fixture.client.terminalSnapshot(threadID: thread.id, terminalID: "default")
        #expect(fixture.client.permissions(forThreadID: thread.id)?.grants("terminal:operate") == true)
        await fixture.server.setPermissions(["terminal:read"], host: "two.example")
        // Environment one still has full terminal access and the same wire thread ID.
        let actions: [@MainActor () async throws -> Void] = [
            { try await fixture.client.openTerminal(threadID: thread.id, terminalID: "default", columns: 80, rows: 24) },
            { try await fixture.client.writeTerminal(threadID: thread.id, terminalID: "default", data: "echo unsafe\r") },
            { try await fixture.client.resizeTerminal(threadID: thread.id, terminalID: "default", columns: 100, rows: 30) },
            { try await fixture.client.clearTerminal(threadID: thread.id, terminalID: "default") },
            { try await fixture.client.closeTerminal(threadID: thread.id, terminalID: "default") },
        ]
        for action in actions {
            do {
                try await action()
                Issue.record("A revoked terminal grant allowed a PTY action")
            } catch let error as EnvironmentPermissionDeniedError {
                #expect(error.requiredPermission == "terminal:operate")
            }
        }
        #expect(await fixture.server.terminalRequests.isEmpty)
        await fixture.client.disconnect()
    }

    @Test func currentOperateGrantDoesNotGrantTerminalReadsOrCachedOutput() async throws {
        let fixture = try await TerminalPermissionFixture.make()
        defer { fixture.cleanUp() }
        let snapshot = try await fixture.client.initialSnapshot()
        let thread = try #require(snapshot.threads.first { $0.environmentID == "two" })
        var readable = fixture.client.terminalEvents(threadID: thread.id, terminalID: "default").makeAsyncIterator()
        #expect(await readable.next()?.buffer == "$ existing output\r\n")
        await fixture.server.setPermissions(["terminal:operate"], host: "two.example")
        await #expect(throws: EnvironmentPermissionDeniedError.self) {
            try await fixture.client.terminalSnapshot(threadID: thread.id, terminalID: "default")
        }
        var sessions = fixture.client.terminalSessions(threadID: thread.id).makeAsyncIterator()
        #expect(await sessions.next() == nil)
        var events = fixture.client.terminalEvents(threadID: thread.id, terminalID: "default").makeAsyncIterator()
        let denied = try #require(await events.next())
        #expect(denied.state == .failed)
        #expect(denied.error?.contains("terminal:read") == true)
        #expect(denied.buffer.isEmpty)
        #expect(await fixture.server.terminalRequests.map(\.method) == ["terminal.observe"])
        await fixture.client.disconnect()
    }

    @Test func unsupportedObservationNeverFallsBackToAttach() async throws {
        let fixture = try await TerminalPermissionFixture.make()
        defer { fixture.cleanUp() }
        let snapshot = try await fixture.client.initialSnapshot()
        let thread = try #require(snapshot.threads.first { $0.environmentID == "two" })
        await fixture.server.rejectObservation()
        var events = fixture.client.terminalEvents(threadID: thread.id, terminalID: "default").makeAsyncIterator()
        let failed = try #require(await events.next())
        #expect(failed.state == .failed)
        #expect(failed.error?.contains("terminal.observe") == true)
        #expect(await events.next() == nil)
        #expect(await fixture.server.terminalRequests.map(\.method) == ["terminal.observe"])
        await fixture.client.disconnect()
    }

    @Test func fullGrantsKeepAttachAndPTYControls() async throws {
        let fixture = try await TerminalPermissionFixture.make()
        defer { fixture.cleanUp() }
        let snapshot = try await fixture.client.initialSnapshot()
        let thread = try #require(snapshot.threads.first { $0.environmentID == "one" })
        var events = fixture.client.terminalEvents(threadID: thread.id, terminalID: "default").makeAsyncIterator()
        #expect(await events.next()?.state == .running)
        try await fixture.client.openTerminal(threadID: thread.id, terminalID: "default", columns: 100, rows: 30)
        try await fixture.client.writeTerminal(threadID: thread.id, terminalID: "default", data: "pwd\r")
        try await fixture.client.resizeTerminal(threadID: thread.id, terminalID: "default", columns: 120, rows: 40)
        try await fixture.client.clearTerminal(threadID: thread.id, terminalID: "default")
        try await fixture.client.closeTerminal(threadID: thread.id, terminalID: "default")
        let calls = await fixture.server.terminalRequests
        #expect(calls.map(\.method) == ["terminal.attach", "terminal.open", "terminal.write",
            "terminal.resize", "terminal.clear", "terminal.close"])
        #expect(calls.allSatisfy { $0.host == "one.example" && $0.payload["threadId"] == .string("thread") })
        await fixture.client.disconnect()
    }

    @Test(arguments: [1, 2])
    func observeUsesTheSelectedRemoteTransportOnBothProtocols(version: Int) async throws {
        let server = TerminalPermissionServer(version: version)
        let environment = Environment(id: "two", label: "Remote", httpBaseURL: URL(string: "https://two.example")!,
                                      webSocketBaseURL: URL(string: "wss://two.example/relay/ws")!)
        let client = T3Client(environment: environment,
            credentialStore: InMemoryCredentialStore(credentials: ["two": .init(accessToken: "fixture")]),
            httpTransport: server, webSocketConnector: TerminalPermissionConnector(server: server))
        var events = await client.observeTerminal(threadID: "thread", terminalID: "default").makeAsyncIterator()
        let first = try #require(try await events.next())
        #expect(first.snapshot?.history == "$ existing output\r\n")
        let urls = await server.connectedURLs
        #expect(urls.count == 1)
        #expect(urls.first?.host == "two.example")
        #expect(urls.first?.path == "/relay/ws")
        let query = urls.first.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems }
        #expect(query?.first { $0.name == "orchestrationProtocol" }?.value == String(version))
        #expect(await server.terminalRequests.map(\.method) == ["terminal.observe"])
        await client.disconnect()
    }
}

@MainActor
private struct TerminalPermissionFixture {
    let directory: URL
    let client: NativeFeatureClient
    let server: TerminalPermissionServer
    let settings: UserDefaults
    let settingsName: String

    static func make() async throws -> Self {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("terminal-permissions-\(UUID())")
        let environments = ["one", "two"].map {
            Environment(id: $0, label: $0, httpBaseURL: URL(string: "https://\($0).example")!,
                        webSocketBaseURL: URL(string: "wss://\($0).example")!)
        }
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        try await store.save(environments)
        let server = TerminalPermissionServer()
        let runtime = EnvironmentRuntime(environmentStore: store,
            credentialStore: InMemoryCredentialStore(credentials: ["one": .init(accessToken: "fixture"), "two": .init(accessToken: "fixture")]),
            httpTransport: server, webSocketConnector: TerminalPermissionConnector(server: server))
        let settingsName = "terminal-permissions-\(UUID())"
        let settings = try #require(UserDefaults(suiteName: settingsName))
        let client = NativeFeatureClient(runtime: runtime, settingsStore: settings,
            projectFaviconStore: FeatureProjectFaviconStore(directoryURL: directory.appendingPathComponent("icons")),
            clientReadCache: ClientReadCache(directoryURL: directory.appendingPathComponent("reads")),
            fallbackPollingInitialDelay: .seconds(3600), aggregateRefreshInterval: .seconds(3600),
            aggregateIdleRefreshInterval: .seconds(3600), aggregateFailureRefreshInterval: .seconds(3600))
        return Self(directory: directory, client: client, server: server, settings: settings, settingsName: settingsName)
    }

    func cleanUp() {
        settings.removePersistentDomain(forName: settingsName)
        try? FileManager.default.removeItem(at: directory)
    }
}

private actor TerminalPermissionServer: HTTPTransport {
    struct Request: Sendable {
        let host: String
        let method: String
        let payload: JSONValue
    }
    private var permissions = ["one.example": ["terminal:read", "terminal:operate"], "two.example": ["terminal:read"]]
    private(set) var terminalRequests: [Request] = []
    private(set) var connectedURLs: [URL] = []
    private let version: Int
    private var observationRejected = false

    init(version: Int = 1) { self.version = version }
    func setPermissions(_ values: [String], host: String) { permissions[host] = values }
    func connected(_ url: URL) { connectedURLs.append(url) }
    func rejectObservation() { observationRejected = true }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = try #require(request.url)
        let host = try #require(url.host)
        let value: JSONValue
        switch url.path {
        case "/.well-known/t3/environment": value = descriptor(host: host)
        case "/api/auth/session":
            value = try JSONValue.encode(AuthSessionState(authenticated: true,
                scopes: ["terminal:operate", "orchestration:read"],
                permissions: ["orchestration:read"] + (permissions[host] ?? []),
                auth: .init(serverUpdateScope: "environment:maintain")))
        case "/api/auth/websocket-ticket":
            value = .object(["ticket": .string("fixture"), "expiresAt": .string("2026-10-07T12:00:00.000Z")])
        case "/api/orchestration/shell": value = try JSONValue.encode(shell)
        default: throw URLError(.unsupportedURL)
        }
        return (try JSONEncoder.t3.encode(value), try #require(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)))
    }

    func reply(host: String, method: String, payload: JSONValue, id: Double) throws -> JSONValue? {
        let value: JSONValue
        if method.hasPrefix("terminal.") || method == "subscribeTerminalMetadata" {
            terminalRequests.append(Request(host: host, method: method, payload: payload))
        }
        if method == "terminal.observe", observationRejected {
            return .object(["_tag": .string("Exit"), "requestId": .number(id), "exit": .object([
                "_tag": .string("Failure"), "cause": .array([.object([
                    "_tag": .string("Fail"), "error": .object(["message": .string("Unknown request tag: terminal.observe")]),
                ])]),
            ])])
        }
        switch method {
        case "terminal.observe", "terminal.attach":
            return chunk(id: id, value: .object(["type": .string("snapshot"), "snapshot": terminal]))
        case "subscribeTerminalMetadata":
            return chunk(id: id, value: .object(["type": .string("snapshot"), "terminals": .array([terminal])]))
        case "terminal.open": value = terminal
        case "terminal.write", "terminal.resize", "terminal.clear", "terminal.close": value = .null
        case RPCMethod.subscribeServerConfig.rawValue:
            return chunk(id: id, value: .object(["type": .string("snapshot"), "config": .object([
                "providers": .array([]), "settings": .object([:]), "environment": descriptor(host: host),
                "auth": .object(["serverUpdateScope": .string("environment:maintain")]),
            ])]))
        case RPCMethod.getArchivedShellSnapshot.rawValue:
            value = try JSONValue.encode(OrchestrationShellSnapshot(snapshotSequence: 1, projects: [], threads: [], updatedAt: "2026-10-07T12:00:00.000Z"))
        default: return nil
        }
        return .object(["_tag": .string("Exit"), "requestId": .number(id),
                        "exit": .object(["_tag": .string("Success"), "value": value])])
    }

    private func chunk(id: Double, value: JSONValue) -> JSONValue {
        .object(["_tag": .string("Chunk"), "requestId": .number(id), "values": .array([value])])
    }

    private func descriptor(host: String) -> JSONValue {
        .object(["environmentId": .string(String(host.split(separator: ".")[0])), "label": .string(host),
            "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
            "serverVersion": .string("fixture"), "capabilities": .object([:]),
            "orchestrationProtocolVersion": .number(Double(version))])
    }

    private var shell: OrchestrationShellSnapshot {
        multiEnvironmentShell(projectID: "project", threadID: "thread", title: "Terminal fixture", modelID: "fixture-model")
    }

    private var terminal: JSONValue {
        .object(["threadId": .string("thread"), "terminalId": .string("default"), "cwd": .string("/work/project"),
            "status": .string("running"), "history": .string("$ existing output\r\n"), "pid": .number(42),
            "hasRunningSubprocess": .bool(false),
            "label": .string("Shell"), "updatedAt": .string("2026-10-07T12:00:00.000Z"), "sequence": .number(1)])
    }
}

private struct TerminalPermissionConnector: WebSocketConnecting {
    let server: TerminalPermissionServer
    func connect(to url: URL) async -> any WebSocketConnection {
        await server.connected(url)
        return TerminalPermissionConnection(server: server, host: url.host ?? "")
    }
}

private actor TerminalPermissionConnection: WebSocketConnection {
    private let server: TerminalPermissionServer
    private let host: String
    private var responses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?
    private var closed = false

    init(server: TerminalPermissionServer, host: String) { self.server = server; self.host = host }

    func send(_ data: Data) async throws {
        guard !closed else { throw RPCError.disconnected }
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard let method = request["tag"]?.stringValue, case let .number(id)? = request["id"] else { return }
        guard let response = try await server.reply(host: host, method: method,
            payload: request["payload"] ?? .object([:]), id: id) else { return }
        let data = try JSONEncoder.t3.encode(response)
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else { responses.append(data) }
    }

    func receive() async throws -> Data {
        guard !closed else { throw RPCError.disconnected }
        if !responses.isEmpty { return responses.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func close() {
        closed = true
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }
}
