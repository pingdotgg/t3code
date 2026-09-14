import Foundation
import Observation

public struct FeatureAttachmentUploadKey: Hashable, Sendable {
    public let environmentID: String
    public let attachmentID: UUID

    public init(environmentID: String, attachmentID: UUID) {
        self.environmentID = environmentID
        self.attachmentID = attachmentID
    }
}

public enum FeatureAttachmentUploadState: Equatable, Sendable {
    case queued
    case uploading
    case ready(FeatureUploadedAttachmentReference?)
    case failed(String)
}

@MainActor
@Observable
public final class FeatureAttachmentUploadCoordinator {
    typealias Upload = @MainActor @Sendable (FeatureUploadAttachment, String) async throws
        -> FeatureUploadedAttachmentReference?
    typealias Persist = @MainActor @Sendable (
        FeatureUploadedAttachmentReference,
        FeatureDraftAttachment,
        String
    ) async throws -> Bool
    typealias WaitForTimeout = @MainActor @Sendable (Duration) async throws -> Void

    private struct Owner {
        var environmentID: String
        var attachments: [UUID: FeatureDraftAttachment]
    }

    private struct Job {
        let attachment: FeatureDraftAttachment
        let token: UUID
        var state: FeatureAttachmentUploadState
        var task: Task<Void, Never>?
        var deadlineTask: Task<Void, Never>?
    }

    public private(set) var states: [FeatureAttachmentUploadKey: FeatureAttachmentUploadState] = [:]
    private let upload: Upload
    private let persist: Persist
    private let waitForTimeout: WaitForTimeout
    private let maximumConcurrentUploads: Int
    private var owners: [String: Owner] = [:]
    private var outboxOwners: [String: Set<FeatureAttachmentUploadKey>] = [:]
    private var jobs: [FeatureAttachmentUploadKey: Job] = [:]
    // Canceled transfers keep their slots until the upload function returns.
    private var runningTokens: Set<UUID> = []

    public convenience init(
        client: any FeatureClient,
        draftStore: FeatureComposerDraftStore = .shared,
        maximumConcurrentUploads: Int = 3
    ) {
        self.init(
            maximumConcurrentUploads: maximumConcurrentUploads,
            upload: { attachment, environmentID in
                try await client.preuploadAttachment(attachment, environmentID: environmentID)
            },
            persist: { reference, attachment, draftKey in
                try await draftStore.setUploadedReference(
                    reference,
                    attachment: attachment,
                    for: draftKey
                )
            }
        )
    }

    init(
        maximumConcurrentUploads: Int = 3,
        upload: @escaping Upload,
        persist: @escaping Persist,
        waitForTimeout: @escaping WaitForTimeout = { try await Task.sleep(for: $0) }
    ) {
        self.maximumConcurrentUploads = max(1, maximumConcurrentUploads)
        self.upload = upload
        self.persist = persist
        self.waitForTimeout = waitForTimeout
    }

    public func syncOwner(
        draftKey: String,
        environmentID: String,
        attachments: [FeatureDraftAttachment]
    ) {
        let previous = owners[draftKey]
        owners[draftKey] = Owner(
            environmentID: environmentID,
            attachments: Dictionary(uniqueKeysWithValues: attachments.map { ($0.id, $0) })
        )
        for attachment in attachments {
            enqueueIfNeeded(attachment, environmentID: environmentID)
        }
        if let previous {
            let oldKeys = Set(previous.attachments.keys.map {
                FeatureAttachmentUploadKey(
                    environmentID: previous.environmentID,
                    attachmentID: $0
                )
            })
            let newKeys = Set(attachments.map {
                FeatureAttachmentUploadKey(environmentID: environmentID, attachmentID: $0.id)
            })
            cancelUnowned(oldKeys.subtracting(newKeys))
        }
        startQueuedJobs()
    }

    public func removeOwner(draftKey: String) {
        guard let owner = owners.removeValue(forKey: draftKey) else { return }
        cancelUnowned(Set(owner.attachments.keys.map {
            FeatureAttachmentUploadKey(environmentID: owner.environmentID, attachmentID: $0)
        }))
    }

    public func syncOutboxOwner(
        ownerID: String,
        environmentID: String,
        attachmentIDs: [UUID]
    ) {
        let previous = outboxOwners[ownerID] ?? []
        let current = Set(attachmentIDs.map {
            FeatureAttachmentUploadKey(environmentID: environmentID, attachmentID: $0)
        })
        outboxOwners[ownerID] = current
        cancelUnowned(previous.subtracting(current))
    }

