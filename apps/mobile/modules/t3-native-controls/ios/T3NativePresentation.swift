import ExpoModulesCore
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
  activity.modalPresentationStyle = .popover
  activity.popoverPresentationController?.sourceView = origin
  activity.popoverPresentationController?.sourceRect = source?.bounds
    ?? CGRect(x: origin.bounds.midX, y: origin.bounds.maxY, width: 0, height: 0)
  presenter.present(activity, animated: true)
}
