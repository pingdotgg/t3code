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
        uploadedReference: FeatureUploadedAttachmentReference? = nil
    ) {
        self.id = id
        self.data = data
        ownedFileName = nil
        byteCount = data.count
        self.name = name
        self.mimeType = mimeType
        self.uploadedReference = uploadedReference
        resolvedOwnedFile = nil
    }

    init(_ attachment: FeatureUploadAttachment) {
        id = attachment.id
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
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        data = try container.decodeIfPresent(Data.self, forKey: .data)
        ownedFileName = try container.decodeIfPresent(String.self, forKey: .ownedFileName)
        byteCount = try container.decodeIfPresent(Int.self, forKey: .byteCount) ?? data?.count
        name = try container.decode(String.self, forKey: .name)
        mimeType = try container.decode(String.self, forKey: .mimeType)
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
                uploadedReference: uploadedReference
            )
        }
        guard let data else { return nil }
        return FeatureUploadAttachment(
            id: id,
            data: data,
            name: name,
            mimeType: mimeType,
            uploadedReference: uploadedReference
        )
    }
}

public struct FeatureQueuedCreation: Sendable, Equatable, Codable {
    public var projectID: String
    public var projectName: String
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
        startFromOrigin: Bool
    ) {
        self.projectID = projectID
        self.projectName = projectName
        self.workspaceMode = workspaceMode
        self.branch = branch
        self.worktreePath = worktreePath
        self.startFromOrigin = startFromOrigin
    }
}

public struct FeatureQueuedSubmission: Identifiable, Sendable, Equatable, Codable {
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
        creation: FeatureQueuedCreation? = nil
    ) {
        self.id = id ?? identity.messageID
        self.environmentID = environmentID
        self.identity = identity
        self.threadID = threadID
        self.text = text
        self.selection = selection
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode.mobileNormalized
        self.attachments = attachments.map(FeatureQueuedAttachment.init)
        self.creation = creation
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
    }

    public static let shared = FeatureOutboxStore()

    public let fileURL: URL
    public let attachmentFileStore: ManagedAttachmentFileStore
    private var cached: [FeatureQueuedSubmission]?

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
        if let cached { return cached }
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            cached = []
            return []
        }
        // Keep failed reads uncached so later writes cannot replace unreadable messages.
        let document = try JSONDecoder.t3.decode(
            Document.self,
            from: Data(contentsOf: fileURL)
        )
        cached = document.submissions.map { submission in
            var submission = submission
            submission.interactionMode = submission.interactionMode.mobileNormalized
            for index in submission.attachments.indices {
                submission.attachments[index].resolveOwnedFile(using: attachmentFileStore)
            }
            return submission
        }.sorted {
            $0.identity.createdAt < $1.identity.createdAt
        }
        return cached ?? []
    }

    public func enqueue(_ submission: FeatureQueuedSubmission) throws {
        var values = try submissions()
        values.removeAll { $0.id == submission.id }
        values.append(submission)
        values.sort { $0.identity.createdAt < $1.identity.createdAt }
        try save(values)
    }

    public func remove(id: String) throws {
        var values = try submissions()
        values.removeAll { $0.id == id }
        try save(values)
    }

    public func removeAll(environmentID: String) throws {
        var values = try submissions()
        values.removeAll { $0.environmentID == environmentID }
        try save(values)
    }

    private func save(_ submissions: [FeatureQueuedSubmission]) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try JSONEncoder.t3.encode(Document(submissions: submissions))
        try data.write(to: fileURL, options: .atomic)
        cached = submissions
    }
}
