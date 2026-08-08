import Foundation
import Testing
import UniformTypeIdentifiers
import UIKit
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
    func pasteQueuePreservesRequestOrder() async {
        let lifecycle = FeatureAttachmentLifecycle(contextID: "draft-a")
        let queue = FeatureComposerPasteQueue(lifecycle: lifecycle)
        let token = lifecycle.token(for: "draft-a")!
        let gate = AttachmentTestGate()
        var committed: [Int] = []

        queue.enqueue(token: token) {
            await gate.wait()
            committed.append(1)
        }
        queue.enqueue(token: token) {
            committed.append(2)
        }

        await gate.open()
        await queue.waitForAll()
        #expect(committed == [1, 2])
    }

    @Test
    @MainActor
    func pasteQueueCannotCommitAfterContextTransition() async {
        let lifecycle = FeatureAttachmentLifecycle(contextID: "draft-a")
        let queue = FeatureComposerPasteQueue(lifecycle: lifecycle)
        let oldToken = lifecycle.token(for: "draft-a")!
        let started = AttachmentTestGate()
        let gate = AttachmentTestGate()
        var didCommit = false

        let task = queue.enqueue(token: oldToken) {
            await started.open()
            await gate.wait()
            guard !Task.isCancelled else { return }
            didCommit = true
        }

        await started.wait()
        lifecycle.transition(to: "draft-b")
        queue.cancelAll()
        await gate.open()
        await task?.value

        #expect(!didCommit)
        #expect(queue.enqueue(token: oldToken) {} == nil)
    }

    @Test
    @MainActor
    func attachmentTasksCannotCommitAfterContextTransition() async {
        let lifecycle = FeatureAttachmentLifecycle(contextID: "draft-a")
        let taskStore = FeatureAttachmentTaskStore(lifecycle: lifecycle)
        let oldToken = lifecycle.token(for: "draft-a")!
        let started = AttachmentTestGate()
        let gate = AttachmentTestGate()
        var didCommit = false

        let task = taskStore.start(lifecycleToken: oldToken) { token in
            await started.open()
            await gate.wait()
            guard taskStore.isActive(token) else { return }
            didCommit = true
        }

        await started.wait()
        lifecycle.transition(to: "draft-b")
        taskStore.cancelAll()
        await gate.open()
        await task?.value

        #expect(!didCommit)
        #expect(taskStore.start(lifecycleToken: oldToken) { _ in } == nil)

        let currentToken = lifecycle.token(for: "draft-b")!
        let currentTask = taskStore.start(lifecycleToken: currentToken) { _ in
            didCommit = true
        }
        await currentTask?.value
        #expect(didCommit)
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
    func cancellingPreparationClearsEveryReservation() {
        var state = FeatureAttachmentPreparationState()
        _ = state.reserve(itemCount: 3, attachments: [])
        _ = state.reserve(itemCount: 2, attachments: [])

        state.cancelAll()

        #expect(!state.isPreparing)
        #expect(state.pendingItemCount == 0)
    }

    @Test
    func preparedAttachmentsRebaseAfterDraftRestoration() {
        let restored = FeatureDraftAttachment(
            data: Data([1]),
            filename: "Image 1.jpg",
            mimeType: "image/jpeg"
        )
        let prepared = [
            FeatureDraftAttachment(
                data: Data([2]),
                filename: "Image 1.jpg",
                mimeType: "image/jpeg"
            ),
            FeatureDraftAttachment(
                data: Data([3]),
                filename: "Image 2.jpg",
                mimeType: "image/jpeg"
            ),
        ]

        let accepted = FeatureImageAttachmentPolicy.attachmentsToAppend(
            prepared,
            to: [restored]
        )

        #expect(accepted.map(\.filename) == ["Image 2.jpg", "Image 3.jpg"])
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

        #expect(try await FeatureImagePasteLoader.data(from: provider) == expected)
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
    func photoLibraryItemLoadsItsConcreteImageRepresentation() async throws {
        let expected = Data([0x89, 0x50, 0x4E, 0x47])
        let provider = NSItemProvider()
        provider.registerDataRepresentation(
            forTypeIdentifier: UTType.png.identifier,
            visibility: .all
        ) { completion in
            completion(expected, nil)
            return nil
        }

        let loaded = try await FeaturePhotoLibraryItem(provider: provider).loadData()

        #expect(loaded == expected)
    }

    @Test
    func photoLibraryItemRejectsProvidersWithoutAnImage() async {
        let provider = NSItemProvider(
            item: "not an image" as NSString,
            typeIdentifier: UTType.plainText.identifier
        )

        do {
            _ = try await FeaturePhotoLibraryItem(provider: provider).loadData()
            Issue.record("Expected a non-image provider to be rejected")
        } catch FeatureImageAttachmentError.invalidImage {
            // Expected.
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }
}

private actor AttachmentTestGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func open() {
        isOpen = true
        let pending = waiters
        waiters.removeAll()
        for continuation in pending {
            continuation.resume()
        }
    }
}
