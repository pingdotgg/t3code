import ImageIO
import Photos
import UIKit

/// Full-screen image gallery modelled on Messages. It opens at once from the tapped thumbnail's
/// own pixels and sharpens when the original arrives, so a slow or failed load never holds it back.
final class T3NativeImageViewer: NSObject {
  let identifier: String
  private let completion: (Error?) -> Void
  private let onFinish: () -> Void
  private weak var sources: T3PresentationSources?
  private let sourceIdentifiers: [String]
  private var titles: [String] = []
  private var urls: [URL?] = []
  /// The original bytes on disk, kept for sharing.
  private var files: [URL?] = []
  private var placeholders: [UIImage?] = []
  private var loads: [Int: Task<Void, Never>] = [:]
  private var decodes: [Int: Task<Void, Never>] = [:]
  /// The last queued decode; each one waits for it, so one original decodes at a time.
  private var decodeQueue: Task<Void, Never>?
  /// Pages showing their decoded original; only the current page and its neighbours keep one.
  private var decoded: Set<Int> = []
  private var currentIndex = 0
  private var controller: T3ImageViewerController?
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

  func present(urls: [URL?], titles: [String], selectedIndex: Int, from presenter: UIViewController) {
    self.urls = urls
    self.titles = titles
    files = Array(repeating: nil, count: urls.count)
    currentIndex = selectedIndex
    let viewer = T3ImageViewerController(titles: titles, selectedIndex: selectedIndex)
    viewer.sourceView = { [weak self] index in self?.sourceView(index) }
    viewer.fileForPage = { [weak self] index in self?.file(at: index) }
    viewer.onRetry = { [weak self] index in self?.load(index, retry: true) }
    viewer.onDismissed = { [weak self] in self?.finish() }
    viewer.onPageChange = { [weak self] index in self?.show(page: index) }
    controller = viewer
    viewer.loadViewIfNeeded()
    placeholders = urls.indices.map { sourceView($0).flatMap(Self.thumbnail(of:)) }
    for (index, placeholder) in placeholders.enumerated() {
      if let placeholder { viewer.setImage(placeholder, at: index, full: false) }
    }
    presenter.present(T3ImageViewerNavigation(viewer: viewer), animated: false) { viewer.animateIn() }
    for index in urls.indices { load(index, retry: false) }
  }

  /// Delivers a URL that was still resolving when the gallery opened, or nil when it never will.
  func update(index: Int, url: URL?) {
    guard !finished, urls.indices.contains(index), urls[index] == nil else { return }
    guard let url else {
      controller?.setFailed(at: index, retryable: false)
      return
    }
    urls[index] = url
    load(index, retry: false)
  }

  func dismiss() {
    guard !finished else { return }
    guard let controller else { finish(); return }
    controller.close()
  }

  /// Ends at once, for a new viewer that must open while this one is still animating away.
  func finishImmediately() {
    guard !finished else { return }
    controller?.presentingViewController?.dismiss(animated: false)
    finish()
  }

  private func file(at index: Int) -> URL? {
    files.indices.contains(index) ? files[index] : nil
  }

  private func sourceView(_ index: Int) -> UIView? {
    guard sourceIdentifiers.indices.contains(index), !sourceIdentifiers[index].isEmpty else { return nil }
    return sources?.view(for: sourceIdentifiers[index])
  }

  private func load(_ index: Int, retry: Bool) {
    guard !finished, urls.indices.contains(index), let url = urls[index], loads[index] == nil else { return }
    if retry { controller?.setLoading(at: index) }
    let title = titles[index]
    loads[index] = Task { @MainActor [self] in
      defer { loads[index] = nil }
      do {
        let file = try await T3NativeFilePresentation.prepareFile(url: url, title: title)
        guard !finished, !Task.isCancelled else { Self.remove(file); return }
        if let previous = files[index] { Self.remove(previous) }
        files[index] = file
        decoded.remove(index)
        if isNearCurrent(index) { decode(index) }
      } catch {
        guard !finished, !Task.isCancelled else { return }
        controller?.setFailed(at: index, retryable: true)
      }
    }
  }

  /// Every original downloads up front, but a decoded one costs far more memory than its file,
  /// so only pages next to the current one decode, and pages further away fall back to their thumbnail.
  private func show(page index: Int) {
    currentIndex = index
    for other in decoded where !isNearCurrent(other) {
      decoded.remove(other)
      controller?.release(at: other, placeholder: placeholders[other])
    }
    // Queued decodes for pages paged past are skipped before they start.
    for (other, task) in decodes where !isNearCurrent(other) { task.cancel() }
    for near in files.indices where isNearCurrent(near) { decode(near) }
  }

  private func isNearCurrent(_ index: Int) -> Bool { abs(index - currentIndex) <= 1 }

