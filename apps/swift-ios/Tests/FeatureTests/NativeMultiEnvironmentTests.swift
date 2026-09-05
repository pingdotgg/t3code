import Foundation
import XCTest
@testable import T3Code

@MainActor
final class NativeMultiEnvironmentTests: XCTestCase {
    func testProviderCatalogueUsesStableProviderAndModelIdentities() {
        let normalized = NativeFeatureClient.normalizedProviders([
            FeatureProvider(
                id: "codex-work",
                name: "Codex",
                models: [
                    FeatureModel(id: "gpt-5.6", name: "GPT-5.6"),
                    FeatureModel(id: "gpt-5.6", name: "Duplicate GPT-5.6"),
                ]
            ),
            FeatureProvider(
                id: "codex-work",
                name: "Duplicate provider",
                models: [
                    FeatureModel(id: "gpt-5.6", name: "Duplicate again"),
                    FeatureModel(id: "gpt-5.6-mini", name: "GPT-5.6 mini"),
                ]
            ),
        ])

        XCTAssertEqual(normalized.map(\.id), ["codex-work"])
        XCTAssertEqual(normalized[0].models.map(\.id), ["gpt-5.6", "gpt-5.6-mini"])
    }

    func testClientReplacementIsSharedWhileStaleClientDisconnects() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-runtime-race-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let originalEnvironment = Environment(
            id: "shared-environment",
            label: "Old endpoint",
            httpBaseURL: URL(string: "https://old.example")!,
            webSocketBaseURL: URL(string: "wss://old.example")!
        )
        let updatedEnvironment = Environment(
            id: originalEnvironment.id,
            label: "New endpoint",
            httpBaseURL: URL(string: "https://new.example")!,
            webSocketBaseURL: URL(string: "wss://new.example")!
        )
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save([updatedEnvironment])
        let staleConnection = BlockingRuntimeCloseConnection()
        let connector = RuntimeReplacementConnector(connection: staleConnection)
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(
                credentials: [
                    originalEnvironment.id: EnvironmentCredential(accessToken: "token"),
                ]
            ),
            httpTransport: RuntimeReplacementHTTPTransport(),
            webSocketConnector: connector
        )
        let original = await runtime.client(for: originalEnvironment)
        await original.connect()
        await staleConnection.waitUntilReceiving()

        let firstLookup = Task { await runtime.client(for: updatedEnvironment) }
        await staleConnection.waitUntilCloseStarted()
        let concurrentLookup = await runtime.client(for: updatedEnvironment)
        await staleConnection.releaseClose()
        let replacement = await firstLookup.value

        XCTAssertTrue(
            replacement === concurrentLookup,
            "Concurrent lookups must share the replacement cached before stale disconnect."
        )
    }

    func testSnapshotMergesEnvironmentsAndRoutesThreadWorkToItsOwner() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let snapshot = try await fixture.client.initialSnapshot()

        XCTAssertEqual(Set(snapshot.projects.map(\.environmentID)), ["one", "two"])
        XCTAssertEqual(Set(snapshot.threads.compactMap(\.wireID)), ["thread-one", "thread-two"])
        let remoteThread = try XCTUnwrap(
            snapshot.threads.first(where: { $0.environmentID == "two" })
        )
        XCTAssertEqual(
            remoteThread.environmentName,
            "Steam Box"
        )
        XCTAssertEqual(
            snapshot.environments.first(where: { $0.id == "two" })?.connectionState,
            .connected
        )

        let detail = try await fixture.client.loadThread(id: remoteThread.id)
        XCTAssertEqual(detail.thread.environmentID, "two")
        XCTAssertEqual(detail.thread.environmentName, "Steam Box")

        try await fixture.client.renameThread(id: remoteThread.id, title: "Remote rename")
        try await fixture.client.sendMessage(
            threadID: remoteThread.id,
            text: "Run this on Steam Box",
            selection: nil
        )

        let routedHosts = await fixture.transport.dispatchHosts()
        XCTAssertEqual(routedHosts, ["two.example", "two.example"])
        await fixture.client.disconnect()
    }

    func testPassiveProviderRefreshKeepsActiveThreadsAndAcceptsTheirNextSequence() async throws {
        let server = MultiEnvironmentConfigurationServer()
        let fixture = try await makeFixture(
            passiveSequence: 5_000,
            webSocketConnector: MultiEnvironmentConfigurationConnector(server: server),
            rpcConnectionWaitTimeout: .seconds(1),
            fallbackPollingInitialDelay: .seconds(60),
            aggregateRefreshInterval: .seconds(60)
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()

        let providers = try await fixture.client.refreshProviders(environmentID: "two")
        XCTAssertEqual(providers.map(\.id), ["codex-two.example"])

        let refreshed = try await fixture.client.initialSnapshot()
        XCTAssertEqual(
            refreshed.threads.filter { $0.environmentID == "one" }.compactMap(\.wireID),
            ["thread-one"]
        )
        XCTAssertEqual(
            refreshed.threads.filter { $0.environmentID == "two" }.compactMap(\.wireID),
            ["thread-two"]
        )

        let current = multiEnvironmentShell(
            projectID: "project-one", threadID: "thread-one", title: "Updated local work"
        )
        let added = multiEnvironmentShell(
            projectID: "project-one", threadID: "thread-new", title: "New local work"
        )
        await fixture.transport.setShell(
            OrchestrationShellSnapshot(
                snapshotSequence: 2,
                projects: current.projects,
                threads: current.threads + added.threads,
                updatedAt: current.updatedAt
            ),
            host: "one.example"
        )

        let updated = try await fixture.client.initialSnapshot()
        XCTAssertEqual(
            Set(updated.threads.filter { $0.environmentID == "one" }.compactMap(\.wireID)),
            ["thread-one", "thread-new"]
        )
        XCTAssertEqual(updated.threads.first { $0.wireID == "thread-one" }?.title, "Updated local work")
        XCTAssertEqual(updated.threads.first { $0.wireID == "thread-new" }?.projectID,
                       FeatureScopedID.project(environmentID: "one", wireID: "project-one"))
        await fixture.client.disconnect()
    }

    func testPassiveEnvironmentSettingsDoNotReplaceActiveThreads() async throws {
        let server = MultiEnvironmentConfigurationServer()
        let fixture = try await makeFixture(
            passiveSequence: 5_000,
            webSocketConnector: MultiEnvironmentConfigurationConnector(server: server),
            rpcConnectionWaitTimeout: .seconds(1),
            fallbackPollingInitialDelay: .seconds(60),
            aggregateRefreshInterval: .seconds(60)
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()

        try await fixture.client.updateServerPreferences(
            environmentID: "two", change: .environmentIcon("mac-mini")
        )

        let snapshot = try await fixture.client.initialSnapshot()
        XCTAssertEqual(
            snapshot.threads.filter { $0.environmentID == "one" }.compactMap(\.wireID),
            ["thread-one"]
        )
        XCTAssertEqual(
            snapshot.threads.filter { $0.environmentID == "two" }.compactMap(\.wireID),
            ["thread-two"]
        )
        let updatedHosts = await server.updatedHosts()
        XCTAssertEqual(updatedHosts, ["two.example"])
        await fixture.client.disconnect()
    }

    func testSharedSettingsFanOutDoesNotReplaceActiveThreads() async throws {
        let server = MultiEnvironmentConfigurationServer()
        let fixture = try await makeFixture(
            passiveSequence: 5_000,
            webSocketConnector: MultiEnvironmentConfigurationConnector(server: server),
            rpcConnectionWaitTimeout: .seconds(1),
            fallbackPollingInitialDelay: .seconds(60),
            aggregateRefreshInterval: .seconds(60)
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()

        try await fixture.client.updateServerPreferences(
            environmentID: "one", change: .defaultThreadEnvMode(.worktree)
        )

        let snapshot = try await fixture.client.initialSnapshot()
        XCTAssertEqual(
            snapshot.threads.filter { $0.environmentID == "one" }.compactMap(\.wireID),
            ["thread-one"]
        )
        XCTAssertEqual(
            snapshot.threads.filter { $0.environmentID == "two" }.compactMap(\.wireID),
            ["thread-two"]
        )
        let updatedHosts = await server.updatedHosts()
        XCTAssertEqual(updatedHosts, ["one.example", "two.example"])
        await fixture.client.disconnect()
    }

    func testRestartPreferenceOnlyReachesComputersThatSupportIt() async throws {
        let server = MultiEnvironmentConfigurationServer(restartSupportHosts: ["one.example"])
        let fixture = try await makeFixture(
            webSocketConnector: MultiEnvironmentConfigurationConnector(server: server),
            rpcConnectionWaitTimeout: .seconds(1),
            fallbackPollingInitialDelay: .seconds(60),
            aggregateRefreshInterval: .seconds(60)
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let snapshot = try await fixture.client.initialSnapshot()
        XCTAssertEqual(snapshot.preferencesByEnvironment?["one"]?.continueThreadsAfterServerUpdate, false)
        XCTAssertNil(snapshot.preferencesByEnvironment?["two"]?.continueThreadsAfterServerUpdate)

        try await fixture.client.updateServerPreferences(
            environmentID: "one", change: .continueThreadsAfterServerUpdate(true)
        )
        let updatedHosts = await server.updatedHosts()
        XCTAssertEqual(updatedHosts, ["one.example"])
        XCTAssertTrue(fixture.client.sharedPreferenceMismatches(environmentID: "one").isEmpty)

        let all = ServerSettingsSnapshot(continueThreadsAfterServerUpdate: true)
        try await fixture.client.updateServerPreferences(
            environmentID: "one",
            change: .sharedPreferences(all.sharedPatch(supportsRestartContinuation: true))
        )
        let supportedSettings = await server.settings(host: "one.example")
        let legacySettings = await server.settings(host: "two.example")
        XCTAssertEqual(supportedSettings["continueThreadsAfterServerUpdate"], .bool(true))
        XCTAssertNil(legacySettings["continueThreadsAfterServerUpdate"])
        XCTAssertEqual(legacySettings["defaultThreadEnvMode"], .string("local"))
        do {
            try await fixture.client.updateServerPreferences(
                environmentID: "two", change: .continueThreadsAfterServerUpdate(true)
            )
            XCTFail("An older computer must not receive the restart preference.")
        } catch is FeatureCapabilityUnavailable {
            // The unsupported action must fail before sending a settings command.
        }
        await fixture.client.disconnect()
    }

    func testBackgroundLivenessKeepsASettledThreadWorking() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        await fixture.transport.setShell(
            multiEnvironmentShell(
                projectID: "project-one",
                threadID: "thread-one",
                title: "Local work",
                backgroundLiveness: .working
            ),
            host: "one.example"
        )

        let snapshot = try await fixture.client.initialSnapshot()
        let thread = try XCTUnwrap(
            snapshot.threads.first(where: { $0.wireID == "thread-one" })
        )
        XCTAssertEqual(thread.state, .working)

        let detail = try await fixture.client.loadThread(id: thread.id)
        XCTAssertEqual(detail.thread.state, .working)
        XCTAssertTrue(detail.backgroundWorkIsActive)
        await fixture.client.disconnect()
    }

    func testNewerDetailSettlementBeatsOlderShellForNonActiveEnvironment() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        await fixture.transport.setShell(
            multiEnvironmentShell(
                projectID: "project-two",
                threadID: "thread-two",
                title: "Remote work",
                snapshotSequence: 90,
                settledOverride: "settled",
                settledAt: "2026-07-31T12:01:00.000Z"
            ),
            host: "two.example"
        )
        await fixture.transport.setDetail(
            multiEnvironmentDetail(
                projectID: "project-two",
                threadID: "thread-two",
                snapshotSequence: 100
            ),
            host: "two.example"
        )

        let snapshot = try await fixture.client.initialSnapshot()
        let thread = try XCTUnwrap(snapshot.threads.first { $0.environmentID == "two" })
        let detail = try await fixture.client.loadThread(id: thread.id)

        XCTAssertFalse(detail.thread.isSettled)
        XCTAssertNil(detail.thread.settlementFacts?.settlementOverride)
        await fixture.client.disconnect()
    }

    func testNewerShellSettlementBeatsStaleDetailForNonActiveEnvironment() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        await fixture.transport.setShell(
            multiEnvironmentShell(
                projectID: "project-two",
                threadID: "thread-two",
                title: "Remote work",
                snapshotSequence: 100,
                settledOverride: "settled",
                settledAt: "2026-07-31T12:01:00.000Z"
            ),
            host: "two.example"
        )
        await fixture.transport.setDetail(
            multiEnvironmentDetail(
                projectID: "project-two",
                threadID: "thread-two",
                snapshotSequence: 90
            ),
            host: "two.example"
        )

        let snapshot = try await fixture.client.initialSnapshot()
        let thread = try XCTUnwrap(snapshot.threads.first { $0.environmentID == "two" })
        let detail = try await fixture.client.loadThread(id: thread.id)

        XCTAssertTrue(detail.thread.isSettled)
        XCTAssertEqual(detail.thread.settlementFacts?.settlementOverride, .settled)

        await fixture.transport.setDetail(
            multiEnvironmentDetail(
                projectID: "project-two",
                threadID: "thread-two",
                snapshotSequence: 95
            ),
            host: "two.example"
        )
        let refreshed = try await fixture.client.loadThread(id: thread.id)
        XCTAssertTrue(refreshed.thread.isSettled)
        XCTAssertEqual(refreshed.thread.settlementFacts?.settlementOverride, .settled)
        await fixture.client.disconnect()
    }

    func testSnapshotKeepsRepositoryIdentityForCrossComputerProjectGrouping() async throws {
        let identity = RepositoryIdentity(
            canonicalKey: "github.com/t3/example",
            locator: .init(
                source: "git-remote",
                remoteName: "origin",
                remoteUrl: "https://github.com/t3/example.git"
            ),
            rootPath: "/work/example",
            displayName: "Example",
            provider: "github",
            owner: "t3",
            name: "example"
        )
        let fixture = try await makeFixture(repositoryIdentity: identity)
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let snapshot = try await fixture.client.initialSnapshot()
        let groups = DailyUXCreationContext.projectGroups(in: snapshot)

        XCTAssertEqual(Set(snapshot.projects.compactMap(\.repositoryIdentity?.canonicalKey)), [
            identity.canonicalKey,
        ])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(Set(groups[0].projects.map(\.environmentID)), ["one", "two"])
        await fixture.client.disconnect()
    }

    func testFailedEnvironmentKeepsItsLastKnownRowsWithoutHidingHealthyDevices() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        _ = try await fixture.client.initialSnapshot()
        await fixture.transport.setReachable(false, host: "two.example")

        let passiveFailure = try await fixture.client.initialSnapshot()
        XCTAssertEqual(
            Set(passiveFailure.threads.compactMap(\.wireID)),
            ["thread-one", "thread-two"]
        )
        XCTAssertEqual(passiveFailure.connection.state, .connected)
        XCTAssertEqual(
            passiveFailure.environments.first(where: { $0.id == "two" })?.connectionState,
            .disconnected
        )

        await fixture.transport.setReachable(false, host: "one.example")
        await fixture.transport.setReachable(true, host: "two.example")

        let activeFailure = try await fixture.client.initialSnapshot()
        XCTAssertEqual(
            Set(activeFailure.threads.compactMap(\.wireID)),
            ["thread-one", "thread-two"]
        )
        XCTAssertEqual(activeFailure.connection.state, .disconnected)
        XCTAssertEqual(activeFailure.connection.environmentName, "Left Book")
        XCTAssertEqual(
            activeFailure.environments.first(where: { $0.id == "two" })?.connectionState,
            .connected
        )
        await fixture.client.disconnect()
    }

    func testOlderHTTPSnapshotCannotReplaceNewerEnvironmentState() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()

        let newer = multiEnvironmentShell(
            projectID: "project-one",
            threadID: "thread-one",
            title: "Newer work"
        )
        await fixture.transport.setShell(
            OrchestrationShellSnapshot(
                snapshotSequence: 3,
                projects: newer.projects,
                threads: newer.threads,
                updatedAt: newer.updatedAt
            ),
            host: "one.example"
        )
        _ = try await fixture.client.initialSnapshot()

        let older = multiEnvironmentShell(
            projectID: "project-one",
            threadID: "thread-one",
            title: "Stale work"
        )
        await fixture.transport.setShell(
            OrchestrationShellSnapshot(
                snapshotSequence: 2,
                projects: older.projects,
                threads: older.threads,
                updatedAt: older.updatedAt
            ),
            host: "one.example"
        )

        let snapshot = try await fixture.client.initialSnapshot()

        XCTAssertEqual(
            snapshot.threads.first(where: { $0.environmentID == "one" })?.title,
            "Newer work"
        )
        await fixture.client.disconnect()
    }

    func testThreadCreationCannotReplaceNewerEnvironmentStateWithAnOlderShell() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()

        let newer = multiEnvironmentShell(
            projectID: "project-one",
            threadID: "thread-one",
            title: "Newer work"
        )
        await fixture.transport.setShell(
            OrchestrationShellSnapshot(
                snapshotSequence: 3,
                projects: newer.projects,
                threads: newer.threads,
                updatedAt: newer.updatedAt
            ),
            host: "one.example"
        )
        let current = try await fixture.client.initialSnapshot()
        let project = try XCTUnwrap(
            current.projects.first(where: { $0.environmentID == "one" })
        )

        let older = multiEnvironmentShell(
            projectID: "project-one",
            threadID: "thread-one",
            title: "Stale work"
        )
        await fixture.transport.setShell(
            OrchestrationShellSnapshot(
                snapshotSequence: 2,
                projects: older.projects,
                threads: older.threads,
                updatedAt: older.updatedAt
            ),
            host: "one.example"
        )

        _ = try await fixture.client.createThread(
            projectID: project.id,
            title: "Another task",
            selection: nil
        )
        let snapshot = try await fixture.client.initialSnapshot()

        XCTAssertEqual(
            snapshot.threads.first(where: { $0.wireID == "thread-one" })?.title,
            "Newer work"
        )
        await fixture.client.disconnect()
    }

    func testPullRequestPagesPreserveCursorsAndTargetOnlyTheRequestedEnvironment() async throws {
        let recorder = PullRequestPageRecorder()
        let fixture = try await makeFixture(
            pullRequestsAvailable: true,
            webSocketConnector: PullRequestPageWebSocketConnector(recorder: recorder),
            rpcConnectionWaitTimeout: .seconds(2)
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let firstPages = try await fixture.client.pullRequestLists(PullRequestListInput())

        XCTAssertEqual(Set(firstPages.map(\.environmentID)), ["one", "two"])
        XCTAssertTrue(firstPages.allSatisfy { $0.result?.truncated == true })
        XCTAssertTrue(firstPages.allSatisfy { $0.result?.nextCursors.isEmpty == false })
        let initialRequests = await recorder.recordedRequests()
        XCTAssertEqual(initialRequests.count, 2)
        XCTAssertEqual(Set(initialRequests.map(\.host)), ["one.example", "two.example"])

        let cursor = try XCTUnwrap(
            firstPages.first(where: { $0.environmentID == "two" })?.result?.nextCursors
        )
        let nextPage = try await fixture.client.pullRequestLists(
            PullRequestListInput(cursors: cursor),
            environmentID: "two"
        )

        XCTAssertEqual(nextPage.map(\.environmentID), ["two"])
        let requests = await recorder.recordedRequests()
        XCTAssertEqual(requests.count, 3)
        XCTAssertEqual(requests.last?.host, "two.example")
        XCTAssertEqual(requests.last?.input.cursors, cursor)
        await fixture.client.disconnect()
    }

    func testBackgroundSnapshotDoesNotStartAggregateRefreshLoops() async throws {
        let loader = CountingAggregateEnvironmentLoader()
        let fixture = try await makeFixture(
            aggregateEnvironmentLoader: { runtime in
                await loader.recordLoad()
                return try await runtime.environments()
            }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let snapshot = try await fixture.client.backgroundSnapshot()

        XCTAssertEqual(snapshot.connection.state, .connected)
        let aggregateLoadCount = await loader.callCount
        XCTAssertEqual(aggregateLoadCount, 0)
        await fixture.client.disconnect()
    }

    func testAggregateRefreshRetriesTransientEnvironmentLoadFailures() async throws {
        let loader = FailOnceAggregateEnvironmentLoader()
        let fixture = try await makeFixture(
            aggregateRefreshInterval: .milliseconds(5),
            aggregateEnvironmentLoader: { runtime in
                try await loader.load(from: runtime)
            }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        _ = try await fixture.client.initialSnapshot()

        await loader.waitForCallCount(2)
        let retryCallCount = await loader.callCount
        XCTAssertGreaterThanOrEqual(retryCallCount, 2)
        await fixture.client.disconnect()
    }

    func testSameClientSnapshotRestartsAggregateRefresh() async throws {
        let loader = BlockingFirstAggregateEnvironmentLoader()
        let fixture = try await makeFixture(
            aggregateRefreshInterval: .milliseconds(5),
            aggregateEnvironmentLoader: { runtime in
                try await loader.load(from: runtime)
            }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        _ = try await fixture.client.initialSnapshot()
        await loader.waitForCallCount(1)

        _ = try await fixture.client.initialSnapshot()

        await loader.waitForFirstLoadCancellation()
        await loader.waitForCallCount(2)
        let restartedCallCount = await loader.callCount
        XCTAssertGreaterThanOrEqual(restartedCallCount, 2)
        await fixture.client.disconnect()
    }

    func testDuplicateWireIDsRemainDistinctAndRouteByEnvironment() async throws {
        let fixture = try await makeFixture(duplicateIDs: true)
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let snapshot = try await fixture.client.initialSnapshot()
        XCTAssertEqual(snapshot.projects.count, 2)
        XCTAssertEqual(snapshot.threads.count, 2)
        XCTAssertEqual(Set(snapshot.projects.map(\.id)).count, 2)
        XCTAssertEqual(Set(snapshot.threads.map(\.id)).count, 2)
        XCTAssertEqual(Set(snapshot.projects.compactMap(\.wireID)), ["project-shared"])
        XCTAssertEqual(Set(snapshot.threads.compactMap(\.wireID)), ["thread-shared"])

        let remote = try XCTUnwrap(
            snapshot.threads.first(where: { $0.environmentID == "two" })
        )
        _ = try await fixture.client.loadThread(id: remote.id)
        try await fixture.client.renameThread(id: remote.id, title: "Remote only")

        let hosts = await fixture.transport.dispatchHosts()
        XCTAssertEqual(hosts, ["two.example"])
        await fixture.client.disconnect()
    }

    func testPassiveCreateUsesOwningProjectDefaultAndFallbackRemainsRoutable() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let snapshot = try await fixture.client.initialSnapshot()
        let remoteProject = try XCTUnwrap(
            snapshot.projects.first(where: { $0.environmentID == "two" })
        )
        let created = try await fixture.client.createThread(
            projectID: remoteProject.id,
            title: "Passive task",
            selection: nil
        )

        XCTAssertEqual(created.environmentID, "two")
        XCTAssertEqual(created.projectID, remoteProject.id)
        XCTAssertNotNil(created.wireID)
        try await fixture.client.renameThread(id: created.id, title: "Fallback routed")

        let records = await fixture.transport.dispatchRecords()
        XCTAssertEqual(records.map(\.host), ["two.example", "two.example"])
        XCTAssertEqual(records[0].command["type"]?.stringValue, "thread.create")
        XCTAssertEqual(records[0].command["projectId"]?.stringValue, "project-two")
        XCTAssertEqual(
            records[0].command["modelSelection"]?["instanceId"]?.stringValue,
            "claudeAgent"
        )
        XCTAssertEqual(
            records[1].command["threadId"]?.stringValue,
            created.wireID
        )
        await fixture.client.disconnect()
    }

    func testPassiveCreateRecoversACommittedThreadAfterItsReplyIsLost() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let snapshot = try await fixture.client.initialSnapshot()
        let project = try XCTUnwrap(
            snapshot.projects.first(where: { $0.environmentID == "two" })
        )
        await fixture.transport.dropNextCreateReply(host: "two.example")

        let created = try await fixture.client.createThread(
            projectID: project.id,
            title: "Recovered task",
            selection: nil
        )

        XCTAssertEqual(created.title, "Recovered task")
        XCTAssertEqual(created.environmentID, "two")
        let creates = await fixture.transport.dispatchRecords().filter {
            $0.command["type"]?.stringValue == "thread.create"
        }
        XCTAssertEqual(creates.count, 1)
        XCTAssertEqual(creates.first?.command["threadId"]?.stringValue, created.wireID)
        await fixture.client.disconnect()
    }

    func testUnarchiveImmediatelyRestoresLiveThreadWhenRefreshIsUnavailable() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let initial = try await fixture.client.initialSnapshot()
        let thread = try XCTUnwrap(
            initial.threads.first(where: { $0.environmentID == "one" })
        )
        let events = fixture.client.events()
        var iterator = events.makeAsyncIterator()
        await fixture.transport.setShellReadsEnabled(false, host: "one.example")

        try await fixture.client.setThreadArchived(id: thread.id, archived: true)
        while let event = await iterator.next() {
            if case let .thread(candidate) = event,
               candidate.id == thread.id,
               candidate.isArchived {
                break
            }
        }
        try await fixture.client.setThreadArchived(id: thread.id, archived: false)
        var restored: FeatureThread?
        while let event = await iterator.next() {
            if case let .thread(candidate) = event,
               candidate.id == thread.id,
               !candidate.isArchived {
                restored = candidate
                break
            }
        }

        XCTAssertEqual(restored?.id, thread.id)
        XCTAssertEqual(restored?.isArchived, false)
        await fixture.client.disconnect()
    }

    func testHTTPFallbackKeepsLiveConnectionReconnecting() async throws {
        let fixture = try await makeFixture(
            fallbackPollingInitialDelay: .milliseconds(40),
            fallbackPollingInterval: .seconds(2)
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()
        let current = multiEnvironmentShell(
            projectID: "project-one",
            threadID: "thread-one",
            title: "Local work"
        )
        let addedProject = OrchestrationProject(
            id: "project-fallback",
            title: "Fallback project",
            workspaceRoot: "/work/fallback",
            repositoryIdentity: nil,
            defaultModelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.4"),
            scripts: [],
            createdAt: current.updatedAt,
            updatedAt: current.updatedAt,
            deletedAt: nil
        )
        await fixture.transport.setShell(
            OrchestrationShellSnapshot(
                snapshotSequence: current.snapshotSequence + 1,
                projects: current.projects + [addedProject],
                threads: current.threads,
                updatedAt: current.updatedAt
            ),
            host: "one.example"
        )
        let events = fixture.client.events()
        var iterator = events.makeAsyncIterator()
        var refreshed: FeatureSnapshot?
        while let event = await iterator.next() {
            if case let .snapshot(snapshot) = event,
               snapshot.projects.contains(where: { $0.wireID == addedProject.id }) {
                refreshed = snapshot
                break
            }
        }

        XCTAssertEqual(refreshed?.connection.state, .reconnecting)
        await fixture.client.disconnect()
    }

    private func makeFixture(
        duplicateIDs: Bool = false,
        passiveSequence: Int = 1,
        repositoryIdentity: RepositoryIdentity? = nil,
        pullRequestsAvailable: Bool = false,
        webSocketConnector: any WebSocketConnecting = UnavailableMultiEnvironmentWebSocketConnector(),
        rpcConnectionWaitTimeout: Duration = .milliseconds(5),
        fallbackPollingInitialDelay: Duration = .seconds(3),
        fallbackPollingInterval: Duration = .seconds(2),
        aggregateRefreshInterval: Duration = .seconds(20),
        aggregateEnvironmentLoader: @escaping @Sendable (EnvironmentRuntime) async throws -> [Environment] = {
            try await $0.environments()
        }
    ) async throws -> MultiEnvironmentFixture {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-native-multi-\(UUID().uuidString)", isDirectory: true)
        let environments = [
            Environment(
                id: "one",
                label: "Left Book",
                httpBaseURL: URL(string: "https://one.example")!,
                webSocketBaseURL: URL(string: "wss://one.example")!,
                descriptor: try multiEnvironmentDescriptor(
                    environmentID: "one",
                    label: "Left Book",
                    pullRequestsAvailable: pullRequestsAvailable
                )
            ),
            Environment(
                id: "two",
                label: "Steam Box",
                httpBaseURL: URL(string: "https://two.example")!,
                webSocketBaseURL: URL(string: "wss://two.example")!,
                descriptor: try multiEnvironmentDescriptor(
                    environmentID: "two",
                    label: "Steam Box",
                    pullRequestsAvailable: pullRequestsAvailable
                )
            ),
        ]
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save(environments)
        try await store.setActiveEnvironment(id: "one")
        let transport = MultiEnvironmentHTTPTransport(
            shells: [
                "one.example": multiEnvironmentShell(
                    projectID: duplicateIDs ? "project-shared" : "project-one",
                    threadID: duplicateIDs ? "thread-shared" : "thread-one",
                    title: "Local work",
                    repositoryIdentity: repositoryIdentity
                ),
                "two.example": multiEnvironmentShell(
                    projectID: duplicateIDs ? "project-shared" : "project-two",
                    threadID: duplicateIDs ? "thread-shared" : "thread-two",
                    title: "Remote work",
                    providerID: "claudeAgent",
                    modelID: "claude-opus-4-1",
                    repositoryIdentity: repositoryIdentity,
                    snapshotSequence: passiveSequence
                ),
            ]
        )
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(
                credentials: [
                    "one": EnvironmentCredential(accessToken: "one-token"),
                    "two": EnvironmentCredential(accessToken: "two-token"),
                ]
            ),
            httpTransport: transport,
            webSocketConnector: webSocketConnector,
            rpcConnectionWaitTimeout: rpcConnectionWaitTimeout
        )
        let settings = UserDefaults(
            suiteName: "t3-native-multi-\(UUID().uuidString)"
        )!
        return MultiEnvironmentFixture(
            directory: directory,
            transport: transport,
            client: NativeFeatureClient(
                runtime: runtime,
                settingsStore: settings,
                fallbackPollingInitialDelay: fallbackPollingInitialDelay,
                fallbackPollingInterval: fallbackPollingInterval,
                aggregateRefreshInterval: aggregateRefreshInterval,
                aggregateEnvironmentLoader: aggregateEnvironmentLoader
            )
        )
    }
}

