import Foundation
import Security
import OSLog

struct StoredSession: Codable, Sendable, Equatable {
    let serverURL: String
    let bearerToken: String
    /// The Orbit environment this session belongs to; `nil` for a manual pairing.
    let orbitServerId: String?
    /// Which server this is; its offline cache belongs to it.
    let environmentId: String?
}

enum KeychainStore {
    private static let service = "com.nckrtl.conn.ios"
    private static let sessionAccount = "session-v1"
    private static let serverURLAccount = "server-url"
    private static let bearerTokenAccount = "bearer-token"
    private static let orbitServerIdAccount = "orbit-server-id"
    private static let environmentIdAccount = "environment-id"

    static func loadSession(scope: String = "") -> StoredSession? {
        if let encoded = read(account: sessionAccount + scope),
           let session = try? JSONDecoder().decode(StoredSession.self, from: Data(encoded.utf8)) {
            return session
        }
        #if DEBUG && targetEnvironment(simulator)
        if scope.isEmpty, let fixture = ProcessInfo.processInfo.environment["CONN_TEST_SAVED_SESSION"],
           let session = try? JSONDecoder().decode(StoredSession.self, from: Data(fixture.utf8)),
           URL(string: session.serverURL)?.host == "127.0.0.1" {
            return session
        }
        #endif
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
        let session = StoredSession(serverURL: serverURL, bearerToken: bearerToken, orbitServerId: orbitServerId, environmentId: environmentId)
        guard let encoded = try? JSONEncoder().encode(session),
              write(String(decoding: encoded, as: UTF8.self), account: sessionAccount + scope) == errSecSuccess else { return }
        clearLegacySession(scope: scope)
    }

    static func clearSession(scope: String = "") {
        delete(account: sessionAccount + scope)
        clearLegacySession(scope: scope)
    }

    private static func clearLegacySession(scope: String) {
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

    @discardableResult
    private static func write(_ value: String, account: String) -> OSStatus {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var newItem = query
            newItem[kSecValueData as String] = data
            newItem[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(newItem as CFDictionary, nil)
        }
        recordWriteStatus(status)
        return status
    }

    private static func recordWriteStatus(_ status: OSStatus) {
        guard status != errSecSuccess else { return }
        Logger(subsystem: service, category: "Keychain").error("Credential persistence failed with OSStatus \(status, privacy: .public)")
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
