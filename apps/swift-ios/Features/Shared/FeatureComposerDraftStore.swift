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

        var featureValue: FeatureComposerDraft {
            FeatureComposerDraft(
                text: text,
                attachments: attachments.map(\.featureValue),
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
        var data: Data
        var thumbnailData: Data?
        var filename: String
        var mimeType: String

        init(_ attachment: FeatureDraftAttachment) {
            id = attachment.id
            data = attachment.data
            thumbnailData = attachment.thumbnailData
            filename = attachment.filename
            mimeType = attachment.mimeType
        }

        var featureValue: FeatureDraftAttachment {
            FeatureDraftAttachment(
                id: id,
                data: data,
                thumbnailData: thumbnailData,
                filename: filename,
                mimeType: mimeType
            )
        }
    }

    public let fileURL: URL
    private var loadedDrafts: [String: PersistedDraft]?

    public init(fileURL: URL? = nil) {
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
        guard let draft = try loadIfNeeded()[key]?.featureValue,
              !draft.isEmpty else { return nil }
        return draft
    }

    public func setDraft(_ draft: FeatureComposerDraft, for key: String) throws {
        var drafts = try loadIfNeeded()
        if draft.isEmpty {
            if let importedShareIDs = drafts[key]?.importedShareIDs,
               !importedShareIDs.isEmpty {
                var persisted = PersistedDraft(draft)
                persisted.importedShareIDs = importedShareIDs
                drafts[key] = persisted
            } else {
                drafts.removeValue(forKey: key)
            }
        } else {
            var persisted = PersistedDraft(draft)
            // Preserve the crash-replay ledger while the composer performs its
            // ordinary debounced saves after opening an imported share.
            persisted.importedShareIDs = drafts[key]?.importedShareIDs
            drafts[key] = persisted
        }
        try persist(drafts)
        loadedDrafts = drafts
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
        guard !importedIDs.contains(shareID) else { return persisted.featureValue }

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
        return persisted.featureValue
    }

    public func removeDraft(for key: String) throws {
        var drafts = try loadIfNeeded()
        guard drafts.removeValue(forKey: key) != nil else { return }
        try persist(drafts)
        loadedDrafts = drafts
    }

    public func removeDrafts(environmentID: String) throws {
        var drafts = try loadIfNeeded()
        let environmentPrefix = "environment:\(environmentID):"
        drafts = drafts.filter { !$0.key.hasPrefix(environmentPrefix) }
        try persist(drafts)
        loadedDrafts = drafts
    }

    public static func threadKey(_ thread: FeatureThread) -> String {
        let environment = thread.environmentID ?? "active"
        let threadID = thread.wireID ?? thread.id
        return "environment:\(environment):thread:\(threadID)"
    }

    public static func newTaskKey(project: FeatureProject) -> String {
        let projectID = project.wireID ?? project.id
        return "environment:\(project.environmentID):new-task:\(projectID)"
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
            drafts = drafts.filter { !$0.value.featureValue.isEmpty }
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
