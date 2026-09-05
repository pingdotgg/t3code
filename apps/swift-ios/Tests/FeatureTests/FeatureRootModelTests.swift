import Foundation
import Observation
import SwiftUI
import Testing
import UIKit
import XCTest
@testable import T3Code

@MainActor
@Suite("Feature root model")
struct FeatureRootModelTests {
    @Test
    func foregroundRecoveryIgnoresInitialActivationAndReplacesLongSuspendedSockets() async {
        let client = FeatureClientStub()
        let model = testRootModel(client: client)
        let start = Date(timeIntervalSince1970: 100)
        await model.applicationDidBecomeActive(at: start)
        #expect(client.foregroundReconnects.isEmpty)
        model.applicationDidEnterBackground(at: start)
        await model.applicationDidBecomeActive(at: start.addingTimeInterval(9))
        model.applicationDidEnterBackground(at: start)
        await model.applicationDidBecomeActive(at: start.addingTimeInterval(10))
        await model.applicationDidBecomeActive(at: start.addingTimeInterval(11))
        #expect(client.foregroundReconnects == [false, true])
    }

    @Test
    func connectedComputerDoesNotHideThreadCatchUpOrItsFailure() {
        #expect(ThreadRefreshPresentation.resolve(
            loadState: nil, connectionState: .connected, isOpening: false, syncState: .catchingUp
        ) == .catchingUp)
        #expect(ThreadRefreshPresentation.resolve(
            loadState: nil, connectionState: .connected, isOpening: false, syncState: .failed("Timeout")
        ) == .failed)
        #expect(ThreadRefreshPresentation.resolve(
            loadState: nil, connectionState: .connected, isOpening: false, syncState: .live
        ) == nil)
    }

    @Test
    func liveThreadSyncOutranksStaleLoadingAndEnvironmentReachability() {
        for connectionState in [FeatureConnection.State.connected, .disconnected, .reconnecting] {
            #expect(ThreadRefreshPresentation.resolve(
                loadState: nil, connectionState: connectionState, isOpening: false, syncState: .live
            ) == nil)
            #expect(ThreadRefreshPresentation.resolve(
                loadState: .loading, connectionState: connectionState, isOpening: false, syncState: .live
            ) == nil)
            #expect(ThreadRefreshPresentation.resolve(
                loadState: .failed("Timeout"), connectionState: connectionState, isOpening: false, syncState: .live
            ) == nil)
            #expect(ThreadRefreshPresentation.resolve(
                loadState: .loading, connectionState: connectionState, isOpening: true, syncState: .live
            ) == nil)
        }
    }

    @Test
    func repeatedCatchUpEventsDoNotInvalidateViewState() async {
        let client = FeatureClientStub()
        let model = testRootModel(client: client)
        let run = Task { await model.start() }
        await withCheckedContinuation { continuation in
            withObservationTracking {
                _ = model.threadSyncStates["thread"]
            } onChange: {
                continuation.resume()
            }
            client.emit(.threadSync(id: "thread", state: .catchingUp))
        }
        let changes = AsyncStream<Void>.makeStream()
        withObservationTracking {
            _ = model.threadSyncStates["thread"]
        } onChange: {
            changes.continuation.yield()
        }
        client.emit(.threadSync(id: "thread", state: .catchingUp))
        client.finishEvents()
        await run.value
        changes.continuation.finish()
        let didChange = await changes.stream.contains { _ in true }
        #expect(!didChange)
        #expect(model.threadSyncStates["thread"] == .catchingUp)
    }

    @Test
    func appearanceAppliesImmediatelyAndPersistsWithoutSavingTheDraft() async {
        let client = FeatureClientStub()
        let model = testRootModel(client: client)

        let save = Task { await model.saveAppearance(.light) }
        await Task.yield()

        #expect(model.snapshot.settings.appearance == .light)
        #expect(await save.value)
        #expect(client.savedSettings.last?.appearance == .light)
    }

    @Test
    func backgroundRefreshUsesTheBoundedClientPath() async {
        let client = FeatureClientStub()
        client.backgroundSnapshotValue = FeatureSnapshot(
            connection: .init(state: .connected, environmentName: "Remote")
        )
        let model = testRootModel(client: client)

        let succeeded = await model.refreshInBackground()

        #expect(succeeded)
        #expect(client.backgroundSnapshotCallCount == 1)
        #expect(client.initialSnapshotCallCount == 0)
        #expect(model.snapshot.connection.environmentName == "Remote")
    }

    @Test
    func savedServersKeepWorkspaceNavigationAvailableWhileDisconnected() {
        let savedEnvironment = FeatureEnvironment(
            id: "offline-demo",
            name: "Offline demo",
            endpoint: "https://offline.example",
            connectionState: .disconnected
        )
        let snapshot = FeatureSnapshot(
            connection: .init(state: .disconnected),
            environments: [savedEnvironment]
        )

        #expect(
            FeatureRootPresentation.showsWorkspace(
                snapshot: snapshot,
                isManagingConnections: true
            )
        )
        #expect(
            FeatureRootPresentation.showsWorkspace(
                snapshot: snapshot,
                isManagingConnections: false
            )
        )
        #expect(
            FeatureRootPresentation.showsWorkspace(
                snapshot: FeatureSnapshot(connection: .init(state: .disconnected)),
                isManagingConnections: true
            )
        )
        #expect(
            !FeatureRootPresentation.showsWorkspace(
                snapshot: FeatureSnapshot(connection: .init(state: .disconnected)),
                isManagingConnections: false
            )
        )
    }

    @Test
    func disconnectEndsConnectionManagement() async {
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "studio",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected,
                    connectionDetail: "Healthy"
                ),
            ]
        )
        let model = testRootModel(client: client)
        await model.reload()
        model.setConnectionManagementPresented(true)

        await model.disconnect()

        #expect(!model.isManagingConnections)
        #expect(model.snapshot.connection.state == .disconnected)
        #expect(model.snapshot.environments.first?.connectionState == .disconnected)
        #expect(model.snapshot.environments.first?.connectionDetail == nil)
    }

    @Test
    func restoredFollowUpWaitsForItsQueuedThreadCreation() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-dependent-outbox-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let threadID = "environment-1::thread::queued-thread"
        let creationIdentity = FeatureSubmissionIdentity(
            threadID: "queued-thread",
            commandID: "create-command",
            messageID: "create-message",
            createdAt: Date(timeIntervalSince1970: 1)
        )
        let creation = FeatureQueuedSubmission(
            environmentID: "environment-1",
            identity: creationIdentity,
            threadID: threadID,
            text: "Create the task",
            selection: .init(providerID: "codex", modelID: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            attachments: [],
            creation: .init(
                projectID: "project-1",
                projectName: "Native",
                workspaceMode: .local,
                branch: nil,
                worktreePath: nil,
                startFromOrigin: false
            )
        )
        let followUp = FeatureQueuedSubmission(
            environmentID: "environment-1",
            identity: .init(
                threadID: "queued-thread",
                commandID: "follow-up-command",
                messageID: "follow-up-message",
                createdAt: Date(timeIntervalSince1970: 2)
            ),
            threadID: threadID,
            text: "And add tests",
            selection: .init(providerID: "codex", modelID: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            attachments: []
        )
        try await store.enqueue(creation)
        try await store.enqueue(followUp)

        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ],
            projects: [
                .init(
                    id: "project-1",
                    environmentID: "environment-1",
                    name: "Native",
                    path: "/native"
                ),
            ]
        )
        client.startTaskError = URLError(.timedOut)
        client.finishEvents()
        let model = FeatureRootModel(client: client, outboxStore: store)

        await model.start()
        await model.disconnect()

        let restoredIDs = try await store.submissions().map(\.id)
        #expect(restoredIDs.count == 2)
        #expect(Set(restoredIDs) == Set([creation.id, followUp.id]))
        #expect(client.sendMessageCallCount == 0)
    }

    @Test
    func restoredCreationWaitsForItsFirstMessageEvenWhenTheThreadExists() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-partial-creation-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let identity = FeatureSubmissionIdentity(
            threadID: "created-thread",
            commandID: "create-command",
            messageID: "missing-message",
            createdAt: Date(timeIntervalSince1970: 1)
        )
        let threadID = "environment-1::thread::created-thread"
        let submission = FeatureQueuedSubmission(
            environmentID: "environment-1",
            identity: identity,
            threadID: threadID,
            text: "Do not lose the first message",
            selection: nil,
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            attachments: [
                .init(data: Data([0x01]), name: "reference.png", mimeType: "image/png"),
            ],
            creation: .init(
                projectID: "project-1",
                projectName: "Native",
                workspaceMode: .local,
                branch: nil,
                worktreePath: nil,
                startFromOrigin: false
            )
        )
        try await store.enqueue(submission)

        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ],
            projects: [
                .init(
                    id: "project-1",
                    environmentID: "environment-1",
                    name: "Native",
                    path: "/native"
                ),
            ],
            threads: [
                .init(
                    id: threadID,
                    wireID: identity.threadID,
                    projectID: "project-1",
                    environmentID: "environment-1",
                    title: "Created without a message"
                ),
            ]
        )
        client.startTaskError = URLError(.timedOut)
        client.finishEvents()
        let model = FeatureRootModel(client: client, outboxStore: store)

        await model.start()
        await model.disconnect()

        #expect(try await store.submissions() == [submission])
    }

    @Test
    func cancellingAnOfflineTaskRemovesItsDurableSubmission() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-cancel-queued-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .disconnected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .disconnected
                ),
            ],
            projects: [
                .init(
                    id: "project-1",
                    environmentID: "environment-1",
                    name: "Native",
                    path: "/native"
                ),
            ]
        )
        client.startTaskError = URLError(.notConnectedToInternet)
        let model = FeatureRootModel(client: client, outboxStore: store)
        await model.reload()
        let thread = try #require(await model.startTask(
            NewTaskRequest(
                projectID: "project-1",
                prompt: "Cancel this task",
                selection: nil,
                runtimeMode: .fullAccess,
                interactionMode: .standard
            )
        ))

        await model.cancelTurn(threadID: thread.id)

        #expect(try await store.submissions().isEmpty)
        #expect(!model.snapshot.threads.contains(where: { $0.id == thread.id }))
        #expect(client.cancelTurnCallCount == 0)
    }

    @Test
    func cancellingARestoredServerThreadAlsoInterruptsItsTurn() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-cancel-restored-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let identity = FeatureSubmissionIdentity(threadID: "created-thread")
        let threadID = "environment-1::thread::created-thread"
        let submission = FeatureQueuedSubmission(
            environmentID: "environment-1",
            identity: identity,
            threadID: threadID,
            text: "Already running on the server",
            selection: nil,
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            attachments: [],
            creation: .init(
                projectID: "project-1",
                projectName: "Native",
                workspaceMode: .local,
                branch: nil,
                worktreePath: nil,
                startFromOrigin: false
            )
        )
        try await store.enqueue(submission)

        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .disconnected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .disconnected
                ),
            ],
            projects: [
                .init(
                    id: "project-1",
                    environmentID: "environment-1",
                    name: "Native",
                    path: "/native"
                ),
            ],
            threads: [
                .init(
                    id: threadID,
                    wireID: identity.threadID,
                    projectID: "project-1",
                    environmentID: "environment-1",
                    title: "Already running",
                    state: .working
                ),
            ]
        )
        client.finishEvents()
        let model = FeatureRootModel(client: client, outboxStore: store)
        await model.start()

        await model.cancelTurn(threadID: threadID)

        #expect(client.cancelTurnCallCount == 1)
        #expect(try await store.submissions().isEmpty)
        #expect(model.snapshot.threads.contains(where: { $0.id == threadID }))
    }

    @Test(arguments: [false, true])
    func cancellingAnAcknowledgedQueuedThreadInterruptsItsTurn(
        acknowledgedBySnapshot: Bool
    ) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-cancel-acknowledged-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let identity = FeatureSubmissionIdentity(threadID: "acknowledged-thread")
        let threadID = "environment-1::thread::acknowledged-thread"
        try await store.enqueue(
            FeatureQueuedSubmission(
                environmentID: "environment-1",
                identity: identity,
                threadID: threadID,
                text: "Accepted before the outbox cleared",
                selection: nil,
                runtimeMode: .fullAccess,
                interactionMode: .standard,
                attachments: [],
                creation: .init(
                    projectID: "project-1",
                    projectName: "Native",
                    workspaceMode: .local,
                    branch: nil,
                    worktreePath: nil,
                    startFromOrigin: false
                )
            )
        )

        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .disconnected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .disconnected
                ),
            ],
            projects: [
                .init(
                    id: "project-1",
                    environmentID: "environment-1",
                    name: "Native",
                    path: "/native"
                ),
            ]
        )
        let acknowledged = FeatureThread(
            id: threadID,
            wireID: identity.threadID,
            projectID: "project-1",
            environmentID: "environment-1",
            title: "Accepted on the server",
            state: .working
        )
        if acknowledgedBySnapshot {
            var snapshot = client.snapshot
            snapshot.threads = [acknowledged]
            client.emit(.snapshot(snapshot))
        } else {
            client.emit(.thread(acknowledged))
        }
        client.finishEvents()
        let model = FeatureRootModel(client: client, outboxStore: store)
        await model.start()

        await model.cancelTurn(threadID: threadID)

        #expect(client.cancelTurnCallCount == 1)
        #expect(try await store.submissions().isEmpty)
        #expect(model.snapshot.threads == [acknowledged])
    }

    @Test
    func retryableCreationFailureReturnsTheAcknowledgedServerThread() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-acknowledged-creation-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .disconnected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .disconnected
                ),
            ],
            projects: [
                .init(
                    id: "project-1",
                    environmentID: "environment-1",
                    name: "Native",
                    path: "/native"
                ),
            ]
        )
        client.startTaskError = URLError(.notConnectedToInternet)
        let model = FeatureRootModel(client: client, outboxStore: store)
        await model.reload()
        client.beforeStartTask = {
            var acknowledged = try #require(model.snapshot.threads.first)
            acknowledged.title = "Accepted on the server"
            acknowledged.state = .working
            await withCheckedContinuation { continuation in
                withObservationTracking {
                    _ = model.snapshot.threads.first(where: { $0.id == acknowledged.id })?.state
                } onChange: {
                    continuation.resume()
                }
                client.emit(.thread(acknowledged))
            }
        }
        let run = Task { await model.start() }

        let thread = await model.startTask(
            NewTaskRequest(
                projectID: "project-1",
                prompt: "Create this task once",
                selection: nil,
                runtimeMode: .fullAccess,
                interactionMode: .standard
            )
        )
        client.finishEvents()
        await run.value

        #expect(thread?.title == "Accepted on the server")
        #expect(thread?.state == .working)
        #expect(try await store.submissions().count == 1)
    }

    @Test
    func testPairReloadsConnectedSnapshot() async {
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(connection: .init(state: .disconnected))
        client.snapshotAfterPair = FeatureSnapshot(
            connection: .init(
                state: .connected,
                environmentName: "Studio",
                endpoint: "https://studio.example"
            )
        )
        let oldThread = FeatureThread(id: "same-id", projectID: "old-project", title: "Old")
        client.threadDetail = FeatureThreadDetail(
            thread: oldThread,
            messages: [FeatureMessage(id: "old-message", role: .assistant, text: "Old")]
        )
        let model = testRootModel(client: client)
        _ = await model.detail(for: oldThread.id)

        let result = await model.pair(endpoint: "https://studio.example", token: "pair-token")

        #expect(result)
        #expect(client.pairEndpoint == "https://studio.example")
        #expect(client.pairToken == "pair-token")
        #expect(model.snapshot.connection.state == .connected)
        #expect(model.details.isEmpty)
    }

    @Test
    func togglingConnectionRefreshesItsIndependentEnabledState() async {
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            environments: [
                .init(
                    id: "studio",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isEnabled: true,
                    connectionState: .connected
                ),
            ]
        )
        client.snapshotAfterEnvironmentToggle = FeatureSnapshot(
            environments: [
                .init(
                    id: "studio",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isEnabled: false,
                    connectionState: .disconnected
                ),
            ]
        )
        let model = testRootModel(client: client)
        await model.reload()

        let toggled = await model.setEnvironmentEnabled("studio", enabled: false)

        #expect(toggled)
        #expect(client.enabledEnvironmentID == "studio")
        #expect(client.environmentEnabledValue == false)
        #expect(model.snapshot.environments.first?.isEnabled == false)
    }

    @Test
    func removingAnEnvironmentClearsItsPhysicalAndGroupedDrafts() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-draft-cleanup-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let drafts = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let outbox = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let project = FeatureProject(
            id: "project-1",
            environmentID: "environment-1",
            name: "Native",
            path: "/native",
            repositoryIdentity: FeatureRepositoryIdentity(canonicalKey: "github.com/t3/native")
        )
        let physicalKey = "environment:environment-1:thread:one"
        let logicalKey = FeatureComposerDraftStore.newTaskKey(
            logicalProjectID: "github.com/t3/native"
        )
        let otherKey = "environment:environment-2:thread:two"
        try await drafts.setDraft(FeatureComposerDraft(text: "remove physical"), for: physicalKey)
        try await drafts.setDraft(FeatureComposerDraft(text: "remove logical"), for: logicalKey)
        try await drafts.setDraft(FeatureComposerDraft(text: "keep"), for: otherKey)

        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example"
                ),
            ],
            projects: [project]
        )
        client.snapshotAfterEnvironmentRemoval = FeatureSnapshot()
        let model = FeatureRootModel(
            client: client,
            outboxStore: outbox,
            draftStore: drafts
        )
        await model.reload()

        await model.removeEnvironment("environment-1")

        #expect(try await drafts.draft(for: physicalKey) == nil)
        #expect(try await drafts.draft(for: logicalKey) == nil)
        #expect(try await drafts.draft(for: otherKey)?.text == "keep")
    }

    @Test
    func removingAnEnvironmentClearsDraftsWhenOutboxCleanupFails() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-cleanup-failure-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let drafts = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let draftKey = "environment:environment-1:thread:one"
        try await drafts.setDraft(FeatureComposerDraft(text: "Clear this draft"), for: draftKey)
        let outbox = FeatureOutboxStore(fileURL: directory)

        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example"
                ),
            ]
        )
        client.snapshotAfterEnvironmentRemoval = FeatureSnapshot()
        let model = FeatureRootModel(client: client, outboxStore: outbox, draftStore: drafts)
        await model.reload()

        await model.removeEnvironment("environment-1")

        #expect(try await drafts.draft(for: draftKey) == nil)
        #expect(model.errorMessage?.contains("queued messages or drafts") == true)
    }

    @Test
    func signingOutClearsManagedOutboxEntriesAndGroupedDrafts() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-sign-out-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let drafts = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let outbox = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let project = FeatureProject(
            id: "project-1",
            environmentID: "managed-1",
            name: "Native",
            path: "/native",
            repositoryIdentity: FeatureRepositoryIdentity(canonicalKey: "github.com/t3/native")
        )
        let groupedDraftKey = FeatureComposerDraftStore.newTaskKey(
            logicalProjectID: "github.com/t3/native"
        )
        try await drafts.setDraft(FeatureComposerDraft(text: "Private prompt"), for: groupedDraftKey)
        try await outbox.enqueue(
            FeatureQueuedSubmission(
                environmentID: "managed-1",
                identity: FeatureSubmissionIdentity(),
                threadID: "managed-1::thread::queued",
                text: "Private queued message",
                selection: nil,
                runtimeMode: .fullAccess,
                interactionMode: .standard,
                attachments: []
            )
        )

        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            environments: [
                .init(
                    id: "managed-1",
                    name: "Managed",
                    endpoint: "https://managed.example",
                    source: .t3Connect
                ),
                .init(
                    id: "manual-1",
                    name: "Manual",
                    endpoint: "https://manual.example"
                ),
            ],
            projects: [project]
        )
        let model = FeatureRootModel(
            client: client,
            outboxStore: outbox,
            draftStore: drafts
        )
        await model.reload()

        await model.signOutT3Connect()

        #expect(client.signOutCallCount == 1)
        #expect(model.snapshot.environments.map(\.id) == ["manual-1"])
        #expect(try await outbox.submissions().isEmpty)
        #expect(try await drafts.draft(for: groupedDraftKey) == nil)
    }

    @Test
    func signingOutPreservesGroupedDraftsUsedByDirectEnvironments() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-shared-draft-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let drafts = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let outbox = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let identity = FeatureRepositoryIdentity(canonicalKey: "github.com/t3/native")
        let groupedDraftKey = FeatureComposerDraftStore.newTaskKey(
            logicalProjectID: identity.canonicalKey
        )
        let managedDraftKey = "environment:managed-1:thread:one"
        try await drafts.setDraft(FeatureComposerDraft(text: "Keep shared prompt"), for: groupedDraftKey)
        try await drafts.setDraft(FeatureComposerDraft(text: "Remove managed prompt"), for: managedDraftKey)

        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            environments: [
                .init(
                    id: "managed-1",
                    name: "Managed",
                    endpoint: "https://managed.example",
                    source: .t3Connect
                ),
                .init(
                    id: "manual-1",
                    name: "Manual",
                    endpoint: "https://manual.example"
                ),
            ],
            projects: [
                .init(
                    id: "managed-project",
                    environmentID: "managed-1",
                    name: "Native",
                    path: "/managed/native",
                    repositoryIdentity: identity
                ),
                .init(
                    id: "manual-project",
                    environmentID: "manual-1",
                    name: "Native",
                    path: "/manual/native",
                    repositoryIdentity: identity
                ),
            ]
        )
        let model = FeatureRootModel(client: client, outboxStore: outbox, draftStore: drafts)
        await model.reload()

        await model.signOutT3Connect()

        #expect(try await drafts.draft(for: groupedDraftKey)?.text == "Keep shared prompt")
        #expect(try await drafts.draft(for: managedDraftKey) == nil)
        #expect(model.snapshot.projects.map(\.id) == ["manual-project"])
    }

    @Test
    func signingOutClearsDraftsWhenOutboxCleanupFails() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-sign-out-failure-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let drafts = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let draftKey = "environment:managed-1:thread:one"
        try await drafts.setDraft(FeatureComposerDraft(text: "Clear this draft"), for: draftKey)
        let outboxURL = directory.appendingPathComponent("outbox.json")
        let outbox = FeatureOutboxStore(fileURL: outboxURL)
        let threadID = "managed-1::thread::queued"
        try await outbox.enqueue(
            FeatureQueuedSubmission(
                environmentID: "managed-1",
                identity: FeatureSubmissionIdentity(threadID: "queued"),
                threadID: threadID,
                text: "Private queued message",
                selection: nil,
                runtimeMode: .fullAccess,
                interactionMode: .standard,
                attachments: [],
                creation: .init(
                    projectID: "managed-project",
                    projectName: "Native",
                    workspaceMode: .local,
                    branch: nil,
                    worktreePath: nil,
                    startFromOrigin: false
                )
            )
        )

        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .disconnected),
            environments: [
                .init(
                    id: "managed-1",
                    name: "Managed",
                    endpoint: "https://managed.example",
                    source: .t3Connect,
                    connectionState: .disconnected
                ),
            ],
            projects: [
                .init(
                    id: "managed-project",
                    environmentID: "managed-1",
                    name: "Native",
                    path: "/native"
                ),
            ]
        )
        client.finishEvents()
        let model = FeatureRootModel(client: client, outboxStore: outbox, draftStore: drafts)
        await model.start()
        #expect(model.snapshot.threads.contains(where: { $0.id == threadID }))
        #expect(model.details[threadID] != nil)
        try FileManager.default.removeItem(at: outboxURL)
        try FileManager.default.createDirectory(
            at: outboxURL,
            withIntermediateDirectories: false
        )

        await model.signOutT3Connect()

        #expect(try await drafts.draft(for: draftKey) == nil)
        #expect(model.snapshot.threads.isEmpty)
        #expect(model.details.isEmpty)
        #expect(model.errorMessage?.contains("Could not clear saved T3 Connect data") == true)
    }

    @Test
    func disconnectedPairDoesNotReportConnectionSuccess() async {
        let client = FeatureClientStub()
        client.snapshotAfterPair = FeatureSnapshot(
            connection: .init(
                state: .disconnected,
                environmentName: "New studio",
                endpoint: "https://new.example"
            )
        )
        let model = testRootModel(client: client)

        let paired = await model.pair(endpoint: "https://new.example", token: "pair-token")

        #expect(!paired)
        #expect(model.snapshot.connection.state == .disconnected)
        #expect(model.errorMessage?.contains("Could not connect") == true)
    }

    @Test
    func testCreateThreadOptimisticallyUpsertsIt() async {
        let client = FeatureClientStub()
        let created = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Build native app",
            providerID: "codex",
            modelID: "gpt-5"
        )
        client.createdThread = created
        let model = testRootModel(client: client)

        let result = await model.createThread(
            projectID: "project-1",
            title: created.title,
            selection: .init(providerID: "codex", modelID: "gpt-5")
        )

        #expect(result == created)
        #expect(model.snapshot.threads == [created])
    }

    @Test
    func testSendAddsQueuedMessageBeforeServerEvent() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            environmentID: "environment-1",
            title: "Thread"
        )
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ],
            threads: [thread]
        )
        client.threadDetail = FeatureThreadDetail(thread: thread)
        let model = testRootModel(client: client)
        await model.reload()
        _ = await model.detail(for: thread.id)

        let sent = await model.sendMessage(
            threadID: thread.id,
            text: "  ship it  ",
            selection: nil
        )

        #expect(sent)
        #expect(client.sentText == "ship it")
        #expect(model.details[thread.id]?.messages.last?.text == "ship it")
        #expect(model.details[thread.id]?.messages.last?.state == .complete)
    }

    @Test
    func sendPreservesTheThreadAutomaticPermission() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            environmentID: "environment-1",
            title: "Thread",
            runtimeMode: .automatic
        )
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ],
            threads: [thread]
        )
        let model = testRootModel(client: client)
        await model.reload()

        let sent = await model.sendMessage(
            threadID: thread.id,
            text: "Use the saved permission",
            selection: nil
        )

        #expect(sent)
        #expect(client.sentRuntimeModes == [.automatic])
    }

    @Test
    func runtimeModeUpdatesAfterSuccessAndStaysPutAfterFailure() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            environmentID: "environment-1",
            title: "Thread",
            runtimeMode: .fullAccess
        )
        client.snapshot = FeatureSnapshot(threads: [thread])
        let model = testRootModel(client: client)
        await model.reload()

        await model.setRuntimeMode(thread.id, mode: .automatic)

        #expect(client.setRuntimeModeCalls == [.automatic])
        #expect(model.snapshot.threads.first?.runtimeMode == .automatic)

        client.runtimeModeError = FeatureCapabilityUnavailable("Permission update failed")
        await model.setRuntimeMode(thread.id, mode: .fullAccess)

        #expect(client.setRuntimeModeCalls == [.automatic, .fullAccess])
        #expect(model.snapshot.threads.first?.runtimeMode == .automatic)
    }

    @Test
    func restoredOutboxRetryPreservesAutomaticPermission() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-permission-retry-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let thread = FeatureThread(
            id: "thread-1",
            wireID: "thread-wire",
            projectID: "project-1",
            environmentID: "environment-1",
            title: "Thread",
            runtimeMode: .fullAccess
        )
        try await store.enqueue(FeatureQueuedSubmission(
            environmentID: "environment-1",
            identity: .init(threadID: "thread-wire"),
            threadID: thread.id,
            text: "Retry with Automatic",
            selection: nil,
            runtimeMode: .automatic,
            interactionMode: .standard,
            attachments: []
        ))
        let delivery = AsyncStream<Void>.makeStream()
        let client = FeatureClientStub()
        client.beforeSendMessage = { delivery.continuation.yield() }
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ],
            threads: [thread]
        )
        client.finishEvents()
        let model = FeatureRootModel(client: client, outboxStore: store)

        await model.start()
        _ = await delivery.stream.first { _ in true }
        delivery.continuation.finish()
        await model.disconnect()

        #expect(client.sentRuntimeModes == [.automatic])
    }

    @Test
    func loadingEarlierTurnsPrependsHistoryAndClearsTheCursor() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            environmentID: "environment-1",
            title: "Long thread"
        )
        let recent = FeatureMessage(
            id: "message-recent",
            role: .assistant,
            text: "Recent",
            createdAt: Date(timeIntervalSince1970: 2)
        )
        let older = FeatureMessage(
            id: "message-older",
            role: .user,
            text: "Older",
            createdAt: Date(timeIntervalSince1970: 1)
        )
        client.threadDetail = FeatureThreadDetail(
            thread: thread,
            messages: [recent],
            page: FeatureThreadPage(beforeCursor: "cursor-1", hasMore: true)
        )
        client.earlierThreadDetail = FeatureThreadDetail(
            thread: thread,
            messages: [older, recent],
            page: FeatureThreadPage(beforeCursor: nil, hasMore: false)
        )
        let model = testRootModel(client: client)
        _ = await model.detail(for: thread.id)

        await model.loadEarlierTurns(for: thread.id)

        #expect(model.details[thread.id]?.messages.map(\.id) == [older.id, recent.id])
        #expect(model.details[thread.id]?.page?.hasMore == false)
        #expect(client.loadEarlierCallCount == 1)
    }

    @Test
    func failedDiscardKeepsTheDurableAndOptimisticSubmission() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-discard-failure-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o700))],
                ofItemAtPath: directory.path
            )
            try? FileManager.default.removeItem(at: directory)
        }

        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            environmentID: "environment-1",
            title: "Thread"
        )
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ],
            threads: [thread]
        )
        client.threadDetail = FeatureThreadDetail(thread: thread)
        client.beforeSendMessage = {
            try FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o500))],
                ofItemAtPath: directory.path
            )
        }
        client.sendMessageError = FeatureCapabilityUnavailable("Rejected message")
        let model = FeatureRootModel(client: client, outboxStore: store)
        await model.reload()
        _ = await model.detail(for: thread.id)

        let sent = await model.sendMessage(
            threadID: thread.id,
            text: "Keep this queued",
            selection: nil
        )

        #expect(!sent)
        #expect(try await store.submissions().count == 1)
        #expect(model.details[thread.id]?.messages.last?.text == "Keep this queued")
        #expect(model.details[thread.id]?.messages.last?.state == .queued)
    }

    @Test
    func failedDeliveryCleanupKeepsTheDurableAndOptimisticSubmission() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-completion-failure-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o700))],
                ofItemAtPath: directory.path
            )
            try? FileManager.default.removeItem(at: directory)
        }

        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            environmentID: "environment-1",
            title: "Thread"
        )
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ],
            threads: [thread]
        )
        client.threadDetail = FeatureThreadDetail(thread: thread)
        client.beforeSendMessage = {
            try FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o500))],
                ofItemAtPath: directory.path
            )
        }
        let model = FeatureRootModel(client: client, outboxStore: store)
        await model.reload()
        _ = await model.detail(for: thread.id)

        let sent = await model.sendMessage(
            threadID: thread.id,
            text: "Already delivered",
            selection: nil
        )

        #expect(sent)
        #expect(client.sendMessageCallCount == 1)
        #expect(try await store.submissions().count == 1)
        #expect(model.details[thread.id]?.messages.last?.text == "Already delivered")
        #expect(model.details[thread.id]?.messages.last?.state == .queued)
        #expect(model.errorMessage?.contains("delivered") == true)
    }

    @Test
    func failedEnvironmentOutboxCleanupKeepsPendingState() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-root-environment-cleanup-failure-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o700))],
                ofItemAtPath: directory.path
            )
            try? FileManager.default.removeItem(at: directory)
        }

        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let identity = FeatureSubmissionIdentity(
            threadID: "queued-thread",
            commandID: "queued-command",
            messageID: "queued-message"
        )
        let submission = FeatureQueuedSubmission(
            environmentID: "environment-1",
            identity: identity,
            threadID: "environment-1::thread::queued-thread",
            text: "Create from the outbox",
            selection: .init(providerID: "codex", modelID: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            attachments: [],
            creation: .init(
                projectID: "project-1",
                projectName: "Native",
                workspaceMode: .local,
                branch: nil,
                worktreePath: nil,
                startFromOrigin: false
            )
        )
        try await store.enqueue(submission)

        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .disconnected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .disconnected
                ),
            ],
            projects: [
                .init(
                    id: "project-1",
                    environmentID: "environment-1",
                    name: "Native",
                    path: "/native"
                ),
            ]
        )
        client.snapshotAfterEnvironmentRemoval = FeatureSnapshot(
            connection: .init(state: .disconnected)
        )
        client.finishEvents()
        let model = FeatureRootModel(client: client, outboxStore: store)
        await model.start()
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: Int16(0o500))],
            ofItemAtPath: directory.path
        )

        await model.removeEnvironment("environment-1")

        #expect(client.removedEnvironmentID == "environment-1")
        #expect(model.snapshot.environments.isEmpty)
        #expect(model.snapshot.threads.contains(where: { $0.id == submission.threadID }))
        #expect(try await store.submissions() == [submission])
        #expect(model.errorMessage?.contains("queued messages") == true)
    }

    @Test
    func testNewTaskStartsThreadAndFirstTurnAtomically() async {
        let client = FeatureClientStub()
        let created = FeatureThread(
            id: "thread-atomic",
            projectID: "project-1",
            title: "Ship the native app",
            providerID: "codex",
            modelID: "gpt-5.6-sol"
        )
        client.createdThread = created
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ],
            projects: [
                .init(
                    id: "project-1",
                    environmentID: "environment-1",
                    name: "Native",
                    path: "/native"
                ),
            ]
        )
        let model = testRootModel(client: client)
        await model.reload()
        let attachment = FeatureDraftAttachment(
            data: Data([0xFF, 0xD8, 0xFF]),
            filename: "reference.jpg",
            mimeType: "image/jpeg"
        )

        let result = await model.startTask(
            NewTaskRequest(
                projectID: "project-1",
                prompt: "  Ship the native app  ",
                selection: .init(providerID: "codex", modelID: "gpt-5.6-sol"),
                runtimeMode: .fullAccess,
                interactionMode: .standard,
                workspaceMode: .worktree,
                branch: "main",
                startFromOrigin: true,
                attachments: [attachment]
            )
        )

        #expect(result == created)
        #expect(client.startedPrompt == "Ship the native app")
        #expect(client.startedAttachments.map(\.name) == ["reference.jpg"])
        #expect(client.startedWorkspaceMode == .worktree)
        #expect(client.startedBranch == "main")
        #expect(client.startedWorktreePath == nil)
        #expect(client.startedFromOrigin)
        #expect(client.createThreadCallCount == 0)
        #expect(client.sendMessageCallCount == 0)
        #expect(model.snapshot.threads == [created])
    }

    @Test(
        "New-task composer grows beyond two lines with a software-keyboard viewport",
        .bug("https://github.com/saphid/t3code-personal/issues/105")
    )
    func newTaskComposerGrowsWithSoftwareKeyboardViewport() async throws {
        let project = FeatureProject(
            id: "project-1",
            environmentID: "environment-1",
            name: "Native",
            path: "/native"
        )
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ],
            projects: [project],
            providersByEnvironment: [
                "environment-1": [
                    .init(
                        id: "codex",
                        name: "Codex",
                        models: [.init(id: "gpt-5.6-sol", name: "Sol")]
                    ),
                ],
            ]
        )
        let model = testRootModel(client: client)
        await model.reload()

        let draftURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-new-task-keyboard-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: draftURL) }
        let draftStore = FeatureComposerDraftStore(fileURL: draftURL)
        let longDraft = (1...20).map { "Composer keyboard proof line \($0)" }
            .joined(separator: "\n")
        try await draftStore.setDraft(
            FeatureComposerDraft(text: longDraft),
            for: FeatureComposerDraftStore.newTaskKey(project: project)
        )

        let controller = UIHostingController(
            rootView: NewThreadView(
                model: model,
                submit: { _ in nil },
                onCreated: { _ in },
                initialProjectID: project.id,
                draftStore: draftStore
            )
        )
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 540))
        window.rootViewController = controller
        window.isHidden = false
        defer { window.isHidden = true }

        var textInput: UIView?
        for _ in 0..<30 {
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
            textInput = firstMultilineTextInput(in: controller.view)
            if textInputText(textInput) == longDraft { break }
            try await Task.sleep(for: .milliseconds(10))
        }

        let input = try #require(textInput)
        #expect(textInputText(input) == longDraft)
        #expect(
            input.bounds.height >= 100,
            "Expected room for more than two visible lines; got \(input.bounds.height) points"
        )
        let inputFrame = input.convert(input.bounds, to: window)
        #expect(
            inputFrame.maxY <= window.bounds.height - 44,
            "The text editor overlaps the composer controls: editor frame \(inputFrame), viewport \(window.bounds)"
        )
    }

    @Test
    func testArchiveAndDeleteKeepLocalListsConsistent() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        client.createdThread = thread
        let model = testRootModel(client: client)
        _ = await model.createThread(projectID: thread.projectID, title: nil, selection: nil)

        await model.setArchived(thread.id, archived: true)
        #expect(model.snapshot.threads[0].isArchived)

        await model.deleteThread(thread.id)
        #expect(model.snapshot.threads.isEmpty)
    }

    @Test
    func activeThreadsCannotBeArchivedOrSettled() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Running task",
            state: .working,
            supportsSettlement: true
        )
        client.snapshot = FeatureSnapshot(threads: [thread])
        let model = testRootModel(client: client)
        await model.reload()

        await model.setArchived(thread.id, archived: true)

        #expect(model.snapshot.threads.first?.isArchived == false)
        #expect(model.errorMessage?.contains("still active") == true)

        model.errorMessage = nil
        await model.setSettled(thread.id, settled: true)

        #expect(model.snapshot.threads.first?.isSettled == false)
        #expect(model.errorMessage?.contains("needs attention") == true)
    }

    @Test
    func cachedThreadRefreshShowsLoadingThenRetryWithoutHidingMessages() async throws {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "cached", projectID: "project", title: "Cached thread")
        let cached = FeatureThreadDetail(
            thread: thread,
            messages: [.init(id: "user", role: .user, text: "Do the task")]
        )
        client.threadDetail = cached
        let model = testRootModel(client: client)
        _ = await model.detail(for: thread.id)

        let started = AsyncStream<Void>.makeStream()
        var response: CheckedContinuation<FeatureThreadDetail, any Error>?
        client.loadThreadHandler = { _ in
            try await withCheckedThrowingContinuation { continuation in
                response = continuation
                started.continuation.yield()
            }
        }
        let refresh = Task { await model.detail(for: thread.id, force: true) }
        var requests = started.stream.makeAsyncIterator()
        await requests.next()
        #expect(model.detailLoadStates[thread.id] == .loading)
        #expect(model.details[thread.id] == cached)

        response?.resume(throwing: URLError(.notConnectedToInternet))
        #expect(await refresh.value == cached)
        guard case .failed = model.detailLoadStates[thread.id] else {
            Issue.record("Expected an inline retry state for the cached thread")
            return
        }
        #expect(model.errorMessage == nil)
        #expect(model.details[thread.id]?.messages.first?.text == "Do the task")

        client.loadThreadHandler = nil
        _ = await model.detail(for: thread.id, force: true)
        #expect(model.detailLoadStates[thread.id] == nil)
    }

    @Test
    func cachedThreadRestoresAttachmentsBeforeItsNetworkRefreshFinishes() async throws {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "cached-draft", projectID: "project", environmentID: "one",
            title: "Cached draft"
        )
        let cached = FeatureThreadDetail(thread: thread)
        client.threadDetail = cached
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-thread-draft-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let draftStore = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let attachment = FeatureDraftAttachment(
            data: Data([1]), filename: "example.png", mimeType: "image/png"
        )
        try await draftStore.setDraft(
            FeatureComposerDraft(text: "Keep this draft", attachments: [attachment]),
            for: FeatureComposerDraftStore.threadKey(thread)
        )
        let model = FeatureRootModel(
            client: client,
            outboxStore: FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json")),
            draftStore: draftStore
        )
        _ = await model.detail(for: thread.id)

        let loads = AsyncStream<Void>.makeStream()
        let uploads = AsyncStream<UUID>.makeStream()
        var pendingLoad: CheckedContinuation<FeatureThreadDetail, any Error>?
        client.loadThreadHandler = { _ in
            try await withCheckedThrowingContinuation { continuation in
                pendingLoad = continuation
                loads.continuation.yield()
            }
        }
        client.preuploadHandler = { value, environmentID in
            #expect(environmentID == "one")
            uploads.continuation.yield(value.id)
            return nil
        }
        defer {
            pendingLoad?.resume(returning: cached)
            loads.continuation.finish()
            uploads.continuation.finish()
        }

        let controller = UIHostingController(rootView: ThreadDetailView(
            model: model, thread: thread, submitMessage: { _ in false }, draftStore: draftStore
        ))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 800))
        window.rootViewController = controller
        window.isHidden = false
        defer { window.isHidden = true }
        controller.view.layoutIfNeeded()

        var loadEvents = loads.stream.makeAsyncIterator()
        await loadEvents.next()
        var uploadEvents = uploads.stream.makeAsyncIterator()
        #expect(await uploadEvents.next() == attachment.id)
        #expect(pendingLoad != nil)
        #expect(model.detailLoadStates[thread.id] == .loading)
        #expect(model.details[thread.id] == cached)
    }

    @Test(.serialized, arguments: [false, true])
    func freshThreadImageSavesAndUploadsAfterDraftRestore(afterFullScreenCover: Bool) async throws {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "fresh-image", projectID: "project", environmentID: "one", title: "Fresh image"
        )
        client.threadDetail = FeatureThreadDetail(thread: thread)
        client.snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [.init(
                id: "one", name: "Studio", endpoint: "https://studio.example",
                connectionState: .connected
            )],
            threads: [thread],
            preferencesByEnvironment: ["one": .init(supportsImageUploads: true)]
        )
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-fresh-image-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let draftStore = FeatureComposerDraftStore(fileURL: directory.appendingPathComponent("drafts.json"))
        let draftKey = FeatureComposerDraftStore.threadKey(thread)
        let initialText = "Attach this screenshot"
        try await draftStore.setDraft(FeatureComposerDraft(text: initialText), for: draftKey)
        let model = FeatureRootModel(
            client: client,
            outboxStore: FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json")),
            draftStore: draftStore
        )
        await model.reload()
        _ = await model.detail(for: thread.id)

        let uploaded = XCTestExpectation(description: "Fresh attachment saved and upload started")
        var uploadedAttachment: FeatureUploadAttachment?
        client.preuploadHandler = { attachment, environmentID in
            let saved = try await draftStore.draft(for: draftKey)
            #expect(environmentID == "one")
            #expect(saved?.text == initialText)
            #expect(saved?.attachments.map(\.id) == [attachment.id])
            uploadedAttachment = attachment
            uploaded.fulfill()
            return nil
        }
        let presentation = ThreadImageCoverPresentation()
        let controller = UIHostingController(rootView: ThreadImageTestHost(
            detail: ThreadDetailView(
                model: model, thread: thread, submitMessage: { _ in false }, draftStore: draftStore
            ),
            presentation: presentation
        ))
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = try #require(scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 800)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            controller.dismiss(animated: false)
            window.isHidden = true
            previousKeyWindow?.makeKey()
        }
        // A representable can update its text without laying out the hosting
        // controller. Drive UI frames until the restored editor is visible.
        var renderedInput: UIView?
        let layoutDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        repeat {
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
            renderedInput = firstMultilineTextInput(in: controller.view)
            if textInputText(renderedInput) == initialText { break }
            try await Task.sleep(for: .milliseconds(16))
        } while ContinuousClock.now < layoutDeadline
        try #require(
            textInputText(renderedInput) == initialText,
            "Editor after layout: \(String(describing: textInputText(renderedInput)))"
        )
        let input = try #require(renderedInput as? FeatureComposerUITextView)
        let pasteImages = try #require(input.onPasteImages)
        let imageFormat = UIGraphicsImageRendererFormat()
        imageFormat.opaque = true
        let image = UIGraphicsImageRenderer(
            size: CGSize(width: 180, height: 320), format: imageFormat
        ).image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 180, height: 320))
        }
        let attachImage = { pasteImages([NSItemProvider(object: image)]) }

        if afterFullScreenCover {
            presentation.onDismiss = attachImage
            presentation.isPresented = true
            try #require(await XCTWaiter.fulfillment(of: [presentation.appeared], timeout: 2) == .completed)
            presentation.isPresented = false
            try #require(await XCTWaiter.fulfillment(of: [presentation.dismissed], timeout: 2) == .completed)
        } else {
            attachImage()
        }
        try #require(await XCTWaiter.fulfillment(of: [uploaded], timeout: 2) == .completed)
        let attachment = try #require(uploadedAttachment)
        #expect(attachment.byteCount > 0)
        #expect(attachment.mimeType.hasPrefix("image/"))
        #expect(try await draftStore.draft(for: draftKey)?.attachments.map(\.id) == [attachment.id])
    }

    @Test
    func threadRefreshPresentationShowsConnectionLossEvenWithCachedContent() {
        #expect(ThreadRefreshPresentation.resolve(
            loadState: nil, connectionState: .connected, isOpening: true
        ) == .loading)
        #expect(ThreadRefreshPresentation.resolve(
            loadState: .loading, connectionState: .connected, isOpening: false
        ) == .loading)
        #expect(ThreadRefreshPresentation.resolve(
            loadState: nil, connectionState: .reconnecting, isOpening: false
        ) == .reconnecting)
        #expect(ThreadRefreshPresentation.resolve(
            loadState: nil, connectionState: .disconnected, isOpening: false
        ) == .offline)
        #expect(ThreadRefreshPresentation.resolve(
            loadState: .failed("Offline"), connectionState: .connected, isOpening: false
        ) == .failed)
        #expect(ThreadRefreshPresentation.resolve(
            loadState: nil, connectionState: .connected, isOpening: false
        ) == nil)
        #expect(ThreadRefreshPresentation.failed.canRetry)
        #expect(!ThreadRefreshPresentation.loading.canRetry)
    }

    @Test
    func testCancelledDetailRefreshKeepsCachedContentWithoutAlert() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        let detail = FeatureThreadDetail(
            thread: thread,
            messages: [
                FeatureMessage(id: "message-1", role: .assistant, text: "Still here"),
            ]
        )
        client.threadDetail = detail
        let model = testRootModel(client: client)
        _ = await model.detail(for: thread.id)
        client.loadThreadError = CancellationError()

        let refreshed = await model.detail(for: thread.id, force: true)

        #expect(refreshed == detail)
        #expect(model.errorMessage == nil)
        #expect(model.detailLoadStates[thread.id] == nil)
    }

    @Test
    func testResnoozeRefreshesTheOptimisticSnoozeTimestamp() async {
        let client = FeatureClientStub()
        var thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Thread",
            state: .failed
        )
        let oldSnooze = Date.now.addingTimeInterval(-600)
        thread.snoozedAt = oldSnooze
        thread.attentionAt = Date.now.addingTimeInterval(-300)
        client.createdThread = thread
        let model = testRootModel(client: client)
        _ = await model.createThread(projectID: thread.projectID, title: nil, selection: nil)

        await model.setSnoozed(
            thread.id,
            until: Date.now.addingTimeInterval(3_600)
        )

        let updated = model.snapshot.threads[0]
        #expect(updated.snoozedAt != oldSnooze)
        #expect(updated.snoozedAt! > updated.attentionAt!)
    }

    @Test
    func testPinOptimisticallyWakesWithoutInventingSettlementOverride() async {
        let client = FeatureClientStub()
        var thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Thread",
            isSettled: true,
            settledAt: .now,
            snoozedUntil: Date.now.addingTimeInterval(3_600),
            snoozedAt: .now
        )
        thread.supportsPinning = true
        client.createdThread = thread
        let model = testRootModel(client: client)
        _ = await model.createThread(projectID: thread.projectID, title: nil, selection: nil)

        await model.setPinned(thread.id, pinned: true)

        let updated = model.snapshot.threads[0]
        #expect(updated.pinnedAt != nil)
        #expect(updated.isSettled)
        #expect(!updated.keepsActive)
        #expect(updated.settledAt != nil)
        #expect(updated.snoozedUntil == nil)
    }

    @Test
    func testPinDoesNotMakeAnOrdinaryThreadPermanentlyActive() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Thread"
        )
        client.createdThread = thread
        let model = testRootModel(client: client)
        _ = await model.createThread(projectID: thread.projectID, title: nil, selection: nil)

        await model.setPinned(thread.id, pinned: true)
        await model.setPinned(thread.id, pinned: false)

        let updated = model.snapshot.threads[0]
        #expect(updated.pinnedAt == nil)
        #expect(!updated.keepsActive)
    }

    @Test
    func failedSettlementKeepsNewerActivityFacts() async {
        let client = FeatureClientStub()
        var thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Thread",
            supportsSettlement: true,
            settlementFacts: FeatureThreadSettlementFacts()
        )
        client.snapshot = FeatureSnapshot(threads: [thread])
        client.settlementError = URLError(.notConnectedToInternet)
        let model = testRootModel(client: client)
        await model.reload()

        client.beforeSettlementReturn = {
            thread.settlementFacts?.sessionStatus = "running"
            thread.settlementFacts?.hasPendingApprovals = true
            await withCheckedContinuation { continuation in
                withObservationTracking {
                    _ = model.snapshot.threads.first?.settlementFacts?.sessionStatus
                } onChange: {
                    continuation.resume()
                }
                client.emit(.thread(thread))
            }
        }
        let run = Task { await model.start() }

        #expect(!(await model.setSettled(thread.id, settled: true)))
        client.finishEvents()
        await run.value

        guard let restored = model.snapshot.threads.first else {
            Issue.record("Expected the thread after settlement rollback")
            return
        }
        #expect(restored.settlementFacts?.settlementOverride == nil)
        #expect(restored.settlementFacts?.sessionStatus == "running")
        #expect(restored.settlementFacts?.hasPendingApprovals == true)
    }

    @Test
    func testResolveUserInputForwardsTypedAnswersAndClearsTheRequest() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        let request = FeatureUserInput(
            id: "request-1",
            threadID: thread.id,
            questions: []
        )
        client.threadDetail = FeatureThreadDetail(thread: thread, userInputs: [request])
        let model = testRootModel(client: client)
        _ = await model.detail(for: thread.id)

        let answers: [String: FeatureInputAnswer] = [
            "scope": .selections(["Server", "Web"]),
            "note": .text("Ship it"),
        ]
        await model.resolveUserInput(request.id, answers: answers)

        #expect(client.resolvedInputID == request.id)
        #expect(client.resolvedInputAnswers == answers)
        #expect(model.details[thread.id]?.userInputs.isEmpty == true)
    }

    @Test
    func granularThreadEventsMaintainCountsAndCollectionRevision() async {
        let client = FeatureClientStub()
        let project = FeatureProject(
            id: "project-1",
            environmentID: "environment-1",
            name: "Native",
            path: "/native"
        )
        client.snapshot = FeatureSnapshot(projects: [project])
        let model = testRootModel(client: client)
        let thread = FeatureThread(
            id: "thread-1",
            projectID: project.id,
            title: "Stream deltas"
        )

        let run = Task { await model.start() }
        client.emit(.thread(thread))
        client.emit(.thread(thread))
        client.emit(.threadRemoved(id: thread.id))
        let connected = FeatureConnection(state: .connected, environmentName: "Native")
        client.emit(.connection(connected))
        client.emit(.connection(connected))
        client.finishEvents()
        await run.value

        #expect(model.snapshot.threads.isEmpty)
        #expect(model.snapshot.projects[0].threadCount == 0)
        #expect(model.threadCollectionRevision == 2)
        #expect(model.homePresentationRevision == 4)
    }

    @Test
    func initialDetailLoadDoesNotOverwriteNewerLiveUpdate() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        let initial = FeatureThreadDetail(
            thread: thread,
            messages: [FeatureMessage(id: "message-1", role: .assistant, text: "Initial")]
        )
        let live = FeatureThreadDetail(
            thread: thread,
            messages: [FeatureMessage(id: "message-2", role: .assistant, text: "Live")]
        )
        client.threadDetail = initial
        let model = testRootModel(client: client)
        let run = Task { await model.start() }
        client.beforeLoadThreadReturn = {
            await withCheckedContinuation { continuation in
                withObservationTracking {
                    _ = model.details[thread.id]
                } onChange: {
                    continuation.resume()
                }
                client.emit(.detail(live))
            }
        }

        let loaded = await model.detail(for: thread.id, force: true)
        client.finishEvents()
        await run.value

        #expect(loaded == live)
        #expect(model.details[thread.id] == live)
    }

    @Test(
        "Later overlapping detail load wins for either completion order",
        .bug("https://github.com/pingdotgg/t3code/pull/7206#discussion_r3816827717"),
        arguments: [[1, 2], [2, 1]]
    )
    func laterOverlappingDetailLoadWins(completionOrder: [Int]) async throws {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        let initial = FeatureThreadDetail(
            thread: thread,
            messages: [FeatureMessage(id: "message-1", role: .assistant, text: "Initial")]
        )
        let refreshed = FeatureThreadDetail(
            thread: thread,
            messages: [FeatureMessage(id: "message-2", role: .assistant, text: "Refreshed")]
        )
        let loadStarted = AsyncStream<Int>.makeStream()
        var loadIndex = 0
        var loadContinuations: [Int: CheckedContinuation<FeatureThreadDetail, Never>] = [:]
        defer {
            loadStarted.continuation.finish()
            for continuation in loadContinuations.values {
                continuation.resume(returning: refreshed)
            }
        }
        client.loadThreadHandler = { _ in
            loadIndex += 1
            let index = loadIndex
            loadStarted.continuation.yield(index)
            return await withCheckedContinuation { continuation in
                loadContinuations[index] = continuation
            }
        }
        let model = testRootModel(client: client)
        var starts = loadStarted.stream.makeAsyncIterator()

        let initialLoad = Task { await model.detail(for: thread.id, force: true) }
        let firstStart = await starts.next()
        #expect(firstStart == 1)
        let refresh = Task { await model.detail(for: thread.id, force: true) }
        let secondStart = await starts.next()
        #expect(secondStart == 2)

        for index in completionOrder {
            let pendingContinuation = loadContinuations.removeValue(forKey: index)
            let continuation = try #require(pendingContinuation)
            continuation.resume(returning: index == 1 ? initial : refreshed)
            if index == 1 {
                _ = await initialLoad.value
                if completionOrder.first == 1 {
                    #expect(model.detailLoadStates[thread.id] == .loading)
                }
            } else {
                _ = await refresh.value
                #expect(model.detailLoadStates[thread.id] == nil)
            }
        }

        let expectedInitialResult = completionOrder.first == 1 ? initial : refreshed
        #expect(await initialLoad.value == expectedInitialResult)
        #expect(await refresh.value == refreshed)
        #expect(model.details[thread.id] == refreshed)
    }

    @Test(
        "Pagination does not cancel an overlapping detail refresh",
        .bug("https://github.com/pingdotgg/t3code/pull/7206#discussion_r3816827717")
    )
    func paginationDoesNotCancelOverlappingDetailRefresh() async throws {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        let cached = FeatureThreadDetail(
            thread: thread,
            messages: [FeatureMessage(id: "message-2", role: .assistant, text: "Cached")],
            page: FeatureThreadPage(beforeCursor: "cursor-1", hasMore: true)
        )
        let paginated = FeatureThreadDetail(
            thread: thread,
            messages: [
                FeatureMessage(id: "message-1", role: .user, text: "Earlier"),
                cached.messages[0],
            ],
            page: FeatureThreadPage(beforeCursor: nil, hasMore: false)
        )
        let refreshed = FeatureThreadDetail(
            thread: thread,
            messages: [FeatureMessage(id: "message-3", role: .assistant, text: "Refreshed")]
        )
        client.threadDetail = cached
        client.earlierThreadDetail = paginated
        let model = testRootModel(client: client)
        _ = await model.detail(for: thread.id)

        let loadStarted = AsyncStream<Void>.makeStream()
        var refreshContinuation: CheckedContinuation<FeatureThreadDetail, Never>?
        defer {
            loadStarted.continuation.finish()
            refreshContinuation?.resume(returning: refreshed)
        }
        client.loadThreadHandler = { _ in
            loadStarted.continuation.yield(())
            return await withCheckedContinuation { continuation in
                refreshContinuation = continuation
            }
        }
        var starts = loadStarted.stream.makeAsyncIterator()

        let refresh = Task { await model.detail(for: thread.id, force: true) }
        _ = await starts.next()
        await model.loadEarlierTurns(for: thread.id)
        let continuation = try #require(refreshContinuation)
        refreshContinuation = nil
        continuation.resume(returning: refreshed)

        #expect(await refresh.value == refreshed)
        #expect(model.details[thread.id]?.messages == refreshed.messages)
    }

    @Test
    func initialDetailLoadDoesNotRestoreRemovedThread() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        client.snapshot = FeatureSnapshot(threads: [thread])
        client.threadDetail = FeatureThreadDetail(
            thread: thread,
            messages: [FeatureMessage(id: "message-1", role: .assistant, text: "Initial")]
        )
        let model = testRootModel(client: client)
        let run = Task { await model.start() }
        client.beforeLoadThreadReturn = {
            await withCheckedContinuation { continuation in
                withObservationTracking {
                    _ = model.detailRevisions[thread.id]
                } onChange: {
                    continuation.resume()
                }
                client.emit(.threadRemoved(id: thread.id))
            }
        }

        let loaded = await model.detail(for: thread.id, force: true)
        client.finishEvents()
        await run.value

        #expect(loaded == nil)
        #expect(model.details[thread.id] == nil)
        #expect(model.snapshot.threads.isEmpty)
    }

    @Test
    func initialDetailLoadMergesLatestThreadMetadata() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Original")
        let intermediateThread = FeatureThread(
            id: thread.id,
            projectID: thread.projectID,
            title: "Intermediate"
        )
        let cached = FeatureThreadDetail(
            thread: thread,
            messages: [FeatureMessage(id: "message-1", role: .assistant, text: "Cached")]
        )
        let refreshed = FeatureThreadDetail(
            thread: intermediateThread,
            messages: [FeatureMessage(id: "message-2", role: .assistant, text: "Refreshed")]
        )
        client.snapshot = FeatureSnapshot(threads: [thread])
        client.threadDetail = cached
        let model = testRootModel(client: client)
        _ = await model.detail(for: thread.id)
        client.threadDetail = refreshed
        let run = Task { await model.start() }
        client.beforeLoadThreadReturn = {
            await withCheckedContinuation { continuation in
                withObservationTracking {
                    _ = model.details[thread.id]?.thread
                } onChange: {
                    continuation.resume()
                }
                client.emit(.thread(intermediateThread))
            }
            await withCheckedContinuation { continuation in
                withObservationTracking {
                    _ = model.details[thread.id]?.thread
                } onChange: {
                    continuation.resume()
                }
                client.emit(.thread(thread))
            }
        }

        let loaded = await model.detail(for: thread.id, force: true)
        client.finishEvents()
        await run.value

        #expect(loaded?.thread == thread)
        #expect(loaded?.messages == refreshed.messages)
        #expect(model.details[thread.id] == loaded)
        #expect(model.snapshot.threads == [thread])
    }

    @Test
    func initialDetailLoadKeepsMetadataFromThreadCreatedDuringLoad() async {
        let client = FeatureClientStub()
        let original = FeatureThread(id: "thread-1", projectID: "project-1", title: "Original")
        let live = FeatureThread(id: original.id, projectID: original.projectID, title: "Live")
        let created = FeatureThread(id: original.id, projectID: original.projectID, title: "Created")
        client.snapshot = FeatureSnapshot(threads: [original])
        client.threadDetail = FeatureThreadDetail(thread: original)
        let model = testRootModel(client: client)
        _ = await model.detail(for: original.id)
        let run = Task { await model.start() }
        client.createdThread = created
        client.beforeLoadThreadReturn = {
            await withCheckedContinuation { continuation in
                withObservationTracking {
                    _ = model.details[original.id]?.thread
                } onChange: {
                    continuation.resume()
                }
                client.emit(.thread(live))
            }
            _ = await model.createThread(projectID: original.projectID, title: nil, selection: nil)
        }

        let loaded = await model.detail(for: original.id, force: true)
        client.finishEvents()
        await run.value

        #expect(loaded?.thread == created)
        #expect(model.details[original.id]?.thread == created)
        #expect(model.snapshot.threads == [created])
    }

    @Test
    func duplicateThreadEventDuringRefreshDoesNotDiscardLoadedMetadata() async {
        let client = FeatureClientStub()
        let original = FeatureThread(id: "thread-1", projectID: "project-1", title: "Original")
        let refreshed = FeatureThread(id: original.id, projectID: original.projectID, title: "Refreshed")
        client.snapshot = FeatureSnapshot(threads: [original])
        client.threadDetail = FeatureThreadDetail(thread: original)
        let model = testRootModel(client: client)
        _ = await model.detail(for: original.id)
        client.threadDetail = FeatureThreadDetail(thread: refreshed)
        let run = Task { await model.start() }
        client.beforeLoadThreadReturn = {
            await withCheckedContinuation { continuation in
                withObservationTracking {
                    _ = model.snapshot.connection
                } onChange: {
                    continuation.resume()
                }
                client.emit(.thread(original))
                client.emit(.connection(.init(state: .connected)))
            }
        }

        let loaded = await model.detail(for: original.id, force: true)
        client.finishEvents()
        await run.value

        #expect(loaded?.thread == refreshed)
        #expect(model.details[original.id]?.thread == refreshed)
        #expect(model.snapshot.threads == [refreshed])
    }

    @Test
    func initialDetailLoadDoesNotRestoreResolvedApproval() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        let approval = FeatureApproval(
            id: "approval-1",
            threadID: thread.id,
            kind: .command,
            title: "Run command",
            detail: "swift test"
        )
        let stale = FeatureThreadDetail(thread: thread, approvals: [approval])
        client.threadDetail = stale
        let model = testRootModel(client: client)
        _ = await model.detail(for: thread.id)
        client.beforeLoadThreadReturn = {
            await model.resolveApproval(approval.id, decision: .allowOnce)
        }

        let loaded = await model.detail(for: thread.id, force: true)

        #expect(loaded?.approvals.isEmpty == true)
        #expect(model.details[thread.id]?.approvals.isEmpty == true)
    }

    @Test
    func initialDetailLoadDoesNotRestoreThreadRemovedBySnapshot() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Thread")
        client.snapshot = FeatureSnapshot(threads: [thread])
        client.threadDetail = FeatureThreadDetail(
            thread: thread,
            messages: [FeatureMessage(id: "message-1", role: .assistant, text: "Initial")]
        )
        let model = testRootModel(client: client)
        let run = Task { await model.start() }
        client.beforeLoadThreadReturn = {
            await withCheckedContinuation { continuation in
                withObservationTracking {
                    _ = model.detailRevisions[thread.id]
                } onChange: {
                    continuation.resume()
                }
                client.emit(.snapshot(FeatureSnapshot()))
            }
        }

        let loaded = await model.detail(for: thread.id, force: true)
        client.finishEvents()
        await run.value

        #expect(loaded == nil)
        #expect(model.details[thread.id] == nil)
        #expect(model.snapshot.threads.isEmpty)
    }

    @Test
    func initialDetailLoadMergesLatestSnapshotMetadata() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(id: "thread-1", projectID: "project-1", title: "Original")
        let intermediateThread = FeatureThread(
            id: thread.id,
            projectID: thread.projectID,
            title: "Intermediate"
        )
        let cached = FeatureThreadDetail(
            thread: thread,
            messages: [FeatureMessage(id: "message-1", role: .assistant, text: "Cached")]
        )
        let refreshed = FeatureThreadDetail(
            thread: intermediateThread,
            messages: [FeatureMessage(id: "message-2", role: .assistant, text: "Refreshed")]
        )
        client.snapshot = FeatureSnapshot(threads: [thread])
        client.threadDetail = cached
        let model = testRootModel(client: client)
        _ = await model.detail(for: thread.id)
        client.threadDetail = refreshed
        let run = Task { await model.start() }
        client.beforeLoadThreadReturn = {
            await withCheckedContinuation { continuation in
                withObservationTracking {
                    _ = model.details[thread.id]?.thread
                } onChange: {
                    continuation.resume()
                }
                client.emit(.snapshot(FeatureSnapshot(threads: [intermediateThread])))
            }
            await withCheckedContinuation { continuation in
                withObservationTracking {
                    _ = model.details[thread.id]?.thread
                } onChange: {
                    continuation.resume()
                }
                client.emit(.snapshot(FeatureSnapshot(threads: [thread])))
            }
        }

        let loaded = await model.detail(for: thread.id, force: true)
        client.finishEvents()
        await run.value

        #expect(loaded?.thread == thread)
        #expect(loaded?.messages == refreshed.messages)
        #expect(model.details[thread.id] == loaded)
        #expect(model.snapshot.threads == [thread])
    }

    @Test
    func environmentScopedCatalogAndPreferencesInvalidateHomePresentation() async {
        let client = FeatureClientStub()
        let model = testRootModel(client: client)
        client.snapshot = FeatureSnapshot(
            providersByEnvironment: [
                "studio": [
                    .init(
                        id: "codex",
                        name: "Codex",
                        models: [.init(id: "gpt-5.6-sol", name: "Sol")]
                    ),
                ],
            ]
        )

        await model.reload()
        let catalogRevision = model.homePresentationRevision
        #expect(catalogRevision == 1)

        client.snapshot.preferencesByEnvironment = [
            "studio": .init(defaultWorkspaceMode: .worktree),
        ]
        await model.reload()

        #expect(model.homePresentationRevision == catalogRevision + 1)
    }

    @Test
    func providerRefreshRoutesOnlyToChosenEnvironment() async {
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(providersByEnvironment: [
            "left": [.init(id: "old-left", name: "Old left")],
            "right": [.init(id: "old-right", name: "Old right")],
        ])
        client.refreshedProviders = [.init(id: "new-left", name: "New left")]
        let model = testRootModel(client: client)
        await model.reload()

        let didRefresh = await model.refreshProviders(environmentID: "left")

        #expect(didRefresh)
        #expect(client.refreshedProviderEnvironmentID == "left")
        #expect(model.snapshot.providersByEnvironment?["left"] == client.refreshedProviders)
        #expect(
            model.snapshot.providersByEnvironment?["right"]
                == [.init(id: "old-right", name: "Old right")]
        )
    }

    @Test
    func automaticSettlementUpdatesRemainEnvironmentScopedAndFailuresKeepVisibleValues() async {
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            preferencesByEnvironment: [
                "left": .init(
                    automaticSettlement: .init(onMerge: true, afterDays: 3)
                ),
                "right": .init(
                    automaticSettlement: .init(onMerge: false, afterDays: 7.5)
                ),
            ]
        )
        let model = testRootModel(client: client)
        await model.reload()

        client.automaticSettlementResult = .init(onMerge: false, afterDays: 3)
        let didUpdate = await model.updateAutomaticSettlement(
            environmentID: "left",
            change: .onMerge(false)
        )

        #expect(didUpdate)
        #expect(client.automaticSettlementEnvironmentID == "left")
        #expect(client.automaticSettlementChange == .onMerge(false))
        #expect(
            model.snapshot.preferencesByEnvironment?["left"]?.automaticSettlement
                == FeatureAutomaticSettlementSettings(onMerge: false, afterDays: 3)
        )
        #expect(
            model.snapshot.preferencesByEnvironment?["right"]?.automaticSettlement
                == FeatureAutomaticSettlementSettings(onMerge: false, afterDays: 7.5)
        )

        client.automaticSettlementError = FeatureCapabilityUnavailable(
            "Automatic settlement settings"
        )
        let didFail = await model.updateAutomaticSettlement(
            environmentID: "right",
            change: .afterDays(nil)
        )

        #expect(!didFail)
        #expect(
            model.snapshot.preferencesByEnvironment?["right"]?.automaticSettlement
                == FeatureAutomaticSettlementSettings(onMerge: false, afterDays: 7.5)
        )
        #expect(
            model.errorMessage
                == "Automatic settlement settings is not supported by this environment."
        )
    }

    @Test
    func stalePullRequestResponseCannotReplaceANewBranchIdentity() async throws {
        let client = FeatureClientStub()
        var thread = FeatureThread(
            id: "thread",
            projectID: "project",
            environmentID: "studio",
            title: "Task",
            branch: "feature/old",
            worktreePath: "/repo"
        )
        client.snapshot = FeatureSnapshot(threads: [thread])
        let model = testRootModel(client: client)
        await model.reload()

        let oldIdentity = try #require(thread.pullRequestObservationIdentity)
        model.updatePullRequest(
            HomeThreadPullRequestPresentation(number: 1, state: .merged, updatedAt: .now),
            threadID: thread.id,
            observationIdentity: oldIdentity
        )
        #expect(model.pullRequestsByThreadID[thread.id]?.number == 1)

        thread.branch = "feature/new"
        client.snapshot.threads = [thread]
        await model.reload()
        #expect(model.pullRequestsByThreadID[thread.id] == nil)

        model.updatePullRequest(
            HomeThreadPullRequestPresentation(number: 1, state: .closed, updatedAt: .now),
            threadID: thread.id,
            observationIdentity: oldIdentity
        )
        #expect(model.pullRequestsByThreadID[thread.id] == nil)
    }

    @Test
    func responseTimeoutKeepsDurableSubmissionQueued() {
        let snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "studio",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ]
        )

        #expect(
            FeatureRootModel.shouldQueue(
                RPCError.responseTimedOut,
                environmentID: "studio",
                snapshot: snapshot
            )
        )
    }

    @Test
    func detailEventsIgnoreDuplicatesAndAdvancePerThreadRevision() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Stream transcript"
        )
        client.snapshot = FeatureSnapshot(threads: [thread])
        let first = FeatureThreadDetail(
            thread: thread,
            messages: [FeatureMessage(id: "message-1", role: .assistant, text: "Hel")]
        )
        let second = FeatureThreadDetail(
            thread: thread,
            messages: [
                FeatureMessage(id: "message-1", role: .assistant, text: "Hello"),
                FeatureMessage(id: "message-2", role: .user, text: "Ship it"),
            ]
        )
        let model = testRootModel(client: client)

        let run = Task { await model.start() }
        client.emit(.detail(first))
        client.emit(.detail(first))
        client.emit(.detail(second))
        client.finishEvents()
        await run.value

        #expect(model.details[thread.id] == second)
        #expect(model.detailRevision == 2)
        #expect(model.detailRevisions[thread.id] == 2)
    }

    @Test
    func authoritativeAttachmentRetainsLocalPreviewUntilURLHydrates() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Image preview"
        )
        client.snapshot = FeatureSnapshot(threads: [thread])
        let preview = Data([0x01, 0x02, 0x03])
        let local = FeatureThreadDetail(
            thread: thread,
            messages: [
                FeatureMessage(
                    id: "message-1",
                    role: .user,
                    text: "See image",
                    attachments: [
                        FeatureMessageAttachment(
                            id: "local-attachment",
                            name: "image.jpg",
                            mimeType: "image/jpeg",
                            sizeBytes: 3,
                            previewData: preview
                        ),
                    ]
                ),
            ]
        )
        let authoritative = FeatureThreadDetail(
            thread: thread,
            messages: [
                FeatureMessage(
                    id: "message-1",
                    role: .user,
                    text: "See image",
                    attachments: [
                        FeatureMessageAttachment(
                            id: "server-attachment",
                            name: "image.jpg",
                            mimeType: "image/jpeg",
                            sizeBytes: 3
                        ),
                    ]
                ),
            ]
        )
        let model = testRootModel(client: client)

        let run = Task { await model.start() }
        client.emit(.detail(local))
        client.emit(.detail(authoritative))
        client.finishEvents()
        await run.value

        #expect(model.details[thread.id]?.messages[0].attachments[0].id == "server-attachment")
        #expect(model.details[thread.id]?.messages[0].attachments[0].previewData == preview)
    }

    @Test
    func detailDeltaCarriesAContiguousRenderCursor() async {
        let client = FeatureClientStub()
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Incremental transcript"
        )
        let firstMessage = FeatureMessage(id: "message-1", role: .assistant, text: "Hel")
        let completedMessage = FeatureMessage(id: "message-1", role: .assistant, text: "Hello")
        let appendedMessage = FeatureMessage(id: "message-2", role: .user, text: "Ship it")
        let first = FeatureThreadDetail(thread: thread, messages: [firstMessage])
        let second = FeatureThreadDetail(
            thread: thread,
            messages: [completedMessage, appendedMessage]
        )
        client.snapshot = FeatureSnapshot(threads: [thread])
        let model = testRootModel(client: client)

        let run = Task { await model.start() }
        client.emit(.detail(first))
        client.emit(.detailDelta(
            second,
            FeatureDetailDelta(
                changedMessages: [completedMessage, appendedMessage],
                appendedMessageIDs: [appendedMessage.id]
            )
        ))
        client.finishEvents()
        await run.value

        #expect(model.details[thread.id] == second)
        #expect(model.detailRevisions[thread.id] == 2)
        guard let update = model.detailRenderUpdates[thread.id] else {
            Issue.record("Expected an incremental render update")
            return
        }
        #expect(update.baseRevision == 1)
        #expect(update.revision == 2)
        guard case let .delta(delta) = update.change else {
            Issue.record("Expected a detail delta")
            return
        }
        #expect(delta.appendedMessageIDs == [appendedMessage.id])
        #expect(delta.changedMessages == [completedMessage, appendedMessage])
    }

    @Test
    func detailReducerAppendsStreamingTailAndExposesRenderMutation() {
        let startedAt = "2026-07-31T20:00:00Z"
        let message = OrchestrationMessage(
            id: "message-1",
            role: "assistant",
            text: "Hel",
            attachments: nil,
            turnId: "turn-1",
            streaming: true,
            createdAt: startedAt,
            updatedAt: startedAt
        )
        let thread = orchestrationThread(messages: [message])
        let event = orchestrationEvent(
            type: "thread.message-sent",
            sequence: 12,
            payload: [
                "threadId": .string(thread.id),
                "messageId": .string(message.id),
                "role": .string("assistant"),
                "text": .string("lo"),
                "turnId": .string("turn-1"),
                "streaming": .bool(true),
                "createdAt": .string(startedAt),
                "updatedAt": .string("2026-07-31T20:00:01Z"),
            ]
        )

        let reduction = NativeThreadDetailReducer.apply(event, to: thread)

        #expect(reduction.sequence == 12)
        guard case let .updated(updated) = reduction.result else {
            Issue.record("Expected a streaming message update")
            return
        }
        #expect(updated.messages[0].text == "Hello")
        #expect(updated.messages[0].updatedAt == startedAt)
        guard case let .message(rendered) = reduction.renderMutation else {
            Issue.record("Expected a message-only render mutation")
            return
        }
        #expect(rendered.text == "Hello")
    }

    @Test
    func detailReducerBindsCheckpointThatArrivedBeforeAssistantMessage() {
        let checkpoint = CheckpointSummary(
            turnId: "turn-1",
            checkpointTurnCount: 1,
            checkpointRef: "refs/t3/checkpoint-1",
            status: "completed",
            files: [],
            assistantMessageId: nil,
            completedAt: "2026-07-31T20:00:01Z"
        )
        let thread = orchestrationThread(checkpoints: [checkpoint])
        let event = orchestrationEvent(
            type: "thread.message-sent",
            sequence: 12,
            payload: [
                "threadId": .string(thread.id),
                "messageId": .string("assistant-1"),
                "role": .string("assistant"),
                "text": .string("Done"),
                "turnId": .string("turn-1"),
                "streaming": .bool(false),
                "createdAt": .string("2026-07-31T20:00:00Z"),
                "updatedAt": .string("2026-07-31T20:00:02Z"),
            ]
        )

        let reduction = NativeThreadDetailReducer.apply(event, to: thread)

        guard case let .updated(updated) = reduction.result else {
            Issue.record("Expected an assistant message update")
            return
        }
        #expect(updated.checkpoints.first?.assistantMessageId == "assistant-1")
    }

    @Test
    func activityReducerKeepsLargeSnapshotHistorySharedAndExposesOnlyTheTail() throws {
        let historical = (0..<1_000).map { (index: Int) in
            OrchestrationActivity(
                id: "history-\(index)",
                tone: "info",
                kind: "tool.completed",
                summary: "Historical work",
                payload: .object([:]),
                turnId: "turn-1",
                sequence: index,
                createdAt: "2026-07-31T20:00:00Z"
            )
        }
        let appended = OrchestrationActivity(
            id: "activity-new",
            tone: "info",
            kind: "tool.completed",
            summary: "New work",
            payload: .object([:]),
            turnId: "turn-1",
            sequence: historical.count,
            createdAt: "2026-07-31T20:00:01Z"
        )
        let thread = orchestrationThread(activities: historical)
        let event = orchestrationEvent(
            type: "thread.activity-appended",
            sequence: 1_001,
            payload: [
                "threadId": .string(thread.id),
                "activity": try JSONValue.encode(appended),
            ]
        )

        let reduction = NativeThreadDetailReducer.apply(event, to: thread)

        guard case let .updated(updated) = reduction.result else {
            Issue.record("Expected an activity update")
            return
        }
        #expect(updated.activities.count == historical.count)
        guard case let .activity(rendered) = reduction.renderMutation else {
            Issue.record("Expected an activity-tail render mutation")
            return
        }
        #expect(rendered == appended)
    }

    @Test
    func destructiveDetailEventRequestsAuthoritativeSnapshot() {
        let thread = orchestrationThread()
        let event = orchestrationEvent(
            type: "thread.reverted",
            sequence: 3,
            payload: ["threadId": .string(thread.id)]
        )

        let reduction = NativeThreadDetailReducer.apply(event, to: thread)

        #expect(reduction.result == .refresh)
        #expect(reduction.renderMutation == .full)
    }

    @Test
    func detailReducerAppliesServerSettlementEvents() {
        let thread = orchestrationThread()
        let settled = orchestrationEvent(
            type: "thread.settled",
            sequence: 4,
            payload: [
                "threadId": .string(thread.id),
                "settledAt": .string("2026-07-31T20:00:03Z"),
                "updatedAt": .string("2026-07-31T20:00:03Z"),
            ]
        )

        guard case let .updated(settledThread) = NativeThreadDetailReducer
            .apply(settled, to: thread).result else {
            Issue.record("Expected a settled thread")
            return
        }
        #expect(settledThread.settledOverride == "settled")
        #expect(settledThread.settledAt == "2026-07-31T20:00:03Z")
        #expect(settledThread.unsettledAt == nil)

        let unsettled = orchestrationEvent(
            type: "thread.unsettled",
            sequence: 5,
            payload: [
                "threadId": .string(thread.id),
                "reason": .string("user"),
                "updatedAt": .string("2026-07-31T20:00:04Z"),
            ]
        )
        guard case let .updated(activeThread) = NativeThreadDetailReducer
            .apply(unsettled, to: settledThread).result else {
            Issue.record("Expected an active thread")
            return
        }
        #expect(activeThread.settledOverride == "active")
        #expect(activeThread.settledAt == nil)
        #expect(activeThread.unsettledAt == "2026-07-31T20:00:04Z")

        let activityReset = orchestrationEvent(
            type: "thread.unsettled",
            sequence: 6,
            payload: [
                "threadId": .string(thread.id),
                "reason": .string("activity"),
                "updatedAt": .string("2026-07-31T20:00:05Z"),
            ]
        )
        guard case let .updated(resetThread) = NativeThreadDetailReducer
            .apply(activityReset, to: activeThread).result else {
            Issue.record("Expected an activity reset")
            return
        }
        #expect(resetThread.settledOverride == nil)
        #expect(resetThread.unsettledAt == "2026-07-31T20:00:04Z")
    }

    @Test
    func linkedPullRequestUpdatesDoNotReloadTheEntireThread() throws {
        let thread = orchestrationThread()
        let link = ThreadLinkedPullRequest(
            projectId: thread.projectId,
            repository: "pingdotgg/t3code",
            number: 5178,
            url: "https://github.com/pingdotgg/t3code/pull/5178"
        )
        let event = orchestrationEvent(
            type: "thread.meta-updated",
            sequence: 7,
            payload: [
                "threadId": .string(thread.id),
                "linkedPullRequest": try JSONValue.encode(link),
                "updatedAt": .string("2026-08-25T12:00:00Z"),
            ]
        )

        let reduction = NativeThreadDetailReducer.apply(event, to: thread)

        guard case let .updated(updated) = reduction.result else {
            Issue.record("Expected the linked pull request to update without a full refresh")
            return
        }
        #expect(updated.linkedPullRequest == link)
        #expect(reduction.renderMutation == .metadata)

        let unlink = orchestrationEvent(
            type: "thread.meta-updated",
            sequence: 8,
            payload: [
                "threadId": .string(thread.id),
                "linkedPullRequest": .null,
                "updatedAt": .string("2026-08-25T12:01:00Z"),
            ]
        )
        guard case let .updated(unlinked) = NativeThreadDetailReducer.apply(unlink, to: updated).result else {
            Issue.record("Expected the pull request link to clear")
            return
        }
        #expect(unlinked.linkedPullRequest == nil)
    }
}

