import Foundation
import Testing
@testable import T3Code

@Suite("Outdated host maintenance")
struct OutdatedHostUpdateTests {
    @Test @MainActor
    func nativeSettingsCanUpdateADisabledSavedHostWithoutAnOrchestrationClient() async throws {
        let fixture = UpdateFixture()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suiteName = "host-update-\(UUID().uuidString)"
        let settings = try #require(UserDefaults(suiteName: suiteName))
        defer {
            try? FileManager.default.removeItem(at: directory)
            settings.removePersistentDomain(forName: suiteName)
        }
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        try await store.save([fixture.environment])
        let runtime = EnvironmentRuntime(
            environmentStore: store, credentialStore: fixture.credentials,
            httpTransport: fixture.http, webSocketConnector: fixture.connector
        )
        let client = NativeFeatureClient(runtime: runtime, settingsStore: settings)
        let descriptor = try await client.environmentDescriptor(environmentID: fixture.environment.id)
        #expect(OutdatedHostUpdate.requiresHostUpdate(descriptor))
        #expect(await fixture.credentials.reads == [])
        try await client.updateEnvironment(environmentID: fixture.environment.id, targetVersion: "0.0.46")
        #expect(await fixture.socket.tags == ["server.updateServer"])
        #expect(try await store.load() == [fixture.environment])
        #expect(try await fixture.credentials.credential(for: "route-credential")?.accessToken == "saved-route-secret")
        await client.disconnect()
    }

