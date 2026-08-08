import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

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
        pendingItemCount == 1 ? "Preparing image…" : "Preparing \(pendingItemCount) images…"
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

struct FeatureImageAttachmentPicker: View {
    private enum Source {
        case photoLibrary
        case camera
        case files
    }

    @Binding var attachments: [FeatureDraftAttachment]
    @Binding var preparationState: FeatureAttachmentPreparationState
    @Binding var isFlowActive: Bool
    let maximumCount: Int
    let isEnabled: Bool

    @State private var isAttachmentSourcePresented = false
    @State private var isPhotoLibraryPresented = false
    @State private var pendingPhotoLibraryItems: [FeaturePhotoLibraryItem] = []
    @State private var isCameraPresented = false
    @State private var isFileImporterPresented = false
    @State private var sourcePresentationTask: Task<Void, Never>?
    @State private var errorMessage: String?

    init(
        attachments: Binding<[FeatureDraftAttachment]>,
        preparationState: Binding<FeatureAttachmentPreparationState>,
        isFlowActive: Binding<Bool>,
        maximumCount: Int = 8,
        isEnabled: Bool = true
    ) {
        _attachments = attachments
        _preparationState = preparationState
        _isFlowActive = isFlowActive
        self.maximumCount = maximumCount
        self.isEnabled = isEnabled
    }

    var body: some View {
        Button {
            isFlowActive = true
            isAttachmentSourcePresented = true
        } label: {
            Image(systemName: preparationState.isPreparing ? "hourglass" : "paperclip")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canAdd)
        .opacity(canAdd ? 1 : 0.3)
        .accessibilityLabel(attachmentAccessibilityLabel)
        .accessibilityIdentifier("image-attachment-picker")
        .accessibilityHint(attachmentAccessibilityHint)
        .confirmationDialog("Add image", isPresented: $isAttachmentSourcePresented) {
            Button("Photo Library") { present(.photoLibrary) }
            Button("Camera") { present(.camera) }
                .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
            Button("Files") { present(.files) }
            Button("Cancel", role: .cancel) {
                isFlowActive = false
            }
        }
        .fullScreenCover(
            isPresented: $isPhotoLibraryPresented,
            onDismiss: finishPhotoLibrarySelection
        ) {
            FeaturePhotoLibraryPicker(
                maximumCount: max(1, remainingCount),
                onFinish: { items in
                    pendingPhotoLibraryItems = items
                    isPhotoLibraryPresented = false
                }
            )
            .ignoresSafeArea()
        }
        .fullScreenCover(isPresented: $isCameraPresented) {
            FeatureCameraPicker(
                onCapture: loadCapturedImage,
                onCancel: {
                    isCameraPresented = false
                    isFlowActive = false
                }
            )
            .ignoresSafeArea()
        }
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: [.image],
            allowsMultipleSelection: true,
            onCompletion: loadFiles
        )
        .alert(
            "Couldn’t add image",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
        .onDisappear {
            sourcePresentationTask?.cancel()
        }
    }

    private var remainingCount: Int {
        max(0, maximumCount - attachments.count)
    }

    private var canAdd: Bool {
        isEnabled && !preparationState.isPreparing && remainingCount > 0
    }

    private var attachmentAccessibilityLabel: String {
        if preparationState.isPreparing { return preparationState.statusLabel }
        if remainingCount == 0 { return "Attachment limit reached" }
        return "Add attachment"
    }

    private var attachmentAccessibilityHint: String {
        if !isEnabled { return "The selected model does not accept images" }
        if remainingCount == 0 { return "Remove an attachment before adding another" }
        return "Choose a photo, take a photo, or browse image files"
    }

    private func present(_ source: Source) {
        sourcePresentationTask?.cancel()
        isAttachmentSourcePresented = false
        sourcePresentationTask = Task { @MainActor in
            // A confirmation dialog is still the active presenter while its action
            // runs. Wait for its dismissal animation before presenting another
            // controller or UIKit can reject (or race) the new presentation.
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, canAdd else {
                isFlowActive = false
                return
            }
            switch source {
            case .photoLibrary:
                isPhotoLibraryPresented = true
            case .camera:
                isCameraPresented = true
            case .files:
                isFileImporterPresented = true
            }
        }
    }

