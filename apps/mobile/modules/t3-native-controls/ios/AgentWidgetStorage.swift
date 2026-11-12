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
  static func commit(_ entries: [[String: Any]], generation: String, requestId: String? = nil, in defaults: UserDefaults) -> Bool {
    guard defaults.string(forKey: generationKey) == generation else { return false }
    if let requestId, defaults.string(forKey: "t3_agent_widget_request") != requestId { return false }
    if requestId == nil { _ = beginRefresh(in: defaults) }
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
    let pending: [AgentWidgetCredential.Revocation] = withLock { defaults in
      prepareRevocations(in: defaults)
      return claimRevocations(AgentWidgetCredential.pendingRevocations(), in: defaults, now: Date())
    } ?? []
    for revocation in pending {
      URLSession.shared.dataTask(with: revocation.request) { _, response, error in
        _ = withLock { defaults in
          finishRevocation(account: revocation.account, in: defaults)
          if error == nil, (response as? HTTPURLResponse)?.statusCode == 200 {
            AgentWidgetCredential.remove(account: revocation.account)
          }
        }
      }.resume()
    }
  }

  static func prepareRelay(url: String, in defaults: UserDefaults, readCredential: () -> AgentWidgetCredential.Lookup = { AgentWidgetCredential.lookup() }, storeRevocation: (URLRequest) -> Bool = AgentWidgetCredential.preserveRevocation) -> Bool {
    guard let previous = defaults.string(forKey: "t3_agent_widget_url"), previous != url else { return true }
    clearStoredState(in: defaults, readCredential: readCredential, storeRevocation: storeRevocation)
    return canCreateCredential(in: defaults, credential: readCredential())
  }

  static func prepareRevocations(in defaults: UserDefaults, readCredential: () -> AgentWidgetCredential.Lookup = { AgentWidgetCredential.lookup() }, storeRevocation: (URLRequest) -> Bool = AgentWidgetCredential.preserveRevocation) {
    if defaults.string(forKey: "t3_agent_widget_identity") == nil, defaults.string(forKey: "t3_agent_widget_url") != nil {
      clearCredential(in: defaults, readCredential: readCredential, storeRevocation: storeRevocation)
    }
  }

  static func claimRevocations(_ pending: [AgentWidgetCredential.Revocation], in defaults: UserDefaults, now: Date) -> [AgentWidgetCredential.Revocation] {
    var claims = defaults.dictionary(forKey: "t3_agent_widget_revocation_claims") as? [String: Double] ?? [:]
    claims = claims.filter { now.timeIntervalSince1970 - $0.value < 30 }
    let claimed = pending.filter { claims[$0.account] == nil }
    for revocation in claimed { claims[revocation.account] = now.timeIntervalSince1970 }
    defaults.set(claims, forKey: "t3_agent_widget_revocation_claims")
    return claimed
  }

  static func finishRevocation(account: String, in defaults: UserDefaults) {
    var claims = defaults.dictionary(forKey: "t3_agent_widget_revocation_claims") as? [String: Double] ?? [:]
    claims.removeValue(forKey: account)
    defaults.set(claims, forKey: "t3_agent_widget_revocation_claims")
  }

  static func canCreateCredential(in defaults: UserDefaults, credential: AgentWidgetCredential.Lookup) -> Bool {
    credential == .missing && defaults.string(forKey: "t3_agent_widget_url") == nil && defaults.string(forKey: "t3_agent_widget_token") == nil
  }

  static func observe(_ props: String, entries: [[String: Any]], in defaults: UserDefaults) -> Bool {
    let previous = defaults.string(forKey: "t3_agent_widget_local_observation")
    defaults.set(props, forKey: "t3_agent_widget_local_observation")
    let storedEntries = defaults.array(forKey: timelineKey) as? [[String: Any]]
    let stored = storedEntries?.first?["props"] as? [String: Any]
    if let previous, let old = presentation(previous), let current = presentation(props), old.isEqual(current),
       let stored, let storedEntries, let next = entries.first?["props"] as? [String: Any], presentation(stored).isEqual(presentation(next)),
       storedEntries.dropFirst().map({ $0["timestamp"] as? Int }) == entries.dropFirst().map({ $0["timestamp"] as? Int }) {
      return false
    }
    return commit(entries, generation: generation(in: defaults), in: defaults)
  }

  private static func presentation(_ props: String) -> NSDictionary? {
    guard let data = props.data(using: .utf8),
          let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return presentation(value)
  }

  private static func presentation(_ props: [String: Any]) -> NSDictionary {
    var value = props.filter { !($0.value is NSNull) }
    for key in ["observedActivities", "updatedAt", generationKey] { value.removeValue(forKey: key) }
    if let deadline = value["expiresAt"] as? NSNumber { value["expiresAt"] = floor(deadline.doubleValue / 60_000) }
    if let rows = value["activities"] as? [[String: Any]] {
      value["activities"] = rows.map { $0.filter { $0.key != "updatedAt" } }
    }
    return value as NSDictionary
  }

  static func beginRefresh(in defaults: UserDefaults) -> String {
    let requestId = UUID().uuidString
    defaults.set(requestId, forKey: "t3_agent_widget_request")
    return requestId
  }

  @discardableResult
  static func clearStoredState(in defaults: UserDefaults, readCredential: () -> AgentWidgetCredential.Lookup = { AgentWidgetCredential.lookup() }, storeRevocation: (URLRequest) -> Bool = AgentWidgetCredential.preserveRevocation) -> URLRequest? {
    defaults.set(UUID().uuidString, forKey: AgentWidgetStorage.generationKey)
    for key in ["t3_agent_widget_identity", "t3_agent_widget_local_observation", AgentWidgetStorage.timelineKey] {
      defaults.removeObject(forKey: key)
    }
    return clearCredential(in: defaults, readCredential: readCredential, storeRevocation: storeRevocation)
  }

  @discardableResult
  private static func clearCredential(in defaults: UserDefaults, readCredential: () -> AgentWidgetCredential.Lookup, storeRevocation: (URLRequest) -> Bool) -> URLRequest? {
    let url = defaults.string(forKey: "t3_agent_widget_url").flatMap(URL.init(string:))
    // Revoke the pre-Keychain development credential when upgrading this branch.
    let credential = readCredential()
    var tokens = Set<String>()
    if case let .available(token) = credential { tokens.insert(token) }
    if let legacy = defaults.string(forKey: "t3_agent_widget_token") { tokens.insert(legacy) }
    guard credential != .unavailable else { return nil }
    var request: URLRequest?
    for token in tokens {
      guard let url else { continue }
      var revoke = URLRequest(url: url, timeoutInterval: 10)
      revoke.httpMethod = "DELETE"
      revoke.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      guard storeRevocation(revoke) else { return nil }
      request = revoke
    }
    AgentWidgetCredential.remove()
    for key in ["t3_agent_widget_token", "t3_agent_widget_url"] { defaults.removeObject(forKey: key) }
    return request
  }
}
