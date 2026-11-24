import Foundation
import Security

public protocol T3CredentialProviding: Sendable {
  func credential(for environmentId: String) -> T3AuthCredentialRecord?
  func saveCredentials(_ credentials: [T3AuthCredentialRecord]) throws
  func removeCredential(for environmentId: String) throws
  func clearAllCredentials() throws
}

public struct T3KeychainError: Error, Equatable {
  public let status: OSStatus
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

  public func saveCredentials(_ credentials: [T3AuthCredentialRecord]) throws {
    lock.lock()
    defer { lock.unlock() }
    let encoder = JSONEncoder()
    for record in credentials {
      let data = try encoder.encode(record)
      let status = writeRecord(account: record.environmentId, data: data, includeAccessGroup: true)
      guard status != errSecSuccess else { continue }
      // Unsigned local dev builds lack the access group entitlement; fall back to the default group.
      guard accessGroup != nil else { throw T3KeychainError(status: status) }
      let fallback = writeRecord(account: record.environmentId, data: data, includeAccessGroup: false)
      guard fallback == errSecSuccess else { throw T3KeychainError(status: fallback) }
    }
  }

  private func writeRecord(account: String, data: Data, includeAccessGroup: Bool) -> OSStatus {
    let query = baseQuery(account: account, includeAccessGroup: includeAccessGroup)
    let update = [kSecValueData as String: data] as CFDictionary
    let updated = SecItemUpdate(query as CFDictionary, update)
    guard updated == errSecItemNotFound else { return updated }
    var addQuery = query
    addQuery[kSecValueData as String] = data
    addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(addQuery as CFDictionary, nil)
  }

  public func removeCredential(for environmentId: String) throws {
    lock.lock()
    defer { lock.unlock() }
    try deleteItems(account: environmentId)
  }

  public func clearAllCredentials() throws {
    lock.lock()
    defer { lock.unlock() }
    try deleteItems(account: nil)
  }

  private func deleteItems(account: String?) throws {
    var groups = [true]
    if accessGroup != nil { groups.append(false) }
    for includeAccessGroup in groups {
      let status = SecItemDelete(baseQuery(account: account, includeAccessGroup: includeAccessGroup) as CFDictionary)
      let scopedWithFallback = includeAccessGroup && accessGroup != nil
      if Self.deleteSucceeded(status, scopedWithFallback: scopedWithFallback) { continue }
      throw T3KeychainError(status: status)
    }
  }

  /// Without the access group entitlement the group-scoped delete fails, but the unscoped delete
  /// that follows it still runs; any other failure, or that one with no fallback, is real.
  static func deleteSucceeded(_ status: OSStatus, scopedWithFallback: Bool) -> Bool {
    if status == errSecSuccess || status == errSecItemNotFound { return true }
    return scopedWithFallback && status == errSecMissingEntitlement
  }
}
