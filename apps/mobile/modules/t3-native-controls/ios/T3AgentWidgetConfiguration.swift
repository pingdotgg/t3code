import Foundation
import Security
import WidgetKit

// Shared with the WidgetKit extension, which runs independently of React Native.
enum T3AgentWidgetConfiguration {
  static func token(identity: String) -> String? {
    let token = AgentWidgetStorage.withLock { defaults -> String? in
      if defaults.string(forKey: "t3_agent_widget_identity") == identity,
         let token = AgentWidgetCredential.read(),
         !AgentWidgetCredential.pendingRevocations().contains(where: { $0.token == token }) { return token }
      _ = clearStoredState(in: defaults)
      // If Keychain cannot preserve revocation, keep the disabled credential for retry.
      guard AgentWidgetCredential.read() == nil else { return nil }
      var bytes = [UInt8](repeating: 0, count: 32)
      guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
      let token = bytes.map { String(format: "%02x", $0) }.joined()
      guard AgentWidgetCredential.store(token) else { return nil }
      defaults.set(identity, forKey: "t3_agent_widget_identity")
      return token
    }.flatMap { $0 }
    AgentWidgetStorage.retryRevocations()
    return token
  }

  static func configure(url: String, token: String) {
    _ = AgentWidgetStorage.withLock { defaults in
      guard defaults.string(forKey: "t3_agent_widget_identity") != nil,
            AgentWidgetCredential.read() == token else { return }
      defaults.set(url, forKey: "t3_agent_widget_url")
    }
    AgentWidgetStorage.retryRevocations()
    WidgetCenter.shared.reloadTimelines(ofKind: "AgentActivity")
  }

  static func observe(props: String, timeline: String) -> Bool {
    guard let data = timeline.data(using: .utf8),
          let entries = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return false }
    let stored = AgentWidgetStorage.withLock { defaults in
      defaults.set(props, forKey: "t3_agent_widget_local_observation")
      return AgentWidgetStorage.commit(entries, generation: AgentWidgetStorage.generation(in: defaults), in: defaults)
    } ?? false
    AgentWidgetStorage.retryRevocations()
    if stored { WidgetCenter.shared.reloadTimelines(ofKind: "AgentActivity") }
    return stored
  }

  static func clear() {
    _ = AgentWidgetStorage.withLock { defaults in clearStoredState(in: defaults) }
    WidgetCenter.shared.reloadTimelines(ofKind: "AgentActivity")
    AgentWidgetStorage.retryRevocations()
  }

  @discardableResult
  static func clearStoredState(in defaults: UserDefaults, storeRevocation: (URLRequest) -> Bool = AgentWidgetCredential.preserveRevocation) -> URLRequest? {
    let url = defaults.string(forKey: "t3_agent_widget_url").flatMap(URL.init(string:))
    // Revoke the pre-Keychain development credential when upgrading this branch.
    let token = AgentWidgetCredential.read() ?? defaults.string(forKey: "t3_agent_widget_token")
    defaults.set(UUID().uuidString, forKey: AgentWidgetStorage.generationKey)
    for key in ["t3_agent_widget_identity", "t3_agent_widget_local_observation", AgentWidgetStorage.timelineKey] {
      defaults.removeObject(forKey: key)
    }
    var request: URLRequest?
    if let url, let token {
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
