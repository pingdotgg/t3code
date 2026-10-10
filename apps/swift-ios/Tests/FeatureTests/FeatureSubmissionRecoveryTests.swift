import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Submission recovery")
struct FeatureSubmissionRecoveryTests {
    @Test(arguments: [false, true])
    func rejectionSurvivesRelaunchWithCompleteInput(newTask: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let attachmentRoot = directory.appendingPathComponent("attachments")
        let attachmentID = UUID()
        let file = try ManagedAttachmentFileStore(rootURL: attachmentRoot).writeOwnedFile(
            data: Data("saved file".utf8), attachmentID: attachmentID, originalFileName: "notes.txt"
        )
        let context = OrchestrationMessageContext(records: [
            FeatureComposerContext.terminalRecord(text: "build output", terminalID: "terminal", label: "Terminal"),
        ])
        let submission = FeatureQueuedSubmission(
            environmentID: "environment",
            identity: .init(threadID: "wire-thread"),
            threadID: "thread",
            text: "Recover all input",
            selection: .init(providerID: "codex", modelID: "test-model"),
            runtimeMode: .approvalRequired,
            interactionMode: .plan,
            attachments: [.init(
                id: attachmentID, ownedFile: file, name: "notes.txt", mimeType: "text/plain",
                uploadedReference: .init(environmentID: "environment", attachmentID: "server-file")
            )],
            creation: newTask ? .init(
                projectID: "project", projectName: "Project", workspaceMode: .worktree,
                branch: "main", worktreePath: "/worktree", startFromOrigin: true,
                draftKey: "logical-project:repository:new-task"
            ) : nil,
            context: context,
            delivery: .queue
        )
        let url = directory.appendingPathComponent("outbox.json")
        let store = FeatureOutboxStore(fileURL: url, attachmentStorageRootURL: attachmentRoot)
        try await store.enqueue(submission)
        try await store.recover(id: submission.id, reason: "Model unavailable")

        let reopened = FeatureOutboxStore(fileURL: url, attachmentStorageRootURL: attachmentRoot)
        #expect(try await reopened.submissions().isEmpty)
        let recovery = try #require(await reopened.recoveryDrafts().first)
        #expect(recovery.submission == submission)
        #expect(recovery.reason == "Model unavailable")
        #expect(recovery.isNewTask == newTask)
        #expect(recovery.draftKey(in: FeatureSnapshot()) == (newTask
            ? "logical-project:repository:new-task" : "environment:environment:thread:wire-thread"))
        let draft = try recovery.composerDraft()
        #expect(draft.text == submission.text)
        #expect(draft.context == context)
        #expect(draft.selection == submission.selection)
        #expect(draft.runtimeMode == .approvalRequired)
        #expect(draft.interactionMode == .plan)
        #expect(draft.workspace?.mode == (newTask ? .worktree : nil))
        #expect(draft.workspace?.branch == (newTask ? "main" : nil))
        #expect(draft.workspace?.worktreePath == (newTask ? "/worktree" : nil))
        #expect(draft.workspace?.startFromOrigin == (newTask ? true : nil))
        #expect(draft.attachments.first?.id == attachmentID)
        #expect(draft.attachments.first?.uploadedReference?.attachmentID == "server-file")
        #expect(try Data(contentsOf: #require(draft.attachments.first?.ownedFile?.url)) == Data("saved file".utf8))
    }

    @Test
    func recoveryWriteFailureKeepsQueueAndNeverPublishesPartialRecovery() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("outbox.json")
        let store = FeatureOutboxStore(fileURL: url)
        let submission = makeSubmission()
        try await store.enqueue(submission)
        let backup = directory.appendingPathComponent("backup.json")
        try FileManager.default.moveItem(at: url, to: backup)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)

        await #expect(throws: (any Error).self) {
            try await store.recover(id: submission.id, reason: "Rejected")
        }
        #expect(try await store.submissions() == [submission])
        #expect(try await store.recoveryDrafts().isEmpty)
        #expect(try await FeatureOutboxStore(fileURL: backup).submissions() == [submission])
    }

    @Test
    func recoveryPreservesNewerEditsAndReplaysOnlyOnce() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("drafts.json")
        let store = FeatureComposerDraftStore(fileURL: url)
        let latestContext = OrchestrationMessageContext(records: [
            FeatureComposerContext.terminalRecord(text: "new output", terminalID: "new", label: "New"),
        ])
        let originalContext = OrchestrationMessageContext(records: [
            FeatureComposerContext.terminalRecord(text: "old output", terminalID: "old", label: "Old"),
        ])
        let latest = FeatureComposerDraft(
            text: "  Newer edits\n", attachments: [.init(data: Data([2]), filename: "new.txt", mimeType: "text/plain")],
            selection: .init(providerID: "claude", modelID: "new-model"),
            workspace: .init(mode: .local, branch: "new-branch", worktreePath: "/new", startFromOrigin: false),
            context: latestContext, runtimeMode: .automatic, interactionMode: .standard
        )
        var submission = makeSubmission()
        submission.context = originalContext
        submission.attachments = [.init(data: Data([1]), name: "old.txt", mimeType: "text/plain")]
        let recovery = FeatureSubmissionRecoveryDraft(submission: submission, reason: "Rejected")
        try await store.setDraft(latest, for: "draft")
        let restored = try await store.restoreSubmission(recovery, for: "draft").draft

        #expect(restored.text == "  Newer edits\n\n\nSaved prompt")
        #expect(restored.attachments.map(\.filename) == ["new.txt", "old.txt"])
        #expect(restored.context?.records == latestContext.records + originalContext.records)
        #expect(restored.selection == latest.selection)
        #expect(restored.workspace == latest.workspace)
        #expect(restored.runtimeMode == latest.runtimeMode)
        #expect(restored.interactionMode == latest.interactionMode)
        let reopened = FeatureComposerDraftStore(fileURL: url)
        #expect(try await reopened.restoreSubmission(recovery, for: "draft").draft == restored)

        // A draft edited after the import must also survive cleanup replay.
        var edited = restored
        edited.text = "Changed after recovery"
        edited.runtimeMode = .fullAccess
        try await reopened.setDraft(edited, for: "draft")
        #expect(try await reopened.restoreSubmission(recovery, for: "draft").draft == edited)
    }

    @Test
    func missingFileRestoresTextAndOtherContextWithAWarning() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = directory.appendingPathComponent("attachments")
        let file = try ManagedAttachmentFileStore(rootURL: root).writeOwnedFile(
            data: Data([1]), attachmentID: UUID(), originalFileName: "missing.txt"
        )
        var submission = makeSubmission()
        submission.attachments = [.init(.init(ownedFile: file, name: "missing.txt", mimeType: "text/plain"))]
        let fileID = submission.attachments[0].id.uuidString
        let fileContext = ComposerContextRecord(contextId: "file", label: "missing.txt", payload: .file(.init(
            attachmentId: fileID, name: "missing.txt", mimeType: "text/plain", sizeBytes: 1
        )))
        let terminal = FeatureComposerContext.terminalRecord(text: "output", terminalID: "terminal", label: "Terminal")
        submission.context = .init(records: [fileContext, terminal])
        submission.text += " " + ComposerContextReferences.format(fileContext)
        let outbox = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"), attachmentStorageRootURL: root)
        try await outbox.enqueue(submission)
        let recovery = try #require(await outbox.recover(id: submission.id, reason: "Missing file"))
        try FileManager.default.removeItem(at: file.url)
        let drafts = FeatureComposerDraftStore(fileURL: directory.appendingPathComponent("drafts.json"))
        let current = FeatureComposerDraft(text: "Keep this")
        try await drafts.setDraft(current, for: "draft")

        let result = try await drafts.restoreSubmission(recovery, for: "draft")
        #expect(result.draft.text == "Keep this\n\nSaved prompt ")
        #expect(result.draft.attachments.isEmpty)
        #expect(result.draft.context?.records == [terminal])
        #expect(result.missingAttachments == ["missing.txt"])
        #expect(result.warning?.contains("missing.txt") == true)
        #expect(try await drafts.draft(for: "draft") == result.draft)
        #expect(try await outbox.recoveryDrafts() == [recovery])
    }

    @Test
    func replayAfterAttachmentRemovalAndSendDoesNotReadOldFilesOrImportAgain() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = directory.appendingPathComponent("attachments")
        let url = directory.appendingPathComponent("drafts.json")
        let file = try ManagedAttachmentFileStore(rootURL: root).writeOwnedFile(
            data: Data([1]), attachmentID: UUID(), originalFileName: "removed.txt"
        )
        var submission = makeSubmission()
        submission.attachments = [.init(.init(ownedFile: file, name: "removed.txt", mimeType: "text/plain"))]
        let recovery = FeatureSubmissionRecoveryDraft(submission: submission, reason: nil)
        let store = FeatureComposerDraftStore(fileURL: url, attachmentStorageRootURL: root)
        var edited = try await store.restoreSubmission(recovery, for: "draft").draft
        edited.attachments = []
        try await store.setDraft(edited, for: "draft")
        try FileManager.default.removeItem(at: file.url)
        let replay = try await store.restoreSubmission(recovery, for: "draft")
        #expect(replay.draft == edited)
        #expect(replay.warning == nil)
        try await store.removeDraft(for: "draft")

        let reopened = FeatureComposerDraftStore(fileURL: url, attachmentStorageRootURL: root)
        #expect(try await reopened.draft(for: "draft") == nil)
        // Later shares must not evict the receipt for an uncleared recovery.
        for index in 0..<33 {
            try await reopened.importSharedContent(shareID: "share-\(index)", text: "", attachments: [], for: "draft")
        }
        #expect(try await reopened.restoreSubmission(recovery, for: "draft").draft.isEmpty)
        #expect(try await reopened.restoreSubmission(recovery, for: "another-project").draft.isEmpty)
    }

    @Test(arguments: [false, true])
    func unreadableCurrentAttachmentKeepsBothSavedDrafts(invalidName: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = directory.appendingPathComponent("attachments")
        let url = directory.appendingPathComponent("drafts.json")
        let file = try ManagedAttachmentFileStore(rootURL: root).writeOwnedFile(
            data: Data([1]), attachmentID: UUID(), originalFileName: "current.txt"
        )
        let savedFile = invalidName
            ? FeatureOwnedAttachmentFile(fileName: "invalid.txt", url: file.url, byteCount: 1) : file
        let store = FeatureComposerDraftStore(fileURL: url, attachmentStorageRootURL: root)
        try await store.setDraft(.init(text: "Current", attachments: [
            .init(ownedFile: savedFile, filename: "current.txt", mimeType: "text/plain"),
        ]), for: "draft")
        if !invalidName { try FileManager.default.removeItem(at: file.url) }
        let before = try Data(contentsOf: url)
        await #expect(throws: FeatureThreadRecoveryError.self) {
            try await store.restoreSubmission(.init(submission: makeSubmission(), reason: nil), for: "draft")
        }
        #expect(try Data(contentsOf: url) == before)
    }

    @Test
    func discardMissingFilesKeepsFilesOwnedByDraftsOrOtherSubmissions() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = directory.appendingPathComponent("attachments")
        let files = try ["missing.txt", "discard.txt", "draft.txt", "queued.txt"].map {
            try ManagedAttachmentFileStore(rootURL: root).writeOwnedFile(
                data: Data([1]), attachmentID: UUID(), originalFileName: $0
            )
        }
        var submission = makeSubmission()
        submission.attachments = files.map { .init(.init(ownedFile: $0, name: $0.fileName, mimeType: "text/plain")) }
        let url = directory.appendingPathComponent("outbox.json")
        let outbox = FeatureOutboxStore(fileURL: url, attachmentStorageRootURL: root)
        try await outbox.enqueue(submission)
        try await outbox.recover(id: submission.id, reason: nil)
        var other = makeSubmission()
        other.attachments = [submission.attachments[3]]
        try await outbox.enqueue(other)
        try FileManager.default.removeItem(at: files[0].url)
        let reopened = FeatureOutboxStore(fileURL: url, attachmentStorageRootURL: root)
        try await reopened.discardRecovery(id: submission.id, preservingOwnedFileNames: [files[2].fileName])
        #expect(try await reopened.recoveryDrafts().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: files[1].url.path))
        #expect(FileManager.default.fileExists(atPath: files[2].url.path))
        #expect(FileManager.default.fileExists(atPath: files[3].url.path))
        #expect(try await reopened.submissions().map(\.id) == [other.id])
    }

    @Test
    func failedDiscardWriteKeepsRecoveryAndItsFile() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = directory.appendingPathComponent("attachments")
        let file = try ManagedAttachmentFileStore(rootURL: root).writeOwnedFile(
            data: Data([1]), attachmentID: UUID(), originalFileName: "saved.txt"
        )
        var submission = makeSubmission()
        submission.attachments = [.init(.init(ownedFile: file, name: "saved.txt", mimeType: "text/plain"))]
        let url = directory.appendingPathComponent("outbox.json")
        let outbox = FeatureOutboxStore(fileURL: url, attachmentStorageRootURL: root)
        try await outbox.enqueue(submission)
        let recovery = try #require(await outbox.recover(id: submission.id, reason: nil))
        try FileManager.default.moveItem(at: url, to: directory.appendingPathComponent("backup.json"))
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        await #expect(throws: (any Error).self) {
            try await outbox.discardRecovery(id: submission.id, preservingOwnedFileNames: [])
        }
        #expect(try await outbox.recoveryDrafts() == [recovery])
        #expect(FileManager.default.fileExists(atPath: file.url.path))
    }

    @Test
    func removingAnEnvironmentAlsoRemovesItsRecoveryDrafts() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let first = makeSubmission()
        var second = makeSubmission()
        second.environmentID = "another-environment"
        try await store.enqueue(first)
        try await store.enqueue(second)
        try await store.recover(id: first.id, reason: "Rejected")
        try await store.recover(id: second.id, reason: "Rejected")
        try await store.removeAll(environmentID: first.environmentID)
        #expect(try await store.recoveryDrafts().map(\.id) == [second.id])
    }

    private func makeSubmission() -> FeatureQueuedSubmission {
        FeatureQueuedSubmission(
            environmentID: "environment", identity: .init(threadID: "wire-thread"), threadID: "thread",
            text: "Saved prompt", selection: .init(providerID: "codex", modelID: "old-model"),
            runtimeMode: .approvalRequired, interactionMode: .plan, attachments: []
        )
    }
}
