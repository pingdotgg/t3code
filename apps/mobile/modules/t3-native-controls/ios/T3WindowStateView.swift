import ExpoModulesCore
import UIKit

/// Tells a React root about the window it is in. UIKit mounts the app again for every window
/// scene, and app-wide work such as an opened link belongs to the window used last.
final class T3WindowStateView: ExpoView {
  let onWindowStateChange = EventDispatcher()
  private weak var observedWindow: UIWindow?

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
    guard let window, let scene = window.windowScene else {
      // A root view can outlive its window; it has nothing left to show.
      if observedWindow != nil { report("closed") }
      observedWindow = nil
      return
    }
    observedWindow = window
    // Side by side, both scenes are active; the key window is the one last touched.
    center.addObserver(self, selector: #selector(windowDidBecomeActive), name: UIWindow.didBecomeKeyNotification, object: window)
    center.addObserver(self, selector: #selector(windowDidBecomeActive), name: UIScene.didActivateNotification, object: scene)
    center.addObserver(self, selector: #selector(sceneDidDisconnect), name: UIScene.didDisconnectNotification, object: scene)
    if window.isKeyWindow { report("active") }
  }

  @objc private func windowDidBecomeActive() {
    report("active")
  }

  @objc private func sceneDidDisconnect() {
    report("closed")
    releaseAppDelegateWindow()
  }

  private func report(_ state: String) {
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
