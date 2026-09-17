import Foundation
import Testing
@testable import T3Code

@Suite("Incoming share import")
struct PlatformIncomingShareTests {
    @Test
    func decodesSchemaOneImageEnvelopeWithoutFiles() throws {
        let json = #"{"schemaVersion":1,"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","createdAt":"1970-01-01T00:01:40Z","text":"old","images":[{"id":"12345678-1234-1234-1234-123456789abc","fileName":"reference.png","typeIdentifier":"public.png","relativePath":"image.png","byteCount":2}],"warnings":[]}"#
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let envelope = try decoder.decode(T3IncomingShareEnvelope.self, from: Data(json.utf8))

        #expect(envelope.schemaVersion == 1)
        #expect(envelope.images.count == 1)
        #expect(envelope.files.isEmpty)
    }

    @Test
    func rejectsSharedFilePathOutsideTheInbox() throws {
        let root = URL(fileURLWithPath: "/tmp/t3-share-root", isDirectory: true)

        #expect(T3IncomingShareStore.fileURL(
            relativePath: "../outside.txt",
            rootURL: root
        ) == nil)
    }

    @Test
    func genericFileImportRetriesWithoutReplacingTheOwnedCopy() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let sourceURL = directory.appendingPathComponent("report.txt")
        try Data("report".utf8).write(to: sourceURL)
        let attachmentID = try #require(UUID(uuidString: "12345678-1234-1234-1234-123456789abc"))
        let envelope = Self.envelope(files: [Self.file(
            id: attachmentID.uuidString,
            byteCount: 6
        )])
        let recorder = IncomingShareTestRecorder()
        let ownedRoot = directory.appendingPathComponent("owned", isDirectory: true)
        let pipeline = PlatformIncomingSharePipeline(
            source: PlatformIncomingShareSource(
                loadAll: { [envelope] },
                data: { _ in Data() },
                remove: { _ in await recorder.record("remove") },
                fileURL: { _ in sourceURL }
            ),
            drafts: PlatformIncomingShareDraftRepository(
                importContent: { _, _, attachments, _, _ in
                    await recorder.record("import")
                    if await recorder.events.count == 1 {
                        throw IncomingShareTestError.saveFailed
                    }
                    return FeatureComposerDraft(attachments: attachments)
                }
            ),
            attachmentFileStore: ManagedAttachmentFileStore(rootURL: ownedRoot)
        )

        do {
            _ = try await pipeline.importEnvelope(envelope, into: Self.project())
            Issue.record("Expected the first draft write to fail")
        } catch {
            #expect(error as? IncomingShareTestError == .saveFailed)
        }
        let draft = try await pipeline.importEnvelope(envelope, into: Self.project())

        #expect(draft.attachments.first?.id == attachmentID)
        #expect(draft.attachments.first?.ownedFile?.byteCount == 6)
        #expect(await recorder.events == ["import", "import", "remove"])
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
    func groupedProjectImportUsesTheSameDraftKeyAsTheComposer() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let project = Self.project(
            repositoryIdentity: FeatureRepositoryIdentity(canonicalKey: "github.com/t3/example")
        )
        let snapshot = FeatureSnapshot(projects: [project])
        let draftKey = FeatureComposerDraftStore.newTaskKey(project: project, in: snapshot)
        let envelope = Self.envelope(text: "Keep shared context")
        let pipeline = PlatformIncomingSharePipeline(
            source: PlatformIncomingShareSource(
                loadAll: { [envelope] },
                data: { _ in Data() },
                remove: { _ in }
            ),
            drafts: PlatformIncomingShareDraftRepository(
                importContent: { shareID, text, attachments, key, maximumCount in
                    try await store.importSharedContent(
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

        _ = try await pipeline.importEnvelope(envelope, into: project, draftKey: draftKey)

        #expect(draftKey == "logical-project:github.com/t3/example:new-task")
        #expect(try await store.draft(for: draftKey)?.text == "Keep shared context")
        #expect(
            try await store.draft(for: FeatureComposerDraftStore.newTaskKey(project: project)) == nil
        )
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
        images: [T3IncomingShareImage] = [],
        files: [T3IncomingShareFile] = []
    ) -> T3IncomingShareEnvelope {
        T3IncomingShareEnvelope(
            schemaVersion: T3IncomingShareEnvelope.schemaVersion,
            id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            createdAt: Date(timeIntervalSince1970: 100),
            text: text,
            images: images,
            files: files,
            warnings: []
        )
    }

    private static func file(id: String, byteCount: Int) -> T3IncomingShareFile {
        T3IncomingShareFile(
            id: id,
            fileName: "report.txt",
            mimeType: "text/plain",
            relativePath: "report.txt",
            byteCount: byteCount
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

    private static func project(
        repositoryIdentity: FeatureRepositoryIdentity? = nil
    ) -> FeatureProject {
        FeatureProject(
            id: "project:environment:project",
            wireID: "project",
            environmentID: "environment",
            name: "t3code",
            path: "/repo",
            repositoryIdentity: repositoryIdentity
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
