import Foundation
import ImageIO

enum NativeUploadAttachmentPreparation {
    /// Called from the upload boundary's detached task. Retained draft files stay unchanged.
    static func make(_ attachment: FeatureUploadAttachment) throws -> UploadChatAttachment {
        let reference = attachment.uploadedReference.map {
            UploadedAttachmentReference(environmentID: $0.environmentID, attachmentID: $0.attachmentID)
        }
        let mimeType = attachment.mimeType.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if mimeType.hasPrefix("image/") {
            let data = try attachment.ownedFile.map { try Data(contentsOf: $0.url) } ?? attachment.data
            if let source = CGImageSourceCreateWithData(data as CFData, [
                kCGImageSourceShouldCache: false,
            ] as CFDictionary),
               let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
               let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
               let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
               max(width.intValue, height.intValue) > 2_000 {
                let prepared = try FeatureImageProcessor.attachment(from: data, ordinal: 1)
                // Changed bytes must not reuse an older, oversized server upload.
                return try UploadChatAttachment(
                    id: attachment.id,
                    data: prepared.data,
                    name: (attachment.name as NSString).deletingPathExtension + ".jpg",
                    mimeType: prepared.mimeType,
                    contextSource: attachment.source
                )
            }
            return try UploadChatAttachment(
                id: attachment.id,
                data: data,
                name: attachment.name,
                mimeType: attachment.mimeType,
                uploadedReference: reference,
                contextSource: attachment.source
            )
        }
        if let ownedFile = attachment.ownedFile {
            return try UploadChatAttachment(
                id: attachment.id,
                fileURL: ownedFile.url,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: ownedFile.byteCount,
                uploadedReference: reference,
                contextSource: attachment.source
            )
        }
        return try UploadChatAttachment(
            id: attachment.id,
            data: attachment.data,
            name: attachment.name,
            mimeType: attachment.mimeType,
            uploadedReference: reference,
            contextSource: attachment.source
        )
    }
}
