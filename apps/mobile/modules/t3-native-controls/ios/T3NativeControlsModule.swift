import ExpoModulesCore
import Security
import UIKit

public final class T3NativeControlsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3NativeControls")

    Function("getShowcasePairingUrl") {
      let arguments = ProcessInfo.processInfo.arguments
      guard
        let flagIndex = arguments.firstIndex(of: "--showcasePairingUrl"),
        arguments.indices.contains(flagIndex + 1)
      else {
        return nil as String?
      }
      return arguments[flagIndex + 1]
    }

    Function("getShowcaseScene") { () -> String? in
      let scenePath = NSHomeDirectory() + "/Library/Caches/T3ShowcaseScene"
      if let storedScene = try? String(contentsOfFile: scenePath, encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines), !storedScene.isEmpty {
        return storedScene
      }
      let arguments = ProcessInfo.processInfo.arguments
      guard
        let flagIndex = arguments.firstIndex(of: "--showcaseScene"),
        arguments.indices.contains(flagIndex + 1)
      else {
        return nil as String?
      }
      return arguments[flagIndex + 1]
    }

    // The palette is fixed for the whole capture, so it only ever arrives as a
    // launch argument — unlike the scene, which the runner rewrites in place.
    Function("getShowcaseTheme") { () -> String? in
      let arguments = ProcessInfo.processInfo.arguments
      guard
        let flagIndex = arguments.firstIndex(of: "--showcaseTheme"),
        arguments.indices.contains(flagIndex + 1)
      else {
        return nil as String?
      }
      return arguments[flagIndex + 1]
    }

    Function("getShowcaseOrientation") { () -> String? in
      let arguments = ProcessInfo.processInfo.arguments
      guard
        let flagIndex = arguments.firstIndex(of: "--showcaseOrientation"),
        arguments.indices.contains(flagIndex + 1)
      else {
        return nil as String?
      }
      return arguments[flagIndex + 1]
    }

    // Rotates the interface without Simulator menu UI scripting, which CI
    // runners cannot perform (osascript is denied Accessibility access there).
    AsyncFunction("applyShowcaseOrientation") { (orientation: String) in
      guard #available(iOS 16.0, *) else { return }
      let mask: UIInterfaceOrientationMask = orientation == "landscape" ? .landscapeRight : .portrait
      for case let windowScene as UIWindowScene in UIApplication.shared.connectedScenes {
        windowScene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
          NSLog("T3NativeControls applyShowcaseOrientation(\(orientation)) failed: \(error)")
        }
        for window in windowScene.windows {
          window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
        }
      }
    }.runOnQueue(.main)

    // The geometry request above can fail transiently (for example before the
    // scene is foreground-active), so callers poll this until it settles.
    // Screen bounds — not the scene's interface orientation — decide the
    // answer because they match the captured framebuffer: with iPadOS
    // windowing active, a floating landscape window still reports a portrait
    // screen, and screenshots would come out portrait.
    AsyncFunction("getInterfaceOrientation") { () -> String in
      guard
        let windowScene = UIApplication.shared.connectedScenes
          .compactMap({ $0 as? UIWindowScene })
          .first
      else {
        return "unknown"
      }
      let bounds = windowScene.screen.coordinateSpace.bounds
      return bounds.width > bounds.height ? "landscape" : "portrait"
    }.runOnQueue(.main)

    Function("prepareShowcaseCapture") {
      for itemClass in [kSecClassGenericPassword, kSecClassInternetPassword] {
        SecItemDelete([kSecClass as String: itemClass] as CFDictionary)
      }
    }

    Function("markShowcaseReady") { (scene: String) in
      let readyPath = NSHomeDirectory() + "/Library/Caches/T3ShowcaseReadyScene"
      try? scene.write(toFile: readyPath, atomically: true, encoding: .utf8)
    }
  }
}