private actor FailOnceAggregateEnvironmentLoader {
    private(set) var callCount = 0
    private var callCountWaiters: [(
        target: Int,
        continuation: CheckedContinuation<Void, Never>
    )] = []

    func load(from runtime: EnvironmentRuntime) async throws -> [Environment] {
        callCount += 1
        resumeSatisfiedWaiters()
        if callCount == 1 {
            throw URLError(.cannotOpenFile)
        }
        return try await runtime.environments()
    }

    func waitForCallCount(_ target: Int) async {
        guard callCount < target else { return }
        await withCheckedContinuation { continuation in
            callCountWaiters.append((target, continuation))
        }
    }

    private func resumeSatisfiedWaiters() {
        let satisfied = callCountWaiters.filter { callCount >= $0.target }
        callCountWaiters.removeAll { callCount >= $0.target }
        for waiter in satisfied {
            waiter.continuation.resume()
        }
    }
}

private actor CountingAggregateEnvironmentLoader {
    private(set) var callCount = 0

    func recordLoad() {
        callCount += 1
    }
}

private actor BlockingFirstAggregateEnvironmentLoader {
    private(set) var callCount = 0
    private var callCountWaiters: [(
        target: Int,
        continuation: CheckedContinuation<Void, Never>
    )] = []
    private var firstLoadContinuation: CheckedContinuation<Void, Never>?
    private var firstLoadCancellationObserved = false
    private var firstLoadCancellationWaiters: [CheckedContinuation<Void, Never>] = []

    func load(from runtime: EnvironmentRuntime) async throws -> [Environment] {
        callCount += 1
        resumeSatisfiedWaiters()
        if callCount == 1 {
            await withTaskCancellationHandler {
                await withCheckedContinuation { continuation in
                    firstLoadContinuation = continuation
                    if Task.isCancelled {
                        firstLoadContinuation = nil
                        continuation.resume()
                    }
                }
            } onCancel: {
                Task { await self.recordFirstLoadCancellation() }
            }
            try Task.checkCancellation()
        }
        return try await runtime.environments()
    }

    func waitForCallCount(_ target: Int) async {
        guard callCount < target else { return }
        await withCheckedContinuation { continuation in
            callCountWaiters.append((target, continuation))
        }
    }

    func waitForFirstLoadCancellation() async {
        guard !firstLoadCancellationObserved else { return }
        await withCheckedContinuation { continuation in
            firstLoadCancellationWaiters.append(continuation)
        }
    }

    private func recordFirstLoadCancellation() {
        firstLoadCancellationObserved = true
        firstLoadContinuation?.resume()
        firstLoadContinuation = nil
        let waiters = firstLoadCancellationWaiters
        firstLoadCancellationWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }

    private func resumeSatisfiedWaiters() {
        let satisfied = callCountWaiters.filter { callCount >= $0.target }
        callCountWaiters.removeAll { callCount >= $0.target }
        for waiter in satisfied {
            waiter.continuation.resume()
        }
    }
}

