import AVFoundation
import ExpoModulesCore
import Security
import UIKit

// Expo Modules 2.0: plain members marked @JS are bound by the macro, while the
// views and main-queue presenters stay in definition(). Both are merged.
@ExpoModule("T3NativeControls")
public final class T3NativeControlsModule: Module {
  private let presentationSources = T3PresentationSources()
  private var videoPresentation: T3NativeVideoPresentation?
  private var filePresentation: T3NativeFilePresentation?
  private var fontPresentation: T3FontPickerPresentation?

  public func definition() -> ModuleDefinition {
    Constants {
      if #available(iOS 26.0, *) {
        return [
          "supportsWorkspaceColumns": NSClassFromString("RNSSplitHostComponentView") != nil,
        ]
      }
      return ["supportsWorkspaceColumns": false]
    }
    View(T3SegmentedControlView.self) {
      ViewName("SegmentedControl")
      Events("onSelectionChange")
      Prop("labels") { (view: T3SegmentedControlView, value: [String]) in view.labels = value }
      Prop("selectedIndex") { (view: T3SegmentedControlView, value: Int) in view.selectedIndex = value }
      Prop("trackColor") { (view: T3SegmentedControlView, value: UIColor) in view.trackColor = value }
      Prop("selectedColor") { (view: T3SegmentedControlView, value: UIColor) in view.selectedColor = value }
      Prop("textColor") { (view: T3SegmentedControlView, value: UIColor) in view.textColor = value }
      Prop("mutedColor") { (view: T3SegmentedControlView, value: UIColor) in view.mutedColor = value }
      Prop("appearance") { (view: T3SegmentedControlView, value: String) in view.appearance = value }
    }

    View(T3LayoutMetricsView.self) {
      ViewName("LayoutMetrics")
      Events("onMetricsChange")
    }

    AsyncFunction("pickInstalledFont") { (selectedName: String?, promise: Promise) in
      MainActor.assumeIsolated {
        guard self.fontPresentation == nil,
          let presenter = self.appContext?.utilities?.currentViewController()
        else {
          promise.reject("ERR_FONT_PICKER", "Cannot present the font picker right now.")
          return
        }
        let presentation = T3FontPickerPresentation { [weak self] result in
          self?.fontPresentation = nil
          promise.resolve(result)
        }
        self.fontPresentation = presentation
        presentation.present(from: presenter, selectedName: selectedName)
      }
    }.runOnQueue(.main)

    AsyncFunction("resolveInstalledFonts") { (names: [String], promise: Promise) in
      MainActor.assumeIsolated {
        T3InstalledFonts.resolve(names) { promise.resolve($0) }
      }
    }.runOnQueue(.main)

    AsyncFunction("presentVideo") { (url: URL, title: String, sourceIdentifier: String, identifier: String, promise: Promise) in
      try self.presentVideo(
        url: url,
        title: title,
        sourceIdentifier: sourceIdentifier,
        identifier: identifier,
        promise: promise
      )
    }.runOnQueue(.main)

    AsyncFunction("presentFile") { (url: URL, title: String, sourceIdentifier: String, identifier: String, promise: Promise) in
      try self.presentFile(url: url, title: title, sourceIdentifier: sourceIdentifier,
                           identifier: identifier, promise: promise)
    }.runOnQueue(.main)

