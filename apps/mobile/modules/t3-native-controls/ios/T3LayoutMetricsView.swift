import ExpoModulesCore
import UIKit

/// Reports the body geometry of a native navigation column.
final class T3LayoutMetricsView: ExpoView {
  let onMetricsChange = EventDispatcher()
  private var lastMetrics: NSDictionary?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    registerForTraitChanges([UITraitHorizontalSizeClass.self, UITraitVerticalSizeClass.self]) {
      (view: T3LayoutMetricsView, _: UITraitCollection) in
      view.publishMetrics()
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    lastMetrics = nil
    publishMetrics()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    publishMetrics()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    publishMetrics()
  }

  private func publishMetrics() {
    guard window != nil, bounds.width > 0, bounds.height > 0 else { return }
    let metrics: [String: Any] = [
      "width": bounds.width, "height": bounds.height,
      "horizontalSizeClass": traitCollection.horizontalSizeClass == .regular ? "regular" : "compact",
      "safeArea": [
        "top": safeAreaInsets.top, "bottom": safeAreaInsets.bottom,
        "left": safeAreaInsets.left, "right": safeAreaInsets.right,
      ],
    ]
    let next = metrics as NSDictionary
    guard lastMetrics?.isEqual(next) != true else { return }
    lastMetrics = next
    onMetricsChange(metrics)
  }
}