private actor RuntimeReplacementConnector: WebSocketConnecting {
    let connection: BlockingRuntimeCloseConnection

    init(connection: BlockingRuntimeCloseConnection) {
        self.connection = connection
    }

    func connect(to _: URL) -> any WebSocketConnection {
        connection
    }
}

private actor BlockingRuntimeCloseConnection: WebSocketConnection {
    private var receiveContinuation: CheckedContinuation<Data, Error>?
    private var receiveWaiters: [CheckedContinuation<Void, Never>] = []
    private var closeContinuation: CheckedContinuation<Void, Never>?
    private var closeWaiters: [CheckedContinuation<Void, Never>] = []

    func send(_: Data) {}

    func receive() async throws -> Data {
        let waiters = receiveWaiters
        receiveWaiters.removeAll()
        waiters.forEach { $0.resume() }
        return try await withCheckedThrowingContinuation { continuation in
            receiveContinuation = continuation
        }
    }

    func close() async {
        receiveContinuation?.resume(throwing: CancellationError())
        receiveContinuation = nil
        let waiters = closeWaiters
        closeWaiters.removeAll()
        waiters.forEach { $0.resume() }
        await withCheckedContinuation { continuation in
            closeContinuation = continuation
        }
    }

    func waitUntilReceiving() async {
        guard receiveContinuation == nil else { return }
        await withCheckedContinuation { continuation in
            receiveWaiters.append(continuation)
        }
    }

    func waitUntilCloseStarted() async {
        guard closeContinuation == nil else { return }
        await withCheckedContinuation { continuation in
            closeWaiters.append(continuation)
        }
    }

    func releaseClose() {
        closeContinuation?.resume()
        closeContinuation = nil
    }
}