    @Test(arguments: [nil, 1] as [Int?])
    func disconnectedOldHostUsesOnlyUpdateRPCAndAwaitsMatchingV2(version: Int?) async throws {
        let fixture = UpdateFixture(version: version, recovery: [
            .init(version: 1), .init(id: "another-host", version: 2), .init(version: 2),
        ])
        let environment = fixture.environment
        let result = try await fixture.updater.update(environment: environment, targetVersion: "0.0.46")
        #expect(result.environmentId == environment.id)
        #expect(result.orchestrationProtocolVersion == 2)
        #expect(result.serverVersion == "0.0.46")
        #expect(await fixture.socket.tags == ["server.updateServer"])
        #expect(await fixture.socket.closed)
        let urls = await fixture.connector.urls
        #expect(urls.count == 1)
        let query = URLComponents(url: try #require(urls.first), resolvingAgainstBaseURL: false)?.queryItems
        #expect(query?.contains { $0.name == "orchestrationProtocol" } == false)
        #expect(query?.first { $0.name == "wsTicket" }?.value == "maintenance-ticket")
        let requests = await fixture.http.requests
        #expect(requests.map { $0.url?.path } == [
            "/.well-known/t3/environment", "/api/auth/session", "/api/auth/websocket-ticket",
            "/.well-known/t3/environment", "/.well-known/t3/environment", "/.well-known/t3/environment",
        ])
        #expect(requests.filter { $0.url?.path == "/.well-known/t3/environment" }.allSatisfy {
            $0.value(forHTTPHeaderField: "Authorization") == nil
                && $0.cachePolicy == .reloadIgnoringLocalAndRemoteCacheData
                && $0.value(forHTTPHeaderField: "Cache-Control") == "no-cache"
        })
        #expect(requests.filter { $0.url?.path.hasPrefix("/api/auth/") == true }.allSatisfy {
            $0.value(forHTTPHeaderField: "Authorization") == "Bearer saved-route-secret"
        })
        #expect(!environment.isEnabled)
        #expect(environment.label == "My saved host")
        #expect(environment.routes.map(\.credentialOwnerID) == ["route-credential"])
    }

    @Test
    func identityMismatchDoesNotReadCredentials() async throws {
        let fixture = UpdateFixture(id: "different-host")
        await #expect(throws: EnvironmentRouteError.identityMismatch) {
            try await fixture.updater.update(environment: fixture.environment, targetVersion: "0.0.46")
        }
        #expect(await fixture.credentials.reads == [])
        #expect(await fixture.connector.urls == [])
    }

    @Test
    func failedSavedRouteFallsBackBeforeReadingItsCredential() async throws {
        let fixture = UpdateFixture()
        let unavailable = EnvironmentRoute(
            id: "unavailable", httpBaseURL: URL(string: "https://unavailable.example")!,
            webSocketBaseURL: URL(string: "wss://unavailable.example/ws")!,
            kind: .bearer, credentialOwnerID: "must-not-read"
        )
        var environment = fixture.environment
        environment.routes.insert(unavailable, at: 0)
        environment = environment.selectingRoute(unavailable)
        let descriptor = try await fixture.updater.update(environment: environment, targetVersion: "0.0.46")
        #expect(descriptor.orchestrationProtocolVersion == 2)
        #expect(await fixture.credentials.reads == ["route-credential", "route-credential"])
        #expect(await fixture.connector.urls.first?.host == "host.example")
        #expect(environment.routes.first == unavailable)
    }

    @Test
    func newerHostAsksForAppUpdateWithoutReadingCredentials() async throws {
        let fixture = UpdateFixture(version: 3)
        await #expect(throws: OrchestrationProtocolError.unsupportedServerVersion(3)) {
            try await fixture.updater.update(environment: fixture.environment, targetVersion: "0.0.46")
        }
        #expect(await fixture.credentials.reads == [])
        #expect(await fixture.connector.urls == [])
    }

    @Test
    func alreadyUpgradedHostReturnsToNormalClientBeforeAuthentication() async throws {
        let fixture = UpdateFixture(version: 2)
        await #expect(throws: OutdatedHostUpdateError.hostAlreadyCompatible) {
            try await fixture.updater.update(environment: fixture.environment, targetVersion: "0.0.46")
        }
        #expect(await fixture.credentials.reads == [])
    }

    @Test(arguments: [nil, "desktop-managed", "unknown-method"] as [String?])
    func missingUpdateCapabilityStopsBeforeAuthentication(method: String?) async throws {
        let fixture = UpdateFixture(method: method)
        await #expect(throws: OutdatedHostUpdateError.manualUpdateRequired) {
            try await fixture.updater.update(environment: fixture.environment, targetVersion: "0.0.46")
        }
        #expect(await fixture.credentials.reads == [])
        #expect(await fixture.connector.urls == [])
    }

    @Test
    func maintenancePermissionIsCheckedBeforeTicketOrSocket() async throws {
        let fixture = UpdateFixture(permissions: ["orchestration:operate"])
        do {
            try await fixture.updater.update(environment: fixture.environment, targetVersion: "0.0.46")
            Issue.record("Exact permissions must grant environment:maintain.")
        } catch let error as EnvironmentPermissionDeniedError {
            #expect(error.requiredPermission == "environment:maintain")
        }
        #expect(await fixture.http.requests.map { $0.url?.path } == [
            "/.well-known/t3/environment", "/api/auth/session",
        ])
        #expect(await fixture.connector.urls == [])
    }

    @Test
    func progressUpdateUsesStreamAndDesktopCommitOnly() async throws {
        let fixture = UpdateFixture(method: "desktop-managed", mode: .desktopProgress, desktopUpdate: true, progress: true)
        let stages = UpdateStages()
        let descriptor = try await fixture.updater.update(
            environment: fixture.environment, targetVersion: "0.0.46", continueRunningThreads: true,
            onStage: { await stages.append($0) }
        )
        #expect(descriptor.orchestrationProtocolVersion == 2)
        #expect(await fixture.socket.tags == ["server.updateServerWithProgress", "server.commitDesktopUpdate"])
        #expect(await fixture.socket.payloads.last?["requestId"] == .string("desktop-token"))
        #expect(await fixture.socket.payloads.first?["continueRunningThreads"] == .bool(false))
        #expect(await stages.values == [.downloading, .installing, .resuming])
        #expect(await fixture.connector.urls.count == 1)
    }

    @Test
    func progressWithoutCompleteDoesNotReportSuccess() async throws {
        let fixture = UpdateFixture(mode: .incompleteProgress, progress: true)
        await #expect(throws: OutdatedHostUpdateError.incompleteProgress) {
            try await fixture.updater.update(environment: fixture.environment, targetVersion: "0.0.46")
        }
        #expect(await fixture.http.descriptorReads == 1)
        #expect(await fixture.socket.closed)
    }

    @Test
    func remoteFailureAfterProgressCompleteStillFails() async throws {
        let fixture = UpdateFixture(mode: .failedProgress, progress: true)
        do {
            try await fixture.updater.update(environment: fixture.environment, targetVersion: "0.0.46")
            Issue.record("A remote error must not become a successful restart.")
        } catch RPCError.remote(let message) {
            #expect(message == "Update refused")
        }
        #expect(await fixture.http.descriptorReads == 1)
        #expect(await fixture.socket.closed)
    }

    @Test
    func droppedLegacyReplyRequiresRecoveryAndNeverReplaysUpdate() async throws {
        let fixture = UpdateFixture(mode: .droppedReply)
        let descriptor = try await fixture.updater.update(environment: fixture.environment, targetVersion: "0.0.46")
        #expect(descriptor.orchestrationProtocolVersion == 2)
        #expect(await fixture.socket.tags == ["server.updateServer"])
        #expect(await fixture.connector.urls.count == 1)
    }

    @Test
    func completedProgressCanLoseSocketDuringRestart() async throws {
        let fixture = UpdateFixture(mode: .droppedProgressReply, progress: true)
        let descriptor = try await fixture.updater.update(environment: fixture.environment, targetVersion: "0.0.46")
        #expect(descriptor.orchestrationProtocolVersion == 2)
        #expect(await fixture.socket.tags == ["server.updateServerWithProgress"])
        #expect(await fixture.connector.urls.count == 1)
    }

    @Test
    func recoveryHasAFiniteDeadline() async throws {
        let fixture = UpdateFixture(mode: .droppedReply, recovery: [.init(version: 1)])
        let updater = fixture.makeUpdater(recoveryTimeout: .zero)
        await #expect(throws: OutdatedHostUpdateError.recoveryTimedOut) {
            try await updater.update(environment: fixture.environment, targetVersion: "0.0.46")
        }
        #expect(await fixture.socket.tags == ["server.updateServer"])
        #expect(await fixture.socket.closed)
        #expect(await fixture.connector.urls.count == 1)
    }

    @Test
    func newerRecoveryHostAsksForAppUpdate() async throws {
        let fixture = UpdateFixture(recovery: [.init(version: 3)])
        await #expect(throws: OrchestrationProtocolError.unsupportedServerVersion(3)) {
            try await fixture.updater.update(environment: fixture.environment, targetVersion: "0.0.46")
        }
        #expect(await fixture.http.descriptorReads == 2)
    }

    @Test
    func descriptorCheckWorksWithoutSavedCredentialsOrSocket() async throws {
        let fixture = UpdateFixture()
        let descriptor = try await fixture.updater.descriptor(for: fixture.environment)
        #expect(OutdatedHostUpdate.requiresHostUpdate(descriptor))
        #expect(await fixture.credentials.reads == [])
        #expect(await fixture.connector.urls == [])
    }
}

