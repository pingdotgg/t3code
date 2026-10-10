import Foundation
import Testing
@testable import T3Code

@Suite("Disposable native offline reads")
@MainActor
struct NativeClientReadCacheTests {
    @Test func coldRestartRestoresCatalogHistoryAndRoutesWithoutWakingOutbox() async throws {
        let fixture = try await OfflineCacheFixture.make()
        defer { fixture.cleanUp() }
        let online = fixture.client()
        let live = try await online.initialSnapshot()
        let id = try #require(live.threads.first?.id)
        let detail = try await online.loadThread(id: id, fresh: true)
        #expect(detail.messages.first?.text == "Saved answer")
        try await online.flushClientReadCache()
        await online.disconnect()
        await fixture.http.setOnline(false)

        // A new cache actor and transport client model an actual process restart.
        let restarted = fixture.client(cache: ClientReadCache(directoryURL: await fixture.cache.directoryURL))
        let saved = try await restarted.initialSnapshot()
        #expect(saved.projects.map(\.wireID) == ["project"])
        #expect(saved.threads.map(\.wireID) == ["thread"])
        #expect(saved.connection.state != .connected)
        #expect(saved.environments.allSatisfy { $0.connectionState != .connected })
        let submission = offlineSubmission()
        #expect(FeatureOutboxPolicy.decision(for: submission, snapshot: saved) == .wait)
        let restored = try await restarted.loadThread(id: id, fresh: true)
        #expect(restored.messages.first?.text == "Saved answer")
        #expect(restored.approvals.isEmpty && restored.userInputs.isEmpty)
        #expect(restored.execution == nil && restored.workflows == nil && restored.recovery == nil)
        await restarted.disconnect()
    }

