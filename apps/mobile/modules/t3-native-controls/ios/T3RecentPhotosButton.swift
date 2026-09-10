import ExpoModulesCore
import Photos
import UIKit

/// Keeps the original touch alive while the photo row opens above the keyboard.
final class T3RecentPhotosButton: ExpoView {
  let onPickMedia = EventDispatcher()
  let onPickFiles = EventDispatcher()
  let onPickPhoto = EventDispatcher()
  private let button = UIButton(type: .system)
  private let icon = UIImageView()
  private lazy var hold = UILongPressGestureRecognizer(target: self, action: #selector(held))
  private var picker: T3RecentPhotosOverlay?
  private var generation = 0
  var recentPhotosEnabled = false {
    didSet {
      hold.isEnabled = recentPhotosEnabled
      button.accessibilityHint = recentPhotosEnabled ? "Touch and hold for recent photos" : nil
      button.accessibilityCustomActions = recentPhotosEnabled
        ? [UIAccessibilityCustomAction(name: "Recent photos", target: self, selector: #selector(openAccessible))]
        : nil
      if !recentPhotosEnabled { close() }
    }
  }
  var supportsFiles = false { didSet { updateMenu() } }
  var disabled = false {
    didSet {
      button.isEnabled = !disabled
      alpha = disabled ? 0.5 : 1
      if disabled { close() }
    }
  }
  var iconColor: UIColor = .label { didSet { icon.tintColor = iconColor } }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    icon.image = UIImage(systemName: "plus", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .regular))
    icon.contentMode = .center
    icon.tintColor = .label
    icon.isUserInteractionEnabled = false
    button.accessibilityLabel = "Add attachment"
    button.addTarget(self, action: #selector(tapped), for: .touchUpInside)
    addSubview(button)
    addSubview(icon)
    hold.isEnabled = false
    hold.minimumPressDuration = 0.3
    hold.allowableMovement = 18
    button.addGestureRecognizer(hold)
    updateMenu()
    NotificationCenter.default.addObserver(self, selector: #selector(close), name: UIApplication.willResignActiveNotification, object: nil)
  }

  deinit { NotificationCenter.default.removeObserver(self) }

  override func layoutSubviews() {
    super.layoutSubviews()
    button.frame = bounds
    icon.bounds = bounds
    icon.center = CGPoint(x: bounds.midX, y: bounds.midY)
    // UIKit's menu recognizer must wait for the hold to fail on finger-up.
    // Otherwise its touch-down presentation wins before a long press can begin.
    for recognizer in button.gestureRecognizers ?? [] where recognizer !== hold {
      recognizer.require(toFail: hold)
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil && picker?.isSelecting != true { close() }
  }

  private func updateMenu() {
    button.menu = supportsFiles ? UIMenu(children: [
      UIAction(title: "Photo Library", image: UIImage(systemName: "photo")) { [weak self] _ in self?.onPickMedia([:]) },
      UIAction(title: "Choose Files", image: UIImage(systemName: "folder")) { [weak self] _ in self?.onPickFiles([:]) },
    ]) : nil
    button.showsMenuAsPrimaryAction = supportsFiles
    setNeedsLayout()
  }

  @objc private func tapped() { if !supportsFiles { onPickMedia([:]) } }
  @objc private func openAccessible() -> Bool { open(); return true }
  @objc private func close() {
    generation += 1
    picker?.dismiss()
    picker = nil
  }

  @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
    switch recognizer.state {
    case .began: open()
    case .changed: picker?.hover(at: recognizer.location(in: picker))
    case .ended: picker?.release(at: recognizer.location(in: picker))
    case .cancelled, .failed: picker?.hover(at: nil)
    default: break
    }
  }

  private func open() {
    guard recentPhotosEnabled, !disabled, picker == nil, window != nil else { return }
    generation += 1
    let current = generation
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard status == .authorized || status == .limited else {
      onPickMedia([:])
      return
    }
    let options = PHFetchOptions()
    options.fetchLimit = 4
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    let result = PHAsset.fetchAssets(with: .image, options: options)
    var assets: [PHAsset] = []
    result.enumerateObjects { asset, _, _ in assets.append(asset) }
    guard !assets.isEmpty else { onPickMedia([:]); return }
    guard let window, generation == current else { return }
    let overlay = T3RecentPhotosOverlay(frame: window.bounds, anchor: convert(bounds, to: window), assets: assets, sourceIcon: icon)
    overlay.onDismiss = { [weak self, weak overlay] in
      if self?.picker === overlay { self?.picker = nil }
    }
    overlay.onSelect = { [weak self] assetId, selectionId in self?.onPickPhoto(["assetId": assetId, "selectionId": selectionId]) }
    picker = overlay
    window.addSubview(overlay)
    overlay.open()
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
  }
}

final class T3RecentPhotosOverlay: UIView {
  private static var pending: [String: T3RecentPhotosOverlay] = [:]
  private let selectionId = UUID().uuidString
  static func finish(selectionId: String, target: UIView?) {
    pending.removeValue(forKey: selectionId)?.finishSelection(target: target)
  }
  var onDismiss: (() -> Void)?
  var onSelect: ((String, String) -> Void)?
  private let anchor: CGRect
  private let assets: [PHAsset]
  private weak var sourceIcon: UIImageView?
  private var tiles: [T3RecentPhotoTile] = []
  private var tileFrames: [CGRect] = []
  private var requests: [PHImageRequestID] = []
  private var hovered: Int?
  private var finishing = false
  private var selectedIndex: Int?
  private var isDismissing = false
  var isSelecting: Bool { finishing && !isDismissing }
  private let selectionFeedback = UISelectionFeedbackGenerator()
  private var initialSize: CGSize = .zero
  private var flight: CADisplayLink?
  private weak var destinationView: UIView?
  private var destinationAlpha: CGFloat = 1
  private var flightStart = CGRect.zero
  private var flightIndex = 0
  private var flightStartedAt: CFTimeInterval = 0

  init(frame: CGRect, anchor: CGRect, assets: [PHAsset], sourceIcon: UIImageView?) {
    self.sourceIcon = sourceIcon
    self.anchor = anchor
    self.assets = assets
    super.init(frame: frame)
    initialSize = frame.size
    autoresizingMask = [.flexibleWidth, .flexibleHeight]
    accessibilityViewIsModal = true
    let size = min(76, (frame.width - 40 - 18) / 4)
    let left = min(max(16, anchor.minX), frame.width - CGFloat(assets.count) * (size + 6) - 16)
    for (index, asset) in assets.enumerated() {
      let tile = T3RecentPhotoTile()
      tile.activate = { [weak self] in self?.select(index) }
      tile.layer.cornerRadius = 15
      tile.layer.cornerCurve = .continuous
      tile.backgroundColor = .secondarySystemBackground
      tile.isAccessibilityElement = true
      tile.accessibilityTraits = .button
      tile.accessibilityLabel = "Recent photo \(index + 1)"
      tile.accessibilityHint = "Double tap to attach"
      let action = UIAccessibilityCustomAction(name: "Attach photo", actionHandler: { [weak self] _ in self?.select(index); return true })
      tile.accessibilityCustomActions = [action]
      let tileFrame = CGRect(x: left + CGFloat(index) * (size + 6), y: max(60, anchor.minY - size - 9), width: size, height: size)
      tileFrames.append(tileFrame)
      tile.frame = tileFrame
      addSubview(tile)
      tiles.append(tile)
      let options = PHImageRequestOptions()
      options.deliveryMode = .opportunistic
      options.isNetworkAccessAllowed = true
      let request = PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: size * 3, height: size * 3), contentMode: .aspectFill, options: options) { [weak tile] image, _ in
        DispatchQueue.main.async { if let image { tile?.image = image } }
      }
      requests.append(request)
    }
    let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
    addGestureRecognizer(tap)
    let drag = UIPanGestureRecognizer(target: self, action: #selector(dragged))
    addGestureRecognizer(drag)
    selectionFeedback.prepare()
    NotificationCenter.default.addObserver(self, selector: #selector(dismiss), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(dismiss), name: UIApplication.willResignActiveNotification, object: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  deinit {
    flight?.invalidate()
    NotificationCenter.default.removeObserver(self)
    requests.forEach { PHImageManager.default().cancelImageRequest($0) }
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    if bounds.size != initialSize { dismiss() }
  }
  override func accessibilityPerformEscape() -> Bool { dismiss(); return true }

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    if superview == nil { sourceIcon?.transform = .identity }
  }

  func open() {
    for (index, tile) in tiles.enumerated() {
      tile.alpha = 0
      tile.transform = collapsedTransform(index)
    }
    UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0.15 : 0.38, delay: 0, usingSpringWithDamping: 0.78, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      self.sourceIcon?.transform = CGAffineTransform(rotationAngle: .pi / 4)
    }
    for (index, tile) in tiles.enumerated() {
      UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0.15 : 0.34,
                     delay: UIAccessibility.isReduceMotionEnabled ? 0 : Double(index) * 0.018,
                     usingSpringWithDamping: 0.8, initialSpringVelocity: 0,
                     options: [.beginFromCurrentState, .allowUserInteraction]) {
        tile.alpha = 1
        tile.transform = .identity
      }
    }
    UIAccessibility.post(notification: .screenChanged, argument: tiles.first)
  }

