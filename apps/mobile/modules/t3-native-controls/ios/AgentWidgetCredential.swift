import Foundation
import Security

// Both targets already belong to this app group, which is also a Keychain
// access group. Keep the bearer credential out of preferences and backups.
enum AgentWidgetCredential {
  private static var query: [String: Any]? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "ExpoWidgetsAppGroupIdentifier") as? String else { return nil }
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "t3-agent-widget",
      kSecAttrAccount as String: "read-capability",
      kSecAttrAccessGroup as String: group,
    ]
  }

  static func read() -> String? {
    guard var query else { return nil }
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func store(_ token: String) -> Bool {
    guard var query else { return false }
    query[kSecValueData as String] = Data(token.utf8)
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
  }

  static func remove() {
    guard let query else { return }
    SecItemDelete(query as CFDictionary)
  }
}
