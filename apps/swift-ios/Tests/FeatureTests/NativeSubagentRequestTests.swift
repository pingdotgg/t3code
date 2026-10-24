import Foundation
import Testing
@testable import T3Code

@Suite("Native subagent request mapping")
@MainActor
struct NativeSubagentRequestTests {
    @Test func collidingThreadIDsKeepRequestsInTheirEnvironmentInShellAndDetail() async throws {
        let fixture = try await NativeSubagentFixture.make(requests: ["one": "user_input", "two": "command"])
        defer { fixture.cleanUp() }
        let client = fixture.client()
        do {
            let snapshot = try await client.initialSnapshot()
            let cases: [(String, OrchestrationV2PendingSubagentRequest)] = [("one", .userInput), ("two", .approval)]
            for (environmentID, request) in cases {
                let id = FeatureScopedID.thread(environmentID: environmentID, wireID: "parent")
                let parent = try #require(snapshot.threads.first { $0.id == id })
                let expected = [OrchestrationV2SubagentRequestTarget(
                    environmentID: environmentID, threadID: "child",
                    title: "\(environmentID) child", request: request
                )]
                #expect(parent.pendingSubagentRequest == request)
                #expect(parent.childThreadInputs == expected)
                let detail = try await client.loadThread(id: id, fresh: true)
                #expect(detail.thread.pendingSubagentRequest == request)
                #expect(detail.thread.childThreadInputs == expected)
            }
            await client.disconnect()
        } catch {
            await client.disconnect()
            throw error
        }
    }

    @Test(arguments: ["user_input", "command"])
    func resolvingChildRefreshesUnchangedParentInShellAndDetail(kind: String) async throws {
        let fixture = try await NativeSubagentFixture.make(requests: ["one": kind])
        defer { fixture.cleanUp() }
        let client = fixture.client()
        do {
            let id = FeatureScopedID.thread(environmentID: "one", wireID: "parent")
            let initial = try await client.initialSnapshot()
            let parent = try #require(initial.threads.first { $0.id == id })
            let expected: OrchestrationV2PendingSubagentRequest = kind == "user_input" ? .userInput : .approval
            #expect(parent.pendingSubagentRequest == expected)
            #expect(parent.childThreadInputs?.count == 1)
            let initialDetail = try await client.loadThread(id: id, fresh: true)
            #expect(initialDetail.thread.pendingSubagentRequest == expected)

            let previous = try #require(fixture.shells["one"])
            let rows = try #require(previous["threads"]?.v2Array)
            let resolved = V2Fixture.patch(previous, [
                "snapshotSequence": .number(101),
                "threads": .array([rows[0], V2Fixture.patch(rows[1], [
                    "pendingRuntimeRequest": .null,
                    "activityRunStatus": .null,
                    "activeRunId": .null,
                    "status": .string("completed"),
                ])]),
            ])
            // The parent's wire record is identical across this refresh.
            #expect(resolved["threads"]?.v2Array?.first == rows.first)
            await fixture.http.setShell(resolved, environmentID: "one")
            let refreshed = try await client.backgroundSnapshot()
            let refreshedParent = try #require(refreshed.threads.first { $0.id == id })
            #expect(refreshedParent.pendingSubagentRequest == nil)
            #expect(refreshedParent.childThreadInputs == [])
            let refreshedDetail = try await client.loadThread(id: id, fresh: true)
            #expect(refreshedDetail.thread.pendingSubagentRequest == nil)
            #expect(refreshedDetail.thread.childThreadInputs == [])
            await client.disconnect()
        } catch {
            await client.disconnect()
            throw error
        }
    }

