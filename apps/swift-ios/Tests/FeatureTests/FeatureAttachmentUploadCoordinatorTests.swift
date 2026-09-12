import Foundation
import Observation
import Testing
@testable import T3Code

@Suite("Attachment pre-upload coordinator")
@MainActor
struct FeatureAttachmentUploadCoordinatorTests {
    @Test func canceledTransferKeepsConcurrencySlotUntilItReturns() async throws {
        let uploads = CoordinatorUploadHarness()
        let coordinator = makeCoordinator(limit: 3, uploads: uploads)
        let attachments = (0..<4).map { attachment(byte: UInt8($0)) }
        coordinator.syncOwner(draftKey: "draft", environmentID: "one", attachments: attachments)
        let started = [await uploads.nextStart(), await uploads.nextStart(), await uploads.nextStart()]
        let canceledID = started[0]

        coordinator.syncOwner(
            draftKey: "draft",
            environmentID: "one",
            attachments: attachments.filter { $0.id != canceledID }
        )
        #expect(uploads.startCount == 3)
        #expect(uploads.maximumActive == 3)

        uploads.complete(canceledID, environmentID: "one")
        _ = await uploads.nextStart()
        #expect(uploads.maximumActive == 3)
        uploads.completeAll()
    }

    @Test func removedAndReaddedUUIDRejectsLateOldResult() async throws {
        let uploads = CoordinatorUploadHarness()
        let coordinator = makeCoordinator(limit: 2, uploads: uploads)
        let id = UUID()
        let old = attachment(id: id, byte: 1)
        let replacement = attachment(id: id, byte: 2)
        coordinator.syncOwner(draftKey: "draft", environmentID: "one", attachments: [old])
        _ = await uploads.nextStart()
        coordinator.syncOwner(draftKey: "draft", environmentID: "one", attachments: [])
        coordinator.syncOwner(draftKey: "draft", environmentID: "one", attachments: [replacement])
        _ = await uploads.nextStart()

        uploads.complete(id, environmentID: "one", attachmentID: "old")
        #expect(coordinator.state(environmentID: "one", attachmentID: id) == .uploading)

        uploads.complete(id, environmentID: "one", attachmentID: "new")
        await waitUntilObserved {
            coordinator.state(environmentID: "one", attachmentID: id)
                == .ready(.init(environmentID: "one", attachmentID: "new"))
        }
    }

    @Test func environmentSwitchDuringPersistenceCannotPublishOldReference() async throws {
        let uploads = CoordinatorUploadHarness()
        let persistence = CoordinatorPersistenceHarness(suspended: true)
        let coordinator = FeatureAttachmentUploadCoordinator(
            upload: uploads.upload,
            persist: persistence.persist
        )
        let value = attachment(byte: 1)
        coordinator.syncOwner(draftKey: "draft", environmentID: "one", attachments: [value])
        _ = await uploads.nextStart()
        uploads.complete(value.id, environmentID: "one")
        await persistence.nextCall()

        coordinator.syncOwner(draftKey: "draft", environmentID: "two", attachments: [value])
        persistence.resume(result: true)
        _ = await uploads.nextStart()
        #expect(coordinator.state(environmentID: "one", attachmentID: value.id) == nil)
        #expect(coordinator.state(environmentID: "two", attachmentID: value.id) == .uploading)
        uploads.completeAll()
    }

    @Test func persistenceFailureBlocksReadyAndRetryCanSucceed() async throws {
        let uploads = CoordinatorUploadHarness()
        let persistence = CoordinatorPersistenceHarness(error: TestFailure.disk)
        let coordinator = FeatureAttachmentUploadCoordinator(
            upload: uploads.upload,
            persist: persistence.persist
        )
        let value = attachment(byte: 1)
        coordinator.syncOwner(draftKey: "draft", environmentID: "one", attachments: [value])
        _ = await uploads.nextStart()
        uploads.complete(value.id, environmentID: "one")
        await waitUntilObserved {
            if case .failed = coordinator.state(environmentID: "one", attachmentID: value.id) {
                return true
            }
            return false
        }

        persistence.error = nil
        coordinator.retry(environmentID: "one", attachmentID: value.id)
        _ = await uploads.nextStart()
        uploads.complete(value.id, environmentID: "one", attachmentID: "retry")
        await waitUntilObserved {
            coordinator.state(environmentID: "one", attachmentID: value.id)
                == .ready(.init(environmentID: "one", attachmentID: "retry"))
        }
    }

