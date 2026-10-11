import ExpoModulesCore
import UIKit

/// Reports geometry in the observing view's coordinate space, including system
/// reservations that safe-area rectangles cannot represent, such as the fold.
final class T3LayoutMetricsView: ExpoView {
  let onMetricsChange = EventDispatcher()
  private var lastMetrics: NSDictionary?
  private var hasHinge: Bool? = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    registerForTraitChanges([UITraitHorizontalSizeClass.self, UITraitVerticalSizeClass.self]) { (view: T3LayoutMetricsView, _: UITraitCollection) in
      view.publishMetrics()
    }
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      hasHinge = nil
      addInteraction(UIHingeInteraction { [weak self] _, update in
        guard let self, self.window != nil else { return }
        // Capability survives temporary detachment and does not follow the hinge angle.
        let hasHinge = self.hasHinge == true || update.hinge != nil
        guard self.hasHinge != hasHinge else { return }
        self.hasHinge = hasHinge
        self.publishMetrics()
      })
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) { (view: T3LayoutMetricsView, _: UITraitCollection) in
        view.publishMetrics()
      }
    }
    #endif
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
    guard let window, bounds.width > 0, bounds.height > 0, let hasHinge else { return }
    if hasHinge {
      T3WorkspaceOrientationSubscriber.allowHingeOrientations(in: window)
    }
    var verticalBarEdge = "none"
    var regions: [[String: Any]] = []
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      let rtl = effectiveUserInterfaceLayoutDirection == .rightToLeft
      switch traitCollection.verticalBarEdge {
      case .leading: verticalBarEdge = rtl ? "right" : "left"
      case .trailing: verticalBarEdge = rtl ? "left" : "right"
      default: break
      }
      for kind in [UIView.ReservedRegion.Kind.division, .occlusion] {
        for region in reservedRegions(kind: kind) where region.isActive {
          let frame = region.frame.intersection(bounds)
          guard !frame.isNull, !frame.isEmpty else { continue }
          regions.append([
            "kind": kind == .division ? "division" : "occlusion",
            "x": frame.minX, "y": frame.minY,
            "width": frame.width, "height": frame.height,
          ])
        }
      }
    }
    #endif
    let metrics: [String: Any] = [
      "width": bounds.width, "height": bounds.height,
      "hasHinge": hasHinge,
      "horizontalSizeClass": traitCollection.horizontalSizeClass == .regular ? "regular" : "compact",
      "verticalBarEdge": verticalBarEdge,
      "safeArea": [
        "top": safeAreaInsets.top, "bottom": safeAreaInsets.bottom,
        "left": safeAreaInsets.left, "right": safeAreaInsets.right,
      ],
      "reservedRegions": regions,
    ]
    let next = metrics as NSDictionary
    guard lastMetrics?.isEqual(next) != true else { return }
    lastMetrics = next
    onMetricsChange(metrics)
  }
}
