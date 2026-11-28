import ExpoModulesCore
import UIKit.UIGestureRecognizerSubclass

/// UIKit menu-dismiss taps still reach RN's surface handler (react-native#58983).
/// Adapted from expo-modules-core's SystemMenuTouchGate (MIT), which only covers SwiftUI windows;
/// this also covers MenuView buttons and header menus.
final class T3MenuDismissTouchGate: UIGestureRecognizer, UIGestureRecognizerDelegate {
  static func install(in window: UIWindow) {
    guard !(window.gestureRecognizers ?? []).contains(where: { $0 is T3MenuDismissTouchGate }) else {
      return
    }
    window.addGestureRecognizer(T3MenuDismissTouchGate())
  }

  private init() {
    super.init(target: nil, action: nil)
    delaysTouchesEnded = false
    cancelsTouchesInView = false
    delegate = self
  }

  // UIKit asks this before delivering the event's touches to any recognizer, so an ignored touch
  // never reaches JS as touchStart, pressIn, or press.
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive event: UIEvent) -> Bool {
    if let touches = event.allTouches {
      ignoreSurfaceTouches(touches.filter { $0.phase == .began }, for: event)
    }
    return true
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesBegan(touches, with: event)
    ignoreSurfaceTouches(touches, for: event)
    state = .failed
  }

  private func ignoreSurfaceTouches(_ touches: Set<UITouch>, for event: UIEvent) {
    guard let window = view as? UIWindow, window.subviews.contains(where: Self.isOpenMenuContainer) else {
      return
    }
    for touch in touches {
      var current = touch.view
      while let view = current {
        for recognizer in view.gestureRecognizers ?? []
        where NSStringFromClass(type(of: recognizer)) == "RCTSurfaceTouchHandler" {
          recognizer.ignore(touch, for: event)
        }
        current = view.superview
      }
    }
  }

  // UIKit adds this container to the window while a menu is presented, and turns its interaction
  // off once dismissal commits so taps during the dismiss animation reach the app again.
  private static func isOpenMenuContainer(_ view: UIView) -> Bool {
    view.isUserInteractionEnabled
      && NSStringFromClass(type(of: view)) == "_UI".appending("ContextMenuContainerView")
  }
}

public final class T3MenuDismissTouchGateSubscriber: ExpoAppDelegateSubscriber {
  public func subscriberDidRegister() {
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(windowDidBecomeVisible(_:)),
      name: UIWindow.didBecomeVisibleNotification,
      object: nil
    )
  }

  @objc private func windowDidBecomeVisible(_ notification: Notification) {
    guard let window = notification.object as? UIWindow else { return }
    T3MenuDismissTouchGate.install(in: window)
  }
}
