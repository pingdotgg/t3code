import ExpoModulesCore
import UIKit

/// Wraps a screen's header scroll view. Where a column pads its content away from the iPhone Duo's
/// vertical bar, this widens the scroll view under the bar, like the system apps' lists. UIKit
/// draws the header's scroll-edge effect inside the scroll view, so the blur reaches the bar while
/// the content stays in the safe area, and the scroll indicator runs along the screen edge past the
/// bar, as in Messages. Everything happens in UIKit layout, so folds move the blur and the content
/// together.
final class T3ScrollEdgeBleedView: ExpoView {
  // Fabric recycles scroll views, so everything changed here is put back before this view leaves
  // the window, which unmounting does before any recycling.
  private var scrollView: UIScrollView?
  private var container: UIView?
  /// React Native's content view, which every row lives in.
  private var content: UIView?
  private var bleed = UIEdgeInsets.zero
  /// Whether the scroll view currently carries this view's changes.
  private var applied = false
  /// React Native's clipping, saved while bleeding. React Native only rewrites it when the
  /// `overflow` style changes, so it stays off while bleeding.
  private var containerClipped: Bool?
  /// The bar's side is read from the root view controller, whose traits can settle after this
  /// view's own during a fold; with no size change after that, nothing else would recheck.
  private weak var observedWindow: UIWindow?
  private var windowTraitRegistration: (any UITraitChangeRegistration)?
  // DIAGNOSTIC BUILD ONLY: live overlay of the bleed decision.
  private var layoutCount = 0
  private let diagLabel = UILabel()
  private var diagTimer: Timer?

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
    MainActor.assumeIsolated {
      diagTimer?.invalidate()
      diagLabel.removeFromSuperview()
      detach()
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    observeWindowTraits()
    if window == nil { detach() } else { setNeedsLayout() }
    updateDiagTimer()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    setNeedsLayout()
  }

