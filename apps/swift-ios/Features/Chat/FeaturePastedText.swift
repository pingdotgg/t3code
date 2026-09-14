import Foundation

enum FeaturePastedText {
    // Keep these limits in sync with client-runtime/textPaste.ts and contracts/orchestration.ts.
    static let attachmentThresholdBytes = 32 * 1024
    static let maximumInputCharacters = 120_000

    enum Disposition: Equatable {
        case inline
        case attachment
        case rejected
    }

    static func maximumAttachmentBytes(
        advertisedMaximum: Int?,
        attachmentCount: Int,
        pendingCount: Int
    ) -> Int? {
        guard let advertisedMaximum, advertisedMaximum > 0,
              attachmentCount + pendingCount < FeatureImageAttachmentLimits.maximumCount else {
            return nil
        }
        return min(advertisedMaximum, ManagedAttachmentFileStore.maximumBytes)
    }

    /// Input limits use UTF-16 offsets, as on web. Attachment limits use UTF-8 bytes.
    static func disposition(
        text: String,
        currentTextLength: Int,
        selection: NSRange,
        maximumAttachmentBytes: Int?,
        bypassAutoAttachment: Bool = false
    ) -> Disposition {
        guard !bypassAutoAttachment, !text.isEmpty else { return .inline }
        let start = min(max(0, selection.location), currentTextLength)
        let selectedLength = min(max(0, selection.length), currentTextLength - start)
        let wouldExceedInputLimit = currentTextLength - selectedLength + text.utf16.count
            > maximumInputCharacters
        let byteCount = text.utf8.count
        guard wouldExceedInputLimit || byteCount >= attachmentThresholdBytes else {
            return .inline
        }
        if let maximumAttachmentBytes, byteCount <= maximumAttachmentBytes {
            return .attachment
        }
        return wouldExceedInputLimit ? .rejected : .inline
    }

    static func nextFileName(existingNames: [String]) -> String {
        let names = Set(existingNames.map { $0.lowercased() })
        guard names.contains("pasted-text.txt") else { return "pasted-text.txt" }
        var sequence = 2
        while names.contains("pasted-text-\(sequence).txt") {
            sequence += 1
        }
        return "pasted-text-\(sequence).txt"
    }
}
