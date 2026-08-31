import AVKit
import UIKit

final class T3NativeVideoPresentation: NSObject, AVPlayerViewControllerDelegate,
  UIAdaptivePresentationControllerDelegate {
  let identifier: String
  private let controller = AVPlayerViewController()
  private let completion: (Error?) -> Void
  private var itemObservation: NSKeyValueObservation?
  private var backgroundObserver: NSObjectProtocol?
  private var playbackError: Error?
  private var presented = false
  private var dismissRequested = false
  private var finished = false
  private struct AudioSessionConfiguration {
    let category: AVAudioSession.Category
    let mode: AVAudioSession.Mode
    let options: AVAudioSession.CategoryOptions

    init(_ session: AVAudioSession) {
      category = session.category
      mode = session.mode
      options = session.categoryOptions
    }
  }
  private var previousAudioSession: AudioSessionConfiguration?
  private weak var fullScreenController: UIViewController?
  private var embedded = false

  init(identifier: String, url: URL, title: String, completion: @escaping (Error?) -> Void) {
    self.identifier = identifier
    self.completion = completion
    super.init()

    let item = AVPlayerItem(url: url)
    let metadata = AVMutableMetadataItem()
    metadata.identifier = .commonIdentifierTitle
    metadata.value = title as NSString
    item.externalMetadata = [metadata]
    controller.player = AVPlayer(playerItem: item)
    controller.delegate = self
    controller.overrideUserInterfaceStyle = .dark
    controller.allowsPictureInPicturePlayback = false

    itemObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
      guard item.status == .failed else { return }
      DispatchQueue.main.async {
        guard let self else { return }
        self.playbackError = item.error ?? NSError(
          domain: "T3NativeVideo",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "This video couldn't be played on this device."]
        )
        self.dismiss()
      }
    }
    backgroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.controller.player?.pause() }
  }

  func present(from presenter: UIViewController, sources: T3PresentationSources, sourceIdentifier: String) {
    let audioSession = AVAudioSession.sharedInstance()
    previousAudioSession = AudioSessionConfiguration(audioSession)
    do {
      try audioSession.setCategory(.playback, mode: .moviePlayback)
    } catch {
      NSLog("T3 video audio session: %@", error.localizedDescription)
    }
    // AVKit exposes programmatic inline-to-full-screen entry through this selector.
    // This is the same guarded entry point used by expo-video's enterFullscreen().
    let enterFullScreen = NSSelectorFromString("enterFullScreenAnimated:completionHandler:")
    if let source = sources.view(for: sourceIdentifier), source.window != nil,
      controller.responds(to: enterFullScreen) {
      // AVKit owns the transition from its inline view to full screen. Using a
      // separate UIKit zoom transition prevents its native Close action from exiting.
      var responder: UIResponder? = source
      while let current = responder, !(current is UIViewController) { responder = current.next }
      let parent = responder as? UIViewController ?? presenter
      embedded = true
      parent.addChild(controller)
      controller.view.frame = source.bounds
      controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      source.addSubview(controller.view)
      controller.didMove(toParent: parent)
      controller.view.layoutIfNeeded()
      controller.perform(enterFullScreen, with: true, with: nil)
      controller.player?.play()
    } else {
      presenter.present(controller, animated: true) { [self] in
        presented = true
        if dismissRequested {
          dismiss()
        } else if UIApplication.shared.applicationState == .active {
          controller.player?.play()
        }
      }
      controller.presentationController?.delegate = self
    }
  }

  func dismiss() {
    dismissRequested = true
    guard !finished else { return }
    guard presented else {
      if embedded && fullScreenController == nil { finish() }
      return
    }
    (fullScreenController ?? controller).dismiss(animated: true) { [self] in finish() }
  }

  func playerViewController(
    _ playerViewController: AVPlayerViewController,
    willBeginFullScreenPresentationWithAnimationCoordinator coordinator: UIViewControllerTransitionCoordinator
  ) {
    fullScreenController = coordinator.viewController(forKey: .to)
    coordinator.animate(alongsideTransition: nil) { [weak self] context in
      guard let self else { return }
      if context.isCancelled {
        finish()
      } else {
        presented = true
        if dismissRequested { dismiss() }
      }
    }
  }

  func playerViewController(
    _ playerViewController: AVPlayerViewController,
    willEndFullScreenPresentationWithAnimationCoordinator coordinator: UIViewControllerTransitionCoordinator
  ) {
    coordinator.animate(alongsideTransition: nil) { [weak self] context in
      if !context.isCancelled { self?.finish() }
    }
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finish()
  }

  private func finish() {
    guard !finished else { return }
    finished = true
    controller.player?.pause()
    if embedded {
      controller.willMove(toParent: nil)
      controller.view.removeFromSuperview()
      controller.removeFromParent()
    }
    itemObservation = nil
    controller.player = nil
    if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
    backgroundObserver = nil
    let audioSession = AVAudioSession.sharedInstance()
    if let previousAudioSession, audioSession.category == .playback,
      audioSession.mode == .moviePlayback, audioSession.categoryOptions.isEmpty {
      // AVPlayer owns activation. Deactivating the shared session here could
      // stop another player or recorder that was active before this preview.
      try? audioSession.setCategory(
        previousAudioSession.category,
        mode: previousAudioSession.mode,
        options: previousAudioSession.options
      )
    }
    completion(playbackError)
  }
}
