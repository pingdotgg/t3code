import Foundation
import Testing
@testable import T3Code

@Suite("Native workspace permission boundaries")
@MainActor
struct NativeWorkspacePermissionTests {
    @Test func revokedFileAccessDoesNotBorrowAnotherEnvironmentGrant() async throws {
        let fixture = try await WorkspacePermissionFixture.make()
        defer { fixture.cleanUp() }
        let snapshot = try await fixture.client.initialSnapshot()
        let thread = try #require(snapshot.threads.first { $0.environmentID == "two" })
        let project = try #require(snapshot.projects.first { $0.environmentID == "two" })
        _ = try await fixture.client.listFiles(threadID: thread.id, path: nil)
        await fixture.server.setPermissions(["orchestration:read"], host: "two.example")
        let actions: [@MainActor () async throws -> Void] = [
            { _ = try await fixture.client.listFiles(threadID: thread.id, path: nil) },
            { _ = try await fixture.client.searchThreadFiles(threadID: thread.id, query: "file", limit: 10) },
            { _ = try await fixture.client.searchWorkspaceFiles(threadID: thread.id, query: "file", limit: 10) },
            { _ = try await fixture.client.searchProjectFiles(projectID: project.id, query: "file", limit: 10) },
            { _ = try await fixture.client.readFile(threadID: thread.id, path: "file.txt") },
            { _ = try await fixture.client.browseProjectFolders(environmentID: "two", partialPath: "/work") },
            { _ = try await fixture.client.workspaceAssetURL(threadID: thread.id, path: "file.png") },
            { _ = try await fixture.client.mediaAsset(threadID: thread.id, path: "file.png") },
        ]
        for action in actions {
            await #expect(throws: EnvironmentPermissionDeniedError.self) { try await action() }
        }
        let requests = await fixture.server.operationRequests
        #expect(requests.map(\.method) == ["projects.listEntries"])
        #expect(requests.first?.host == "two.example")
        #expect(requests.first?.payload["cwd"] == .string("/work/two"))
        await fixture.client.disconnect()
    }

    @Test func attachmentReadUsesOrchestrationPermissionEvenWithCachedURL() async throws {
        let fixture = try await WorkspacePermissionFixture.make()
        defer { fixture.cleanUp() }
        let snapshot = try await fixture.client.initialSnapshot()
        let thread = try #require(snapshot.threads.first { $0.environmentID == "two" })
        await fixture.server.setPermissions(["orchestration:read"], host: "two.example")
        let attachment = FeatureMessageAttachment(id: "attachment", name: "image.png", mimeType: "image/png", sizeBytes: 1)
        let url = try await fixture.client.attachmentAssetURL(threadID: thread.id, attachment: attachment)
        #expect(url.host == "two.example")
        _ = try await fixture.client.attachmentAssetURL(threadID: thread.id, attachment: attachment)
        #expect(await fixture.server.operationRequests.count == 1)
        await fixture.server.setPermissions(["filesystem:read"], host: "two.example")
        await #expect(throws: EnvironmentPermissionDeniedError.self) {
            try await fixture.client.attachmentAssetURL(threadID: thread.id, attachment: attachment)
        }
        #expect(await fixture.server.operationRequests.count == 1)
        await fixture.client.disconnect()
    }

    @Test(arguments: ["source-control:write", "orchestration:operate"])
    func branchSwitchRechecksBothGrantsAfterListingRefs(revokedScope: String) async throws {
        let fixture = try await WorkspacePermissionFixture.make()
        defer { fixture.cleanUp() }
        let snapshot = try await fixture.client.initialSnapshot()
        let thread = try #require(snapshot.threads.first { $0.environmentID == "two" })
        await fixture.server.revoke(revokedScope, after: "vcs.listRefs")
        do {
            try await fixture.client.changeSourceControlWorkspace(threadID: thread.id, action: .switchBranch("other"))
            Issue.record("A revoked grant allowed a branch switch")
        } catch let error as EnvironmentPermissionDeniedError {
            #expect(error.requiredPermission == revokedScope)
        }
        let requests = await fixture.server.operationRequests
        #expect(requests.map(\.method) == ["vcs.refreshStatus", "vcs.listRefs"])
        #expect(requests.allSatisfy { $0.host == "two.example" })
        await fixture.client.disconnect()
    }

    @Test func scriptRechecksOperateAfterOpeningBeforeSendingInput() async throws {
        let fixture = try await WorkspacePermissionFixture.make()
        defer { fixture.cleanUp() }
        let snapshot = try await fixture.client.initialSnapshot()
        let thread = try #require(snapshot.threads.first { $0.environmentID == "two" })
        await fixture.server.revoke("terminal:operate", after: "terminal.open")
        await #expect(throws: EnvironmentPermissionDeniedError.self) {
            try await fixture.client.runProjectScript(threadID: thread.id, scriptID: "test", columns: 80, rows: 24,
                                                     hasSessionSnapshot: true)
        }
        let requests = await fixture.server.operationRequests
        #expect(requests.map(\.method) == ["terminal.open"])
        #expect(requests.first?.host == "two.example")
        #expect(requests.first?.payload["threadId"] == .string("thread"))
        // Operate alone cannot use a cached terminal listing to choose an existing session.
        #expect(requests.first?.payload["terminalId"]?.stringValue?.hasPrefix("script-") == true)
        await fixture.client.disconnect()
    }
}