    @Test(arguments: ["user_input", "command"])
    func childShellEventsUpdateOpenParentDetailWithoutReloading(kind: String) async throws {
        let fixture = try await NativeSubagentFixture.make(requests: ["one": kind])
        defer { fixture.cleanUp() }
        let shell = try #require(fixture.shells["one"])
        let rows = try #require(shell["threads"]?.v2Array)
        let parent = rows[0]
        let requestingChild = rows[1]
        let resolvedChild = V2Fixture.patch(requestingChild, [
            "pendingRuntimeRequest": .null, "activityRunStatus": .null,
            "activeRunId": .null, "status": .string("completed"),
        ])
        await fixture.http.setShell(V2Fixture.patch(shell, [
            "threads": .array([parent, resolvedChild]),
        ]), environmentID: "one")
        let subscriptions = AsyncStream<NativeSubagentShellSubscription>.makeStream()
        let client = fixture.client(
            webSocketConnector: NativeSubagentStreamConnector(subscriptions: subscriptions.continuation),
            rpcConnectionWaitTimeout: .seconds(1)
        )
        do {
            _ = try await client.initialSnapshot()
            let id = FeatureScopedID.thread(environmentID: "one", wireID: "parent")
            let detail = try await client.loadThread(id: id, fresh: true)
            #expect(detail.thread.childThreadInputs == [])
            var events = client.events().makeAsyncIterator()
            var requests = subscriptions.stream.makeAsyncIterator()
            let subscription = try #require(await requests.next())
            let expected: OrchestrationV2PendingSubagentRequest = kind == "user_input" ? .userInput : .approval

            // The parent never appears in either shell update.
            try await subscription.update(child: requestingChild, sequence: 101)
            let waiting = try #require(await activeDetailBeforeParentPublication(
                events: &events, parentID: id, pendingRequest: expected
            ))
            #expect(waiting.thread.pendingSubagentRequest == expected)
            #expect(waiting.thread.childThreadInputs == [OrchestrationV2SubagentRequestTarget(
                environmentID: "one", threadID: "child", title: "one child", request: expected
            )])

            try await subscription.update(child: resolvedChild, sequence: 102)
            let resolved = try #require(await activeDetailBeforeParentPublication(
                events: &events, parentID: id, pendingRequest: nil
            ))
            #expect(resolved.thread.pendingSubagentRequest == nil)
            #expect(resolved.thread.childThreadInputs == [])
            #expect(await fixture.http.detailReadCount == 1)
            await client.disconnect()
        } catch {
            await client.disconnect()
            throw error
        }
    }

    @Test(arguments: ["delete", "archive"])
    func acceptedChildRemovalClearsAncestorControlsWhenFollowupReadFails(action: String) async throws {
        let fixture = try await NativeSubagentFixture.make(requests: ["one": "command"])
        defer { fixture.cleanUp() }
        let subscriptions = AsyncStream<NativeSubagentShellSubscription>.makeStream()
        let client = fixture.client(
            webSocketConnector: NativeSubagentStreamConnector(subscriptions: subscriptions.continuation),
            rpcConnectionWaitTimeout: .seconds(1)
        )
        do {
            _ = try await client.initialSnapshot()
            let parentID = FeatureScopedID.thread(environmentID: "one", wireID: "parent")
            let childID = FeatureScopedID.thread(environmentID: "one", wireID: "child")
            let initialDetail = try await client.loadThread(id: parentID, fresh: true)
            #expect(initialDetail.thread.pendingSubagentRequest == .approval)
            #expect(initialDetail.thread.childThreadInputs?.count == 1)
            var events = client.events().makeAsyncIterator()
            var requests = subscriptions.stream.makeAsyncIterator()
            let subscription = try #require(await requests.next())
            await fixture.http.setFailShellReads(true)

            // Accept the command without a server delta, leaving the local shell sequence unchanged.
            if action == "delete" {
                try await client.deleteThread(id: childID)
            } else {
                try await client.setThreadArchived(id: childID, archived: true)
            }
            #expect(await fixture.http.failedShellReadCount > 0)
            let commands = await subscription.socket.dispatchedCommands
            #expect(commands.count == 1)
            #expect(commands.first?["type"]?.stringValue == "thread.\(action)")
            #expect(commands.first?["threadId"]?.stringValue == "child")
            var publishedDetail: FeatureThreadDetail?
            publication: while let event = await events.next() {
                switch event {
                case let .detail(detail), let .detailDelta(detail, _):
                    if detail.thread.id == parentID { publishedDetail = detail }
                case let .threadRemoved(id) where id == childID:
                    break publication
                case let .thread(thread) where thread.id == childID && thread.isArchived:
                    break publication
                case let .snapshot(snapshot) where !snapshot.threads.contains(where: {
                    $0.id == childID && !$0.isArchived
                }):
                    break publication
                default:
                    break
                }
            }
            let updatedDetail = try #require(publishedDetail)
            #expect(updatedDetail.thread.pendingSubagentRequest == nil)
            #expect(updatedDetail.thread.childThreadInputs == [])

            let retained = try await client.backgroundSnapshot()
            let parent = try #require(retained.threads.first { $0.id == parentID })
            #expect(parent.pendingSubagentRequest == nil)
            #expect(parent.childThreadInputs == [])
            #expect(await fixture.http.detailReadCount == 1)
            await client.disconnect()
        } catch {
            await client.disconnect()
            throw error
        }
    }

    private func activeDetailBeforeParentPublication(
        events: inout AsyncStream<FeatureEvent>.Iterator,
        parentID: String,
        pendingRequest: OrchestrationV2PendingSubagentRequest?
    ) async -> FeatureThreadDetail? {
        var latestDetail: FeatureThreadDetail?
        while let event = await events.next() {
            switch event {
            case let .detail(detail), let .detailDelta(detail, _):
                if detail.thread.id == parentID { latestDetail = detail }
            case let .thread(thread) where thread.id == parentID && thread.pendingSubagentRequest == pendingRequest:
                return latestDetail
            case let .snapshot(snapshot) where snapshot.threads.contains(where: {
                $0.id == parentID && $0.pendingSubagentRequest == pendingRequest
            }):
                return latestDetail
            default:
                break
            }
        }
        Issue.record("The shell stream ended before publishing the parent update")
        return nil
    }

    @Test func restoredShellAndHistoryDoNotExposeChildControls() async throws {
        let fixture = try await NativeSubagentFixture.make(requests: ["one": "user_input", "two": "command"])
        defer { fixture.cleanUp() }
        for environment in fixture.environments {
            let shell = try #require(fixture.shells[environment.id])
            let lease = try await fixture.cache.activate(.init(environment))
            await fixture.cache.record(shell: try OrchestrationV2Presentation.shellSnapshot(shell), lease: lease)
            let rawHistory = try #require(fixture.details[environment.id])
            let history = try OrchestrationV2ThreadState(snapshot: rawHistory).normalizedSnapshot()
            await fixture.cache.record(history: history, lease: lease)
        }
        try await fixture.cache.flush()
        await fixture.http.setOnline(false)
        let restartedCache = ClientReadCache(directoryURL: await fixture.cache.directoryURL)
        for environment in fixture.environments {
            let lease = try await restartedCache.activate(.init(environment))
            let saved = try #require(await restartedCache.shell(for: lease))
            let child = try #require(saved.threads.first { $0.id == "child" })
            #expect(child.v2SubagentRequestSource?.request != nil)
            #expect(await restartedCache.history(threadID: "parent", lease: lease) != nil)
        }
        let client = fixture.client(cache: restartedCache)
        do {
            let restored = try await client.initialSnapshot()
            #expect(restored.threads.count == 4)
            for environment in fixture.environments {
                let id = FeatureScopedID.thread(environmentID: environment.id, wireID: "parent")
                let parent = try #require(restored.threads.first { $0.id == id })
                #expect(parent.pendingSubagentRequest == nil)
                #expect(parent.childThreadInputs == [])
                let detail = try await client.loadThread(id: id, fresh: true)
                #expect(detail.thread.id == id)
                #expect(detail.thread.pendingSubagentRequest == nil)
                #expect(detail.thread.childThreadInputs == [])
            }
            await client.disconnect()
        } catch {
            await client.disconnect()
            throw error
        }
    }
}

