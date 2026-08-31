import ExpoModulesCore
import Security
import UIKit

public final class T3NativeControlsModule: Module {
  private let presentationSources = T3PresentationSources()
  private var videoPresentation: T3NativeVideoPresentation?

  public func definition() -> ModuleDefinition {
    Name("T3NativeControls")

    AsyncFunction("presentVideo") {
      (url: URL, title: String, sourceIdentifier: String, presentationIdentifier: String, promise: Promise) in
      let isPlayableURL = url.isFileURL
        ? FileManager.default.isReadableFile(atPath: url.path)
        : (["https", "http"].contains(url.scheme?.lowercased() ?? "") && url.host != nil)
      guard self.videoPresentation == nil,
        let presenter = self.appContext?.utilities?.currentViewController(),
        isPlayableURL
      else {
        throw NSError(domain: "T3NativeVideo", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "The video preview is no longer available."])
      }
      let presentation = T3NativeVideoPresentation(
        identifier: presentationIdentifier, url: url, title: title
      ) { [weak self] error in
        self?.videoPresentation = nil
        if let error { promise.reject(error) } else { promise.resolve(nil) }
      }
      self.videoPresentation = presentation
      presentation.present(from: presenter, sources: self.presentationSources,
        sourceIdentifier: sourceIdentifier)
    }.runOnQueue(.main)

    AsyncFunction("dismissVideo") { (identifier: String) in
      if self.videoPresentation?.identifier == identifier { self.videoPresentation?.dismiss() }
    }.runOnQueue(.main)

    OnDestroy {
      let presentation = self.videoPresentation
      DispatchQueue.main.async { presentation?.dismiss() }
    }

    View(T3PresentationSourceView.self) {
      ViewName("PresentationSource")
      Prop("identifier") { (view: T3PresentationSourceView, identifier: String) in
        view.sources = self.presentationSources
        view.identifier = identifier
      }
    }

    View(T3ZoomTransitionView.self) {
      ViewName("ZoomTransitionTarget")
      Prop("sourceIdentifier") { (view: T3ZoomTransitionView, identifier: String) in
        view.sources = self.presentationSources
        view.sourceIdentifier = identifier
      }
      Prop("colorScheme") { (view: T3ZoomTransitionView, colorScheme: String?) in
        view.colorScheme = colorScheme
      }
      OnViewDidUpdateProps { (view: T3ZoomTransitionView) in
        view.updateTransition()
      }
    }

    AsyncFunction("shareFileFromSource") { (url: URL, title: String, identifier: String, promise: Promise) in
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        throw NSError(domain: "T3NativePresentation", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "The presenting screen is no longer open."])
      }
      try presentFileShare(url: url, title: title, source: self.presentationSources.view(for: identifier),
        presenter: presenter, promise: promise)
    }.runOnQueue(.main)

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
