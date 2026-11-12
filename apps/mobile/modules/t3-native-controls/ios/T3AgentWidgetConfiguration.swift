import Foundation
import Security
import WidgetKit

// Shared with the WidgetKit extension, which runs independently of React Native.
enum T3AgentWidgetConfiguration {
  static func token(identity: String, url: String? = nil) -> String? {
    let token = AgentWidgetStorage.withLock { defaults -> String? in
      if let url, !AgentWidgetStorage.prepareRelay(url: url, in: defaults) { return nil }
      if defaults.string(forKey: "t3_agent_widget_identity") == identity,
         let token = AgentWidgetCredential.read(),
         !AgentWidgetCredential.pendingRevocations().contains(where: { $0.token == token }) {
        if let url { defaults.set(url, forKey: "t3_agent_widget_url") }
        return token
      }
      _ = AgentWidgetStorage.clearStoredState(in: defaults)
      guard AgentWidgetStorage.canCreateCredential(in: defaults, credential: AgentWidgetCredential.lookup()) else { return nil }
      var bytes = [UInt8](repeating: 0, count: 32)
      guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
      let token = bytes.map { String(format: "%02x", $0) }.joined()
      guard AgentWidgetCredential.store(token) else { return nil }
      defaults.set(identity, forKey: "t3_agent_widget_identity")
      if let url { defaults.set(url, forKey: "t3_agent_widget_url") }
      return token
    }.flatMap { $0 }
    AgentWidgetStorage.retryRevocations()
    return token
  }

  static func configure(url: String, token: String) {
    _ = AgentWidgetStorage.withLock { defaults in
      guard defaults.string(forKey: "t3_agent_widget_identity") != nil,
            AgentWidgetCredential.read() == token,
            defaults.string(forKey: "t3_agent_widget_url") == nil || defaults.string(forKey: "t3_agent_widget_url") == url else { return }
      defaults.set(url, forKey: "t3_agent_widget_url")
    }
    AgentWidgetStorage.retryRevocations()
    WidgetCenter.shared.reloadTimelines(ofKind: "AgentActivity")
  }

  static func observe(props: String, timeline: String) -> Bool {
    guard let data = timeline.data(using: .utf8),
          let entries = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return false }
    let stored = AgentWidgetStorage.withLock { defaults in
      AgentWidgetStorage.observe(props, entries: entries, in: defaults)
    }
    AgentWidgetStorage.retryRevocations()
    if stored == true { WidgetCenter.shared.reloadTimelines(ofKind: "AgentActivity") }
    return stored != nil
  }

  static func clear() {
    _ = AgentWidgetStorage.withLock { defaults in AgentWidgetStorage.clearStoredState(in: defaults) }
    WidgetCenter.shared.reloadTimelines(ofKind: "AgentActivity")
    AgentWidgetStorage.retryRevocations()
  }

}
