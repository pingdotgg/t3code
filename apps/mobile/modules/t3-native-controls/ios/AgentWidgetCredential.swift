import Foundation
import Security
import CryptoKit

// Both targets already belong to this app group, which is also a Keychain
// access group. Keep the bearer credential out of preferences and backups.
enum AgentWidgetCredential {
  private static func query(account: String) -> [String: Any]? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "ExpoWidgetsAppGroupIdentifier") as? String else { return nil }
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "t3-agent-widget",
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: group,
    ]
  }

  static func read(account: String = "read-capability") -> String? {
    guard var query = query(account: account) else { return nil }
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func store(_ token: String, account: String = "read-capability") -> Bool {
    guard var query = query(account: account) else { return false }
    query[kSecValueData as String] = Data(token.utf8)
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    var status = SecItemAdd(query as CFDictionary, nil)
    if status == errSecDuplicateItem, let base = self.query(account: account) {
      status = SecItemUpdate(base as CFDictionary, [
        kSecValueData as String: Data(token.utf8),
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      ] as CFDictionary)
    }
    return status == errSecSuccess
  }

  static func remove(account: String = "read-capability") {
    guard let query = query(account: account) else { return }
    SecItemDelete(query as CFDictionary)
  }

  static func preserveRevocation(_ request: URLRequest) -> Bool {
    guard let revocation = Revocation(request: request),
          let data = try? JSONEncoder().encode(revocation),
          let value = String(data: data, encoding: .utf8) else { return false }
    return store(value, account: revocation.account)
  }

  static func pendingRevocations() -> [Revocation] {
    guard var query = query(account: "") else { return [] }
    query.removeValue(forKey: kSecAttrAccount as String)
    query[kSecReturnAttributes as String] = true
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let items = result as? [[String: Any]] else { return [] }
    return items.compactMap { item in
      guard (item[kSecAttrAccount as String] as? String)?.hasPrefix("revoke-") == true,
            let data = item[kSecValueData as String] as? Data else { return nil }
      return try? JSONDecoder().decode(Revocation.self, from: data)
    }
  }

  struct Revocation: Codable {
    let url: URL
    let token: String

    init?(request: URLRequest) {
      guard let url = request.url, let header = request.value(forHTTPHeaderField: "Authorization"),
            header.hasPrefix("Bearer ") else { return nil }
      self.url = url
      self.token = String(header.dropFirst(7))
    }

    var account: String {
      "revoke-" + SHA256.hash(data: Data((url.absoluteString + "\n" + token).utf8)).map { String(format: "%02x", $0) }.joined()
    }

    var request: URLRequest {
      var request = URLRequest(url: url, timeoutInterval: 10)
      request.httpMethod = "DELETE"
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      return request
    }
  }
}
