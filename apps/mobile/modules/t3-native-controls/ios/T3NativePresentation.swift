import ExpoModulesCore
import RNScreens
import UIKit

final class T3PresentationSources {
  private class Entry {
    weak var view: UIView?
    init(_ view: UIView) { self.view = view }
  }

  private var entries: [String: Entry] = [:]

  func register(_ view: UIView, identifier: String) {
    entries[identifier] = Entry(view)
  }

  func remove(_ view: UIView, identifier: String) {
    if entries[identifier]?.view == nil || entries[identifier]?.view === view {
      entries.removeValue(forKey: identifier)
    }
  }

  func view(for identifier: String) -> UIView? {
    // Use the child bounds, not the wrapper's potentially stretched layout bounds.
    entries[identifier]?.view?.subviews.first
  }

  func configureZoom(
    for controller: UIViewController,
    sourceIdentifier: String,
    alignmentRect: @escaping (UIViewController) -> CGRect? = { _ in nil }
  ) {
    guard #available(iOS 18.0, *), !UIAccessibility.isReduceMotionEnabled,
      !sourceIdentifier.isEmpty
    else { return }
    let options = UIViewController.Transition.ZoomOptions()
    options.alignmentRectProvider = { context in alignmentRect(context.zoomedViewController) }
    controller.preferredTransition = .zoom(options: options) { [weak self] _ in
      self?.view(for: sourceIdentifier)
    }
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

final class T3ZoomTransitionView: ExpoView {
  weak var sources: T3PresentationSources?
  var sourceIdentifier = ""
  var colorScheme: String? {
    didSet {
      overrideUserInterfaceStyle = colorScheme == "dark" ? .dark
        : colorScheme == "light" ? .light : .unspecified
    }
  }

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    updateTransition()
  }

  func updateTransition() {
    guard superview != nil else { return }
    // The native stack attaches its screen controller after mounting the children.
    DispatchQueue.main.async { [weak self] in self?.configureTransition() }
  }

  private func configureTransition() {
    var responder: UIResponder? = self
    while let current = responder {
      if let screen = current as? RNSScreen {
        // RNS wraps a modal with a visible native header in an inner stack.
        // UIKit presents the outer screen, so it owns the zoom and dismissal.
        let destination = screen.navigationController?.parent as? RNSScreen ?? screen
        sources?.configureZoom(for: destination, sourceIdentifier: sourceIdentifier) { [weak self] controller in
          guard let self else { return nil }
          return self.convert(self.bounds, to: controller.view)
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
    throw NSError(domain: "T3NativePresentation", code: 1,
      userInfo: [NSLocalizedDescriptionKey: "The file is no longer available."])
  }

  let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
  activity.title = title
  activity.overrideUserInterfaceStyle = source?.traitCollection.userInterfaceStyle
    ?? presenter.traitCollection.userInterfaceStyle
  activity.completionWithItemsHandler = { _, _, _, _ in promise.resolve(nil) }
  activity.modalPresentationStyle = .popover
  let origin = source ?? presenter.view!
  activity.popoverPresentationController?.sourceView = origin
  activity.popoverPresentationController?.sourceRect = source?.bounds
    ?? CGRect(x: origin.bounds.midX, y: origin.bounds.maxY, width: 0, height: 0)
  presenter.present(activity, animated: true)
}
