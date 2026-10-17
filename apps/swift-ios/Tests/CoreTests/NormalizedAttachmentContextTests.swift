import Foundation
import Testing
@testable import T3Code

@Suite("Normalized attachment context metadata")
struct NormalizedAttachmentContextTests {
    @Test func existingImageRecordGetsUploadMetadataBeforeServerIDRebind() throws {
        let upload = try UploadChatAttachment(data: Data([1, 2, 3]), name: "resized.jpg", mimeType: "image/jpeg")
        let record = imageRecord(attachmentID: upload.id.uuidString)
        let text = "Inspect " + ComposerContextReferences.format(record)
        let result = T3Client.prepareMessageContext(
            text: text, context: .init(records: [record]), attachments: [upload],
            uploadedAttachments: [upload.uploadedJSONValue(id: "new-server-id")], supportsContext: true
        )
        let updated = try #require(result.context?.records.first)

        #expect(result.text == text)
        #expect(result.context?.records.count == 1)
        #expect(updated.contextId == record.contextId)
        #expect(updated.label == record.label)
        #expect(updated.attachment == .init(
            attachmentId: "new-server-id", name: upload.name, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes
        ))
    }

    @Test func imageOnlyBootstrapRetainsNormalizedBinding() throws {
        let upload = try UploadChatAttachment(data: Data([1, 2, 3]), name: "resized.jpg", mimeType: "image/jpeg")
        let record = imageRecord(attachmentID: upload.id.uuidString)
        let result = T3Client.prepareMessageContext(
            text: ComposerContextReferences.format(record), context: .init(records: [record]),
            attachments: [upload], uploadedAttachments: [upload.uploadedJSONValue(id: "new-server-id")],
            supportsContext: true
        )
        let updated = try #require(result.context?.records.first)

        #expect(result.text == "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]")
        #expect(result.context?.records.count == 1)
        #expect(updated.contextId == record.contextId)
        #expect(updated.attachment?.attachmentId == "new-server-id")
        #expect(updated.attachment?.mimeType == "image/jpeg")
        #expect(updated.attachment?.sizeBytes == 3)
    }

    @Test func legacyProjectionUsesNormalizedMetadataAndKeepsContextIdentity() throws {
        let upload = try UploadChatAttachment(data: Data([1, 2, 3]), name: "resized.jpg", mimeType: "image/jpeg")
        let record = imageRecord(attachmentID: upload.id.uuidString)
        let result = T3Client.prepareMessageContext(
            text: "Inspect " + ComposerContextReferences.format(record), context: .init(records: [record]),
            attachments: [upload], uploadedAttachments: [upload.uploadedJSONValue(id: "new-server-id")],
            supportsContext: false
        )

        #expect(result.context == nil)
        #expect(result.text.contains("ref=\(record.contextId)"))
        #expect(result.text.contains("name: resized.jpg"))
        #expect(result.text.contains("mimeType: image/jpeg"))
        #expect(result.text.contains("sizeBytes: 3"))
        #expect(result.text.contains("attachmentId: new-server-id"))
    }

    private func imageRecord(attachmentID: String) -> ComposerContextRecord {
        ComposerContextRecord(
            contextId: "image-context", label: "Original screenshot",
            payload: .image(.init(attachmentId: attachmentID, name: "original.png", mimeType: "image/png", sizeBytes: 999))
        )
    }
}
