import ExpoModulesCore
import Security
import UIKit

public final class T3NativeControlsModule: Module {
  private let presentationSources = T3PresentationSources()
  private var videoPresentation: T3NativeVideoPresentation?
  private var filePresentation: T3NativeFilePresentation?

  public func definition() -> ModuleDefinition {
    Name("T3NativeControls")

    AsyncFunction("presentVideo") { (url: URL, title: String, sourceIdentifier: String, identifier: String, promise: Promise) in
      try self.presentVideo(
        url: url,
        title: title,
        sourceIdentifier: sourceIdentifier,
        identifier: identifier,
        promise: promise
      )
    }.runOnQueue(.main)

    AsyncFunction("dismissVideo") { (identifier: String) in
      self.dismissVideo(identifier: identifier)
    }.runOnQueue(.main)

    AsyncFunction("presentFile") { (url: URL, title: String, sourceIdentifier: String, identifier: String, promise: Promise) in
      try self.presentFile(url: url, title: title, sourceIdentifier: sourceIdentifier,
                           identifier: identifier, promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("dismissFile") { (identifier: String) in
      self.dismissFile(identifier: identifier)
    }.runOnQueue(.main)

    OnDestroy {
      let presentation = self.videoPresentation
      let file = self.filePresentation
      DispatchQueue.main.async {
        presentation?.dismiss()
        file?.dismiss()
      }
    }

    View(T3PresentationSourceView.self) {
      ViewName("PresentationSource")
      Prop("identifier") { (view: T3PresentationSourceView, identifier: String) in
        view.sources = self.presentationSources
        view.identifier = identifier
      }
    }

    AsyncFunction("shareFileFromSource") { (url: URL, title: String, identifier: String, promise: Promise) in
      try self.shareFile(url: url, title: title, sourceIdentifier: identifier, promise: promise)
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

  private func presentVideo(url: URL, title: String, sourceIdentifier: String, identifier: String, promise: Promise) throws {
    let isPlayableURL = url.isFileURL
      ? FileManager.default.isReadableFile(atPath: url.path)
      : (["https", "http"].contains(url.scheme?.lowercased() ?? "") && url.host != nil)
    guard videoPresentation == nil, filePresentation == nil,
      let presenter = appContext?.utilities?.currentViewController(),
      isPlayableURL
    else {
      throw NSError(
        domain: "T3NativeVideo",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "The video preview is no longer available."]
      )
    }
    let presentation = T3NativeVideoPresentation(identifier: identifier, url: url, title: title) { [weak self] error in
      self?.videoPresentation = nil
      if let error { promise.reject(error) } else { promise.resolve(nil) }
    }
    videoPresentation = presentation
    presentation.present(from: presenter, sources: presentationSources, sourceIdentifier: sourceIdentifier)
  }

  private func dismissVideo(identifier: String) {
    if videoPresentation?.identifier == identifier { videoPresentation?.dismiss() }
  }

  private func presentFile(url: URL, title: String, sourceIdentifier: String,
                           identifier: String, promise: Promise) throws {
    guard filePresentation == nil, videoPresentation == nil,
      let presenter = appContext?.utilities?.currentViewController()
    else { throw URLError(.cannotLoadFromNetwork) }
    let file = T3NativeFilePresentation(identifier: identifier, sources: presentationSources,
                                        sourceIdentifier: sourceIdentifier) { [weak self] error in
      self?.filePresentation = nil
      if let error { promise.reject(error) } else { promise.resolve(nil) }
    }
    filePresentation = file
    file.present(url: url, title: title, from: presenter)
  }

  private func dismissFile(identifier: String) {
    if filePresentation?.identifier == identifier { filePresentation?.dismiss() }
  }

  private func shareFile(url: URL, title: String, sourceIdentifier: String, promise: Promise) throws {
    guard let presenter = appContext?.utilities?.currentViewController() else {
      throw NSError(
        domain: "T3NativePresentation",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "The presenting screen is no longer open."]
      )
    }
    try presentFileShare(
      url: url,
      title: title,
      source: presentationSources.view(for: sourceIdentifier),
      presenter: presenter,
      promise: promise
    )
  }
}