  private func collapsedTransform(_ index: Int) -> CGAffineTransform {
    if UIAccessibility.isReduceMotionEnabled { return .identity }
    let frame = tileFrames[index]
    return CGAffineTransform(translationX: anchor.midX - frame.midX, y: anchor.midY - frame.midY).scaledBy(x: 0.1, y: 0.1)
  }

  private func index(at point: CGPoint?) -> Int? {
    guard let point else { return nil }
    return tileFrames.firstIndex { $0.contains(point) }
  }

  func hover(at point: CGPoint?) {
    guard !finishing else { return }
    let next = index(at: point)
    guard next != hovered else { return }
    hovered = next
    if next != nil { selectionFeedback.selectionChanged() }
    UIView.animate(withDuration: 0.16, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      for (i, tile) in self.tiles.enumerated() {
        tile.transform = i == next && !UIAccessibility.isReduceMotionEnabled ? CGAffineTransform(translationX: 0, y: -10).scaledBy(x: 1.12, y: 1.12) : .identity
      }
    }
  }

  func release(at point: CGPoint) {
    if let index = index(at: point) { select(index) } else { hover(at: nil) }
  }
  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    if let index = index(at: gesture.location(in: self)) { select(index) } else { dismiss() }
  }
  @objc private func dragged(_ gesture: UIPanGestureRecognizer) {
    if gesture.state == .ended {
      release(at: gesture.location(in: self))
    } else {
      hover(at: gesture.state == .cancelled ? nil : gesture.location(in: self))
    }
  }

  @objc func dismiss() {
    guard !isDismissing else { return }
    isDismissing = true
    flight?.invalidate()
    flight = nil
    destinationView?.alpha = destinationAlpha
    finishing = true
    Self.pending.removeValue(forKey: selectionId)
    requests.forEach { PHImageManager.default().cancelImageRequest($0) }
    UIView.animate(withDuration: 0.22, delay: 0, options: [.beginFromCurrentState]) {
      self.sourceIcon?.transform = .identity
      for (index, tile) in self.tiles.enumerated() {
        tile.transform = self.collapsedTransform(index)
        tile.alpha = 0
      }
    } completion: { _ in self.removeFromSuperview(); self.onDismiss?() }
  }

  private func select(_ index: Int) {
    guard !finishing else { return }
    finishing = true
    let spinner = UIActivityIndicatorView(style: .medium)
    spinner.center = CGPoint(x: tileFrames[index].midX, y: tileFrames[index].midY)
    addSubview(spinner)
    spinner.startAnimating()
    selectedIndex = index
    Self.pending[selectionId] = self
    onSelect?(assets[index].localIdentifier, selectionId)
    // A bridge reload can drop the finalization callback. Release only a
    // selection still awaiting JavaScript, never one already in flight.
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
      guard let self, Self.pending[self.selectionId] === self else { return }
      self.dismiss()
    }
  }

  func finishSelection(target: UIView?) {
    guard let index = selectedIndex else { return }
    selectedIndex = nil
    subviews.compactMap { $0 as? UIActivityIndicatorView }.forEach { $0.removeFromSuperview() }
    guard let target, target.window === window else {
      finishing = false
      dismiss()
      return
    }
    // The composer grows while the photo lands. Track its real position during
    // this finite flight instead of measuring the still-collapsed layout once.
    destinationView = target
    destinationAlpha = target.alpha
    target.alpha = 0
    flightIndex = index
    flightStart = tiles[index].layer.presentation()?.frame ?? tiles[index].frame
    tiles[index].layer.removeAllAnimations()
    tiles[index].transform = .identity
    tiles[index].frame = flightStart
    flightStartedAt = CACurrentMediaTime()
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    UIView.animate(withDuration: 0.22, delay: 0, options: [.beginFromCurrentState]) {
      self.sourceIcon?.transform = .identity
      for (i, tile) in self.tiles.enumerated() where i != index {
        tile.transform = self.collapsedTransform(i)
        tile.alpha = 0
      }
    }
    let link = CADisplayLink(target: self, selector: #selector(advanceFlight))
    flight = link
    link.add(to: .main, forMode: .common)
  }

  @objc private func advanceFlight() {
    guard let target = destinationView, target.window === window else {
      dismiss()
      return
    }
    let duration = UIAccessibility.isReduceMotionEnabled ? 0.15 : 0.42
    let progress = min(1, (CACurrentMediaTime() - flightStartedAt) / duration)
    let destination = target.convert(target.bounds, to: self)
    let tile = tiles[flightIndex]
    if UIAccessibility.isReduceMotionEnabled {
      tile.alpha = 1 - progress
    } else {
      let eased = 1 - pow(1 - progress, 3)
      tile.frame = CGRect(
        x: flightStart.minX + (destination.minX - flightStart.minX) * eased,
        y: flightStart.minY + (destination.minY - flightStart.minY) * eased,
        width: flightStart.width + (destination.width - flightStart.width) * eased,
        height: flightStart.height + (destination.height - flightStart.height) * eased
      )
    }
    if progress >= 1 {
      flight?.invalidate()
      flight = nil
      target.alpha = destinationAlpha
      removeFromSuperview()
      onDismiss?()
    }
  }

}

private final class T3RecentPhotoTile: UIView {
  private let imageView = UIImageView()
  var image: UIImage? {
    get { imageView.image }
    set { imageView.image = newValue }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    imageView.layer.cornerRadius = 15
    imageView.layer.cornerCurve = .continuous
    addSubview(imageView)
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.18
    layer.shadowRadius = 8
    layer.shadowOffset = CGSize(width: 0, height: 4)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = bounds
    layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: 15).cgPath
  }

  var activate: (() -> Void)?
  override func accessibilityActivate() -> Bool { activate?(); return true }
}