    private func finishPhotoLibrarySelection() {
        Task { @MainActor in
            // Keep PhotosUI presentation and asset materialization in separate turns.
            // Some OS versions become stuck or dismiss mid-selection when the picker
            // and its selection are driven by the same SwiftUI binding transaction.
            await Task.yield()
            guard !isPhotoLibraryPresented, !pendingPhotoLibraryItems.isEmpty, canAdd else {
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
                    let data = try await item.loadData()
                    try await appendImage(
                        data,
                        ordinal: firstOrdinal + offset
                    )
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func loadCapturedImage(_ image: UIImage) {
        isCameraPresented = false
        guard canAdd else {
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
                let data = try await Task.detached(priority: .userInitiated) {
                    guard let data = image.jpegData(compressionQuality: 0.94) else {
                        throw FeatureImageAttachmentError.encodingFailed
                    }
                    return data
                }.value
                try await appendImage(data)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func loadFiles(_ result: Result<[URL], Error>) {
        defer { isFlowActive = false }
        switch result {
        case .failure(let error):
            errorMessage = error.localizedDescription
        case .success(let urls):
            guard !urls.isEmpty, canAdd else { return }
            let operation = preparationState.begin(itemCount: min(urls.count, remainingCount))

            Task {
                defer { preparationState.finish(operation) }
                for url in urls.prefix(remainingCount) {
                    do {
                        let data = try await Task.detached(priority: .userInitiated) {
                            let hasAccess = url.startAccessingSecurityScopedResource()
                            defer {
                                if hasAccess { url.stopAccessingSecurityScopedResource() }
                            }
                            return try Data(contentsOf: url, options: .mappedIfSafe)
                        }.value
                        try await appendImage(data)
                    } catch {
                        errorMessage = error.localizedDescription
                        break
                    }
                }
            }
        }
    }

    private func appendImage(_ data: Data, ordinal: Int? = nil) async throws {
        let ordinal = ordinal ?? attachments.count + 1
        let attachment = try await Task.detached(priority: .userInitiated) {
            try FeatureImageProcessor.attachment(from: data, ordinal: ordinal)
        }.value
        attachments.append(attachment)
    }
}

private struct FeaturePhotoLibraryItem: @unchecked Sendable {
    let provider: NSItemProvider

    func loadData() async throws -> Data {
        guard let typeIdentifier = provider.registeredTypeIdentifiers.first(where: { identifier in
            UTType(identifier)?.conforms(to: .image) == true
        }) else {
            throw FeatureImageAttachmentError.invalidImage
        }

        return try await withCheckedThrowingContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, error in
                if let data {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(
                        throwing: error ?? FeatureImageAttachmentError.encodingFailed
                    )
                }
            }
        }
    }
}

private struct FeaturePhotoLibraryPicker: UIViewControllerRepresentable {
    let maximumCount: Int
    let onFinish: @MainActor ([FeaturePhotoLibraryItem]) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onFinish: onFinish)
    }

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = maximumCount
        configuration.selection = .ordered
        configuration.preferredAssetRepresentationMode = .compatible

        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: PHPickerViewController, context: Context) {}

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        private let onFinish: @MainActor ([FeaturePhotoLibraryItem]) -> Void
        private var didFinish = false

        init(onFinish: @escaping @MainActor ([FeaturePhotoLibraryItem]) -> Void) {
            self.onFinish = onFinish
        }

        func picker(_: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard !didFinish else { return }
            didFinish = true

            let items = results.map { FeaturePhotoLibraryItem(provider: $0.itemProvider) }
            Task { @MainActor in
                onFinish(items)
            }
        }
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
            .accessibilityLabel("\(attachments.count) image attachments")
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
                } else {
                    Image(systemName: "photo")
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
            let data = attachment.thumbnailData ?? attachment.data
            image = await Task.detached(priority: .utility) {
                UIImage(data: data)
            }.value
        }
    }
}

private struct FeatureCameraPicker: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.cameraCaptureMode = .photo
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        private let onCapture: (UIImage) -> Void
        private let onCancel: () -> Void

        init(onCapture: @escaping (UIImage) -> Void, onCancel: @escaping () -> Void) {
            self.onCapture = onCapture
            self.onCancel = onCancel
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let image = info[.originalImage] as? UIImage else {
                onCancel()
                return
            }
            onCapture(image)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }
    }
}

enum FeatureImageProcessor {
    private static let maximumDimension: CGFloat = 2_048
    private static let maximumEncodedBytes = 10 * 1_024 * 1_024

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