@MainActor
@Observable
private final class ThreadImageCoverPresentation {
    var isPresented = false
    var onDismiss: (() -> Void)?
    let appeared = XCTestExpectation(description: "Full-screen attachment flow appeared")
    let dismissed = XCTestExpectation(description: "Full-screen attachment flow dismissed")
}

private struct ThreadImageTestHost: View {
    let detail: ThreadDetailView
    @Bindable var presentation: ThreadImageCoverPresentation

    var body: some View {
        detail.fullScreenCover(isPresented: $presentation.isPresented, onDismiss: {
            presentation.onDismiss?()
            presentation.dismissed.fulfill()
        }) {
            ThreadImageAppearanceProbe(onAppear: { presentation.appeared.fulfill() })
        }
    }
}

private struct ThreadImageAppearanceProbe: UIViewControllerRepresentable {
    let onAppear: () -> Void

    func makeUIViewController(context: Context) -> Controller {
        let controller = Controller()
        controller.onAppear = onAppear
        return controller
    }

    func updateUIViewController(_ controller: Controller, context: Context) {}

    final class Controller: UIViewController {
        var onAppear: (() -> Void)?

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            onAppear?()
            onAppear = nil
        }
    }
}

@MainActor
private func firstMultilineTextInput(in view: UIView) -> UIView? {
    if view is UITextView || view is UITextField {
        return view
    }
    for subview in view.subviews {
        if let input = firstMultilineTextInput(in: subview) {
            return input
        }
    }
    return nil
}

