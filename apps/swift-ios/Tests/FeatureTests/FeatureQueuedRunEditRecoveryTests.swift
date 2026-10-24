import Foundation
import Testing
@testable import T3Code

@Suite("Rich queued message edits")
struct FeatureQueuedRunEditRecoveryTests {
    @MainActor
    @Test func retainedFileRemovedElsewhereReportsTheFileAndCanBeRemovedFromTheEdit() throws {
        let (execution, raw) = try fixture()
        var edit = FeatureQueuedRunEdit(entry: try #require(execution.queuedEntries.first))
        let originalMessage = try #require(raw["messages"]?.v2Array?.first)
        let changed = V2Fixture.patch(raw, [
            "messages": .array([V2Fixture.patch(originalMessage, ["attachments": .array([])])]),
        ])
        #expect(edit.isStillQueued(in: try FeatureThreadExecution(projection: changed)))
        do {
            try NativeFeatureClient.validateQueuedEdit(edit, control: changed)
            Issue.record("A removed retained attachment must be reported before upload.")
        } catch {
            #expect(error.localizedDescription.contains("retained.txt"))
            #expect(error.localizedDescription.contains("Remove them from this edit"))
            #expect(!error.localizedDescription.contains("no longer queued"))
        }
        edit.removeExistingAttachment(id: "retained")
        try NativeFeatureClient.validateQueuedEdit(edit, control: changed)
        let payload = try edit.replacementPayload(uploads: [], preparedAttachments: [])
        #expect(payload.attachments.isEmpty)
        #expect(try payload.context.decode(OrchestrationMessageContext.self).records.isEmpty)
    }

    @Test func queuedEntryRetainsContextAndReplacementRemapsNewUploads() throws {
        let (execution, _) = try fixture()
        var edit = FeatureQueuedRunEdit(entry: try #require(execution.queuedEntries.first))
        let retained = try #require(edit.existingAttachments.first)
        let mention = ComposerContextRecord(contextId: "path", label: "README", payload: .mention(.init(path: "README.md")))
        let added = FeatureDraftAttachment(data: Data([1, 2]), filename: "new.txt", mimeType: "text/plain")
        edit.draft.attachments = [added]
        edit.draft.context?.records.append(mention)
        edit.draft.text = ComposerContextReferences.ensureReferences(edit.draft.text, records: [mention])
        let upload = try UploadChatAttachment(id: added.id, data: added.data, name: added.filename, mimeType: added.mimeType)
        let payload = try edit.replacementPayload(uploads: [upload], preparedAttachments: [upload.uploadedJSONValue(id: "new-server-id")])
        #expect(payload.attachments.map { $0["id"]?.stringValue } == [retained.id, "new-server-id"])
        #expect(payload.attachments.first?["source"] == .object(["_tag": .string("pasted-text")]))
        let context = try payload.context.decode(OrchestrationMessageContext.self)
        #expect(context.records.contains { $0.attachment?.attachmentId == retained.id })
        #expect(context.records.contains { $0.attachment?.attachmentId == "new-server-id" })
        #expect(context.records.contains { $0.contextId == "path" })
        #expect(execution.allows(.replace(edit)))
    }

    @Test func removedFilesRemoveTheirReferencesAndAnEmptyContextReplacesServerContext() throws {
        let (execution, _) = try fixture()
        var edit = FeatureQueuedRunEdit(entry: try #require(execution.queuedEntries.first))
        edit.removeExistingAttachment(id: "retained")
        let payload = try edit.replacementPayload(uploads: [], preparedAttachments: [])
        #expect(payload.attachments.isEmpty)
        #expect(!payload.text.contains("t3-context:"))
        #expect(try payload.context.decode(OrchestrationMessageContext.self).records.isEmpty)
        edit.draft.text = " \n"
        #expect(!execution.allows(.replace(edit)))
    }

    @Test func inlineImageContextKeepsClientIdentityUntilCorePersistence() async throws {
        let (execution, _) = try fixture()
        var edit = FeatureQueuedRunEdit(entry: try #require(execution.queuedEntries.first))
        let attachment = FeatureDraftAttachment(data: Data([1]), filename: "image.png", mimeType: "image/png")
        edit.draft.attachments = [attachment]
        let upload = try UploadChatAttachment(id: attachment.id, data: attachment.data, name: attachment.filename, mimeType: attachment.mimeType)
        let payload = try edit.replacementPayload(uploads: [upload], preparedAttachments: [upload.jsonValue])
        let command = OrchestrationV2Commands.editQueuedRun(
            threadID: "thread", runID: edit.runID, text: payload.text, messageID: edit.messageID,
            attachments: payload.attachments, context: payload.context
        )
        let originalMessageID = edit.messageID
        let stored = try await OrchestrationV2Commands.prepareAttachments(command) { request in
            #expect(request.method == "assets.persistChatAttachments")
            #expect(request.payload["messageId"] == .string(originalMessageID))
            return .object(["attachments": .array([.object([
                "id": .string("persisted-image"), "type": .string("image"), "name": .string("image.png"),
                "mimeType": .string("image/png"), "sizeBytes": .number(1),
            ])])])
        }
        let context = try #require(stored["context"]).decode(OrchestrationMessageContext.self)
        #expect(context.records.contains { $0.attachment?.attachmentId == "persisted-image" })
        #expect(context.records.contains { $0.attachment?.attachmentId == "retained" })
    }

    @Test func startedElsewhereRejectsSaveAndRecoversIntoOccupiedComposerWithoutLosingContextOrFiles() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("drafts.json")
        let store = FeatureComposerDraftStore(fileURL: fileURL)
        let key = "environment:test:thread:queue"
        let (execution, raw) = try fixture()
        var edit = FeatureQueuedRunEdit(entry: try #require(execution.queuedEntries.first))
        let newFile = FeatureDraftAttachment(data: Data([1, 2]), filename: "new.txt", mimeType: "text/plain")
        edit.draft.attachments = [newFile]
        let normal = FeatureComposerDraft(text: "Keep my next prompt", selection: .init(providerID: "provider", modelID: "model"))
        try await store.setDraft(normal, for: key)
        try await store.saveQueuedRunEdit(edit, for: key)
        let reloaded = FeatureComposerDraftStore(fileURL: fileURL)
        #expect(try await reloaded.queuedRunEdit(for: key) == edit)
        #expect(try await reloaded.draft(for: key) == normal)
        let run = try #require(raw["runs"]?.v2Array?.first)
        let started = try FeatureThreadExecution(projection: V2Fixture.patch(raw, [
            "runs": .array([V2Fixture.patch(run, ["status": .string("running")])]),
        ]))
        #expect(!edit.isStillQueued(in: started))
        #expect(!started.allows(.replace(edit)))
        // Native recovery copies server files first and rebinds them to these local IDs.
        let retainedCopy = FeatureDraftAttachment(data: Data([3]), filename: "retained.txt", mimeType: "text/plain")
        var recovery = edit.draft
        recovery.attachments.insert(retainedCopy, at: 0)
        recovery.context = ComposerContextReferences.rebind(recovery.context, attachmentIDs: ["retained": retainedCopy.id.uuidString])
        let restored = try await reloaded.recoverQueuedRunEdit(edit, recovery: recovery, for: key)
        #expect(restored.text.hasPrefix(normal.text + "\n\n"))
        #expect(restored.attachments == [retainedCopy, newFile])
        #expect(restored.context?.records.first?.attachment?.attachmentId == retainedCopy.id.uuidString)
        #expect(restored.selection == normal.selection)
        #expect(try await reloaded.queuedRunEdit(for: key) == nil)
        #expect(try await reloaded.draft(for: key) == restored)
    }

    @Test func staleRecoveryCannotOverwriteANewerQueuedEdit() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(fileURL: directory.appendingPathComponent("drafts.json"))
        let (execution, _) = try fixture()
        let original = FeatureQueuedRunEdit(entry: try #require(execution.queuedEntries.first))
        var newer = original
        newer.draft.text = "Newer input"
        try await store.saveQueuedRunEdit(newer, for: "thread")
        await #expect(throws: FeatureThreadRecoveryError.self) {
            try await store.recoverQueuedRunEdit(original, recovery: original.draft, for: "thread")
        }
        #expect(try await store.queuedRunEdit(for: "thread") == newer)
        #expect(try await store.draft(for: "thread") == nil)
    }

    @Test(arguments: [false, true])
    func unreadableCurrentFileDoesNotConsumeTheSavedQueueEdit(invalidName: Bool) async throws {
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
        ]), for: "thread")
        let (execution, _) = try fixture()
        let edit = FeatureQueuedRunEdit(entry: try #require(execution.queuedEntries.first))
        try await store.saveQueuedRunEdit(edit, for: "thread")
        if !invalidName { try FileManager.default.removeItem(at: file.url) }
        let before = try Data(contentsOf: url)
        await #expect(throws: FeatureThreadRecoveryError.self) {
            try await store.recoverQueuedRunEdit(edit, recovery: edit.draft, for: "thread")
        }
        #expect(try Data(contentsOf: url) == before)
        #expect(try await store.queuedRunEdit(for: "thread") == edit)
    }

    private func fixture() throws -> (FeatureThreadExecution, JSONValue) {
        let base = try #require(V2Fixture.load("v2-thread-bounded-snapshot")["projection"])
        let originalRun = try #require(base["runs"]?.v2Array?.first)
        let messageID = try #require(originalRun["userMessageId"]?.stringValue)
        let record = ComposerContextRecord(contextId: "retained_context", label: "retained.txt", payload: .file(.init(
            attachmentId: "retained", name: "retained.txt", mimeType: "text/plain", sizeBytes: 1
        )))
        let raw = V2Fixture.patch(base, [
            "runs": .array([V2Fixture.patch(originalRun, ["status": .string("queued")])]),
            "messages": .array([.object([
                "id": .string(messageID), "text": .string("Edit this " + ComposerContextReferences.format(record)),
                "context": try JSONValue.encode(OrchestrationMessageContext(records: [record])),
                "attachments": .array([.object([
                    "id": .string("retained"), "name": .string("retained.txt"), "mimeType": .string("text/plain"),
                    "type": .string("file"), "sizeBytes": .number(1), "source": .object(["_tag": .string("pasted-text")]),
                ])]),
            ])]),
        ])
        return (try FeatureThreadExecution(projection: raw), raw)
    }
}