    public func removeOutboxOwner(ownerID: String) {
        guard let previous = outboxOwners.removeValue(forKey: ownerID) else { return }
        cancelUnowned(previous)
    }

    public func retry(environmentID: String, attachmentID: UUID) {
        let key = FeatureAttachmentUploadKey(
            environmentID: environmentID,
            attachmentID: attachmentID
        )
        guard let job = jobs[key], case .failed = job.state, isOwned(key) else { return }
        queue(key: key, attachment: job.attachment)
        startQueuedJobs()
    }

    public func state(
        environmentID: String,
        attachmentID: UUID
    ) -> FeatureAttachmentUploadState? {
        states[FeatureAttachmentUploadKey(
            environmentID: environmentID,
            attachmentID: attachmentID
        )]
    }

    public func attachmentsForSend(
        draftKey: String,
        environmentID: String,
        attachments: [FeatureDraftAttachment]
    ) -> [FeatureDraftAttachment] {
        guard let owner = owners[draftKey], owner.environmentID == environmentID else {
            return attachments
        }
        return attachments.map { attachment in
            let key = FeatureAttachmentUploadKey(
                environmentID: environmentID,
                attachmentID: attachment.id
            )
            guard let owned = owner.attachments[attachment.id],
                  Self.samePayload(owned, attachment),
                  let job = jobs[key], Self.samePayload(job.attachment, attachment),
                  case let .ready(reference) = job.state,
                  let reference, reference.environmentID == environmentID else {
                return attachment
            }
            var enriched = attachment
            enriched.uploadedReference = reference
            return enriched
        }
    }

    private func enqueueIfNeeded(_ attachment: FeatureDraftAttachment, environmentID: String) {
        let key = FeatureAttachmentUploadKey(
            environmentID: environmentID,
            attachmentID: attachment.id
        )
        if let job = jobs[key] {
            guard !Self.samePayload(job.attachment, attachment) else { return }
            job.task?.cancel()
            job.deadlineTask?.cancel()
            jobs[key] = nil
            states[key] = nil
        }
        queue(key: key, attachment: attachment)
    }

    private func queue(key: FeatureAttachmentUploadKey, attachment: FeatureDraftAttachment) {
        jobs[key] = Job(
            attachment: attachment,
            token: UUID(),
            state: .queued,
            task: nil,
            deadlineTask: nil
        )
        states[key] = .queued
    }

    private func startQueuedJobs() {
        while runningTokens.count < maximumConcurrentUploads,
              let key = jobs.first(where: { $0.value.state == .queued && isOwned($0.key) })?.key,
              var job = jobs[key] {
            let token = job.token
            let attachment = job.attachment
            job.state = .uploading
            runningTokens.insert(token)
            states[key] = .uploading
            job.deadlineTask = Task { [weak self, waitForTimeout] in
                do {
                    // Include connection setup and draft persistence, not just
                    // the HTTP transfer. Files can be as large as 50 MiB.
                    let timeout: Duration = attachment.mimeType.hasPrefix("image/")
                        ? .seconds(120) : .seconds(600)
                    try await waitForTimeout(timeout)
                    try Task.checkCancellation()
                } catch {
                    return
                }
                self?.uploadTimedOut(key: key, token: token)
            }
            job.task = Task { [weak self, upload] in
                let result: Result<FeatureUploadedAttachmentReference?, any Error>
                do {
                    result = .success(try await upload(
                        FeatureUploadAttachment(attachment),
                        key.environmentID
                    ))
                } catch {
                    result = .failure(error)
                }
                await self?.transferReturned(
                    key: key,
                    token: token,
                    attachment: attachment,
                    result: result
                )
            }
            jobs[key] = job
        }
    }

    private func transferReturned(
        key: FeatureAttachmentUploadKey,
        token: UUID,
        attachment: FeatureDraftAttachment,
        result: Result<FeatureUploadedAttachmentReference?, any Error>
    ) async {
        runningTokens.remove(token)
        guard jobs[key]?.token == token, jobs[key]?.state == .uploading else {
            startQueuedJobs()
            return
        }
        switch result {
        case let .failure(error):
            fail(key: key, token: token, error: error)
        case let .success(reference):
            await persistThenPublish(
                key: key,
                token: token,
                attachment: attachment,
                reference: reference
            )
        }
        startQueuedJobs()
    }