@MainActor
private func textInputText(_ view: UIView?) -> String? {
    if let textView = view as? UITextView {
        return textView.text
    }
    if let textField = view as? UITextField {
        return textField.text
    }
    return nil
}

@MainActor
private func testRootModel(client: FeatureClientStub) -> FeatureRootModel {
    FeatureRootModel(
        client: client,
        outboxStore: FeatureOutboxStore(
            fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("t3-root-outbox-\(UUID().uuidString).json")
        )
    )
}

private func orchestrationEvent(
    type: String,
    sequence: Int,
    payload: [String: JSONValue]
) -> JSONValue {
    .object([
        "type": .string(type),
        "sequence": .number(Double(sequence)),
        "occurredAt": .string("2026-07-31T20:00:02Z"),
        "payload": .object(payload),
    ])
}

private func orchestrationThread(
    messages: [OrchestrationMessage] = [],
    activities: [OrchestrationActivity] = [],
    checkpoints: [CheckpointSummary] = []
) -> OrchestrationThread {
    OrchestrationThread(
        id: "thread-1",
        projectId: "project-1",
        title: "Native detail stream",
        modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
        runtimeMode: .fullAccess,
        interactionMode: .default,
        branch: "main",
        worktreePath: "/native",
        latestTurn: nil,
        createdAt: "2026-07-31T20:00:00Z",
        updatedAt: "2026-07-31T20:00:00Z",
        archivedAt: nil,
        settledOverride: nil,
        settledAt: nil,
        snoozedUntil: nil,
        snoozedAt: nil,
        pinnedAt: nil,
        deletedAt: nil,
        messages: messages,
        activities: activities,
        checkpoints: checkpoints,
        session: nil
    )
}

