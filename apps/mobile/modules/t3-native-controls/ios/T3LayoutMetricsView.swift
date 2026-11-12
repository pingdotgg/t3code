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
    // The hinge and vertical-bar APIs ship in the iOS 27.1 SDK, whose UIKit is 9127.0.85.
    // Xcode 27.0 has Swift 6.4 but the 27.0 SDK (UIKit 9127.0.84), so gate on the SDK.
    #if canImport(UIKit, _version: 9127.0.85)
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
    assumeNoHingeIfSilent()
    publishMetrics()
  }

  /// UIKit only sends hinge updates on devices that have a hinge. Without this,
  /// an ordinary iPhone never publishes and the navigator never attaches.
  private func assumeNoHingeIfSilent() {
    guard window != nil, hasHinge == nil else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
      guard let self, self.window != nil, self.hasHinge == nil else { return }
      self.hasHinge = false
      self.publishMetrics()
    }
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
    var bottomBarInset: CGFloat?
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      let rtl = effectiveUserInterfaceLayoutDirection == .rightToLeft
      switch traitCollection.verticalBarEdge {
      case .leading: verticalBarEdge = rtl ? "right" : "left"
      case .trailing: verticalBarEdge = rtl ? "left" : "right"
      default: break
      }
      // Where UIKit floats a bar as tall as the app's bottom controls, level with its tab bar.
      bottomBarInset = edgeInsets(for: .bar(onEdge: UIRectEdge.bottom, extent: 48)).bottom
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
    var metrics: [String: Any] = [
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
    metrics["bottomBarInset"] = bottomBarInset
    let next = metrics as NSDictionary
    guard lastMetrics?.isEqual(next) != true else { return }
    lastMetrics = next
    onMetricsChange(metrics)
  }
}