private actor RuntimeReplacementHTTPTransport: HTTPTransport {
    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        guard request.url?.path == "/api/auth/websocket-ticket" else {
            throw URLError(.unsupportedURL)
        }
        return (
            Data("{\"ticket\":\"ticket\",\"expiresAt\":\"2026-08-01T12:05:00.000Z\"}".utf8),
            multiEnvironmentResponse(request)
        )
    }
}

private struct MultiEnvironmentFixture {
    let directory: URL
    let transport: MultiEnvironmentHTTPTransport
    let client: NativeFeatureClient
}

private actor MultiEnvironmentHTTPTransport: HTTPTransport {
    private let shells: [String: OrchestrationShellSnapshot]
    private var shellData: [String: Data]
    private var detailData: [String: [String: Data]] = [:]
    private var reachableHosts: Set<String>
    private var shellReadsEnabledHosts: Set<String>
    private var dispatched: [MultiEnvironmentDispatchRecord] = []
    private var hostsDroppingNextCreateReply = Set<String>()

    init(shells: [String: OrchestrationShellSnapshot]) {
        self.shells = shells
        shellData = shells.mapValues { try! JSONEncoder.t3.encode($0) }
        reachableHosts = Set(shells.keys)
        shellReadsEnabledHosts = Set(shells.keys)
    }

    func setReachable(_ reachable: Bool, host: String) {
        if reachable {
            reachableHosts.insert(host)
        } else {
            reachableHosts.remove(host)
        }
    }

    func setShellReadsEnabled(_ enabled: Bool, host: String) {
        if enabled {
            shellReadsEnabledHosts.insert(host)
        } else {
            shellReadsEnabledHosts.remove(host)
        }
    }

    func setShell(_ shell: OrchestrationShellSnapshot, host: String) {
        shellData[host] = try! JSONEncoder.t3.encode(shell)
    }

    func setDetail(
        _ detail: OrchestrationThreadDetailSnapshot,
        host: String
    ) {
        detailData[host, default: [:]][detail.thread.id] = try! JSONEncoder.t3.encode(detail)
    }

    func dispatchHosts() -> [String] {
        dispatched.map(\.host)
    }

    func dispatchRecords() -> [MultiEnvironmentDispatchRecord] {
        dispatched
    }

    func dropNextCreateReply(host: String) {
        hostsDroppingNextCreateReply.insert(host)
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let host = request.url?.host ?? ""
        guard reachableHosts.contains(host) else {
            throw URLError(.cannotConnectToHost)
        }
        let path = request.url?.path ?? ""
        if path == "/api/orchestration/shell",
           shellReadsEnabledHosts.contains(host),
           let data = shellData[host] {
            return (data, multiEnvironmentResponse(request))
        }
        if path.hasPrefix("/api/orchestration/threads/") {
            let threadID = request.url?.lastPathComponent.removingPercentEncoding ?? "thread"
            if let data = detailData[host]?[threadID] {
                return (data, multiEnvironmentResponse(request))
            }
            let projectID = shells[host]?.threads
                .first(where: { $0.id == threadID })?
                .projectId ?? shells[host]?.projects.first?.id ?? "project"
            return (
                try JSONEncoder.t3.encode(
                    multiEnvironmentDetail(projectID: projectID, threadID: threadID)
                ),
                multiEnvironmentResponse(request)
            )
        }
        if path == "/api/orchestration/dispatch" {
            guard let body = request.httpBody else { throw URLError(.badServerResponse) }
            let command = try JSONDecoder.t3.decode(JSONValue.self, from: body)
            dispatched.append(
                MultiEnvironmentDispatchRecord(host: host, command: command)
            )
            if command["type"]?.stringValue == "thread.create",
               hostsDroppingNextCreateReply.remove(host) != nil,
               let projectID = command["projectId"]?.stringValue,
               let threadID = command["threadId"]?.stringValue {
                let model = command["modelSelection"]
                shellData[host] = try JSONEncoder.t3.encode(
                    multiEnvironmentShell(
                        projectID: projectID,
                        threadID: threadID,
                        title: command["title"]?.stringValue ?? "New thread",
                        providerID: model?["instanceId"]?.stringValue ?? "codex",
                        modelID: model?["model"]?.stringValue ?? "gpt-5.6-sol"
                    )
                )
                throw URLError(.networkConnectionLost)
            }
            return (
                try JSONEncoder.t3.encode(DispatchResult(sequence: 2)),
                multiEnvironmentResponse(request)
            )
        }
        if path == "/api/auth/websocket-ticket" {
            return (
                Data(
                    """
                    {"ticket":"ticket","expiresAt":"2026-07-31T12:05:00.000Z"}
                    """.utf8
                ),
                multiEnvironmentResponse(request)
            )
        }
        throw URLError(.unsupportedURL)
    }
}