@MainActor
private final class FeatureClientStub: FeatureClient, T3ConnectCapable {
    var foregroundReconnects: [Bool] = []
    func resumeAfterBackground(reconnect: Bool) async { foregroundReconnects.append(reconnect) }
    private let eventStream: AsyncStream<FeatureEvent>
    private let eventContinuation: AsyncStream<FeatureEvent>.Continuation
    var snapshot = FeatureSnapshot()
    var backgroundSnapshotValue: FeatureSnapshot?
    var snapshotAfterEnvironmentToggle: FeatureSnapshot?
    var initialSnapshotCallCount = 0
    var backgroundSnapshotCallCount = 0
    var snapshotAfterPair: FeatureSnapshot?
    var snapshotAfterEnvironmentRemoval: FeatureSnapshot?
    var createdThread = FeatureThread(id: "created", projectID: "project", title: "Created")
    var threadDetail: FeatureThreadDetail?
    var earlierThreadDetail: FeatureThreadDetail?
    var pairEndpoint: String?
    var pairToken: String?
    var sentText: String?
    var startedPrompt: String?
    var startedAttachments: [FeatureUploadAttachment] = []
    var startedWorkspaceMode: FeatureWorkspaceMode?
    var startedBranch: String?
    var startedWorktreePath: String?
    var startedFromOrigin = false
    var createThreadCallCount = 0
    var sendMessageCallCount = 0
    var sentRuntimeModes: [FeatureRuntimeMode] = []
    var setRuntimeModeCalls: [FeatureRuntimeMode] = []
    var cancelTurnCallCount = 0
    var signOutCallCount = 0
    var startTaskError: (any Error)?
    var sendMessageError: (any Error)?
    var runtimeModeError: (any Error)?
    var settlementError: (any Error)?
    var beforeSettlementReturn: (() async -> Void)?
    var enabledEnvironmentID: String?
    var environmentEnabledValue: Bool?
    var removedEnvironmentID: String?
    var beforeStartTask: (() async throws -> Void)?
    var beforeSendMessage: (() throws -> Void)?
    var loadThreadError: (any Error)?
    var loadThreadHandler: ((String) async throws -> FeatureThreadDetail)?
    var preuploadHandler: ((FeatureUploadAttachment, String) async throws -> FeatureUploadedAttachmentReference?)?
    var beforeLoadThreadReturn: (() async -> Void)?
    var loadEarlierCallCount = 0
    var resolvedInputID: String?
    var resolvedInputAnswers: [String: FeatureInputAnswer]?
    var savedSettings: [FeatureSettings] = []
    var refreshedProviderEnvironmentID: String?
    var refreshedProviders: [FeatureProvider] = []
    var automaticSettlementEnvironmentID: String?
    var automaticSettlementChange: FeatureAutomaticSettlementChange?
    var automaticSettlementResult = FeatureAutomaticSettlementSettings(
        onMerge: true,
        afterDays: 3
    )
    var automaticSettlementError: (any Error)?
    lazy var t3ConnectController = T3ConnectController(
        resolution: .unavailable(reason: "T3 Connect is disabled in feature tests.")
    )

