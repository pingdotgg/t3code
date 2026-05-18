import Foundation
import Security

enum MobileConnectionCredentialStoreError: Error, LocalizedError {
    case keychainStatus(OSStatus)

    var errorDescription: String? {
        switch self {
        case let .keychainStatus(status):
            "Keychain operation failed with status \(status)."
        }
    }
}

struct MobileConnectionCredentialStore {
    private static let baseURLKey = "tools.t3.mobile.serverBaseURL"
    private static let keychainService = "tools.t3.mobile.connection"
    private static let bearerTokenAccount = "bearer-token"

    private let userDefaults: UserDefaults

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
    }

    var savedServerURLString: String {
        userDefaults.string(forKey: Self.baseURLKey) ?? ""
    }

    func loadConfiguration() throws -> MobileServerConfiguration? {
        if let persisted = try loadPersistedConfiguration() {
            return persisted
        }
        return try MobileLaunchConfiguration.fromProcessInfo()
    }

    func rememberPendingPairing(baseURL: URL) throws {
        userDefaults.set(baseURL.absoluteString, forKey: Self.baseURLKey)
        try deleteBearerToken()
    }

    func rememberAuthenticatedSession(baseURL: URL, bearerToken: String) throws {
        userDefaults.set(baseURL.absoluteString, forKey: Self.baseURLKey)
        try saveBearerToken(bearerToken)
    }

    func forget() throws {
        userDefaults.removeObject(forKey: Self.baseURLKey)
        try deleteBearerToken()
    }

    private func loadPersistedConfiguration() throws -> MobileServerConfiguration? {
        guard
            let rawBaseURL = userDefaults.string(forKey: Self.baseURLKey),
            !rawBaseURL.isEmpty,
            let baseURL = URL(string: rawBaseURL)
        else {
            return nil
        }
        guard let bearerToken = try loadBearerToken(), !bearerToken.isEmpty else {
            return nil
        }
        return MobileServerConfiguration(baseURL: baseURL, bearerSessionToken: bearerToken)
    }

    private func loadBearerToken() throws -> String? {
        var query = bearerTokenQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw MobileConnectionCredentialStoreError.keychainStatus(status)
        }
        guard let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private func saveBearerToken(_ bearerToken: String) throws {
        let data = Data(bearerToken.utf8)
        let query = bearerTokenQuery()
        let updateStatus = SecItemUpdate(query as CFDictionary, [
            kSecValueData as String: data,
        ] as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else {
            throw MobileConnectionCredentialStoreError.keychainStatus(updateStatus)
        }

        var addQuery = query
        addQuery[kSecValueData as String] = data
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw MobileConnectionCredentialStoreError.keychainStatus(addStatus)
        }
    }

    private func deleteBearerToken() throws {
        let status = SecItemDelete(bearerTokenQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw MobileConnectionCredentialStoreError.keychainStatus(status)
        }
    }

    private func bearerTokenQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: Self.bearerTokenAccount,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
    }
}
