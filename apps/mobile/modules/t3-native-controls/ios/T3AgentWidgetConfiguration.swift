import Foundation
import Security
import WidgetKit

// Shared with the WidgetKit extension, which runs independently of React Native.
enum T3AgentWidgetConfiguration {
  static var defaults: UserDefaults? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "ExpoWidgetsAppGroupIdentifier") as? String else { return nil }
    return UserDefaults(suiteName: group)
  }

  static func token(identity: String) -> String? {
    guard let defaults else { return nil }
    if defaults.string(forKey: "t3_agent_widget_identity") == identity,
       let token = AgentWidgetCredential.read() { return token }
    clear()
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
    let token = bytes.map { String(format: "%02x", $0) }.joined()
    guard AgentWidgetCredential.store(token) else { return nil }
    defaults.set(identity, forKey: "t3_agent_widget_identity")
    return token
  }

  static func configure(url: String, token: String) {
    guard let defaults, AgentWidgetCredential.read() == token else { return }
    defaults.set(url, forKey: "t3_agent_widget_url")
    WidgetCenter.shared.reloadTimelines(ofKind: "AgentActivity")
  }

  static func observe(props: String) {
    defaults?.set(props, forKey: "t3_agent_widget_local_observation")
  }

  static func clear() {
    guard let defaults else { return }
    let request = clearStoredState(in: defaults)
    WidgetCenter.shared.reloadTimelines(ofKind: "AgentActivity")
    // Clerk may already be signed out. The capability can revoke itself without
    // needing the old account's session token; normal device cleanup still runs.
    if let request {
      URLSession.shared.dataTask(with: request) { _, response, error in
        if error != nil || (response as? HTTPURLResponse)?.statusCode != 200 {
          NSLog("Agent widget capability revocation failed")
        }
      }.resume()
    }
  }

  static func clearStoredState(in defaults: UserDefaults) -> URLRequest? {
    let url = defaults.string(forKey: "t3_agent_widget_url").flatMap(URL.init(string:))
    // Revoke the pre-Keychain development credential when upgrading this branch.
    let token = AgentWidgetCredential.read() ?? defaults.string(forKey: "t3_agent_widget_token")
    AgentWidgetCredential.remove()
    for key in ["t3_agent_widget_identity", "t3_agent_widget_token", "t3_agent_widget_url", "t3_agent_widget_local_observation", "__expo_widgets_AgentActivity_timeline"] {
      defaults.removeObject(forKey: key)
    }
    guard let url, let token else { return nil }
    var request = URLRequest(url: url, timeoutInterval: 10)
    request.httpMethod = "DELETE"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    return request
  }
}