    init() {
        let pair = AsyncStream<FeatureEvent>.makeStream()
        eventStream = pair.stream
        eventContinuation = pair.continuation
    }

    func events() -> AsyncStream<FeatureEvent> {
        eventStream
    }

    func emit(_ event: FeatureEvent) {
        eventContinuation.yield(event)
    }

    func finishEvents() {
        eventContinuation.finish()
    }

    func initialSnapshot() async throws -> FeatureSnapshot {
        initialSnapshotCallCount += 1
        if removedEnvironmentID != nil, let snapshotAfterEnvironmentRemoval {
            return snapshotAfterEnvironmentRemoval
        }
        if pairEndpoint != nil, let snapshotAfterPair {
            return snapshotAfterPair
        }
        if enabledEnvironmentID != nil, let snapshotAfterEnvironmentToggle {
            return snapshotAfterEnvironmentToggle
        }
        return snapshot
    }

    func backgroundSnapshot() async throws -> FeatureSnapshot {
        backgroundSnapshotCallCount += 1
        return backgroundSnapshotValue ?? snapshot
    }

    func pair(endpoint: String, token: String?) async throws {
        pairEndpoint = endpoint
        pairToken = token
    }

    func setEnvironmentEnabled(id: String, enabled: Bool) async throws {
        enabledEnvironmentID = id
        environmentEnabledValue = enabled
    }