    @Test func restoredWaitingV2RequestsAndQueueActionsCannotDispatch() async throws {
        let fixture = try await OfflineCacheFixture.make()
        defer { fixture.cleanUp() }
        var shell = fixture.shell
        shell.orchestrationProtocolVersion = 2
        var raw = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(
            items: [V2Fixture.patch(V2Fixture.assistant("answer", ordinal: 1), [
                "status": .string("completed"), "streaming": .bool(false),
            ])], fields: ["runs": .array([V2Fixture.run(status: "waiting")])]
        )).normalizedSnapshot()
        var thread = raw.thread
        thread.activities.append(OrchestrationActivity(
            id: "approval-activity", tone: "info", kind: "approval.requested", summary: "Approval",
            payload: .object(["requestId": .string("approval"), "requestType": .string("command")]),
            turnId: nil, sequence: nil, createdAt: V2Fixture.now
        ))
        thread.activities.append(OrchestrationActivity(
            id: "question-activity", tone: "info", kind: "user-input.requested", summary: "Question",
            payload: .object(["requestId": .string("question"), "questions": .array([])]),
            turnId: nil, sequence: nil, createdAt: V2Fixture.now
        ))
        raw = OrchestrationThreadDetailSnapshot(snapshotSequence: raw.snapshotSequence, thread: thread)
        raw.orchestrationProtocolVersion = 2
        #expect(ClientReadCache.isEligible(raw))
        let lease = try await fixture.cache.activate(.init(fixture.environment))
        await fixture.cache.record(shell: shell, lease: lease)
        await fixture.cache.record(history: raw, lease: lease)
        try await fixture.cache.flush()
        await fixture.http.setOnline(false)
        let client = fixture.client(cache: ClientReadCache(directoryURL: await fixture.cache.directoryURL))
        let snapshot = try await client.initialSnapshot()
        let id = try #require(snapshot.threads.first?.id)
        let restored = try await client.loadThread(id: id, fresh: true)
        #expect(!restored.messages.isEmpty)
        #expect(restored.approvals.isEmpty && restored.userInputs.isEmpty)
        #expect(restored.execution == nil && restored.workflows == nil)
        await #expect(throws: (any Error).self) {
            try await client.resolveApproval(id: FeatureScopedID.approval(environmentID: "one", wireID: "approval"), decision: .allowOnce)
        }
        await #expect(throws: (any Error).self) {
            try await client.resolveUserInput(id: FeatureScopedID.input(environmentID: "one", wireID: "question"), answers: [:], attachmentsByQuestionID: [:])
        }
        await #expect(throws: (any Error).self) {
            try await client.updateThreadQueue(threadID: id, action: .resume)
        }
        #expect(await fixture.http.dispatchCount == 0)
        await client.disconnect()
    }

    @Test func liveLowerSequenceReplacesSavedRowsAndDeletedHistory() async throws {
        let fixture = try await OfflineCacheFixture.make()
        defer { fixture.cleanUp() }
        let high = multiEnvironmentShell(projectID: "project", threadID: "thread", title: "Old", snapshotSequence: 999)
        let lease = try await fixture.cache.activate(.init(fixture.environment))
        await fixture.cache.record(shell: high, lease: lease)
        await fixture.cache.record(history: fixture.detail, lease: lease)
        try await fixture.cache.flush()
        let replacement = multiEnvironmentShell(projectID: "new-project", threadID: "new-thread", title: "New", snapshotSequence: 1)
        await fixture.http.setShell(replacement)
        let client = fixture.client(cache: ClientReadCache(directoryURL: await fixture.cache.directoryURL))
        let saved = try await client.initialSnapshot()
        #expect(saved.projects.first?.wireID == "project")
        var events = client.events().makeAsyncIterator()
        while let event = await events.next() {
            if case let .snapshot(current) = event, current.projects.first?.wireID == "new-project" {
                #expect(current.threads.map(\.wireID) == ["new-thread"])
                break
            }
        }
        try await client.flushClientReadCache()
        await client.disconnect()
        let disk = ClientReadCache(directoryURL: await fixture.cache.directoryURL)
        let nextLease = try await disk.activate(.init(fixture.environment))
        #expect(await disk.shell(for: nextLease)?.snapshotSequence == 1)
        #expect(await disk.history(threadID: "thread", lease: nextLease) == nil)
    }

    @Test func environmentProtocolAndEndpointScopesCannotResurrectOldReads() async throws {
        let fixture = try await OfflineCacheFixture.make()
        defer { fixture.cleanUp() }
        var second = fixture.environment
        second = Environment(id: "two", label: "Two", httpBaseURL: second.httpBaseURL, webSocketBaseURL: second.webSocketBaseURL)
        let one = try await fixture.cache.activate(.init(fixture.environment))
        let two = try await fixture.cache.activate(.init(second))
        await fixture.cache.record(shell: fixture.shell, lease: one)
        await fixture.cache.record(history: fixture.detail, lease: one)
        await fixture.cache.record(shell: fixture.shell, lease: two)
        try await fixture.cache.flush()
        try await fixture.cache.clear(environmentID: "one")
        await fixture.cache.record(shell: fixture.shell, lease: one)
        await fixture.cache.record(history: fixture.detail, lease: one)
        try await fixture.cache.flush()
        #expect(await fixture.cache.shell(for: two) != nil)
        #expect(await fixture.cache.summary().map(\.environmentID) == ["two"])

        var changed = second
        changed.httpBaseURL = URL(string: "https://replacement.example")!
        let endpointLease = try await fixture.cache.activate(.init(changed))
        #expect(await fixture.cache.shell(for: endpointLease) == nil)
        await fixture.cache.record(shell: fixture.shell, lease: two)
        #expect(await fixture.cache.shell(for: endpointLease) == nil)
        await fixture.cache.record(shell: fixture.shell, lease: endpointLease)
        changed.orchestrationProtocolPreference = .v2
        let protocolLease = try await fixture.cache.activate(.init(changed))
        #expect(await fixture.cache.shell(for: protocolLease) == nil)
        await fixture.cache.record(history: fixture.detail, lease: endpointLease)
        #expect(await fixture.cache.history(threadID: "thread", lease: protocolLease) == nil)
        try await fixture.cache.retainEnvironments([])
        #expect(await fixture.cache.summary().isEmpty)
    }

    @Test func protocolUpgradeDropsOldHistoryButPreservesNewProtocolReads() async throws {
        let fixture = try await OfflineCacheFixture.make()
        defer { fixture.cleanUp() }
        let lease = try await fixture.cache.activate(.init(fixture.environment))
        await fixture.cache.record(shell: fixture.shell, lease: lease)
        await fixture.cache.record(history: fixture.detail, lease: lease)
        var shell = fixture.shell
        shell.orchestrationProtocolVersion = 2
        await fixture.cache.record(shell: shell, lease: lease)
        await fixture.cache.record(history: fixture.detail, lease: lease)
        #expect(await fixture.cache.history(threadID: "thread", lease: lease) == nil)
        var next = fixture.detail
        next.orchestrationProtocolVersion = 2
        await fixture.cache.record(history: next, lease: lease)
        #expect(await fixture.cache.history(threadID: "thread", lease: lease) == next)
    }

    @Test func clearRejectsPendingWritesAndLateHTTPReadThenAcceptsLaterRefresh() async throws {
        let fixture = try await OfflineCacheFixture.make()
        defer { fixture.cleanUp() }
        let client = fixture.client()
        _ = try await client.initialSnapshot()
        await fixture.http.holdNextShell()
        let refresh = Task { try await client.backgroundSnapshot() }
        await fixture.http.waitForHeldShell()
        try await client.clearClientStorage(environmentID: "one")
        await fixture.http.releaseShell()
        _ = try await refresh.value
        try await client.flushClientReadCache()
        #expect(await fixture.cache.summary().isEmpty)
        _ = try await client.backgroundSnapshot()
        try await client.flushClientReadCache()
        #expect(await fixture.cache.summary().first?.shellCount == 1)
        await client.disconnect()
    }

    @Test func clearPreservesDraftsOutboxCredentialsConnectionsAndOtherEnvironmentIcons() async throws {
        let fixture = try await OfflineCacheFixture.make()
        defer { fixture.cleanUp() }
        let client = fixture.client()
        let draftURL = fixture.directory.appendingPathComponent("drafts.json")
        let outboxURL = fixture.directory.appendingPathComponent("outbox.json")
        let drafts = FeatureComposerDraftStore(fileURL: draftURL)
        let outbox = FeatureOutboxStore(fileURL: outboxURL)
        try await drafts.setDraft(.init(text: "Keep draft", attachments: [.init(data: Data([7, 8]), filename: "keep.png", mimeType: "image/png")]), for: "draft")
        try await outbox.enqueue(offlineSubmission())
        let oneIcon = FeatureProjectFaviconCacheKey(environmentID: "one", workspaceRoot: "/project")
        let twoIcon = FeatureProjectFaviconCacheKey(environmentID: "two", workspaceRoot: "/project")
        try await fixture.icons.record(data: Data([1]), revision: "one", for: oneIcon)
        try await fixture.icons.record(data: Data([2]), revision: "two", for: twoIcon)
        let iconGeneration = await fixture.icons.generation(environmentID: "one")
        // The completion holds the token obtained before its HTTP request.
        let completion = OfflineCacheGate()
        let lateHTTPCompletion = Task {
            await completion.wait()
            try await fixture.icons.record(data: Data([3]), revision: "late", for: oneIcon, generation: iconGeneration)
        }
        _ = try await client.initialSnapshot()
        try await client.clearClientStorage(environmentID: "one")
        await completion.open()
        try await lateHTTPCompletion.value
        try await client.flushClientReadCache()
        #expect(try await fixture.icons.value(for: oneIcon) == nil)
        #expect(try await fixture.icons.value(for: twoIcon)?.data == Data([2]))
        try await client.clearClientStorage(environmentID: nil)
        #expect(try await fixture.icons.storageSummary().isEmpty)
        #expect(await fixture.cache.summary().isEmpty)
        #expect(try await FeatureComposerDraftStore(fileURL: draftURL).draft(for: "draft")?.text == "Keep draft")
        #expect(try await FeatureComposerDraftStore(fileURL: draftURL).draft(for: "draft")?.attachments.first?.data == Data([7, 8]))
        #expect(try await FeatureOutboxStore(fileURL: outboxURL).submissions().first?.text == "Keep queued message")
        #expect(try await fixture.environments.load() == [fixture.environment])
        #expect(await fixture.credentials.credential(for: "one")?.accessToken == "test-only")
        await client.disconnect()
    }

    @Test func historiesAreBoundedAndExpandedOrActiveHistoryIsExcluded() async throws {
        let fixture = try await OfflineCacheFixture.make()
        defer { fixture.cleanUp() }
        let lease = try await fixture.cache.activate(.init(fixture.environment))
        var shell = fixture.shell
        shell.threads = (0..<20).flatMap { multiEnvironmentShell(projectID: "project", threadID: "t\($0)", title: "Thread").threads }
        await fixture.cache.record(shell: shell, lease: lease)
        for index in 0..<20 {
            await fixture.cache.record(history: multiEnvironmentDetail(projectID: "project", threadID: "t\(index)"), lease: lease)
        }
        try await fixture.cache.flush()
        #expect(await fixture.cache.summary().first?.threadCount == ClientReadCache.maximumHistories)
        await fixture.cache.record(shell: fixture.shell, lease: lease)
        await fixture.cache.record(history: fixture.detail, lease: lease, expanded: true)
        #expect(await fixture.cache.history(threadID: "thread", lease: lease) == nil)
        var thread = fixture.detail.thread
        thread.orchestrationV2Control = .object(["runs": .array([V2Fixture.run(status: "running")])])
        #expect(!ClientReadCache.isEligible(.init(snapshotSequence: 2, thread: thread)))
        thread.messages = [OrchestrationMessage(id: "large", role: "assistant", text: String(repeating: "x", count: ClientReadCache.maximumHistoryBytes), attachments: nil, turnId: nil, streaming: false, createdAt: V2Fixture.now, updatedAt: V2Fixture.now)]
        thread.orchestrationV2Control = nil
        await fixture.cache.record(history: .init(snapshotSequence: 2, thread: thread), lease: lease)
        #expect(await fixture.cache.history(threadID: "thread", lease: lease) == nil)
    }

    @Test func sameCatalogSharesRevocationAndDifferentCatalogsStayIsolated() async throws {
        let fixture = try await OfflineCacheFixture.make()
        defer { fixture.cleanUp() }
        let first = ClientReadCache.shared(directoryURL: fixture.directory.appendingPathComponent("shared"))
        let second = ClientReadCache.shared(directoryURL: fixture.directory.appendingPathComponent("shared"))
        let other = ClientReadCache.shared(directoryURL: fixture.directory.appendingPathComponent("other"))
        #expect(first === second)
        #expect(first !== other)
        let lease = try await first.activate(.init(fixture.environment))
        await first.record(shell: fixture.shell, lease: lease)
        try await second.clear(environmentID: nil)
        await first.record(shell: fixture.shell, lease: lease)
        try await first.flush()
        #expect(await second.summary().isEmpty)
    }

    @Test func activeRunKeepsTheLastSavedHistory() async throws {
        let fixture = try await OfflineCacheFixture.make()
        defer { fixture.cleanUp() }
        let lease = try await fixture.cache.activate(.init(fixture.environment))
        await fixture.cache.record(shell: fixture.shell, lease: lease)
        await fixture.cache.record(history: fixture.detail, lease: lease)
        try await fixture.cache.flush()
        var running = fixture.detail.thread
        running.orchestrationV2Control = .object(["runs": .array([V2Fixture.run(status: "running")])])
        running.messages = []
        await fixture.cache.record(history: .init(snapshotSequence: 999, thread: running), lease: lease)
        try await fixture.cache.flush()

        let restarted = ClientReadCache(directoryURL: await fixture.cache.directoryURL)
        let restoredLease = try await restarted.activate(.init(fixture.environment))
        let saved = await restarted.history(threadID: "thread", lease: restoredLease)
        #expect(saved?.snapshotSequence == fixture.detail.snapshotSequence)
        #expect(saved?.thread.messages.first?.text == "Saved answer")
    }

    @Test func deletionOfRestoredHistoryDoesNotPromoteItsOldSequence() async throws {
        let fixture = try await OfflineCacheFixture.make()
        defer { fixture.cleanUp() }
        let lease = try await fixture.cache.activate(.init(fixture.environment))
        let high = multiEnvironmentShell(projectID: "project", threadID: "thread", title: "Old", snapshotSequence: 999)
        await fixture.cache.record(shell: high, lease: lease)
        try await fixture.cache.flush()
        let restarted = ClientReadCache(directoryURL: await fixture.cache.directoryURL)
        let restoredLease = try await restarted.activate(.init(fixture.environment))
        try await restarted.remove(threadID: "thread", lease: restoredLease)
        let live = multiEnvironmentShell(projectID: "new-project", threadID: "new-thread", title: "New", snapshotSequence: 1)
        await restarted.record(shell: live, lease: restoredLease)
        try await restarted.flush()
        #expect(await restarted.shell(for: restoredLease)?.snapshotSequence == 1)
        #expect(await restarted.shell(for: restoredLease)?.threads.map(\.id) == ["new-thread"])
    }

    @Test func pruningUsesTheEnvironmentFileLimit() async throws {
        let fixture = try await OfflineCacheFixture.make()
        defer { fixture.cleanUp() }
        for index in 0...ClientReadCache.maximumEnvironments {
            let environment = Environment(
                id: "environment-\(index)", label: "Environment \(index)",
                httpBaseURL: fixture.environment.httpBaseURL,
                webSocketBaseURL: fixture.environment.webSocketBaseURL
            )
            let lease = try await fixture.cache.activate(.init(environment))
            await fixture.cache.record(shell: fixture.shell, lease: lease)
            try await fixture.cache.flush()
        }
        #expect(await fixture.cache.summary().count == ClientReadCache.maximumEnvironments)
        let files = try FileManager.default.contentsOfDirectory(at: await fixture.cache.directoryURL, includingPropertiesForKeys: nil)
        #expect(files.filter { $0.pathExtension == "json" }.count == ClientReadCache.maximumEnvironments)
    }

    @Test func acceptedDeletionCannotBeUndoneByOldShellOrHistory() async throws {
        let fixture = try await OfflineCacheFixture.make()
        defer { fixture.cleanUp() }
        let lease = try await fixture.cache.activate(.init(fixture.environment))
        await fixture.cache.record(shell: fixture.shell, lease: lease)
        await fixture.cache.record(history: fixture.detail, lease: lease)
        try await fixture.cache.flush()
        try await fixture.cache.remove(threadID: "thread", lease: lease)
        await fixture.cache.record(shell: fixture.shell, lease: lease)
        await fixture.cache.record(history: fixture.detail, lease: lease)
        try await fixture.cache.flush()
        let restarted = ClientReadCache(directoryURL: await fixture.cache.directoryURL)
        let nextLease = try await restarted.activate(.init(fixture.environment))
        #expect(await restarted.shell(for: nextLease)?.threads.isEmpty == true)
        #expect(await restarted.history(threadID: "thread", lease: nextLease) == nil)
    }
}

