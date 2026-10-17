import Foundation

/// The server message and the composer's new files have separate ownership.
/// Bind the normal composer to `draft` while this edit is open.
public struct FeatureQueuedRunEdit: Sendable, Equatable {
    public let runID: String
    public let messageID: String
    public var existingAttachments: [FeatureThreadExecution.Attachment]
    public var draft: FeatureComposerDraft

    public init(entry: FeatureThreadExecution.QueuedEntry) {
        runID = entry.id
        messageID = entry.messageID
        existingAttachments = entry.attachments
        draft = FeatureComposerDraft(text: entry.text, context: entry.context)
    }

    public var validationMessage: String? {
        if draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Add a message before saving the queued edit."
        }
        if existingAttachments.count + draft.attachments.count > UploadChatAttachment.maximumCount {
            return "A message can include up to 100 attachments."
        }
        return nil
    }

    public func isStillQueued(in execution: FeatureThreadExecution) -> Bool {
        execution.queuedEntries.contains { $0.id == runID && $0.messageID == messageID }
    }

    public mutating func removeExistingAttachment(id: String) {
        existingAttachments.removeAll { $0.id == id }
        let removed = Set((draft.context?.records ?? []).filter { $0.attachment?.attachmentId == id }.map(\.contextId))
        let original = draft.text as NSString
        draft.text = ComposerContextReferences.replace(draft.text) {
            removed.contains($0.contextId) ? "" : original.substring(with: $0.range)
        }
        draft.context?.records.removeAll { removed.contains($0.contextId) }
    }

    /// Rebind new uploads and remove context for files removed during the edit.
    /// An empty context is intentional: omission would preserve stale server context.
    func replacementPayload(
        uploads: [UploadChatAttachment], preparedAttachments: [JSONValue]
    ) throws -> (text: String, attachments: [JSONValue], context: JSONValue) {
        let prepared = T3Client.prepareMessageContext(
            text: draft.text.trimmingCharacters(in: .whitespacesAndNewlines),
            context: draft.context, attachments: uploads,
            uploadedAttachments: preparedAttachments, supportsContext: true
        )
        let attachments = existingAttachments.map(\.wireValue) + preparedAttachments
        let liveIDs = Set(attachments.compactMap { $0["id"]?.stringValue })
        let records = (prepared.context?.records ?? []).filter {
            guard let attachment = $0.attachment else { return true }
            return liveIDs.contains(attachment.attachmentId)
        }
        let context = OrchestrationMessageContext(records: records)
        return (prepared.text, attachments, try JSONValue.encode(context))
    }

    private struct SavedMessage: Codable {
        let runID: String
        let messageID: String
        let existingAttachments: [FeatureThreadExecution.Attachment]
        let text: String
    }

    func savedDraft() throws -> FeatureComposerDraft {
        var saved = draft
        let message = SavedMessage(runID: runID, messageID: messageID,
                                   existingAttachments: existingAttachments, text: draft.text)
        saved.text = String(decoding: try JSONEncoder().encode(message), as: UTF8.self)
        return saved
    }

    init(savedDraft: FeatureComposerDraft) throws {
        let saved = try JSONDecoder().decode(SavedMessage.self, from: Data(savedDraft.text.utf8))
        runID = saved.runID
        messageID = saved.messageID
        existingAttachments = saved.existingAttachments
        draft = savedDraft
        draft.text = saved.text
    }
}

public extension FeatureComposerDraftStore {
    /// One durable edit per thread. Keep the environment-scoped composer key intact.
    nonisolated static func queuedRunEditKey(for threadKey: String) -> String {
        "queued-run-edit:" + threadKey
    }

    func queuedRunEdit(for threadKey: String) throws -> FeatureQueuedRunEdit? {
        try draft(for: Self.queuedRunEditKey(for: threadKey)).map(FeatureQueuedRunEdit.init(savedDraft:))
    }

    /// Call before dispatch and on debounced composer changes, including attachment removal.
    func saveQueuedRunEdit(_ edit: FeatureQueuedRunEdit, for threadKey: String) throws {
        try setDraft(edit.savedDraft(), for: Self.queuedRunEditKey(for: threadKey))
    }

    func removeQueuedRunEdit(for threadKey: String) throws {
        try removeDraft(for: Self.queuedRunEditKey(for: threadKey))
    }

    /// Save the recovered content before leaving edit mode. Flush the visible
    /// normal draft before calling so newer input is included in the merge.
    func recoverQueuedRunEdit(
        _ edit: FeatureQueuedRunEdit, recovery: FeatureComposerDraft, for threadKey: String
    ) throws -> FeatureComposerDraft {
        try consumeQueuedRunEdit(edit, recovery: recovery, for: threadKey)
    }
}
