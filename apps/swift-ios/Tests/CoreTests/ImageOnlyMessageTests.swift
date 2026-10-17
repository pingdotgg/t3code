import Foundation
import Testing
@testable import T3Code

@Suite("Image-only message serialization")
struct ImageOnlyMessageTests {
    private let image = ComposerContextRecord(
        contextId: "image-1", label: "Screenshot",
        payload: .image(.init(attachmentId: "uploaded-1", name: "screen.png", mimeType: "image/png", sizeBytes: 12))
    )

    @Test
    func imageOnlyPromptKeepsTheImageBinding() {
        let result = T3Client.prepareMessageContext(
            text: ComposerContextReferences.format(image), context: .init(records: [image]),
            attachments: [], uploadedAttachments: nil, supportsContext: true
        )
        #expect(result.text == "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]")
        #expect(result.context?.records == [image])
    }

    @Test
    func proseBesideAnImageIsUnchanged() {
        let text = "What is this? " + ComposerContextReferences.format(image)
        let result = T3Client.prepareMessageContext(
            text: text, context: .init(records: [image]),
            attachments: [], uploadedAttachments: nil, supportsContext: true
        )
        #expect(result.text == text)
        #expect(result.context?.records == [image])
    }

    @Test
    func fileReferenceIsNotAnImageOnlyMessage() {
        let file = ComposerContextRecord(
            contextId: "file-1", label: "Notes",
            payload: .file(.init(attachmentId: "uploaded-2", name: "notes.txt", mimeType: "text/plain", sizeBytes: 12))
        )
        let text = ComposerContextReferences.format(file)
        let result = T3Client.prepareMessageContext(
            text: text, context: .init(records: [file]),
            attachments: [], uploadedAttachments: nil, supportsContext: true
        )
        #expect(result.text == text)
        #expect(result.context?.records == [file])
    }
}
