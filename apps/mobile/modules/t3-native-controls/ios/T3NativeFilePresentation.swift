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
  var onDismiss: (() -> Void)?

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    onAppear?()
  }

  // Quick Look's own didDismiss callback can lag well behind the screen being tappable again,
  // so a tap on the thumbnail in that gap would land while JS still thinks the viewer is open.
  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isBeingDismissed { onDismiss?() }
  }
}

/// A load faster than this zooms straight from the thumbnail without a spinner.
private let spinnerDelayNanoseconds: UInt64 = 250_000_000

/// Quick Look for PDFs and documents; images open in T3NativeImageViewer.
final class T3NativeFilePresentation: NSObject, QLPreviewControllerDataSource,
  QLPreviewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  let identifier: String
  private var controller: FilePreviewController?
  private let completion: (Error?) -> Void
  private let onFinish: () -> Void
  private weak var sources: T3PresentationSources?
  private let sourceIdentifier: String
  private var file: URL?
  private var item: FilePreviewItem?
  private var download: Task<Void, Never>?
  private var spinnerDelay: Task<Void, Never>?
  private var spinner: UIView?
  private var openError: Error?
  private var dismissRequested = false
  private var finished = false

  init(identifier: String, sources: T3PresentationSources, sourceIdentifier: String,
       onFinish: @escaping () -> Void, completion: @escaping (Error?) -> Void) {
    self.identifier = identifier
    self.sources = sources
    self.sourceIdentifier = sourceIdentifier
    self.onFinish = onFinish
    self.completion = completion
    super.init()
  }

  /// Downloads the file before presenting so Quick Look can refuse a format the caller should share instead.
  func present(url: URL, title: String, from presenter: UIViewController) {
    spinnerDelay = Task { @MainActor [self] in
      try? await Task.sleep(nanoseconds: spinnerDelayNanoseconds)
      guard !Task.isCancelled else { return }
      showSpinner()
    }
    download = Task { @MainActor [self] in
      let result: Result<URL, Error>
      do {
        result = .success(try await Self.prepareFile(url: url, title: title))
      } catch {
        result = .failure(error)
      }
      download = nil
      settle(result, title: title, presenter: presenter)
    }
  }

  private func settle(_ result: Result<URL, Error>, title: String, presenter: UIViewController) {
    guard !finished, controller == nil, !dismissRequested else {
      if case .success(let file) = result { Self.remove(file) }
      return
    }
    switch result {
    case .success(let file):
      // Quick Look knows which formats it renders; refuse before presenting so the caller
      // can fall back instead of showing an "unsupported format" page.
      guard QLPreviewController.canPreview(file as NSURL) else {
        Self.remove(file)
        openError = NSError(
          domain: "T3NativePresentation",
          code: 3,
          userInfo: [NSLocalizedDescriptionKey: "This file type cannot be previewed on this device."]
        )
        finish()
        return
      }
      self.file = file
      show(file: file, title: title, presenter: presenter)
    case .failure(let error):
      openError = error
      finish()
    }
  }

  private func show(file: URL, title: String, presenter: UIViewController) {
    cancelLoading()
    let item = FilePreviewItem()
    item.previewItemURL = file
    item.previewItemTitle = title
    self.item = item
    let preview = FilePreviewController()
    preview.delegate = self
    preview.dataSource = self
    preview.onAppear = { [weak self] in self?.resumePendingDismissal() }
    preview.onDismiss = { [weak self] in self?.finish() }
    controller = preview
    presenter.present(preview, animated: !UIAccessibility.isReduceMotionEnabled) { [self] in
      resumePendingDismissal()
    }
    preview.presentationController?.delegate = self
  }

  /// Shows over the tapped thumbnail that a slow open is on its way.
  private func showSpinner() {
    guard !finished, controller == nil, spinner == nil,
      let source = sources?.view(for: sourceIdentifier),
      let window = source.window
    else { return }
    let backing = UIView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
    backing.backgroundColor = UIColor.black.withAlphaComponent(0.55)
    backing.layer.cornerRadius = 22
    backing.isUserInteractionEnabled = false
    let indicator = UIActivityIndicatorView(style: .medium)
    indicator.color = .white
    indicator.center = CGPoint(x: 22, y: 22)
    indicator.startAnimating()
    backing.addSubview(indicator)
    backing.center = source.convert(CGPoint(x: source.bounds.midX, y: source.bounds.midY), to: window)
    window.addSubview(backing)
    spinner = backing
  }

  private func cancelLoading() {
    download?.cancel()
    download = nil
    spinnerDelay?.cancel()
    spinnerDelay = nil
    spinner?.removeFromSuperview()
    spinner = nil
  }

  func dismiss() {
    dismissRequested = true
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

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { item == nil ? 0 : 1 }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    item ?? FilePreviewItem()
  }

  private var sourceView: UIView? {
    UIAccessibility.isReduceMotionEnabled ? nil : sources?.view(for: sourceIdentifier)
  }

  func previewController(_ controller: QLPreviewController, transitionViewFor item: QLPreviewItem) -> UIView? {
    sourceView
  }

  func previewController(_ controller: QLPreviewController, frameFor item: QLPreviewItem,
                         inSourceView view: AutoreleasingUnsafeMutablePointer<UIView?>) -> CGRect {
    guard let source = sourceView else { return .zero }
    view.pointee = source
    return source.bounds
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) { finish() }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish() }

  private func finish() {
    guard !finished else { return }
    finished = true
    cancelLoading()
    if let file { Self.remove(file) }
    file = nil
    item = nil
    DispatchQueue.main.async { [completion, openError] in completion(openError) }
    // After queueing the completion, so a new presentation JS starts on seeing this lands behind it.
    onFinish()
  }

  private static func remove(_ file: URL) {
    try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
  }

  /// Writes the bytes behind a file, data or http(s) URL to `destination`, returning the MIME type it declares.
  nonisolated private static func copyOriginal(_ url: URL, to destination: URL) async throws -> String? {
    if url.isFileURL {
      try FileManager.default.copyItem(at: url, to: destination)
      return nil
    }
    if url.scheme == "data" {
      try Data(contentsOf: url).write(to: destination, options: .atomic)
      return url.absoluteString.lowercased().hasPrefix("data:image/svg+xml") ? "image/svg+xml" : nil
    }
    guard ["https", "http"].contains(url.scheme?.lowercased() ?? "") else { throw URLError(.unsupportedURL) }
    let (temporaryFile, response) = try await URLSession.shared.download(from: url)
    guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
      throw URLError(.badServerResponse)
    }
    try FileManager.default.moveItem(at: temporaryFile, to: destination)
    return response.mimeType
  }

  /// Copy original bytes so preview and sharing do not mutate a draft or workspace file.
  nonisolated static func prepareFile(url: URL, title: String) async throws -> URL {
    try Task.checkCancellation()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("t3-preview-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    do {
      let download = directory.appendingPathComponent("original")
      let mimeType = try await copyOriginal(url, to: download)
      try Task.checkCancellation()
      // Detect images and PDFs by content; preserve other extensions so Quick Look can decide support.
      let filename = URL(fileURLWithPath: title).lastPathComponent as NSString
      let originalExtension = filename.pathExtension
      var type: UTType?
      if let image = CGImageSourceCreateWithURL(download as CFURL, nil),
        CGImageSourceGetCount(image) > 0, let imageType = CGImageSourceGetType(image),
        let detectedType = UTType(imageType as String) {
        type = detectedType
      } else if CGPDFDocument(download as CFURL) != nil {
        type = .pdf
      } else if originalExtension.lowercased() == "svg" || mimeType == "image/svg+xml" {
        // ImageIO cannot read SVG, and served images such as QR codes often have no extension.
        type = .svg
      }
      let fileExtension: String
      if let type {
        fileExtension = UTType(filenameExtension: originalExtension) == type
          ? originalExtension : type.preferredFilenameExtension ?? originalExtension
      } else {
        fileExtension = originalExtension
      }
      let stem = filename.deletingPathExtension
      var name = String(stem.prefix(60)).components(separatedBy: .controlCharacters).joined(separator: "_")
      while name.utf8.count > 200 { name.removeLast() }
      let baseName = name.isEmpty ? "Preview" : name
      let file = directory.appendingPathComponent(
        fileExtension.isEmpty ? baseName : "\(baseName).\(fileExtension)")
      try FileManager.default.moveItem(at: download, to: file)
      return file
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
  }
}
