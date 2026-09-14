import Foundation

/// Resolve in the source environment. Its attachment IDs never enter the destination upload queue.
@MainActor
public protocol FeatureContextAttachmentResolving: AnyObject {
    func contextAttachmentAssetURL(
        environmentID: String,
        attachment: ComposerContextRecord.Attachment
    ) async throws -> URL
}

@MainActor
struct FeatureContextClipboardImporter {
    struct Result {
        let text: String
        let context: OrchestrationMessageContext
        let attachments: [FeatureDraftAttachment]

        func discardFiles(using store: ManagedAttachmentFileStore) {
            for attachment in attachments {
                if let file = attachment.ownedFile { try? store.removeOwnedFile(fileName: file.fileName) }
            }
        }
    }

    var fileStore = ManagedAttachmentFileStore()
    var draftStore = FeatureComposerDraftStore.shared
    var outboxStore = FeatureOutboxStore.shared
    var resolver: (any FeatureContextAttachmentResolving)?
    var download: (URL) async throws -> (URL, URLResponse) = {
        try await URLSession.shared.download(for: URLRequest(url: $0, timeoutInterval: 30))
    }

    func importContent(
        _ content: ComposerContextClipboard.Content,
        attachmentCount: Int,
        contextCount: Int,
        imagesAllowed: Bool,
        maximumFileBytes: Int?
    ) async throws -> Result {
        let content = try ComposerContextClipboard.reidentified(content)
        guard contextCount + content.fragment.records.count <= ComposerContextClipboard.maximumRecords else {
            throw ComposerContextClipboardError.contextLimit
        }
        let bindings = content.fragment.records.compactMap(\.attachment)
        guard attachmentCount + Set(bindings.map(\.attachmentId)).count <= FeatureImageAttachmentLimits.maximumCount else {
            throw FileAttachmentError.tooMany(maximum: FeatureImageAttachmentLimits.maximumCount)
        }
        var imported: [String: FeatureDraftAttachment] = [:]
        var ordered: [FeatureDraftAttachment] = []
        do {
            for record in content.fragment.records {
                try Task.checkCancellation()
                guard let binding = record.attachment else { continue }
                let maximum: Int
                if record.kind == "image" {
                    guard imagesAllowed else { throw ImageAttachmentError.invalidMIMEType }
                    maximum = UploadChatAttachment.maximumBytes
                } else {
                    guard let maximumFileBytes, maximumFileBytes > 0 else { throw FileAttachmentError.unsupported }
                    maximum = min(maximumFileBytes, ManagedAttachmentFileStore.maximumBytes)
                }
                if let previous = imported[binding.attachmentId] {
                    guard previous.filename == binding.name, previous.mimeType == binding.mimeType else {
                        throw ComposerContextClipboardError.invalidFragment
                    }
                    continue
                }
                guard binding.sizeBytes >= 0, binding.sizeBytes <= maximum else {
                    throw FileAttachmentError.tooLarge(actualBytes: binding.sizeBytes, maximumBytes: maximum)
                }
                let attachment = try await importAttachment(
                    binding, environmentID: content.fragment.source.environmentId, maximumBytes: maximum
                )
                imported[binding.attachmentId] = attachment
                ordered.append(attachment)
            }
            try Task.checkCancellation()
            let rebound = ComposerContextReferences.rebind(
                .init(records: content.fragment.records),
                attachmentIDs: imported.mapValues { $0.id.uuidString }
            )!
            return Result(text: content.text, context: rebound, attachments: ordered)
        } catch {
            Result(text: "", context: .init(records: []), attachments: ordered).discardFiles(using: fileStore)
            throw error
        }
    }

