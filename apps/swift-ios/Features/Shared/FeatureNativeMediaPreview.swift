import AVKit
import Foundation
import QuickLook
import SwiftUI
import UIKit

enum FeatureMediaPreviewSource: Equatable {
    case localImage(Data)
    case file(URL)
    case remote(URL)
}

struct FeatureTypedMediaPreviewRoute: Equatable {
    let path: String
    let kind: FeatureFilePreviewKind

    static func parse(_ url: URL) -> Self? {
        guard url.scheme?.lowercased() == "t3code",
              url.host?.lowercased() == "media-preview",
              url.path == "/open",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let path = components.queryItems?.first(where: { $0.name == "path" })?.value,
              !path.isEmpty, path.count <= 1_024,
              let rawKind = components.queryItems?.first(where: { $0.name == "kind" })?.value
        else { return nil }
        let kind: FeatureFilePreviewKind
        switch rawKind {
        case "image": kind = .image
        case "video": kind = .video
        case "pdf": kind = .pdf
        case "document": kind = .document
        default: return nil
        }
        return Self(path: path, kind: kind)
    }
}

struct FeatureMediaPreviewGeneration {
    private(set) var value = 0
    mutating func begin() -> Int {
        value += 1
        return value
    }
    mutating func invalidate() { value += 1 }
    func isCurrent(_ candidate: Int) -> Bool { value == candidate }
}

enum FeatureMediaPreviewError: LocalizedError, Equatable {
    case invalidResponse
    case httpStatus(Int)
    case tooLarge
    case invalidFileName

    var errorDescription: String? {
        switch self {
        case .invalidResponse: "The server returned an invalid file."
        case let .httpStatus(status): "The server returned HTTP \(status)."
        case .tooLarge: "The file is too large to preview."
        case .invalidFileName: "The file name is invalid."
        }
    }
}

enum FeatureMediaPreviewFiles {
    static let maximumBytes: Int64 = 64 * 1_024 * 1_024

    static func safeFileName(_ proposedName: String) throws -> String {
        let name = URL(fileURLWithPath: proposedName).lastPathComponent
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != ".", name != "..", name.utf8.count <= 255,
              !name.contains("/") else {
            throw FeatureMediaPreviewError.invalidFileName
        }
        return name.replacingOccurrences(of: ":", with: "_")
    }

    static func ownedDirectory(fileManager: FileManager = .default) throws -> URL {
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("T3CodePreviews", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    static func shareURL(
        for source: FeatureMediaPreviewSource,
        downloadedURL: URL?
    ) -> URL? {
        switch source {
        case let .file(url): url
        case .localImage, .remote: downloadedURL
        }
    }
}

@MainActor
final class FeatureMediaPreviewLoader: ObservableObject {
    @Published private(set) var fileURL: URL?
    @Published private(set) var errorMessage: String?
    @Published private(set) var isLoading = false

    private var ownedDirectory: URL?
    private var generation = FeatureMediaPreviewGeneration()

    deinit {
        if let ownedDirectory { try? FileManager.default.removeItem(at: ownedDirectory) }
    }

    func load(source: FeatureMediaPreviewSource, fileName: String) async {
        guard fileURL == nil, !isLoading else { return }
        let activeGeneration = generation.begin()
        errorMessage = nil
        isLoading = true
        defer {
            if generation.isCurrent(activeGeneration) { isLoading = false }
        }
        do {
            switch source {
            case let .file(url):
                fileURL = url
            case let .localImage(data):
                guard Int64(data.count) <= FeatureMediaPreviewFiles.maximumBytes else {
                    throw FeatureMediaPreviewError.tooLarge
                }
                let directory = try FeatureMediaPreviewFiles.ownedDirectory()
                ownedDirectory = directory
                let destination = directory.appendingPathComponent(
                    try FeatureMediaPreviewFiles.safeFileName(fileName)
                )
                try data.write(to: destination, options: .atomic)
                fileURL = destination
            case let .remote(url):
                let request = URLRequest(url: url, timeoutInterval: 30)
                let (temporaryURL, response) = try await URLSession.shared.download(for: request)
                defer { try? FileManager.default.removeItem(at: temporaryURL) }
                guard generation.isCurrent(activeGeneration), !Task.isCancelled else { return }
                guard let response = response as? HTTPURLResponse else {
                    throw FeatureMediaPreviewError.invalidResponse
                }
                guard (200 ... 299).contains(response.statusCode) else {
                    throw FeatureMediaPreviewError.httpStatus(response.statusCode)
                }
                if response.expectedContentLength > FeatureMediaPreviewFiles.maximumBytes {
                    throw FeatureMediaPreviewError.tooLarge
                }
                let byteCount = try temporaryURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard Int64(byteCount) <= FeatureMediaPreviewFiles.maximumBytes else {
                    throw FeatureMediaPreviewError.tooLarge
                }
                let directory = try FeatureMediaPreviewFiles.ownedDirectory()
                ownedDirectory = directory
                let destination = directory.appendingPathComponent(
                    try FeatureMediaPreviewFiles.safeFileName(fileName)
                )
                try FileManager.default.moveItem(at: temporaryURL, to: destination)
                guard generation.isCurrent(activeGeneration), !Task.isCancelled else {
                    cleanUp()
                    return
                }
                fileURL = destination
            }
        } catch is CancellationError {
            if let ownedDirectory { try? FileManager.default.removeItem(at: ownedDirectory) }
            ownedDirectory = nil
            return
        } catch {
            if let ownedDirectory { try? FileManager.default.removeItem(at: ownedDirectory) }
            ownedDirectory = nil
            guard generation.isCurrent(activeGeneration) else { return }
            errorMessage = error.localizedDescription
        }
    }

    func cleanUp() {
        generation.invalidate()
        if let ownedDirectory { try? FileManager.default.removeItem(at: ownedDirectory) }
        self.ownedDirectory = nil
        fileURL = nil
        isLoading = false
    }
}

struct FeatureNativeMediaPreviewView: View {
    let source: FeatureMediaPreviewSource
    let kind: FeatureFilePreviewKind
    let fileName: String

    @StateObject private var loader = FeatureMediaPreviewLoader()
    @State private var sharedFile: FeatureSharedFile?

    var body: some View {
        Group {
            if kind == .video, case let .remote(url) = source {
                FeatureVideoPlayerView(url: url)
            } else if kind == .image, case let .localImage(data) = source,
               let image = UIImage(data: data) {
                FeatureNativeZoomableImageView(image: image)
            } else if let fileURL = loader.fileURL {
                preview(fileURL)
            } else if let errorMessage = loader.errorMessage {
                ContentUnavailableView {
                    Label("Preview unavailable", systemImage: "doc.badge.ellipsis")
                } description: { Text(errorMessage) } actions: {
                    Button("Try again") { Task { await loader.load(source: source, fileName: fileName) } }
                }
            } else {
                Text("Loading preview…")
                    .foregroundStyle(T3Colors.textSecondary)
            }
        }
        .background(kind == .image || kind == .video ? Color.black : T3Colors.background)
        .task {
            if kind != .video || !isRemoteSource {
                await loader.load(source: source, fileName: fileName)
            }
        }
        .onDisappear {
            loader.cleanUp()
        }
        .sheet(item: $sharedFile) { file in
            FeatureFileActivityView(url: file.url)
        }
        .toolbar {
            if kind == .video, isRemoteSource {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task {
                            await loader.load(source: source, fileName: fileName)
                            sharedFile = FeatureMediaPreviewFiles.shareURL(
                                for: source,
                                downloadedURL: loader.fileURL
                            ).map(FeatureSharedFile.init)
                        }
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .disabled(loader.isLoading)
                    .accessibilityLabel("Share file")
                }
            } else if let fileURL = loader.fileURL {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: fileURL) { Image(systemName: "square.and.arrow.up") }
                        .accessibilityLabel("Share file")
                }
            }
        }
    }

    private var isRemoteSource: Bool {
        if case .remote = source { true } else { false }
    }

    @ViewBuilder
    private func preview(_ url: URL) -> some View {
        switch kind {
        case .image:
            if let image = UIImage(contentsOfFile: url.path) {
                FeatureNativeZoomableImageView(image: image)
            } else {
                ContentUnavailableView("Image unavailable", systemImage: "photo.badge.exclamationmark")
            }
        case .video:
            FeatureVideoPlayerView(url: url)
        case .pdf, .document:
            FeatureQuickLookPreview(url: url)
        case .markdown, .source, .plainText:
            FeatureQuickLookPreview(url: url)
        }
    }
}