  private func decode(_ index: Int) {
    guard !finished, let file = file(at: index), !decoded.contains(index), decodes[index] == nil else { return }
    let source = sourceView(index)
    let previous = decodeQueue
    let task = Task { @MainActor [self] in
      await previous?.value
      var settled = false
      defer {
        decodes[index] = nil
        // Paged away and back while this run waited: it was cancelled, so the page asks again.
        if !settled, !finished, isNearCurrent(index), !decoded.contains(index) { decode(index) }
      }
      guard !finished, !Task.isCancelled, isNearCurrent(index), files[index] == file else { return }
      // ImageIO reads SVG poorly or not at all; the thumbnail is vector, so redraw it at full-screen size.
      let isSVG = file.pathExtension.lowercased() == "svg"
      let image = isSVG ? nil : await Task.detached(priority: .userInitiated) { Self.decode(file) }.value
      guard !finished, !Task.isCancelled, isNearCurrent(index), files[index] == file else { return }
      if isSVG {
        // The open transition hides the thumbnail, which draws blank until it is back.
        await controller?.untilRevealed()
        guard !finished, !Task.isCancelled, isNearCurrent(index), files[index] == file else { return }
      }
      settled = true
      if let image = image ?? (isSVG ? source.flatMap(Self.render(_:)) : nil) {
        decoded.insert(index)
        controller?.setImage(image, at: index, full: true)
      } else {
        // A corrupt download or an SVG whose thumbnail is scrolled away; retrying downloads it again.
        // A file that is not an image must not reach Share.
        if !isSVG {
          Self.remove(file)
          files[index] = nil
        }
        controller?.setFailed(at: index, retryable: true)
      }
    }
    decodes[index] = task
    decodeQueue = task
  }

  private func finish() {
    guard !finished else { return }
    finished = true
    for task in loads.values { task.cancel() }
    loads.removeAll()
    for task in decodes.values { task.cancel() }
    decodes.removeAll()
    decodeQueue = nil
    for file in files.compactMap({ $0 }) { Self.remove(file) }
    files.removeAll()
    controller = nil
    DispatchQueue.main.async { [completion] in completion(nil) }
    // After queueing the completion, so a new presentation JS starts on seeing this lands behind it.
    onFinish()
  }

  private static func remove(_ file: URL) {
    try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
  }

  /// The decoded image a thumbnail already shows, uncropped, or a snapshot of a view that draws one.
  /// The largest image view wins, so an overlaid icon is never mistaken for the picture.
  private static func thumbnail(of view: UIView) -> UIImage? {
    var queue = [view]
    var best: (image: UIImage, area: CGFloat)?
    while let candidate = queue.popLast() {
      queue.append(contentsOf: candidate.subviews)
      guard let image = (candidate as? UIImageView)?.image, image.size.width > 0, image.size.height > 0 else { continue }
      let area = candidate.bounds.width * candidate.bounds.height
      if area > best?.area ?? 0 { best = (image, area) }
    }
    if let best, best.area >= view.bounds.width * view.bounds.height / 2 { return best.image }
    return snapshot(view, scale: view.window?.screen.scale ?? 2)
  }

  private static func render(_ view: UIView) -> UIImage? {
    let screen = view.window?.screen.bounds.size ?? CGSize(width: 1024, height: 1024)
    let fit = min(screen.width / max(view.bounds.width, 1), screen.height / max(view.bounds.height, 1))
    // The thumbnail was shown again after the open transition, in a frame not yet on screen.
    return snapshot(view, scale: max(1, fit) * (view.window?.screen.scale ?? 2), afterScreenUpdates: true)
  }

  private static func snapshot(_ view: UIView, scale: CGFloat, afterScreenUpdates: Bool = false) -> UIImage? {
    guard view.bounds.width > 1, view.bounds.height > 1, view.window != nil else { return nil }
    let format = UIGraphicsImageRendererFormat()
    format.scale = scale
    format.opaque = false
    return UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { _ in
      view.drawHierarchy(in: view.bounds, afterScreenUpdates: afterScreenUpdates)
    }
  }

