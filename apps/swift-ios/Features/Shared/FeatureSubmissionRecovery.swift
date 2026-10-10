import Foundation

/// A local draft, separate from the delivery queue. Keeping the original
/// submission also preserves modes and creation settings after a relaunch.
public struct FeatureSubmissionRecoveryDraft: Identifiable, Sendable, Equatable, Codable {
    public var id: String { submission.id }
    public let submission: FeatureQueuedSubmission
    public let reason: String?

    public init(submission: FeatureQueuedSubmission, reason: String?) {
        self.submission = submission
        self.reason = reason
    }

    public var threadID: String { submission.threadID }
    public var environmentID: String { submission.environmentID }
    public var projectID: String? { submission.creation?.projectID }
    public var isNewTask: Bool { submission.creation != nil }

    /// A new task uses the project's current logical draft route. The fallback
    /// keeps recovery reachable even when that project is no longer available.
    public func draftKey(in snapshot: FeatureSnapshot) -> String {
        if let creation = submission.creation {
            if let project = snapshot.projects.first(where: {
                $0.id == creation.projectID && $0.environmentID == environmentID
            }) {
                return FeatureComposerDraftStore.newTaskKey(project: project, in: snapshot)
            }
            return creation.draftKey
                ?? "environment:\(environmentID):new-task:\(creation.projectID)"
        }
        return "environment:\(environmentID):thread:\(submission.identity.threadID)"
    }

    public func composerDraft() throws -> FeatureComposerDraft {
        composerDraft(uploads: try submission.validatedUploads())
    }

    /// A recovery can retain the prompt even when a saved file is gone. Keep
    /// attachment references consistent and report every omitted file.
    func recoverableComposerDraft() -> FeatureSubmissionRecoveryResult {
        let uploads = submission.attachments.compactMap { try? $0.validatedUpload() }
        let retainedIDs = Set(uploads.map(\.id))
        let missing = submission.attachments.filter { !retainedIDs.contains($0.id) }
        var draft = composerDraft(uploads: uploads)
        let missingIDs = Set(missing.flatMap { attachment in
            [attachment.id.uuidString, attachment.uploadedReference?.attachmentID].compactMap { $0 }
        })
        let removedContextIDs = Set((draft.context?.records ?? []).filter {
            $0.attachment.map { missingIDs.contains($0.attachmentId) } == true
        }.map(\.contextId))
        let original = draft.text as NSString
        draft.text = ComposerContextReferences.replace(draft.text) {
            removedContextIDs.contains($0.contextId) ? "" : original.substring(with: $0.range)
        }
        draft.context?.records.removeAll { removedContextIDs.contains($0.contextId) }
        return FeatureSubmissionRecoveryResult(draft: draft, missingAttachments: missing.map(\.name))
    }

    private func composerDraft(uploads: [FeatureUploadAttachment]) -> FeatureComposerDraft {
        let attachments = uploads.map { upload in
            if let file = upload.ownedFile {
                return FeatureDraftAttachment(
                    id: upload.id, ownedFile: file, filename: upload.name,
                    mimeType: upload.mimeType, uploadedReference: upload.uploadedReference,
                    source: upload.source
                )
            }
            return FeatureDraftAttachment(
                id: upload.id, data: upload.data, filename: upload.name,
                mimeType: upload.mimeType, uploadedReference: upload.uploadedReference,
                source: upload.source
            )
        }
        return FeatureComposerDraft(
            text: submission.text,
            attachments: attachments,
            selection: submission.selection,
            workspace: submission.creation.map {
                FeatureComposerWorkspaceDraft(
                    mode: $0.workspaceMode, branch: $0.branch,
                    worktreePath: $0.worktreePath, startFromOrigin: $0.startFromOrigin
                )
            },
            context: submission.context,
            runtimeMode: submission.runtimeMode,
            interactionMode: submission.interactionMode
        )
    }
}

struct FeatureSubmissionRecoveryResult: Sendable {
    var draft: FeatureComposerDraft
    var missingAttachments: [String] = []

    var warning: String? {
        missingAttachments.isEmpty ? nil
            : "Restored the message without unreadable attachments: \(missingAttachments.joined(separator: ", ")). Add these files again before sending."
    }
}

public enum FeatureSubmissionRecoveryError: LocalizedError {
    case missingAttachment(String)

    public var errorDescription: String? {
        switch self {
        case let .missingAttachment(name):
            "The saved attachment \(name) could not be read. The recovery draft is kept."
        }
    }
}

extension FeatureComposerDraftStore {
    /// Reuses the durable import ledger so a crash after saving the composer,
    /// but before deleting its recovery record, cannot append the prompt twice.
    /// This method does not suspend between reading and writing the draft.
    func restoreSubmission(
        _ recovery: FeatureSubmissionRecoveryDraft,
        for key: String
    ) throws -> FeatureSubmissionRecoveryResult {
        try importRecoveredDraft(recovery,
            importID: "outbox-recovery:\(recovery.environmentID):\(recovery.id)", for: key)
    }
}

extension FeatureQueuedSubmission {
    /// Do not silently omit an attachment whose saved file is missing.
    func validatedUploads() throws -> [FeatureUploadAttachment] {
        try attachments.map { try $0.validatedUpload() }
    }
}

private extension FeatureQueuedAttachment {
    func validatedUpload() throws -> FeatureUploadAttachment {
        guard let upload else {
            throw FeatureSubmissionRecoveryError.missingAttachment(name)
        }
        if let file = upload.ownedFile {
            guard FileManager.default.isReadableFile(atPath: file.url.path),
                  let values = try? file.url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
                  values.isRegularFile == true, values.fileSize == file.byteCount else {
                throw FeatureSubmissionRecoveryError.missingAttachment(name)
            }
        }
        return upload
    }
}
