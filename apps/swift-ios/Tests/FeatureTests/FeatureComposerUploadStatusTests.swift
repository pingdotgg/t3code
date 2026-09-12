import Foundation
import Testing
@testable import T3Code

@Suite("Composer upload status")
struct FeatureComposerUploadStatusTests {
    @Test func anAttachmentWithoutAnUploadJobIsPreparingNotUploading() {
        let status = FeatureComposerUploadStatus(states: [
            (UUID(), nil),
            (UUID(), .queued),
        ])
        #expect(status.preparingCount == 2)
        #expect(status.uploadingCount == 0)
        #expect(status.blocksSend)
    }

    @Test func mixedBatchKeepsPendingTransfersAndFailuresVisible() {
        let failedID = UUID()
        let status = FeatureComposerUploadStatus(states: [
            (UUID(), .ready(nil)),
            (UUID(), .uploading),
            (failedID, .failed("The server did not respond.")),
        ])
        #expect(status.preparingCount == 0)
        #expect(status.uploadingCount == 1)
        #expect(status.failures.first?.0 == failedID)
        #expect(status.failures.first?.1 == "The server did not respond.")
        #expect(status.blocksSend)
    }

    @Test func readyAndInlineAttachmentsDoNotBlockSending() {
        let status = FeatureComposerUploadStatus(states: [
            (UUID(), .ready(nil)),
            (UUID(), .ready(.init(environmentID: "one", attachmentID: "image"))),
        ])
        #expect(!status.blocksSend)
        #expect(!FeatureComposerUploadStatus(states: []).blocksSend)
    }
}