  /// Decodes off the main thread at no more than zooming needs, and keeps GIFs animated.
  nonisolated private static func decode(_ file: URL) -> UIImage? {
    guard let source = CGImageSourceCreateWithURL(file as CFURL, nil) else { return nil }
    let count = CGImageSourceGetCount(source)
    guard count > 0 else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: 4096,
    ]
    var animationOptions = options
    animationOptions[kCGImageSourceThumbnailMaxPixelSize] = 1024
    animationOptions[kCGImageSourceShouldCacheImmediately] = nil
    // Every frame stays decoded while it plays, so an animation over this budget shows its first frame.
    if count > 1, let first = CGImageSourceCreateThumbnailAtIndex(source, 0, animationOptions as CFDictionary),
      first.bytesPerRow * first.height * count <= animationByteBudget {
      var frames: [(image: UIImage, delay: Double)] = [(UIImage(cgImage: first), frameDuration(source, 0))]
      for index in 1..<count {
        guard let frame = CGImageSourceCreateThumbnailAtIndex(source, index, animationOptions as CFDictionary) else { continue }
        frames.append((UIImage(cgImage: frame), frameDuration(source, index)))
      }
      // UIKit plays frames evenly, so each frame repeats once per tick of its delay; the repeats share
      // one bitmap. The tick grows with the animation's length to keep the timeline near 1,000 entries.
      let total = frames.reduce(0) { $0 + $1.delay }
      let tick = max(0.02, total / 1_000)
      let timeline = frames.flatMap { frame in
        Array(repeating: frame.image, count: max(1, Int((frame.delay / tick).rounded())))
      }
      if frames.count > 1 { return UIImage.animatedImage(with: timeline, duration: Double(timeline.count) * tick) }
    }
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
  }

  nonisolated private static func frameDuration(_ source: CGImageSource, _ index: Int) -> Double {
    let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
    let gif = properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
    let png = properties?[kCGImagePropertyPNGDictionary] as? [CFString: Any]
    let delay = gif?[kCGImagePropertyGIFUnclampedDelayTime] as? Double
      ?? gif?[kCGImagePropertyGIFDelayTime] as? Double
      ?? png?[kCGImagePropertyAPNGUnclampedDelayTime] as? Double
      ?? png?[kCGImagePropertyAPNGDelayTime] as? Double
      ?? 0.1
    // Browsers treat near-zero delays as 0.1s.
    return delay < 0.011 ? 0.1 : delay
  }
}

private let animationByteBudget = 64 * 1024 * 1024

private extension Array {
  subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

/// One zoomable page. Its content never exceeds its bounds at the fitted zoom, so a vertical
/// drag has nothing to scroll and always reaches the dismiss gesture.
private final class T3ImageViewerPage: UIView, UIScrollViewDelegate {
  let scroll = UIScrollView()
  let imageView = UIImageView()
  private let spinner = UIActivityIndicatorView(style: .large)
  private let failure = UIStackView()
  private var spinnerDelay: DispatchWorkItem?
  private var laidOutSize = CGSize.zero
  private(set) var isFull = false
  var onRetry: (() -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    scroll.delegate = self
    scroll.showsVerticalScrollIndicator = false
    scroll.showsHorizontalScrollIndicator = false
    scroll.contentInsetAdjustmentBehavior = .never
    scroll.decelerationRate = .fast
    scroll.alwaysBounceVertical = false
    scroll.alwaysBounceHorizontal = false
    scroll.bouncesZoom = true
    addSubview(scroll)
    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    imageView.isAccessibilityElement = true
    imageView.accessibilityTraits = .image
    scroll.addSubview(imageView)
    spinner.color = .white
    spinner.hidesWhenStopped = true
    addSubview(spinner)
    configureFailure()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }

  private func configureFailure() {
    let icon = UIImageView(image: UIImage(systemName: "exclamationmark.triangle"))
    icon.tintColor = UIColor(white: 1, alpha: 0.8)
    icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 28, weight: .regular)
    let label = UILabel()
    label.text = "This image could not be loaded."
    label.textColor = UIColor(white: 1, alpha: 0.8)
    label.font = .preferredFont(forTextStyle: .subheadline)
    label.adjustsFontForContentSizeCategory = true
    label.textAlignment = .center
    label.numberOfLines = 0
    var configuration = UIButton.Configuration.gray()
    configuration.title = "Try Again"
    configuration.cornerStyle = .capsule
    configuration.baseForegroundColor = .white
    configuration.baseBackgroundColor = UIColor(white: 1, alpha: 0.18)
    let retry = UIButton(configuration: configuration, primaryAction: UIAction { [weak self] _ in self?.onRetry?() })
    failure.axis = .vertical
    failure.alignment = .center
    failure.spacing = 12
    failure.isHidden = true
    for view in [icon, label, retry] { failure.addArrangedSubview(view) }
    addSubview(failure)
  }

  var image: UIImage? { imageView.image }

  func setImage(_ image: UIImage, full: Bool) {
    guard full || !isFull else { return }
    let previous = imageView.image?.size
    imageView.image = image
    isFull = full
    stopLoading()
    failure.isHidden = true
    let ratio = { (size: CGSize) in size.width / max(size.height, 1) }
    // A sharper copy of the same picture keeps the reader's zoom; a different shape starts over.
    if previous == nil || abs(ratio(previous ?? .zero) - ratio(image.size)) > 0.01 { laidOutSize = .zero }
    setNeedsLayout()
  }