    func removeEnvironment(id: String) async throws {
        removedEnvironmentID = id
    }

    func connectT3Environment(
        _ credential: T3ConnectManagedEnvironmentCredential
    ) async throws {}

    func signOutT3Connect() async {
        signOutCallCount += 1
        let removedIDs = Set(snapshot.environments.filter { $0.source == .t3Connect }.map(\.id))
        snapshot.environments.removeAll { removedIDs.contains($0.id) }
        snapshot.projects.removeAll { removedIDs.contains($0.environmentID) }
        snapshot.threads.removeAll {
            $0.environmentID.map(removedIDs.contains) ?? false
        }
    }

    func createThread(
        projectID: String,
        title: String?,
        selection: FeatureSelection?
    ) async throws -> FeatureThread {
        createThreadCallCount += 1
        return createdThread
    }

    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread {
        if let startTaskError { throw startTaskError }
        startedPrompt = prompt
        startedAttachments = attachments
        return createdThread
    }

    func createThreadAndSend(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        workspaceMode: FeatureWorkspaceMode,
        branch: String?,
        worktreePath: String?,
        startFromOrigin: Bool,
        attachments: [FeatureUploadAttachment]
    ) async throws -> FeatureThread {
        try await beforeStartTask?()
        if let startTaskError { throw startTaskError }
        startedPrompt = prompt
        startedAttachments = attachments
        startedWorkspaceMode = workspaceMode
        startedBranch = branch
        startedWorktreePath = worktreePath
        startedFromOrigin = startFromOrigin
        return createdThread
    }

