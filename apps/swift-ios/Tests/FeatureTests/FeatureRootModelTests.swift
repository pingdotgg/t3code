import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Feature root model")
struct FeatureRootModelTests {
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
    func failedActivationDoesNotReuseThePriorConnectedSnapshot() async {
        let client = FeatureClientStub()
        client.snapshot = FeatureSnapshot(
            connection: .init(
                state: .connected,
                environmentName: "Old studio",
                endpoint: "https://old.example"
            ),
            environments: [
                .init(
                    id: "old",
                    name: "Old studio",
                    endpoint: "https://old.example",
                    isActive: true,
                    connectionState: .connected
                ),
                .init(
                    id: "target",
                    name: "Target studio",
                    endpoint: "https://target.example",
                    connectionState: .disconnected
                ),
            ]
        )
        client.activateEnvironmentError = FeatureCapabilityUnavailable("Activation")
        let model = testRootModel(client: client)
        await model.reload()

        let activated = await model.activateEnvironment("target")

        #expect(!activated)
        #expect(client.activatedEnvironmentID == "target")
        #expect(model.snapshot.connection.state == .connected)
        #expect(model.snapshot.environments.first(where: { $0.id == "old" })?.isActive == true)
        #expect(model.snapshot.environments.first(where: { $0.id == "target" })?.isActive == false)
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
private final class FeatureClientStub: FeatureClient {
    private let eventStream: AsyncStream<FeatureEvent>
    private let eventContinuation: AsyncStream<FeatureEvent>.Continuation
    var snapshot = FeatureSnapshot()
    var backgroundSnapshotValue: FeatureSnapshot?
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
    var startTaskError: (any Error)?
    var sendMessageError: (any Error)?
    var activateEnvironmentError: (any Error)?
    var activatedEnvironmentID: String?
    var removedEnvironmentID: String?
    var beforeSendMessage: (() throws -> Void)?
    var loadThreadError: (any Error)?
    var loadEarlierCallCount = 0
    var resolvedInputID: String?
    var resolvedInputAnswers: [String: FeatureInputAnswer]?
    var savedSettings: [FeatureSettings] = []

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

    func activateEnvironment(id: String) async throws {
        activatedEnvironmentID = id
        if let activateEnvironmentError { throw activateEnvironmentError }
    }

    func removeEnvironment(id: String) async throws {
        removedEnvironmentID = id
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
    func deleteThread(id: String) async throws {}

    func loadThread(id: String) async throws -> FeatureThreadDetail {
        if let loadThreadError {
            throw loadThreadError
        }
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

    func cancelTurn(threadID: String) async throws {}
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
}
