import Foundation
import Testing
import UIKit
@testable import T3Code

@Suite("Native upload image normalization")
struct NativeUploadAttachmentPreparationTests {
    @Test @MainActor func restoredOversizedImageKeepsItsIDAndRequiresFreshUpload() async throws {
        let data = try imageData(size: CGSize(width: 2_400, height: 1_200))
        let attachment = FeatureUploadAttachment(
            data: data, name: "restored.png", mimeType: " IMAGE/PNG ",
            uploadedReference: .init(environmentID: "environment", attachmentID: "old-upload")
        )
        let upload = try await Task.detached {
            try NativeUploadAttachmentPreparation.make(attachment)
        }.value
        let encoded = try imageBytes(upload)
        let image = try #require(UIImage(data: encoded)?.cgImage)

        #expect(upload.id == attachment.id)
        #expect(upload.name == "restored.jpg")
        #expect(upload.mimeType == "image/jpeg")
        #expect(upload.sizeBytes == encoded.count)
        #expect(upload.uploadedReference == nil)
        #expect(image.width == 2_000)
        #expect(image.height == 1_000)
        #expect(attachment.data == data)
    }

    @Test @MainActor func oversizedSharedFileIsResizedWithoutRewritingFile() async throws {
        let data = try imageData(size: CGSize(width: 1_200, height: 2_400))
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        try data.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let attachment = FeatureUploadAttachment(
            ownedFile: .init(fileName: url.lastPathComponent, url: url, byteCount: data.count),
            name: "shared.png", mimeType: "image/png"
        )
        let upload = try await Task.detached {
            try NativeUploadAttachmentPreparation.make(attachment)
        }.value
        let encoded = try imageBytes(upload)
        let image = try #require(UIImage(data: encoded)?.cgImage)

        #expect(upload.id == attachment.id)
        #expect(upload.sizeBytes == encoded.count)
        #expect(image.width == 1_000)
        #expect(image.height == 2_000)
        #expect(try Data(contentsOf: url) == data)
    }

    @Test @MainActor func fittingImagesKeepExactBytesAndUploadedReference() async throws {
        let original = try imageData(size: CGSize(width: 2_000, height: 1_000))
        let normalized = try FeatureImageProcessor.attachment(from: original, ordinal: 1).data
        for (data, mimeType, name) in [(original, "image/png", "fits.png"), (normalized, "image/jpeg", "fits.jpg")] {
            let attachment = FeatureUploadAttachment(
                data: data, name: name, mimeType: mimeType,
                uploadedReference: .init(environmentID: "environment", attachmentID: "existing-upload")
            )
            let upload = try await Task.detached {
                try NativeUploadAttachmentPreparation.make(attachment)
            }.value

            #expect(try imageBytes(upload) == data)
            #expect(upload.id == attachment.id)
            #expect(upload.name == attachment.name)
            #expect(upload.mimeType == attachment.mimeType)
            #expect(upload.sizeBytes == data.count)
            #expect(upload.uploadedReference == .init(environmentID: "environment", attachmentID: "existing-upload"))
        }
    }

    @Test func nonImageFilesKeepFileSourceAndContextOrigin() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".txt")
        let attachment = FeatureUploadAttachment(
            ownedFile: .init(fileName: url.lastPathComponent, url: url, byteCount: 123),
            name: "pasted.txt", mimeType: "text/plain",
            uploadedReference: .init(environmentID: "environment", attachmentID: "existing-upload"),
            source: .pastedText
        )
        let upload = try NativeUploadAttachmentPreparation.make(attachment)

        #expect(upload.id == attachment.id)
        #expect(upload.source == .file(url))
        #expect(upload.sizeBytes == 123)
        #expect(upload.contextSource == .pastedText)
        #expect(upload.uploadedReference == .init(environmentID: "environment", attachmentID: "existing-upload"))
    }

    private func imageBytes(_ upload: UploadChatAttachment) throws -> Data {
        guard case let .imageData(data) = upload.source else {
            throw ImageAttachmentError.invalidMIMEType
        }
        return data
    }

    @MainActor private func imageData(size: CGSize) throws -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            context.cgContext.setFillColor(UIColor.red.cgColor)
            context.cgContext.fill(CGRect(origin: .zero, size: size))
        }
        return try #require(image.pngData())
    }
}