@MainActor
private struct NativeSubagentFixture {
    let directory: URL
    let settingsName: String
    let settings: UserDefaults
    let environments: [Environment]
    let store: EnvironmentStore
    let credentials: InMemoryCredentialStore
    let cache: ClientReadCache
    let shells: [String: JSONValue]
    let details: [String: JSONValue]
    let http: NativeSubagentHTTPTransport

    static func make(requests: [String: String]) async throws -> Self {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("native-subagent-\(UUID())")
        let settingsName = "native-subagent-\(UUID())"
        let settings = try #require(UserDefaults(suiteName: settingsName))
        let environments = try requests.keys.sorted().map { id in
            var environment = Environment(id: id, label: id, httpBaseURL: URL(string: "https://\(id).example")!,
                                          webSocketBaseURL: URL(string: "wss://\(id).example")!)
            environment.descriptor = try JSONDecoder.t3.decode(
                EnvironmentDescriptor.self, from: v2EnvironmentDescriptorData(for: environment)
            )
            return environment
        }
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        try await store.save(environments)
        let template = try V2Fixture.load("v2-shell-snapshot")
        let thread = try #require(template["threads"]?.v2Array?.first)
        var shells: [String: JSONValue] = [:]
        var details: [String: JSONValue] = [:]
        for environment in environments {
            let kind = try #require(requests[environment.id])
            let parent = V2Fixture.patch(thread, [
                "id": .string("parent"), "title": .string("\(environment.id) parent"),
                "lineage": .object(["parentThreadId": .null, "relationshipToParent": .null, "rootThreadId": .string("parent")]),
                "status": .string("completed"), "activityRunStatus": .null, "activeRunId": .null,
                "pendingRuntimeRequest": .null,
            ])
            let child = V2Fixture.patch(thread, [
                "id": .string("child"), "title": .string("\(environment.id) child"),
                "lineage": .object(["parentThreadId": .string("parent"), "relationshipToParent": .string("subagent"), "rootThreadId": .string("parent")]),
                "pendingRuntimeRequest": .object([
                    "id": .string("request"), "kind": .string(kind), "createdAt": .string(V2Fixture.now),
                ]),
            ])
            shells[environment.id] = V2Fixture.patch(template, ["threads": .array([parent, child])])
            details[environment.id] = V2Fixture.snapshot(fields: ["thread": parent])
        }
        return Self(
            directory: directory, settingsName: settingsName, settings: settings,
            environments: environments, store: store,
            credentials: InMemoryCredentialStore(credentials: Dictionary(uniqueKeysWithValues: environments.map {
                ($0.id, EnvironmentCredential(accessToken: "test-only"))
            })),
            cache: ClientReadCache(directoryURL: directory.appendingPathComponent("reads"), writeDelay: .seconds(3600)),
            shells: shells, details: details,
            http: NativeSubagentHTTPTransport(environments: environments, shells: shells, details: details)
        )
    }