    AsyncFunction("presentFiles") { (urls: [URL], titles: [String], selectedIndex: Int, sourceIdentifiers: [String], identifier: String, promise: Promise) in
      guard !urls.isEmpty, urls.count == titles.count, urls.count == sourceIdentifiers.count,
        urls.indices.contains(selectedIndex)
      else {
        throw URLError(.badURL)
      }
      let file = try self.makeFilePresentation(sourceIdentifiers: sourceIdentifiers, identifier: identifier,
                                               promise: promise)
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        file.dismiss()
        return
      }
      file.present(urls: urls, titles: titles, selectedIndex: selectedIndex, from: presenter)
    }.runOnQueue(.main)

    OnDestroy {
      let presentation = self.videoPresentation
      let file = self.filePresentation
      let font = self.fontPresentation
      DispatchQueue.main.async {
        presentation?.dismiss()
        file?.dismiss()
        font?.dismiss()
      }
    }

    View(T3PresentationSourceView.self) {
      ViewName("PresentationSource")
      Prop("identifier") { (view: T3PresentationSourceView, identifier: String) in
        view.sources = self.presentationSources
        view.identifier = identifier
      }
    }

    View(T3FrostedCutoutView.self) {
      ViewName("FrostedCutout")
      Prop("cutoutTop") { (view: T3FrostedCutoutView, value: Double) in view.cutoutTop = CGFloat(value) }
      Prop("cutoutWidth") { (view: T3FrostedCutoutView, value: Double) in view.cutoutWidth = CGFloat(value) }
      Prop("cutoutHeight") { (view: T3FrostedCutoutView, value: Double) in view.cutoutHeight = CGFloat(value) }
      Prop("cutoutRadius") { (view: T3FrostedCutoutView, value: Double) in view.cutoutRadius = CGFloat(value) }
      Prop("appearance") { (view: T3FrostedCutoutView, value: String) in view.appearance = value }
    }

    View(T3ContextSheetSizeView.self) {
      ViewName("ContextSheetSize")
      Prop("contentHeight") { (view: T3ContextSheetSizeView, height: Double) in
        view.contentHeight = CGFloat(height)
      }
    }

    AsyncFunction("shareFileFromSource") { (url: URL, title: String, identifier: String, promise: Promise) in
      try self.shareFile(url: url, title: title, sourceIdentifier: identifier, promise: promise)
    }.runOnQueue(.main)
  }

  // UIKit presenters are main-actor isolated rather than run on the JS thread
  // the macro would otherwise pick.
  @JS
  @MainActor
  func dismissVideo(identifier: String) async {
    dismissVideoPresentation(identifier: identifier)
  }

  // expo-video activates the session for inline playback but never deactivates
  // it. Any other category or mode means another feature (recording) owns it.
  @JS
  @MainActor
  func releaseVideoAudioSession() async {
    // The fullscreen presentation releases the session in its own teardown.
    guard videoPresentation == nil else { return }
    let session = AVAudioSession.sharedInstance()
    guard session.category == .playback, session.mode == .moviePlayback else { return }
    try? session.setActive(false, options: [.notifyOthersOnDeactivation])
  }

  @JS
  @MainActor
  func dismissFile(identifier: String) async {
    dismissFilePresentation(identifier: identifier)
  }

  // Rotates the interface without Simulator menu UI scripting, which CI
  // runners cannot perform (osascript is denied Accessibility access there).
  @JS
  @MainActor
  func applyShowcaseOrientation(orientation: String) async {
    let mask: UIInterfaceOrientationMask = orientation == "landscape" ? .landscapeRight : .portrait
    for case let windowScene as UIWindowScene in UIApplication.shared.connectedScenes {
      windowScene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
        NSLog("T3NativeControls applyShowcaseOrientation(\(orientation)) failed: \(error)")
      }
      for window in windowScene.windows {
        window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
      }
    }
  }

  // The geometry request above can fail transiently (for example before the
  // scene is foreground-active), so callers poll this until it settles.
  // Screen bounds — not the scene's interface orientation — decide the
  // answer because they match the captured framebuffer: with iPadOS
  // windowing active, a floating landscape window still reports a portrait
  // screen, and screenshots would come out portrait.
  @JS
  @MainActor
  func getInterfaceOrientation() async -> String {
    guard
      let windowScene = UIApplication.shared.connectedScenes
        .compactMap({ $0 as? UIWindowScene })
        .first
    else {
      return "unknown"
    }
    let bounds = windowScene.screen.coordinateSpace.bounds
    return bounds.width > bounds.height ? "landscape" : "portrait"
  }

  @JS
  @MainActor
  func isProtectedDataAvailable() async -> Bool {
    UIApplication.shared.isProtectedDataAvailable
  }

  private func launchArgument(_ flag: String) -> String? {
    let arguments = ProcessInfo.processInfo.arguments
    guard
      let flagIndex = arguments.firstIndex(of: flag),
      arguments.indices.contains(flagIndex + 1)
    else {
      return nil
    }
    return arguments[flagIndex + 1]
  }

  @JS
  func getShowcasePairingUrl() -> String? {
    launchArgument("--showcasePairingUrl")
  }

  @JS
  func getShowcaseScene() -> String? {
    let scenePath = NSHomeDirectory() + "/Library/Caches/T3ShowcaseScene"
    if let storedScene = try? String(contentsOfFile: scenePath, encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines), !storedScene.isEmpty {
      return storedScene
    }
    return launchArgument("--showcaseScene")
  }

  // The palette is fixed for the whole capture, so it only ever arrives as a
  // launch argument — unlike the scene, which the runner rewrites in place.
  @JS
  func getShowcaseTheme() -> String? {
    launchArgument("--showcaseTheme")
  }

  @JS
  func getShowcaseOrientation() -> String? {
    launchArgument("--showcaseOrientation")
  }

  @JS
  func prepareShowcaseCapture() {
    for itemClass in [kSecClassGenericPassword, kSecClassInternetPassword] {
      SecItemDelete([kSecClass as String: itemClass] as CFDictionary)
    }
  }

  @JS(.concurrent)
  func markShowcaseReady(scene: String) async {
    let readyPath = NSHomeDirectory() + "/Library/Caches/T3ShowcaseReadyScene"
    try? scene.write(toFile: readyPath, atomically: true, encoding: .utf8)
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

  private func dismissVideoPresentation(identifier: String) {
    if videoPresentation?.identifier == identifier { videoPresentation?.dismiss() }
  }

  private func makeFilePresentation(sourceIdentifiers: [String], identifier: String,
                                    promise: Promise) throws -> T3NativeFilePresentation {
    guard filePresentation == nil, videoPresentation == nil,
      appContext?.utilities?.currentViewController() != nil
    else { throw URLError(.cannotLoadFromNetwork) }
    let file = T3NativeFilePresentation(identifier: identifier, sources: presentationSources,
                                        sourceIdentifiers: sourceIdentifiers) { [weak self] error in
      self?.filePresentation = nil
      if let error { promise.reject(error) } else { promise.resolve(nil) }
    }
    filePresentation = file
    return file
  }

  private func presentFile(url: URL, title: String, sourceIdentifier: String,
                           identifier: String, promise: Promise) throws {
    let file = try makeFilePresentation(sourceIdentifiers: [sourceIdentifier], identifier: identifier, promise: promise)
    guard let presenter = appContext?.utilities?.currentViewController() else { file.dismiss(); return }
    file.present(url: url, title: title, from: presenter)
  }

  private func dismissFilePresentation(identifier: String) {
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