    func renameThread(id: String, title: String) async throws {}
    func setThreadArchived(id: String, archived: Bool) async throws {}
    func setRuntimeMode(id: String, mode: FeatureRuntimeMode) async throws {
        setRuntimeModeCalls.append(mode)
        if let runtimeModeError { throw runtimeModeError }
    }
    func deleteThread(id: String) async throws {}

    func preuploadAttachment(
        _ attachment: FeatureUploadAttachment,
        environmentID: String
    ) async throws -> FeatureUploadedAttachmentReference? {
        try await preuploadHandler?(attachment, environmentID)
    }

    func loadThread(id: String) async throws -> FeatureThreadDetail {
        if let loadThreadError {
            throw loadThreadError
        }
        if let loadThreadHandler {
            return try await loadThreadHandler(id)
        }
        await beforeLoadThreadReturn?()
        if let threadDetail {
            return threadDetail
        }
        return FeatureThreadDetail(thread: createdThread)
    }

    func loadEarlierThreadTurns(id: String) async throws -> FeatureThreadDetail? {
        loadEarlierCallCount += 1
        return earlierThreadDetail
    }

    func sendMessage(threadID: String, text: String, selection: FeatureSelection?) async throws {
        sendMessageCallCount += 1
        try beforeSendMessage?()
        if let sendMessageError { throw sendMessageError }
        sentText = text
    }