    func client(
        cache: ClientReadCache? = nil,
        webSocketConnector: (any WebSocketConnecting)? = nil,
        rpcConnectionWaitTimeout: Duration = .milliseconds(1)
    ) -> NativeFeatureClient {
        let subscriptions = AsyncStream<NativeSubagentShellSubscription>.makeStream()
        return NativeFeatureClient(
            runtime: EnvironmentRuntime(environmentStore: store, credentialStore: credentials,
                                        httpTransport: http, webSocketConnector: webSocketConnector ?? NativeSubagentStreamConnector(subscriptions: subscriptions.continuation),
                                        rpcConnectionWaitTimeout: rpcConnectionWaitTimeout),
            settingsStore: settings, clientReadCache: cache ?? self.cache,
            fallbackPollingInitialDelay: .seconds(3600), aggregateRefreshInterval: .seconds(3600),
            aggregateIdleRefreshInterval: .seconds(3600), aggregateFailureRefreshInterval: .seconds(3600),
            catchUpDelay: { try await Task.sleep(for: .seconds(3600)) }
        )
    }

    func cleanUp() {
        settings.removePersistentDomain(forName: settingsName)
        try? FileManager.default.removeItem(at: directory)
    }
}

private actor NativeSubagentHTTPTransport: HTTPTransport {
    let environments: [Environment]
    var shells: [String: JSONValue]
    let details: [String: JSONValue]
    var online = true
    private(set) var detailReadCount = 0
    private var failShellReads = false
    private(set) var failedShellReadCount = 0

    init(environments: [Environment], shells: [String: JSONValue], details: [String: JSONValue]) {
        self.environments = environments
        self.shells = shells
        self.details = details
    }

    func setShell(_ shell: JSONValue, environmentID: String) { shells[environmentID] = shell }
    func setOnline(_ online: Bool) { self.online = online }
    func setFailShellReads(_ fail: Bool) { failShellReads = fail }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard online else { throw URLError(.notConnectedToInternet) }
        let url = try #require(request.url)
        let environment = try #require(environments.first { $0.httpBaseURL.host == url.host })
        let data: Data
        switch url.path {
        case "/.well-known/t3/environment":
            data = try v2EnvironmentDescriptorData(for: environment)
        case "/api/auth/session":
            data = try JSONEncoder.t3.encode(AuthSessionState(
                authenticated: true, scopes: ["orchestration:read", "orchestration:operate"], sessionMethod: "bearer-access-token",
                permissions: ["orchestration:read", "orchestration:operate"], auth: .init(serverUpdateScope: "environment:maintain")
            ))
        case "/api/auth/websocket-ticket":
            data = try JSONEncoder.t3.encode(JSONValue.object([
                "ticket": .string("test-only"), "expiresAt": .string("2027-01-01T00:00:00Z"),
            ]))
        case "/api/orchestration/shell":
            if failShellReads {
                failedShellReadCount += 1
                throw URLError(.notConnectedToInternet)
            }
            data = try JSONEncoder.t3.encode(try #require(shells[environment.id]))
        case "/api/orchestration/threads/parent/bounded":
            detailReadCount += 1
            data = try JSONEncoder.t3.encode(try #require(details[environment.id]))
        default:
            throw URLError(.unsupportedURL)
        }
        return (data, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

private struct NativeSubagentStreamConnector: WebSocketConnecting {
    let subscriptions: AsyncStream<NativeSubagentShellSubscription>.Continuation

    func connect(to url: URL) async throws -> any WebSocketConnection {
        NativeSubagentStreamSocket(subscriptions: subscriptions)
    }
}

private struct NativeSubagentShellSubscription: Sendable {
    let id: Int
    let socket: NativeSubagentStreamSocket

    func update(child: JSONValue, sequence: Int) async throws {
        try await socket.chunk(id: id, values: [.object([
            "kind": .string("thread.updated"), "sequence": .number(Double(sequence)),
            "location": .string("active"), "thread": child,
        ])])
    }
}

private actor NativeSubagentStreamSocket: WebSocketConnection {
    let subscriptions: AsyncStream<NativeSubagentShellSubscription>.Continuation
    private var pending: [Data] = []
    private var receiver: CheckedContinuation<Data, any Error>?
    private var closed = false
    private(set) var dispatchedCommands: [JSONValue] = []

    init(subscriptions: AsyncStream<NativeSubagentShellSubscription>.Continuation) {
        self.subscriptions = subscriptions
    }

    func send(_ data: Data) throws {
        guard !closed else { throw URLError(.networkConnectionLost) }
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        if request["_tag"]?.stringValue == "Ping" {
            try enqueue(.object(["_tag": .string("Pong")]))
        }
        guard let tag = request["tag"]?.stringValue, let id = request["id"]?.v2Int else { return }
        switch tag {
        case RPCMethod.subscribeShell.rawValue:
            subscriptions.yield(.init(id: id, socket: self))
        case RPCMethod.subscribeServerConfig.rawValue:
            try chunk(id: id, values: [.object([
                "type": .string("snapshot"), "config": .object(["providers": .array([])]),
            ])])
        case RPCMethod.subscribeThread.rawValue:
            try chunk(id: id, values: [.object(["kind": .string("synchronized")])])
        case RPCMethod.dispatchCommand.rawValue:
            dispatchedCommands.append(try #require(request["payload"]))
            try enqueue(.object([
                "_tag": .string("Exit"), "requestId": .number(Double(id)),
                "exit": .object([
                    "_tag": .string("Success"), "value": .object(["sequence": .number(101)]),
                ]),
            ]))
        default:
            try enqueue(.object([
                "_tag": .string("Exit"), "requestId": .number(Double(id)),
                "exit": .object(["_tag": .string("Success"), "value": .null]),
            ]))
        }
    }

    func receive() async throws -> Data {
        guard !closed else { throw URLError(.networkConnectionLost) }
        if !pending.isEmpty { return pending.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func close() {
        closed = true
        receiver?.resume(throwing: URLError(.networkConnectionLost))
        receiver = nil
    }

    func chunk(id: Int, values: [JSONValue]) throws {
        try enqueue(.object([
            "_tag": .string("Chunk"), "requestId": .number(Double(id)), "values": .array(values),
        ]))
    }

    private func enqueue(_ value: JSONValue) throws {
        let data = try JSONEncoder.t3.encode(value)
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            pending.append(data)
        }
    }
}
