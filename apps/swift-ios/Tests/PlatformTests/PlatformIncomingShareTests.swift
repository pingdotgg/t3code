import Foundation
import Testing
@testable import T3Code

@Suite("Incoming share import")
struct PlatformIncomingShareTests {
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
                    return draft
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
                    return FeatureComposerDraft()
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
                    return try await store.importSharedContent(
                        shareID: shareID,
                        text: text,
                        attachments: attachments,
                        for: key,
                        maximumAttachmentCount: maximumCount
                    )
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
        let twice = try await store.importSharedContent(
            shareID: "share-id",
            text: "Shared",
            attachments: [attachment],
            for: key
        )

        #expect(once.text == "Existing\n\nShared")
        #expect(once.attachments == [attachment])
        #expect(twice == edited)
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
                    importContent: { _, _, _, _, _ in FeatureComposerDraft() }
                ),
                prepareImage: { _, _ in Self.attachment(id: UUID(), value: 1) }
            )
        )

        #expect(await coordinator.refresh(hasProjects: false))
        #expect(coordinator.pendingEnvelope == envelope)
        #expect(!(await coordinator.refresh(hasProjects: false)))
        #expect(coordinator.pendingEnvelope == envelope)
    }

    private static func envelope(
        text: String = "",
        images: [T3IncomingShareImage] = []
    ) -> T3IncomingShareEnvelope {
        T3IncomingShareEnvelope(
            schemaVersion: T3IncomingShareEnvelope.schemaVersion,
            id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            createdAt: Date(timeIntervalSince1970: 100),
            text: text,
            images: images,
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
