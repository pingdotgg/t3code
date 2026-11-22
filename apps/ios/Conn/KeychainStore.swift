import Foundation
import Security

struct StoredSession: Sendable, Equatable {
    let serverURL: String
    let bearerToken: String
}

enum KeychainStore {
    private static let service = "com.nckrtl.conn.ios"
    private static let serverURLAccount = "server-url"
    private static let bearerTokenAccount = "bearer-token"

    static func loadSession() -> StoredSession? {
        guard let serverURL = read(account: serverURLAccount),
              let bearerToken = read(account: bearerTokenAccount),
              !serverURL.isEmpty,
              !bearerToken.isEmpty else {
            return nil
        }
        return StoredSession(serverURL: serverURL, bearerToken: bearerToken)
    }

    static func saveSession(serverURL: String, bearerToken: String) {
        write(serverURL, account: serverURLAccount)
        write(bearerToken, account: bearerTokenAccount)
    }

    static func clearSession() {
        delete(account: serverURLAccount)
        delete(account: bearerTokenAccount)
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
