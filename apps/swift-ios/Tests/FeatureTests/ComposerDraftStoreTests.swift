import Foundation
import Testing
@testable import T3Code

@Suite("Composer draft persistence")
struct ComposerDraftStoreTests {
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

    @Test func incomingShareAppendsToTheCurrentComposer() {
        let liveDraft = FeatureComposerDraft(
            text: "Typed before import",
            attachments: [FeatureDraftAttachment(
                data: Data([0x01]),
                filename: "live.png",
                mimeType: "image/png"
            )]
        )
        let importedAttachment = FeatureDraftAttachment(
            data: Data([0x02]),
            filename: "shared.png",
            mimeType: "image/png"
        )
        let incomingDraft = FeatureComposerDraft(
            text: "Shared content",
            attachments: [importedAttachment]
        )

        let result = FeatureComposerIncomingShareMerge.merge(
            current: liveDraft,
            incoming: incomingDraft
        )

        #expect(result.draft.text == "Typed before import\n\nShared content")
        #expect(result.draft.attachments == liveDraft.attachments + [importedAttachment])
        #expect(result.attachmentOverflowCount == 0)
    }

    @Test func incomingShareMergeKeepsAttachmentsAndReportsTheRequiredRemovalCount() {
        let currentAttachments = (0..<8).map { value in
            FeatureDraftAttachment(
                data: Data([UInt8(value)]),
                filename: "live-\(value).png",
                mimeType: "image/png"
            )
        }
        let incoming = FeatureComposerDraft(
            text: "Shared",
            attachments: [FeatureDraftAttachment(
                data: Data([0xFF]),
                filename: "shared.png",
                mimeType: "image/png"
            )]
        )

        let result = FeatureComposerIncomingShareMerge.merge(
            current: FeatureComposerDraft(text: "   ", attachments: currentAttachments),
            incoming: incoming
        )

        #expect(result.draft.text == "Shared")
        #expect(result.draft.attachments == currentAttachments + incoming.attachments)
        #expect(result.attachmentOverflowCount == 1)
    }

    @Test func draftSnapshotReportsWhichShareImportsRestorationConsumed() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json")
        )
        let key = "environment:one:thread:one"
        _ = try await store.importSharedContent(
            shareID: "share-one",
            text: "Shared",
            attachments: [],
            for: key
        )

        let snapshot = try await store.snapshot(for: key)

        #expect(snapshot.draft?.text == "Shared")
        #expect(snapshot.importedShareIDs == ["share-one"])
    }

    @Test func reloadPolicyRetainsEveryShareNotConsumedByInitialRestoration() {
        let imports = [
            FeatureComposerIncomingShareDraft(
                shareID: "already-restored",
                draft: FeatureComposerDraft(text: "First")
            ),
            FeatureComposerIncomingShareDraft(
                shareID: "pending-one",
                draft: FeatureComposerDraft(text: "Second")
            ),
            FeatureComposerIncomingShareDraft(
                shareID: "pending-two",
                draft: FeatureComposerDraft(text: "Third")
            ),
        ]

        let pending = FeatureComposerIncomingShareReloadPolicy.pendingImports(
            imports,
            restoredShareIDs: ["already-restored"]
        )

        #expect(pending.map(\.shareID) == ["pending-one", "pending-two"])
    }

    @Test func reloadQueueMatchesThePersistedLedgerWindowAndDeduplicatesReplays() {
        var imports: [FeatureComposerIncomingShareDraft] = []
        for index in 0..<34 {
            imports = FeatureComposerIncomingShareReloadPolicy.appending(
                FeatureComposerIncomingShareDraft(
                    shareID: "share-\(index)",
                    draft: FeatureComposerDraft(text: "Shared \(index)")
                ),
                to: imports
            )
        }
        imports = FeatureComposerIncomingShareReloadPolicy.appending(
            FeatureComposerIncomingShareDraft(
                shareID: "share-33",
                draft: FeatureComposerDraft(text: "Replayed 33")
            ),
            to: imports
        )

        #expect(imports.count == 32)
        #expect(imports.first?.shareID == "share-2")
        #expect(imports.last?.shareID == "share-33")
        #expect(imports.last?.draft.text == "Replayed 33")
        #expect(imports.filter { $0.shareID == "share-33" }.count == 1)
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

    @Test func incomingSharePersistenceWaitsForTheMatchingRestore() {
        #expect(!NewTaskIncomingSharePersistencePolicy.canPersist(
            pendingShareID: "share-a",
            restoredShareID: nil
        ))
        #expect(!NewTaskIncomingSharePersistencePolicy.canPersist(
            pendingShareID: "share-a",
            restoredShareID: "share-b"
        ))
        #expect(NewTaskIncomingSharePersistencePolicy.canPersist(
            pendingShareID: "share-a",
            restoredShareID: "share-a"
        ))
        #expect(!NewTaskIncomingSharePersistencePolicy.canPersist(
            pendingShareID: nil,
            restoredShareID: "share-a"
        ))
    }

    @Test func sharedThreadNavigationRequestsAComposerReload() {
        let importDraft = FeatureComposerIncomingShareDraft(
            shareID: "share-1",
            draft: FeatureComposerDraft(text: "Shared")
        )
        let request = FeatureWorkspaceNavigationRequest(
            destination: .sharedThread(
                id: "thread-1",
                importDraft: importDraft
            )
        )

        #expect(request.destination == .sharedThread(
            id: "thread-1",
            importDraft: importDraft
        ))
        #expect(request.destination != .thread(id: "thread-1"))
    }

    @Test func dismissingOldShareSheetPreservesReplacementContext() {
        let resolution = NewTaskDismissalContext(
            initialProjectID: "project-a",
            incomingShareID: "share-a"
        ).resolve(
            currentInitialProjectID: nil,
            currentIncomingShareID: "share-b"
        )

        #expect(resolution == NewTaskDismissalResolution(
            remainingInitialProjectID: nil,
            remainingIncomingShareID: "share-b",
            releasedIncomingShareID: "share-a"
        ))
    }

    @Test func dismissingCurrentShareSheetClearsItsContext() {
        let resolution = NewTaskDismissalContext(
            initialProjectID: "project-a",
            incomingShareID: "share-a"
        ).resolve(
            currentInitialProjectID: "project-a",
            currentIncomingShareID: "share-a"
        )

        #expect(resolution == NewTaskDismissalResolution(
            remainingInitialProjectID: nil,
            remainingIncomingShareID: nil,
            releasedIncomingShareID: "share-a"
        ))
    }
}
