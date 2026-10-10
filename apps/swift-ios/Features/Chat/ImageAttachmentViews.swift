import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import UIKit

enum FeatureImageAttachmentLimits {
    /// Shared by every attachment entry point (picker, camera, files, and
    /// paste), so their in-flight reservations count against the same cap.
    static let maximumCount = 100
}

struct FeatureAttachmentPreparationState: Equatable {
    struct Operation: Hashable {
        fileprivate let id: UUID
    }

    private var pendingItemsByOperation: [Operation: Int] = [:]

    var isPreparing: Bool {
        !pendingItemsByOperation.isEmpty
    }

    var pendingItemCount: Int {
        pendingItemsByOperation.values.reduce(0, +)
    }

    var statusLabel: String {
        pendingItemCount == 1
            ? "Preparing attachment…"
            : "Preparing \(pendingItemCount) attachments…"
    }

    @discardableResult
    mutating func begin(itemCount: Int, id: UUID = UUID()) -> Operation {
        let operation = Operation(id: id)
        pendingItemsByOperation[operation] = max(1, itemCount)
        return operation
    }

    mutating func finish(_ operation: Operation) {
        pendingItemsByOperation.removeValue(forKey: operation)
    }
}

struct FeatureAttachmentOperationIdentity: Equatable {
    let ownerID: String
    let environmentID: String?
    let generation: UUID

    func matches(ownerID: String, environmentID: String?, generation: UUID) -> Bool {
        self.ownerID == ownerID
            && self.environmentID == environmentID
            && self.generation == generation
    }
}

struct FeatureImageAttachmentPicker: View {
    @SwiftUI.Environment(\.featureThreadPresentationDismissal) private var presentationDismissal

    @Binding var attachments: [FeatureDraftAttachment]
    @Binding var preparationState: FeatureAttachmentPreparationState
    @Binding var isFlowActive: Bool
    let maximumCount: Int
    let draftOwnerID: String
    let environmentID: String?
    let imagesAllowed: Bool
    let maximumFileBytes: Int?

    @State private var sourceRequestID: UUID?
    @State private var presentationID = UUID()
    @State private var isNativePickerPresented = false
    @State private var pendingPhotoLibraryItems: [FeaturePhotoLibraryItem] = []
    @State private var errorMessage: String?
    @State private var generation = UUID()
    @State private var flowIdentity: FeatureAttachmentOperationIdentity?

    init(
        attachments: Binding<[FeatureDraftAttachment]>,
        preparationState: Binding<FeatureAttachmentPreparationState>,
        isFlowActive: Binding<Bool>,
        draftOwnerID: String,
        environmentID: String?,
        imagesAllowed: Bool,
        maximumFileBytes: Int?,
        maximumCount: Int = FeatureImageAttachmentLimits.maximumCount
    ) {
        _attachments = attachments
        _preparationState = preparationState
        _isFlowActive = isFlowActive
        self.maximumCount = maximumCount
        self.draftOwnerID = draftOwnerID
        self.environmentID = environmentID
        self.imagesAllowed = imagesAllowed
        self.maximumFileBytes = maximumFileBytes
    }