    func sendMessage(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        attachments _: [FeatureUploadAttachment],
        identity _: FeatureSubmissionIdentity
    ) async throws {
        sentRuntimeModes.append(runtimeMode)
        try await sendMessage(threadID: threadID, text: text, selection: selection)
    }

    func cancelTurn(threadID: String) async throws {
        cancelTurnCallCount += 1
    }
    func setThreadSettled(id: String, settled: Bool) async throws {
        await beforeSettlementReturn?()
        if let settlementError { throw settlementError }
    }
    func resolveApproval(id: String, decision: FeatureApprovalDecision) async throws {}
    func resolveUserInput(
        id: String,
        answers: [String: FeatureInputAnswer]
    ) async throws {
        resolvedInputID = id
        resolvedInputAnswers = answers
    }
    func saveSettings(_ settings: FeatureSettings) async throws {
        savedSettings.append(settings)
    }
    func refreshProviders(environmentID: String) async throws -> [FeatureProvider] {
        refreshedProviderEnvironmentID = environmentID
        return refreshedProviders
    }
    func updateAutomaticSettlement(
        environmentID: String,
        change: FeatureAutomaticSettlementChange
    ) async throws -> FeatureAutomaticSettlementSettings {
        automaticSettlementEnvironmentID = environmentID
        automaticSettlementChange = change
        if let automaticSettlementError { throw automaticSettlementError }
        return automaticSettlementResult
    }
}
