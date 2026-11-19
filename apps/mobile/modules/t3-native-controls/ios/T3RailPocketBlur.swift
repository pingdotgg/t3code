import ExpoModulesCore
import QuartzCore
import UIKit

// Folded iPhone Duo rail (iOS 27.2): after a return from the background, UIKit lays the tab bar's
// private VerticalBarPocketView over the whole rail, above the screen's, and its CABackdropLayer
// blurs the screen's header buttons. A UIKit rename of these private classes makes this a no-op.
public final class T3RailPocketBlurSubscriber: ExpoAppDelegateSubscriber {
  public func applicationDidBecomeActive(_ application: UIApplication) {
    // UIKit can add the second pocket a moment after activation, so look again shortly after.
    DispatchQueue.main.async { T3RailPocketBlur.update() }
    for delay in [0.3, 1.5] {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { T3RailPocketBlur.update() }
    }
  }
}

@MainActor
enum T3RailPocketBlur {
  private static let pocketClassName = "VerticalBar".appending("PocketView")
  private static let backdropClassName = "CABackdrop".appending("Layer")
  /// Backdrop layers this hid, so they can be shown again once their pocket is alone.
  private static let hiddenLayers = NSHashTable<CALayer>.weakObjects()

  private struct Pocket {
    let view: UIView
    /// Subview indexes from the window, which give the drawing order.
    let path: [Int]
    let frame: CGRect
  }

  static func update() {
    var stacked: [CALayer] = []
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
    for window in windows {
      var pockets: [Pocket] = []
      var path: [Int] = []
      collectPockets(in: window, window: window, path: &path, into: &pockets)
      let overlapping = pockets.filter { pocket in
        pockets.contains { $0.view !== pocket.view && $0.frame.intersects(pocket.frame) }
      }
      if let top = overlapping.max(by: { drawsBelow($0.path, $1.path) }) {
        stacked += backdropLayers(of: top.view)
      }
    }
    for layer in hiddenLayers.allObjects where !stacked.contains(where: { $0 === layer }) {
      layer.isHidden = false
      hiddenLayers.remove(layer)
    }
    // A backdrop UIKit hid itself stays UIKit's to show again.
    for layer in stacked where !layer.isHidden {
      layer.isHidden = true
      hiddenLayers.add(layer)
    }
  }

  private static func collectPockets(
    in view: UIView, window: UIWindow, path: inout [Int], into pockets: inout [Pocket]
  ) {
    guard !view.isHidden, view.alpha > 0.01 else { return }
    if NSStringFromClass(type(of: view)).contains(pocketClassName) {
      let frame = view.convert(view.bounds, to: window)
      if !frame.isEmpty { pockets.append(Pocket(view: view, path: path, frame: frame)) }
    }
    for (index, subview) in view.subviews.enumerated() {
      path.append(index)
      collectPockets(in: subview, window: window, path: &path, into: &pockets)
      path.removeLast()
    }
  }

  /// A later sibling, or a descendant, draws above.
  private static func drawsBelow(_ a: [Int], _ b: [Int]) -> Bool {
    for (x, y) in zip(a, b) where x != y { return x < y }
    return a.count < b.count
  }

  /// The pocket's frost is a layer no view owns, holding the backdrop layer that blurs.
  private static func backdropLayers(of pocket: UIView) -> [CALayer] {
    (pocket.layer.sublayers ?? []).filter { layer in
      !(layer.delegate is UIView)
        && ([layer] + (layer.sublayers ?? [])).contains {
          NSStringFromClass(type(of: $0)) == backdropClassName
        }
    }
  }
}
