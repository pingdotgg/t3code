import Foundation
import Observation
import SwiftUI

enum PlatformIncomingShareError: LocalizedError, Equatable {
    case missingImage(String)
    case invalidImage(String)
    case missingFile(String)
    case invalidFile(String)
    case invalidEnvelope

    var errorDescription: String? {
        switch self {
        case let .missingImage(name):
            "The shared image \(name) is no longer available. Share it again to retry."
        case let .invalidImage(name):
            "The shared image \(name) is incomplete or too large. Share it again to retry."
        case let .missingFile(name):
            "The shared file \(name) is no longer available. Share it again to retry."
        case let .invalidFile(name):
            "The shared file \(name) is incomplete or too large. Share it again to retry."
        case .invalidEnvelope:
            "This shared item is invalid. Share it again to retry."
        }
    }
}

struct PlatformIncomingShareSource: Sendable {
    var loadAll: @Sendable () async -> [T3IncomingShareEnvelope]
    var data: @Sendable (T3IncomingShareImage) async throws -> Data
    var fileURL: @Sendable (T3IncomingShareFile) async throws -> URL
    var remove: @Sendable (String) async throws -> Void

    init(
        loadAll: @escaping @Sendable () async -> [T3IncomingShareEnvelope],
        data: @escaping @Sendable (T3IncomingShareImage) async throws -> Data,
        remove: @escaping @Sendable (String) async throws -> Void,
        fileURL: @escaping @Sendable (T3IncomingShareFile) async throws -> URL = { file in
            guard let url = T3IncomingShareStore.fileURL(for: file) else {
                throw PlatformIncomingShareError.missingFile(file.fileName)
            }
            return url
        }
    ) {
        self.loadAll = loadAll
        self.data = data
        self.fileURL = fileURL
        self.remove = remove
    }

    static let live = PlatformIncomingShareSource(
        loadAll: {
            await Task.detached(priority: .utility) {
                T3IncomingShareStore.loadAll()
            }.value
        },
        data: { image in
            guard let root = T3SharedContainer.rootURL?.standardizedFileURL,
                  let url = T3IncomingShareStore.fileURL(for: image)?.standardizedFileURL,
                  url.path.hasPrefix(root.path + "/") else {
                throw PlatformIncomingShareError.missingImage(image.fileName)
            }
            let data = try await Task.detached(priority: .userInitiated) {
                guard FileManager.default.fileExists(atPath: url.path) else {
                    throw PlatformIncomingShareError.missingImage(image.fileName)
                }
                return try Data(contentsOf: url, options: .mappedIfSafe)
            }.value
            guard !data.isEmpty,
                  data.count <= T3IncomingShareStore.maximumImageBytes,
                  data.count == image.byteCount else {
                throw PlatformIncomingShareError.invalidImage(image.fileName)
            }
            return data
        },
        remove: { id in
            guard UUID(uuidString: id) != nil else {
                throw PlatformIncomingShareError.invalidEnvelope
            }
            try await Task.detached(priority: .utility) {
                try T3IncomingShareStore.remove(id: id)
            }.value
        },
        fileURL: { file in
            guard let root = T3SharedContainer.rootURL?.standardizedFileURL,
                  let url = T3IncomingShareStore.fileURL(for: file)?.standardizedFileURL,
                  url.path.hasPrefix(root.path + "/") else {
                throw PlatformIncomingShareError.missingFile(file.fileName)
            }
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values.isRegularFile == true,
                  let byteCount = values.fileSize,
                  byteCount > 0,
                  byteCount <= T3IncomingShareStore.maximumFileBytes,
                  byteCount == file.byteCount else {
                throw PlatformIncomingShareError.invalidFile(file.fileName)
            }
            return url
        }
    )
}

struct PlatformIncomingShareDraftRepository: Sendable {
    var importContent: @Sendable (
        _ shareID: String,
        _ text: String,
        _ attachments: [FeatureDraftAttachment],
        _ key: String,
        _ maximumAttachmentCount: Int
    ) async throws -> FeatureComposerDraft

    static let live = PlatformIncomingShareDraftRepository(
        importContent: { shareID, text, attachments, key, maximumAttachmentCount in
            try await FeatureComposerDraftStore.shared.importSharedContent(
                shareID: shareID,
                text: text,
                attachments: attachments,
                for: key,
                maximumAttachmentCount: maximumAttachmentCount
            )
        }
    )
}

/// Moves one extension envelope into the durable new-task draft. The saved
/// attachment identifiers make the operation idempotent if inbox cleanup fails
/// after the atomic draft write.
struct PlatformIncomingSharePipeline: Sendable {
    static let maximumAttachmentCount = 8

