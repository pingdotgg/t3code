import ImageIO
import QuickLook
import UIKit
import UniformTypeIdentifiers

private final class FilePreviewItem: NSObject, QLPreviewItem {
  var previewItemURL: URL?
  var previewItemTitle: String?
}

private enum FilePreviewState { case loading, ready, failed }

private final class FilePreviewController: QLPreviewController {
  var onAppear: (() -> Void)?
  // Quick Look shows a blank page for an item without a file, so loading and failure are ours to show.
  private let spinner = UIActivityIndicatorView(style: .large)
  private let failure = UILabel()
  var state = FilePreviewState.ready {
    didSet { if isViewLoaded { showState() } }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    failure.text = "This image could not be loaded."
    failure.textColor = .secondaryLabel
    failure.textAlignment = .center
    failure.numberOfLines = 0
    for status in [spinner, failure] as [UIView] {
      status.isUserInteractionEnabled = false
      status.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(status)
      NSLayoutConstraint.activate([
        status.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        status.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        status.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -48),
      ])
    }
    showState()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    view.bringSubviewToFront(spinner)
    view.bringSubviewToFront(failure)
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    onAppear?()
  }

  private func showState() {
    if state == .loading { spinner.startAnimating() } else { spinner.stopAnimating() }
    failure.isHidden = state != .failed
  }
}

