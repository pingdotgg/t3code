import ExpoModulesCore
import UIKit

/// Wraps a screen's header scroll view. Where a column pads its content away from the iPhone Duo's
/// vertical bar, this widens the scroll view under the bar. UIKit draws
/// the header's scroll-edge effect inside the scroll view, so the blur reaches the bar like in the
/// system apps while the content stays in the safe area. Everything happens in UIKit layout, so
/// folds move the blur and the content together.
final class T3ScrollEdgeBleedView: ExpoView {
  // Fabric recycles scroll views, so everything changed here is put back before this view leaves
  // the window, which unmounting does before any recycling.
  private var scrollView: UIScrollView?
  private var container: UIView?
  private var bleed: CGFloat = 0
  /// Whether the scroll view currently carries this view's changes.
  private var applied = false
  /// React Native's clipping, saved while bleeding. React Native only rewrites it when the
  /// `overflow` style changes, so it stays off while bleeding.
  private var containerClipped: Bool?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) { (view: T3ScrollEdgeBleedView, _: UITraitCollection) in
        view.setNeedsLayout()
      }
    }
    #endif
  }

  deinit {
    MainActor.assumeIsolated { detach() }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { detach() } else { setNeedsLayout() }
  }

  override func didAddSubview(_ subview: UIView) {
    super.didAddSubview(subview)
    setNeedsLayout()
  }

  override func willRemoveSubview(_ subview: UIView) {
    if let scrollView, scrollView.isDescendant(of: subview) { detach() }
    super.willRemoveSubview(subview)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard window != nil, let found = findScrollView(), let parent = found.superview else { return }
    if found !== scrollView {
      detach()
      scrollView = found
      container = parent
    }
    bleed = verticalBarBleed()
    apply()
  }

  /// How far the vertical bar's safe area reaches past this view's right edge, when this view sits
  /// flush against the padding its column added for it. Nothing else is bled into: not a sidebar
  /// column overlapping this one, not a notch, and not a bar on the left, where widening would
  /// move the content and need a horizontal offset React Native keeps rewriting.
  private func verticalBarBleed() -> CGFloat {
    guard verticalBarIsOnTheRight() else { return 0 }
    var ancestor = superview
    while let view = ancestor {
      let inset = view.safeAreaInsets.right
      if inset > 0 {
        let frame = convert(bounds, to: view)
        return abs(view.bounds.maxX - inset - frame.maxX) < 0.5 ? inset : 0
      }
      ancestor = view.superview
    }
    return 0
  }

  private func verticalBarIsOnTheRight() -> Bool {
    // The vertical-bar API ships in the iOS 27.1 SDK (UIKit 9127.0.85); see T3LayoutMetricsView.
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      let rtl = effectiveUserInterfaceLayoutDirection == .rightToLeft
      switch traitCollection.verticalBarEdge {
      case .leading: return rtl
      case .trailing: return !rtl
      default: return false
      }
    }
    #endif
    return false
  }

  /// Widening to the right leaves the content where React Native laid it out, so only the frame,
  /// the container's clipping and the scroll indicator change; contentInset and contentOffset are
  /// never touched. Nothing at all is written unless this view is bleeding or undoing its bleed.
  private func apply() {
    guard let scrollView, let container else { return }
    guard bleed > 0 || applied else { return }
    // React Native sizes the scroll view's component view; the UIScrollView inside follows it by
    // autoresizing, so the widened frame survives React Native's own layout updates.
    let frame = container.bounds.inset(by: UIEdgeInsets(top: 0, left: 0, bottom: 0, right: -bleed))
    if scrollView.frame != frame { scrollView.frame = frame }
    if bleed == 0 {
      if let clipped = containerClipped {
        containerClipped = nil
        container.layer.masksToBounds = clipped
      }
    } else if container.layer.masksToBounds {
      // The component view clips to its own bounds, which would cut the widened scroll view back.
      // The scroll view itself still clips its content.
      containerClipped = containerClipped ?? true
      container.layer.masksToBounds = false
    }
    var indicators = scrollView.verticalScrollIndicatorInsets
    if indicators.right != bleed {
      indicators.right = bleed
      scrollView.verticalScrollIndicatorInsets = indicators
    }
    applied = bleed > 0
  }

  private func detach() {
    guard scrollView != nil else { return }
    bleed = 0
    apply()
    scrollView = nil
    container = nil
  }

  /// The scroll view sits a fixed few levels down (marker, React Native's scroll view component);
  /// never walk into a scroll view's content.
  private func findScrollView() -> UIScrollView? {
    var level: [UIView] = subviews
    for _ in 0..<4 {
      var next: [UIView] = []
      for view in level {
        if let scrollView = view as? UIScrollView { return scrollView }
        next.append(contentsOf: view.subviews)
      }
      level = next
    }
    return nil
  }
}
