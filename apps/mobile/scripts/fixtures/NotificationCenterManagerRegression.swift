import Foundation

// The registry runs on macOS without starting a simulator. Only the OS-facing
// types are replaced; the tests compile the dependency's actual Swift source.
public enum UIBackgroundFetchResult {
  case noData
}

public struct UNNotificationPresentationOptions: OptionSet {
  public let rawValue: Int
  public init(rawValue: Int) { self.rawValue = rawValue }
}

public final class UNNotification: NSObject {}

public final class UNNotificationResponse: NSObject {
  let identifier: String
  init(_ identifier: String) { self.identifier = identifier }
}

public protocol UNUserNotificationCenterDelegate: AnyObject {}

public final class UNUserNotificationCenter: NSObject {
  private static let instance = UNUserNotificationCenter()
  public weak var delegate: UNUserNotificationCenterDelegate?
  public static func current() -> UNUserNotificationCenter { instance }
}

private final class TestDelegate: NotificationDelegate {
  private let lock = NSLock()
  private var recordedEvents: [String] = []
  var onEvent: ((String) -> Void)?
  var onResponse: ((UNNotificationResponse) -> Bool)?

  var events: [String] { lock.withLock { recordedEvents } }

  private func record(_ event: String) {
    lock.withLock { recordedEvents.append(event) }
    onEvent?(event)
  }

  func didRegister(_ deviceToken: String) { record("registered") }
  func didFailRegistration(_ error: Error) { record("failed") }
  func openSettings(_ notification: UNNotification?) { record("settings") }

  func willPresent(_ notification: UNNotification, completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) -> Bool {
    record("present")
    return false
  }

  func didReceive(_ userInfo: [AnyHashable: Any], completionHandler: @escaping (UIBackgroundFetchResult) -> Void) -> Bool {
    record("background")
    return false
  }

  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    record(response.identifier)
    return onResponse?(response) ?? false
  }
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() {
    throw NSError(domain: "NotificationCenterManagerRegression", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}

private func deliver(_ identifier: String) {
  NotificationCenterManager.shared.userNotificationCenter(
    UNUserNotificationCenter.current(),
    didReceive: UNNotificationResponse(identifier),
    withCompletionHandler: {}
  )
}

private func reentrantCallbacks() throws {
  let manager = NotificationCenterManager.shared
  let center = UNUserNotificationCenter.current()
  let callbacks: [(String, () -> Void)] = [
    ("registered", { manager.didRegister("token") }),
    ("failed", { manager.didFailRegistration(NSError(domain: "test", code: 1)) }),
    ("settings", { manager.userNotificationCenter(center, openSettingsFor: nil) }),
    ("present", { manager.userNotificationCenter(center, willPresent: UNNotification(), withCompletionHandler: { _ in }) }),
    ("background", { manager.didReceive([:], completionHandler: { _ in }) })
  ]

  for (event, callback) in callbacks {
    let original = TestDelegate()
    let replacement = TestDelegate()
    original.onEvent = { [weak original] _ in
      guard let original else { return }
      manager.removeDelegate(original)
      manager.addDelegate(replacement)
    }
    manager.addDelegate(original)
    callback()
    try require(original.events == [event], "The original delegate must receive the callback once")
    try require(replacement.events.isEmpty, "New delegates must not join an in-flight callback snapshot")
    callback()
    try require(replacement.events == [event], "Reentrant registration must take effect for the next callback")
    manager.removeDelegate(replacement)
  }
}

private func registrationDuringDelivery() throws {
  let manager = NotificationCenterManager.shared
  let original = TestDelegate()
  let receiver = TestDelegate()
  receiver.onResponse = { _ in true }
  original.onResponse = { _ in
    manager.addDelegate(receiver)
    return false
  }
  manager.addDelegate(original)
  deliver("handoff")
  try require(receiver.events == ["handoff"], "A delegate registering during delivery must not miss the pending response")
  manager.removeDelegate(original)
  manager.removeDelegate(receiver)
}

private func responseDuringReplay() throws {
  let manager = NotificationCenterManager.shared
  deliver("first")
  let original = TestDelegate()
  original.onResponse = { response in
    if response.identifier == "first" {
      deliver("second")
      return true
    }
    return false
  }
  manager.addDelegate(original)
  let receiver = TestDelegate()
  receiver.onResponse = { _ in true }
  manager.addDelegate(receiver)
  try require(receiver.events == ["second"], "Finishing a replay must retain responses received during callbacks")
  manager.removeDelegate(original)
  manager.removeDelegate(receiver)
}

private func concurrentRegistrations() throws {
  let manager = NotificationCenterManager.shared
  let delegates = (0..<512).map { _ in
    let delegate = TestDelegate()
    delegate.onResponse = { _ in true }
    return delegate
  }
  DispatchQueue.concurrentPerform(iterations: delegates.count) { index in
    manager.addDelegate(delegates[index])
    if index.isMultiple(of: 16) {
      manager.didRegister("during-add")
      deliver("during-add")
    }
  }
  let before = delegates.map { $0.events.count }
  manager.didRegister("after-add")
  for (index, delegate) in delegates.enumerated() {
    try require(delegate.events.count == before[index] + 1, "Concurrent registration must retain every delegate exactly once")
  }
  DispatchQueue.concurrentPerform(iterations: delegates.count) { index in
    manager.removeDelegate(delegates[index])
    if index.isMultiple(of: 16) {
      manager.didRegister("during-remove")
      deliver("during-remove")
    }
  }
  let removed = delegates.map { $0.events.count }
  manager.didRegister("after-remove")
  try require(delegates.map { $0.events.count } == removed, "Removed delegates must not receive new callbacks")
}

@main
private enum RegressionTests {
  static func main() {
    do {
      switch CommandLine.arguments.last {
      case "reentrant": try reentrantCallbacks()
      case "handoff": try registrationDuringDelivery()
      case "pending": try responseDuringReplay()
      case "concurrent": try concurrentRegistrations()
      default: throw NSError(domain: "NotificationCenterManagerRegression", code: 2)
      }
      print("passed")
    } catch {
      FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
      exit(1)
    }
  }
}
