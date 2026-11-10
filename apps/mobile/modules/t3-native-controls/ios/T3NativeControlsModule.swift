import AVFoundation
import ExpoModulesCore
import Photos
import Security
import UIKit
import UniformTypeIdentifiers

@ExpoModule("T3NativeControls")
public final class T3NativeControlsModule: Module {
  private let presentationSources = T3PresentationSources()
  private var videoPresentation: T3NativeVideoPresentation?
  private var filePresentation: T3NativeFilePresentation?
  /// Serializes file presents so a quick reopen waits out the previous dismiss instead of failing.
  private var filePresentSequence: Task<Void, Never> = Task {}
  private var presentationWaiters: [CheckedContinuation<Void, Never>] = []
  private var pendingFilePresentations: [String: PendingFilePresentation] = [:]
  /// URLs that arrived through updateFile before a queued present started.
  private var pendingFileUpdates: [String: [Int: URL?]] = [:]

  private final class PendingFilePresentation {
    var cancelled = false
    let promise: Promise
    init(promise: Promise) { self.promise = promise }
  }

  public func definition() -> ModuleDefinition {
    Events("videoPlaybackChange")
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

    View(T3SidebarTabBarView.self) {
      ViewName("SidebarTabBar")
      Events("onSelectionChange", "onCompose")
      Prop("tabs") { (view: T3SidebarTabBarView, value: [String]) in view.tabs = value }
      Prop("selectedTab") { (view: T3SidebarTabBarView, value: String) in view.selectedTab = value }
      Prop("selectedColor") { (view: T3SidebarTabBarView, value: UIColor) in view.selectedColor = value }
      Prop("showsCompose") { (view: T3SidebarTabBarView, value: Bool) in view.showsCompose = value }
      Prop("compact") { (view: T3SidebarTabBarView, value: Bool) in view.compact = value }
      Prop("appearance") { (view: T3SidebarTabBarView, value: String) in view.appearance = value }
    }

    View(T3LayoutMetricsView.self) {
      ViewName("LayoutMetrics")
      Events("onMetricsChange")
    }

    View(T3ScrollEdgeBleedView.self) {
      ViewName("ScrollEdgeBleed")
    }

    AsyncFunction("generateDpopKey") { T3DpopKeys.generate() }

    AsyncFunction("dpopKeyMatches") { (privateKey: Data, publicKey: Data) in
      try T3DpopKeys.matches(privateKey: privateKey, publicKey: publicKey)
    }

    AsyncFunction("signDpop") { (privateKey: Data, signingInput: Data) in
      try T3DpopKeys.sign(privateKey: privateKey, signingInput: signingInput)
    }

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
      self.enqueueFilePresentation(identifier: identifier, promise: promise) { presenter in
        let file = try self.makeFilePresentation(sourceIdentifiers: [sourceIdentifier], identifier: identifier,
                                                 promise: promise)
        file.present(url: url, title: title, from: presenter)
      }
    }.runOnQueue(.main)

    // A nil URL is still resolving in JS and arrives later through updateFile.
    AsyncFunction("presentFiles") { (urls: [URL?], titles: [String], selectedIndex: Int, sourceIdentifiers: [String], identifier: String, promise: Promise) in
      guard !urls.isEmpty, urls.count == titles.count, urls.count == sourceIdentifiers.count,
        urls.indices.contains(selectedIndex)
      else {
        throw URLError(.badURL)
      }
      self.enqueueFilePresentation(identifier: identifier, promise: promise) { presenter in
        let file = try self.makeFilePresentation(sourceIdentifiers: sourceIdentifiers, identifier: identifier,
                                                 promise: promise)
        file.present(urls: urls, titles: titles, selectedIndex: selectedIndex, from: presenter)
      }
    }.runOnQueue(.main)

    // A nil URL marks the item as one that could not be resolved.
    AsyncFunction("updateFile") { (identifier: String, index: Int, url: URL?) in
      if self.filePresentation?.identifier == identifier {
        self.filePresentation?.update(index: index, url: url)
      } else if self.pendingFilePresentations[identifier] != nil {
        self.pendingFileUpdates[identifier, default: [:]][index] = url
      }
    }.runOnQueue(.main)

    OnDestroy {
      let presentation = self.videoPresentation
      let file = self.filePresentation
      let pending = self.pendingFilePresentations
      self.pendingFilePresentations.removeAll()
      self.pendingFileUpdates.removeAll()
      for item in pending.values {
        item.cancelled = true
        item.promise.resolve(nil)
      }
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

    // Photos names the asset itself, so iOS ignores the Android display name.
    AsyncFunction("saveImageToLibrary") { (url: URL, mimeType: String, name: String, promise: Promise) in
      Self.saveImageToLibrary(url: url, mimeType: mimeType, name: name, promise: promise)
    }
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
    if cancelPendingFilePresentation(identifier: identifier) { return }
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

  // Geometry requests can fail before foreground activation; callers retry until bounds match.
  // Use screen bounds because iPadOS floating-window orientation can differ from the captured framebuffer.
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
    let presentation = T3NativeVideoPresentation(
      identifier: identifier, url: url, title: title,
      onPlaybackChange: { [weak self] isPlaying in
        self?.sendEvent("videoPlaybackChange", ["identifier": identifier, "isPlaying": isPlaying])
      },
      completion: { [weak self] error in
        self?.videoPresentation = nil
        self?.releasePresentationSlot()
        if let error { promise.reject(error) } else { promise.resolve(nil) }
      }
    )
    videoPresentation = presentation
    presentation.present(from: presenter, sources: presentationSources, sourceIdentifier: sourceIdentifier)
  }

