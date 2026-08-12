import Foundation
import Testing
@testable import T3Code

@Suite("Incoming share import")
struct PlatformIncomingShareTests {
    @Test @MainActor
    func routingGateCoalescesARequestThatArrivesWhileRouting() async {
        let gate = PlatformIncomingShareRoutingGate()
        let started = AsyncStream<Void>.makeStream()
        let release = AsyncStream<Void>.makeStream()
        var runCount = 0

        let first = Task { @MainActor in
            await gate.request {
                runCount += 1
                if runCount == 1 {
                    started.continuation.yield()
                    for await _ in release.stream { break }
                }
            }
        }
        var startedIterator = started.stream.makeAsyncIterator()
        _ = await startedIterator.next()

        await gate.request { runCount += 1 }
        await gate.request { runCount += 10 }
        release.continuation.yield()
        await first.value

        #expect(runCount == 11)
    }

    @Test
    func threadDestinationResolutionRequiresAnAuthoritativeConnectedSnapshot() {
        #expect(PlatformIncomingShareDestinationConnectionPolicy.canResolveThread(
            connectionState: .connected
        ))
        #expect(!PlatformIncomingShareDestinationConnectionPolicy.canResolveThread(
            connectionState: .disconnected
        ))
        #expect(!PlatformIncomingShareDestinationConnectionPolicy.canResolveThread(
            connectionState: nil
        ))
    }

    @Test
    func persistsMergedDraftBeforeRemovingInboxEnvelope() async throws {
        let recorder = IncomingShareTestRecorder()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let selection = FeatureSelection(providerID: "codex", modelID: "gpt-5.6-sol")
        let workspace = FeatureComposerWorkspaceDraft(
            mode: .worktree,
            branch: "main",
            worktreePath: nil,
            startFromOrigin: true
        )
        let existingAttachment = Self.attachment(id: UUID(), value: 1)
        let existing = FeatureComposerDraft(
            text: "Existing prompt",
            attachments: [existingAttachment],
            selection: selection,
            workspace: workspace
        )
        let imageID = try #require(UUID(uuidString: "12345678-1234-1234-1234-123456789abc"))
        let envelope = Self.envelope(
            text: "Shared context",
            images: [Self.image(id: imageID.uuidString)]
        )
        let project = Self.project()
        let expectedKey = FeatureComposerDraftStore.newTaskKey(project: project)
        try await store.setDraft(existing, for: expectedKey)
        let pipeline = PlatformIncomingSharePipeline(
            source: PlatformIncomingShareSource(
                loadAll: { [envelope] },
                data: { image in
                    await recorder.record("read:\(image.id)")
                    return Data([0xCA, 0xFE])
                },
                remove: { id in await recorder.record("remove:\(id)") }
            ),
            drafts: PlatformIncomingShareDraftRepository(
                importContent: { shareID, text, attachments, key, maximumCount in
                    let draft = try await store.importSharedContent(
                        shareID: shareID,
                        text: text,
                        attachments: attachments,
                        for: key,
                        maximumAttachmentCount: maximumCount
                    )
                    await recorder.capture(draft: draft, key: key)
                    await recorder.record("import:\(key)")
                    return PlatformIncomingShareDraftImport(draft: draft, didImport: true)
                }
            ),
            prepareImage: { data, ordinal in
                await recorder.record("prepare:\(ordinal)")
                return FeatureDraftAttachment(
                    data: data,
                    filename: "Image \(ordinal).jpg",
                    mimeType: "image/jpeg"
                )
            }
        )

        let merged = try await pipeline.importEnvelope(envelope, into: project)
        let captured = await recorder.capturedDraft
        let events = await recorder.events

        #expect(merged.text == "Existing prompt\n\nShared context")
        #expect(merged.selection == selection)
        #expect(merged.workspace == workspace)
        #expect(merged.attachments.count == 2)
        #expect(merged.attachments.last?.id == imageID)
        #expect(captured?.key == expectedKey)
        #expect(captured?.draft == merged)
        #expect(events.suffix(2) == ["import:\(expectedKey)", "remove:\(envelope.id)"])
        #expect(try await store.draft(for: expectedKey) == merged)
    }

    @Test
    func failedDraftSaveLeavesTheInboxUntouched() async {
        let recorder = IncomingShareTestRecorder()
        let envelope = Self.envelope(text: "Keep me")
        let pipeline = PlatformIncomingSharePipeline(
            source: PlatformIncomingShareSource(
                loadAll: { [envelope] },
                data: { _ in Data() },
                remove: { _ in await recorder.record("remove") }
            ),
            drafts: PlatformIncomingShareDraftRepository(
                importContent: { _, _, _, _, _ in
                    await recorder.record("import")
                    throw IncomingShareTestError.saveFailed
                }
            ),
            prepareImage: { _, _ in Self.attachment(id: UUID(), value: 1) }
        )

        do {
            _ = try await pipeline.importEnvelope(envelope, into: Self.project())
            Issue.record("Expected the draft write to fail")
        } catch {
            #expect(error as? IncomingShareTestError == .saveFailed)
        }

        #expect(await recorder.events == ["import"])
    }

    @Test
    func imageFailureDoesNotPersistOrRemoveTheEnvelope() async {
        let recorder = IncomingShareTestRecorder()
        let envelope = Self.envelope(
            images: [Self.image(id: UUID().uuidString)]
        )
        let pipeline = PlatformIncomingSharePipeline(
            source: PlatformIncomingShareSource(
                loadAll: { [envelope] },
                data: { _ in throw IncomingShareTestError.imageFailed },
                remove: { _ in await recorder.record("remove") }
            ),
            drafts: PlatformIncomingShareDraftRepository(
                importContent: { _, _, _, _, _ in
                    await recorder.record("import")
                    return PlatformIncomingShareDraftImport(
                        draft: FeatureComposerDraft(),
                        didImport: true
                    )
                }
            ),
            prepareImage: { _, _ in Self.attachment(id: UUID(), value: 1) }
        )

        do {
            _ = try await pipeline.importEnvelope(envelope, into: Self.project())
            Issue.record("Expected image loading to fail")
        } catch {
            #expect(error as? IncomingShareTestError == .imageFailed)
        }

        #expect(await recorder.events.isEmpty)
    }

    @Test
    func attachmentLimitPreservesTheWholeEnvelope() async throws {
        let recorder = IncomingShareTestRecorder()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let existing = FeatureComposerDraft(
            attachments: (0..<7).map { Self.attachment(id: UUID(), value: UInt8($0)) }
        )
        let envelope = Self.envelope(
            images: [
                Self.image(id: UUID().uuidString),
                Self.image(id: UUID().uuidString),
            ]
        )
        let pipeline = PlatformIncomingSharePipeline(
            source: PlatformIncomingShareSource(
                loadAll: { [envelope] },
                data: { _ in
                    await recorder.record("read")
                    return Data()
                },
                remove: { _ in await recorder.record("remove") }
            ),
            drafts: PlatformIncomingShareDraftRepository(
                importContent: { shareID, text, attachments, key, maximumCount in
                    await recorder.record("import")
                    let draft = try await store.importSharedContent(
                        shareID: shareID,
                        text: text,
                        attachments: attachments,
                        for: key,
                        maximumAttachmentCount: maximumCount
                    )
                    return PlatformIncomingShareDraftImport(draft: draft, didImport: true)
                }
            ),
            prepareImage: { _, _ in Self.attachment(id: UUID(), value: 1) }
        )
        let key = FeatureComposerDraftStore.newTaskKey(project: Self.project())
        try await store.setDraft(existing, for: key)

        do {
            _ = try await pipeline.importEnvelope(envelope, into: Self.project())
            Issue.record("Expected the attachment limit to reject the import")
        } catch let error as FeatureComposerDraftImportError {
            if case let .attachmentLimitExceeded(available) = error {
                #expect(available == 1)
            }
        }

        #expect(!(await recorder.events.contains("remove")))
        #expect(try await store.draft(for: key) == existing)
    }

    @Test
    func repeatedAtomicImportIsIdempotent() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let key = "environment:one:new-task:project"
        let attachment = Self.attachment(id: UUID(), value: 1)
        try await store.setDraft(FeatureComposerDraft(text: "Existing"), for: key)

        let once = try await store.importSharedContent(
            shareID: "share-id",
            text: "Shared",
            attachments: [attachment],
            for: key
        )
        var edited = once
        edited.text += "\nUser edit"
        try await store.setDraft(edited, for: key)
        let replay = try await store.importSharedContentResult(
            shareID: "share-id",
            text: "Shared",
            attachments: [attachment],
            for: key
        )

        #expect(once.text == "Existing\n\nShared")
        #expect(once.attachments == [attachment])
        #expect(replay.draft == edited)
        #expect(!replay.didImport)
    }

    @Test
    func replayAfterInboxRemovalFailureSuppressesAnAlreadyImportedDelta() async throws {
        let recorder = IncomingShareTestRecorder()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let envelope = Self.envelope(text: "Shared once")
        let thread = FeatureThread(
            id: "thread:environment:thread",
            wireID: "thread",
            projectID: "project",
            environmentID: "environment",
            title: "Thread"
        )
        let pipeline = PlatformIncomingSharePipeline(
            source: PlatformIncomingShareSource(
                loadAll: { [envelope] },
                data: { _ in Data() },
                remove: { id in
                    await recorder.record("remove:\(id)")
                    if await recorder.events.count == 1 {
                        throw IncomingShareTestError.removeFailed
                    }
                }
            ),
            drafts: PlatformIncomingShareDraftRepository(
                importContent: { shareID, text, attachments, key, maximumCount in
                    let result = try await store.importSharedContentResult(
                        shareID: shareID,
                        text: text,
                        attachments: attachments,
                        for: key,
                        maximumAttachmentCount: maximumCount
                    )
                    return PlatformIncomingShareDraftImport(
                        draft: result.draft,
                        didImport: result.didImport
                    )
                }
            )
        )

        do {
            _ = try await pipeline.importEnvelope(envelope, into: thread)
            Issue.record("Expected inbox removal to fail")
        } catch {
            #expect(error as? IncomingShareTestError == .removeFailed)
        }

        let replay = try await pipeline.importEnvelope(envelope, into: thread)
        let snapshot = try await store.snapshot(for: FeatureComposerDraftStore.threadKey(thread))

        #expect(replay.sharedContent == nil)
        #expect(snapshot.draft?.text == "Shared once")
        #expect(snapshot.importedShareIDs == [envelope.id])
        #expect(await recorder.events.count == 2)
    }

    @Test
    func existingThreadImportUsesItsDraftAndRepresentsVideoAsAContactSheet() async throws {
        let recorder = IncomingShareTestRecorder()
        let videoID = "12345678-1234-1234-1234-123456789abc"
        let envelope = Self.envelope(
            text: "Review this",
            videos: [Self.video(id: videoID)]
        )
        let thread = FeatureThread(
            id: "thread:environment:thread",
            wireID: "thread",
            projectID: "project",
            environmentID: "environment",
            title: "Existing"
        )
        let pipeline = PlatformIncomingSharePipeline(
            source: PlatformIncomingShareSource(
                loadAll: { [envelope] },
                data: { _ in Data() },
                videoURL: { video in
                    await recorder.record("video:\(video.id)")
                    return URL(fileURLWithPath: "/tmp/video.mov")
                },
                remove: { id in await recorder.record("remove:\(id)") }
            ),
            drafts: PlatformIncomingShareDraftRepository(
                importContent: { shareID, text, attachments, key, _ in
                    await recorder.capture(
                        draft: FeatureComposerDraft(text: text, attachments: attachments),
                        key: key
                    )
                    await recorder.record("import:\(shareID)")
                    return PlatformIncomingShareDraftImport(
                        draft: FeatureComposerDraft(text: text, attachments: attachments),
                        didImport: true
                    )
                }
            ),
            prepareImage: { _, _ in Self.attachment(id: UUID(), value: 1) },
            prepareVideo: { _, _, _ in
                Self.attachment(id: UUID(), value: 9)
            }
        )

        let imported = try await pipeline.importEnvelope(envelope, into: thread)
        let sharedContent = try #require(imported.sharedContent)
        let captured = await recorder.capturedDraft

        #expect(captured?.key == FeatureComposerDraftStore.threadKey(thread))
        #expect(imported.draft.text.contains("Review this"))
        #expect(sharedContent.shareID == envelope.id)
        #expect(sharedContent.draft.text.contains("Shared video: reference.mov"))
        #expect(
            sharedContent.draft.attachments.first?.id.uuidString.lowercased() == videoID
        )
        #expect(await recorder.events == [
            "video:\(videoID)",
            "import:\(envelope.id)",
            "remove:\(envelope.id)",
        ])
    }

    @Test
    func newThreadShareStaysDurableUntilProjectSelectionRoutesIt() async throws {
        let recorder = IncomingShareTestRecorder()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let envelope = Self.envelope(text: "Choose my project")
        let pipeline = PlatformIncomingSharePipeline(
            source: PlatformIncomingShareSource(
                loadAll: { [envelope] },
                data: { _ in Data() },
                remove: { id in await recorder.record("remove:\(id)") }
            ),
            drafts: PlatformIncomingShareDraftRepository(
                importContent: { shareID, text, attachments, key, maximumCount in
                    let draft = try await store.importSharedContent(
                        shareID: shareID,
                        text: text,
                        attachments: attachments,
                        for: key,
                        maximumAttachmentCount: maximumCount
                    )
                    return PlatformIncomingShareDraftImport(draft: draft, didImport: true)
                }
            ),
            prepareImage: { _, _ in Self.attachment(id: UUID(), value: 1) }
        )

        _ = try await pipeline.stageEnvelopeForNewThread(envelope)
        let transferKey = FeatureComposerDraftStore.incomingShareKey(shareID: envelope.id)
        #expect(try await store.draft(for: transferKey)?.text == "Choose my project")
        #expect(await recorder.events.isEmpty)

        let project = Self.project()
        let destinationKey = FeatureComposerDraftStore.newTaskKey(project: project)
        let routed = try await store.routeIncomingShare(
            shareID: envelope.id,
            to: destinationKey
        )
        guard case let .routed(routedDraft) = routed else {
            Issue.record("Expected the staged share to be routed")
            return
        }
        #expect(routedDraft.text == "Choose my project")
        #expect(try await store.draft(for: transferKey) == nil)
        #expect(try await store.draft(for: destinationKey) == routedDraft)

        try await pipeline.acknowledgeEnvelope(id: envelope.id)
        #expect(await recorder.events == ["remove:\(envelope.id)"])
    }

    @Test
    func failedNewThreadRouteKeepsTheStagedSourceAndDestination() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let shareID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        let sourceKey = FeatureComposerDraftStore.incomingShareKey(shareID: shareID)
        let destinationKey = "new-task:full-project"
        let stagedAttachment = Self.attachment(id: UUID(), value: 9)
        let destination = FeatureComposerDraft(
            text: "Existing task",
            attachments: (0..<8).map { Self.attachment(id: UUID(), value: UInt8($0)) }
        )
        _ = try await store.importSharedContent(
            shareID: shareID,
            text: "Still staged",
            attachments: [stagedAttachment],
            for: sourceKey
        )
        try await store.setDraft(destination, for: destinationKey)

        await #expect(throws: FeatureComposerDraftImportError.self) {
            try await store.routeIncomingShare(shareID: shareID, to: destinationKey)
        }

        #expect(try await store.draft(for: sourceKey)?.text == "Still staged")
        #expect(try await store.draft(for: sourceKey)?.attachments == [stagedAttachment])
        #expect(try await store.draft(for: destinationKey) == destination)
    }

    @Test
    func missingStagedShareNeverMasqueradesAsAnExistingDestinationDraft() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(fileURL: directory.appending(path: "drafts.json"))
        let key = "new-task:project"
        try await store.setDraft(FeatureComposerDraft(text: "Existing text"), for: key)

        let result = try await store.routeIncomingShare(
            shareID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            to: key
        )

        #expect(result == .sourceMissing)
        #expect(try await store.draft(for: key)?.text == "Existing text")
    }

    @Test
    @MainActor
    func noProjectNoticeKeepsEnvelopePendingAndOnlyReportsOnce() async {
        let envelope = Self.envelope(text: "Pending")
        let coordinator = PlatformIncomingShareCoordinator(
            pipeline: PlatformIncomingSharePipeline(
                source: PlatformIncomingShareSource(
                    loadAll: { [envelope] },
                    data: { _ in Data() },
                    remove: { _ in }
                ),
                drafts: PlatformIncomingShareDraftRepository(
                    importContent: { _, _, _, _, _ in
                        PlatformIncomingShareDraftImport(
                            draft: FeatureComposerDraft(),
                            didImport: true
                        )
                    }
                ),
                prepareImage: { _, _ in Self.attachment(id: UUID(), value: 1) }
            )
        )

        #expect(await coordinator.refresh(hasProjects: false))
        #expect(coordinator.pendingEnvelope == envelope)
        #expect(!(await coordinator.refresh(hasProjects: false)))
        #expect(coordinator.pendingEnvelope == envelope)
    }

    @Test
    @MainActor
    func dismissedStagedShareDoesNotImmediatelyPresentAgain() async {
        let envelope = Self.envelope(text: "Dismiss for this app session")
        let coordinator = PlatformIncomingShareCoordinator(
            pipeline: PlatformIncomingSharePipeline(
                source: PlatformIncomingShareSource(
                    loadAll: { [envelope] },
                    data: { _ in Data() },
                    remove: { _ in }
                ),
                drafts: PlatformIncomingShareDraftRepository(
                    importContent: { _, _, _, _, _ in
                        PlatformIncomingShareDraftImport(
                            draft: FeatureComposerDraft(),
                            didImport: true
                        )
                    }
                ),
                prepareImage: { _, _ in Self.attachment(id: UUID(), value: 1) }
            )
        )

        _ = await coordinator.refresh(hasProjects: true)
        coordinator.dismissStagedNewThread(id: envelope.id.uppercased())
        _ = await coordinator.refresh(hasProjects: true)

        #expect(coordinator.pendingEnvelope == nil)
    }

    @Test
    @MainActor
    func staleThreadDestinationCanFallBackToThePicker() async throws {
        var envelope = Self.envelope(text: "Pending")
        envelope.destination = .existingThread(environmentID: "env", threadID: "deleted")
        let coordinator = PlatformIncomingShareCoordinator(
            pipeline: PlatformIncomingSharePipeline(
                source: PlatformIncomingShareSource(
                    loadAll: { [envelope] },
                    data: { _ in Data() },
                    remove: { _ in },
                    updateDestination: { _, _ in }
                ),
                drafts: PlatformIncomingShareDraftRepository(
                    importContent: { _, _, _, _, _ in
                        PlatformIncomingShareDraftImport(
                            draft: FeatureComposerDraft(),
                            didImport: true
                        )
                    }
                ),
                prepareImage: { _, _ in Self.attachment(id: UUID(), value: 1) }
            )
        )

        _ = await coordinator.refresh(hasProjects: true)
        try await coordinator.requestAnotherDestination()

        #expect(coordinator.pendingEnvelope?.destination == nil)
    }

    @Test
    @MainActor
    func preferredEnvelopeDoesNotFallBackToAnotherPendingShare() async {
        let envelope = Self.envelope(text: "Do not route me")
        let coordinator = PlatformIncomingShareCoordinator(
            pipeline: PlatformIncomingSharePipeline(
                source: PlatformIncomingShareSource(
                    loadAll: { [envelope] },
                    data: { _ in Data() },
                    remove: { _ in }
                ),
                drafts: PlatformIncomingShareDraftRepository(
                    importContent: { _, _, _, _, _ in
                        PlatformIncomingShareDraftImport(
                            draft: FeatureComposerDraft(),
                            didImport: true
                        )
                    }
                ),
                prepareImage: { _, _ in Self.attachment(id: UUID(), value: 1) }
            )
        )

        #expect(
            !(await coordinator.refresh(
                preferredID: "ffffffff-ffff-ffff-ffff-ffffffffffff",
                hasProjects: true
            ))
        )
        #expect(coordinator.pendingEnvelope == nil)
    }

    private static func envelope(
        text: String = "",
        images: [T3IncomingShareImage] = [],
        videos: [T3IncomingShareVideo] = []
    ) -> T3IncomingShareEnvelope {
        T3IncomingShareEnvelope(
            schemaVersion: T3IncomingShareEnvelope.schemaVersion,
            id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            createdAt: Date(timeIntervalSince1970: 100),
            text: text,
            images: images,
            videos: videos,
            warnings: []
        )
    }

    private static func image(id: String) -> T3IncomingShareImage {
        T3IncomingShareImage(
            id: id,
            fileName: "reference.png",
            typeIdentifier: "public.png",
            relativePath: "image.png",
            byteCount: 2
        )
    }

    private static func video(id: String) -> T3IncomingShareVideo {
        T3IncomingShareVideo(
            id: id,
            fileName: "reference.mov",
            typeIdentifier: "com.apple.quicktime-movie",
            relativePath: "video.mov",
            byteCount: 2
        )
    }

    private static func attachment(id: UUID, value: UInt8) -> FeatureDraftAttachment {
        FeatureDraftAttachment(
            id: id,
            data: Data([value]),
            filename: "Image.jpg",
            mimeType: "image/jpeg"
        )
    }

    private static func project() -> FeatureProject {
        FeatureProject(
            id: "project:environment:project",
            wireID: "project",
            environmentID: "environment",
            name: "t3code",
            path: "/repo"
        )
    }
}

private enum IncomingShareTestError: Error, Equatable {
    case imageFailed
    case removeFailed
    case saveFailed
}

private actor IncomingShareTestRecorder {
    private(set) var events: [String] = []
    private(set) var capturedDraft: (draft: FeatureComposerDraft, key: String)?

    func record(_ event: String) {
        events.append(event)
    }

    func capture(draft: FeatureComposerDraft, key: String) {
        capturedDraft = (draft, key)
    }
}
