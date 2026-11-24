import ExpoModulesCore
import UIKit

/// Visible portion of `view` inside `container`, clipped by every `clipsToBounds` ancestor.
func clippedVisibleRect(of view: UIView, in container: UIView) -> CGRect {
  guard let window = view.window, !view.isHidden, view.alpha > 0.01 else { return .null }
  var rect = view.bounds
  guard !rect.isEmpty else { return .null }
  var current: UIView = view
  while let parent = current.superview {
    if parent.isHidden || parent.alpha <= 0.01 { return .null }
    rect = current.convert(rect, to: parent)
    if parent.clipsToBounds {
      rect = rect.intersection(parent.bounds)
      if rect.isNull || rect.isEmpty { return .null }
    }
    current = parent
    if parent === window { break }
  }
  let inContainer = current.convert(rect, to: container)
  return inContainer.intersection(container.bounds)
}

/// Whether enough of `view` is visible inside `container` to serve as a zoom transition target.
func isVisiblePresentationTarget(_ view: UIView, in container: UIView) -> Bool {
  let fullArea = view.bounds.width * view.bounds.height
  guard fullArea > 1 else { return false }
  let visible = clippedVisibleRect(of: view, in: container)
  return visible.width > 1 && visible.height > 1 && visible.width * visible.height >= fullArea * 0.25
}

final class T3PresentationSources {
  private class Entry {
    weak var view: UIView?
    init(_ view: UIView) { self.view = view }
  }

  /// The same file embedded twice registers twice; removing one copy keeps the other.
  private var entries: [String: [Entry]] = [:]

  func register(_ view: UIView, identifier: String) {
    var list = (entries[identifier] ?? []).filter { $0.view != nil && $0.view !== view }
    list.append(Entry(view))
    entries[identifier] = list
  }

  func remove(_ view: UIView, identifier: String) {
    let list = (entries[identifier] ?? []).filter { $0.view != nil && $0.view !== view }
    entries[identifier] = list.isEmpty ? nil : list
  }

  func view(for identifier: String) -> UIView? {
    let views = (entries[identifier] ?? []).compactMap(\.view)
    // Prefer a visible copy, the latest first; use the child bounds, not the wrapper's stretched ones.
    let source = views.last(where: { view in
      guard let window = view.window, let target = view.subviews.first else { return false }
      return isVisiblePresentationTarget(target, in: window)
    }) ?? views.last(where: { $0.window != nil && !$0.subviews.isEmpty })
      ?? views.last(where: { !$0.subviews.isEmpty })
    return source?.subviews.first
  }
}

final class T3PresentationSourceView: ExpoView {
  weak var sources: T3PresentationSources?
  var identifier = "" {
    didSet { updateRegistration(old: oldValue, new: identifier) }
  }
  var fallbackIdentifier = "" {
    didSet { updateRegistration(old: oldValue, new: fallbackIdentifier) }
  }

  private func updateRegistration(old: String, new: String) {
    guard old != new else { return }
    if !old.isEmpty, old != identifier, old != fallbackIdentifier {
      sources?.remove(self, identifier: old)
    }
    if !new.isEmpty { sources?.register(self, identifier: new) }
  }

  deinit {
    if !identifier.isEmpty { sources?.remove(self, identifier: identifier) }
    if !fallbackIdentifier.isEmpty { sources?.remove(self, identifier: fallbackIdentifier) }
  }
}

final class T3ContextSheetSizeView: ExpoView {
  var contentHeight: CGFloat = 0 {
    didSet { updateSheet() }
  }
  private weak var configuredSheet: UISheetPresentationController?
  private var appliedHeight: CGFloat = 0

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // The modal's presentation controller is attached after the content view.
    DispatchQueue.main.async { [weak self] in self?.updateSheet() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    updateSheet()
  }

  private func updateSheet() {
    guard window != nil, contentHeight > 0 else { return }
    var responder: UIResponder? = self
    while let current = responder {
      if let controller = current as? UIViewController,
         controller.presentingViewController != nil,
         let sheet = controller.sheetPresentationController {
        guard configuredSheet !== sheet || abs(appliedHeight - contentHeight) > 1 else { return }
        configuredSheet = sheet
        appliedHeight = contentHeight
        let height = contentHeight
        let identifier = UISheetPresentationController.Detent.Identifier("t3-context-content")
        sheet.animateChanges {
          sheet.detents = [.custom(identifier: identifier) { context in
            min(height, context.maximumDetentValue * 0.92)
          }]
          sheet.selectedDetentIdentifier = identifier
          sheet.prefersGrabberVisible = true
          sheet.prefersScrollingExpandsWhenScrolledToEdge = false
        }
        return
      }
      responder = current.next
    }
  }
}

func presentFileShare(
  url: URL,
  title: String,
  source: UIView?,
  presenter: UIViewController,
  promise: Promise
) throws {
  guard url.isFileURL, FileManager.default.isReadableFile(atPath: url.path) else {
    throw NSError(
      domain: "T3NativePresentation",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "The file is no longer available."]
    )
  }

  guard let origin = source ?? presenter.view else {
    throw NSError(
      domain: "T3NativePresentation",
      code: 2,
      userInfo: [NSLocalizedDescriptionKey: "The presenting screen is no longer open."]
    )
  }

  let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
  activity.title = title
  activity.overrideUserInterfaceStyle = source?.traitCollection.userInterfaceStyle
    ?? presenter.traitCollection.userInterfaceStyle
  activity.completionWithItemsHandler = { _, _, _, _ in promise.resolve(nil) }
  if presenter.traitCollection.userInterfaceIdiom == .pad {
    activity.popoverPresentationController?.sourceView = origin
    activity.popoverPresentationController?.sourceRect = source?.bounds
      ?? CGRect(x: origin.bounds.midX, y: origin.bounds.midY, width: 1, height: 1)
  } else {
    // Let UIKit adapt the remote share scene to the phone, not an anchored popover.
    activity.modalPresentationStyle = .automatic
  }
  presenter.present(activity, animated: true)
}