private struct UpdateFixture {
    let http: UpdateHTTP
    let credentials = UpdateCredentials()
    let socket: UpdateSocket
    let connector: UpdateConnector

    init(
        id: String = "saved-host", version: Int? = nil, method: String? = "boot-service",
        mode: UpdateSocket.Mode = .unary, desktopUpdate: Bool = false, progress: Bool = false,
        permissions: [String] = ["environment:maintain"], recovery: [UpdateHTTP.Descriptor] = [.init(version: 2)]
    ) {
        http = UpdateHTTP(
            initial: .init(id: id, version: version), method: method, desktopUpdate: desktopUpdate,
            progress: progress, permissions: permissions, recovery: recovery
        )
        socket = UpdateSocket(mode: mode, http: http)
        connector = UpdateConnector(socket: socket)
    }

    var environment: Environment {
        Environment(
            id: "saved-host", label: "My saved host",
            httpBaseURL: URL(string: "https://host.example")!,
            webSocketBaseURL: URL(string: "wss://host.example/ws?orchestrationProtocol=1&wsTicket=stale")!,
            isEnabled: false,
            routes: [EnvironmentRoute(
                id: "saved-route", httpBaseURL: URL(string: "https://host.example")!,
                webSocketBaseURL: URL(string: "wss://host.example/ws?orchestrationProtocol=1&wsTicket=stale")!,
                kind: .bearer, credentialOwnerID: "route-credential"
            )]
        )
    }

