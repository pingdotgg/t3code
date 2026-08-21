import Foundation
import Testing
import UniformTypeIdentifiers
@testable import T3Code

@Suite("Attachment preparation")
struct AttachmentPreparationTests {
    @Test
    func providerLoaderReadsImageDataRepresentation() async throws {
        let expected = Data([0x01, 0x02, 0x03])
        let provider = NSItemProvider(
            item: expected as NSData,
            typeIdentifier: UTType.jpeg.identifier
        )

        #expect(try await FeatureImageItemProviderLoader.data(from: provider) == expected)
    }

    @Test
    @MainActor
    func providerLoadCanStartBeforeItsDataIsAwaited() async throws {
        let expected = Data([0x01, 0x02, 0x03])
        let provider = NSItemProvider(
            item: expected as NSData,
            typeIdentifier: UTType.jpeg.identifier
        )

        let load = try FeatureImageItemProviderLoader.start(from: provider)

        #expect(try await load.data() == expected)
    }

    @Test
    func providerLoaderRejectsProvidersWithoutImageRepresentations() async {
        await #expect(throws: FeatureImageAttachmentError.self) {
            try await FeatureImageItemProviderLoader.data(from: NSItemProvider())
        }
    }

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
