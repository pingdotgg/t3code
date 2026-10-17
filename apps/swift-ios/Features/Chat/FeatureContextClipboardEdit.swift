import Foundation

@MainActor
enum FeatureContextClipboardEdit {
    struct Result {
        let text: String
        let context: OrchestrationMessageContext?
        let attachments: [FeatureDraftAttachment]
        let cursor: Int
    }

    static func unlinkedAttachmentIDs(
        context: OrchestrationMessageContext?, previousText: String, text: String
    ) -> Set<String> {
        let previous = ComposerContextReferences.referenced(context, text: previousText)?.records ?? []
        let remaining = ComposerContextReferences.referenced(context, text: text)?.records ?? []
        let liveIDs = Set(remaining.compactMap { $0.attachment?.attachmentId.lowercased() })
        return Set(previous.compactMap { $0.attachment?.attachmentId.lowercased() }).subtracting(liveIDs)
    }

    static func apply(
        text: String, selection: NSRange, context: OrchestrationMessageContext?,
        attachments: [FeatureDraftAttachment], imported: FeatureContextClipboardImporter.Result
    ) throws -> Result {
        guard selection.location != NSNotFound, selection.location >= 0,
              selection.length >= 0, selection.location <= text.utf16.count,
              selection.length <= text.utf16.count - selection.location else {
            throw ComposerContextClipboardError.draftChanged
        }
        let remainingText = (text as NSString).replacingCharacters(in: selection, with: "")
        let updatedText = (text as NSString).replacingCharacters(in: selection, with: imported.text)
        guard updatedText.utf16.count <= FeaturePastedText.maximumInputCharacters else {
            throw ComposerContextClipboardError.tooLarge
        }
        let remainingContext = ComposerContextReferences.referenced(context, text: remainingText)
        let merged = try FeatureComposerContext.merge(remainingContext, imported.context)
        if let merged {
            let encoded = try JSONEncoder.t3.encode(merged)
            guard String(decoding: encoded, as: UTF8.self).utf16.count <= ComposerContextClipboard.maximumCharacters else {
                throw ComposerContextClipboardError.tooLarge
            }
        }
        let removedIDs = unlinkedAttachmentIDs(context: context, previousText: text, text: remainingText)
        let updatedAttachments = attachments.filter { !removedIDs.contains($0.id.uuidString.lowercased()) } + imported.attachments
        guard updatedAttachments.count <= FeatureImageAttachmentLimits.maximumCount else {
            throw FileAttachmentError.tooMany(maximum: FeatureImageAttachmentLimits.maximumCount)
        }
        return Result(text: updatedText, context: merged, attachments: updatedAttachments,
                      cursor: selection.location + imported.text.utf16.count)
    }
}