  /// Gives back a far-away page's decoded original, keeping the thumbnail until it returns.
  func release(to placeholder: UIImage?) {
    guard isFull else { return }
    isFull = false
    imageView.image = placeholder
    laidOutSize = .zero
    setNeedsLayout()
    setLoading()
  }

  func setLoading() {
    failure.isHidden = true
    imageView.alpha = 1
    guard imageView.image == nil, spinnerDelay == nil else { return }
    let work = DispatchWorkItem { [weak self] in self?.spinner.startAnimating() }
    spinnerDelay = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
  }

  func setFailed(retryable: Bool) {
    stopLoading()
    guard !isFull else { return }
    failure.arrangedSubviews.last?.isHidden = !retryable
    failure.isHidden = false
    // A thumbnail stays visible behind the message, dimmed.
    imageView.alpha = imageView.image == nil ? 1 : 0.35
  }

  private func stopLoading() {
    spinnerDelay?.cancel()
    spinnerDelay = nil
    spinner.stopAnimating()
    imageView.alpha = 1
  }

  var isZoomed: Bool { scroll.zoomScale > scroll.minimumZoomScale + 0.01 }

  func resetZoom(animated: Bool) { scroll.setZoomScale(scroll.minimumZoomScale, animated: animated) }

  override func layoutSubviews() {
    super.layoutSubviews()
    scroll.frame = bounds
    spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
    let width = min(bounds.width - 48, 320)
    let height = failure.systemLayoutSizeFitting(CGSize(width: width, height: 0),
                                                 withHorizontalFittingPriority: .required,
                                                 verticalFittingPriority: .fittingSizeLevel).height
    failure.frame = CGRect(x: (bounds.width - width) / 2, y: (bounds.height - height) / 2, width: width, height: height)
    guard bounds.size != laidOutSize, let size = imageView.image?.size, size.width > 0, size.height > 0 else { return }
    laidOutSize = bounds.size
    let fit = min(bounds.width / size.width, bounds.height / size.height)
    scroll.minimumZoomScale = 1
    scroll.zoomScale = 1
    imageView.transform = .identity
    imageView.frame = CGRect(x: 0, y: 0, width: size.width * fit, height: size.height * fit)
    scroll.contentSize = imageView.frame.size
    // Enough to fill the screen and then some, or to see the original's pixels.
    let fill = max(bounds.width / imageView.frame.width, bounds.height / imageView.frame.height)
    let pixels = 1 / fit / (window?.screen.scale ?? 2)
    scroll.maximumZoomScale = max(3, fill * 1.5, pixels)
    centerImage()
  }

  /// The fitted frame of the image, for the opening transition.
  func fittedFrame(in view: UIView) -> CGRect {
    layoutIfNeeded()
    return imageView.convert(imageView.bounds, to: view)
  }

  func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

  func scrollViewDidZoom(_ scrollView: UIScrollView) { centerImage() }

  private func centerImage() {
    let content = scroll.contentSize
    imageView.center = CGPoint(x: max(content.width, scroll.bounds.width) / 2,
                               y: max(content.height, scroll.bounds.height) / 2)
  }

  func toggleZoom(at point: CGPoint) {
    if isZoomed { resetZoom(animated: true); return }
    guard imageView.image != nil else { return }
    let location = convert(point, to: imageView)
    let fill = max(scroll.bounds.width / imageView.bounds.width, scroll.bounds.height / imageView.bounds.height)
    let scale = min(scroll.maximumZoomScale, fill > 1.2 ? fill : 2.5)
    let width = scroll.bounds.width / scale
    let height = scroll.bounds.height / scale
    scroll.zoom(to: CGRect(x: location.x - width / 2, y: location.y - height / 2, width: width, height: height),
                animated: true)
  }
}

/// System bars, so UIKit places Close, the title, Save and Share: at the top and bottom of an iPhone,
/// and in the side bar of an unfolded iPhone Duo.
private final class T3ImageViewerNavigation: UINavigationController {
  init(viewer: T3ImageViewerController) {
    super.init(rootViewController: viewer)
    modalPresentationStyle = .overFullScreen
    modalPresentationCapturesStatusBarAppearance = true
    overrideUserInterfaceStyle = .dark
    view.backgroundColor = .clear
    if #unavailable(iOS 26.0) {
      // Before iOS 26 bars at the scroll edge are transparent; iOS 26 gives them its edge blur instead.
      let bar = UINavigationBarAppearance()
      bar.configureWithDefaultBackground()
      navigationBar.scrollEdgeAppearance = bar
      navigationBar.compactScrollEdgeAppearance = bar
      let tools = UIToolbarAppearance()
      tools.configureWithDefaultBackground()
      toolbar.scrollEdgeAppearance = tools
      toolbar.compactScrollEdgeAppearance = tools
    }
    setNavigationBarHidden(true, animated: false)
    setToolbarHidden(true, animated: false)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }

  override var childForStatusBarHidden: UIViewController? { topViewController }
  override var childForStatusBarStyle: UIViewController? { topViewController }
  override var childForHomeIndicatorAutoHidden: UIViewController? { topViewController }
}