    private let source: PlatformIncomingShareSource
    private let drafts: PlatformIncomingShareDraftRepository
    private let prepareImage: @Sendable (Data, Int) async throws -> FeatureDraftAttachment
    private let attachmentFileStore: ManagedAttachmentFileStore

    init(
        source: PlatformIncomingShareSource = .live,
        drafts: PlatformIncomingShareDraftRepository = .live,
        prepareImage: @escaping @Sendable (Data, Int) async throws -> FeatureDraftAttachment = {
            data,
            ordinal in
            try await Task.detached(priority: .userInitiated) {
                try FeatureImageProcessor.attachment(from: data, ordinal: ordinal)
            }.value
        },
        attachmentFileStore: ManagedAttachmentFileStore = ManagedAttachmentFileStore()
    ) {
        self.source = source
        self.drafts = drafts
        self.prepareImage = prepareImage
        self.attachmentFileStore = attachmentFileStore
    }

    func pendingEnvelopes() async -> [T3IncomingShareEnvelope] {
        await source.loadAll()
    }

    func importEnvelope(
        _ envelope: T3IncomingShareEnvelope,
        into project: FeatureProject,
        draftKey: String? = nil
    ) async throws -> FeatureComposerDraft {
        guard UUID(uuidString: envelope.id) != nil else {
            throw PlatformIncomingShareError.invalidEnvelope
        }
        guard envelope.images.count + envelope.files.count <= Self.maximumAttachmentCount else {
            throw PlatformIncomingShareError.invalidEnvelope
        }
        let key = draftKey ?? FeatureComposerDraftStore.newTaskKey(project: project)
        var prepared: [FeatureDraftAttachment] = []
        prepared.reserveCapacity(envelope.images.count + envelope.files.count)
        for (offset, image) in envelope.images.enumerated() {
            let data = try await source.data(image)
            let attachment = try await prepareImage(
                data,
                offset + 1
            )
            prepared.append(Self.stableAttachment(attachment, for: image))
        }
        for file in envelope.files {
            guard let attachmentID = UUID(uuidString: file.id) else {
                throw PlatformIncomingShareError.invalidEnvelope
            }
            let sourceURL = try await source.fileURL(file)
            let ownedFile: FeatureOwnedAttachmentFile
            do {
                ownedFile = try attachmentFileStore.copyOwnedFile(
                    from: sourceURL,
                    attachmentID: attachmentID,
                    originalFileName: file.fileName,
                    maximumBytes: T3IncomingShareStore.maximumFileBytes
                )
            } catch ManagedAttachmentFileError.alreadyExists {
                ownedFile = try Self.existingOwnedFile(
                    in: attachmentFileStore,
                    sourceURL: sourceURL,
                    attachmentID: attachmentID,
                    file: file
                )
            }
            guard ownedFile.byteCount == file.byteCount else {
                throw PlatformIncomingShareError.invalidFile(file.fileName)
            }
            prepared.append(FeatureDraftAttachment(
                id: attachmentID,
                ownedFile: ownedFile,
                thumbnailData: nil,
                filename: file.fileName,
                mimeType: file.mimeType,
                uploadedReference: nil
            ))
        }

        let merged = try await drafts.importContent(
            envelope.id,
            envelope.text,
            prepared,
            key,
            Self.maximumAttachmentCount
        )

        // The repository's actor operation atomically merges the latest draft
        // and records the share ID. Never acknowledge the inbox before it ends.
        try await source.remove(envelope.id)
        return merged
    }

    private static func existingOwnedFile(
        in store: ManagedAttachmentFileStore,
        sourceURL: URL,
        attachmentID: UUID,
        file: T3IncomingShareFile
    ) throws -> FeatureOwnedAttachmentFile {
        let pathExtension = URL(fileURLWithPath: file.fileName).pathExtension
        let ownedName = pathExtension.isEmpty
            ? attachmentID.uuidString
            : "\(attachmentID.uuidString).\(pathExtension.lowercased())"
        let existing = try store.resolvedFile(fileName: ownedName, byteCount: file.byteCount)
        let values = try existing.url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true,
              values.fileSize == file.byteCount,
              try filesMatch(sourceURL, existing.url) else {
            throw PlatformIncomingShareError.invalidFile(file.fileName)
        }
        return existing
    }

    private static func filesMatch(_ lhsURL: URL, _ rhsURL: URL) throws -> Bool {
        let lhs = try FileHandle(forReadingFrom: lhsURL)
        let rhs = try FileHandle(forReadingFrom: rhsURL)
        defer { try? lhs.close(); try? rhs.close() }
        while true {
            let left = try lhs.read(upToCount: 256 * 1_024) ?? Data()
            let right = try rhs.read(upToCount: 256 * 1_024) ?? Data()
            guard left == right else { return false }
            if left.isEmpty { return true }
        }
    }