    var updater: OutdatedHostUpdate { makeUpdater() }

    func makeUpdater(recoveryTimeout: Duration = .seconds(5)) -> OutdatedHostUpdate {
        OutdatedHostUpdate(
            api: EnvironmentAPI(transport: http, credentials: credentials), transport: http, connector: connector,
            recoveryTimeout: recoveryTimeout, recoveryPollInterval: .zero
        )
    }
}

private actor UpdateHTTP: HTTPTransport {
    struct Descriptor: Sendable {
        var id = "saved-host"
        let version: Int?
    }

    private let initial: Descriptor
    private let method: String?
    private let desktopUpdate: Bool
    private let progress: Bool
    private let permissions: [String]
    private var recovery: [Descriptor]
    private var updating = false
    private(set) var requests: [URLRequest] = []
    private(set) var descriptorReads = 0

    init(initial: Descriptor, method: String?, desktopUpdate: Bool, progress: Bool, permissions: [String], recovery: [Descriptor]) {
        self.initial = initial
        self.method = method
        self.desktopUpdate = desktopUpdate
        self.progress = progress
        self.permissions = permissions
        self.recovery = recovery
    }

    func startedUpdate() { updating = true }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let url = try #require(request.url)
        if url.host == "unavailable.example" { throw URLError(.cannotConnectToHost) }
        let value: JSONValue
        switch url.path {
        case "/.well-known/t3/environment":
            descriptorReads += 1
            let descriptor = updating ? recovery[0] : initial
            if updating, recovery.count > 1 { recovery.removeFirst() }
            var fields: [String: JSONValue] = [
                "environmentId": .string(descriptor.id), "label": .string("Remote host"),
                "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
                "serverVersion": .string(updating ? "0.0.46" : "0.0.45"),
                "capabilities": .object([
                    "serverSelfUpdate": method.map(JSONValue.string) ?? .null,
                    "desktopAppUpdate": .bool(desktopUpdate), "serverSelfUpdateProgress": .bool(progress),
                ]),
            ]
            if let version = descriptor.version { fields["orchestrationProtocolVersion"] = .number(Double(version)) }
            value = .object(fields)
        case "/api/auth/session":
            value = .object([
                "authenticated": .bool(true), "scopes": .array([.string("orchestration:operate")]),
                "permissions": .array(permissions.map(JSONValue.string)),
                "auth": .object(["serverUpdateScope": .string("environment:maintain")]),
            ])
        case "/api/auth/websocket-ticket":
            value = .object(["ticket": .string("maintenance-ticket"), "expiresAt": .string("2026-10-16T12:00:00Z")])
        default: throw URLError(.unsupportedURL)
        }
        return (try JSONEncoder.t3.encode(value), try #require(HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: nil, headerFields: nil
        )))
    }
}

