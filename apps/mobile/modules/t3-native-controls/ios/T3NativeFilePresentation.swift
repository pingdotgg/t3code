import ImageIO
import QuickLook
import UIKit
import UniformTypeIdentifiers

private final class FilePreviewItem: NSObject, QLPreviewItem {
  var previewItemURL: URL?
  var previewItemTitle: String?
}

private final class FilePreviewController: QLPreviewController {
  var onAppear: (() -> Void)?

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    onAppear?()
  }
}

/// Quick Look owns image and document controls, zooming, and source-view transitions.
final class T3NativeFilePresentation: NSObject, QLPreviewControllerDataSource,
  QLPreviewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  let identifier: String
  private var controller: UIViewController?
  private let completion: (Error?) -> Void
  private weak var sources: T3PresentationSources?
  private let sourceIdentifier: String
  private let item = FilePreviewItem()
  private var loading: Task<Void, Never>?
  private var dismissRequested = false
  private var finished = false

  init(identifier: String, sources: T3PresentationSources, sourceIdentifier: String, completion: @escaping (Error?) -> Void) {
    self.identifier = identifier
    self.sources = sources
    self.sourceIdentifier = sourceIdentifier
    self.completion = completion
    super.init()
  }

  func present(url: URL, title: String, from presenter: UIViewController) {
    loading = Task { @MainActor [self] in
      do {
        let file = try await Self.prepareFile(url: url, title: title)
        guard !finished, !Task.isCancelled else {
          try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
          return
        }
        item.previewItemURL = file
        item.previewItemTitle = title
        let preview = FilePreviewController()
        preview.delegate = self
        preview.dataSource = self
        preview.onAppear = { [weak self] in self?.resumePendingDismissal() }
        controller = preview
        presenter.present(preview, animated: !UIAccessibility.isReduceMotionEnabled) { [self] in
          resumePendingDismissal()
        }
        preview.presentationController?.delegate = self
      } catch {
        finish(error: error)
      }
    }
  }

  func dismiss() {
    dismissRequested = true
    loading?.cancel()
    guard !finished else { return }
    guard let controller else { finish(); return }
    // Drain Close from viewDidAppear after opening or cancelling an interactive dismissal.
    // Starting a second modal transition while UIKit is settling the first can strand it.
    guard !controller.isBeingPresented, !controller.isBeingDismissed else { return }
    controller.dismiss(animated: !UIAccessibility.isReduceMotionEnabled) { [self] in finish() }
  }

  private func resumePendingDismissal() {
    // Appearance callbacks run before UIKit has cleared the current transition.
    DispatchQueue.main.async { [weak self] in
      if self?.dismissRequested == true { self?.dismiss() }
    }
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { item.previewItemURL == nil ? 0 : 1 }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    item
  }

  func previewController(_ controller: QLPreviewController, transitionViewFor item: QLPreviewItem) -> UIView? {
    guard !UIAccessibility.isReduceMotionEnabled else { return nil }
    return sources?.view(for: sourceIdentifier)
  }

  func previewController(_ controller: QLPreviewController, frameFor item: QLPreviewItem,
                         inSourceView view: AutoreleasingUnsafeMutablePointer<UIView?>) -> CGRect {
    guard !UIAccessibility.isReduceMotionEnabled, let source = sources?.view(for: sourceIdentifier) else { return .zero }
    view.pointee = source
    return source.bounds
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) { finish() }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish() }

  private func finish(error: Error? = nil) {
    guard !finished else { return }
    finished = true
    loading?.cancel()
    loading = nil
    if let file = item.previewItemURL {
      try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }
    item.previewItemURL = nil
    DispatchQueue.main.async { [completion] in completion(error) }
  }

  /// Copy original bytes so preview and sharing do not mutate a draft or workspace file.
  nonisolated private static func prepareFile(url: URL, title: String) async throws -> URL {
    try Task.checkCancellation()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("t3-preview-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    do {
      let download = directory.appendingPathComponent("original")
      if url.isFileURL {
        try FileManager.default.copyItem(at: url, to: download)
      } else if url.scheme == "data" {
        try Data(contentsOf: url).write(to: download, options: .atomic)
      } else {
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? "") else {
          throw URLError(.unsupportedURL)
        }
        let (temporaryFile, response) = try await URLSession.shared.download(from: url)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
          throw URLError(.badServerResponse)
        }
        try FileManager.default.moveItem(at: temporaryFile, to: download)
      }
      try Task.checkCancellation()
      let type: UTType
      if let image = CGImageSourceCreateWithURL(download as CFURL, nil),
        CGImageSourceGetCount(image) > 0, let imageType = CGImageSourceGetType(image),
        let detectedType = UTType(imageType as String) {
        type = detectedType
      } else if CGPDFDocument(download as CFURL) != nil {
        type = .pdf
      } else {
        throw URLError(.cannotDecodeContentData)
      }
      let filename = URL(fileURLWithPath: title).lastPathComponent as NSString
      let originalExtension = filename.pathExtension
      let fileExtension = UTType(filenameExtension: originalExtension) == type
        ? originalExtension : type.preferredFilenameExtension ?? "png"
      let stem = filename.deletingPathExtension
      var name = String(stem.prefix(60)).components(separatedBy: .controlCharacters).joined(separator: "_")
      while name.utf8.count > 200 { name.removeLast() }
      let file = directory.appendingPathComponent("\(name.isEmpty ? "Preview" : name).\(fileExtension)")
      try FileManager.default.moveItem(at: download, to: file)
      return file
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
  }
}