@MainActor
private struct WorkspacePermissionFixture {
    let directory: URL
    let client: NativeFeatureClient
    let server: WorkspacePermissionServer
    let settings: UserDefaults
    let settingsName: String

    static func make() async throws -> Self {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("workspace-permissions-\(UUID())")
        let environments = ["one", "two"].map {
            Environment(id: $0, label: $0, httpBaseURL: URL(string: "https://\($0).example")!,
                        webSocketBaseURL: URL(string: "wss://\($0).example/relay/ws")!)
        }
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        try await store.save(environments)
        let server = WorkspacePermissionServer()
        let runtime = EnvironmentRuntime(environmentStore: store,
            credentialStore: InMemoryCredentialStore(credentials: ["one": .init(accessToken: "fixture"), "two": .init(accessToken: "fixture")]),
            httpTransport: server, webSocketConnector: WorkspacePermissionConnector(server: server))
        let settingsName = "workspace-permissions-\(UUID())"
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

private actor WorkspacePermissionServer: HTTPTransport {
    struct Request: Sendable {
        let host: String
        let method: String
        let payload: JSONValue
    }
    private let fullPermissions = ["orchestration:read", "orchestration:operate", "filesystem:read", "source-control:write", "terminal:operate"]
    private var permissions: [String: [String]] = [:]
    private var revocation: (scope: String, method: String)?
    private(set) var operationRequests: [Request] = []

    func setPermissions(_ values: [String], host: String) { permissions[host] = values }
    func revoke(_ scope: String, after method: String) { revocation = (scope, method) }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = try #require(request.url)
        let host = try #require(url.host)
        let value: JSONValue
        switch url.path {
        case "/.well-known/t3/environment": value = descriptor(host: host)
        case "/api/auth/session":
            value = try JSONValue.encode(AuthSessionState(authenticated: true, scopes: ["orchestration:operate"],
                permissions: permissions[host] ?? fullPermissions,
                auth: .init(serverUpdateScope: "environment:maintain")))
        case "/api/auth/websocket-ticket":
            value = .object(["ticket": .string("fixture"), "expiresAt": .string("2026-10-07T12:00:00.000Z")])
        case "/api/orchestration/shell":
            value = try JSONValue.encode(multiEnvironmentShell(projectID: "project", threadID: "thread", title: "Workspace",
                modelID: "fixture-model", workspaceRoot: "/work/\(host.split(separator: ".")[0])"))
        default: throw URLError(.unsupportedURL)
        }
        return (try JSONEncoder.t3.encode(value), try #require(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)))
    }

    func reply(host: String, method: String, payload: JSONValue, id: Double) throws -> JSONValue? {
        if method.hasPrefix("projects.") || method.hasPrefix("filesystem.") || method.hasPrefix("assets.")
            || method.hasPrefix("vcs.") || method.hasPrefix("terminal.") || method.hasPrefix("git.") {
            operationRequests.append(Request(host: host, method: method, payload: payload))
        }
        if let revocation, revocation.method == method {
            permissions[host] = (permissions[host] ?? fullPermissions).filter { $0 != revocation.scope }
            self.revocation = nil
        }
        let value: JSONValue
        switch method {
        case "projects.listEntries": value = .object(["entries": .array([]), "truncated": .bool(false)])
        case "assets.createUrl":
            value = .object(["relativeUrl": .string("/api/assets/fixture"),
                             "expiresAt": .number(Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000)])
        case "vcs.refreshStatus":
            value = .object(["isRepo": .bool(true), "hasPrimaryRemote": .bool(true), "isDefaultRef": .bool(false),
                "refName": .string("current"), "hasWorkingTreeChanges": .bool(false),
                "workingTree": .object(["files": .array([]), "insertions": .number(0), "deletions": .number(0)]),
                "hasUpstream": .bool(true), "aheadCount": .number(0), "behindCount": .number(0)])
        case "vcs.listRefs":
            value = .object(["refs": .array([.object(["name": .string("other"), "current": .bool(false), "isDefault": .bool(false)])]),
                "isRepo": .bool(true), "hasPrimaryRemote": .bool(true), "totalCount": .number(1)])
        case "terminal.open":
            value = .object(["threadId": .string("thread"), "terminalId": payload["terminalId"] ?? .string("default"),
                "cwd": payload["cwd"] ?? .string("/work/two"), "status": .string("running"), "history": .string(""),
                "label": .string("Script"), "hasRunningSubprocess": .bool(false),
                "updatedAt": .string("2026-10-07T12:00:00.000Z")])
        case RPCMethod.subscribeServerConfig.rawValue:
            return .object(["_tag": .string("Chunk"), "requestId": .number(id), "values": .array([
                .object(["type": .string("snapshot"), "config": .object([
                    "providers": .array([]), "environment": descriptor(host: host),
                    "auth": .object(["serverUpdateScope": .string("environment:maintain")]),
                    "settings": .object(["defaultProjectScripts": .array([.object([
                        "id": .string("test"), "name": .string("Test"), "command": .string("echo test"),
                        "icon": .string("test"), "runOnWorktreeCreate": .bool(false),
                    ])])]),
                ])]),
            ])])
        case RPCMethod.getArchivedShellSnapshot.rawValue:
            value = try JSONValue.encode(OrchestrationShellSnapshot(snapshotSequence: 1, projects: [], threads: [], updatedAt: "2026-10-07T12:00:00.000Z"))
        default:
            guard operationRequests.last?.method == method else { return nil }
            return .object(["_tag": .string("Exit"), "requestId": .number(id), "exit": .object([
                "_tag": .string("Failure"), "cause": .array([.object([
                    "_tag": .string("Fail"), "error": .object(["message": .string("Unexpected workspace RPC: \(method)")]),
                ])]),
            ])])
        }
        return .object(["_tag": .string("Exit"), "requestId": .number(id),
                        "exit": .object(["_tag": .string("Success"), "value": value])])
    }

    private func descriptor(host: String) -> JSONValue {
        .object(["environmentId": .string(String(host.split(separator: ".")[0])), "label": .string(host),
            "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
            "serverVersion": .string("fixture"), "capabilities": .object([:]), "orchestrationProtocolVersion": .number(1)])
    }
}

private struct WorkspacePermissionConnector: WebSocketConnecting {
    let server: WorkspacePermissionServer
    func connect(to url: URL) async -> any WebSocketConnection {
        WorkspacePermissionConnection(server: server, host: url.host ?? "")
    }
}

private actor WorkspacePermissionConnection: WebSocketConnection {
    private let server: WorkspacePermissionServer
    private let host: String
    private var responses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?
    private var closed = false

    init(server: WorkspacePermissionServer, host: String) { self.server = server; self.host = host }

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