    private func persistThenPublish(
        key: FeatureAttachmentUploadKey,
        token: UUID,
        attachment: FeatureDraftAttachment,
        reference: FeatureUploadedAttachmentReference?
    ) async {
        guard currentAndOwned(key: key, token: token, attachment: attachment) else { return }
        if let reference {
            guard reference.environmentID == key.environmentID else {
                fail(key: key, token: token, error: CoordinatorError.wrongEnvironment)
                return
            }
            let draftKeys = matchingDraftKeys(key: key, attachment: attachment)
            do {
                for draftKey in draftKeys {
                    let didPersist = try await persist(reference, attachment, draftKey)
                    guard currentAndOwned(key: key, token: token, attachment: attachment),
                          matchingDraftKeys(key: key, attachment: attachment).contains(draftKey)
                    else { return }
                    guard didPersist else {
                        fail(key: key, token: token, error: CoordinatorError.persistenceRejected)
                        return
                    }
                }
            } catch {
                fail(key: key, token: token, error: error)
                return
            }
        }
        guard var job = jobs[key], job.token == token,
              currentAndOwned(key: key, token: token, attachment: attachment) else { return }
        job.state = .ready(reference)
        job.task = nil
        job.deadlineTask?.cancel()
        job.deadlineTask = nil
        jobs[key] = job
        states[key] = job.state
    }

    private func matchingDraftKeys(
        key: FeatureAttachmentUploadKey,
        attachment: FeatureDraftAttachment
    ) -> [String] {
        owners.compactMap { draftKey, owner in
            owner.environmentID == key.environmentID
                && owner.attachments[attachment.id].map {
                    Self.samePayload($0, attachment)
                } == true ? draftKey : nil
        }
    }

    private func fail(key: FeatureAttachmentUploadKey, token: UUID, error: any Error) {
        guard var job = jobs[key], job.token == token, job.state == .uploading else { return }
        job.state = .failed(
            (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        )
        job.task = nil
        job.deadlineTask?.cancel()
        job.deadlineTask = nil
        jobs[key] = job
        states[key] = job.state
    }

    private func uploadTimedOut(key: FeatureAttachmentUploadKey, token: UUID) {
        guard let job = jobs[key], job.token == token, job.state == .uploading else { return }
        job.task?.cancel()
        // Publish the failure even if a canceled transfer has not returned.
        // Its concurrency slot still belongs to it until transferReturned.
        fail(key: key, token: token, error: CoordinatorError.timedOut)
        startQueuedJobs()
    }

    private func cancelUnowned(_ keys: Set<FeatureAttachmentUploadKey>) {
        for key in keys where !isOwned(key) {
            jobs[key]?.task?.cancel()
            jobs[key]?.deadlineTask?.cancel()
            jobs[key] = nil
            states[key] = nil
        }
        startQueuedJobs()
    }

    private func currentAndOwned(
        key: FeatureAttachmentUploadKey,
        token: UUID,
        attachment: FeatureDraftAttachment
    ) -> Bool {
        guard let job = jobs[key], job.token == token, job.state == .uploading,
              Self.samePayload(job.attachment, attachment) else { return false }
        return outboxOwners.values.contains(where: { $0.contains(key) }) || !matchingDraftKeys(
            key: key,
            attachment: attachment
        ).isEmpty
    }

    private func isOwned(_ key: FeatureAttachmentUploadKey) -> Bool {
        outboxOwners.values.contains(where: { $0.contains(key) }) || owners.values.contains {
            $0.environmentID == key.environmentID && $0.attachments[key.attachmentID] != nil
        }
    }

    private static func samePayload(
        _ lhs: FeatureDraftAttachment,
        _ rhs: FeatureDraftAttachment
    ) -> Bool {
        guard lhs.id == rhs.id,
              lhs.filename == rhs.filename,
              lhs.mimeType == rhs.mimeType,
              lhs.byteCount == rhs.byteCount else { return false }
        if let file = lhs.ownedFile {
            return file.fileName == rhs.ownedFile?.fileName
        }
        return rhs.ownedFile == nil && lhs.data == rhs.data
    }
}

private enum CoordinatorError: LocalizedError {
    case wrongEnvironment
    case persistenceRejected
    case timedOut

    var errorDescription: String? {
        switch self {
        case .wrongEnvironment:
            "The uploaded attachment belongs to a different environment."
        case .persistenceRejected:
            "The draft changed before the upload could be saved. Retry the upload."
        case .timedOut:
            "Upload timed out. Check the connection and retry."
        }
    }
}