private actor UpdateSocket: WebSocketConnection {
    enum Mode: Sendable { case unary, droppedReply, desktopProgress, incompleteProgress, failedProgress, droppedProgressReply }

    private let mode: Mode
    private let http: UpdateHTTP
    private var messages: [Data] = []
    private var receiver: CheckedContinuation<Data, any Error>?
    private(set) var closed = false
    private(set) var tags: [String] = []
    private(set) var payloads: [JSONValue] = []

    init(mode: Mode, http: UpdateHTTP) { self.mode = mode; self.http = http }

    func send(_ data: Data) async throws {
        let message = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        if message["_tag"] == .string("Ping") {
            try enqueue(.object(["_tag": .string("Pong")]))
            return
        }
        guard message["_tag"] == .string("Request"), let tag = message["tag"]?.stringValue else { return }
        let id = try #require(message["id"])
        tags.append(tag)
        payloads.append(message["payload"] ?? .null)
        if tag == "server.commitDesktopUpdate" { await close(); return }
        await http.startedUpdate()
        if mode == .droppedReply { await close(); return }
        let result: JSONValue = .object([
            "targetVersion": .string("0.0.46"),
            "method": .string(mode == .desktopProgress ? "desktop-app" : "boot-service"),
            "desktopUpdateToken": .string("desktop-token"),
        ])
        if tag == "server.updateServerWithProgress" {
            var values: [JSONValue] = [.object(["type": .string("progress"), "stage": .string("installing")])]
            if mode != .incompleteProgress { values.append(.object(["type": .string("complete"), "result": result])) }
            try enqueue(.object(["_tag": .string("Chunk"), "requestId": id, "values": .array(values)]))
            if mode == .droppedProgressReply { await close(); return }
        }
        let exit: JSONValue = mode == .failedProgress
            ? .object(["_tag": .string("Failure"), "cause": .array([
                .object(["_tag": .string("Fail"), "error": .object(["message": .string("Update refused")])]),
            ])])
            : .object(["_tag": .string("Success"), "value": tag == "server.updateServer" ? result : .null])
        try enqueue(.object(["_tag": .string("Exit"), "requestId": id, "exit": exit]))
    }

    func receive() async throws -> Data {
        if !messages.isEmpty { return messages.removeFirst() }
        if closed { throw RPCError.disconnected }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func close() async {
        closed = true
        receiver?.resume(throwing: RPCError.disconnected)
        receiver = nil
    }

    private func enqueue(_ value: JSONValue) throws {
        let data = try JSONEncoder.t3.encode(value)
        if let receiver { self.receiver = nil; receiver.resume(returning: data) }
        else { messages.append(data) }
    }
}

private actor UpdateConnector: WebSocketConnecting {
    let socket: UpdateSocket
    private(set) var urls: [URL] = []

    init(socket: UpdateSocket) { self.socket = socket }

    func connect(to url: URL) -> any WebSocketConnection {
        urls.append(url)
        return socket
    }
}

private actor UpdateCredentials: CredentialStore {
    private let store = InMemoryCredentialStore(credentials: ["route-credential": .init(accessToken: "saved-route-secret")])
    private(set) var reads: [String] = []

    func credential(for environmentID: String) async throws -> EnvironmentCredential? {
        reads.append(environmentID)
        return try await store.credential(for: environmentID)
    }

    func setCredential(_ credential: EnvironmentCredential, for environmentID: String) async throws {
        try await store.setCredential(credential, for: environmentID)
    }

    func swapCredential(_ credential: EnvironmentCredential, for environmentID: String) async throws -> EnvironmentCredential? {
        try await store.swapCredential(credential, for: environmentID)
    }

    func replaceCredential(_ credential: EnvironmentCredential, ifMatching expected: EnvironmentCredential?, for environmentID: String) async throws -> Bool {
        try await store.replaceCredential(credential, ifMatching: expected, for: environmentID)
    }

    func removeCredential(for environmentID: String) async throws {
        try await store.removeCredential(for: environmentID)
    }

    func removeCredential(ifMatching expected: EnvironmentCredential, for environmentID: String) async throws -> Bool {
        try await store.removeCredential(ifMatching: expected, for: environmentID)
    }
}

private actor UpdateStages {
    private(set) var values: [OutdatedHostUpdate.Stage] = []
    func append(_ value: OutdatedHostUpdate.Stage) { values.append(value) }
}
