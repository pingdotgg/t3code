import Foundation

extension NativeFeatureClient: FeatureThreadRecoveryClient {
    func updateThreadRecovery(threadID: String, action: FeatureThreadRecoveryAction) async throws {
        let route = try await v2ActionContext(threadID: threadID)
        // Do not trust the row that opened the action. Another device can have retried it.
        let snapshot = try await route.client.fullThreadSnapshot(id: route.wireID)
        guard let control = snapshot.thread.orchestrationV2Control else {
            throw FeatureCapabilityUnavailable("Thread recovery")
        }
        let execution = try FeatureThreadExecution(projection: control)
        guard execution.canManageQueue else { throw FeatureCapabilityUnavailable("Thread recovery") }
        let command: JSONValue
        switch action {
        case let .retryWorkspacePreparation(runID):
            guard execution.canRetryWorkspacePreparation(runID: runID) else {
                throw FeatureThreadRecoveryError("This run no longer has failed workspace setup. Refresh the thread.")
            }
            command = OrchestrationV2Commands.retryWorkspacePreparation(threadID: route.wireID, runID: runID)
        case let .setUsageLimit(runID, resetAt, choice, enabled):
            guard let recovery = FeatureThreadRecovery(thread: snapshot.thread)?.usageLimit,
                  recovery.runID == runID, recovery.resetAt == resetAt else {
                throw FeatureThreadRecoveryError("The usage limit changed. Refresh the thread before changing recovery.")
            }
            command = try OrchestrationV2Commands.updateMetadata(threadID: route.wireID, fields: [
                "limitRecovery": recovery.metadataUpdate(choice: choice, enabled: enabled),
            ])
        }
        _ = try await route.client.dispatch(command)
    }

    func queuedRunEditRecoveryDraft(threadID: String, edit: FeatureQueuedRunEdit) async throws -> FeatureComposerDraft {
        _ = try await v2ActionContext(threadID: threadID)
        let fileStore = ManagedAttachmentFileStore()
        var copies: [FeatureDraftAttachment] = []
        var completed = false
        defer {
            if !completed {
                for copy in copies {
                    if let file = copy.ownedFile { try? fileStore.removeOwnedFile(fileName: file.fileName) }
                }
            }
        }
        for attachment in edit.existingAttachments {
            try Task.checkCancellation()
            let source = attachment.source.flatMap { try? $0.decode(PastedTextAttachmentSource.self) }
            let url = try await attachmentAssetURL(threadID: threadID, attachment: FeatureMessageAttachment(
                id: attachment.id, name: attachment.name, mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes, source: source
            ))
            let (temporaryURL, response) = try await URLSession.shared.download(from: url)
            defer { try? FileManager.default.removeItem(at: temporaryURL) }
            guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
                throw FeatureThreadRecoveryError("Could not recover \(attachment.name). The queued edit is still saved.")
            }
            let id = UUID()
            let file = try await Task.detached {
                try fileStore.copyOwnedFile(from: temporaryURL, attachmentID: id, originalFileName: attachment.name)
            }.value
            copies.append(FeatureDraftAttachment(id: id, ownedFile: file, filename: attachment.name,
                                                  mimeType: attachment.mimeType, source: source))
        }
        var recovered = edit.draft
        recovered.attachments = copies + recovered.attachments
        recovered.context = ComposerContextReferences.rebind(recovered.context, attachmentIDs: Dictionary(
            zip(edit.existingAttachments, copies).map { ($0.id, $1.id.uuidString) },
            uniquingKeysWith: { first, _ in first }
        ))
        completed = true
        return recovered
    }
}