    var body: some View {
        Button {
            guard presentationDismissal.requestID == nil else { return }
            flowIdentity = FeatureAttachmentOperationIdentity(
                ownerID: draftOwnerID,
                environmentID: environmentID,
                generation: generation
            )
            isFlowActive = true
            sourceRequestID = UUID()
        } label: {
            Image(systemName: preparationState.isPreparing ? "hourglass" : "paperclip")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canAdd || isFlowActive)
        .opacity(canAdd ? 1 : 0.3)
        .accessibilityLabel(attachmentAccessibilityLabel)
        .accessibilityIdentifier("image-attachment-picker")
        .accessibilityHint(attachmentAccessibilityHint)
        .background {
            FeatureAttachmentPickerPresenter(
                requestID: presentationDismissal.requestID == nil ? sourceRequestID : nil,
                maximumCount: max(1, remainingCount),
                imagesAllowed: imagesAllowed,
                videosAllowed: maximumFileBytes != nil,
                onPresentationChange: {
                    isNativePickerPresented = $0
                    if !$0, flowIdentity == nil { isFlowActive = false }
                    presentationDismissal.onPresentationChange(presentationID, $0)
                },
                onFinish: finishSelection
            )
            .allowsHitTesting(false)
        }
        .alert(
            "Couldn’t add attachment",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
        .onChange(of: draftOwnerID) { cancelSelection() }
        .onChange(of: environmentID) { cancelSelection() }
        .onChange(of: presentationDismissal.requestID, initial: true) { _, requestID in
            if requestID != nil { cancelSelection() }
        }
    }

    private var remainingCount: Int {
        max(0, maximumCount - attachments.count)
    }

    private var canAdd: Bool {
        (imagesAllowed || maximumFileBytes != nil)
            && !preparationState.isPreparing && remainingCount > 0
    }

    private var attachmentAccessibilityLabel: String {
        if preparationState.isPreparing { return preparationState.statusLabel }
        if remainingCount == 0 { return "Attachment limit reached" }
        return "Add attachment"
    }

    private var attachmentAccessibilityHint: String {
        if !imagesAllowed && maximumFileBytes == nil { return "Attachments are not supported" }
        if remainingCount == 0 { return "Remove an attachment before adding another" }
        return maximumFileBytes == nil
            ? "Choose a photo, take a photo, or browse image files"
            : "Choose a photo, video, or file"
    }

    private func cancelSelection() {
        sourceRequestID = nil
        generation = UUID()
        flowIdentity = nil
        pendingPhotoLibraryItems = []
        errorMessage = nil
        // Keep an empty composer and its UIKit presenter mounted until the
        // picker has finished closing, including during a root route change.
        if !isNativePickerPresented { isFlowActive = false }
    }

    private func finishSelection(_ selection: FeatureAttachmentPickerSelection?) {
        sourceRequestID = nil
        guard presentationDismissal.requestID == nil, flowIdentity != nil else {
            if !isNativePickerPresented { isFlowActive = false }
            return
        }
        switch selection {
        case let .photos(providers):
            pendingPhotoLibraryItems = providers.map { FeaturePhotoLibraryItem(provider: $0) }
            finishPhotoLibrarySelection()
        case let .image(image):
            loadCapturedImage(image)
        case let .files(urls):
            loadFiles(.success(urls))
        case nil:
            isFlowActive = false
        }
    }

    private func finishPhotoLibrarySelection() {
        guard let identity = flowIdentity else {
            pendingPhotoLibraryItems = []
            isFlowActive = false
            return
        }
        Task { @MainActor in
            // Start materialization after the picker completion returns to UIKit.
            await Task.yield()
            guard !pendingPhotoLibraryItems.isEmpty, canAdd else {
                pendingPhotoLibraryItems = []
                isFlowActive = false
                return
            }

            let selected = Array(pendingPhotoLibraryItems.prefix(remainingCount))
            pendingPhotoLibraryItems = []
            let firstOrdinal = attachments.count + preparationState.pendingItemCount + 1
            let operation = preparationState.begin(itemCount: selected.count)

            defer {
                preparationState.finish(operation)
                isFlowActive = false
            }

            for (offset, item) in selected.enumerated() {
                do {
                    let attachment = try await item.loadAttachment(
                        ordinal: firstOrdinal + offset,
                        maximumFileBytes: maximumFileBytes
                    )
                    guard identity.matches(
                        ownerID: draftOwnerID,
                        environmentID: environmentID,
                        generation: generation
                    ) else {
                        discardOwnedFile(for: attachment)
                        return
                    }
                    if attachment.mimeType.hasPrefix("image/"), !imagesAllowed {
                        throw FeatureAttachmentIntakeError.imagesUnsupported
                    }
                    attachments.append(attachment)
                } catch {
                    guard identity.matches(
                        ownerID: draftOwnerID, environmentID: environmentID, generation: generation
                    ) else { return }
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func loadCapturedImage(_ image: UIImage) {
        guard canAdd else {
            isFlowActive = false
            return
        }
        guard let identity = flowIdentity else {
            isFlowActive = false
            return
        }
        let operation = preparationState.begin(itemCount: 1)

        Task {
            defer {
                preparationState.finish(operation)
                isFlowActive = false
            }
            do {
                let ordinal = attachments.count + 1
                let data = try await Task.detached(priority: .userInitiated) {
                    guard let data = image.jpegData(compressionQuality: 0.94) else {
                        throw FeatureImageAttachmentError.encodingFailed
                    }
                    return data
                }.value
                let attachment = try await Task.detached(priority: .userInitiated) {
                    try FeatureImageProcessor.attachment(from: data, ordinal: ordinal)
                }.value
                guard identity.matches(
                    ownerID: draftOwnerID,
                    environmentID: environmentID,
                    generation: generation
                ) else { return }
                attachments.append(attachment)
            } catch {
                guard identity.matches(
                    ownerID: draftOwnerID, environmentID: environmentID, generation: generation
                ) else { return }
                errorMessage = error.localizedDescription
            }
        }
    }

    private func loadFiles(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            errorMessage = error.localizedDescription
            isFlowActive = false
        case .success(let urls):
            guard !urls.isEmpty, canAdd, let identity = flowIdentity else {
                isFlowActive = false
                return
            }
            let operation = preparationState.begin(itemCount: min(urls.count, remainingCount))

            Task {
                defer {
                    preparationState.finish(operation)
                    isFlowActive = false
                }
                for url in urls.prefix(remainingCount) {
                    do {
                        let attachment = try await prepareFile(url)
                        guard identity.matches(
                            ownerID: draftOwnerID,
                            environmentID: environmentID,
                            generation: generation
                        ) else {
                            discardOwnedFile(for: attachment)
                            return
                        }
                        attachments.append(attachment)
                    } catch {
                        guard identity.matches(
                            ownerID: draftOwnerID, environmentID: environmentID, generation: generation
                        ) else { return }
                        errorMessage = error.localizedDescription
                        break
                    }
                }
            }
        }
    }

    private func prepareFile(_ url: URL) async throws -> FeatureDraftAttachment {
        let type = UTType(filenameExtension: url.pathExtension)
        if type?.conforms(to: .image) == true {
            guard imagesAllowed else { throw FeatureAttachmentIntakeError.imagesUnsupported }
            let ordinal = attachments.count + 1
            let data = try await Task.detached(priority: .userInitiated) {
                let hasAccess = url.startAccessingSecurityScopedResource()
                defer { if hasAccess { url.stopAccessingSecurityScopedResource() } }
                return try Data(contentsOf: url, options: .mappedIfSafe)
            }.value
            return try await Task.detached(priority: .userInitiated) {
                try FeatureImageProcessor.attachment(from: data, ordinal: ordinal)
            }.value
        }
        guard let maximumFileBytes else { throw FeatureAttachmentIntakeError.filesUnsupported }
        let id = UUID()
        let owned = try await Task.detached(priority: .userInitiated) {
            try ManagedAttachmentFileStore().copyOwnedFile(
                from: url,
                attachmentID: id,
                originalFileName: url.lastPathComponent,
                maximumBytes: maximumFileBytes
            )
        }.value
        return FeatureDraftAttachment(
            id: id,
            ownedFile: owned,
            filename: url.lastPathComponent,
            mimeType: type?.preferredMIMEType ?? "application/octet-stream"
        )
    }

    private func discardOwnedFile(for attachment: FeatureDraftAttachment) {
        guard let fileName = attachment.ownedFile?.fileName else { return }
        try? ManagedAttachmentFileStore().removeOwnedFile(fileName: fileName)
    }
}

private struct FeaturePhotoLibraryItem: @unchecked Sendable {
    let provider: NSItemProvider

    @MainActor
    func loadAttachment(
        ordinal: Int,
        maximumFileBytes: Int?
    ) async throws -> FeatureDraftAttachment {
        if provider.registeredTypeIdentifiers.contains(where: {
            UTType($0)?.conforms(to: .image) == true
        }) {
            let data = try await FeatureImageItemProviderLoader.data(from: provider)
            return try await Task.detached(priority: .userInitiated) {
                try FeatureImageProcessor.attachment(from: data, ordinal: ordinal)
            }.value
        }
        guard let maximumFileBytes else { throw FeatureAttachmentIntakeError.filesUnsupported }
        return try await FeatureFileItemProviderLoader.attachment(
            from: provider,
            maximumBytes: maximumFileBytes
        )
    }
}

enum FeatureFileItemProviderLoader {
    @MainActor
    static func attachment(
        from provider: NSItemProvider,
        maximumBytes: Int
    ) async throws -> FeatureDraftAttachment {
        guard let identifier = provider.registeredTypeIdentifiers.first(where: {
            UTType($0)?.conforms(to: .movie) == true
                || UTType($0)?.conforms(to: .item) == true
        }) else { throw FeatureAttachmentIntakeError.invalidFile }
        let type = UTType(identifier)
        let id = UUID()
        let preferredExtension = type?.preferredFilenameExtension
        let suggestedName = provider.suggestedName ?? "Attachment"
        let suggestedURL = URL(fileURLWithPath: suggestedName)
        let fileName = suggestedURL.pathExtension.isEmpty
            ? preferredExtension.map { "\(suggestedName).\($0)" } ?? suggestedName
            : suggestedName

        return try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, error in
                do {
                    guard let url else {
                        throw error ?? FeatureAttachmentIntakeError.invalidFile
                    }
                    // The provider deletes this URL when the callback returns.
                    let owned = try ManagedAttachmentFileStore().copyOwnedFile(
                        from: url,
                        attachmentID: id,
                        originalFileName: fileName,
                        maximumBytes: maximumBytes
                    )
                    continuation.resume(returning: FeatureDraftAttachment(
                        id: id,
                        ownedFile: owned,
                        filename: fileName,
                        mimeType: type?.preferredMIMEType ?? "application/octet-stream"
                    ))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}

/// Loads raw image bytes from an `NSItemProvider`, shared by the photo
/// library picker and the composer's paste path. Main-actor isolated because
/// providers arrive from main-actor UI callbacks and are not `Sendable`; the
/// provider does its own work off-thread.
enum FeatureImageItemProviderLoader {
    struct Load {
        fileprivate let values: AsyncThrowingStream<Data, Error>

        @MainActor
        func data() async throws -> Data {
            for try await data in values {
                return data
            }
            throw FeatureImageAttachmentError.encodingFailed
        }
    }

    /// Starts the provider request before returning. Drop callers use this
    /// form so access begins within `performDrop`, while the provider grant is
    /// active.
    @MainActor
    static func start(from provider: NSItemProvider) throws -> Load {
        guard let typeIdentifier = provider.registeredTypeIdentifiers.first(where: { identifier in
            UTType(identifier)?.conforms(to: .image) == true
        }) else {
            throw FeatureImageAttachmentError.invalidImage
        }

        let values = AsyncThrowingStream<Data, Error> { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, error in
                if let data {
                    continuation.yield(data)
                    continuation.finish()
                } else {
                    continuation.finish(
                        throwing: error ?? FeatureImageAttachmentError.encodingFailed
                    )
                }
            }
        }
        return Load(values: values)
    }

    @MainActor
    static func data(from provider: NSItemProvider) async throws -> Data {
        try await start(from: provider).data()
    }
}

struct FeatureAttachmentStrip: View {
    @Binding var attachments: [FeatureDraftAttachment]

    var body: some View {
        if !attachments.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(attachments) { attachment in
                        FeatureAttachmentThumbnail(attachment: attachment) {
                            attachments.removeAll { $0.id == attachment.id }
                        }
                    }
                }
                .padding(.horizontal, 1)
            }
            .scrollIndicators(.hidden)
            .accessibilityLabel("\(attachments.count) attachments")
        }
    }
}

private struct FeatureAttachmentThumbnail: View {
    let attachment: FeatureDraftAttachment
    let onRemove: () -> Void
    @State private var image: UIImage?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else if attachment.mimeType.hasPrefix("image/") {
                    Image(systemName: "photo")
                        .foregroundStyle(T3Colors.textSecondary)
                } else {
                    VStack(spacing: 3) {
                        Image(systemName: "doc")
                        Text(attachment.filename)
                            .font(.caption2)
                            .lineLimit(1)
                        Text(ByteCountFormatter.string(
                            fromByteCount: Int64(attachment.byteCount),
                            countStyle: .file
                        ))
                        .font(.caption2)
                    }
                    .foregroundStyle(T3Colors.textSecondary)
                }
            }
            .frame(width: 58, height: 58)
            .background(T3Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 22, height: 22)
                    .background(.black.opacity(0.78), in: Circle())
                    .frame(
                        width: T3Metrics.minimumTapTarget,
                        height: T3Metrics.minimumTapTarget
                    )
                    .contentShape(Rectangle())
            }
            .offset(x: 11, y: -11)
            .accessibilityLabel("Remove \(attachment.filename)")
        }
        .padding(.top, 11)
        .padding(.trailing, 11)
        .task(id: attachment.id) {
            guard attachment.mimeType.hasPrefix("image/") else { return }
            let data = attachment.thumbnailData ?? attachment.data
            image = await Task.detached(priority: .utility) {
                UIImage(data: data)
            }.value
        }
    }
}

