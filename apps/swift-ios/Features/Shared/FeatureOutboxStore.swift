import Foundation

/// Stable wire identities make an outbox retry idempotent across app launches,
/// including the ambiguous case where the server committed a command but its
/// response never reached the phone.
public struct FeatureSubmissionIdentity: Sendable, Equatable, Hashable, Codable {
    public var threadID: String
    public var commandID: String
    public var messageID: String
    public var createdAt: Date

    public init(
        threadID: String = UUID().uuidString,
        commandID: String = UUID().uuidString,
        messageID: String = UUID().uuidString,
        createdAt: Date = .now
    ) {
        self.threadID = threadID
        self.commandID = commandID
        self.messageID = messageID
        self.createdAt = createdAt
    }
}

public struct FeatureQueuedAttachment: Sendable, Equatable, Codable {
    public var source: PastedTextAttachmentSource?
    public var id: UUID
    public var data: Data?
    public var ownedFileName: String?
    public var byteCount: Int?
    public var name: String
    public var mimeType: String
    public var uploadedReference: FeatureUploadedAttachmentReference?
    private var resolvedOwnedFile: FeatureOwnedAttachmentFile?

    public init(
        id: UUID = UUID(),
        data: Data,
        name: String,
        mimeType: String,
        uploadedReference: FeatureUploadedAttachmentReference? = nil,
        source: PastedTextAttachmentSource? = nil
    ) {
        self.id = id
        self.data = data
        ownedFileName = nil
        byteCount = data.count
        self.name = name
        self.mimeType = mimeType
        self.uploadedReference = uploadedReference
        self.source = source
        resolvedOwnedFile = nil
    }

    init(_ attachment: FeatureUploadAttachment) {
        id = attachment.id
        source = attachment.source
        data = attachment.ownedFile == nil ? attachment.data : nil
        ownedFileName = attachment.ownedFile?.fileName
        byteCount = attachment.byteCount
        name = attachment.name
        mimeType = attachment.mimeType
        uploadedReference = attachment.uploadedReference
        resolvedOwnedFile = attachment.ownedFile
    }

    private enum CodingKeys: String, CodingKey {
        case id, data, ownedFileName, byteCount, name, mimeType, uploadedReference
        case source
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        data = try container.decodeIfPresent(Data.self, forKey: .data)
        ownedFileName = try container.decodeIfPresent(String.self, forKey: .ownedFileName)
        byteCount = try container.decodeIfPresent(Int.self, forKey: .byteCount) ?? data?.count
        name = try container.decode(String.self, forKey: .name)
        mimeType = try container.decode(String.self, forKey: .mimeType)
        source = try container.decodeIfPresent(PastedTextAttachmentSource.self, forKey: .source)
        uploadedReference = try container.decodeIfPresent(
            FeatureUploadedAttachmentReference.self,
            forKey: .uploadedReference
        )
        resolvedOwnedFile = nil
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encodeIfPresent(data, forKey: .data)
        try container.encodeIfPresent(ownedFileName, forKey: .ownedFileName)
        try container.encodeIfPresent(byteCount, forKey: .byteCount)
        try container.encode(name, forKey: .name)
        try container.encode(mimeType, forKey: .mimeType)
        try container.encodeIfPresent(source, forKey: .source)
        try container.encodeIfPresent(uploadedReference, forKey: .uploadedReference)
    }

    mutating func resolveOwnedFile(using fileStore: ManagedAttachmentFileStore) {
        guard let ownedFileName else { return }
        resolvedOwnedFile = try? fileStore.resolvedFile(
            fileName: ownedFileName,
            byteCount: byteCount ?? 0
        )
    }

    var upload: FeatureUploadAttachment? {
        if let resolvedOwnedFile {
            return FeatureUploadAttachment(
                id: id,
                ownedFile: resolvedOwnedFile,
                name: name,
                mimeType: mimeType,
                uploadedReference: uploadedReference,
                source: source
            )
        }
        guard let data else { return nil }
        return FeatureUploadAttachment(
            id: id,
            data: data,
            name: name,
            mimeType: mimeType,
            uploadedReference: uploadedReference,
            source: source
        )
    }
}

public struct FeatureQueuedCreation: Sendable, Equatable, Codable {
    public var projectID: String
    public var projectName: String
    public var draftKey: String?
    public var workspaceMode: FeatureWorkspaceMode
    public var branch: String?
    public var worktreePath: String?
    public var startFromOrigin: Bool

