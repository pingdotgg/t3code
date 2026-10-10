import ExpoModulesCore
import UIKit

/// Keep ordinary phones portrait-only while allowing a hinge-backed scene to rotate.
public final class T3WorkspaceOrientationSubscriber: ExpoAppDelegateSubscriber {
  private static let hingeWindows = NSHashTable<UIWindow>.weakObjects()

  static func allowHingeOrientations(in window: UIWindow) {
    guard !hingeWindows.contains(window) else { return }
    hingeWindows.add(window)
    window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
  }

  public func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
    if UIDevice.current.userInterfaceIdiom == .pad {
      // Keep iPad orientation policy, including portrait-only showcase captures.
      let orientations = Bundle.main.object(forInfoDictionaryKey: "UISupportedInterfaceOrientations~ipad") as? [String] ?? []
      return orientations == ["UIInterfaceOrientationPortrait"] ? .portrait : .all
    }
    return window.map { Self.hingeWindows.contains($0) } == true ? .allButUpsideDown : .portrait
  }
}
