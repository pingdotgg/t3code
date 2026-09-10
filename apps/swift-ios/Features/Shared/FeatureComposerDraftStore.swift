import Foundation

public struct FeatureComposerDraft: Sendable, Equatable {
    public var text: String
    public var attachments: [FeatureDraftAttachment]
    public var selection: FeatureSelection?
    public var workspace: FeatureComposerWorkspaceDraft?

    public init(
        text: String = "",
        attachments: [FeatureDraftAttachment] = [],
        selection: FeatureSelection? = nil,
        workspace: FeatureComposerWorkspaceDraft? = nil
    ) {
        self.text = text
        self.attachments = attachments
        self.selection = selection
        self.workspace = workspace
    }

    public var isEmpty: Bool {
        text.isEmpty && attachments.isEmpty && selection == nil && workspace == nil
    }
}

public struct FeatureComposerWorkspaceDraft: Sendable, Equatable {
    public var mode: FeatureWorkspaceMode
    public var branch: String?
    public var worktreePath: String?
    public var startFromOrigin: Bool

    public init(
        mode: FeatureWorkspaceMode,
        branch: String?,
        worktreePath: String?,
        startFromOrigin: Bool
    ) {
        self.mode = mode
        self.branch = branch
        self.worktreePath = worktreePath
        self.startFromOrigin = startFromOrigin
    }
}

enum FeatureQuestionAttachmentDraft {
    static func key(inputID: String) -> String { "question-attachments:\(inputID)" }

    static func encode(_ attachments: [String: [FeatureDraftAttachment]]) throws -> FeatureComposerDraft {
        let nonempty = attachments.filter { !$0.value.isEmpty }
        guard !nonempty.isEmpty else { return FeatureComposerDraft() }
        let data = try JSONEncoder().encode(nonempty.mapValues { $0.map(\.id) })
        return FeatureComposerDraft(
            text: String(decoding: data, as: UTF8.self),
            attachments: nonempty.keys.sorted().flatMap { nonempty[$0] ?? [] }
        )
    }

    static func decode(_ draft: FeatureComposerDraft?) throws -> [String: [FeatureDraftAttachment]] {
        guard let draft, !draft.isEmpty else { return [:] }
        let ids = try JSONDecoder().decode([String: [UUID]].self, from: Data(draft.text.utf8))
        let byID = Dictionary(draft.attachments.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return ids.mapValues { $0.compactMap { byID[$0] } }
    }
}

public enum FeatureComposerDraftImportError: LocalizedError, Equatable, Sendable {
    case attachmentLimitExceeded(available: Int)

