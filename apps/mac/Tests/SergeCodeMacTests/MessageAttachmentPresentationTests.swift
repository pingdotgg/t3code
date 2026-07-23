import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Message attachment timeline mapping")
struct MessageAttachmentPresentationTests {
    @Test func userMessagePreservesAttachmentsOnTimelineItem() {
        let attachment = MessageAttachment(
            id: "att-1", name: "shot.png", mimeType: "image/png", sizeBytes: 2048)
        let item = TimelineItem.userMessage(
            id: "msg-1", text: "see this", attachments: [attachment],
            at: Date(timeIntervalSince1970: 100))

        guard case .userMessage(let id, let text, let attachments, let at) = item else {
            Issue.record("Expected userMessage")
            return
        }
        #expect(id == "msg-1")
        #expect(text == "see this")
        #expect(attachments == [attachment])
        #expect(at.timeIntervalSince1970 == 100)
    }

    @Test func userMessageWithoutAttachmentsUsesEmptyArray() {
        let item = TimelineItem.userMessage(
            id: "msg-2", text: "plain", attachments: [], at: Date())
        guard case .userMessage(_, _, let attachments, _) = item else {
            Issue.record("Expected userMessage")
            return
        }
        #expect(attachments.isEmpty)
    }
}