private struct FeatureVideoPlayerView: View {
    let url: URL
    @StateObject private var playback = FeatureVideoPlayback()

    var body: some View {
        Group {
            if playback.failed {
                ContentUnavailableView {
                    Label("Video unavailable", systemImage: "video.slash")
                } description: { Text("The video could not load.") } actions: {
                    Button("Try again") { playback.load(url) }
                }
            } else {
                VideoPlayer(player: playback.player)
                    .overlay {
                        if !playback.ready { Text("Loading video…").foregroundStyle(.white) }
                    }
            }
        }
        .onAppear { playback.load(url) }
        .onDisappear { playback.stop() }
    }
}

@MainActor
private final class FeatureVideoPlayback: ObservableObject {
    let player = AVPlayer()
    @Published private(set) var failed = false
    @Published private(set) var ready = false
    private var observation: NSKeyValueObservation?

    func load(_ url: URL) {
        stop()
        failed = false
        ready = false
        let item = AVPlayerItem(url: url)
        player.replaceCurrentItem(with: item)
        observation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            Task { @MainActor [weak self] in
                guard let self, self.player.currentItem === item else { return }
                self.failed = item.status == .failed
                self.ready = item.status == .readyToPlay
            }
        }
    }

    func stop() {
        observation?.invalidate()
        observation = nil
        player.pause()
        player.replaceCurrentItem(with: nil)
    }
}

private struct FeatureFileActivityView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private struct FeatureSharedFile: Identifiable {
    let url: URL
    var id: URL { url }
}

private struct FeatureQuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        context.coordinator.url = url
        controller.reloadData()
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(
            _ controller: QLPreviewController,
            previewItemAt index: Int
        ) -> QLPreviewItem { url as NSURL }
    }
}

private struct FeatureNativeZoomableImageView: UIViewRepresentable {
    let image: UIImage

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIScrollView {
        let scrollView = UIScrollView()
        scrollView.backgroundColor = .black
        scrollView.delegate = context.coordinator
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 6
        let imageView = context.coordinator.imageView
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.contentMode = .scaleAspectFit
        imageView.accessibilityLabel = "Image preview"
        scrollView.addSubview(imageView)
        NSLayoutConstraint.activate([
            imageView.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            imageView.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            imageView.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor),
            imageView.heightAnchor.constraint(equalTo: scrollView.frameLayoutGuide.heightAnchor),
        ])
        context.coordinator.scrollView = scrollView
        return scrollView
    }

    func updateUIView(_ scrollView: UIScrollView, context: Context) {
        context.coordinator.imageView.image = image
    }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        let imageView = UIImageView()
        weak var scrollView: UIScrollView?
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
    }
}