  private func observeWindowTraits() {
    guard observedWindow !== window else { return }
    if let observedWindow, let windowTraitRegistration {
      observedWindow.unregisterForTraitChanges(windowTraitRegistration)
    }
    observedWindow = window
    windowTraitRegistration = nil
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *), let window {
      windowTraitRegistration = window.registerForTraitChanges(
        UITraitCollection.systemTraitsAffectingVerticalBarEdge
      ) { [weak self] (_: UIWindow, _: UITraitCollection) in
        self?.setNeedsLayout()
      }
    }
    #endif
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
    layoutCount += 1
    guard window != nil, let found = findScrollView(), let parent = found.superview else { return }
    if found !== scrollView {
      detach()
      scrollView = found
      container = parent
      // React Native adds one plain UIView to its scroll view and mounts every child into it.
      content = found.subviews.first { type(of: $0) == UIView.self }
    }
    bleed = verticalBarBleed()
    // Without the content view to shift back, bleeding left would move the rows under the bar.
    if content == nil { bleed.left = 0 }
    apply()
  }

  /// How far the vertical bar's safe area reaches past this view's edge, when this view sits flush
  /// against the padding its column added for it. Nothing else is bled into: not a sidebar column
  /// overlapping this one, and not a notch.
  private func verticalBarBleed() -> UIEdgeInsets {
    guard let side = verticalBarSide() else { return .zero }
    var ancestor = superview
    while let view = ancestor {
      let inset = side == .left ? view.safeAreaInsets.left : view.safeAreaInsets.right
      if inset > 0 {
        let frame = convert(bounds, to: view)
        let flush = side == .left
          ? abs(frame.minX - (view.bounds.minX + inset)) < 0.5
          : abs(view.bounds.maxX - inset - frame.maxX) < 0.5
        guard flush else { return .zero }
        return side == .left
          ? UIEdgeInsets(top: 0, left: inset, bottom: 0, right: 0)
          : UIEdgeInsets(top: 0, left: 0, bottom: 0, right: inset)
      }
      ancestor = view.superview
    }
    return .zero
  }

  private enum Side { case left, right }

  private func verticalBarSide() -> Side? {
    // The vertical-bar API ships in the iOS 27.1 SDK (UIKit 9127.0.85); see T3LayoutMetricsView.
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      // UIKit leaves the trait unset in a split view's inspector column, though the bar overlaps
      // it; the flush check above still decides whether this view sits at the bar.
      let traits = window?.rootViewController?.traitCollection ?? traitCollection
      let rtl = effectiveUserInterfaceLayoutDirection == .rightToLeft
      switch traits.verticalBarEdge {
      case .leading: return rtl ? .right : .left
      case .trailing: return rtl ? .left : .right
      default: return nil
      }
    }
    #endif
    return nil
  }

  /// Widening to the left would move the rows with it. Instead of a horizontal content offset,
  /// which React Native rewrites on its own layout passes, the content view's bounds origin shifts
  /// them back: React Native only ever sets that view's frame, which leaves its bounds origin.
  /// Nothing at all is written unless this view is bleeding or undoing its bleed.
  private func apply() {
    guard let scrollView, let container else { return }
    let bleeding = bleed != .zero
    guard bleeding || applied else { return }
    // React Native sizes the scroll view's component view; the UIScrollView inside follows it by
    // autoresizing, so the widened frame survives React Native's own layout updates.
    let frame = container.bounds.inset(
      by: UIEdgeInsets(top: 0, left: -bleed.left, bottom: 0, right: -bleed.right))
    if scrollView.frame != frame { scrollView.frame = frame }
    if let content, content.bounds.origin.x != -bleed.left {
      content.bounds.origin.x = -bleed.left
    }
    if !bleeding {
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
    applied = bleeding
  }

  private func updateDiagTimer() {
    diagTimer?.invalidate()
    diagTimer = nil
    guard window != nil else {
      diagLabel.removeFromSuperview()
      return
    }
    diagLabel.numberOfLines = 0
    diagLabel.font = .monospacedSystemFont(ofSize: 10, weight: .medium)
    diagLabel.textColor = .white
    diagLabel.backgroundColor = UIColor.black.withAlphaComponent(0.75)
    diagLabel.isUserInteractionEnabled = false
    diagTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.updateDiag() }
    }
    updateDiag()
  }

  private func updateDiag() {
    guard let window else { return }
    if diagLabel.superview !== window { window.addSubview(diagLabel) }
    window.bringSubviewToFront(diagLabel)
    diagLabel.text = diagnostics()
    let frame = convert(bounds, to: window)
    let size = diagLabel.sizeThatFits(CGSize(width: min(frame.width - 16, 380), height: 300))
    diagLabel.frame = CGRect(x: frame.minX + 8, y: frame.midY - 60, width: size.width, height: size.height)
  }

  private func diagnostics() -> String {
    func f(_ v: CGFloat) -> String { String(format: "%.1f", v) }
    var lines: [String] = []
    var edges = "edge api n/a"
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      func d(_ t: UITraitCollection?) -> String {
        guard let t else { return "nil" }
        switch t.verticalBarEdge {
        case .leading: return "L"
        case .trailing: return "T"
        default: return "-"
        }
      }
      edges = "edge root \(d(window?.rootViewController?.traitCollection)) win \(d(window?.traitCollection)) own \(d(traitCollection))"
    }
    #endif
    lines.append(edges)
    if let window {
      let s = window.safeAreaInsets
      lines.append("window w\(f(window.bounds.width)) safe L\(f(s.left)) R\(f(s.right))")
    }
    var ancestor = superview
    var depth = 1
    var found = "no inset ancestor"
    while let view = ancestor {
      let insets = view.safeAreaInsets
      if insets.left > 0 || insets.right > 0 {
        let r = convert(bounds, to: view)
        found = "d\(depth) \(type(of: view)) L\(f(insets.left)) R\(f(insets.right)) gapL \(f(r.minX - view.bounds.minX - insets.left)) gapR \(f(view.bounds.maxX - insets.right - r.maxX))"
        break
      }
      ancestor = view.superview
      depth += 1
    }
    lines.append(found)
    let live = verticalBarBleed()
    lines.append("bleed applied L\(f(bleed.left)) R\(f(bleed.right)) live L\(f(live.left)) R\(f(live.right))")
    if let scrollView, let container {
      lines.append("sv x\(f(scrollView.frame.minX)) w\(f(scrollView.frame.width)) cont w\(f(container.bounds.width)) clip \(container.layer.masksToBounds) content \(content != nil)")
    } else {
      lines.append("no scroll view")
    }
    lines.append("layouts \(layoutCount) self w\(f(bounds.width))")
    return lines.joined(separator: "\n")
  }

  private func detach() {
    guard scrollView != nil else { return }
    bleed = .zero
    apply()
    scrollView = nil
    container = nil
    content = nil
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
