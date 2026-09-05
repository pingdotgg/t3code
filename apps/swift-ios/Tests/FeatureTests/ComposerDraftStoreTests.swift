import Foundation
import Testing
@testable import T3Code

@Suite("Composer draft persistence")
struct ComposerDraftStoreTests {
    @Test func staleComposerSavePreservesUploadedReferenceForSameContent() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let key = "environment:test:thread:stale-save"
        let attachment = FeatureDraftAttachment(
            data: Data([1, 2, 3]),
            filename: "same.png",
            mimeType: "image/png"
        )
        try await store.setDraft(
            FeatureComposerDraft(text: "before", attachments: [attachment]),
            for: key
        )
        let reference = FeatureUploadedAttachmentReference(
            environmentID: "test",
            attachmentID: "uploaded"
        )
        #expect(try await store.setUploadedReference(
            reference,
            attachment: attachment,
            for: key
        ))

        try await store.setDraft(
            FeatureComposerDraft(text: "after", attachments: [attachment]),
            for: key
        )

        let saved = try #require(await store.draft(for: key))
        #expect(saved.text == "after")
        #expect(saved.attachments.first?.uploadedReference == reference)
    }

    @Test func uploadedReferenceCompareAndSetDoesNotRestoreRemovedAttachment() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let key = "environment:test:thread:removed"
        let attachment = FeatureDraftAttachment(
            data: Data([1]),
            filename: "removed.png",
            mimeType: "image/png"
        )
        try await store.setDraft(
            FeatureComposerDraft(text: "keep", attachments: [attachment]),
            for: key
        )
        try await store.setDraft(FeatureComposerDraft(text: "keep"), for: key)

        let didSave = try await store.setUploadedReference(
            FeatureUploadedAttachmentReference(
                environmentID: "test",
                attachmentID: "late"
            ),
            attachment: attachment,
            for: key
        )

        #expect(!didSave)
        #expect(try await store.draft(for: key)?.attachments.isEmpty == true)
    }

    @Test func roundTripsThreadTextImagesAndSelection() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("drafts.json")
        let store = FeatureComposerDraftStore(fileURL: fileURL)
        let attachment = FeatureDraftAttachment(
            data: Data([0x01, 0x02, 0x03]),
            thumbnailData: Data([0x04]),
            filename: "reference.png",
            mimeType: "image/png"
        )
        let draft = FeatureComposerDraft(
            text: "Keep this work",
            attachments: [attachment],
            selection: FeatureSelection(providerID: "openai", modelID: "gpt-5.6"),
            workspace: FeatureComposerWorkspaceDraft(
                mode: .worktree,
                branch: "main",
                worktreePath: nil,
                startFromOrigin: true
            )
        )

        try await store.setDraft(draft, for: "environment:test:thread:one")

        let reloaded = FeatureComposerDraftStore(fileURL: fileURL)
        #expect(try await reloaded.draft(for: "environment:test:thread:one") == draft)
    }

    @Test func fileBackedDraftRoundTripUsesTheCurrentStorageRoot() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let sourceURL = directory.appendingPathComponent("provider-notes.txt")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("notes".utf8).write(to: sourceURL)
        let attachmentID = UUID()
        let firstRoot = directory.appendingPathComponent("first-root", isDirectory: true)
        let firstFiles = ManagedAttachmentFileStore(rootURL: firstRoot)
        let ownedFile = try firstFiles.copyOwnedFile(
            from: sourceURL,
            attachmentID: attachmentID,
            originalFileName: "notes.txt"
        )
        let fileURL = directory.appendingPathComponent("drafts.json")
        let store = FeatureComposerDraftStore(
            fileURL: fileURL,
            attachmentStorageRootURL: firstRoot
        )
        let reference = FeatureUploadedAttachmentReference(
            environmentID: "environment-1",
            attachmentID: "server-attachment-1"
        )
        try await store.setDraft(
            FeatureComposerDraft(attachments: [
                FeatureDraftAttachment(
                    id: attachmentID,
                    ownedFile: ownedFile,
                    filename: "notes.txt",
                    mimeType: "text/plain",
                    uploadedReference: reference
                ),
            ]),
            for: "environment:test:thread:file"
        )

        let movedRoot = directory.appendingPathComponent("moved-root", isDirectory: true)
        try FileManager.default.moveItem(at: firstRoot, to: movedRoot)
        let restored = try await FeatureComposerDraftStore(
            fileURL: fileURL,
            attachmentStorageRootURL: movedRoot
        ).draft(for: "environment:test:thread:file")?.attachments.first

        #expect(restored?.id == attachmentID)
        #expect(restored?.ownedFile?.url.deletingLastPathComponent() == movedRoot)
        #expect(restored?.byteCount == 5)
        #expect(restored?.data.isEmpty == true)
        #expect(restored?.uploadedReference == reference)
        let json = try #require(String(data: Data(contentsOf: fileURL), encoding: .utf8))
        #expect(!json.contains(Data("notes".utf8).base64EncodedString()))
    }

    @Test func ownedAttachmentPathsRejectTraversalAndUnknownNames() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let files = ManagedAttachmentFileStore(rootURL: root)

        #expect(throws: ManagedAttachmentFileError.invalidFileName) {
            try files.resolvedFile(fileName: "../outside.txt", byteCount: 1)
        }
        #expect(throws: ManagedAttachmentFileError.invalidFileName) {
            try files.removeOwnedFile(fileName: "not-a-uuid.txt")
        }
    }

    @Test func restoresImageAttachmentWrittenBeforeFileBacking() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let fileURL = directory.appendingPathComponent("drafts.json")
        let attachmentID = UUID()
        try Data(
            """
            {
              "version": 2,
              "drafts": {
                "environment:test:thread:old": {
                  "text": "Old image",
                  "attachments": [{
                    "id": "\(attachmentID.uuidString)",
                    "data": "AQID",
                    "filename": "old.png",
                    "mimeType": "image/png"
                  }]
                }
              }
            }
            """.utf8
        ).write(to: fileURL)

        let attachment = try await FeatureComposerDraftStore(fileURL: fileURL)
            .draft(for: "environment:test:thread:old")?.attachments.first

        #expect(attachment?.id == attachmentID)
        #expect(attachment?.data == Data([1, 2, 3]))
        #expect(attachment?.ownedFile == nil)
    }

    @Test func emptyDraftRemovesPersistedEntry() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("drafts.json")
        let store = FeatureComposerDraftStore(fileURL: fileURL)
        let key = "environment:test:thread:one"

        try await store.setDraft(FeatureComposerDraft(text: "hello"), for: key)
        try await store.setDraft(FeatureComposerDraft(), for: key)

        #expect(try await store.draft(for: key) == nil)
    }

    @Test func clearingDraftPreservesImportedShareIdempotency() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let key = "environment:test:thread:one"

        _ = try await store.importSharedContent(
            shareID: "share-1",
            text: "Imported once",
            attachments: [],
            for: key
        )
        try await store.setDraft(FeatureComposerDraft(), for: key)
        let replayed = try await store.importSharedContent(
            shareID: "share-1",
            text: "Imported once",
            attachments: [],
            for: key
        )

        #expect(replayed.isEmpty)
        #expect(try await store.draft(for: key) == nil)
    }

    @Test func environmentRemovalLeavesOtherDraftsAlone() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        try await store.setDraft(
            FeatureComposerDraft(text: "remove"),
            for: "environment:first:thread:one"
        )
        try await store.setDraft(
            FeatureComposerDraft(text: "keep"),
            for: "environment:second:new-task:two"
        )

        try await store.removeDrafts(environmentID: "first")

        #expect(try await store.draft(for: "environment:first:thread:one") == nil)
        #expect(
            try await store.draft(for: "environment:second:new-task:two")?.text == "keep"
        )
    }

    @Test func environmentRemovalClearsItsGroupedProjectDrafts() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let removedKey = FeatureComposerDraftStore.newTaskKey(
            logicalProjectID: "github.com/t3/removed"
        )
        let preservedKey = FeatureComposerDraftStore.newTaskKey(
            logicalProjectID: "github.com/t3/preserved"
        )
        try await store.setDraft(FeatureComposerDraft(text: "remove"), for: removedKey)
        try await store.setDraft(FeatureComposerDraft(text: "keep"), for: preservedKey)

        try await store.removeDrafts(
            environmentID: "first",
            logicalProjectIDs: ["github.com/t3/removed"]
        )

        #expect(try await store.draft(for: removedKey) == nil)
        #expect(try await store.draft(for: preservedKey)?.text == "keep")
    }

    @Test func migratesResolvedVersionOneNewTaskDefaultsBackToImplicit() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let fileURL = directory.appendingPathComponent("drafts.json")
        try Data(
            """
            {
              "version": 1,
              "drafts": {
                "environment:test:new-task:project": {
                  "text": "Keep the prompt",
                  "attachments": [],
                  "selection": {
                    "providerID": "codex",
                    "modelID": "gpt-old",
                    "options": []
                  },
                  "workspace": {
                    "mode": "local",
                    "startFromOrigin": true
                  }
                }
              }
            }
            """.utf8
        ).write(to: fileURL)

        let store = FeatureComposerDraftStore(fileURL: fileURL)
        let migrated = try await store.draft(
            for: "environment:test:new-task:project"
        )

        #expect(migrated?.text == "Keep the prompt")
        #expect(migrated?.selection == nil)
        #expect(migrated?.workspace == nil)
        let persisted = try JSONSerialization.jsonObject(
            with: Data(contentsOf: fileURL)
        ) as? [String: Any]
        #expect(persisted?["version"] as? Int == 2)
    }

    @Test func restorationPreservesLiveEditsAndRestoresUntouchedFields() {
        let baseline = FeatureComposerDraft(
            selection: FeatureSelection(providerID: "openai", modelID: "gpt-default"),
            workspace: FeatureComposerWorkspaceDraft(
                mode: .local,
                branch: nil,
                worktreePath: nil,
                startFromOrigin: true
            )
        )
        let liveAttachment = FeatureDraftAttachment(
            data: Data([0x01]),
            filename: "live.png",
            mimeType: "image/png"
        )
        let current = FeatureComposerDraft(
            text: "Typed while loading",
            attachments: [liveAttachment],
            selection: baseline.selection,
            workspace: FeatureComposerWorkspaceDraft(
                mode: .local,
                branch: nil,
                worktreePath: nil,
                startFromOrigin: false
            )
        )
        let saved = FeatureComposerDraft(
            text: "Older text",
            attachments: [],
            selection: FeatureSelection(providerID: "anthropic", modelID: "claude-opus"),
            workspace: FeatureComposerWorkspaceDraft(
                mode: .worktree,
                branch: "main",
                worktreePath: "/tmp/worktree",
                startFromOrigin: true
            )
        )

        let merged = FeatureComposerDraftRestoration.merge(
            saved: saved,
            baseline: baseline,
            current: current
        )

        #expect(merged.text == "Typed while loading")
        #expect(merged.attachments == [liveAttachment])
        #expect(merged.selection == saved.selection)
        #expect(merged.workspace?.mode == .worktree)
        #expect(merged.workspace?.branch == "main")
        #expect(merged.workspace?.worktreePath == "/tmp/worktree")
        #expect(merged.workspace?.startFromOrigin == false)
    }

    @Test func restorationUsesFallbacksWithoutOverwritingLiveChoices() {
        let baseline = FeatureComposerDraft()
        let liveSelection = FeatureSelection(providerID: "anthropic", modelID: "claude-sonnet")
        let current = FeatureComposerDraft(selection: liveSelection)
        let fallbackSelection = FeatureSelection(providerID: "openai", modelID: "gpt-default")
        let fallbackWorkspace = FeatureComposerWorkspaceDraft(
            mode: .local,
            branch: nil,
            worktreePath: nil,
            startFromOrigin: true
        )

        let merged = FeatureComposerDraftRestoration.merge(
            saved: nil,
            baseline: baseline,
            current: current,
            fallbackSelection: fallbackSelection,
            fallbackWorkspace: fallbackWorkspace
        )

        #expect(merged.selection == liveSelection)
        #expect(merged.workspace == fallbackWorkspace)
    }

    @Test func successfulSubmissionFenceWaitsForCancelledDraftWrites() async {
        let started = AsyncStream<Void>.makeStream()
        let release = AsyncStream<Void>.makeStream()
        let events = AsyncStream<String>.makeStream()
        let pendingWrite = Task {
            started.continuation.yield()
            for await _ in release.stream { break }
            events.continuation.yield("write finished")
        }
        var startedIterator = started.stream.makeAsyncIterator()
        _ = await startedIterator.next()

        let fencedRemoval = Task {
            await NewTaskDraftWriteFence.cancelAndWait(pendingWrite)
            events.continuation.yield("draft removed")
        }
        release.continuation.yield()
        await fencedRemoval.value

        var eventIterator = events.stream.makeAsyncIterator()
        #expect(await eventIterator.next() == "write finished")
        #expect(await eventIterator.next() == "draft removed")
    }
}
