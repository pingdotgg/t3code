import Foundation
import Security

public enum KeychainStoreError: Error, LocalizedError, Sendable {
    case unexpectedStatus(Int32)
    case invalidTokenData

    public var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status):
            return "Keychain operation failed with status \(status)."
        case .invalidTokenData:
            return "The stored remote session token is not valid UTF-8."
        }
    }
}

public protocol KeychainStoreProtocol: Sendable {
    func readToken(deviceID: String) throws -> String?
    func writeToken(_ token: String, deviceID: String, label: String) throws
    func deleteToken(deviceID: String) throws
}

/// Minimal wrapper around the classic login keychain.
///
/// This intentionally does not set `kSecUseDataProtectionKeychain`: the
/// ad-hoc/dev-signed app has no entitlement for the data-protection keychain.
public struct KeychainStore: KeychainStoreProtocol {
    public static let service = "com.sergeserb.sergecode.remote-device"

    public init() {}

    public func readToken(deviceID: String) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: deviceID,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data,
                let token = String(data: data, encoding: .utf8)
            else {
                throw KeychainStoreError.invalidTokenData
            }
            return token
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainStoreError.unexpectedStatus(status)
        }
    }

    public func writeToken(_ token: String, deviceID: String, label: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: deviceID,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: Data(token.utf8),
            kSecAttrLabel as String: label,
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else {
            throw KeychainStoreError.unexpectedStatus(updateStatus)
        }

        var item = query
        item[kSecValueData as String] = Data(token.utf8)
        item[kSecAttrLabel as String] = label
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            // A concurrent first writer can win between SecItemUpdate and
            // SecItemAdd. Make that race converge on the same update path.
            if addStatus == errSecDuplicateItem {
                let retryStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
                guard retryStatus == errSecSuccess else {
                    throw KeychainStoreError.unexpectedStatus(retryStatus)
                }
                return
            }
            throw KeychainStoreError.unexpectedStatus(addStatus)
        }
    }

    public func deleteToken(deviceID: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: deviceID,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainStoreError.unexpectedStatus(status)
        }
    }
}