    public init(
        projectID: String,
        projectName: String,
        workspaceMode: FeatureWorkspaceMode,
        branch: String?,
        worktreePath: String?,
        startFromOrigin: Bool,
        draftKey: String? = nil
    ) {
        self.projectID = projectID
        self.projectName = projectName
        self.draftKey = draftKey
        self.workspaceMode = workspaceMode
        self.branch = branch
        self.worktreePath = worktreePath
        self.startFromOrigin = startFromOrigin
    }
}

public struct FeatureQueuedSubmission: Identifiable, Sendable, Equatable, Codable {
    public var context: OrchestrationMessageContext?
    public let id: String
    public var environmentID: String
    public var identity: FeatureSubmissionIdentity
    public var threadID: String
    public var text: String
    public var selection: FeatureSelection?
    public var runtimeMode: FeatureRuntimeMode
    public var interactionMode: FeatureInteractionMode
    public var attachments: [FeatureQueuedAttachment]
    public var creation: FeatureQueuedCreation?
    public var delivery: FeatureMessageDelivery

    public init(
        id: String? = nil,
        environmentID: String,
        identity: FeatureSubmissionIdentity,
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        attachments: [FeatureUploadAttachment],
        creation: FeatureQueuedCreation? = nil,
        context: OrchestrationMessageContext? = nil,
        delivery: FeatureMessageDelivery = .auto
    ) {
        self.id = id ?? identity.messageID
        self.environmentID = environmentID
        self.identity = identity
        self.threadID = threadID
        self.text = text
        self.selection = selection
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
        self.attachments = attachments.map(FeatureQueuedAttachment.init)
        self.creation = creation
        self.context = context
        self.delivery = delivery
    }

    private enum CodingKeys: String, CodingKey {
        case id, environmentID, identity, threadID, text, selection, runtimeMode, interactionMode
        case attachments, creation, context, delivery
    }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        environmentID = try values.decode(String.self, forKey: .environmentID)
        identity = try values.decode(FeatureSubmissionIdentity.self, forKey: .identity)
        threadID = try values.decode(String.self, forKey: .threadID)
        text = try values.decode(String.self, forKey: .text)
        selection = try values.decodeIfPresent(FeatureSelection.self, forKey: .selection)
        runtimeMode = try values.decode(FeatureRuntimeMode.self, forKey: .runtimeMode)
        interactionMode = try values.decode(FeatureInteractionMode.self, forKey: .interactionMode)
        attachments = try values.decode([FeatureQueuedAttachment].self, forKey: .attachments)
        creation = try values.decodeIfPresent(FeatureQueuedCreation.self, forKey: .creation)
        context = try values.decodeIfPresent(OrchestrationMessageContext.self, forKey: .context)
        delivery = try values.decodeIfPresent(FeatureMessageDelivery.self, forKey: .delivery) ?? .auto
    }

    public var uploads: [FeatureUploadAttachment] {
        attachments.compactMap(\.upload)
    }
}

public enum FeatureOutboxDeliveryDecision: Equatable {
    case discard
    case wait
    case send
}

public enum FeatureOutboxPolicy {
    /// Delivery waits for the owning environment. Existing threads accept
    /// follow-up messages while a turn is running, matching the web queue.
    /// A created thread does not prove that its first message was accepted.
    /// Retry its stable command identity until the message itself is confirmed.
    public static func decision(
        for submission: FeatureQueuedSubmission,
        snapshot: FeatureSnapshot,
        pendingCreationThreadIDs: Set<String> = []
    ) -> FeatureOutboxDeliveryDecision {
        let environment = snapshot.environments.first { $0.id == submission.environmentID }
        let isConnected = environment?.isEnabled == true
            && environment?.connectionState == .connected
        let thread = snapshot.threads.first { $0.id == submission.threadID }

        if submission.creation != nil {
            if thread != nil { return isConnected ? .send : .wait }
            let projectExists = snapshot.projects.contains {
                $0.id == submission.creation?.projectID
                    && $0.environmentID == submission.environmentID
            }
            if isConnected, !projectExists { return .discard }
            return isConnected ? .send : .wait
        }

        if pendingCreationThreadIDs.contains(submission.threadID) {
            return .wait
        }
        guard thread != nil else {
            // A fully synchronized environment proves the thread was deleted.
            return isConnected ? .discard : .wait
        }
        guard isConnected else { return .wait }
        return .send
    }
}