final class T3NativeFilePresentation: NSObject, QLPreviewControllerDataSource,
  QLPreviewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  let identifier: String
  private var controller: FilePreviewController?
  private let completion: (Error?) -> Void
  private weak var sources: T3PresentationSources?
  private let sourceIdentifiers: [String]
  private var items: [FilePreviewItem] = []
  private var urls: [URL?] = []
  private var states: [FilePreviewState] = []
  private var selectedIndex = 0
  private weak var presenter: UIViewController?
  /// Files that arrived while their page was off screen; Quick Look may still hold the blank page.
  private var staleIndices = Set<Int>()
  private var currentIndexObservation: NSKeyValueObservation?
  private var download: (index: Int, task: Task<Void, Never>)?
  private var placeholder: Task<Void, Never>?
  private var openError: Error?
  private var dismissRequested = false
  private var finished = false

  init(identifier: String, sources: T3PresentationSources, sourceIdentifiers: [String],
       completion: @escaping (Error?) -> Void) {
    self.identifier = identifier
    self.sources = sources
    self.sourceIdentifiers = sourceIdentifiers
    self.completion = completion
    super.init()
  }

  /// Downloads the file before presenting so Quick Look can refuse a format the caller should share instead.
  func present(url: URL, title: String, from presenter: UIViewController) {
    load(urls: [url], titles: [title], selectedIndex: 0, from: presenter, opensWhileLoading: false)
  }

  /// Opens the selected image once it is ready, or a loading page if it is slow, and loads the rest
  /// of the gallery behind it so a slow or broken sibling never holds the viewer back.
  func present(urls: [URL?], titles: [String], selectedIndex: Int, from presenter: UIViewController) {
    load(urls: urls, titles: titles, selectedIndex: selectedIndex, from: presenter, opensWhileLoading: true)
  }

  /// Delivers a URL that was still resolving when the gallery opened, or nil when it never will.
  func update(index: Int, url: URL?) {
    guard !finished, urls.indices.contains(index), urls[index] == nil, states[index] == .loading else { return }
    guard let url else {
      failed(index, error: URLError(.resourceUnavailable))
      return
    }
    urls[index] = url
    loadNext()
  }

  private func load(urls: [URL?], titles: [String], selectedIndex: Int, from presenter: UIViewController,
                    opensWhileLoading: Bool) {
    items = titles.map { title in
      let item = FilePreviewItem()
      item.previewItemTitle = title
      return item
    }
    self.urls = urls
    self.selectedIndex = selectedIndex
    self.presenter = presenter
    states = Array(repeating: .loading, count: urls.count)
    if opensWhileLoading {
      // A short grace keeps the zoom from the thumbnail into a loaded image when the file is quick.
      placeholder = Task { @MainActor [self] in
        try? await Task.sleep(nanoseconds: 250_000_000)
        guard !Task.isCancelled, !finished, controller == nil else { return }
        show()
      }
    }
    loadNext()
  }

  /// Downloads one file at a time, nearest the page on screen first. The page on screen takes over
  /// from a background download, which restarts later.
  private func loadNext() {
    guard !finished, !dismissRequested else { return }
    let current = controller?.currentPreviewItemIndex ?? selectedIndex
    guard let next = urls.indices
      .filter({ urls[$0] != nil && states[$0] == .loading })
      .min(by: { abs($0 - current) < abs($1 - current) })
    else { return }
    if let download {
      guard next == current, download.index != current else { return }
      download.task.cancel()
    }
    guard let url = urls[next] else { return }
    let title = items[next].previewItemTitle ?? ""
    let task = Task { @MainActor [self] in
      let result: Result<URL, Error>
      do {
        result = .success(try await Self.prepareFile(url: url, title: title))
      } catch {
        result = .failure(error)
      }
      guard !finished, !Task.isCancelled else {
        if case .success(let file) = result {
          try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        return
      }
      download = nil
      switch result {
      case .success(let file): loaded(next, file: file)
      case .failure(let error): failed(next, error: error)
      }
      loadNext()
    }
    download = (next, task)
  }

  private func loaded(_ index: Int, file: URL) {
    // Quick Look knows which formats it renders; refuse before presenting so the caller
    // can fall back instead of showing an "unsupported format" page.
    guard QLPreviewController.canPreview(file as NSURL) else {
      try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
      failed(index, error: NSError(
        domain: "T3NativePresentation",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "This file type cannot be previewed on this device."]
      ))
      return
    }
    items[index].previewItemURL = file
    states[index] = .ready
    if controller != nil { refresh(index) } else if index == selectedIndex { show() }
  }

  private func failed(_ index: Int, error: Error) {
    guard index != selectedIndex else {
      openError = error
      dismiss()
      return
    }
    states[index] = .failed
    refresh(index)
  }

  private func show() {
    guard let presenter else { finish(); return }
    placeholder?.cancel()
    let preview = FilePreviewController()
    preview.delegate = self
    preview.dataSource = self
    preview.currentPreviewItemIndex = selectedIndex
    preview.onAppear = { [weak self] in self?.resumePendingDismissal() }
    controller = preview
    preview.state = states[selectedIndex]
    currentIndexObservation = preview.observe(\.currentPreviewItemIndex) { [weak self] _, _ in
      DispatchQueue.main.async { self?.currentItemChanged() }
    }
    presenter.present(preview, animated: !UIAccessibility.isReduceMotionEnabled) { [self] in
      resumePendingDismissal()
    }
    preview.presentationController?.delegate = self
  }

  private func refresh(_ index: Int) {
    guard let controller else { return }
    guard controller.currentPreviewItemIndex == index else {
      if states[index] == .ready { staleIndices.insert(index) }
      return
    }
    if states[index] == .ready { controller.refreshCurrentPreviewItem() }
    controller.state = states[index]
  }

  private func currentItemChanged() {
    guard !finished, let controller, states.indices.contains(controller.currentPreviewItemIndex) else { return }
    let index = controller.currentPreviewItemIndex
    if staleIndices.remove(index) != nil { controller.refreshCurrentPreviewItem() }
    controller.state = states[index]
    loadNext()
  }

  func dismiss() {
    dismissRequested = true
    download?.task.cancel()
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
      let index = items.firstIndex(where: { $0 === item }),
      sourceIdentifiers.indices.contains(index)
    else { return nil }
    return sources?.view(for: sourceIdentifiers[index])
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

  private func finish(error: Error? = nil) {
    guard !finished else { return }
    finished = true
    download?.task.cancel()
    download = nil
    placeholder?.cancel()
    placeholder = nil
    currentIndexObservation = nil
    for item in items {
      if let file = item.previewItemURL {
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
      }
    }
    items.removeAll()
    urls.removeAll()
    states.removeAll()
    let result = error ?? openError
    DispatchQueue.main.async { [completion] in completion(result) }
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
      } else if originalExtension.lowercased() == "svg" {
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
