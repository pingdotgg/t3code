import ExpoModulesCore
import UIKit.UIGestureRecognizerSubclass

/// Tells a React root about the window it is in. UIKit mounts the app again for every window
/// scene, and app-wide work such as an opened link belongs to the window used last.
final class T3WindowStateView: ExpoView {
  let onWindowStateChange = EventDispatcher()
  private weak var observedWindow: UIWindow?
  private var touchObserver: T3WindowTouchObserver?
  // Touches arrive constantly; only a change of window is news.
  private static weak var lastActive: T3WindowStateView?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    let center = NotificationCenter.default
    center.removeObserver(self)
    if let touchObserver {
      touchObserver.view?.removeGestureRecognizer(touchObserver)
      self.touchObserver = nil
    }
    guard let window, let scene = window.windowScene else {
      // A root view can outlive its window; it has nothing left to show.
      if observedWindow != nil { report("closed") }
      observedWindow = nil
      return
    }
    observedWindow = window
    center.addObserver(self, selector: #selector(windowDidBecomeActive), name: UIWindow.didBecomeKeyNotification, object: window)
    center.addObserver(self, selector: #selector(windowDidBecomeActive), name: UIScene.didActivateNotification, object: scene)
    center.addObserver(self, selector: #selector(sceneDidDisconnect), name: UIScene.didDisconnectNotification, object: scene)
    // Side by side, both scenes stay active and no notification says which one a touch went to.
    let touchObserver = T3WindowTouchObserver(owner: self)
    window.addGestureRecognizer(touchObserver)
    self.touchObserver = touchObserver
    // A window opens in use, as its React root assumes when it mounts.
    report("active")
  }

  @objc fileprivate func windowDidBecomeActive() {
    report("active")
  }

  @objc private func sceneDidDisconnect() {
    report("closed")
    releaseAppDelegateWindow()
  }

  private func report(_ state: String) {
    if state == "active" {
      guard Self.lastActive !== self else { return }
      Self.lastActive = self
    } else if Self.lastActive === self {
      Self.lastActive = nil
    }
    onWindowStateChange(["state": state])
  }

  /// Expo mirrors the newest window onto the app delegate. Left there after its scene closed, it
  /// would keep the window, its root view and the React tree mounted in it alive.
  private func releaseAppDelegateWindow() {
    guard let closed = observedWindow,
      let delegate = UIApplication.shared.delegate as? NSObject,
      delegate.responds(to: NSSelectorFromString("window")),
      delegate.responds(to: NSSelectorFromString("setWindow:")),
      (delegate.value(forKey: "window") as? UIWindow) === closed
    else { return }
    let remaining = UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.keyWindow }
      .first { $0 !== closed }
    delegate.setValue(remaining, forKey: "window")
  }
}

/// Sees the first touch of every gesture in a window without taking part in it.
private final class T3WindowTouchObserver: UIGestureRecognizer {
  private weak var owner: T3WindowStateView?

  init(owner: T3WindowStateView) {
    self.owner = owner
    super.init(target: nil, action: nil)
    delaysTouchesEnded = false
    cancelsTouchesInView = false
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesBegan(touches, with: event)
    owner?.windowDidBecomeActive()
    state = .failed
  }
}