    @Test func rejectedCompareAndSetDoesNotStayUploading() async throws {
        let uploads = CoordinatorUploadHarness()
        let coordinator = FeatureAttachmentUploadCoordinator(
            upload: uploads.upload,
            persist: { _, _, _ in false }
        )
        let value = attachment(byte: 1)
        coordinator.syncOwner(draftKey: "draft", environmentID: "one", attachments: [value])
        _ = await uploads.nextStart()
        uploads.complete(value.id, environmentID: "one")

        await waitUntilObserved {
            if case .failed = coordinator.state(environmentID: "one", attachmentID: value.id) {
                return true
            }
            return false
        }
    }

    @Test func timeoutShowsRetryWithoutReleasingAnActiveTransferSlot() async throws {
        let uploads = CoordinatorUploadHarness()
        let persistence = CoordinatorPersistenceHarness()
        let deadlines = CoordinatorDeadlineHarness()
        let coordinator = FeatureAttachmentUploadCoordinator(
            maximumConcurrentUploads: 1,
            upload: uploads.upload,
            persist: persistence.persist,
            waitForTimeout: deadlines.wait
        )
        let value = attachment(byte: 1)
        coordinator.syncOwner(draftKey: "draft", environmentID: "one", attachments: [value])
        _ = await uploads.nextStart()
        deadlines.expire(await deadlines.nextStart())
        await waitUntilObserved {
            coordinator.state(environmentID: "one", attachmentID: value.id)
                == .failed("Upload timed out. Check the connection and retry.")
        }

        coordinator.retry(environmentID: "one", attachmentID: value.id)
        #expect(coordinator.state(environmentID: "one", attachmentID: value.id) == .queued)
        #expect(uploads.startCount == 1)

        // This transport ignores cancellation until its callback arrives.
        uploads.complete(value.id, environmentID: "one", attachmentID: "late")
        _ = await uploads.nextStart()
        #expect(uploads.maximumActive == 1)
        #expect(persistence.callCount == 0)
        uploads.complete(value.id, environmentID: "one", attachmentID: "retry")
        await waitUntilObserved {
            coordinator.state(environmentID: "one", attachmentID: value.id)
                == .ready(.init(environmentID: "one", attachmentID: "retry"))
        }
        #expect(persistence.callCount == 1)
    }

    @Test(arguments: [true, false])
    func timeoutDuringPersistenceStartsNextUploadAndRejectsLateCompletion(succeeds: Bool) async throws {
        let uploads = CoordinatorUploadHarness()
        let persistence = CoordinatorPersistenceHarness(suspended: true)
        let deadlines = CoordinatorDeadlineHarness()
        let coordinator = FeatureAttachmentUploadCoordinator(
            maximumConcurrentUploads: 1,
            upload: uploads.upload,
            persist: persistence.persist,
            waitForTimeout: deadlines.wait
        )
        let values = [attachment(byte: 1), attachment(byte: 2)]
        coordinator.syncOwner(draftKey: "draft", environmentID: "one", attachments: values)
        let first = await uploads.nextStart()
        let deadline = await deadlines.nextStart()
        uploads.complete(first, environmentID: "one")
        await persistence.nextCall()

        deadlines.expire(deadline)
        let expected = FeatureAttachmentUploadState.failed(
            "Upload timed out. Check the connection and retry."
        )
        await waitUntilObserved {
            coordinator.state(environmentID: "one", attachmentID: first) == expected
        }
        // A stalled disk save must not block the next network transfer.
        let second = await uploads.nextStart()
        if succeeds {
            persistence.resume(result: true)
        } else {
            persistence.fail(error: CancellationError())
        }

        uploads.complete(second, environmentID: "one")
        await waitUntilObserved {
            coordinator.state(environmentID: "one", attachmentID: second)
                == .ready(.init(environmentID: "one", attachmentID: "uploaded"))
        }
        #expect(coordinator.state(environmentID: "one", attachmentID: first) == expected)
    }

    private func makeCoordinator(
        limit: Int,
        uploads: CoordinatorUploadHarness
    ) -> FeatureAttachmentUploadCoordinator {
        FeatureAttachmentUploadCoordinator(
            maximumConcurrentUploads: limit,
            upload: uploads.upload,
            persist: { _, _, _ in true }
        )
    }

    private func attachment(id: UUID = UUID(), byte: UInt8) -> FeatureDraftAttachment {
        FeatureDraftAttachment(
            id: id,
            data: Data([byte]),
            filename: "\(byte).png",
            mimeType: "image/png"
        )
    }

    private func waitUntilObserved(_ condition: @escaping @MainActor () -> Bool) async {
        await CoordinatorObservationWaiter(condition: condition).wait()
    }
}

@MainActor
private final class CoordinatorObservationWaiter {
    private let condition: @MainActor () -> Bool
    private var continuation: CheckedContinuation<Void, Never>?