  private func dismissVideoPresentation(identifier: String) {
    if videoPresentation?.identifier == identifier { videoPresentation?.dismiss() }
  }

  private func enqueueFilePresentation(
    identifier: String,
    promise: Promise,
    start: @escaping @MainActor (UIViewController) throws -> Void,
  ) {
    let pending = PendingFilePresentation(promise: promise)
    pendingFilePresentations[identifier] = pending
    // Closing then immediately opening another image hits present while UIKit is still
    // dismissing; wait for that slot instead of rejecting with a load error.
    filePresentation?.dismiss(animated: false)
    videoPresentation?.dismiss()
    let previous = filePresentSequence
    filePresentSequence = Task { @MainActor in
      await previous.value
      await self.waitForPresentationSlot()
      guard self.pendingFilePresentations[identifier] === pending, !pending.cancelled else { return }
      guard let presenter = await self.readyPresenter() else {
        self.pendingFilePresentations.removeValue(forKey: identifier)
        self.pendingFileUpdates.removeValue(forKey: identifier)
        // Resolve quietly: a transient presenter gap is not a file-load failure.
        promise.resolve(nil)
        return
      }
      guard self.pendingFilePresentations[identifier] === pending, !pending.cancelled else { return }
      self.pendingFilePresentations.removeValue(forKey: identifier)
      do {
        try start(presenter)
        self.applyPendingFileUpdates(identifier: identifier)
      } catch {
        self.pendingFileUpdates.removeValue(forKey: identifier)
        promise.reject(error)
      }
    }
  }

  private func applyPendingFileUpdates(identifier: String) {
    guard let updates = pendingFileUpdates.removeValue(forKey: identifier),
      filePresentation?.identifier == identifier
    else { return }
    for (index, url) in updates {
      filePresentation?.update(index: index, url: url)
    }
  }

  private func cancelPendingFilePresentation(identifier: String) -> Bool {
    guard let pending = pendingFilePresentations.removeValue(forKey: identifier) else { return false }
    pending.cancelled = true
    pendingFileUpdates.removeValue(forKey: identifier)
    pending.promise.resolve(nil)
    return true
  }

  private func waitForPresentationSlot() async {
    while filePresentation != nil || videoPresentation != nil {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        presentationWaiters.append(continuation)
      }
    }
  }

  /// After the previous Quick Look finishes, UIKit may still be tearing it down; presenting
  /// into that gap is what produced the "Could not open preview" dialog on fast reopen.
  private func readyPresenter() async -> UIViewController? {
    for _ in 0..<60 {
      if Task.isCancelled { return nil }
      if filePresentation != nil || videoPresentation != nil {
        filePresentation?.dismiss(animated: false)
        videoPresentation?.dismiss()
        await waitForPresentationSlot()
        continue
      }
      if let presenter = appContext?.utilities?.currentViewController(),
        presenter.presentedViewController == nil,
        presenter.transitionCoordinator == nil,
        !presenter.isBeingPresented,
        !presenter.isBeingDismissed {
        return presenter
      }
      try? await Task.sleep(for: .milliseconds(16))
    }
    guard filePresentation == nil, videoPresentation == nil else { return nil }
    return appContext?.utilities?.currentViewController()
  }

  private func releasePresentationSlot() {
    let waiters = presentationWaiters
    presentationWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
  }

  private func makeFilePresentation(sourceIdentifiers: [String], identifier: String,
                                    promise: Promise) throws -> T3NativeFilePresentation {
    guard filePresentation == nil, videoPresentation == nil,
      appContext?.utilities?.currentViewController() != nil
    else { throw URLError(.cannotLoadFromNetwork) }
    let file = T3NativeFilePresentation(identifier: identifier, sources: presentationSources,
                                        sourceIdentifiers: sourceIdentifiers) { [weak self] error in
      self?.filePresentation = nil
      self?.releasePresentationSlot()
      if let error { promise.reject(error) } else { promise.resolve(nil) }
    }
    filePresentation = file
    return file
  }

  private func dismissFilePresentation(identifier: String) {
    if filePresentation?.identifier == identifier { filePresentation?.dismiss() }
  }

  private static func saveImageToLibrary(url: URL, mimeType: String, name: String, promise: Promise) {
    PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
      guard status == .authorized || status == .limited else {
        promise.reject(NSError(
          domain: "T3NativePhotos",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Allow T3 Code to add photos in Settings."]
        ))
        return
      }
      PHPhotoLibrary.shared().performChanges({
        let options = PHAssetResourceCreationOptions()
        options.uniformTypeIdentifier = UTType(mimeType: mimeType)?.identifier
        options.originalFilename = name
        PHAssetCreationRequest.forAsset().addResource(with: .photo, fileURL: url, options: options)
      }, completionHandler: { saved, error in
        if saved {
          promise.resolve(nil)
        } else {
          promise.reject(error ?? NSError(
            domain: "T3NativePhotos",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "Photos could not save this image."]
          ))
        }
      })
    }
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