private struct MultiEnvironmentDispatchRecord: Sendable {
    let host: String
    let command: JSONValue
}

private struct UnavailableMultiEnvironmentWebSocketConnector: WebSocketConnecting {
    func connect(to _: URL) async throws -> any WebSocketConnection {
        throw URLError(.cannotConnectToHost)
    }
}

private actor MultiEnvironmentConfigurationServer {
    private var settingsByHost: [String: [String: JSONValue]] = [:]
    private var settingsUpdateHosts: [String] = []
    private let restartSupportHosts: Set<String>

    init(restartSupportHosts: Set<String> = []) {
        self.restartSupportHosts = restartSupportHosts
    }

    func updatedHosts() -> [String] { settingsUpdateHosts }
    func settings(host: String) -> [String: JSONValue] { settingsByHost[host] ?? [:] }

    func response(to request: JSONValue, host: String) throws -> JSONValue? {
        guard let tag = request["tag"]?.stringValue,
              case let .number(id)? = request["id"] else { return nil }
        let value: JSONValue
        switch tag {
        case RPCMethod.subscribeServerConfig.rawValue:
            return .object([
                "_tag": .string("Chunk"), "requestId": .number(id),
                "values": .array([.object([
                    "type": .string("snapshot"), "config": config(host: host),
                ])]),
            ])
        case RPCMethod.serverRefreshProviders.rawValue:
            value = .object(["providers": .array([.object([
                "instanceId": .string("codex-\(host)"), "driver": .string("codex"),
                "enabled": .bool(true), "installed": .bool(true), "status": .string("ready"),
                "auth": .object(["status": .string("authenticated")]),
                "checkedAt": .string("2026-09-04T12:00:00.000Z"), "models": .array([]),
            ])])])
        case RPCMethod.serverUpdateSettings.rawValue:
            guard case let .object(patch)? = request["payload"]?["patch"] else {
                throw URLError(.badServerResponse)
            }
            settingsUpdateHosts.append(host)
            settingsByHost[host, default: [:]].merge(patch) { _, next in next }
            value = .object(settingsByHost[host] ?? [:])
        case RPCMethod.getArchivedShellSnapshot.rawValue:
            value = try JSONValue.encode(OrchestrationShellSnapshot(
                snapshotSequence: 0, projects: [], threads: [], updatedAt: "2026-09-04T12:00:00.000Z"
            ))
        default:
            return nil
        }
        return .object([
            "_tag": .string("Exit"), "requestId": .number(id),
            "exit": .object(["_tag": .string("Success"), "value": value]),
        ])
    }

    private func config(host: String) -> JSONValue {
        let environmentID = host == "one.example" ? "one" : "two"
        return .object([
            "providers": .array([]), "settings": .object(settingsByHost[host] ?? [:]),
            "environment": .object([
                "environmentId": .string(environmentID), "label": .string(host),
                "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
                "serverVersion": .string("1.0.0"),
                "capabilities": .object([
                    "threadAutoSettlement": .bool(true), "environmentIcon": .bool(true),
                    "threadRestartContinuation": .bool(restartSupportHosts.contains(host)),
                ]),
            ]),
        ])
    }
}

