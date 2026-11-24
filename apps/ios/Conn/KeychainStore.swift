import Foundation
import Security

struct StoredSession: Sendable, Equatable {
    let serverURL: String
    let bearerToken: String
    /// The Orbit environment this session belongs to; `nil` for a manual pairing.
    let orbitServerId: String?
    /// Which server this is; its offline cache belongs to it.
    let environmentId: String?
}

enum KeychainStore {
    private static let service = "com.nckrtl.conn.ios"
    private static let serverURLAccount = "server-url"
    private static let bearerTokenAccount = "bearer-token"
    private static let orbitServerIdAccount = "orbit-server-id"
    private static let environmentIdAccount = "environment-id"

    static func loadSession(scope: String = "") -> StoredSession? {
        guard let serverURL = read(account: serverURLAccount + scope),
              let bearerToken = read(account: bearerTokenAccount + scope),
              !serverURL.isEmpty,
              !bearerToken.isEmpty else {
            return nil
        }
        let orbitServerId = read(account: orbitServerIdAccount + scope).flatMap { $0.isEmpty ? nil : $0 }
        let environmentId = read(account: environmentIdAccount + scope).flatMap { $0.isEmpty ? nil : $0 }
        return StoredSession(
            serverURL: serverURL,
            bearerToken: bearerToken,
            orbitServerId: orbitServerId,
            environmentId: environmentId
        )
    }

    static func saveSession(
        serverURL: String,
        bearerToken: String,
        orbitServerId: String?,
        environmentId: String?,
        scope: String = ""
    ) {
        write(serverURL, account: serverURLAccount + scope)
        write(bearerToken, account: bearerTokenAccount + scope)
        for (value, account) in [(orbitServerId, orbitServerIdAccount), (environmentId, environmentIdAccount)] {
            if let value {
                write(value, account: account + scope)
            } else {
                delete(account: account + scope)
            }
        }
    }

    static func clearSession(scope: String = "") {
        delete(account: serverURLAccount + scope)
        delete(account: bearerTokenAccount + scope)
        delete(account: orbitServerIdAccount + scope)
        delete(account: environmentIdAccount + scope)
    }

    private static let pushDeviceIdAccount = "push-device-id"

    /// A stable UUID that names this install to the Orbit Gateway's push registry. It survives
    /// sign-out, so a later registration replaces the same device row.
    static func pushDeviceId() -> String {
        if let existing = read(account: pushDeviceIdAccount), !existing.isEmpty {
            return existing
        }
        let created = UUID().uuidString.lowercased()
        write(created, account: pushDeviceIdAccount)
        return created
    }

    private static func read(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private static func write(_ value: String, account: String) {
        guard let data = value.data(using: .utf8) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var newItem = query
            newItem[kSecValueData as String] = data
            newItem[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(newItem as CFDictionary, nil)
        }
    }

    private static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
