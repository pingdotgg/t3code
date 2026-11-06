import Foundation
import Darwin

enum AgentWidgetStorage {
  static let timelineKey = "__expo_widgets_AgentActivity_timeline"
  static let generationKey = "t3_agent_widget_generation"

  static func withLock<T>(_ body: (UserDefaults) -> T) -> T? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "ExpoWidgetsAppGroupIdentifier") as? String,
          let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
          let defaults = UserDefaults(suiteName: group) else { return nil }
    return withLock(at: directory.appendingPathComponent("agent-widget.lock"), defaults: defaults, body)
  }

  // App and extension must synchronize preferences inside the same OS lock.
  static func withLock<T>(at url: URL, defaults: UserDefaults, _ body: (UserDefaults) -> T) -> T? {
    let fd = open(url.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    guard flock(fd, LOCK_EX) == 0 else { return nil }
    defer { flock(fd, LOCK_UN) }
    defaults.synchronize()
    defer { defaults.synchronize() }
    return body(defaults)
  }

  static func generation(in defaults: UserDefaults) -> String {
    if let generation = defaults.string(forKey: generationKey) { return generation }
    let generation = UUID().uuidString
    defaults.set(generation, forKey: generationKey)
    return generation
  }

  static func owns(_ props: [String: Any]?, in defaults: UserDefaults) -> Bool {
    guard let owner = props?[generationKey] as? String else { return false }
    return owner == defaults.string(forKey: generationKey)
  }

  @discardableResult
  static func commit(_ entries: [[String: Any]], generation: String, in defaults: UserDefaults) -> Bool {
    guard defaults.string(forKey: generationKey) == generation else { return false }
    defaults.set(entries.map { entry in
      var entry = entry
      var props = (entry["props"] as? [String: Any] ?? [:]).filter { !($0.value is NSNull) }
      props[generationKey] = generation
      entry["props"] = props
      return entry
    }, forKey: timelineKey)
    return true
  }

  static func retryRevocations() {
    let pending = withLock { _ in AgentWidgetCredential.pendingRevocations() } ?? []
    for revocation in pending {
      URLSession.shared.dataTask(with: revocation.request) { _, response, error in
        guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200 else { return }
        _ = withLock { _ in AgentWidgetCredential.remove(account: revocation.account) }
      }.resume()
    }
  }
}
