import ExpoModulesCore
import UIKit

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
    // Prefer an on-screen copy, the latest first; use the child bounds, not the wrapper's stretched ones.
    let source = views.last(where: { view in
      guard let window = view.window else { return false }
      return window.bounds.intersects(view.convert(view.bounds, to: window))
    }) ?? views.last
    return source?.subviews.first
  }
}

final class T3PresentationSourceView: ExpoView {
  weak var sources: T3PresentationSources?
  var identifier = "" {
    didSet {
      sources?.remove(self, identifier: oldValue)
      if !identifier.isEmpty { sources?.register(self, identifier: identifier) }
    }
  }

  deinit {
    sources?.remove(self, identifier: identifier)
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
