import Darwin
import ExpoModulesCore
import LocalAuthentication
import UIKit

/// App Lock lives in native code so its cover is up before iOS snapshots the app for the
/// switcher, before JavaScript loads on a cold launch, and above every native presentation.
@MainActor
final class T3AppLock {
  static let shared = T3AppLock()
  static let defaultTimeoutSeconds = 60

  private enum Key {
    static let enabled = "t3.appLock.enabled"
    static let timeout = "t3.appLock.timeoutSeconds"
    static let backgroundedAt = "t3.appLock.backgroundedAt"
    static let bootTime = "t3.appLock.bootTime"
    static let unlockLabel = "t3.appLock.unlockLabel"
    static let reason = "t3.appLock.reason"
  }

  private let defaults = UserDefaults.standard
  private var started = false
  private var locked = false
  private var authenticating = false
  /// The user dismissed the prompt; wait for a tap instead of prompting again.
  private var promptDismissed = false
  private var windows: [ObjectIdentifier: UIWindow] = [:]
  /// App windows hidden from VoiceOver while covered, so it cannot read what the cover hides.
  private let concealedWindows = NSHashTable<UIWindow>.weakObjects()

  var enabled: Bool { defaults.bool(forKey: Key.enabled) }

  var timeoutSeconds: Int {
    defaults.object(forKey: Key.timeout) as? Int ?? Self.defaultTimeoutSeconds
  }

