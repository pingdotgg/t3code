import ExpoModulesCore
import UIKit

/// Wraps a screen's header scroll view. Where a column pads its content away from a side safe
/// area (the iPhone Duo's vertical bar), this widens the scroll view under that band. UIKit draws
/// the header's scroll-edge effect inside the scroll view, so the blur reaches the bar like in the
/// system apps while the content stays in the safe area. Everything happens in UIKit layout, so
/// folds move the blur and the content together.
final class T3ScrollEdgeBleedView: ExpoView {
  // Fabric recycles scroll views, so everything changed here is put back before this view leaves
  // the window, which unmounting does before any recycling.
  private var scrollView: UIScrollView?
  private var container: UIView?
  private var bleed = UIEdgeInsets.zero
  /// React Native's clipping, saved while bleeding. React Native only rewrites it when the
  /// `overflow` style changes, so it stays off while bleeding.
  private var containerClipped: Bool?

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
    bleed = flushSafeAreaBand()
    apply()
  }

  /// The side safe areas this view sits flush against: an ancestor padded its content away from
  /// them. Only those bands are bled into, so a screen with its own margins is left alone.
  private func flushSafeAreaBand() -> UIEdgeInsets {
    var ancestor = superview
    while let view = ancestor {
      let insets = view.safeAreaInsets
      if insets.left > 0 || insets.right > 0 {
        let frame = convert(bounds, to: view)
        let left = insets.left > 0 && abs(frame.minX - insets.left) < 0.5 ? insets.left : 0
        let right = insets.right > 0 && abs(view.bounds.maxX - insets.right - frame.maxX) < 0.5
          ? insets.right : 0
        return UIEdgeInsets(top: 0, left: left, bottom: 0, right: right)
      }
      ancestor = view.superview
    }
    return .zero
  }

  /// Widening to the right leaves the content in place. Widening to the left moves it with the
  /// frame, so a left inset and offset put it back.
  private func apply() {
    guard let scrollView, let container else { return }
    // React Native sizes the scroll view's component view; the UIScrollView inside follows it by
    // autoresizing, so the widened frame survives React Native's own layout updates.
    let frame = container.bounds.inset(by: UIEdgeInsets(top: 0, left: -bleed.left, bottom: 0, right: -bleed.right))
    if scrollView.frame != frame { scrollView.frame = frame }
    if bleed == .zero {
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
    var inset = scrollView.contentInset
    if inset.left != bleed.left {
      inset.left = bleed.left
      scrollView.contentInset = inset
    }
    var indicators = scrollView.verticalScrollIndicatorInsets
    if indicators.right != bleed.right {
      indicators.right = bleed.right
      scrollView.verticalScrollIndicatorInsets = indicators
    }
    let x = -scrollView.adjustedContentInset.left
    if scrollView.contentOffset.x != x {
      scrollView.contentOffset = CGPoint(x: x, y: scrollView.contentOffset.y)
    }
  }

  private func detach() {
    guard scrollView != nil else { return }
    bleed = .zero
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
