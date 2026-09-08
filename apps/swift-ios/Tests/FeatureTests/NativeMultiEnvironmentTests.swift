import Foundation
import Darwin
import Observation
import Testing
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
        let fixture = try await Self.makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let snapshot = try await fixture.hydratedSnapshot()

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
        let selection = FeatureSelection(
            providerID: "codex",
            modelID: "gpt-5.6-sol",
            options: [
                .init(id: "reasoningEffort", value: .string("xhigh")),
                .init(id: "serviceTier", value: .string("priority")),
            ]
        )
        try await fixture.client.sendMessage(
            threadID: remoteThread.id,
            text: "Run this on Steam Box",
            selection: selection
        )

        let records = await fixture.transport.dispatchRecords()
        XCTAssertEqual(records.map(\.host), ["two.example", "two.example"])
        let turnSelection = try XCTUnwrap(
            records.last?.command["modelSelection"]?.decode(ModelSelection.self)
        )
        XCTAssertEqual(turnSelection.instanceId, selection.providerID)
        XCTAssertEqual(turnSelection.model, selection.modelID)
        XCTAssertEqual(
            turnSelection.options,
            [
                .init(id: "reasoningEffort", value: .string("xhigh")),
                .init(id: "serviceTier", value: .string("priority")),
            ]
        )
        await fixture.client.disconnect()
    }

    func testPassiveProviderRefreshKeepsActiveThreadsAndAcceptsTheirNextSequence() async throws {
        let server = MultiEnvironmentConfigurationServer()
        let fixture = try await Self.makeFixture(
            requireConfiguration: true, passiveSequence: 5_000,
            webSocketConnector: MultiEnvironmentConfigurationConnector(server: server),
            rpcConnectionWaitTimeout: .seconds(1),
            fallbackPollingInitialDelay: .seconds(60),
            aggregateRefreshInterval: .seconds(60)
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.hydratedSnapshot()

        let providers = try await fixture.client.refreshProviders(environmentID: "two")
        XCTAssertEqual(providers.map(\.id), ["codex-two.example"])

        let refreshed = try await fixture.hydratedSnapshot()
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

        let updated = try await fixture.hydratedSnapshot()
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
        let fixture = try await Self.makeFixture(
            requireConfiguration: true, passiveSequence: 5_000,
            webSocketConnector: MultiEnvironmentConfigurationConnector(server: server),
            rpcConnectionWaitTimeout: .seconds(1),
            fallbackPollingInitialDelay: .seconds(60),
            aggregateRefreshInterval: .seconds(60)
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.hydratedSnapshot()

        try await fixture.client.updateServerPreferences(
            environmentID: "two", change: .environmentIcon("mac-mini")
        )

        let snapshot = try await fixture.hydratedSnapshot()
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

    func testMachineModelDefaultsRefreshCachedProjectsWithoutChangingOtherEnvironments() async throws {
        let server = MultiEnvironmentConfigurationServer()
        let fixture = try await Self.makeFixture(
            requireConfiguration: true,
            webSocketConnector: MultiEnvironmentConfigurationConnector(server: server),
            rpcConnectionWaitTimeout: .seconds(1),
            fallbackPollingInitialDelay: .seconds(60),
            aggregateRefreshInterval: .seconds(60)
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let source = multiEnvironmentShell(projectID: "project-two", threadID: "thread-two", title: "Remote work")
        var projectFields = try JSONValue.encode(source.projects[0]).decode([String: JSONValue].self)
        projectFields["defaultModelSelection"] = .null
        let project = try JSONValue.object(projectFields).decode(OrchestrationProject.self)
        await fixture.transport.setShell(OrchestrationShellSnapshot(
            snapshotSequence: source.snapshotSequence, projects: [project],
            threads: source.threads, updatedAt: source.updatedAt
        ), host: "two.example")
        let initial = try await fixture.hydratedSnapshot()
        XCTAssertNil(initial.projects.first { $0.environmentID == "two" }?.defaultSelection)
        let localDefault = initial.projects.first { $0.environmentID == "one" }?.defaultSelection

        for model in ["claude-opus-5", "claude-sonnet-5"] {
            let selection = ModelSelection(instanceId: "claude-work", model: model)
            try await fixture.client.updateServerPreferences(environmentID: "two", change: .sharedPreferences(.object([
                "defaultModelSelection": try JSONValue.encode(selection),
            ])))
            let snapshot = try await fixture.hydratedSnapshot()
            XCTAssertEqual(snapshot.projects.first { $0.environmentID == "two" }?.defaultSelection?.modelID, model)
            XCTAssertEqual(snapshot.projects.first { $0.environmentID == "one" }?.defaultSelection, localDefault)
        }

        await fixture.transport.setShell(source, host: "two.example")
        let overridden = try await fixture.hydratedSnapshot()
        XCTAssertEqual(overridden.projects.first { $0.environmentID == "two" }?.defaultSelection?.modelID, "gpt-5.6-sol")
        await fixture.client.disconnect()
    }

    func testSharedSettingsFanOutDoesNotReplaceActiveThreads() async throws {
        let server = MultiEnvironmentConfigurationServer()
        let fixture = try await Self.makeFixture(
            requireConfiguration: true, passiveSequence: 5_000,
            webSocketConnector: MultiEnvironmentConfigurationConnector(server: server),
            rpcConnectionWaitTimeout: .seconds(1),
            fallbackPollingInitialDelay: .seconds(60),
            aggregateRefreshInterval: .seconds(60)
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.hydratedSnapshot()

        try await fixture.client.updateServerPreferences(
            environmentID: "one", change: .defaultThreadEnvMode(.worktree)
        )

        let snapshot = try await fixture.hydratedSnapshot()
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
        let fixture = try await Self.makeFixture(
            requireConfiguration: true,
            webSocketConnector: MultiEnvironmentConfigurationConnector(server: server),
            rpcConnectionWaitTimeout: .seconds(1),
            fallbackPollingInitialDelay: .seconds(60),
            aggregateRefreshInterval: .seconds(60)
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let snapshot = try await fixture.hydratedSnapshot()
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
        let fixture = try await Self.makeFixture()
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

        let snapshot = try await fixture.hydratedSnapshot()
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
        let fixture = try await Self.makeFixture()
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

        let snapshot = try await fixture.hydratedSnapshot()
        let thread = try XCTUnwrap(snapshot.threads.first { $0.environmentID == "two" })
        let detail = try await fixture.client.loadThread(id: thread.id)

        XCTAssertFalse(detail.thread.isSettled)
        XCTAssertNil(detail.thread.settlementFacts?.settlementOverride)
        await fixture.client.disconnect()
    }

    func testNewerShellSettlementBeatsStaleDetailForNonActiveEnvironment() async throws {
        let fixture = try await Self.makeFixture()
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

        let snapshot = try await fixture.hydratedSnapshot()
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

    func testNewerShellTitleAndRegenerationStateBeatStaleDetail() async throws {
        let fixture = try await Self.makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        await fixture.transport.setShell(
            multiEnvironmentShell(
                projectID: "project-two",
                threadID: "thread-two",
                title: "Regenerated title",
                snapshotSequence: 100,
                titleRegeneration: ThreadTitleRegeneration(
                    requestId: "command-regenerate",
                    startedAt: "2026-07-31T12:01:00.000Z"
                )
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

        let snapshot = try await fixture.hydratedSnapshot()
        let thread = try XCTUnwrap(snapshot.threads.first { $0.environmentID == "two" })
        XCTAssertTrue(thread.isRegeneratingTitle)

        // The detail fixture still carries the pre-regeneration title.
        let detail = try await fixture.client.loadThread(id: thread.id)
        XCTAssertEqual(detail.thread.title, "Regenerated title")
        XCTAssertTrue(detail.thread.isRegeneratingTitle)
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
        let fixture = try await Self.makeFixture(repositoryIdentity: identity)
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let snapshot = try await fixture.hydratedSnapshot()
        let groups = DailyUXCreationContext.projectGroups(in: snapshot)

        XCTAssertEqual(Set(snapshot.projects.compactMap(\.repositoryIdentity?.canonicalKey)), [
            identity.canonicalKey,
        ])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(Set(groups[0].projects.map(\.environmentID)), ["one", "two"])
        await fixture.client.disconnect()
    }

    func testFailedEnvironmentKeepsItsLastKnownRowsWithoutHidingHealthyDevices() async throws {
        let fixture = try await Self.makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        _ = try await fixture.hydratedSnapshot()
        await fixture.transport.setReachable(false, host: "two.example")

        let passiveFailure = try await fixture.hydratedSnapshot()
        XCTAssertEqual(
            Set(passiveFailure.threads.compactMap(\.wireID)),
            ["thread-one", "thread-two"]
        )
        XCTAssertEqual(passiveFailure.environments.first { $0.id == "one" }?.connectionState, .connected)
        XCTAssertEqual(
            passiveFailure.environments.first(where: { $0.id == "two" })?.connectionState,
            .disconnected
        )

        await fixture.transport.setReachable(false, host: "one.example")
        await fixture.transport.setReachable(true, host: "two.example")

        let activeFailure = try await fixture.hydratedSnapshot()
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

    func testCachedShellRowsApplySettlementAndRemoveDeletedRoutes() async throws {
        let fixture = try await Self.makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let initial = try await fixture.hydratedSnapshot()
        let original = try XCTUnwrap(initial.threads.first { $0.environmentID == "two" })
        let updated = multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Remote work",
            providerID: "claudeAgent", modelID: "claude-opus-4-1",
            backgroundLiveness: .monitoring, snapshotSequence: 2,
            settledOverride: "settled", settledAt: "2026-07-31T12:01:00.000Z"
        )
        await fixture.transport.setShell(updated, host: "two.example")
        let refreshed = try await fixture.hydratedSnapshot()
        let settled = try XCTUnwrap(refreshed.threads.first { $0.id == original.id })
        XCTAssertEqual(settled.updatedAt, original.updatedAt)
        XCTAssertTrue(settled.isSettled)
        XCTAssertEqual(settled.state, .monitoring)
        XCTAssertEqual(refreshed.threads.first { $0.environmentID == "one" },
                       initial.threads.first { $0.environmentID == "one" })

        await fixture.transport.setShell(
            OrchestrationShellSnapshot(
                snapshotSequence: 3, projects: updated.projects, threads: [], updatedAt: updated.updatedAt
            ),
            host: "two.example"
        )
        let removed = try await fixture.hydratedSnapshot()
        XCTAssertFalse(removed.threads.contains { $0.id == original.id })
        XCTAssertEqual(removed.projects.first { $0.environmentID == "two" }?.threadCount, 0)
        do {
            _ = try await fixture.client.loadThread(id: original.id)
            XCTFail("Removed threads must no longer have a route.")
        } catch {
            XCTAssertEqual(error.localizedDescription, "The selected thread is no longer available.")
        }
        await fixture.client.disconnect()
    }

    func testOlderHTTPSnapshotCannotReplaceNewerEnvironmentState() async throws {
        let fixture = try await Self.makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.hydratedSnapshot()

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
        _ = try await fixture.hydratedSnapshot()

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

        let snapshot = try await fixture.hydratedSnapshot()

        XCTAssertEqual(
            snapshot.threads.first(where: { $0.environmentID == "one" })?.title,
            "Newer work"
        )
        await fixture.client.disconnect()
    }

    func testThreadCreationCannotReplaceNewerEnvironmentStateWithAnOlderShell() async throws {
        let fixture = try await Self.makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.hydratedSnapshot()

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
        let current = try await fixture.hydratedSnapshot()
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
        let snapshot = try await fixture.hydratedSnapshot()

        XCTAssertEqual(
            snapshot.threads.first(where: { $0.wireID == "thread-one" })?.title,
            "Newer work"
        )
        await fixture.client.disconnect()
    }

    func testPullRequestPagesPreserveCursorsAndTargetOnlyTheRequestedEnvironment() async throws {
        let recorder = PullRequestPageRecorder()
        let fixture = try await Self.makeFixture(
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
        let fixture = try await Self.makeFixture(
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
        let fixture = try await Self.makeFixture(
            aggregateRefreshInterval: .milliseconds(5),
            aggregateFailureRefreshInterval: .milliseconds(5),
            aggregateEnvironmentLoader: { runtime in
                try await loader.load(from: runtime)
            }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        _ = try await fixture.hydratedSnapshot()

        await loader.waitForCallCount(2)
        let retryCallCount = await loader.callCount
        XCTAssertGreaterThanOrEqual(retryCallCount, 2)
        await fixture.client.disconnect()
    }

    func testSameClientSnapshotRestartsAggregateRefresh() async throws {
        let loader = BlockingFirstAggregateEnvironmentLoader()
        let fixture = try await Self.makeFixture(
            aggregateRefreshInterval: .milliseconds(5),
            aggregateEnvironmentLoader: { runtime in
                try await loader.load(from: runtime)
            }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        _ = try await fixture.client.initialSnapshot()
        await loader.waitForCallCount(1)

        _ = try await fixture.hydratedSnapshot()

        await loader.waitForFirstLoadCancellation()
        await loader.waitForCallCount(2)
        let restartedCallCount = await loader.callCount
        XCTAssertGreaterThanOrEqual(restartedCallCount, 2)
        await fixture.client.disconnect()
    }

    func testDuplicateWireIDsRemainDistinctAndRouteByEnvironment() async throws {
        let fixture = try await Self.makeFixture(duplicateIDs: true)
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let snapshot = try await fixture.hydratedSnapshot()
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
        let fixture = try await Self.makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        let snapshot = try await fixture.hydratedSnapshot()
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
        let fixture = try await Self.makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let snapshot = try await fixture.hydratedSnapshot()
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
        let fixture = try await Self.makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let initial = try await fixture.hydratedSnapshot()
        let thread = try XCTUnwrap(
            initial.threads.first(where: { $0.environmentID == "one" })
        )
        let recorder = try XCTUnwrap(fixture.recorder)
        await fixture.transport.setShellReadsEnabled(false, host: "one.example")
        try await fixture.client.setThreadArchived(id: thread.id, archived: true)
        _ = try await recorder.wait { $0.threads.contains { $0.id == thread.id && $0.isArchived } }
        try await fixture.client.setThreadArchived(id: thread.id, archived: false)
        let restoredSnapshot = try await recorder.wait { $0.threads.contains { $0.id == thread.id && !$0.isArchived } }
        let restored = restoredSnapshot.threads.first { $0.id == thread.id }

        XCTAssertEqual(restored?.id, thread.id)
        XCTAssertEqual(restored?.isArchived, false)
        await fixture.client.disconnect()
    }

    func testHTTPFallbackKeepsLiveConnectionReconnecting() async throws {
        let fixture = try await Self.makeFixture(
            fallbackPollingInitialDelay: .milliseconds(40),
            fallbackPollingInterval: .seconds(2)
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.hydratedSnapshot()
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
        let recorder = try XCTUnwrap(fixture.recorder)
        let refreshed = try await recorder.wait { $0.projects.contains { $0.wireID == addedProject.id } }
        XCTAssertEqual(refreshed.connection.state, .reconnecting)
        await fixture.client.disconnect()
    }

    fileprivate static func makeFixture(
        duplicateIDs: Bool = false,
        requireConfiguration: Bool = false,
        passiveSequence: Int = 1,
        includeThirdEnvironment: Bool = false,
        repositoryIdentity: RepositoryIdentity? = nil,
        pullRequestsAvailable: Bool = false,
        webSocketConnector: any WebSocketConnecting = UnavailableMultiEnvironmentWebSocketConnector(),
        rpcConnectionWaitTimeout: Duration = .milliseconds(5),
        fallbackPollingInitialDelay: Duration = .seconds(3),
        fallbackPollingInterval: Duration = .seconds(2),
        aggregateRefreshInterval: Duration = NativeFeatureClient.defaultAggregateRefreshInterval,
        aggregateIdleRefreshInterval: Duration = NativeFeatureClient.defaultAggregateIdleRefreshInterval,
        aggregateFailureRefreshInterval: Duration = NativeFeatureClient.defaultAggregateFailureRefreshInterval,
        aggregateRefreshSleep: @escaping @Sendable (Duration) async throws -> Void = {
            try await Task.sleep(for: $0)
        },
        aggregatePeerRefreshSleep: @escaping @Sendable (String, Duration) async throws -> Void = { _, interval in
            try await Task.sleep(for: interval)
        },
        aggregateStreamRetrySleep: @escaping @Sendable (String, Duration) async throws -> Void = { _, interval in
            try await Task.sleep(for: interval)
        },
        aggregatePublishSleep: @escaping @Sendable () async throws -> Void = {
            try await Task.sleep(for: .milliseconds(250))
        },
        aggregateRefreshReceipt: @escaping @MainActor @Sendable (NativePassiveShellReceipt) -> Void = { _ in },
        aggregateEnvironmentLoader: @escaping @Sendable (EnvironmentRuntime) async throws -> [Environment] = {
            try await $0.environments()
        }
    ) async throws -> MultiEnvironmentFixture {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-native-multi-\(UUID().uuidString)", isDirectory: true)
        var environments = [
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
        if includeThirdEnvironment {
            environments.append(
                Environment(
                    id: "three",
                    label: "Third Box",
                    httpBaseURL: URL(string: "https://three.example")!,
                    webSocketBaseURL: URL(string: "wss://three.example")!,
                    descriptor: try multiEnvironmentDescriptor(
                        environmentID: "three",
                        label: "Third Box",
                        pullRequestsAvailable: pullRequestsAvailable
                    )
                )
            )
        }
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save(environments)
        try await store.setActiveEnvironment(id: "one")
        var shells = [
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
        if includeThirdEnvironment {
            shells["three.example"] = multiEnvironmentShell(
                projectID: "project-three",
                threadID: "thread-three",
                title: "Third work",
                providerID: "codex",
                modelID: "gpt-5.6-sol"
            )
        }
        let transport = MultiEnvironmentHTTPTransport(shells: shells)
        var environmentCredentials = [
            "one": EnvironmentCredential(accessToken: "one-token"),
            "two": EnvironmentCredential(accessToken: "two-token"),
        ]
        if includeThirdEnvironment {
            environmentCredentials["three"] = EnvironmentCredential(accessToken: "three-token")
        }
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(credentials: environmentCredentials),
            httpTransport: transport,
            webSocketConnector: webSocketConnector,
            rpcConnectionWaitTimeout: rpcConnectionWaitTimeout
        )
        let settings = UserDefaults(
            suiteName: "t3-native-multi-\(UUID().uuidString)"
        )!
        let receipts = PassiveLiveReceipts()
        return MultiEnvironmentFixture(
            directory: directory,
            transport: transport,
            runtime: runtime,
            client: NativeFeatureClient(
                runtime: runtime,
                settingsStore: settings,
                fallbackPollingInitialDelay: fallbackPollingInitialDelay,
                fallbackPollingInterval: fallbackPollingInterval,
                aggregateRefreshInterval: aggregateRefreshInterval,
                aggregateIdleRefreshInterval: aggregateIdleRefreshInterval,
                aggregateFailureRefreshInterval: aggregateFailureRefreshInterval,
                aggregateRefreshSleep: aggregateRefreshSleep,
                aggregatePeerRefreshSleep: aggregatePeerRefreshSleep,
                aggregateStreamRetrySleep: aggregateStreamRetrySleep,
                aggregatePublishSleep: aggregatePublishSleep,
                aggregateRefreshReceipt: { receipt in
                    receipts.record(receipt)
                    aggregateRefreshReceipt(receipt)
                },
                aggregateEnvironmentLoader: aggregateEnvironmentLoader
            ), receipts: receipts, requireConfiguration: requireConfiguration
        )
    }
}

@Suite("Native passive thread refresh")
@MainActor
struct NativePassiveThreadRefreshTests {
    @Test(
        "Passive thread events arrive within five seconds and stay fast after changes",
        .timeLimit(.minutes(1))
    )
    func passiveThreadEventsArriveWithinFiveSecondsAndStayFastAfterChanges() async throws {
        let refreshSleep = ControllableAggregateRefreshSleep()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            aggregatePeerRefreshSleep: { _, interval in
                try await refreshSleep.sleep(for: interval)
            }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()
        let threadID = FeatureScopedID.thread(environmentID: "two", wireID: "thread-two")
        let updatedTitle = "Passive work updated automatically"
        let eventProbe = ThreadTitleEventProbe(
            events: fixture.client.events(),
            threadID: threadID,
            title: updatedTitle
        )
        eventProbe.start()

        let firstCadence = await refreshSleep.waitUntilRequested(count: 1)
        #expect(firstCadence == .seconds(5))
        await fixture.transport.setShell(
            multiEnvironmentShell(
                projectID: "project-two",
                threadID: "thread-two",
                title: updatedTitle,
                providerID: "claudeAgent",
                modelID: "claude-opus-4-1"
            ),
            host: "two.example"
        )
        await refreshSleep.resume()

        await eventProbe.waitUntilObserved()
        #expect(eventProbe.didObserveTitle())
        let changedCadence = await refreshSleep.waitUntilRequested(count: 2)
        #expect(changedCadence == .seconds(5))
        await fixture.client.disconnect()
    }

    @Test("Passive refresh uses ten seconds when work is unchanged")
    func passiveRefreshUsesTenSecondsWhenWorkIsUnchanged() async throws {
        let refreshSleep = ControllableAggregateRefreshSleep()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            aggregatePeerRefreshSleep: { _, interval in
                try await refreshSleep.sleep(for: interval)
            }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()

        let firstCadence = await refreshSleep.waitUntilRequested(count: 1)
        #expect(firstCadence == .seconds(5))
        await refreshSleep.resume()
        let idleCadence = await refreshSleep.waitUntilRequested(count: 2)
        #expect(idleCadence == .seconds(10))
        await fixture.client.disconnect()
    }

    @Test("A failed passive environment backs off without slowing an active peer", .timeLimit(.minutes(1)))
    func failedPassiveEnvironmentBacksOffWithoutSlowingActivePeer() async throws {
        let healthyClock = ControllableAggregateRefreshSleep()
        let failedClock = ControllableAggregateRefreshSleep()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            includeThirdEnvironment: true,
            aggregatePeerRefreshSleep: { id, interval in
                try await (id == "two" ? healthyClock : failedClock).sleep(for: interval)
            }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()
        _ = await healthyClock.waitUntilRequested(count: 1)
        _ = await failedClock.waitUntilRequested(count: 1)
        await fixture.transport.setReachable(false, host: "three.example")
        await failedClock.resume()
        let failureCadence = await failedClock.waitUntilRequested(count: 2)
        #expect(failureCadence == .seconds(20))
        for count in 2...4 {
            await healthyClock.resume()
            _ = await healthyClock.waitUntilRequested(count: count)
            let failedReads = await fixture.transport.shellReadCount(host: "three.example")
            #expect(failedReads == 2)
        }
        await failedClock.resume()
        _ = await failedClock.waitUntilRequested(count: 3)
        let retriedReads = await fixture.transport.shellReadCount(host: "three.example")
        #expect(retriedReads == 3)
        await fixture.client.disconnect()
    }

    @Test("Healthy rows publish twice while a peer shell and optional catalogue remain held", .timeLimit(.minutes(1)))
    func healthyRowsPublishTwiceWhilePeerAndCatalogueAreHeld() async throws {
        let healthyClock = ControllableAggregateRefreshSleep()
        let slowClock = ControllableAggregateRefreshSleep()
        let connector = GatedPassiveCatalogueConnector()
        let topologyGate = PassiveRequestGate()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            includeThirdEnvironment: true,
            webSocketConnector: connector,
            aggregatePeerRefreshSleep: { id, interval in
                try await (id == "two" ? healthyClock : slowClock).sleep(for: interval)
            },
            aggregateEnvironmentLoader: { runtime in
                await topologyGate.enter()
                return try await runtime.environments()
            }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()
        let healthyID = FeatureScopedID.thread(environmentID: "two", wireID: "thread-two")
        let heldShell = PassiveRequestGate()
        await fixture.transport.holdNextShell(host: "three.example", gate: heldShell)
        await connector.holdPassiveConnections()
        await topologyGate.release()
        await connector.gate.waitUntilEntered()
        _ = await healthyClock.waitUntilRequested(count: 1)
        await heldShell.waitUntilEntered()
        for update in 1...2 {
            let title = "Healthy update \(update)"
            let probe = ThreadTitleEventProbe(events: fixture.client.events(), threadID: healthyID, title: title)
            probe.start()
            await fixture.transport.setShell(multiEnvironmentShell(
                projectID: "project-two", threadID: "thread-two", title: title,
                snapshotSequence: update + 1
            ), host: "two.example")
            await healthyClock.resume()
            await probe.waitUntilObserved()
            #expect(probe.didObserveTitle())
            _ = await healthyClock.waitUntilRequested(count: update + 1)
            #expect(await heldShell.isHeld)
            #expect(await connector.gate.isHeld)
        }
        await fixture.client.disconnect()
        await heldShell.release()
        await connector.release()
    }
    @Test("A cancelled refresh generation cannot overwrite a restarted peer", .timeLimit(.minutes(1)))
    func cancelledGenerationCannotOverwriteRestartedPeer() async throws {
        let clock = ControllableAggregateRefreshSleep()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            aggregatePeerRefreshSleep: { _, interval in try await clock.sleep(for: interval) }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()
        _ = await clock.waitUntilRequested(count: 1)
        let oldWorker = try #require(fixture.client.aggregateRefreshWorkers["two"]?.task)
        let gate = PassiveRequestGate()
        await fixture.transport.setShell(multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Stale generation",
            snapshotSequence: 999
        ), host: "two.example")
        await fixture.transport.holdNextShell(host: "two.example", gate: gate)
        await clock.resume()
        await gate.waitUntilEntered()
        await fixture.transport.setShell(multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Current generation",
            snapshotSequence: 2
        ), host: "two.example")
        _ = try await fixture.client.initialSnapshot()
        #expect(oldWorker.isCancelled)
        await gate.release()
        await oldWorker.value
        // A stale 999 would survive this read of sequence 2 if it reached the cache.
        let snapshot = try await fixture.client.backgroundSnapshot()
        #expect(snapshot.threads.first { $0.environmentID == "two" }?.title == "Current generation")
        await fixture.client.disconnect()
    }

    @Test("Failed environment writes preserve the passive worker", arguments: [false, true])
    func failedEnvironmentWritePreservesWorker(removal: Bool) async throws {
        let clock = ControllableAggregateRefreshSleep()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            aggregatePeerRefreshSleep: { _, interval in try await clock.sleep(for: interval) }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()
        _ = await clock.waitUntilRequested(count: 1)
        let worker = try #require(fixture.client.aggregateRefreshWorkers["two"]?.task)
        let catalog = fixture.directory.appendingPathComponent("environments.json")
        let data = try Data(contentsOf: catalog)
        try FileManager.default.removeItem(at: catalog)
        try FileManager.default.createDirectory(at: catalog, withIntermediateDirectories: false)
        do {
            if removal { try await fixture.client.removeEnvironment(id: "two") }
            else { try await fixture.client.setEnvironmentEnabled(id: "two", enabled: false) }
            Issue.record("The blocked catalog write unexpectedly succeeded")
        } catch {
            #expect(!worker.isCancelled)
            #expect(fixture.client.aggregateRefreshWorkers["two"] != nil)
        }
        try FileManager.default.removeItem(at: catalog)
        try data.write(to: catalog)
        #expect(try await fixture.runtime.environments().contains { $0.id == "two" && $0.isEnabled })
        let probe = ThreadTitleEventProbe(
            events: fixture.client.events(),
            threadID: FeatureScopedID.thread(environmentID: "two", wireID: "thread-two"),
            title: "Still updating"
        )
        probe.start()
        await fixture.transport.setShell(multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Still updating", snapshotSequence: 2
        ), host: "two.example")
        await clock.resume()
        await probe.waitUntilObserved()
        #expect(probe.didObserveTitle())
        await fixture.client.disconnect()
    }

    @Test("Removal cancels a held peer and its late response never returns a row", .timeLimit(.minutes(1)))
    func removedPeerCannotPublishLateResponse() async throws {
        let removedClock = ControllableAggregateRefreshSleep()
        let healthyClock = ControllableAggregateRefreshSleep()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            includeThirdEnvironment: true,
            aggregatePeerRefreshSleep: { id, interval in
                try await (id == "two" ? removedClock : healthyClock).sleep(for: interval)
            }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()
        let healthyID = FeatureScopedID.thread(environmentID: "three", wireID: "thread-three")
        let probe = ThreadTitleEventProbe(
            events: fixture.client.events(), threadID: healthyID, title: "Removal verified"
        )
        probe.start()
        _ = await removedClock.waitUntilRequested(count: 1)
        _ = await healthyClock.waitUntilRequested(count: 1)
        let oldWorker = try #require(fixture.client.aggregateRefreshWorkers["two"]?.task)
        let gate = PassiveRequestGate()
        await fixture.transport.setShell(multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Ghost removed row",
            snapshotSequence: 999
        ), host: "two.example")
        await fixture.transport.holdNextShell(host: "two.example", gate: gate)
        await removedClock.resume()
        await gate.waitUntilEntered()
        try await fixture.client.removeEnvironment(id: "two")
        #expect(oldWorker.isCancelled)
        #expect(fixture.client.aggregateRefreshWorkers["two"] == nil)
        await gate.release()
        await oldWorker.value
        await fixture.transport.setShell(multiEnvironmentShell(
            projectID: "project-three", threadID: "thread-three", title: "Removal verified",
            snapshotSequence: 2
        ), host: "three.example")
        await healthyClock.resume()
        await probe.waitUntilObserved()
        #expect(!probe.sawThreadTitle("Ghost removed row"))
        #expect(!probe.lastEnvironmentIDs.contains("two"))
        await fixture.client.disconnect()
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

@MainActor
private final class ThreadTitleEventProbe {
    private let events: AsyncStream<FeatureEvent>
    private let threadID: String
    private let title: String
    private var observed = false
    private var observedTitles = Set<String>()
    private(set) var lastEnvironmentIDs = Set<String>()
    private var observedWaiters: [CheckedContinuation<Void, Never>] = []
    private var task: Task<Void, Never>?

    init(events: AsyncStream<FeatureEvent>, threadID: String, title: String) {
        self.events = events
        self.threadID = threadID
        self.title = title
    }

    func start() {
        task = Task { [weak self] in
            guard let self else { return }
            for await event in events {
                switch event {
                case let .thread(thread):
                    observedTitles.insert(thread.title)
                    observed = thread.id == threadID && thread.title == title
                case let .snapshot(snapshot):
                    observedTitles.formUnion(snapshot.threads.map(\.title))
                    lastEnvironmentIDs = Set(snapshot.environments.map(\.id))
                    observed = snapshot.threads.contains {
                        $0.id == self.threadID && $0.title == self.title
                    }
                case .connection, .threadRemoved, .detail, .detailDelta, .threadSync, .failure:
                    observed = false
                }
                if observed {
                    observedWaiters.forEach { $0.resume() }
                    observedWaiters.removeAll()
                    return
                }
            }
        }
    }

    func sawThreadTitle(_ title: String) -> Bool { observedTitles.contains(title) }

    func didObserveTitle() -> Bool {
        observed
    }

    func waitUntilObserved() async {
        guard observed == false else { return }
        await withCheckedContinuation { continuation in
            observedWaiters.append(continuation)
        }
    }

    deinit {
        task?.cancel()
    }
}

private actor ControllableAggregateRefreshSleep {
    var requestCount: Int { requestedCadences.count }
    private var requestedCadences: [Duration] = []
    private var requestWaiters: [(
        count: Int,
        continuation: CheckedContinuation<Duration, Never>
    )] = []
    private var sleepContinuation: CheckedContinuation<Void, Never>?

    func sleep(for cadence: Duration) async throws {
        requestedCadences.append(cadence)
        let satisfied = requestWaiters.filter { requestedCadences.count >= $0.count }
        requestWaiters.removeAll { requestedCadences.count >= $0.count }
        satisfied.forEach {
            $0.continuation.resume(returning: requestedCadences[$0.count - 1])
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                if Task.isCancelled {
                    continuation.resume()
                } else {
                    sleepContinuation = continuation
                }
            }
        } onCancel: {
            Task { await self.resume() }
        }
        try Task.checkCancellation()
    }

    func waitUntilRequested(count: Int) async -> Duration {
        if requestedCadences.count >= count { return requestedCadences[count - 1] }
        return await withCheckedContinuation { continuation in
            requestWaiters.append((count, continuation))
        }
    }

    func resume() {
        sleepContinuation?.resume()
        sleepContinuation = nil
    }
}

@MainActor
private final class MultiEnvironmentFixture {
    let directory: URL
    let transport: MultiEnvironmentHTTPTransport
    let runtime: EnvironmentRuntime
    let client: NativeFeatureClient
    let receipts: PassiveLiveReceipts
    let requireConfiguration: Bool
    private(set) var recorder: BootstrapSnapshotRecorder?

    init(directory: URL, transport: MultiEnvironmentHTTPTransport, runtime: EnvironmentRuntime,
         client: NativeFeatureClient, receipts: PassiveLiveReceipts, requireConfiguration: Bool) {
        self.directory = directory
        self.transport = transport
        self.runtime = runtime
        self.client = client
        self.receipts = receipts
        self.requireConfiguration = requireConfiguration
    }

    func hydratedSnapshot() async throws -> FeatureSnapshot {
        let ids = try await runtime.environments().filter(\.isEnabled).map(\.id)
        let targets = Dictionary(uniqueKeysWithValues: ids.map { ($0, receipts.httpCount($0) + 1) })
        let seed = try await client.initialSnapshot()
        if let recorder { recorder.record(seed) }
        else { recorder = BootstrapSnapshotRecorder(seed: seed, events: client.events()) }
        for id in ids {
            try await receipts.waitForHTTP(id, count: targets[id]!)
            if requireConfiguration { try await receipts.waitForConfiguration(id) }
        }
        let needsPublishedConfiguration = requireConfiguration
        return try await recorder!.wait { snapshot in
            ids.allSatisfy { id in
                // The configuration receipt precedes publication. Wait for
                // the same event consumer to observe settings in its snapshot.
                if needsPublishedConfiguration && snapshot.preferencesByEnvironment?[id] == nil { return false }
                guard let state = snapshot.environments.first(where: { $0.id == id })?.connectionState else { return false }
                return state == .connected || state == .disconnected
            }
        }
    }
}

private actor MultiEnvironmentHTTPTransport: HTTPTransport {
    private let shells: [String: OrchestrationShellSnapshot]
    private var shellData: [String: Data]
    private var detailData: [String: [String: Data]] = [:]
    private var reachableHosts: Set<String>
    private var shellReadsEnabledHosts: Set<String>
    private var shellReadCounts: [String: Int] = [:]
    private var dispatched: [MultiEnvironmentDispatchRecord] = []
    private var hostsDroppingNextCreateReply = Set<String>()
    private var nextShellGates: [String: PassiveRequestGate] = [:]
    private var nextDispatchGates: [String: PassiveRequestGate] = [:]

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

    func shellReadCount(host: String) -> Int {
        shellReadCounts[host, default: 0]
    }

    func dropNextCreateReply(host: String) {
        hostsDroppingNextCreateReply.insert(host)
    }

    func holdNextDispatch(host: String, gate: PassiveRequestGate) { nextDispatchGates[host] = gate }

    func holdNextShell(host: String, gate: PassiveRequestGate) {
        nextShellGates[host] = gate
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let host = request.url?.host ?? ""
        let path = request.url?.path ?? ""
        if path == "/api/orchestration/shell" {
            shellReadCounts[host, default: 0] += 1
            if let gate = nextShellGates.removeValue(forKey: host), let data = shellData[host] {
                await gate.enter()
                return (data, multiEnvironmentResponse(request))
            }
        }
        guard reachableHosts.contains(host) else {
            throw URLError(.cannotConnectToHost)
        }
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
            if let gate = nextDispatchGates.removeValue(forKey: host) { await gate.enter() }
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
    settledAt: String? = nil,
    titleRegeneration: ThreadTitleRegeneration? = nil
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
                titleRegeneration: titleRegeneration,
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

/// Deliberately ignores cancellation to model a transport completing an old read.
private actor PassiveRequestGate {
    private var cancellableEntryWaiters: [UUID: CheckedContinuation<Void, Error>] = [:]
    private var entered = false
    private var released = false
    private var entryWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []
    var isHeld: Bool { entered && !released }

    func enter() async {
        entered = true
        let pending = cancellableEntryWaiters.values
        cancellableEntryWaiters.removeAll()
        pending.forEach { $0.resume() }
        entryWaiters.forEach { $0.resume() }
        entryWaiters.removeAll()
        guard !released else { return }
        await withCheckedContinuation { releaseWaiters.append($0) }
    }

    func waitUntilEnteredCancellable() async throws {
        try Task.checkCancellation()
        guard !entered else { return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { cancellableEntryWaiters[id] = $0 }
        } onCancel: {
            Task { await self.cancelEntryWaiter(id) }
        }
    }

    private func cancelEntryWaiter(_ id: UUID) {
        cancellableEntryWaiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }

    func waitUntilEntered() async {
        guard !entered else { return }
        await withCheckedContinuation { entryWaiters.append($0) }
    }

    func release() {
        released = true
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private actor GatedPassiveCatalogueConnector: WebSocketConnecting {
    private var shouldHold = false
    let gate = PassiveRequestGate()

    func holdPassiveConnections() { shouldHold = true }

    func connect(to url: URL) async throws -> any WebSocketConnection {
        if shouldHold && url.host == "two.example" {
            return GatedPassiveCatalogueConnection(gate: gate)
        }
        throw URLError(.cannotConnectToHost)
    }

    func release() async { await gate.release() }
}

private actor GatedPassiveCatalogueConnection: WebSocketConnection {
    let gate: PassiveRequestGate
    private var receiver: CheckedContinuation<Data, Error>?
    private var closed = false

    init(gate: PassiveRequestGate) { self.gate = gate }

    func send(_ data: Data) async throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        if request["tag"]?.stringValue != nil { await gate.enter() }
    }

    func receive() async throws -> Data {
        if closed { throw CancellationError() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func close() {
        closed = true
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }
}

@Suite("Native passive live shells")
@MainActor
struct NativePassiveLiveShellTests {
    @Test("Live peer bursts publish together without polling", .timeLimit(.minutes(1)))
    func livePeerBurstsPublishTogetherWithoutPolling() async throws {
        let server = PassiveLiveServer()
        let topology = PassiveRequestGate()
        let topologyClock = ControllableAggregateRefreshSleep()
        let clocks = PassiveClockBank()
        let publication = ControllableAggregateRefreshSleep()
        let receipts = PassiveLiveReceipts()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            includeThirdEnvironment: true,
            webSocketConnector: server,
            fallbackPollingInitialDelay: .seconds(60),
            aggregateRefreshSleep: { try await topologyClock.sleep(for: $0) },
            aggregatePeerRefreshSleep: { try await clocks.sleep(id: $0, interval: $1) },
            aggregateStreamRetrySleep: { _, _ in },
            aggregatePublishSleep: { try await publication.sleep(for: .zero) },
            aggregateRefreshReceipt: { receipts.record($0) },
            aggregateEnvironmentLoader: { runtime in
                await topology.enter()
                return try await runtime.environments()
            }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()
        let threeID = FeatureScopedID.thread(environmentID: "three", wireID: "thread-three")
        let heldTwo = PassiveRequestGate()
        let heldThree = PassiveRequestGate()
        await fixture.transport.holdNextShell(host: "two.example", gate: heldTwo)
        await fixture.transport.holdNextShell(host: "three.example", gate: heldThree)
        await topology.release()
        await server.waitForSubscriptions(host: "two.example", count: 1)
        await server.waitForSubscriptions(host: "three.example", count: 1)
        await heldTwo.waitUntilEntered()
        await heldThree.waitUntilEntered()
        let shellTwo = multiEnvironmentShell(projectID: "project-two", threadID: "thread-two", title: "Live base", snapshotSequence: 10)
        let shellThree = multiEnvironmentShell(projectID: "project-three", threadID: "thread-three", title: "Third base", snapshotSequence: 20)
        try await server.snapshot(shellTwo, host: "two.example")
        try await server.snapshot(shellThree, host: "three.example")
        try await receipts.waitForShells("two", count: 1)
        try await receipts.waitForShells("three", count: 1)
        let finalTwo = multiEnvironmentShell(projectID: "project-two", threadID: "thread-two", title: "Burst final", snapshotSequence: 12)
        let finalThree = multiEnvironmentShell(projectID: "project-three", threadID: "thread-three", title: "Third final", snapshotSequence: 21)
        try await server.upsert(finalTwo.threads[0], sequence: 11, host: "two.example")
        try await server.upsert(finalTwo.threads[0], sequence: 12, host: "two.example")
        try await server.upsert(finalThree.threads[0], sequence: 21, host: "three.example")
        try await receipts.waitForShells("two", count: 3)
        try await receipts.waitForShells("three", count: 2)
        _ = await publication.waitUntilRequested(count: 1)
        #expect(await publication.requestCount == 1)
        let probe = ThreadTitleEventProbe(events: fixture.client.events(), threadID: threeID, title: "Third final")
        probe.start()
        await publication.resume()
        await probe.waitUntilObserved()
        #expect(probe.sawThreadTitle("Burst final"))
        #expect(await heldTwo.isHeld)
        #expect(await heldThree.isHeld)
        await heldTwo.release()
        await heldThree.release()
        try await receipts.waitForHTTP("two", count: 1)
        try await receipts.waitForHTTP("three", count: 1)
        let reads = await fixture.transport.shellReadCount(host: "two.example")
        #expect(reads == 1)
        let payload = await server.lastPayload(host: "two.example")
        #expect(payload?["afterSequence"] == nil)
        await fixture.client.disconnect()
    }

    @Test("A replacement socket accepts a low sequence and rejects old HTTP", .timeLimit(.minutes(1)))
    func replacementSocketRejectsOldHTTP() async throws {
        let server = PassiveLiveServer()
        let topology = PassiveRequestGate()
        let clocks = PassiveClockBank()
        let receipts = PassiveLiveReceipts()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            webSocketConnector: server,
            fallbackPollingInitialDelay: .seconds(60),
            aggregatePeerRefreshSleep: { try await clocks.sleep(id: $0, interval: $1) },
            aggregateStreamRetrySleep: { _, _ in },
            aggregatePublishSleep: {},
            aggregateRefreshReceipt: { receipts.record($0) },
            aggregateEnvironmentLoader: { runtime in
                await topology.enter()
                return try await runtime.environments()
            }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()
        let oldHTTP = PassiveRequestGate()
        await fixture.transport.setShell(multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Old HTTP", snapshotSequence: 999
        ), host: "two.example")
        await fixture.transport.holdNextShell(host: "two.example", gate: oldHTTP)
        await topology.release()
        await server.waitForSubscriptions(host: "two.example", count: 1)
        await oldHTTP.waitUntilEntered()
        try await server.snapshot(multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Old socket", snapshotSequence: 100
        ), host: "two.example")
        try await receipts.waitForShells("two", count: 1)
        await server.closeLatest(host: "two.example")
        await server.waitForSubscriptions(host: "two.example", count: 2)
        let fresh = multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Replacement socket", snapshotSequence: 2
        )
        await fixture.transport.setShell(fresh, host: "two.example")
        try await server.snapshot(fresh, host: "two.example")
        try await receipts.waitForShells("two", count: 2)
        await oldHTTP.release()
        try await receipts.waitForHTTP("two", count: 1)
        let snapshot = try await fixture.client.backgroundSnapshot()
        #expect(snapshot.threads.first { $0.environmentID == "two" }?.title == "Replacement socket")
        #expect(receipts.sequences["two"] == [100, 2])
        let payload = await server.lastPayload(host: "two.example")
        #expect(payload?["afterSequence"] == nil)
        await fixture.client.disconnect()
    }

    @Test("Unknown live events trigger one immediate HTTP repair and recover", .timeLimit(.minutes(1)))
    func unknownEventRepairsWithoutPollingDelay() async throws {
        let server = PassiveLiveServer()
        let receipts = PassiveLiveReceipts()
        let clocks = PassiveClockBank()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            webSocketConnector: server,
            fallbackPollingInitialDelay: .seconds(60),
            aggregatePeerRefreshSleep: { try await clocks.sleep(id: $0, interval: $1) },
            aggregateStreamRetrySleep: { _, _ in },
            aggregatePublishSleep: {},
            aggregateRefreshReceipt: { receipts.record($0) }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()
        let threadID = FeatureScopedID.thread(environmentID: "two", wireID: "thread-two")
        await server.waitForSubscriptions(host: "two.example", count: 1)
        // Drain the initial repair before making the stream authoritative.
        try await receipts.waitForHTTP("two", count: 1)
        let live = multiEnvironmentShell(projectID: "project-two", threadID: "thread-two", title: "Live", snapshotSequence: 10)
        try await server.snapshot(live, host: "two.example")
        try await receipts.waitForShells("two", count: 1)
        let initialReadCount = await fixture.transport.shellReadCount(host: "two.example")
        let initialReceiptCount = receipts.httpCount("two")
        let held = PassiveRequestGate()
        let repaired = multiEnvironmentShell(projectID: "project-two", threadID: "thread-two", title: "HTTP repaired", snapshotSequence: 11)
        await fixture.transport.setShell(repaired, host: "two.example")
        await fixture.transport.holdNextShell(host: "two.example", gate: held)
        try await server.emit([.object(["kind": .string("future-shell-event")])], host: "two.example")
        await held.waitUntilEntered()
        await server.waitForSubscriptions(host: "two.example", count: 2)
        let readCount = await fixture.transport.shellReadCount(host: "two.example")
        #expect(readCount == initialReadCount + 1)
        let probe = ThreadTitleEventProbe(events: fixture.client.events(), threadID: threadID, title: "HTTP repaired")
        probe.start()
        await held.release()
        try await receipts.waitForHTTP("two", count: initialReceiptCount + 1)
        await probe.waitUntilObserved()
        try await server.snapshot(repaired, host: "two.example")
        try await receipts.waitForShells("two", count: 2)
        #expect(await fixture.transport.shellReadCount(host: "two.example") == initialReadCount + 1)
        await fixture.client.disconnect()
    }

    @Test("Background cancels passive work and foreground replaces subscriptions", .timeLimit(.minutes(1)))
    func backgroundAndRemovalCancelOwnedSubscriptions() async throws {
        let server = PassiveLiveServer()
        let receipts = PassiveLiveReceipts()
        let clocks = PassiveClockBank()
        let publication = ControllableAggregateRefreshSleep()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            webSocketConnector: server,
            fallbackPollingInitialDelay: .seconds(60),
            aggregatePeerRefreshSleep: { try await clocks.sleep(id: $0, interval: $1) },
            aggregateStreamRetrySleep: { _, _ in },
            aggregatePublishSleep: { try await publication.sleep(for: .zero) },
            aggregateRefreshReceipt: { receipts.record($0) }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()
        await server.waitForSubscriptions(host: "two.example", count: 1)
        try await receipts.waitForHTTP("two", count: 1)
        try await server.snapshot(multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Cached live peer", snapshotSequence: 3
        ), host: "two.example")
        try await receipts.waitForShells("two", count: 1)
        _ = await publication.waitUntilRequested(count: 1)
        let oldWorker = try #require(fixture.client.aggregateRefreshWorkers["two"]?.task)
        fixture.client.suspendForBackground()
        await oldWorker.value
        await server.waitForInterrupts(host: "two.example", count: 1)
        #expect(fixture.client.aggregateRefreshWorkers.isEmpty)
        #expect(oldWorker.isCancelled)
        await fixture.client.resumeAfterBackground(reconnect: false)
        await server.waitForSubscriptions(host: "two.example", count: 2)
        let payload = await server.lastPayload(host: "two.example")
        #expect(payload?["afterSequence"] == nil)
        let nextWorker = try #require(fixture.client.aggregateRefreshWorkers["two"]?.task)
        try await fixture.client.removeEnvironment(id: "two")
        await nextWorker.value
        await server.waitForInterrupts(host: "two.example", count: 2)
        #expect(nextWorker.isCancelled)
        #expect(fixture.client.aggregateRefreshWorkers["two"] == nil)
        let snapshot = try await fixture.client.backgroundSnapshot()
        #expect(!snapshot.environments.contains { $0.id == "two" })
        await fixture.client.disconnect()
    }
    @Test("Repeated snapshot then stream end waits twenty seconds between subscriptions", .timeLimit(.minutes(1)))
    func repeatedStreamEndsBackOffWhileHTTPRepairs() async throws {
        let server = PassiveLiveServer()
        let receipts = PassiveLiveReceipts()
        let clocks = PassiveClockBank()
        let retries = ControllableAggregateRefreshSleep()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            webSocketConnector: server,
            fallbackPollingInitialDelay: .seconds(60),
            aggregatePeerRefreshSleep: { try await clocks.sleep(id: $0, interval: $1) },
            aggregateStreamRetrySleep: { _, interval in try await retries.sleep(for: interval) },
            aggregatePublishSleep: {},
            aggregateRefreshReceipt: { receipts.record($0) }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()
        await server.waitForSubscriptions(host: "two.example", count: 1)
        try await receipts.waitForHTTP("two", count: 1)
        for attempt in 1...3 {
            try await server.snapshot(multiEnvironmentShell(
                projectID: "project-two", threadID: "thread-two", title: "Snapshot \(attempt)", snapshotSequence: 10 + attempt
            ), host: "two.example")
            try await receipts.waitForShells("two", count: attempt)
            try await server.finish(host: "two.example")
            let cadence = await retries.waitUntilRequested(count: attempt)
            #expect(cadence == .seconds(20))
            try await receipts.waitForHTTP("two", count: attempt + 1)
            #expect(await server.subscriptionCount(host: "two.example") == attempt)
            if attempt < 3 {
                await retries.resume()
                await server.waitForSubscriptions(host: "two.example", count: attempt + 1)
            }
        }
        await fixture.client.disconnect()
    }

    @Test("Selecting a passive environment transfers shell ownership", .timeLimit(.minutes(1)))
    func activeSwitchTransfersShellOwnership() async throws {
        let server = PassiveLiveServer()
        let receipts = PassiveLiveReceipts()
        let clocks = PassiveClockBank()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            webSocketConnector: server,
            fallbackPollingInitialDelay: .seconds(60),
            aggregatePeerRefreshSleep: { try await clocks.sleep(id: $0, interval: $1) },
            aggregateStreamRetrySleep: { _, _ in },
            aggregatePublishSleep: {},
            aggregateRefreshReceipt: { receipts.record($0) }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let seed = try await fixture.client.initialSnapshot()
        let recorder = BootstrapSnapshotRecorder(seed: seed, events: fixture.client.events())
        defer { recorder.stop() }
        await server.waitForSubscriptions(host: "two.example", count: 1)
        try await receipts.waitForHTTP("two", count: 1)
        try await server.snapshot(multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Selected peer", snapshotSequence: 10
        ), host: "two.example")
        try await receipts.waitForShells("two", count: 1)
        // A same-socket HTTP refresh must retain the epoch association even
        // when its complete snapshot is identical to the last socket snapshot.
        await fixture.transport.setShell(multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Selected peer", snapshotSequence: 10
        ), host: "two.example")
        let readsBeforeRename = await fixture.transport.shellReadCount(host: "two.example")
        try await fixture.client.renameThread(
            id: FeatureScopedID.thread(environmentID: "two", wireID: "thread-two"), title: "Selected peer"
        )
        #expect(await fixture.transport.shellReadCount(host: "two.example") == readsBeforeRename + 1)
        await fixture.transport.setShell(multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Remote work", snapshotSequence: 1
        ), host: "two.example")
        let oldWorker = try #require(fixture.client.aggregateRefreshWorkers["two"]?.task)
        let adoptedHTTPCount = receipts.httpCount("two") + 1
        _ = try await fixture.runtime.activate(id: "two")
        let selected = try await fixture.client.initialSnapshot()
        await oldWorker.value
        await server.waitForSubscriptions(host: "two.example", count: 2)
        try await receipts.waitForHTTP("two", count: adoptedHTTPCount)
        #expect(oldWorker.isCancelled)
        #expect(fixture.client.aggregateRefreshWorkers["two"] == nil)
        #expect(selected.environments.first { $0.isActive }?.id == "two")
        #expect(selected.threads.first { $0.environmentID == "two" }?.title == "Selected peer")
        await server.waitForSubscriptions(host: "one.example", count: 2)
        try await server.snapshot(multiEnvironmentShell(
            projectID: "project-one", threadID: "thread-one", title: "New passive peer", snapshotSequence: 2
        ), host: "one.example")
        try await receipts.waitForShells("one", count: 2)
        let snapshot = try await fixture.client.backgroundSnapshot()
        #expect(snapshot.threads.first { $0.environmentID == "two" }?.title == "Selected peer")
        #expect(snapshot.threads.first { $0.environmentID == "one" }?.title == "New passive peer")

        // Retaining the adopted socket's sequence must not pin a genuinely
        // replacement socket to that old high watermark after a server restart.
        let restarted = multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Restarted active peer", snapshotSequence: 2
        )
        await fixture.transport.setShell(restarted, host: "two.example")
        await server.closeLatest(host: "two.example")
        await server.waitForSubscriptions(host: "two.example", count: 3)
        try await server.snapshot(restarted, host: "two.example")
        let recovered = try await recorder.wait {
            $0.connection.state == .connected
                && $0.threads.first { $0.environmentID == "two" }?.title == "Restarted active peer"
        }
        #expect(recovered.threads.first { $0.environmentID == "two" }?.title == "Restarted active peer")
        await fixture.client.disconnect()
    }

    @Test("HTTP begun before an unknown same-socket event cannot repair the gap", .timeLimit(.minutes(1)))
    func sameSocketGapRejectsPreGapHTTP() async throws {
        let server = PassiveLiveServer()
        let topology = PassiveRequestGate()
        let receipts = PassiveLiveReceipts()
        let clocks = PassiveClockBank()
        let retries = ControllableAggregateRefreshSleep()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            webSocketConnector: server,
            fallbackPollingInitialDelay: .seconds(60),
            aggregatePeerRefreshSleep: { try await clocks.sleep(id: $0, interval: $1) },
            aggregateStreamRetrySleep: { _, interval in try await retries.sleep(for: interval) },
            aggregatePublishSleep: {},
            aggregateRefreshReceipt: { receipts.record($0) },
            aggregateEnvironmentLoader: { runtime in
                await topology.enter()
                return try await runtime.environments()
            }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()
        let oldRead = PassiveRequestGate()
        let freshRead = PassiveRequestGate()
        await fixture.transport.setShell(multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Pre-gap stale HTTP", snapshotSequence: 999
        ), host: "two.example")
        await fixture.transport.holdNextShell(host: "two.example", gate: oldRead)
        await topology.release()
        await server.waitForSubscriptions(host: "two.example", count: 1)
        await oldRead.waitUntilEntered()
        try await server.emit([.object(["kind": .string("unknown-before-baseline")])], host: "two.example")
        _ = await retries.waitUntilRequested(count: 1)
        await fixture.transport.setShell(multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Post-gap authoritative HTTP", snapshotSequence: 2
        ), host: "two.example")
        await fixture.transport.holdNextShell(host: "two.example", gate: freshRead)
        await oldRead.release()
        try await receipts.waitForHTTP("two", count: 1)
        await freshRead.waitUntilEntered()
        #expect(await fixture.transport.shellReadCount(host: "two.example") == 2)
        // If the old 999 was installed, this independent sequence-2 read
        // cannot undo it and exposes the poisoned cache deterministically.
        let snapshot = try await fixture.client.backgroundSnapshot()
        #expect(snapshot.threads.first { $0.environmentID == "two" }?.title == "Post-gap authoritative HTTP")
        await freshRead.release()
        try await receipts.waitForHTTP("two", count: 2)
        await fixture.client.disconnect()
    }

    @Test("An authoritative peer snapshot removes its selected detail subscription", .timeLimit(.minutes(1)))
    func fullSnapshotRemovalStopsSelectedPeerDetail() async throws {
        let server = PassiveLiveServer()
        let receipts = PassiveLiveReceipts()
        let clocks = PassiveClockBank()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            webSocketConnector: server,
            fallbackPollingInitialDelay: .seconds(60),
            aggregatePeerRefreshSleep: { try await clocks.sleep(id: $0, interval: $1) },
            aggregateStreamRetrySleep: { _, _ in },
            aggregatePublishSleep: {},
            aggregateRefreshReceipt: { receipts.record($0) }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.client.initialSnapshot()
        let threadID = FeatureScopedID.thread(environmentID: "two", wireID: "thread-two")
        await server.waitForSubscriptions(host: "two.example", count: 1)
        try await receipts.waitForHTTP("two", count: 1)
        // HTTP completion can mean a rejected read after the socket epoch
        // changed. Establish an applied baseline before using its detail route.
        try await server.snapshot(multiEnvironmentShell(
            projectID: "project-two", threadID: "thread-two", title: "Before removal", snapshotSequence: 9
        ), host: "two.example")
        try await receipts.waitForShells("two", count: 1)
        _ = try await fixture.client.loadThread(id: threadID)
        await server.waitForSubscriptions(host: "two.example#detail", count: 1)
        let baseline = multiEnvironmentShell(projectID: "project-two", threadID: "thread-two", title: "Removed", snapshotSequence: 10)
        try await server.snapshot(OrchestrationShellSnapshot(
            snapshotSequence: 10, projects: baseline.projects, threads: [], updatedAt: baseline.updatedAt
        ), host: "two.example")
        try await receipts.waitForShells("two", count: 2)
        await server.waitForInterrupts(host: "two.example#detail", count: 1)
        #expect(await server.subscriptionCount(host: "one.example") == 1)
        await fixture.client.disconnect()
    }

}

@MainActor
private final class PassiveLiveReceipts {
    private(set) var sequences: [String: [Int]] = [:]
    private var counts: [String: Int] = [:]
    private var waiters: [UUID: (String, Int, CheckedContinuation<Void, Error>)] = [:]

    func record(_ receipt: NativePassiveShellReceipt) {
        let key: String
        switch receipt {
        case let .shellApplied(id, sequence):
            sequences[id, default: []].append(sequence)
            key = "shell:" + id
        case let .httpFinished(id): key = "http:" + id
        case let .configurationApplied(id): key = "config:" + id
        case let .archiveFinished(id): key = "archive:" + id
        }
        counts[key, default: 0] += 1
        let ready = waiters.filter { counts[$0.value.0, default: 0] >= $0.value.1 }
        for (id, waiter) in ready {
            waiters[id] = nil
            waiter.2.resume()
        }
    }

    func httpCount(_ id: String) -> Int { counts["http:" + id, default: 0] }
    func waitForShells(_ id: String, count: Int) async throws { try await wait("shell:" + id, count: count) }
    func waitForHTTP(_ id: String, count: Int) async throws { try await wait("http:" + id, count: count) }
    func waitForConfiguration(_ id: String) async throws { try await wait("config:" + id, count: 1) }
    func waitForArchive(_ id: String) async throws { try await wait("archive:" + id, count: 1) }

    private func wait(_ key: String, count: Int) async throws {
        try Task.checkCancellation()
        guard counts[key, default: 0] < count else { return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiters[id] = (key, count, continuation)
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.waiters.removeValue(forKey: id)?.2.resume(throwing: CancellationError())
            }
        }
    }
}

private actor PassiveClockBank {
    private var clocks: [String: ControllableAggregateRefreshSleep] = [:]

    private func clock(_ id: String) -> ControllableAggregateRefreshSleep {
        if let clock = clocks[id] { return clock }
        let clock = ControllableAggregateRefreshSleep()
        clocks[id] = clock
        return clock
    }

    func sleep(id: String, interval: Duration) async throws {
        try await clock(id).sleep(for: interval)
    }

    func resumeInitial(_ id: String) async {
        let clock = clock(id)
        _ = await clock.waitUntilRequested(count: 1)
        await clock.resume()
    }
}

private actor PassiveLiveServer: WebSocketConnecting {
    struct Subscription: Sendable {
        let connection: PassiveLiveConnection
        let requestID: Int
        let payload: JSONValue?
    }
    private let configs = MultiEnvironmentConfigurationServer()
    private var archiveGates: [String: PassiveRequestGate] = [:]
    func holdArchive(host: String, gate: PassiveRequestGate) { archiveGates[host] = gate }
    private var subscriptions: [String: [Subscription]] = [:]
    private var interrupts: [String: Int] = [:]
    private var waiters: [(String, Int, Bool, CheckedContinuation<Void, Never>)] = []

    func connect(to url: URL) -> any WebSocketConnection {
        PassiveLiveConnection(host: url.host ?? "", server: self)
    }

    func request(_ value: JSONValue, host: String, connection: PassiveLiveConnection) async throws -> JSONValue? {
        if let tag = value["tag"]?.stringValue,
           tag == RPCMethod.subscribeShell.rawValue || tag == RPCMethod.subscribeThread.rawValue,
           case let .number(id)? = value["id"] {
            let key = tag == RPCMethod.subscribeThread.rawValue ? host + "#detail" : host
            subscriptions[key, default: []].append(Subscription(connection: connection, requestID: Int(id), payload: value["payload"]))
            resumeWaiters()
            return nil
        }
        if value["_tag"]?.stringValue == "Interrupt", case let .number(id)? = value["requestId"] {
            for key in [host, host + "#detail"] where subscriptions[key, default: []].contains(where: {
                $0.connection === connection && $0.requestID == Int(id)
            }) {
                interrupts[key, default: 0] += 1
            }
            resumeWaiters()
        }
        if value["_tag"]?.stringValue == "Ping" { return .object(["_tag": .string("Pong")]) }
        if value["tag"]?.stringValue == RPCMethod.dispatchCommand.rawValue,
           ["thread.meta.update", "thread.unarchive"].contains(value["payload"]?["type"]?.stringValue ?? ""),
           case let .number(id)? = value["id"] {
            return .object([
                "_tag": .string("Exit"), "requestId": .number(id),
                "exit": .object(["_tag": .string("Success"), "value": try JSONValue.encode(DispatchResult(sequence: 10))]),
            ])
        }
        if value["tag"]?.stringValue == RPCMethod.getArchivedShellSnapshot.rawValue,
           let gate = archiveGates.removeValue(forKey: host) { await gate.enter() }
        return try await configs.response(to: value, host: host)
    }

    func lastPayload(host: String) -> JSONValue? { subscriptions[host]?.last?.payload }

    func waitForSubscriptions(host: String, count: Int) async { await wait(host: host, count: count, interrupt: false) }
    func waitForInterrupts(host: String, count: Int) async { await wait(host: host, count: count, interrupt: true) }

    private func count(_ host: String, interrupt: Bool) -> Int {
        interrupt ? interrupts[host, default: 0] : subscriptions[host, default: []].count
    }

    private func wait(host: String, count: Int, interrupt: Bool) async {
        guard self.count(host, interrupt: interrupt) < count else { return }
        await withCheckedContinuation { waiters.append((host, count, interrupt, $0)) }
    }

    private func resumeWaiters() {
        let ready = waiters.filter { count($0.0, interrupt: $0.2) >= $0.1 }
        waiters.removeAll { count($0.0, interrupt: $0.2) >= $0.1 }
        ready.forEach { $0.3.resume() }
    }

    func emit(_ values: [JSONValue], host: String) async throws {
        guard let subscription = subscriptions[host]?.last else { throw URLError(.notConnectedToInternet) }
        try await subscription.connection.enqueue(.object([
            "_tag": .string("Chunk"), "requestId": .number(Double(subscription.requestID)), "values": .array(values),
        ]))
    }

    func snapshot(_ shell: OrchestrationShellSnapshot, host: String) async throws {
        try await emit([.object(["kind": .string("snapshot"), "snapshot": try JSONValue.encode(shell)])], host: host)
    }

    func upsert(_ thread: OrchestrationThreadShell, sequence: Int, host: String) async throws {
        try await emit([.object([
            "kind": .string("thread-upserted"), "sequence": .number(Double(sequence)), "thread": try JSONValue.encode(thread),
        ])], host: host)
    }

    func finish(host: String) async throws {
        guard let subscription = subscriptions[host]?.last else { throw URLError(.notConnectedToInternet) }
        try await subscription.connection.enqueue(.object([
            "_tag": .string("Exit"), "requestId": .number(Double(subscription.requestID)),
            "exit": .object(["_tag": .string("Success"), "value": .null]),
        ]))
    }

    func subscriptionCount(host: String) -> Int { subscriptions[host, default: []].count }

    func closeLatest(host: String) async { await subscriptions[host]?.last?.connection.close() }
}

private actor PassiveLiveConnection: WebSocketConnection {
    private let host: String
    private let server: PassiveLiveServer
    private var responses: [Data] = []
    private var receiver: CheckedContinuation<Data, Error>?
    private var closed = false

    init(host: String, server: PassiveLiveServer) { self.host = host; self.server = server }

    func send(_ data: Data) async throws {
        guard !closed else { throw URLError(.networkConnectionLost) }
        let value = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        if let response = try await server.request(value, host: host, connection: self) { try enqueue(response) }
    }

    func enqueue(_ value: JSONValue) throws {
        let data = try JSONEncoder.t3.encode(value)
        if let receiver { self.receiver = nil; receiver.resume(returning: data) }
        else { responses.append(data) }
    }

    func receive() async throws -> Data {
        guard !closed else { throw URLError(.networkConnectionLost) }
        if !responses.isEmpty { return responses.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func close() {
        closed = true
        receiver?.resume(throwing: URLError(.networkConnectionLost))
        receiver = nil
    }
}

@Suite("Native incremental bootstrap")
@MainActor
struct NativeIncrementalBootstrapTests {
    @Test("Foreground restores bootstrap before a client has been adopted", .timeLimit(.minutes(1)))
    func foregroundRestartsUnadoptedClient() async throws {
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            fallbackPollingInitialDelay: .seconds(60), aggregatePublishSleep: {}
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let recorder = BootstrapSnapshotRecorder(
            seed: FeatureSnapshot(connection: .init(state: .disconnected)), events: fixture.client.events()
        )
        defer { recorder.stop() }
        fixture.client.suspendForBackground()
        await fixture.client.resumeAfterBackground(reconnect: false)
        let restored = try await recorder.wait { $0.threads.contains { $0.environmentID == "one" } }
        #expect(restored.environments.contains { $0.id == "one" })
        await fixture.client.disconnect()
    }

    @Test("An archive refresh reads the current shell after the archive RPC settles", .timeLimit(.minutes(1)))
    func archiveRefreshReadsShellAfterArchive() async throws {
        let receipts = PassiveLiveReceipts()
        let server = PassiveLiveServer()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            webSocketConnector: server, fallbackPollingInitialDelay: .seconds(60),
            aggregatePublishSleep: {}, aggregateRefreshReceipt: { receipts.record($0) }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.hydratedSnapshot()
        let recorder = try #require(fixture.recorder)
        try await receipts.waitForArchive("one")
        let archive = PassiveRequestGate()
        await server.holdArchive(host: "one.example", gate: archive)
        let refresh = Task { try await fixture.client.setThreadArchived(id: "thread-one", archived: false) }
        do {
            try await archive.waitUntilEnteredCancellable()
            await fixture.transport.setShell(multiEnvironmentShell(
                projectID: "project-one", threadID: "thread-one", title: "Current after archive", snapshotSequence: 20
            ), host: "one.example")
            await archive.release()
            try await refresh.value
            #expect(recorder.history.last?.threads.contains { $0.title == "Current after archive" } == true)
        } catch {
            await archive.release()
            refresh.cancel()
            _ = try? await refresh.value
            await fixture.client.disconnect()
            throw error
        }
        await fixture.client.disconnect()
    }

    @Test("Metadata returns while active HTTP and catalogue are held; a healthy peer publishes", .timeLimit(.minutes(1)))
    func heldActiveDoesNotBlockHealthyPeer() async throws {
        let connector = BootstrapHeldConnector()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            includeThirdEnvironment: true, webSocketConnector: connector,
            rpcConnectionWaitTimeout: .seconds(60), fallbackPollingInitialDelay: .seconds(60), aggregatePublishSleep: {}
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let active = PassiveRequestGate()
        let passive = PassiveRequestGate()
        await fixture.transport.holdNextShell(host: "one.example", gate: active)
        await fixture.transport.holdNextShell(host: "two.example", gate: passive)
        let seed = try await fixture.client.initialSnapshot()
        #expect(Set(seed.environments.map(\.id)) == ["one", "two", "three"])
        #expect(seed.threads.isEmpty)
        #expect(seed.environments.allSatisfy { $0.connectionState != .connected })
        let recorder = BootstrapSnapshotRecorder(seed: seed, events: fixture.client.events())
        defer { recorder.stop() }
        try await active.waitUntilEnteredCancellable()
        try await passive.waitUntilEnteredCancellable()
        try await connector.gate.waitUntilEnteredCancellable()
        let healthy = try await recorder.wait { snapshot in
            snapshot.threads.contains { $0.environmentID == "three" }
                && snapshot.environments.first { $0.id == "three" }?.connectionState == .connected
        }
        #expect(await active.isHeld)
        #expect(await passive.isHeld)
        #expect(await connector.gate.isHeld)
        #expect(healthy.environments.first { $0.id == "one" }?.connectionState != .connected)
        await active.release()
        await passive.release()
        await connector.gate.release()
        await fixture.client.disconnect()
    }

    @Test("Catalog and synchronized markers cannot authorize an empty outbox view", .timeLimit(.minutes(1)))
    func authorityAndRowsPublishTogether() async throws {
        let receipts = PassiveLiveReceipts()
        let server = PassiveLiveServer()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            webSocketConnector: server, fallbackPollingInitialDelay: .seconds(60),
            aggregatePublishSleep: {}, aggregateRefreshReceipt: { receipts.record($0) }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let held = PassiveRequestGate()
        await fixture.transport.holdNextShell(host: "one.example", gate: held)
        let seed = try await fixture.client.initialSnapshot()
        let recorder = BootstrapSnapshotRecorder(seed: seed, events: fixture.client.events())
        defer { recorder.stop() }
        let submission = FeatureQueuedSubmission(
            environmentID: "one", identity: .init(threadID: "thread-one"),
            threadID: FeatureScopedID.thread(environmentID: "one", wireID: "thread-one"),
            text: "Queued before hydration", selection: nil, runtimeMode: .fullAccess,
            interactionMode: .standard, attachments: []
        )
        #expect(FeatureOutboxPolicy.decision(for: submission, snapshot: seed) == .wait)
        try await held.waitUntilEnteredCancellable()
        await server.waitForSubscriptions(host: "one.example", count: 1)
        try await server.emit([.object(["kind": .string("synchronized")])], host: "one.example")
        try await receipts.waitForConfiguration("one")
        let shell = multiEnvironmentShell(projectID: "project-one", threadID: "thread-one", title: "Authoritative", snapshotSequence: 10)
        try await server.snapshot(shell, host: "one.example")
        let ready = try await recorder.wait { $0.threads.contains { $0.title == "Authoritative" } }
        #expect(FeatureOutboxPolicy.decision(for: submission, snapshot: ready) == .send)
        for snapshot in recorder.history {
            let connected = snapshot.environments.first { $0.id == "one" }?.connectionState == .connected
            #expect(!connected || snapshot.threads.contains { $0.id == submission.threadID })
            #expect(FeatureOutboxPolicy.decision(for: submission, snapshot: snapshot) != .discard)
        }
        #expect(await held.isHeld)
        await held.release()
        await fixture.client.disconnect()
    }

    @Test("Same-client reload rejects a late old HTTP response and retains cached rows", .timeLimit(.minutes(1)))
    func reloadRetainsCacheAndRejectsOldRead() async throws {
        let receipts = PassiveLiveReceipts()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            fallbackPollingInitialDelay: .seconds(60), aggregatePublishSleep: {},
            aggregateRefreshReceipt: { receipts.record($0) }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let seed = try await fixture.client.initialSnapshot()
        let recorder = BootstrapSnapshotRecorder(seed: seed, events: fixture.client.events())
        defer { recorder.stop() }
        _ = try await recorder.wait { $0.threads.count == 2 }
        let old = PassiveRequestGate()
        await fixture.transport.setShell(multiEnvironmentShell(projectID: "project-one", threadID: "thread-one", title: "Stale old request", snapshotSequence: 999), host: "one.example")
        await fixture.transport.holdNextShell(host: "one.example", gate: old)
        let cached = try await fixture.client.initialSnapshot()
        #expect(cached.threads.count == 2)
        #expect(cached.environments.allSatisfy { $0.connectionState != .connected })
        try await old.waitUntilEnteredCancellable()
        await fixture.transport.setShell(multiEnvironmentShell(projectID: "project-one", threadID: "thread-one", title: "Current reload", snapshotSequence: 2), host: "one.example")
        _ = try await fixture.client.initialSnapshot()
        _ = try await recorder.wait { $0.threads.contains { $0.title == "Current reload" } }
        await old.release()
        try await receipts.waitForHTTP("one", count: 3)
        #expect(!recorder.history.contains { $0.threads.contains { $0.title == "Stale old request" } })
        await fixture.client.disconnect()
    }

    @Test("A current HTTP command refresh keeps the live header reconnecting while its rows are ready", .timeLimit(.minutes(1)))
    func currentHTTPCommandPreservesReconnectingHeader() async throws {
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            fallbackPollingInitialDelay: .seconds(60), aggregatePublishSleep: {}
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        do {
            _ = try await fixture.hydratedSnapshot()
            let recorder = try #require(fixture.recorder)
            await fixture.transport.setShell(multiEnvironmentShell(
                projectID: "project-one", threadID: "thread-one", title: "HTTP command result", snapshotSequence: 2
            ), host: "one.example")
            try await fixture.client.renameThread(id: "thread-one", title: "HTTP command result")
            let updated = try await recorder.wait { $0.threads.contains { $0.title == "HTTP command result" } }
            #expect(updated.connection.state == .reconnecting)
            #expect(updated.environments.first { $0.id == "one" }?.connectionState == .connected)
            #expect(await fixture.transport.dispatchRecords().count == 1)
        } catch {
            await fixture.client.disconnect()
            throw error
        }
        await fixture.client.disconnect()
    }

    @Test("A public rename's old optional shell cannot authorize a replacement bootstrap", .timeLimit(.minutes(1)))
    func oldCommandRefreshCannotAuthorizeReload() async throws {
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            fallbackPollingInitialDelay: .seconds(60), aggregatePublishSleep: {}
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        _ = try await fixture.hydratedSnapshot()
        let recorder = try #require(fixture.recorder)
        let oldRead = PassiveRequestGate()
        let replacementRead = PassiveRequestGate()
        let stale = multiEnvironmentShell(projectID: "project-one", threadID: "thread-one", title: "Old command shell", snapshotSequence: 999)
        await fixture.transport.setShell(stale, host: "one.example")
        await fixture.transport.holdNextShell(host: "one.example", gate: oldRead)
        let command = Task { try await fixture.client.renameThread(id: "thread-one", title: "Rename once") }
        do {
            try await oldRead.waitUntilEnteredCancellable()
            await fixture.transport.setShell(multiEnvironmentShell(projectID: "project-one", threadID: "thread-one", title: "Replacement bootstrap", snapshotSequence: 2), host: "one.example")
            await fixture.transport.holdNextShell(host: "one.example", gate: replacementRead)
            let seed = try await fixture.client.initialSnapshot()
            recorder.record(seed)
            try await replacementRead.waitUntilEnteredCancellable()
            await oldRead.release()
            try await command.value
            #expect(recorder.history.last?.environments.first { $0.id == "one" }?.connectionState != .connected)
            #expect(!recorder.history.contains { $0.threads.contains { $0.title == "Old command shell" } })
            await replacementRead.release()
            _ = try await recorder.wait { $0.threads.contains { $0.title == "Replacement bootstrap" } }
        } catch {
            await oldRead.release()
            await replacementRead.release()
            command.cancel()
            _ = try? await command.value
            await fixture.client.disconnect()
            throw error
        }
        await fixture.client.disconnect()
    }

    @Test("A cancelled old archive cannot authorize a same-client reload", .timeLimit(.minutes(1)))
    func oldArchiveCannotAuthorizeReload() async throws {
        let receipts = PassiveLiveReceipts()
        let server = PassiveLiveServer()
        let archive = PassiveRequestGate()
        await server.holdArchive(host: "one.example", gate: archive)
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            webSocketConnector: server, fallbackPollingInitialDelay: .seconds(60),
            aggregatePublishSleep: {}, aggregateRefreshReceipt: { receipts.record($0) }
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let seed = try await fixture.client.initialSnapshot()
        let recorder = BootstrapSnapshotRecorder(seed: seed, events: fixture.client.events())
        defer { recorder.stop() }
        _ = try await recorder.wait { $0.threads.contains { $0.environmentID == "one" } }
        try await archive.waitUntilEnteredCancellable()
        let heldShell = PassiveRequestGate()
        await fixture.transport.holdNextShell(host: "one.example", gate: heldShell)
        let reload = try await fixture.client.initialSnapshot()
        recorder.record(reload)
        let startIndex = recorder.history.count - 1
        try await heldShell.waitUntilEnteredCancellable()
        await archive.release()
        try await receipts.waitForArchive("one")
        for snapshot in recorder.history.dropFirst(startIndex) {
            #expect(snapshot.environments.first { $0.id == "one" }?.connectionState != .connected)
        }
        #expect(await heldShell.isHeld)
        await heldShell.release()
        await fixture.client.disconnect()
    }

    @Test("Unknown active events repair once, then a replacement stream delivers deltas", .timeLimit(.minutes(1)))
    func unknownActiveStreamRepairsAndResubscribes() async throws {
        let server = PassiveLiveServer()
        let retries = ControllableAggregateRefreshSleep()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            webSocketConnector: server, fallbackPollingInitialDelay: .seconds(60),
            aggregateStreamRetrySleep: { id, interval in
                if id == "one" { try await retries.sleep(for: interval) }
            }, aggregatePublishSleep: {}
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let seed = try await fixture.client.initialSnapshot()
        let recorder = BootstrapSnapshotRecorder(seed: seed, events: fixture.client.events())
        defer { recorder.stop() }
        await server.waitForSubscriptions(host: "one.example", count: 1)
        let baseline = multiEnvironmentShell(projectID: "project-one", threadID: "thread-one", title: "Active live baseline", snapshotSequence: 10)
        try await server.snapshot(baseline, host: "one.example")
        _ = try await recorder.wait { $0.threads.contains { $0.title == "Active live baseline" } }
        let held = PassiveRequestGate()
        let repaired = multiEnvironmentShell(projectID: "project-one", threadID: "thread-one", title: "Active HTTP repaired", snapshotSequence: 20)
        await fixture.transport.setShell(repaired, host: "one.example")
        await fixture.transport.holdNextShell(host: "one.example", gate: held)
        try await server.emit([.object(["kind": .string("unknown-active-event")])], host: "one.example")
        try await held.waitUntilEnteredCancellable()
        #expect(await retries.waitUntilRequested(count: 1) == .seconds(20))
        // These are delivered to the discarded subscription and cannot poison repair.
        for sequence in 21...23 { try await server.upsert(baseline.threads[0], sequence: sequence, host: "one.example") }
        await held.release()
        _ = try await recorder.wait { $0.threads.contains { $0.title == "Active HTTP repaired" } }
        #expect(await server.subscriptionCount(host: "one.example") == 1)
        await retries.resume()
        await server.waitForSubscriptions(host: "one.example", count: 2)
        try await server.snapshot(repaired, host: "one.example")
        let delta = multiEnvironmentShell(projectID: "project-one", threadID: "thread-one", title: "Active delta recovered", snapshotSequence: 24)
        try await server.upsert(delta.threads[0], sequence: 24, host: "one.example")
        _ = try await recorder.wait { $0.threads.contains { $0.title == "Active delta recovered" } }
        await fixture.client.disconnect()
    }

    @Test("A failed initial socket attempt cannot invalidate its independent HTTP read", .timeLimit(.minutes(1)))
    func failedSocketDoesNotStarveHTTP() async throws {
        let connector = FailedBootstrapAttemptConnector()
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            webSocketConnector: connector, fallbackPollingInitialDelay: .seconds(60), aggregatePublishSleep: {}
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let held = PassiveRequestGate()
        await fixture.transport.holdNextShell(host: "one.example", gate: held)
        let seed = try await fixture.client.initialSnapshot()
        let recorder = BootstrapSnapshotRecorder(seed: seed, events: fixture.client.events())
        defer { recorder.stop() }
        do {
        try await held.waitUntilEnteredCancellable()
        try await connector.waitForFailure()
        await held.release()
        let ready = try await recorder.wait {
            $0.environments.first { $0.id == "one" }?.connectionState == .connected
        }
        #expect(ready.threads.contains { $0.environmentID == "one" })
        #expect(await fixture.transport.shellReadCount(host: "one.example") == 1)
        } catch {
            await held.release()
            await fixture.client.disconnect()
            throw error
        }
        await fixture.client.disconnect()
    }
}

/// One collector per fixture; any number of predicates observe the same snapshots.
@MainActor
final class BootstrapSnapshotRecorder {
    private(set) var history: [FeatureSnapshot]
    private var task: Task<Void, Never>?
    private var waiters: [UUID: (@MainActor (FeatureSnapshot) -> Bool, CheckedContinuation<FeatureSnapshot, Error>)] = [:]
    private var finished = false

    init(seed: FeatureSnapshot, events: AsyncStream<FeatureEvent>) {
        history = [seed]
        task = Task { [weak self] in
            for await event in events {
                guard !Task.isCancelled else { break }
                guard let self else { break }
                switch event {
                case let .snapshot(snapshot): self.record(snapshot)
                case let .thread(thread):
                    guard var snapshot = self.history.last else { continue }
                    if let index = snapshot.threads.firstIndex(where: { $0.id == thread.id }) {
                        snapshot.threads[index] = thread
                    } else { snapshot.threads.append(thread) }
                    self.record(snapshot)
                case let .threadRemoved(id):
                    guard var snapshot = self.history.last else { continue }
                    snapshot.threads.removeAll { $0.id == id }
                    self.record(snapshot)
                default: break
                }
            }
            self?.stop()
        }
    }

    func record(_ snapshot: FeatureSnapshot) {
        history.append(snapshot)
        let ready = waiters.filter { $0.value.0(snapshot) }
        for (id, waiter) in ready {
            waiters[id] = nil
            waiter.1.resume(returning: snapshot)
        }
    }

    func wait(_ predicate: @escaping @MainActor (FeatureSnapshot) -> Bool) async throws -> FeatureSnapshot {
        try Task.checkCancellation()
        if let snapshot = history.last, predicate(snapshot) { return snapshot }
        guard !finished else { throw CancellationError() }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiters[id] = (predicate, continuation)
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.waiters.removeValue(forKey: id)?.1.resume(throwing: CancellationError())
            }
        }
    }

    func stop() {
        finished = true
        task?.cancel()
        task = nil
        let pending = waiters.values
        waiters.removeAll()
        pending.forEach { $0.1.resume(throwing: CancellationError()) }
    }

    deinit { task?.cancel() }
}

private actor BootstrapHeldConnector: WebSocketConnecting {
    let gate = PassiveRequestGate()
    func connect(to url: URL) async throws -> any WebSocketConnection {
        if url.host == "one.example" { await gate.enter() }
        throw URLError(.cannotConnectToHost)
    }
}

@Suite("Native bootstrap durable outbox")
@MainActor
struct NativeBootstrapRootOutboxTests {
    @Test("A persisted follow-up waits through another peer's update and sends once after its owner hydrates", .timeLimit(.minutes(1)))
    func restoredFollowUpWaitsForOwningShell() async throws {
        let fixture = try await NativeMultiEnvironmentTests.makeFixture(
            fallbackPollingInitialDelay: .seconds(60), aggregatePublishSleep: {}
        )
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let outbox = FeatureOutboxStore(fileURL: fixture.directory.appendingPathComponent("root-outbox.json"))
        let drafts = FeatureComposerDraftStore(fileURL: fixture.directory.appendingPathComponent("root-drafts.json"))
        let threadID = FeatureScopedID.thread(environmentID: "two", wireID: "thread-two")
        let identity = FeatureSubmissionIdentity(threadID: "thread-two", commandID: "bootstrap-root-command", messageID: "bootstrap-root-message")
        let submission = FeatureQueuedSubmission(
            environmentID: "two", identity: identity, threadID: threadID,
            text: "Persisted before the peer loaded", selection: nil,
            runtimeMode: .fullAccess, interactionMode: .standard, attachments: []
        )
        try await outbox.enqueue(submission)
        let heldShell = PassiveRequestGate()
        let heldDispatch = PassiveRequestGate()
        await fixture.transport.holdNextShell(host: "two.example", gate: heldShell)
        await fixture.transport.holdNextDispatch(host: "two.example", gate: heldDispatch)
        let model = FeatureRootModel(client: fixture.client, outboxStore: outbox, draftStore: drafts)
        let run = Task { await model.start() }
        do {
        try await heldShell.waitUntilEnteredCancellable()
        let healthy = RootObservationWaiter {
            !model.isLoading && model.snapshot.threads.contains { $0.environmentID == "one" }
        }
        try await healthy.wait()
        #expect(model.snapshot.environments.first { $0.id == "two" }?.connectionState != .connected)
        #expect(try await outbox.submissions().map(\.id) == [submission.id])
        #expect(await fixture.transport.dispatchRecords().isEmpty)
        #expect(await heldShell.isHeld)

        await heldShell.release()
        try await heldDispatch.waitUntilEnteredCancellable()
        // Load the real detail while acceptance is held; the root attaches its
        // restored queued message, giving an observable completion after removal.
        _ = await model.detail(for: threadID)
        #expect(model.details[threadID]?.messages.first { $0.id == identity.messageID }?.state == .queued)
        let completed = RootObservationWaiter {
            model.details[threadID]?.messages.first { $0.id == identity.messageID }?.state == .complete
        }
        await heldDispatch.release()
        try await completed.wait()
        // Message acceptance may precede durable deletion. Wait for the actual
        // owned outbox file change, independent of that presentation ordering.
        try await OwnedOutboxRemovalWaiter(fileURL: fixture.directory.appendingPathComponent("root-outbox.json")).wait()
        #expect(try await outbox.submissions().isEmpty)
        let commands = await fixture.transport.dispatchRecords()
        #expect(commands.count == 1)
        #expect(commands.first?.host == "two.example")
        #expect(commands.first?.command["commandId"]?.stringValue == identity.commandID)
        #expect(commands.first?.command["threadId"]?.stringValue == identity.threadID)
        #expect(commands.first?.command["message"]?["messageId"]?.stringValue == identity.messageID)
        #expect(model.errorMessage == nil)
        } catch {
            await heldShell.release()
            await heldDispatch.release()
            run.cancel()
            await fixture.client.disconnect()
            await run.value
            throw error
        }
        await heldShell.release()
        await heldDispatch.release()
        run.cancel()
        await fixture.client.disconnect()
        await run.value
    }
}

/// Observe the root's applied state without taking a second client event iterator.
@MainActor
private final class RootObservationWaiter {
    private let predicate: @MainActor () -> Bool
    private var continuation: CheckedContinuation<Void, Error>?

    init(_ predicate: @escaping @MainActor () -> Bool) { self.predicate = predicate }

    func wait() async throws {
        try Task.checkCancellation()
        if predicate() { return }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                observe()
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.finish(.failure(CancellationError()))
            }
        }
    }

    private func observe() {
        guard continuation != nil else { return }
        let ready = withObservationTracking { predicate() } onChange: { [weak self] in
            Task { @MainActor in self?.observe() }
        }
        if ready { finish(.success(())) }
    }

    private func finish(_ result: Result<Void, Error>) {
        let pending = continuation
        continuation = nil
        pending?.resume(with: result)
    }
}


/// The test watches only its owned directory. Atomic store writes replace the
/// file, so observing the directory avoids retaining an obsolete file inode.
@MainActor
private final class OwnedOutboxRemovalWaiter {
    private let fileURL: URL
    private var source: DispatchSourceFileSystemObject?
    private var continuation: CheckedContinuation<Void, Error>?

    init(fileURL: URL) { self.fileURL = fileURL }

    func wait() async throws {
        try Task.checkCancellation()
        let descriptor = open(fileURL.deletingLastPathComponent().path, O_EVTONLY)
        guard descriptor >= 0 else { throw POSIXError(.EIO) }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor, eventMask: [.write, .rename], queue: .global()
        )
        self.source = source
        source.setCancelHandler { close(descriptor) }
        source.setEventHandler { [weak self] in
            Task { @MainActor in self?.check() }
        }
        source.resume()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                check()
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.finish(.failure(CancellationError())) }
        }
    }

    private func check() {
        guard continuation != nil else { return }
        do {
            let document = try JSONSerialization.jsonObject(with: Data(contentsOf: fileURL)) as? [String: Any]
            guard let submissions = document?["submissions"] as? [Any] else { throw URLError(.cannotParseResponse) }
            if submissions.isEmpty { finish(.success(())) }
        } catch { finish(.failure(error)) }
    }

    private func finish(_ result: Result<Void, Error>) {
        let pending = continuation
        continuation = nil
        source?.cancel()
        source = nil
        pending?.resume(with: result)
    }
}


/// Observe the failed connector attempt itself: the RPC subscription deliberately
/// keeps waiting for its first usable socket instead of failing with a UI header.
private actor FailedBootstrapAttemptConnector: WebSocketConnecting {
    private let failures = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))

    func connect(to url: URL) async throws -> any WebSocketConnection {
        if url.host == "one.example" { failures.continuation.yield(()) }
        throw URLError(.cannotConnectToHost)
    }

    func waitForFailure() async throws {
        try Task.checkCancellation()
        var iterator = failures.stream.makeAsyncIterator()
        guard await iterator.next() != nil else { throw CancellationError() }
        try Task.checkCancellation()
    }
}