enum FeatureImageProcessor {
    private static let maximumDimension: CGFloat = 2_048
    private static let maximumEncodedBytes = 10 * 1_024 * 1_024

    static func thumbnail(fileURL: URL) -> Data? {
        guard let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: 160,
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image).jpegData(compressionQuality: 0.72)
    }

    static func attachment(
        from sourceData: Data,
        ordinal: Int
    ) throws -> FeatureDraftAttachment {
        guard let source = CGImageSourceCreateWithData(sourceData as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(
                  source,
                  0,
                  [
                      kCGImageSourceCreateThumbnailFromImageAlways: true,
                      kCGImageSourceCreateThumbnailWithTransform: true,
                      kCGImageSourceThumbnailMaxPixelSize: maximumDimension,
                      kCGImageSourceShouldCacheImmediately: true,
                  ] as CFDictionary
              ) else {
            throw FeatureImageAttachmentError.invalidImage
        }

        let preparedImage = UIImage(cgImage: image)
        guard let data = preparedImage.jpegData(compressionQuality: 0.82),
              let thumbnailData = thumbnail(from: preparedImage) else {
            throw FeatureImageAttachmentError.encodingFailed
        }
        guard data.count <= maximumEncodedBytes else {
            throw FeatureImageAttachmentError.tooLarge
        }

        return FeatureDraftAttachment(
            data: data,
            thumbnailData: thumbnailData,
            filename: "Image \(ordinal).jpg",
            mimeType: "image/jpeg"
        )
    }

    private static func thumbnail(from image: UIImage) -> Data? {
        let longestSide = max(image.size.width, image.size.height)
        let scale = min(1, 160 / longestSide)
        let size = CGSize(
            width: max(1, image.size.width * scale),
            height: max(1, image.size.height * scale)
        )
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }.jpegData(compressionQuality: 0.72)
    }
}

enum FeatureImageAttachmentError: LocalizedError {
    case invalidImage
    case encodingFailed
    case tooLarge

    var errorDescription: String? {
        switch self {
        case .invalidImage:
            "That photo could not be read."
        case .encodingFailed:
            "That photo could not be prepared."
        case .tooLarge:
            "Images must be smaller than 10 MB."
        }
    }
}

enum FeatureAttachmentIntakeError: LocalizedError {
    case invalidFile
    case filesUnsupported
    case imagesUnsupported

    var errorDescription: String? {
        switch self {
        case .invalidFile: "That file could not be read."
        case .filesUnsupported: "This environment does not accept file attachments."
        case .imagesUnsupported: "The selected model does not accept images."
        }
    }
}