  func start() {
    guard !started else { return }
    started = true
    let center = NotificationCenter.default
    let observe: [(Notification.Name, Selector)] = [
      (UIApplication.willResignActiveNotification, #selector(willResignActive)),
      (UIApplication.didEnterBackgroundNotification, #selector(didEnterBackground)),
      (UIApplication.willEnterForegroundNotification, #selector(willEnterForeground)),
      (UIApplication.didBecomeActiveNotification, #selector(didBecomeActive)),
      (UIScene.willEnterForegroundNotification, #selector(sceneWillEnterForeground(_:))),
      (UIScene.didDisconnectNotification, #selector(sceneDidDisconnect(_:))),
    ]
    for (name, selector) in observe {
      center.addObserver(self, selector: selector, name: name, object: nil)
    }
    // The background record stays until the app comes forward: a background launch must not
    // erase the time it was last closed.
    locked = enabled && !resumesWithinTimeout()
    if locked { showCover() }
  }

  // MARK: Lifecycle

  @objc private func willResignActive() {
    // Our own prompt resigns the app; covering then would flash the cover behind it.
    guard enabled, !authenticating else { return }
    showCover()
  }

  @objc private func didEnterBackground() {
    guard enabled else { return }
    if !locked {
      defaults.set(Self.monotonicNanoseconds(), forKey: Key.backgroundedAt)
      defaults.set(Self.bootTime(), forKey: Key.bootTime)
    }
    promptDismissed = false
    // The keyboard's suggestion bar can echo typed text into the switcher snapshot.
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    showCover()
  }

  @objc private func willEnterForeground() {
    evaluateTimeout()
  }

  @objc private func sceneWillEnterForeground(_ notification: Notification) {
    guard enabled, locked, let scene = notification.object as? UIWindowScene else { return }
    attachWindow(to: scene)
  }

  @objc private func sceneDidDisconnect(_ notification: Notification) {
    guard let scene = notification.object as? UIScene else { return }
    windows.removeValue(forKey: ObjectIdentifier(scene))?.isHidden = true
  }

  @objc private func didBecomeActive() {
    guard !authenticating else { return }
    evaluateTimeout()
    if locked {
      showCover()
      if !promptDismissed { authenticate() }
    } else {
      hideCover()
    }
  }

  private func evaluateTimeout() {
    guard enabled else {
      locked = false
      clearBackgroundedAt()
      return
    }
    if defaults.object(forKey: Key.backgroundedAt) != nil, !resumesWithinTimeout() {
      lock()
    }
    clearBackgroundedAt()
  }

  /// Times the background with a clock that keeps counting while the device sleeps and that the
  /// user cannot change. A reboot or a missing record counts as expired.
  private func resumesWithinTimeout() -> Bool {
    guard
      let backgroundedAt = defaults.object(forKey: Key.backgroundedAt) as? UInt64,
      let bootTime = defaults.object(forKey: Key.bootTime) as? Int,
      abs(bootTime - Self.bootTime()) <= 2
    else { return false }
    let now = Self.monotonicNanoseconds()
    guard now >= backgroundedAt else { return false }
    return (now - backgroundedAt) / 1_000_000_000 < UInt64(max(0, timeoutSeconds))
  }

  private func clearBackgroundedAt() {
    defaults.removeObject(forKey: Key.backgroundedAt)
    defaults.removeObject(forKey: Key.bootTime)
  }

  private func lock() {
    locked = true
    promptDismissed = false
  }

  private func unlock() {
    locked = false
    promptDismissed = false
    hideCover()
  }

  // MARK: Authentication

  func authenticate() {
    guard locked, !authenticating, UIApplication.shared.applicationState == .active else { return }
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
      // Removing the passcode takes the passcode, so only the owner can reach this.
      if LAError.Code(rawValue: error?.code ?? 0) == .passcodeNotSet {
        defaults.set(false, forKey: Key.enabled)
        unlock()
      }
      return
    }
    authenticating = true
    updateCovers()
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
      Task { @MainActor in
        self.authenticating = false
        if success {
          self.unlock()
          return
        }
        switch LAError.Code(rawValue: (error as NSError?)?.code ?? 0) {
        case .systemCancel?, .appCancel?:
          break
        default:
          self.promptDismissed = true
        }
        self.updateCovers()
      }
    }
  }

  /// Settings changes that weaken the lock need the owner; tightening it does not.
  func configure(enabled newEnabled: Bool, timeoutSeconds newTimeout: Int) async throws -> Bool {
    let tightensOnly = enabled && newEnabled && newTimeout <= timeoutSeconds
    if !tightensOnly {
      let context = LAContext()
      var error: NSError?
      if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
        authenticating = true
        defer { authenticating = false }
        do {
          _ = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch {
          return false
        }
      } else if newEnabled {
        throw T3AppLockUnavailableException()
      }
      // Without a passcode the lock protects nothing, so turning it off needs no prompt.
    }
    defaults.set(newEnabled, forKey: Key.enabled)
    defaults.set(max(0, newTimeout), forKey: Key.timeout)
    if !newEnabled {
      clearBackgroundedAt()
      unlock()
    }
    return true
  }

  func status() -> [String: Any] {
    let context = LAContext()
    let available = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    return [
      "enabled": enabled,
      "timeoutSeconds": timeoutSeconds,
      "available": available,
      "biometry": Self.biometryName(context.biometryType),
    ]
  }

  func setStrings(unlockLabel: String, reason: String) {
    defaults.set(unlockLabel, forKey: Key.unlockLabel)
    defaults.set(reason, forKey: Key.reason)
    updateCovers()
  }

  private var reason: String {
    defaults.string(forKey: Key.reason) ?? "Unlock \(Self.appName)"
  }

  private var unlockLabel: String {
    defaults.string(forKey: Key.unlockLabel) ?? "Unlock"
  }

  // MARK: Cover windows

  private func showCover() {
    for case let scene as UIWindowScene in UIApplication.shared.connectedScenes
    where scene.activationState != .unattached {
      attachWindow(to: scene)
    }
    if locked { takeKeyFocus() }
    updateCovers()
  }

  private func attachWindow(to scene: UIWindowScene) {
    let id = ObjectIdentifier(scene)
    if let existing = windows[id] {
      existing.isHidden = false
      return
    }
    let window = UIWindow(windowScene: scene)
    window.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.alert.rawValue + 1)
    window.rootViewController = T3AppLockViewController { [weak self] in
      self?.promptDismissed = false
      self?.authenticate()
    }
    window.isHidden = false
    windows[id] = window
    if locked { takeKeyFocus() }
    updateCovers()
  }

  /// Keeps hardware keyboard input and VoiceOver away from the app while it is locked.
  private func takeKeyFocus() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    for window in windows.values where !window.isKeyWindow { window.makeKey() }
  }

  private func hideCover() {
    for window in concealedWindows.allObjects { window.accessibilityElementsHidden = false }
    concealedWindows.removeAllObjects()
    for window in windows.values {
      window.isHidden = true
      window.windowScene?.windows
        .first { $0.windowLevel == .normal && !$0.isHidden }?
        .makeKey()
    }
    windows.removeAll()
  }

  private func updateCovers() {
    let biometry = Self.biometryType()
    for window in windows.values {
      for other in window.windowScene?.windows ?? [] where !windows.values.contains(other) {
        guard !other.accessibilityElementsHidden else { continue }
        other.accessibilityElementsHidden = true
        concealedWindows.add(other)
      }
      (window.rootViewController as? T3AppLockViewController)?.update(
        showsUnlock: locked && !authenticating,
        title: unlockLabel,
        symbol: Self.unlockSymbol(biometry)
      )
    }
  }

  // MARK: Helpers

  static var appName: String {
    let info = Bundle.main.infoDictionary
    return info?["CFBundleDisplayName"] as? String ?? info?["CFBundleName"] as? String ?? ""
  }

  /// LAContext reports its biometry only after a policy check.
  private static func biometryType() -> LABiometryType {
    let context = LAContext()
    _ = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    return context.biometryType
  }

  private static func monotonicNanoseconds() -> UInt64 {
    // On Darwin, CLOCK_MONOTONIC keeps counting while the device sleeps.
    clock_gettime_nsec_np(CLOCK_MONOTONIC)
  }

  private static func bootTime() -> Int {
    var boot = timeval()
    var size = MemoryLayout<timeval>.size
    guard sysctlbyname("kern.boottime", &boot, &size, nil, 0) == 0 else { return 0 }
    return boot.tv_sec
  }

  private static func biometryName(_ type: LABiometryType) -> String {
    switch type {
    case .faceID: return "faceID"
    case .touchID: return "touchID"
    case .opticID: return "opticID"
    default: return "none"
    }
  }

  private static func unlockSymbol(_ type: LABiometryType) -> String {
    switch type {
    case .faceID: return "faceid"
    case .touchID: return "touchid"
    case .opticID: return "opticid"
    default: return "lock.open"
    }
  }
}

final class T3AppLockUnavailableException: Exception, @unchecked Sendable {
  override var code: String { "ERR_APP_LOCK_UNAVAILABLE" }
  override var reason: String { "Set a device passcode to use App Lock." }
}

final class T3AppLockViewController: UIViewController {
  private let onUnlock: () -> Void
  private let button = UIButton(configuration: .filled())

  init(onUnlock: @escaping () -> Void) {
    self.onUnlock = onUnlock
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    view.accessibilityViewIsModal = true

    let icon = UIImageView(
      image: UIImage(systemName: "lock.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 44))
    )
    icon.tintColor = .secondaryLabel
    icon.contentMode = .scaleAspectFit
    icon.isAccessibilityElement = false

    let name = UILabel()
    name.text = T3AppLock.appName
    name.font = .preferredFont(forTextStyle: .title2)
    name.adjustsFontForContentSizeCategory = true
    name.textColor = .label

    button.configuration?.cornerStyle = .capsule
    button.configuration?.imagePadding = 8
    button.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 24, bottom: 12, trailing: 24)
    button.addAction(UIAction { [weak self] _ in self?.onUnlock() }, for: .primaryActionTriggered)
    button.isHidden = true

    let stack = UIStackView(arrangedSubviews: [icon, name, button])
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 20
    stack.setCustomSpacing(32, after: name)
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.layoutMarginsGuide.leadingAnchor),
    ])
  }

  func update(showsUnlock: Bool, title: String, symbol: String) {
    loadViewIfNeeded()
    button.configuration?.title = title
    button.configuration?.image = UIImage(systemName: symbol)
    button.isHidden = !showsUnlock
  }
}

public final class T3AppLockSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    MainActor.assumeIsolated { T3AppLock.shared.start() }
    return true
  }
}

public final class T3AppLockModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3AppLock")

    AsyncFunction("getStatus") { () -> [String: Any] in
      await T3AppLock.shared.status()
    }

    AsyncFunction("configure") { (enabled: Bool, timeoutSeconds: Int) async throws -> Bool in
      try await T3AppLock.shared.configure(enabled: enabled, timeoutSeconds: timeoutSeconds)
    }

    AsyncFunction("setStrings") { (unlockLabel: String, reason: String) in
      await T3AppLock.shared.setStrings(unlockLabel: unlockLabel, reason: reason)
    }
  }
}
