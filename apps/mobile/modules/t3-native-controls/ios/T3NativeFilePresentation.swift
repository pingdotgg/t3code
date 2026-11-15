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

/// How long the gallery waits for siblings once the selected file is ready; later ones are left out.
private let siblingGraceNanoseconds: UInt64 = 1_000_000_000
/// A load faster than this zooms straight from the thumbnail without a spinner.
private let spinnerDelayNanoseconds: UInt64 = 250_000_000

/// Quick Look only ever receives pages whose file is on disk: a page refreshed after it first
/// rendered blank keeps a stale scroll offset, so drags scroll the image instead of paging or dismissing.
final class T3NativeFilePresentation: NSObject, QLPreviewControllerDataSource,
  QLPreviewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  let identifier: String
  private var controller: FilePreviewController?
  private let completion: (Error?) -> Void
  private let onFinish: () -> Void
  private weak var sources: T3PresentationSources?
  private let sourceIdentifiers: [String]
  private var titles: [String] = []
  private var urls: [URL?] = []
  /// A prepared file, or nil while loading or after failing; `settled` tells those apart.
  private var files: [URL?] = []
  private var settled: [Bool] = []
  private var downloads: [Int: Task<Void, Never>] = [:]
  private var selectedIndex = 0
  /// The pages Quick Look shows, as indices into `files`.
  private var pages: [Int] = []
  private var items: [FilePreviewItem] = []
  private weak var presenter: UIViewController?
  private var grace: Task<Void, Never>?
  private var spinnerDelay: Task<Void, Never>?
  private var spinner: UIView?
  private var openError: Error?
  private var dismissRequested = false
  private var finished = false

  init(identifier: String, sources: T3PresentationSources, sourceIdentifiers: [String],
       onFinish: @escaping () -> Void, completion: @escaping (Error?) -> Void) {
    self.identifier = identifier
    self.sources = sources
    self.sourceIdentifiers = sourceIdentifiers
    self.onFinish = onFinish
    self.completion = completion
    super.init()
  }

  /// Downloads the file before presenting so Quick Look can refuse a format the caller should share instead.
  func present(url: URL, title: String, from presenter: UIViewController) {
    present(urls: [url], titles: [title], selectedIndex: 0, from: presenter)
  }

  /// Loads the gallery in parallel and opens once the selected file is ready, with whichever
  /// siblings are ready by the end of a short grace, so a slow or broken one never holds it back.
  func present(urls: [URL?], titles: [String], selectedIndex: Int, from presenter: UIViewController) {
    self.titles = titles
    self.urls = urls
    self.selectedIndex = selectedIndex
    self.presenter = presenter
    files = Array(repeating: nil, count: urls.count)
    settled = Array(repeating: false, count: urls.count)
    spinnerDelay = Task { @MainActor [self] in
      try? await Task.sleep(nanoseconds: spinnerDelayNanoseconds)
      guard !Task.isCancelled else { return }
      showSpinner()
    }
    for index in urls.indices { download(index) }
  }

  /// Delivers a URL that was still resolving when the gallery opened, or nil when it never will.
  func update(index: Int, url: URL?) {
    guard !finished, controller == nil, urls.indices.contains(index), urls[index] == nil,
      !settled[index]
    else { return }
    guard let url else {
      settle(index, result: .failure(URLError(.resourceUnavailable)))
      return
    }
    urls[index] = url
    download(index)
  }

  private func download(_ index: Int) {
    guard let url = urls[index], downloads[index] == nil else { return }
    let title = titles[index]
    downloads[index] = Task { @MainActor [self] in
      let result: Result<URL, Error>
      do {
        result = .success(try await Self.prepareFile(url: url, title: title))
      } catch {
        result = .failure(error)
      }
      downloads[index] = nil
      settle(index, result: result)
    }
  }

  private func settle(_ index: Int, result: Result<URL, Error>) {
    guard !finished, controller == nil, !dismissRequested else {
      if case .success(let file) = result { Self.remove(file) }
      return
    }
    settled[index] = true
    if let error = store(index, result: result), index == selectedIndex {
      openError = error
      dismiss()
      return
    }
    guard files[selectedIndex] != nil else { return }
    if settled.allSatisfy({ $0 }) {
      show()
    } else if grace == nil {
      grace = Task { @MainActor [self] in
        try? await Task.sleep(nanoseconds: siblingGraceNanoseconds)
        guard !Task.isCancelled else { return }
        show()
      }
    }
  }

  private func store(_ index: Int, result: Result<URL, Error>) -> Error? {
    switch result {
    case .success(let file):
      // Quick Look knows which formats it renders; refuse before presenting so the caller
      // can fall back instead of showing an "unsupported format" page.
      guard QLPreviewController.canPreview(file as NSURL) else {
        Self.remove(file)
        return NSError(
          domain: "T3NativePresentation",
          code: 3,
          userInfo: [NSLocalizedDescriptionKey: "This file type cannot be previewed on this device."]
        )
      }
      files[index] = file
      return nil
    case .failure(let error):
      return error
    }
  }

  private func show() {
    guard !finished, controller == nil, !dismissRequested else { return }
    guard let presenter else { finish(); return }
    cancelLoading()
    pages = files.indices.filter { files[$0] != nil }
    items = pages.map { index in
      let item = FilePreviewItem()
      item.previewItemURL = files[index]
      item.previewItemTitle = titles[index]
      return item
    }
    let preview = FilePreviewController()
    preview.delegate = self
    preview.dataSource = self
    preview.currentPreviewItemIndex = pages.firstIndex(of: selectedIndex) ?? 0
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
      sourceIdentifiers.indices.contains(selectedIndex),
      let source = sources?.view(for: sourceIdentifiers[selectedIndex]),
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
    for task in downloads.values { task.cancel() }
    downloads.removeAll()
    grace?.cancel()
    grace = nil
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

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { items.count }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    items[index]
  }

  private func sourceView(for item: QLPreviewItem) -> UIView? {
    guard !UIAccessibility.isReduceMotionEnabled,
      let page = items.firstIndex(where: { $0 === item }),
      sourceIdentifiers.indices.contains(pages[page])
    else { return nil }
    return sources?.view(for: sourceIdentifiers[pages[page]])
  }

  func previewController(_ controller: QLPreviewController, transitionViewFor item: QLPreviewItem) -> UIView? {
    sourceView(for: item)
  }

  func previewController(_ controller: QLPreviewController, frameFor item: QLPreviewItem,
                         inSourceView view: AutoreleasingUnsafeMutablePointer<UIView?>) -> CGRect {
    guard let source = sourceView(for: item) else { return .zero }
    view.pointee = source
    return source.bounds
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) { finish() }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish() }

  private func finish() {
    guard !finished else { return }
    finished = true
    cancelLoading()
    for file in files.compactMap({ $0 }) { Self.remove(file) }
    files.removeAll()
    items.removeAll()
    DispatchQueue.main.async { [completion, openError] in completion(openError) }
    // After queueing the completion, so a new presentation JS starts on seeing this lands behind it.
    onFinish()
  }

  private static func remove(_ file: URL) {
    try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
  }

  /// Copy original bytes so preview and sharing do not mutate a draft or workspace file.
  nonisolated private static func prepareFile(url: URL, title: String) async throws -> URL {
    try Task.checkCancellation()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("t3-preview-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    do {
      let download = directory.appendingPathComponent("original")
      var mimeType: String?
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
        mimeType = response.mimeType
        try FileManager.default.moveItem(at: temporaryFile, to: download)
      }
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