    private static func stableAttachment(
        _ attachment: FeatureDraftAttachment,
        for image: T3IncomingShareImage
    ) -> FeatureDraftAttachment {
        FeatureDraftAttachment(
            id: UUID(uuidString: image.id) ?? attachment.id,
            data: attachment.data,
            thumbnailData: attachment.thumbnailData,
            filename: attachment.filename,
            mimeType: attachment.mimeType
        )
    }
}

@MainActor
@Observable
final class PlatformIncomingShareCoordinator {
    private(set) var pendingEnvelope: T3IncomingShareEnvelope?
    private(set) var isImporting = false

    private let pipeline: PlatformIncomingSharePipeline
    private var isRefreshing = false
    private var lastNoProjectNoticeID: String?

    init(pipeline: PlatformIncomingSharePipeline = PlatformIncomingSharePipeline()) {
        self.pipeline = pipeline
    }

    /// Returns true once per pending envelope when the app cannot offer a
    /// destination. The envelope remains in the shared container.
    func refresh(hasProjects: Bool) async -> Bool {
        guard pendingEnvelope == nil, !isRefreshing, !isImporting else {
            return pendingEnvelope != nil
                && !hasProjects
                && markNoProjectNoticeIfNeeded()
        }
        isRefreshing = true
        let envelopes = await pipeline.pendingEnvelopes()
        isRefreshing = false
        pendingEnvelope = envelopes.first
        guard pendingEnvelope != nil, !hasProjects else { return false }
        return markNoProjectNoticeIfNeeded()
    }

    func dismissDestination() {
        guard !isImporting else { return }
        pendingEnvelope = nil
    }

    func importPending(into project: FeatureProject, draftKey: String? = nil) async throws {
        guard let pendingEnvelope, !isImporting else { return }
        isImporting = true
        do {
            _ = try await pipeline.importEnvelope(
                pendingEnvelope,
                into: project,
                draftKey: draftKey
            )
            self.pendingEnvelope = nil
            lastNoProjectNoticeID = nil
            isImporting = false
        } catch {
            isImporting = false
            throw error
        }
    }

    private func markNoProjectNoticeIfNeeded() -> Bool {
        guard let id = pendingEnvelope?.id,
              lastNoProjectNoticeID != id else {
            return false
        }
        lastNoProjectNoticeID = id
        return true
    }
}

struct PlatformIncomingShareDestinationSheet: View {
    let envelope: T3IncomingShareEnvelope
    let projects: [FeatureProject]
    let environments: [FeatureEnvironment]
    let isImporting: Bool
    let onCancel: () -> Void
    let onSelect: (FeatureProject) -> Void

    var body: some View {
        NavigationStack {
            List {
                if !summary.isEmpty {
                    Section {
                        Text(summary)
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                    .listRowBackground(Color(uiColor: .systemBackground))
                }

                Section("Choose a project") {
                    ForEach(projects) { project in
                        Button {
                            onSelect(project)
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "folder")
                                    .foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(project.name)
                                        .font(.body.weight(.semibold))
                                        .foregroundStyle(.primary)
                                    if let environmentName = environmentName(for: project) {
                                        Text(environmentName)
                                            .font(.subheadline)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if isImporting {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Image(systemName: "chevron.right")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .frame(minHeight: 48)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(isImporting)
                        .listRowBackground(Color(uiColor: .systemBackground))
                    }
                }

                if !envelope.warnings.isEmpty {
                    Section {
                        ForEach(envelope.warnings, id: \.self) { warning in
                            Label(warning, systemImage: "exclamationmark.triangle")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .listRowBackground(Color(uiColor: .systemBackground))
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color(uiColor: .systemBackground))
            .navigationTitle("Start a task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .disabled(isImporting)
                }
            }
        }
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(isImporting)
    }

    private var summary: String {
        let attachmentCount = envelope.images.count + envelope.files.count
        if !envelope.text.isEmpty, attachmentCount > 0 {
            return "\(envelope.text)\n\(attachmentCount) file\(attachmentCount == 1 ? "" : "s")"
        }
        if !envelope.text.isEmpty { return envelope.text }
        guard attachmentCount > 0 else { return "" }
        return "\(attachmentCount) shared file\(attachmentCount == 1 ? "" : "s")"
    }

    private func environmentName(for project: FeatureProject) -> String? {
        guard environments.count > 1 else { return nil }
        return environments.first { $0.id == project.environmentID }?.name
    }
}