@MainActor
private struct OfflineCacheFixture {
    let directory: URL
    let environment: Environment
    let environments: EnvironmentStore
    let credentials: InMemoryCredentialStore
    let cache: ClientReadCache
    let icons: FeatureProjectFaviconStore
    let http: OfflineCacheHTTPTransport
    let shell: OrchestrationShellSnapshot
    let detail: OrchestrationThreadDetailSnapshot

    static func make() async throws -> Self {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("native-read-cache-\(UUID())")
        let environment = Environment(id: "one", label: "One", httpBaseURL: URL(string: "https://one.example")!, webSocketBaseURL: URL(string: "wss://one.example")!)
        let environments = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        try await environments.save([environment])
        let shell = multiEnvironmentShell(projectID: "project", threadID: "thread", title: "Project")
        let detail = multiEnvironmentDetail(projectID: "project", threadID: "thread", messages: [
            OrchestrationMessage(id: "answer", role: "assistant", text: "Saved answer", attachments: nil, turnId: nil, streaming: false, createdAt: V2Fixture.now, updatedAt: V2Fixture.now),
        ])
        return Self(directory: directory, environment: environment, environments: environments,
                    credentials: InMemoryCredentialStore(credentials: ["one": .init(accessToken: "test-only")]),
                    cache: ClientReadCache(directoryURL: directory.appendingPathComponent("reads"), writeDelay: .seconds(3600)),
                    icons: FeatureProjectFaviconStore(directoryURL: directory.appendingPathComponent("icons")),
                    http: OfflineCacheHTTPTransport(environment: environment, shell: shell, detail: detail), shell: shell, detail: detail)
    }

