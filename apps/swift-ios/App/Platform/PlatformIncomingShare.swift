import Foundation
import Observation
import SwiftUI

enum PlatformIncomingShareError: LocalizedError, Equatable {
    case missingImage(String)
    case invalidImage(String)
    case invalidEnvelope

    var errorDescription: String? {
        switch self {
        case let .missingImage(name):
            "The shared image \(name) is no longer available. Share it again to retry."
        case let .invalidImage(name):
            "The shared image \(name) is incomplete or too large. Share it again to retry."
        case .invalidEnvelope:
            "This shared item is invalid. Share it again to retry."
        }
    }
}

struct PlatformIncomingShareSource: Sendable {
    var loadAll: @Sendable () async -> [T3IncomingShareEnvelope]
    var data: @Sendable (T3IncomingShareImage) async throws -> Data
    var remove: @Sendable (String) async throws -> Void

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

    init(
        source: PlatformIncomingShareSource = .live,
        drafts: PlatformIncomingShareDraftRepository = .live,
        prepareImage: @escaping @Sendable (Data, Int) async throws -> FeatureDraftAttachment = {
            data,
            ordinal in
            try await Task.detached(priority: .userInitiated) {
                try FeatureImageProcessor.attachment(from: data, ordinal: ordinal)
            }.value
        }
    ) {
        self.source = source
        self.drafts = drafts
        self.prepareImage = prepareImage
    }

    func pendingEnvelopes() async -> [T3IncomingShareEnvelope] {
        await source.loadAll()
    }

    func importEnvelope(
        _ envelope: T3IncomingShareEnvelope,
        into project: FeatureProject
    ) async throws -> FeatureComposerDraft {
        guard UUID(uuidString: envelope.id) != nil else {
            throw PlatformIncomingShareError.invalidEnvelope
        }
        let key = FeatureComposerDraftStore.newTaskKey(project: project)
        var prepared: [FeatureDraftAttachment] = []
        prepared.reserveCapacity(envelope.images.count)
        for (offset, image) in envelope.images.enumerated() {
            let data = try await source.data(image)
            let attachment = try await prepareImage(
                data,
                offset + 1
            )
            prepared.append(Self.stableAttachment(attachment, for: image))
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

    func importPending(into project: FeatureProject) async throws {
        guard let pendingEnvelope, !isImporting else { return }
        isImporting = true
        do {
            _ = try await pipeline.importEnvelope(pendingEnvelope, into: project)
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
        if !envelope.text.isEmpty, !envelope.images.isEmpty {
            return "\(envelope.text)\n\(envelope.images.count) image\(envelope.images.count == 1 ? "" : "s")"
        }
        if !envelope.text.isEmpty { return envelope.text }
        guard !envelope.images.isEmpty else { return "" }
        return "\(envelope.images.count) shared image\(envelope.images.count == 1 ? "" : "s")"
    }

    private func environmentName(for project: FeatureProject) -> String? {
        guard environments.count > 1 else { return nil }
        return environments.first { $0.id == project.environmentID }?.name
    }
}
