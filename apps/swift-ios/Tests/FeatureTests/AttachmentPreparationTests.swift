import Foundation
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import T3Code

@Suite("Attachment preparation")
struct AttachmentPreparationTests {
    @Test
    func overlappingPreparationOnlyFinishesAfterEveryOperation() {
        var state = FeatureAttachmentPreparationState()
        let firstID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let secondID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        let first = state.begin(itemCount: 2, id: firstID)
        let second = state.begin(itemCount: 1, id: secondID)

        #expect(state.isPreparing)
        #expect(state.pendingItemCount == 3)
        #expect(state.statusLabel == "Preparing 3 images…")

        state.finish(first)

        #expect(state.isPreparing)
        #expect(state.pendingItemCount == 1)
        #expect(state.statusLabel == "Preparing image…")

        state.finish(second)

        #expect(!state.isPreparing)
        #expect(state.pendingItemCount == 0)
    }

    @Test
    func reservationsShareCapacityAcrossPendingOperations() {
        var state = FeatureAttachmentPreparationState()
        let first = state.reserve(itemCount: 6, attachments: [])
        let second = state.reserve(itemCount: 6, attachments: [])

        #expect(first?.count == 6)
        #expect(second?.count == 2)
        #expect(state.pendingItemCount == FeatureImageAttachmentPolicy.maximumCount)
        #expect(state.reserve(itemCount: 1, attachments: []) == nil)

        if let first {
            state.finish(first)
        }
        #expect(state.pendingItemCount == 2)

        let third = state.reserve(itemCount: 6, attachments: [])
        #expect(third?.count == 6)
    }

    @Test
    @MainActor
    func sameContextTransitionInvalidatesCapturedCallbacks() {
        let lifecycle = FeatureAttachmentLifecycle(contextID: "draft-a")
        let oldToken = lifecycle.token(for: "draft-a")!

        lifecycle.transition(to: "draft-a")

        #expect(!lifecycle.isCurrent(oldToken))
        #expect(lifecycle.token(for: "draft-a") != oldToken)
    }

    @Test
    func preparedAttachmentsRespectCapacityAfterDraftRestoration() {
        let existing = (1...7).map { ordinal in
            FeatureDraftAttachment(
                data: Data([UInt8(ordinal)]),
                filename: "Image \(ordinal).jpg",
                mimeType: "image/jpeg"
            )
        }
        let prepared = (1...3).map { ordinal in
            FeatureDraftAttachment(
                data: Data([UInt8(ordinal)]),
                filename: "Image \(ordinal).jpg",
                mimeType: "image/jpeg"
            )
        }

        let accepted = FeatureImageAttachmentPolicy.attachmentsToAppend(
            prepared,
            to: existing
        )

        #expect(accepted.count == 1)
        #expect(accepted.first?.filename == "Image 8.jpg")
    }

    @Test
    func pasteProviderLoaderReadsImageDataRepresentation() async throws {
        let expected = Data([0x01, 0x02, 0x03])
        let provider = NSItemProvider(
            item: expected as NSData,
            typeIdentifier: UTType.jpeg.identifier
        )

        #expect(try await FeatureImageItemProviderLoader.data(from: provider) == expected)
    }

    @Test
    @MainActor
    func pasteBatchKeepsValidImagesWhenAnotherProviderFails() async throws {
        let invalidProvider = NSItemProvider()
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
        let imageData = try #require(image.jpegData(compressionQuality: 1))
        let validProvider = NSItemProvider(
            item: imageData as NSData,
            typeIdentifier: UTType.jpeg.identifier
        )

        let result = try await FeatureImagePasteBatchLoader.prepare(
            providers: [invalidProvider, validProvider]
        )

        #expect(result.attachments.count == 1)
        #expect(result.failureMessage != nil)
    }

    @Test
    func textOnlySubmissionWaitsForSelectedImagePreparation() {
        var state = FeatureAttachmentPreparationState()
        let operation = state.begin(itemCount: 1)

        #expect(!FeatureComposerSubmissionEligibility.canSend(
            text: "Explain this screenshot",
            attachmentCount: 0,
            imagesAllowed: true,
            isSending: false,
            preparationState: state
        ))

        state.finish(operation)

        #expect(FeatureComposerSubmissionEligibility.canSend(
            text: "Explain this screenshot",
            attachmentCount: 1,
            imagesAllowed: true,
            isSending: false,
            preparationState: state
        ))
    }

    @Test
    func attachmentSubmissionStillRequiresImageCapableModel() {
        let state = FeatureAttachmentPreparationState()

        #expect(!FeatureComposerSubmissionEligibility.canSend(
            text: "",
            attachmentCount: 1,
            imagesAllowed: false,
            isSending: false,
            preparationState: state
        ))
        #expect(FeatureComposerSubmissionEligibility.canSend(
            text: "Text still works",
            attachmentCount: 0,
            imagesAllowed: false,
            isSending: false,
            preparationState: state
        ))
    }

    @Test
    func attachmentPickerKeepsExistingThreadComposerMountedWhenFocusResigns() {
        #expect(!FeatureComposerCollapsePolicy.shouldCollapse(
            isFocused: false,
            textIsEmpty: true,
            attachmentsAreEmpty: true,
            isAttachmentFlowActive: true,
            isPreparingAttachments: false
        ))

        #expect(FeatureComposerCollapsePolicy.shouldCollapse(
            isFocused: false,
            textIsEmpty: true,
            attachmentsAreEmpty: true,
            isAttachmentFlowActive: false,
            isPreparingAttachments: false
        ))
    }
}
