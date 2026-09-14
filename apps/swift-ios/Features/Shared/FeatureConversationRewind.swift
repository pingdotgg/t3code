import Foundation

public struct FeatureRevertedMessage: Sendable {
    public let message: FeatureMessage
    public let attachments: [FeatureDraftAttachment]

    public init(message: FeatureMessage, attachments: [FeatureDraftAttachment]) {
        self.message = message
        self.attachments = attachments
    }
}

struct FeatureConversationRewindError: LocalizedError {
    let message: String
    var didNotRevert = false
    var errorDescription: String? { message }
}

enum FeatureConversationRewind {
    static func canStart(in detail: FeatureThreadDetail) -> Bool {
        switch detail.thread.state {
        case .idle, .completed, .failed:
            detail.isCompacting != true && !detail.backgroundWorkIsActive
                && detail.approvals.isEmpty && detail.userInputs.isEmpty
        default:
            false
        }
    }

    /// Append recovered input without changing the current model or workspace.
    static func recover(_ reverted: FeatureRevertedMessage, draft: FeatureComposerDraft) throws -> FeatureComposerDraft {
        let original = reverted.message.text
        let prompt = !reverted.attachments.isEmpty
            && original == "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]"
            ? "" : original
        // Copies keep the original attachment order but receive fresh local IDs.
        // Keep the context links stable and point their records at those copies.
        let attachmentIDs = Dictionary(zip(reverted.message.attachments, reverted.attachments).map { original, copy in
            (original.id, copy.id.uuidString)
        }, uniquingKeysWith: { first, _ in first })
        let context = ComposerContextReferences.rebind(reverted.message.context, attachmentIDs: attachmentIDs)
        return try merge(
            recovery: FeatureComposerDraft(text: prompt, attachments: reverted.attachments, context: context),
            into: draft
        )
    }

    static func merge(recovery: FeatureComposerDraft, into draft: FeatureComposerDraft) throws -> FeatureComposerDraft {
        var recovered = draft
        if !recovery.text.isEmpty {
            recovered.text = draft.text.isEmpty ? recovery.text : draft.text + "\n\n" + recovery.text
        }
        recovered.attachments.append(contentsOf: recovery.attachments)
        recovered.context = try FeatureComposerContext.merge(draft.context, recovery.context)
        return recovered
    }
}