public actor FeatureOutboxStore {
    private struct Document: Codable {
        var version = 1
        var submissions: [FeatureQueuedSubmission]
        var recoveryDrafts: [FeatureSubmissionRecoveryDraft]?
    }

    public static let shared = FeatureOutboxStore()

    public let fileURL: URL
    public let attachmentFileStore: ManagedAttachmentFileStore
    private var cached: Document?

    public init(fileURL: URL? = nil, attachmentStorageRootURL: URL? = nil) {
        attachmentFileStore = ManagedAttachmentFileStore(rootURL: attachmentStorageRootURL)
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let root = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first!
            self.fileURL = root
                .appendingPathComponent("T3CodeSwift", isDirectory: true)
                .appendingPathComponent("outbox.json", isDirectory: false)
        }
    }

    public func submissions() throws -> [FeatureQueuedSubmission] {
        try document().submissions
    }

    public func recoveryDrafts() throws -> [FeatureSubmissionRecoveryDraft] {
        try document().recoveryDrafts ?? []
    }

    private func document() throws -> Document {
        if let cached { return cached }
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            let empty = Document(submissions: [])
            cached = empty
            return empty
        }
        // Failed reads stay uncached. A later write must not replace unreadable input.
        var document = try JSONDecoder.t3.decode(Document.self, from: Data(contentsOf: fileURL))
        document.submissions = document.submissions.map(resolveFiles).sorted {
            $0.identity.createdAt < $1.identity.createdAt
        }
        document.recoveryDrafts = document.recoveryDrafts?.map {
            FeatureSubmissionRecoveryDraft(submission: resolveFiles($0.submission), reason: $0.reason)
        }
        cached = document
        return document
    }

    private func resolveFiles(_ submission: FeatureQueuedSubmission) -> FeatureQueuedSubmission {
        var submission = submission
        for index in submission.attachments.indices {
            submission.attachments[index].resolveOwnedFile(using: attachmentFileStore)
        }
        return submission
    }

    public func enqueue(_ submission: FeatureQueuedSubmission) throws {
        var document = try document()
        document.submissions.removeAll { $0.id == submission.id }
        document.submissions.append(submission)
        document.submissions.sort { $0.identity.createdAt < $1.identity.createdAt }
        try save(document)
    }

    public func remove(id: String) throws {
        var document = try document()
        document.submissions.removeAll { $0.id == id }
        try save(document)
    }

    /// The saved draft and removal from delivery are one atomic write. Files
    /// keep their local identity and ownership until the composer takes them.
    @discardableResult
    public func recover(id: String, reason: String?) throws -> FeatureSubmissionRecoveryDraft? {
        var document = try document()
        if let existing = document.recoveryDrafts?.first(where: { $0.id == id }) {
            return existing
        }
        guard let submission = document.submissions.first(where: { $0.id == id }) else { return nil }
        let recovery = FeatureSubmissionRecoveryDraft(submission: submission, reason: reason)
        document.recoveryDrafts = (document.recoveryDrafts ?? []) + [recovery]
        document.submissions.removeAll { $0.id == id }
        try save(document)
        return recovery
    }

    public func removeRecovery(id: String) throws {
        var document = try document()
        document.recoveryDrafts?.removeAll { $0.id == id }
        try save(document)
    }

    /// Discard does not validate attachments: a missing file must never trap
    /// a recovery row. Delete only managed files with no remaining owner.
    public func discardRecovery(id: String, preservingOwnedFileNames: Set<String>) throws {
        var document = try document()
        guard let recovery = document.recoveryDrafts?.first(where: { $0.id == id }) else { return }
        document.recoveryDrafts?.removeAll { $0.id == id }
        let remaining = document.submissions + (document.recoveryDrafts ?? []).map(\.submission)
        let retainedNames = preservingOwnedFileNames.union(
            remaining.flatMap { $0.attachments.compactMap(\.ownedFileName) }
        )
        try save(document)
        for name in Set(recovery.submission.attachments.compactMap(\.ownedFileName))
        where !retainedNames.contains(name) {
            try? attachmentFileStore.removeOwnedFile(fileName: name)
        }
    }

    public func removeAll(environmentID: String) throws {
        var document = try document()
        document.submissions.removeAll { $0.environmentID == environmentID }
        document.recoveryDrafts?.removeAll { $0.environmentID == environmentID }
        try save(document)
    }

    private func save(_ document: Document) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try JSONEncoder.t3.encode(document)
        try data.write(to: fileURL, options: .atomic)
        cached = document
    }
}