private struct MultiEnvironmentConfigurationConnector: WebSocketConnecting {
    let server: MultiEnvironmentConfigurationServer

    func connect(to url: URL) -> any WebSocketConnection {
        MultiEnvironmentConfigurationConnection(host: url.host ?? "", server: server)
    }
}

private actor MultiEnvironmentConfigurationConnection: WebSocketConnection {
    private let host: String
    private let server: MultiEnvironmentConfigurationServer
    private var responses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?
    private var closed = false

    init(host: String, server: MultiEnvironmentConfigurationServer) {
        self.host = host
        self.server = server
    }

    func send(_ data: Data) async throws {
        guard !closed else { throw URLError(.networkConnectionLost) }
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard let response = try await server.response(to: request, host: host) else { return }
        let data = try JSONEncoder.t3.encode(response)
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else {
            responses.append(data)
        }
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
}

private struct PullRequestPageRequest: Sendable {
    let host: String
    let input: PullRequestListInput
}

private actor PullRequestPageRecorder {
    private var requests: [PullRequestPageRequest] = []

    func record(host: String, input: PullRequestListInput) {
        requests.append(PullRequestPageRequest(host: host, input: input))
    }

    func recordedRequests() -> [PullRequestPageRequest] {
        requests
    }
}

private struct PullRequestPageWebSocketConnector: WebSocketConnecting {
    let recorder: PullRequestPageRecorder

    func connect(to url: URL) -> any WebSocketConnection {
        PullRequestPageWebSocketConnection(host: url.host ?? "", recorder: recorder)
    }
}

private actor PullRequestPageWebSocketConnection: WebSocketConnection {
    private let host: String
    private let recorder: PullRequestPageRecorder
    private var queuedResponses: [Data] = []
    private var receiveContinuation: CheckedContinuation<Data, Error>?

    init(host: String, recorder: PullRequestPageRecorder) {
        self.host = host
        self.recorder = recorder
    }

    func send(_ data: Data) async throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard request["tag"]?.stringValue == RPCMethod.pullRequestsList.rawValue,
              case let .number(requestID)? = request["id"],
              let payload = request["payload"] else { return }

        let input = try payload.decode(PullRequestListInput.self)
        await recorder.record(host: host, input: input)
        let page = PullRequestListResult(
            viewers: ["github.com": "theo"],
            providers: [],
            entries: [],
            errors: [],
            truncated: true,
            nextCursors: ["github.com t3/repo": "cursor-\(host)"]
        )
        let response = JSONValue.object([
            "_tag": .string("Exit"),
            "requestId": .number(requestID),
            "exit": .object([
                "_tag": .string("Success"),
                "value": try JSONValue.encode(page),
            ]),
        ])
        let responseData = try JSONEncoder.t3.encode(response)
        if let receiveContinuation {
            self.receiveContinuation = nil
            receiveContinuation.resume(returning: responseData)
        } else {
            queuedResponses.append(responseData)
        }
    }

    func receive() async throws -> Data {
        if !queuedResponses.isEmpty {
            return queuedResponses.removeFirst()
        }
        return try await withCheckedThrowingContinuation { continuation in
            receiveContinuation = continuation
        }
    }

    func close() {
        receiveContinuation?.resume(throwing: CancellationError())
        receiveContinuation = nil
    }
}