    func client(cache: ClientReadCache? = nil) -> NativeFeatureClient {
        NativeFeatureClient(
            runtime: EnvironmentRuntime(environmentStore: environments, credentialStore: credentials,
                                        httpTransport: http, webSocketConnector: OfflineCacheConnector(), rpcConnectionWaitTimeout: .milliseconds(1)),
            projectFaviconStore: icons, clientReadCache: cache ?? self.cache,
            fallbackPollingInitialDelay: .seconds(3600), aggregateRefreshInterval: .seconds(3600),
            aggregateIdleRefreshInterval: .seconds(3600), aggregateFailureRefreshInterval: .seconds(3600),
            catchUpDelay: { try await Task.sleep(for: .seconds(3600)) }
        )
    }

    func cleanUp() { try? FileManager.default.removeItem(at: directory) }
}

private func offlineSubmission() -> FeatureQueuedSubmission {
    .init(environmentID: "one", identity: .init(threadID: "thread"),
          threadID: FeatureScopedID.thread(environmentID: "one", wireID: "thread"),
          text: "Keep queued message", selection: nil, runtimeMode: .automatic,
          interactionMode: .standard, attachments: [])
}

private actor OfflineCacheGate {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func open() {
        opened = true
        let pending = waiters
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }
}

private actor OfflineCacheHTTPTransport: HTTPTransport {
    let environment: Environment
    var shell: OrchestrationShellSnapshot
    let detail: OrchestrationThreadDetailSnapshot
    var online = true
    var dispatchCount = 0
    private var holdShell = false
    private let held = OfflineCacheGate()
    private let release = OfflineCacheGate()
    init(environment: Environment, shell: OrchestrationShellSnapshot, detail: OrchestrationThreadDetailSnapshot) {
        self.environment = environment; self.shell = shell; self.detail = detail
    }
    func setOnline(_ online: Bool) { self.online = online }
    func setShell(_ shell: OrchestrationShellSnapshot) { self.shell = shell }
    func holdNextShell() { holdShell = true }
    func waitForHeldShell() async { await held.wait() }
    func releaseShell() async { await release.open() }
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard online else { throw URLError(.notConnectedToInternet) }
        let url = request.url!
        let data: Data
        switch url.path {
        case "/.well-known/t3/environment": data = try legacyEnvironmentDescriptorData(for: environment)
        case "/api/orchestration/shell":
            data = try JSONEncoder.t3.encode(shell)
            if holdShell {
                holdShell = false
                await held.open()
                await release.wait()
            }
        case let path where path.hasPrefix("/api/orchestration/threads/"):
            data = try JSONEncoder.t3.encode(detail)
        case "/api/orchestration/dispatch":
            dispatchCount += 1
            throw URLError(.unsupportedURL)
        default: throw URLError(.cannotConnectToHost)
        }
        return (data, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

private struct OfflineCacheConnector: WebSocketConnecting {
    func connect(to url: URL) async throws -> any WebSocketConnection { throw URLError(.cannotConnectToHost) }
}