final class T3ImageViewerController: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate {
  var sourceView: (Int) -> UIView? = { _ in nil }
  var fileForPage: (Int) -> URL? = { _ in nil }
  var onRetry: (Int) -> Void = { _ in }
  var onPageChange: (Int) -> Void = { _ in }
  var onDismissed: () -> Void = {}

  private let titles: [String]
  private var currentIndex: Int
  private let backdrop = UIView()
  private let pager = UIScrollView()
  private var pages: [T3ImageViewerPage] = []
  private let titleLabel = UILabel()
  private let counterLabel = UILabel()
  private lazy var dismissPan = UIPanGestureRecognizer(target: self, action: #selector(handleDismissPan(_:)))
  private var chromeHidden = false
  private var chromeHiddenBeforeDrag = false
  private var dragAnchor = CGPoint.zero
  private var transitioning = true
  private var closeRequested = false
  private var closing = false
  private var revealed = false
  private var revealWaiters: [CheckedContinuation<Void, Never>] = []
  private var laidOutSize = CGSize.zero
  private var isLayingOut = false
  private lazy var saveItem = UIBarButtonItem(
    title: "Save to Photos", image: UIImage(systemName: "square.and.arrow.down"),
    primaryAction: UIAction { [weak self] _ in self?.save() })
  private lazy var shareItem = UIBarButtonItem(
    systemItem: .action, primaryAction: UIAction { [weak self] _ in self?.share() })
  private static let pageGap: CGFloat = 20

  init(titles: [String], selectedIndex: Int) {
    self.titles = titles
    currentIndex = selectedIndex
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }

  override var prefersStatusBarHidden: Bool { chromeHidden }
  override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
  override var prefersHomeIndicatorAutoHidden: Bool { chromeHidden }
  override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { .fade }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    backdrop.backgroundColor = .black
    backdrop.alpha = 0
    view.addSubview(backdrop)
    pager.isPagingEnabled = true
    pager.showsHorizontalScrollIndicator = false
    pager.showsVerticalScrollIndicator = false
    pager.contentInsetAdjustmentBehavior = .never
    pager.alwaysBounceVertical = false
    pager.delegate = self
    pager.isHidden = true
    view.addSubview(pager)
    for index in titles.indices {
      let page = T3ImageViewerPage()
      page.imageView.accessibilityLabel = titles[index]
      page.onRetry = { [weak self] in self?.onRetry(index) }
      page.scroll.panGestureRecognizer.require(toFail: dismissPan)
      page.setLoading()
      pages.append(page)
      pager.addSubview(page)
    }
    pager.panGestureRecognizer.require(toFail: dismissPan)
    dismissPan.delegate = self
    dismissPan.maximumNumberOfTouches = 1
    view.addGestureRecognizer(dismissPan)
    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
    doubleTap.numberOfTapsRequired = 2
    pager.addGestureRecognizer(doubleTap)
    let singleTap = UITapGestureRecognizer(target: self, action: #selector(handleSingleTap))
    singleTap.require(toFail: doubleTap)
    pager.addGestureRecognizer(singleTap)
    configureChrome()
    updateTitle()
  }

  private func configureChrome() {
    navigationItem.leftBarButtonItem = UIBarButtonItem(
      systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.close() })
    if #unavailable(iOS 26.0) {
      // Before iOS 26 a navigation item has no subtitle, so the count sits under the title by hand.
      titleLabel.font = .preferredFont(forTextStyle: .headline)
      counterLabel.font = .preferredFont(forTextStyle: .caption1)
      counterLabel.textColor = .secondaryLabel
      for label in [titleLabel, counterLabel] {
        label.textAlignment = .center
        label.adjustsFontForContentSizeCategory = true
        label.lineBreakMode = .byTruncatingMiddle
      }
      let titles = UIStackView(arrangedSubviews: [titleLabel, counterLabel])
      titles.axis = .vertical
      titles.alignment = .center
      navigationItem.titleView = titles
    }
    toolbarItems = [.flexibleSpace(), saveItem, shareItem]
    setContentScrollView(pager, for: .top)
    setContentScrollView(pager, for: .bottom)
  }

  /// Shows or hides the bars through UIKit, which also moves them out of an iPhone Duo's side bar.
  private func setBarsVisible(_ visible: Bool) {
    navigationController?.setNavigationBarHidden(!visible, animated: true)
    navigationController?.setToolbarHidden(!visible, animated: true)
  }

  private func updateTitle() {
    updateActions()
    let title = titles[safe: currentIndex]
    let counter = titles.count > 1 ? "\(currentIndex + 1) of \(titles.count)" : nil
    navigationItem.title = title
    if #available(iOS 26.0, *) { navigationItem.subtitle = counter }
    titleLabel.text = title
    counterLabel.text = counter
    counterLabel.isHidden = counter == nil
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    backdrop.frame = view.bounds
    guard view.bounds.size != laidOutSize else { return }
    laidOutSize = view.bounds.size
    // Resizing the pager scrolls it; that must not move the reader to another page.
    isLayingOut = true
    defer { isLayingOut = false }
    // Pages sit a gap apart, like Photos, so the pager is a gap wider than the screen.
    let pageWidth = view.bounds.width + Self.pageGap
    pager.frame = CGRect(x: -Self.pageGap / 2, y: 0, width: pageWidth, height: view.bounds.height)
    for (index, page) in pages.enumerated() {
      page.transform = .identity
      page.frame = CGRect(x: CGFloat(index) * pageWidth + Self.pageGap / 2, y: 0,
                          width: view.bounds.width, height: view.bounds.height)
    }
    pager.contentSize = CGSize(width: pageWidth * CGFloat(pages.count), height: view.bounds.height)
    pager.contentOffset = CGPoint(x: CGFloat(currentIndex) * pageWidth, y: 0)
  }

  func setImage(_ image: UIImage, at index: Int, full: Bool) {
    guard let page = pages[safe: index] else { return }
    page.setImage(image, full: full)
    updateActions()
  }

  func setLoading(at index: Int) { pages[safe: index]?.setLoading() }

  func release(at index: Int, placeholder: UIImage?) {
    pages[safe: index]?.release(to: placeholder)
    updateActions()
  }

  func setFailed(at index: Int, retryable: Bool) {
    pages[safe: index]?.setFailed(retryable: retryable)
    updateActions()
  }

  /// Save and Share act on the original, so they wait until the current page shows it.
  private func updateActions() {
    let ready = pages[safe: currentIndex]?.isFull == true
    saveItem.isEnabled = ready
    shareItem.isEnabled = ready
  }

  // MARK: Transitions

  private var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled }

  private func visibleSource(_ index: Int) -> UIView? {
    guard !reduceMotion, let source = sourceView(index), source.window === view.window, !source.isHidden else { return nil }
    let frame = source.convert(source.bounds, to: view)
    guard frame.width > 1, frame.height > 1, view.bounds.intersects(frame) else { return nil }
    return source
  }

  private static func cornerRadius(of view: UIView) -> CGFloat {
    var queue = [view]
    var depth = 0
    while !queue.isEmpty, depth < 4 {
      for candidate in queue where candidate.layer.cornerRadius > 0 { return candidate.layer.cornerRadius }
      queue = queue.flatMap(\.subviews)
      depth += 1
    }
    return 0
  }

  private func makeTransitionView(_ image: UIImage, frame: CGRect) -> UIImageView {
    let transition = UIImageView(image: image)
    transition.contentMode = .scaleAspectFill
    transition.clipsToBounds = true
    transition.frame = frame
    view.addSubview(transition)
    return transition
  }

  /// Returns once the open transition has finished and the thumbnails are on screen again.
  func untilRevealed() async {
    guard !revealed else { return }
    await withCheckedContinuation { revealWaiters.append($0) }
  }

  func animateIn() {
    view.layoutIfNeeded()
    let page = pages[currentIndex]
    let reveal = { [weak self] in
      guard let self else { return }
      self.pager.isHidden = false
      self.transitioning = false
      self.revealed = true
      for waiter in self.revealWaiters { waiter.resume() }
      self.revealWaiters.removeAll()
      self.setNeedsStatusBarAppearanceUpdate()
      UIAccessibility.post(notification: .screenChanged, argument: page.imageView)
      if self.closeRequested { self.close() }
    }
    guard let image = page.image, let source = visibleSource(currentIndex) else {
      pager.isHidden = false
      pager.alpha = 0
      setBarsVisible(true)
      UIView.animate(withDuration: reduceMotion ? 0.2 : 0.25, animations: {
        self.backdrop.alpha = 1
        self.pager.alpha = 1
      }, completion: { _ in reveal() })
      return
    }
    let transition = makeTransitionView(image, frame: source.convert(source.bounds, to: view))
    transition.layer.cornerRadius = Self.cornerRadius(of: source)
    let sourceAlpha = source.alpha
    source.alpha = 0
    let target = page.fittedFrame(in: view)
    let animator = UIViewPropertyAnimator(duration: 0.42, dampingRatio: 0.86) {
      transition.frame = target
      transition.layer.cornerRadius = 0
      self.backdrop.alpha = 1
    }
    setBarsVisible(true)
    animator.addCompletion { _ in
      source.alpha = sourceAlpha
      transition.removeFromSuperview()
      reveal()
    }
    animator.startAnimation()
  }

  /// Closes back into the current page's thumbnail, or away in the drag's direction when it is gone.
  func close(velocity: CGPoint = .zero) {
    closeRequested = true
    guard !transitioning, !closing else { return }
    closing = true
    transitioning = true
    setNeedsStatusBarAppearanceUpdate()
    setBarsVisible(false)
    let page = pages[currentIndex]
    guard let image = page.image else {
      UIView.animate(withDuration: 0.2, animations: { self.view.alpha = 0 }, completion: { _ in self.finishClose() })
      return
    }
    let transition = makeTransitionView(image, frame: page.imageView.convert(page.imageView.bounds, to: view))
    pager.isHidden = true
    guard let source = visibleSource(currentIndex) else {
      let direction: CGFloat = velocity.y < 0 ? -1 : 1
      let animator = UIViewPropertyAnimator(duration: 0.3, curve: .easeIn) {
        transition.center.y += direction * self.view.bounds.height
        self.backdrop.alpha = 0
        if self.reduceMotion { transition.alpha = 0 }
      }
      animator.addCompletion { _ in self.finishClose() }
      animator.startAnimation()
      return
    }
    let sourceAlpha = source.alpha
    source.alpha = 0
    let target = source.convert(source.bounds, to: view)
    let radius = Self.cornerRadius(of: source)
    let speed = hypot(velocity.x, velocity.y)
    let distance = hypot(target.midX - transition.center.x, target.midY - transition.center.y)
    let initial = distance > 0 ? CGVector(dx: velocity.x / distance, dy: velocity.y / distance) : .zero
    let timing = UISpringTimingParameters(dampingRatio: 0.88, initialVelocity: speed > 0 ? initial : .zero)
    let animator = UIViewPropertyAnimator(duration: 0.4, timingParameters: timing)
    animator.addAnimations {
      transition.frame = target
      transition.layer.cornerRadius = radius
      self.backdrop.alpha = 0
    }
    animator.addCompletion { _ in
      source.alpha = sourceAlpha
      self.finishClose()
    }
    animator.startAnimation()
  }

  private func finishClose() {
    presentingViewController?.dismiss(animated: false) { [onDismissed] in onDismissed() }
  }

  // MARK: Gestures

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard gestureRecognizer === dismissPan else { return true }
    guard !transitioning, !pager.isDragging, !pager.isDecelerating,
      let page = pages[safe: currentIndex], !page.isZoomed
    else { return false }
    let velocity = dismissPan.velocity(in: view)
    return abs(velocity.y) > abs(velocity.x)
  }

  @objc private func handleDismissPan(_ gesture: UIPanGestureRecognizer) {
    let page = pages[currentIndex]
    let translation = gesture.translation(in: view)
    switch gesture.state {
    case .began:
      chromeHiddenBeforeDrag = chromeHidden
      dragAnchor = gesture.location(in: page)
      setChromeHidden(true)
    case .changed:
      // Shrink around the finger, as Photos does, so the touched spot stays under it.
      let progress = min(1, abs(translation.y) / (view.bounds.height / 2))
      let scale = 1 - 0.3 * progress
      let offset = CGPoint(x: dragAnchor.x - page.bounds.midX, y: dragAnchor.y - page.bounds.midY)
      page.transform = CGAffineTransform(translationX: translation.x + (1 - scale) * offset.x,
                                         y: translation.y + (1 - scale) * offset.y).scaledBy(x: scale, y: scale)
      backdrop.alpha = 1 - progress
    case .ended, .cancelled, .failed:
      let velocity = gesture.velocity(in: view)
      let flung = abs(velocity.y) > 800 && velocity.y * translation.y > 0
      if gesture.state == .ended, flung || abs(translation.y) > 120 {
        close(velocity: velocity)
      } else {
        UIViewPropertyAnimator(duration: 0.35, dampingRatio: 0.8) {
          page.transform = .identity
          self.backdrop.alpha = 1
        }.startAnimation()
        setChromeHidden(chromeHiddenBeforeDrag)
      }
    default:
      break
    }
  }

  @objc private func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
    guard !transitioning, let page = pages[safe: currentIndex] else { return }
    page.toggleZoom(at: gesture.location(in: page))
  }

  @objc private func handleSingleTap() {
    guard !transitioning else { return }
    setChromeHidden(!chromeHidden)
  }

  private func setChromeHidden(_ hidden: Bool) {
    guard chromeHidden != hidden else { return }
    chromeHidden = hidden
    setBarsVisible(!hidden)
    UIView.animate(withDuration: 0.2) { self.setNeedsStatusBarAppearanceUpdate() }
    setNeedsUpdateOfHomeIndicatorAutoHidden()
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    guard scrollView === pager, !transitioning, !isLayingOut, pager.bounds.width > 0 else { return }
    let index = Int((pager.contentOffset.x / pager.bounds.width).rounded())
    guard pages.indices.contains(index), index != currentIndex else { return }
    pages[currentIndex].resetZoom(animated: false)
    currentIndex = index
    updateTitle()
    onPageChange(index)
  }

  private func scroll(to index: Int) {
    guard pages.indices.contains(index), !transitioning else { return }
    pager.setContentOffset(CGPoint(x: CGFloat(index) * pager.bounds.width, y: 0), animated: !reduceMotion)
  }

  // MARK: Share, keyboard and accessibility

  private func save() {
    let image = pages[currentIndex].isFull ? pages[currentIndex].image : nil
    // Original bytes keep the format and metadata; an SVG only has its rendered image. The copy
    // belongs to this save, since closing the viewer deletes its files before Photos may read them.
    let original = fileForPage(currentIndex).flatMap { file -> URL? in
      guard file.pathExtension.lowercased() != "svg", let source = CGImageSourceCreateWithURL(file as CFURL, nil), CGImageSourceGetCount(source) > 0 else { return nil }
      let copy = FileManager.default.temporaryDirectory.appendingPathComponent("t3-save-\(UUID().uuidString)")
        .appendingPathComponent(file.lastPathComponent)
      do {
        try FileManager.default.createDirectory(at: copy.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: file, to: copy)
        return copy
      } catch {
        return nil
      }
    }
    guard original != nil || image != nil else { return }
    let cleanUp = { if let original { try? FileManager.default.removeItem(at: original.deletingLastPathComponent()) } }
    PHPhotoLibrary.requestAuthorization(for: .addOnly) { [weak self] status in
      guard status == .authorized || status == .limited else {
        cleanUp()
        DispatchQueue.main.async { self?.showSaveError("Allow T3 Code to add photos in Settings.") }
        return
      }
      PHPhotoLibrary.shared().performChanges({
        if let original {
          PHAssetCreationRequest.forAsset().addResource(with: .photo, fileURL: original, options: nil)
        } else if let image {
          PHAssetChangeRequest.creationRequestForAsset(from: image)
        }
      }, completionHandler: { saved, error in
        cleanUp()
        DispatchQueue.main.async {
          if saved {
            self?.confirmSaved()
          } else {
            self?.showSaveError(error?.localizedDescription ?? "Photos could not save this image.")
          }
        }
      })
    }
  }

  private func confirmSaved() {
    UINotificationFeedbackGenerator().notificationOccurred(.success)
    UIAccessibility.post(notification: .announcement, argument: "Saved to Photos")
    saveItem.image = UIImage(systemName: "checkmark")
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
      self?.saveItem.image = UIImage(systemName: "square.and.arrow.down")
    }
  }

  private func showSaveError(_ message: String) {
    let alert = UIAlertController(title: "Could not save image", message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "OK", style: .default))
    present(alert, animated: true)
  }

  private func share() {
    let page = pages[currentIndex]
    let item: Any? = fileForPage(currentIndex) ?? (page.isFull ? page.image : nil)
    guard let item else { return }
    let sheet = UIActivityViewController(activityItems: [item], applicationActivities: nil)
    sheet.popoverPresentationController?.sourceItem = shareItem
    present(sheet, animated: true)
  }

  override var canBecomeFirstResponder: Bool { true }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    becomeFirstResponder()
  }

  override var keyCommands: [UIKeyCommand]? {
    [
      UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(handleEscape)),
      UIKeyCommand(input: UIKeyCommand.inputLeftArrow, modifierFlags: [], action: #selector(handlePrevious)),
      UIKeyCommand(input: UIKeyCommand.inputRightArrow, modifierFlags: [], action: #selector(handleNext)),
    ]
  }

  @objc private func handleEscape() { close() }
  @objc private func handlePrevious() { scroll(to: currentIndex - 1) }
  @objc private func handleNext() { scroll(to: currentIndex + 1) }

  override func accessibilityPerformEscape() -> Bool {
    close()
    return true
  }

  override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
    switch direction {
    case .left: scroll(to: currentIndex + 1)
    case .right: scroll(to: currentIndex - 1)
    default: return false
    }
    UIAccessibility.post(notification: .pageScrolled, argument: counterLabel.text)
    return true
  }
}