private func multiEnvironmentDescriptor(
    environmentID: String,
    label: String,
    pullRequestsAvailable: Bool
) throws -> EnvironmentDescriptor? {
    guard pullRequestsAvailable else { return nil }
    let value = JSONValue.object([
        "environmentId": .string(environmentID),
        "label": .string(label),
        "platform": .object([
            "os": .string("darwin"),
            "arch": .string("arm64"),
        ]),
        "serverVersion": .string("0.1.0"),
        "capabilities": .object([
            "repositoryIdentity": .bool(true),
            "pullRequests": .bool(true),
        ]),
    ])
    return try value.decode(EnvironmentDescriptor.self)
}

func multiEnvironmentShell(
    projectID: String,
    threadID: String,
    title: String,
    providerID: String = "codex",
    modelID: String = "gpt-5.6-sol",
    repositoryIdentity: RepositoryIdentity? = nil,
    backgroundLiveness: OrchestrationBackgroundLiveness? = nil,
    snapshotSequence: Int = 1,
    settledOverride: String? = nil,
    settledAt: String? = nil
) -> OrchestrationShellSnapshot {
    let timestamp = "2026-07-31T12:00:00.000Z"
    let model = ModelSelection(instanceId: providerID, model: modelID)
    return OrchestrationShellSnapshot(
        snapshotSequence: snapshotSequence,
        projects: [
            OrchestrationProject(
                id: projectID,
                title: title,
                workspaceRoot: "/work/\(projectID)",
                repositoryIdentity: repositoryIdentity,
                defaultModelSelection: model,
                scripts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                deletedAt: nil
            ),
        ],
        threads: [
            OrchestrationThreadShell(
                id: threadID,
                projectId: projectID,
                title: title,
                modelSelection: model,
                runtimeMode: .fullAccess,
                interactionMode: .default,
                branch: "feat/multi-device",
                worktreePath: nil,
                latestTurn: nil,
                createdAt: timestamp,
                updatedAt: timestamp,
                archivedAt: nil,
                settledOverride: settledOverride,
                settledAt: settledAt,
                snoozedUntil: nil,
                snoozedAt: nil,
                pinnedAt: nil,
                session: nil,
                latestUserMessageAt: nil,
                hasPendingApprovals: false,
                hasPendingUserInput: false,
                hasActionableProposedPlan: false,
                backgroundLiveness: backgroundLiveness
            ),
        ],
        updatedAt: timestamp
    )
}

func multiEnvironmentDetail(
    projectID: String,
    threadID: String,
    snapshotSequence: Int = 2,
    settledOverride: String? = nil,
    settledAt: String? = nil,
    messages: [OrchestrationMessage] = []
) -> OrchestrationThreadDetailSnapshot {
    let timestamp = "2026-07-31T12:00:00.000Z"
    return OrchestrationThreadDetailSnapshot(
        snapshotSequence: snapshotSequence,
        thread: OrchestrationThread(
            id: threadID,
            projectId: projectID,
            title: threadID,
            modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            interactionMode: .default,
            branch: "feat/multi-device",
            worktreePath: nil,
            latestTurn: nil,
            createdAt: timestamp,
            updatedAt: timestamp,
            archivedAt: nil,
            settledOverride: settledOverride,
            settledAt: settledAt,
            snoozedUntil: nil,
            snoozedAt: nil,
            pinnedAt: nil,
            deletedAt: nil,
            messages: messages,
            activities: [],
            checkpoints: [],
            session: nil
        )
    )
}

private func multiEnvironmentResponse(_ request: URLRequest) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
    )!
}
