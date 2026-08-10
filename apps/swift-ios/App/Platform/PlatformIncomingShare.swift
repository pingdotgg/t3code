import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import Observation
import SwiftUI
import UniformTypeIdentifiers

enum PlatformIncomingShareError: LocalizedError, Equatable {
    case missingImage(String)
    case invalidImage(String)
    case missingVideo(String)
    case invalidVideo(String)
    case unreadableVideo(String)
    case invalidEnvelope

    var errorDescription: String? {
        switch self {
        case let .missingImage(name):
            "The shared image \(name) is no longer available. Share it again to retry."
        case let .invalidImage(name):
            "The shared image \(name) is incomplete or too large. Share it again to retry."
        case let .missingVideo(name):
            "The shared video \(name) is no longer available. Share it again to retry."
        case let .invalidVideo(name):
            "The shared video \(name) is incomplete or too large. Share it again to retry."
        case let .unreadableVideo(name):
            "T3 Code could not create representative frames from \(name)."
        case .invalidEnvelope:
            "This shared item is invalid. Share it again to retry."
        }
    }
}

struct PlatformIncomingShareSource: Sendable {
    var loadAll: @Sendable () async -> [T3IncomingShareEnvelope]
    var data: @Sendable (T3IncomingShareImage) async throws -> Data
    var videoURL: @Sendable (T3IncomingShareVideo) async throws -> URL = { video in
        throw PlatformIncomingShareError.missingVideo(video.fileName)
    }
    var remove: @Sendable (String) async throws -> Void
    var updateDestination: @Sendable (
        String,
        T3IncomingShareDestination?
    ) async throws -> Void = { id, destination in
        try await Task.detached(priority: .utility) {
            try T3IncomingShareStore.updateDestination(id: id, destination: destination)
        }.value
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
        videoURL: { video in
            guard let root = T3SharedContainer.rootURL?.standardizedFileURL,
                  let url = T3IncomingShareStore.fileURL(for: video)?.standardizedFileURL,
                  url.path.hasPrefix(root.path + "/") else {
                throw PlatformIncomingShareError.missingVideo(video.fileName)
            }
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values.isRegularFile == true,
                  let byteCount = values.fileSize,
                  byteCount > 0,
                  byteCount <= T3IncomingShareStore.maximumVideoBytes,
                  byteCount == video.byteCount else {
                throw PlatformIncomingShareError.invalidVideo(video.fileName)
            }
            return url
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

struct PlatformIncomingShareDraftImport: Sendable {
    let draft: FeatureComposerDraft
    let didImport: Bool
}

struct PlatformIncomingShareImport: Sendable {
    let draft: FeatureComposerDraft
    let sharedContent: FeatureComposerIncomingShareDraft
}

struct PlatformIncomingShareDraftRepository: Sendable {
    var importContent: @Sendable (
        _ shareID: String,
        _ text: String,
        _ attachments: [FeatureDraftAttachment],
        _ key: String,
        _ maximumAttachmentCount: Int
    ) async throws -> PlatformIncomingShareDraftImport

    static let live = PlatformIncomingShareDraftRepository(
        importContent: { shareID, text, attachments, key, maximumAttachmentCount in
            let result = try await FeatureComposerDraftStore.shared.importSharedContentResult(
                shareID: shareID,
                text: text,
                attachments: attachments,
                for: key,
                maximumAttachmentCount: maximumAttachmentCount
            )
            return PlatformIncomingShareDraftImport(
                draft: result.draft,
                didImport: result.didImport
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
    private let prepareVideo: @Sendable (
        URL,
        T3IncomingShareVideo,
        Int
    ) async throws -> FeatureDraftAttachment

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
        prepareVideo: @escaping @Sendable (
            URL,
            T3IncomingShareVideo,
            Int
        ) async throws -> FeatureDraftAttachment = { url, video, ordinal in
            try await PlatformSharedVideoProcessor.contactSheetAttachment(
                videoURL: url,
                video: video,
                ordinal: ordinal
            )
        }
    ) {
        self.source = source
        self.drafts = drafts
        self.prepareImage = prepareImage
        self.prepareVideo = prepareVideo
    }

    func pendingEnvelopes() async -> [T3IncomingShareEnvelope] {
        await source.loadAll()
    }

    func importEnvelope(
        _ envelope: T3IncomingShareEnvelope,
        into project: FeatureProject
    ) async throws -> FeatureComposerDraft {
        try await importEnvelope(
            envelope,
            draftKey: FeatureComposerDraftStore.newTaskKey(project: project),
            removesEnvelope: true
        ).draft
    }

    func importEnvelope(
        _ envelope: T3IncomingShareEnvelope,
        into thread: FeatureThread
    ) async throws -> PlatformIncomingShareImport {
        try await importEnvelope(
            envelope,
            draftKey: FeatureComposerDraftStore.threadKey(thread),
            removesEnvelope: true
        )
    }

    func stageEnvelopeForNewThread(
        _ envelope: T3IncomingShareEnvelope
    ) async throws -> FeatureComposerDraft {
        try await importEnvelope(
            envelope,
            draftKey: FeatureComposerDraftStore.incomingShareKey(shareID: envelope.id),
            removesEnvelope: false
        ).draft
    }

    func acknowledgeEnvelope(id: String) async throws {
        try await source.remove(id)
    }

    func updateDestination(
        id: String,
        destination: T3IncomingShareDestination?
    ) async throws {
        try await source.updateDestination(id, destination)
    }

    private func importEnvelope(
        _ envelope: T3IncomingShareEnvelope,
        draftKey: String,
        removesEnvelope: Bool
    ) async throws -> PlatformIncomingShareImport {
        guard UUID(uuidString: envelope.id) != nil else {
            throw PlatformIncomingShareError.invalidEnvelope
        }
        var prepared: [FeatureDraftAttachment] = []
        prepared.reserveCapacity(envelope.images.count + envelope.videos.count)
        for (offset, image) in envelope.images.enumerated() {
            let data = try await source.data(image)
            let attachment = try await prepareImage(
                data,
                offset + 1
            )
            prepared.append(Self.stableAttachment(attachment, for: image))
        }

        for (offset, video) in envelope.videos.enumerated() {
            let url = try await source.videoURL(video)
            let attachment = try await prepareVideo(
                url,
                video,
                envelope.images.count + offset + 1
            )
            prepared.append(Self.stableAttachment(attachment, for: video))
        }

        let sharedText = Self.composerText(for: envelope)
        let imported = try await drafts.importContent(
            envelope.id,
            sharedText,
            prepared,
            draftKey,
            Self.maximumAttachmentCount
        )

        // The repository's actor operation atomically merges the latest draft
        // and records the share ID. Never acknowledge the inbox before it ends.
        if removesEnvelope {
            try await source.remove(envelope.id)
        }
        return PlatformIncomingShareImport(
            draft: imported.draft,
            sharedContent: FeatureComposerIncomingShareDraft(
                shareID: envelope.id,
                draft: FeatureComposerDraft(text: sharedText, attachments: prepared)
            )
        )
    }

    private static func composerText(for envelope: T3IncomingShareEnvelope) -> String {
        var fragments = [envelope.text].filter { !$0.isEmpty }
        fragments.append(contentsOf: envelope.videos.map { video in
            "Shared video: \(video.fileName) (representative frames attached as a contact sheet)."
        })
        return fragments.joined(separator: "\n\n")
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

    private static func stableAttachment(
        _ attachment: FeatureDraftAttachment,
        for video: T3IncomingShareVideo
    ) -> FeatureDraftAttachment {
        FeatureDraftAttachment(
            id: UUID(uuidString: video.id) ?? attachment.id,
            data: attachment.data,
            thumbnailData: attachment.thumbnailData,
            filename: attachment.filename,
            mimeType: attachment.mimeType
        )
    }
}

enum PlatformSharedVideoProcessor {
    private static let frameCount = 6
    private static let cellSize = CGSize(width: 640, height: 360)

    static func contactSheetAttachment(
        videoURL: URL,
        video: T3IncomingShareVideo,
        ordinal: Int
    ) async throws -> FeatureDraftAttachment {
        let data = try await Task.detached(priority: .userInitiated) {
            let asset = AVURLAsset(url: videoURL)
            let duration = try await asset.load(.duration)
            let seconds = duration.seconds
            guard seconds.isFinite, seconds > 0 else {
                throw PlatformIncomingShareError.unreadableVideo(video.fileName)
            }

            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = cellSize
            generator.requestedTimeToleranceBefore = CMTime(seconds: 0.25, preferredTimescale: 600)
            generator.requestedTimeToleranceAfter = CMTime(seconds: 0.25, preferredTimescale: 600)

            let fractions = (0..<frameCount).map {
                (Double($0) + 0.5) / Double(frameCount)
            }
            var frames: [CGImage] = []
            for fraction in fractions {
                try Task.checkCancellation()
                let time = CMTime(seconds: seconds * fraction, preferredTimescale: 600)
                if let image = try? generator.copyCGImage(at: time, actualTime: nil) {
                    frames.append(image)
                }
            }
            guard !frames.isEmpty else {
                throw PlatformIncomingShareError.unreadableVideo(video.fileName)
            }
            return try jpegContactSheet(frames: frames, videoName: video.fileName)
        }.value

        return try FeatureImageProcessor.attachment(from: data, ordinal: ordinal)
    }

    private static func jpegContactSheet(frames: [CGImage], videoName: String) throws -> Data {
        let columns = min(2, frames.count)
        let rows = Int(ceil(Double(frames.count) / Double(columns)))
        let width = Int(cellSize.width) * columns
        let height = Int(cellSize.height) * rows
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                  data: nil,
                  width: width,
                  height: height,
                  bitsPerComponent: 8,
                  bytesPerRow: 0,
                  space: colorSpace,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else {
            throw PlatformIncomingShareError.unreadableVideo(videoName)
        }

        context.setFillColor(CGColor(gray: 0.04, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        for (index, frame) in frames.enumerated() {
            let column = index % columns
            let row = rows - 1 - (index / columns)
            let cell = CGRect(
                x: CGFloat(column) * cellSize.width,
                y: CGFloat(row) * cellSize.height,
                width: cellSize.width,
                height: cellSize.height
            )
            let scale = min(
                cell.width / CGFloat(frame.width),
                cell.height / CGFloat(frame.height)
            )
            let size = CGSize(
                width: CGFloat(frame.width) * scale,
                height: CGFloat(frame.height) * scale
            )
            let frameRect = CGRect(
                x: cell.midX - size.width / 2,
                y: cell.midY - size.height / 2,
                width: size.width,
                height: size.height
            )
            context.draw(frame, in: frameRect)
        }

        guard let image = context.makeImage() else {
            throw PlatformIncomingShareError.unreadableVideo(videoName)
        }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            throw PlatformIncomingShareError.unreadableVideo(videoName)
        }
        CGImageDestinationAddImage(
            destination,
            image,
            [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else {
            throw PlatformIncomingShareError.unreadableVideo(videoName)
        }
        return data as Data
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
    func refresh(preferredID: String? = nil, hasProjects: Bool) async -> Bool {
        guard pendingEnvelope == nil, !isRefreshing, !isImporting else {
            return pendingEnvelope != nil
                && pendingEnvelope?.destination == nil
                && !hasProjects
                && markNoProjectNoticeIfNeeded()
        }
        isRefreshing = true
        let envelopes = await pipeline.pendingEnvelopes()
        isRefreshing = false
        if let preferredID {
            pendingEnvelope = envelopes.first {
                $0.id.caseInsensitiveCompare(preferredID) == .orderedSame
            }
        } else {
            pendingEnvelope = envelopes.first
        }
        guard pendingEnvelope != nil,
              pendingEnvelope?.destination == nil,
              !hasProjects else { return false }
        return markNoProjectNoticeIfNeeded()
    }

    func dismissDestination() {
        guard !isImporting else { return }
        pendingEnvelope = nil
    }

    func requestAnotherDestination() async throws {
        guard !isImporting else { return }
        guard let id = pendingEnvelope?.id else { return }
        try await pipeline.updateDestination(id: id, destination: nil)
        pendingEnvelope?.destination = nil
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

    func importPending(into thread: FeatureThread) async throws -> PlatformIncomingShareImport? {
        guard let pendingEnvelope, !isImporting else { return nil }
        isImporting = true
        do {
            let imported = try await pipeline.importEnvelope(pendingEnvelope, into: thread)
            self.pendingEnvelope = nil
            lastNoProjectNoticeID = nil
            isImporting = false
            return imported
        } catch {
            isImporting = false
            throw error
        }
    }

    func stagePendingForNewThread() async throws -> String? {
        guard let pendingEnvelope, !isImporting else { return nil }
        isImporting = true
        do {
            _ = try await pipeline.stageEnvelopeForNewThread(pendingEnvelope)
            isImporting = false
            return pendingEnvelope.id
        } catch {
            isImporting = false
            throw error
        }
    }

    func acknowledgeStagedNewThread(id: String) async throws {
        try await pipeline.acknowledgeEnvelope(id: id)
        if pendingEnvelope?.id.caseInsensitiveCompare(id) == .orderedSame {
            pendingEnvelope = nil
        }
        lastNoProjectNoticeID = nil
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
        var fragments = [envelope.text].filter { !$0.isEmpty }
        if !envelope.images.isEmpty {
            fragments.append(
                "\(envelope.images.count) image\(envelope.images.count == 1 ? "" : "s")"
            )
        }
        if !envelope.videos.isEmpty {
            fragments.append(
                "\(envelope.videos.count) video\(envelope.videos.count == 1 ? "" : "s")"
            )
        }
        return fragments.joined(separator: "\n")
    }

    private func environmentName(for project: FeatureProject) -> String? {
        guard environments.count > 1 else { return nil }
        return environments.first { $0.id == project.environmentID }?.name
    }
}