    public var errorDescription: String? {
        switch self {
        case let .attachmentLimitExceeded(available):
            available == 0
                ? "This draft already has eight attachments. Remove one before importing the share."
                : "This share needs more attachment slots. The current draft has room for \(available)."
        }
    }
}

/// Persists composer state independently of view navigation. Draft writes are
/// atomic, and callers debounce high-frequency text changes before reaching
/// this actor so image data is not repeatedly encoded for every keystroke.
public actor FeatureComposerDraftStore {
    public static let shared = FeatureComposerDraftStore()
    private static let documentVersion = 2

    private struct Document: Codable {
        let version: Int
        var drafts: [String: PersistedDraft]
    }

    private struct PersistedDraft: Codable {
        var text: String
        var attachments: [PersistedAttachment]
        var selection: FeatureSelection?
        var workspace: PersistedWorkspace?
        var importedShareIDs: [String]?

        init(_ draft: FeatureComposerDraft) {
            text = draft.text
            attachments = draft.attachments.map(PersistedAttachment.init)
            selection = draft.selection
            workspace = draft.workspace.map(PersistedWorkspace.init)
            importedShareIDs = nil
        }

        func featureValue(fileStore: ManagedAttachmentFileStore) -> FeatureComposerDraft {
            FeatureComposerDraft(
                text: text,
                attachments: attachments.compactMap { $0.featureValue(fileStore: fileStore) },
                selection: selection,
                workspace: workspace?.featureValue
            )
        }
    }

    private struct PersistedWorkspace: Codable {
        var mode: FeatureWorkspaceMode
        var branch: String?
        var worktreePath: String?
        var startFromOrigin: Bool

        init(_ workspace: FeatureComposerWorkspaceDraft) {
            mode = workspace.mode
            branch = workspace.branch
            worktreePath = workspace.worktreePath
            startFromOrigin = workspace.startFromOrigin
        }

        var featureValue: FeatureComposerWorkspaceDraft {
            FeatureComposerWorkspaceDraft(
                mode: mode,
                branch: branch,
                worktreePath: worktreePath,
                startFromOrigin: startFromOrigin
            )
        }
    }

    private struct PersistedAttachment: Codable {
        var id: UUID
        var data: Data?
        var ownedFileName: String?
        var byteCount: Int?
        var thumbnailData: Data?
        var filename: String
        var mimeType: String
        var uploadedReference: FeatureUploadedAttachmentReference?

        init(_ attachment: FeatureDraftAttachment) {
            id = attachment.id
            data = attachment.ownedFile == nil ? attachment.data : nil
            ownedFileName = attachment.ownedFile?.fileName
            byteCount = attachment.byteCount
            thumbnailData = attachment.thumbnailData
            filename = attachment.filename
            mimeType = attachment.mimeType
            uploadedReference = attachment.uploadedReference
        }

        func featureValue(fileStore: ManagedAttachmentFileStore) -> FeatureDraftAttachment? {
            if let ownedFileName,
               let ownedFile = try? fileStore.resolvedFile(
                   fileName: ownedFileName,
                   byteCount: byteCount ?? 0
               ) {
                return FeatureDraftAttachment(
                    id: id,
                    ownedFile: ownedFile,
                    thumbnailData: thumbnailData,
                    filename: filename,
                    mimeType: mimeType,
                    uploadedReference: uploadedReference
                )
            }
            guard let data else { return nil }
            return FeatureDraftAttachment(
                id: id,
                data: data,
                thumbnailData: thumbnailData,
                filename: filename,
                mimeType: mimeType,
                uploadedReference: uploadedReference
            )
        }

        func hasSameContent(as attachment: FeatureDraftAttachment) -> Bool {
            guard id == attachment.id,
                  filename == attachment.filename,
                  mimeType == attachment.mimeType,
                  (byteCount ?? data?.count ?? 0) == attachment.byteCount else { return false }
            if let ownedFileName {
                return ownedFileName == attachment.ownedFile?.fileName
            }
            return attachment.ownedFile == nil && data == attachment.data
        }
    }

    public let fileURL: URL
    public let attachmentFileStore: ManagedAttachmentFileStore
    private var loadedDrafts: [String: PersistedDraft]?

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
                .appendingPathComponent("composer-drafts.json", isDirectory: false)
        }
    }

    public func draft(for key: String) throws -> FeatureComposerDraft? {
        guard let draft = try loadIfNeeded()[key]?.featureValue(fileStore: attachmentFileStore),
              !draft.isEmpty else { return nil }
        return draft
    }

    /// Loads the new-task draft of one workspace. Before drafts were keyed by
    /// workspace, one draft served a whole repository group; the first
    /// workspace of that group to open adopts it, and the old key is dropped so
    /// sending cannot resurrect it.
    func newTaskDraft(project: FeatureProject, in snapshot: FeatureSnapshot) throws
        -> FeatureComposerDraft?
    {
        let key = Self.newTaskKey(project: project)
        var drafts = try loadIfNeeded()
        if drafts[key] == nil,
           let legacyKey = Self.repositoryNewTaskKey(project: project, in: snapshot),
           let legacyDraft = drafts.removeValue(forKey: legacyKey) {
            drafts[key] = legacyDraft
            try persist(drafts)
            loadedDrafts = drafts
        }
        return try draft(for: key)
    }

    public func setDraft(_ draft: FeatureComposerDraft, for key: String) throws {
        var drafts = try loadIfNeeded()
        let existingReferences = Dictionary(
            uniqueKeysWithValues: (drafts[key]?.attachments ?? []).compactMap { attachment in
                attachment.uploadedReference.map { (attachment.id, (attachment, $0)) }
            }
        )
        var mergedDraft = draft
        for index in mergedDraft.attachments.indices
        where mergedDraft.attachments[index].uploadedReference == nil {
            let incoming = mergedDraft.attachments[index]
            if let (persisted, reference) = existingReferences[incoming.id],
               persisted.hasSameContent(as: incoming) {
                mergedDraft.attachments[index].uploadedReference = reference
            }
        }
        if mergedDraft.isEmpty {
            if let importedShareIDs = drafts[key]?.importedShareIDs,
               !importedShareIDs.isEmpty {
                var persisted = PersistedDraft(mergedDraft)
                persisted.importedShareIDs = importedShareIDs
                drafts[key] = persisted
            } else {
                drafts.removeValue(forKey: key)
            }
        } else {
            var persisted = PersistedDraft(mergedDraft)
            // Preserve the crash-replay ledger while the composer performs its
            // ordinary debounced saves after opening an imported share.
            persisted.importedShareIDs = drafts[key]?.importedShareIDs
            drafts[key] = persisted
        }
        try persist(drafts)
        loadedDrafts = drafts
    }

    /// Saves an upload result only if the attachment still exists with the
    /// same immutable content. Text, selection, and workspace stay unchanged.
    @discardableResult
    public func setUploadedReference(
        _ reference: FeatureUploadedAttachmentReference,
        attachment: FeatureDraftAttachment,
        for key: String
    ) throws -> Bool {
        var drafts = try loadIfNeeded()
        guard var draft = drafts[key],
              let index = draft.attachments.firstIndex(where: { $0.id == attachment.id }),
              draft.attachments[index].hasSameContent(as: attachment) else { return false }
        draft.attachments[index].uploadedReference = reference
        drafts[key] = draft
        try persist(drafts)
        loadedDrafts = drafts
        return true
    }

    /// Atomically imports one share-extension envelope into the latest stored
    /// draft. The share ID is committed with the content, so a host crash after
    /// this write but before inbox cleanup cannot duplicate the import.
    @discardableResult
    public func importSharedContent(
        shareID: String,
        text: String,
        attachments: [FeatureDraftAttachment],
        for key: String,
        maximumAttachmentCount: Int = 8
    ) throws -> FeatureComposerDraft {
        var drafts = try loadIfNeeded()
        var persisted = drafts[key] ?? PersistedDraft(FeatureComposerDraft())
        var importedIDs = persisted.importedShareIDs ?? []
        guard !importedIDs.contains(shareID) else {
            return persisted.featureValue(fileStore: attachmentFileStore)
        }

        let existingIDs = Set(persisted.attachments.map(\.id))
        let uniqueAttachments = attachments.filter { !existingIDs.contains($0.id) }
        let availableCount = max(0, maximumAttachmentCount - persisted.attachments.count)
        guard uniqueAttachments.count <= availableCount else {
            throw FeatureComposerDraftImportError.attachmentLimitExceeded(
                available: availableCount
            )
        }

        let incomingText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !incomingText.isEmpty {
            persisted.text = persisted.text.trimmingCharacters(in: .whitespacesAndNewlines)
            persisted.text = persisted.text.isEmpty
                ? incomingText
                : "\(persisted.text)\n\n\(incomingText)"
        }

        persisted.attachments.append(contentsOf: uniqueAttachments.map(PersistedAttachment.init))
        importedIDs.append(shareID)
        persisted.importedShareIDs = Array(importedIDs.suffix(32))
        drafts[key] = persisted
        try persist(drafts)
        loadedDrafts = drafts
        return persisted.featureValue(fileStore: attachmentFileStore)
    }

    public func removeDraft(for key: String) throws {
        var drafts = try loadIfNeeded()
        guard drafts.removeValue(forKey: key) != nil else { return }
        try persist(drafts)
        loadedDrafts = drafts
    }

    public func removeDrafts(
        environmentID: String,
        logicalProjectIDs: Set<String> = []
    ) throws {
        var drafts = try loadIfNeeded()
        let environmentPrefix = "environment:\(environmentID):"
        let questionPrefix = FeatureQuestionAttachmentDraft.key(
            inputID: FeatureScopedID.input(environmentID: environmentID, wireID: "")
        )
        let logicalKeys = Set(logicalProjectIDs.map(Self.newTaskKey(logicalProjectID:)))
        drafts = drafts.filter {
            !$0.key.hasPrefix(environmentPrefix) && !$0.key.hasPrefix(questionPrefix)
                && !logicalKeys.contains($0.key)
        }
        try persist(drafts)
        loadedDrafts = drafts
    }

    public static func threadKey(_ thread: FeatureThread) -> String {
        let environment = thread.environmentID ?? "active"
        let threadID = thread.wireID ?? thread.id
        return "environment:\(environment):thread:\(threadID)"
    }

    /// Projects with a repository identity key their new-task draft by physical
    /// workspace, so alias rows of one checkout share a draft. Other projects
    /// keep the environment-scoped project key.
    public static func newTaskKey(project: FeatureProject) -> String {
        guard project.repositoryIdentity != nil else {
            let projectID = project.wireID ?? project.id
            return "environment:\(project.environmentID):new-task:\(projectID)"
        }
        return newTaskKey(logicalProjectID: DailyUXCreationContext.logicalProjectID(for: project))
    }

    public static func newTaskKey(logicalProjectID: String) -> String {
        "logical-project:\(logicalProjectID):new-task"
    }

    /// The key new-task drafts used while creation grouped checkouts the way
    /// the sidebar does. `nil` when the project never had such a key.
    private static func repositoryNewTaskKey(
        project: FeatureProject,
        in snapshot: FeatureSnapshot
    ) -> String? {
        guard project.repositoryIdentity != nil else { return nil }
        let groups = DailyUXProjectGrouping.groups(
            projects: snapshot.projects,
            preferencesByEnvironment: snapshot.preferencesByEnvironment ?? [:]
        )
        return DailyUXProjectGrouping.group(containing: project.id, in: groups)
            .map { newTaskKey(logicalProjectID: $0.id) }
    }

    private func loadIfNeeded() throws -> [String: PersistedDraft] {
        if let loadedDrafts { return loadedDrafts }
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            let drafts: [String: PersistedDraft] = [:]
            loadedDrafts = drafts
            return drafts
        }
        let data = try Data(contentsOf: fileURL)
        let document = try JSONDecoder.t3.decode(Document.self, from: data)
        guard document.version == 1 || document.version == Self.documentVersion else {
            throw CocoaError(.fileReadCorruptFile)
        }
        var drafts = document.drafts
        if document.version == 1 {
            // Version 1 wrote resolved project/environment defaults into every
            // new-task draft. They were not necessarily user choices, so drop
            // only those derived fields while preserving text and attachments.
            for key in Array(drafts.keys) where key.contains(":new-task:") {
                drafts[key]?.selection = nil
                drafts[key]?.workspace = nil
            }
            drafts = drafts.filter {
                !$0.value.featureValue(fileStore: attachmentFileStore).isEmpty
            }
            try persist(drafts)
        }
        loadedDrafts = drafts
        return drafts
    }

    private func persist(_ drafts: [String: PersistedDraft]) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let document = Document(version: Self.documentVersion, drafts: drafts)
        try JSONEncoder.t3.encode(document).write(to: fileURL, options: .atomic)
    }
}