    private func importAttachment(
        _ binding: ComposerContextRecord.Attachment,
        environmentID: String,
        maximumBytes: Int
    ) async throws -> FeatureDraftAttachment {
        let retained = FeatureContextClipboard.retainedAttachment(environmentID: environmentID, attachmentID: binding.attachmentId)
        var local = if let retained { retained } else {
            try await draftStore.clipboardAttachment(environmentID: environmentID, attachmentID: binding.attachmentId)
        }
        if local == nil {
            let queued = try await outboxStore.submissions().filter { $0.environmentID == environmentID }
                .flatMap(\.uploads).first {
                    $0.id.uuidString.caseInsensitiveCompare(binding.attachmentId) == .orderedSame
                        || ($0.uploadedReference?.environmentID == environmentID
                            && $0.uploadedReference?.attachmentID == binding.attachmentId)
                }
            if let queued {
                if let file = queued.ownedFile {
                    local = FeatureDraftAttachment(id: queued.id, ownedFile: file, filename: queued.name, mimeType: queued.mimeType, source: queued.source)
                } else {
                    local = FeatureDraftAttachment(id: queued.id, data: queued.data, filename: queued.name, mimeType: queued.mimeType, source: queued.source)
                }
            }
        }
        try Task.checkCancellation()
        if let local {
            guard local.filename == binding.name,
                  local.mimeType.caseInsensitiveCompare(binding.mimeType) == .orderedSame else {
                throw ComposerContextClipboardError.invalidFragment
            }
            if let file = local.ownedFile, FileManager.default.fileExists(atPath: file.url.path) {
                return try await copyFile(file.url, binding: binding, maximumBytes: maximumBytes, source: local.source)
            }
            if local.ownedFile == nil, !local.data.isEmpty {
                guard local.byteCount <= maximumBytes else {
                    throw FileAttachmentError.tooLarge(actualBytes: local.byteCount, maximumBytes: maximumBytes)
                }
                if !binding.mimeType.hasPrefix("image/") {
                    let id = UUID()
                    let store = fileStore
                    let data = local.data
                    let file = try await Task.detached(priority: .userInitiated) {
                        try store.writeOwnedFile(data: data, attachmentID: id, originalFileName: binding.name, maximumBytes: maximumBytes)
                    }.value
                    return FeatureDraftAttachment(id: id, ownedFile: file, filename: binding.name, mimeType: binding.mimeType, source: local.source)
                }
                return FeatureDraftAttachment(
                    data: local.data, thumbnailData: local.thumbnailData,
                    filename: binding.name, mimeType: binding.mimeType, source: local.source
                )
            }
        }
        guard let resolver else { throw ComposerContextClipboardError.sourceUnavailable }
        let url = try await resolver.contextAttachmentAssetURL(environmentID: environmentID, attachment: binding)
        try Task.checkCancellation()
        let (temporary, response) = try await download(url)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse else { throw FeatureMediaPreviewError.invalidResponse }
        guard (200 ... 299).contains(response.statusCode) else { throw FeatureMediaPreviewError.httpStatus(response.statusCode) }
        return try await copyFile(temporary, binding: binding, maximumBytes: maximumBytes, source: local?.source)
    }

    private func copyFile(
        _ url: URL, binding: ComposerContextRecord.Attachment,
        maximumBytes: Int, source: PastedTextAttachmentSource?
    ) async throws -> FeatureDraftAttachment {
        let id = UUID()
        let store = fileStore
        let (file, thumbnail) = try await Task.detached(priority: .userInitiated) {
            let file = try store.copyOwnedFile(from: url, attachmentID: id, originalFileName: binding.name, maximumBytes: maximumBytes)
            let thumbnail = binding.mimeType.hasPrefix("image/") ? FeatureImageProcessor.thumbnail(fileURL: file.url) : nil
            return (file, thumbnail)
        }.value
        // Ownership passes to the caller even after cancellation, so its rollback removes this copy.
        return FeatureDraftAttachment(id: id, ownedFile: file, thumbnailData: thumbnail, filename: binding.name, mimeType: binding.mimeType, source: source)
    }
}
