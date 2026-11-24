import Foundation
import Security

public protocol T3CredentialProviding: Sendable {
  func credential(for environmentId: String) -> T3AuthCredentialRecord?
  func saveCredentials(_ credentials: [T3AuthCredentialRecord])
  func removeCredential(for environmentId: String)
  func clearAllCredentials()
}

/// Keychain-backed credential store so headless App Intents and the macOS ExtensionKit process
/// can call authenticated environment HTTP routes across local, LAN, Tailscale, and T3 Connect.
public final class T3KeychainCredentialStore: T3CredentialProviding, @unchecked Sendable {
  public static let shared = T3KeychainCredentialStore()

  private let service: String
  private let accessGroup: String?
  private let lock = NSLock()

  public init(
    service: String = T3IntentsConfig.keychainService,
    accessGroup: String? = T3IntentsConfig.keychainAccessGroup
  ) {
    self.service = service
    self.accessGroup = accessGroup
  }

  private func baseQuery(account: String? = nil, includeAccessGroup: Bool = true) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
    ]
    if let account {
      query[kSecAttrAccount as String] = account
    }
    if includeAccessGroup, let accessGroup {
      query[kSecAttrAccessGroup as String] = accessGroup
    }
    #if os(macOS)
    query[kSecUseDataProtectionKeychain as String] = true
    #endif
    return query
  }

  public func credential(for environmentId: String) -> T3AuthCredentialRecord? {
    lock.lock()
    defer { lock.unlock() }
    if let found = readRecord(account: environmentId, includeAccessGroup: true) {
      return found
    }
    // Unsigned local dev builds lack keychain-access-groups entitlement; retry default group.
    if accessGroup != nil {
      return readRecord(account: environmentId, includeAccessGroup: false)
    }
    return nil
  }

  private func readRecord(account: String, includeAccessGroup: Bool) -> T3AuthCredentialRecord? {
    var query = baseQuery(account: account, includeAccessGroup: includeAccessGroup)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else {
      return nil
    }
    return try? JSONDecoder().decode(T3AuthCredentialRecord.self, from: data)
  }

  public func saveCredentials(_ credentials: [T3AuthCredentialRecord]) {
    lock.lock()
    defer { lock.unlock() }
    let encoder = JSONEncoder()
    for record in credentials {
      guard let data = try? encoder.encode(record) else { continue }
      if !writeRecord(account: record.environmentId, data: data, includeAccessGroup: true),
         accessGroup != nil {
        _ = writeRecord(account: record.environmentId, data: data, includeAccessGroup: false)
      }
    }
  }

  private func writeRecord(account: String, data: Data, includeAccessGroup: Bool) -> Bool {
    let deleteQuery = baseQuery(account: account, includeAccessGroup: includeAccessGroup)
    SecItemDelete(deleteQuery as CFDictionary)
    var addQuery = baseQuery(account: account, includeAccessGroup: includeAccessGroup)
    addQuery[kSecValueData as String] = data
    addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(addQuery as CFDictionary, nil) == errSecSuccess
  }

  public func removeCredential(for environmentId: String) {
    lock.lock()
    defer { lock.unlock() }
    SecItemDelete(baseQuery(account: environmentId, includeAccessGroup: true) as CFDictionary)
    if accessGroup != nil {
      SecItemDelete(baseQuery(account: environmentId, includeAccessGroup: false) as CFDictionary)
    }
  }

  public func clearAllCredentials() {
    lock.lock()
    defer { lock.unlock() }
    SecItemDelete(baseQuery(account: nil, includeAccessGroup: true) as CFDictionary)
    if accessGroup != nil {
      SecItemDelete(baseQuery(account: nil, includeAccessGroup: false) as CFDictionary)
    }
  }
}