    init(condition: @escaping @MainActor () -> Bool) {
        self.condition = condition
    }

    func wait() async {
        guard !condition() else { return }
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            check()
        }
    }

    private func check() {
        guard continuation != nil else { return }
        withObservationTracking {
            guard condition(), let continuation else { return }
            self.continuation = nil
            continuation.resume()
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                self?.check()
            }
        }
    }
}

@MainActor
private final class CoordinatorUploadHarness {
    private struct Pending {
        let id: UUID
        let environmentID: String
        let continuation: CheckedContinuation<FeatureUploadedAttachmentReference?, Never>
    }

    private var pending: [Pending] = []
    private(set) var startCount = 0
    private(set) var maximumActive = 0
    private var active = 0
    private var startedIDs: [UUID] = []
    private var startWaiters: [CheckedContinuation<UUID, Never>] = []

    lazy var upload: FeatureAttachmentUploadCoordinator.Upload = { [weak self] attachment, env in
        guard let self else { return nil }
        self.startCount += 1
        self.active += 1
        self.maximumActive = max(self.maximumActive, self.active)
        if startWaiters.isEmpty {
            startedIDs.append(attachment.id)
        } else {
            startWaiters.removeFirst().resume(returning: attachment.id)
        }
        let result = await withCheckedContinuation { continuation in
            self.pending.append(Pending(
                id: attachment.id,
                environmentID: env,
                continuation: continuation
            ))
        }
        self.active -= 1
        return result
    }

    func complete(_ id: UUID, environmentID: String, attachmentID: String = "uploaded") {
        guard let index = pending.firstIndex(where: {
            $0.id == id && $0.environmentID == environmentID
        }) else {
            Issue.record("Upload was not pending")
            return
        }
        pending.remove(at: index).continuation.resume(returning: .init(
            environmentID: environmentID,
            attachmentID: attachmentID
        ))
    }

    func nextStart() async -> UUID {
        if !startedIDs.isEmpty { return startedIDs.removeFirst() }
        return await withCheckedContinuation { startWaiters.append($0) }
    }

    func completeAll() {
        let values = pending
        pending.removeAll()
        for value in values {
            value.continuation.resume(returning: .init(
                environmentID: value.environmentID,
                attachmentID: "drained"
            ))
        }
    }
}

@MainActor
private final class CoordinatorPersistenceHarness {
    var error: (any Error)?
    private var suspended: Bool
    private var continuation: CheckedContinuation<Bool, any Error>?
    private(set) var callCount = 0
    private var callReceipts = 0
    private var callWaiters: [CheckedContinuation<Void, Never>] = []

    init(suspended: Bool = false, error: (any Error)? = nil) {
        self.suspended = suspended
        self.error = error
    }

    lazy var persist: FeatureAttachmentUploadCoordinator.Persist = { [weak self] _, _, _ in
        guard let self else { return false }
        self.callCount += 1
        if callWaiters.isEmpty {
            callReceipts += 1
        } else {
            callWaiters.removeFirst().resume()
        }
        if let error = self.error { throw error }
        if self.suspended {
            return try await withCheckedThrowingContinuation { self.continuation = $0 }
        }
        return true
    }

    func resume(result: Bool) {
        suspended = false
        continuation?.resume(returning: result)
        continuation = nil
    }

    func fail(error: any Error) {
        suspended = false
        continuation?.resume(throwing: error)
        continuation = nil
    }

    func nextCall() async {
        if callReceipts > 0 {
            callReceipts -= 1
            return
        }
        await withCheckedContinuation { callWaiters.append($0) }
    }
}

@MainActor
private final class CoordinatorDeadlineHarness {
    private var pending: [UUID: CheckedContinuation<Void, any Error>] = [:]
    private var startedIDs: [UUID] = []
    private var startWaiters: [CheckedContinuation<UUID, Never>] = []

    lazy var wait: FeatureAttachmentUploadCoordinator.WaitForTimeout = { [weak self] _ in
        guard let self else { throw CancellationError() }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                self.pending[id] = continuation
                if self.startWaiters.isEmpty {
                    self.startedIDs.append(id)
                } else {
                    self.startWaiters.removeFirst().resume(returning: id)
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.pending.removeValue(forKey: id)?.resume(throwing: CancellationError())
            }
        }
    }

    func nextStart() async -> UUID {
        if !startedIDs.isEmpty { return startedIDs.removeFirst() }
        return await withCheckedContinuation { startWaiters.append($0) }
    }

    func expire(_ id: UUID) {
        pending.removeValue(forKey: id)?.resume()
    }
}

private enum TestFailure: LocalizedError {
    case disk

    var errorDescription: String? { "Disk write failed." }
}
