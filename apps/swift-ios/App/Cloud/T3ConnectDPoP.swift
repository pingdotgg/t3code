import CryptoKit
import Foundation
import Security

public struct T3ConnectDPoPPublicJWK: Codable, Equatable, Sendable {
    public let kty: String
    public let crv: String
    public let x: String
    public let y: String

    fileprivate init(publicKey: P256.Signing.PublicKey) throws {
        let representation = publicKey.x963Representation
        guard representation.count == 65, representation.first == 0x04 else {
            throw T3ConnectDPoPError.invalidPublicKey
        }
        kty = "EC"
        crv = "P-256"
        x = Data(representation[1..<33]).base64URLEncodedString()
        y = Data(representation[33..<65]).base64URLEncodedString()
    }

    public var canonicalThumbprintInput: String {
        "{\"crv\":\"\(crv)\",\"kty\":\"\(kty)\",\"x\":\"\(x)\",\"y\":\"\(y)\"}"
    }

    public var thumbprint: String {
        Data(SHA256.hash(data: Data(canonicalThumbprintInput.utf8)))
            .base64URLEncodedString()
    }
}

public struct T3ConnectDPoPProof: Equatable, Sendable {
    public let value: String
    public let thumbprint: String
}

public enum T3ConnectDPoPError: LocalizedError, Sendable {
    case invalidURL
    case invalidPrivateKey
    case invalidPublicKey
    case invalidStoredKey
    case keychain(OSStatus)
    case encoding

    public var errorDescription: String? {
        switch self {
        case .invalidURL:
            "The DPoP proof URL is invalid."
        case .invalidPrivateKey:
            "The DPoP private key is invalid."
        case .invalidPublicKey:
            "The DPoP public key is invalid."
        case .invalidStoredKey:
            "The saved DPoP identity is invalid."
        case let .keychain(status):
            SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)."
        case .encoding:
            "The DPoP proof could not be encoded."
        }
    }
}

/// Owns the proof-of-possession identity used by both relay and environment requests.
/// Rotating this key invalidates every token bound to its JWK thumbprint, so the
/// production initializer persists it in the device-only Keychain.
public actor T3ConnectDPoPSigner {
    private let service: String?
    private let account: String
    private var privateKey: P256.Signing.PrivateKey?

    public init(
        service: String = "com.t3tools.t3code.swiftui.t3-connect-dpop",
        account: String = "device-proof-key"
    ) {
        self.service = service
        self.account = account
    }

    /// Deterministic in-memory identity for focused tests and previews.
    public init(privateKeyRawRepresentation: Data) throws {
        do {
            privateKey = try P256.Signing.PrivateKey(rawRepresentation: privateKeyRawRepresentation)
        } catch {
            throw T3ConnectDPoPError.invalidPrivateKey
        }
        service = nil
        account = "in-memory"
    }

    /// The signing key never rotates (see type docs), so the derived JWK and
    /// its SHA-256 thumbprint are stable and cached. Both are recomputed on
    /// every managed request otherwise.
    private var cachedJWK: T3ConnectDPoPPublicJWK?
    private var cachedThumbprint: String?

    public func publicJWK() throws -> T3ConnectDPoPPublicJWK {
        if let cachedJWK { return cachedJWK }
        let jwk = try T3ConnectDPoPPublicJWK(publicKey: try loadPrivateKey().publicKey)
        cachedJWK = jwk
        return jwk
    }

    public func thumbprint() throws -> String {
        if let cachedThumbprint { return cachedThumbprint }
        let thumbprint = try publicJWK().thumbprint
        cachedThumbprint = thumbprint
        return thumbprint
    }

    public func proof(
        method: String,
        url: URL,
        accessToken: String? = nil,
        issuedAt: Date = Date(),
        identifier: UUID = UUID()
    ) throws -> T3ConnectDPoPProof {
        guard let normalizedURL = Self.normalizedHTU(url) else {
            throw T3ConnectDPoPError.invalidURL
        }

        let key = try loadPrivateKey()
        let jwk = try publicJWK()
        let header = Header(typ: "dpop+jwt", alg: "ES256", jwk: jwk)
        let payload = Payload(
            htm: method.uppercased(),
            htu: normalizedURL.absoluteString,
            jti: identifier.uuidString.lowercased(),
            iat: Int(issuedAt.timeIntervalSince1970.rounded(.down)),
            ath: accessToken.map(Self.accessTokenHash)
        )
        guard
            let headerPart = try? Self.proofEncoder.encode(header).base64URLEncodedString(),
            let payloadPart = try? Self.proofEncoder.encode(payload).base64URLEncodedString()
        else {
            throw T3ConnectDPoPError.encoding
        }
        let signingInput = "\(headerPart).\(payloadPart)"
        let signature = try key.signature(for: Data(signingInput.utf8))
        return T3ConnectDPoPProof(
            value: "\(signingInput).\(signature.rawRepresentation.base64URLEncodedString())",
            thumbprint: jwk.thumbprint
        )
    }

    public static func normalizedHTU(_ url: URL) -> URL? {
        guard
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.scheme != nil,
            components.host != nil
        else { return nil }
        components.query = nil
        components.fragment = nil
        switch (components.scheme?.lowercased(), components.port) {
        case ("http", 80), ("https", 443), ("ws", 80), ("wss", 443):
            components.port = nil
        default:
            break
        }
        return components.url
    }

    public static func accessTokenHash(_ accessToken: String) -> String {
        Data(SHA256.hash(data: Data(accessToken.utf8))).base64URLEncodedString()
    }

    private func loadPrivateKey() throws -> P256.Signing.PrivateKey {
        if let privateKey { return privateKey }
        guard let service else { throw T3ConnectDPoPError.invalidStoredKey }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess {
            guard let data = item as? Data else { throw T3ConnectDPoPError.invalidStoredKey }
            do {
                let restored = try P256.Signing.PrivateKey(rawRepresentation: data)
                privateKey = restored
                return restored
            } catch {
                throw T3ConnectDPoPError.invalidStoredKey
            }
        }
        guard status == errSecItemNotFound else { throw T3ConnectDPoPError.keychain(status) }

        let generated = P256.Signing.PrivateKey()
        var insertion = query
        insertion.removeValue(forKey: kSecReturnData as String)
        insertion.removeValue(forKey: kSecMatchLimit as String)
        insertion[kSecValueData as String] = generated.rawRepresentation
        insertion[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let insertionStatus = SecItemAdd(insertion as CFDictionary, nil)
        if insertionStatus == errSecDuplicateItem {
            // Another signer instance won the first-launch race. Preserve that
            // identity instead of rotating to this actor's generated key.
            return try readExistingPrivateKey(service: service)
        }
        guard insertionStatus == errSecSuccess else {
            throw T3ConnectDPoPError.keychain(insertionStatus)
        }
        privateKey = generated
        return generated
    }

    private func readExistingPrivateKey(service: String) throws -> P256.Signing.PrivateKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else { throw T3ConnectDPoPError.keychain(status) }
        guard let data = item as? Data else { throw T3ConnectDPoPError.invalidStoredKey }
        do {
            let restored = try P256.Signing.PrivateKey(rawRepresentation: data)
            privateKey = restored
            return restored
        } catch {
            throw T3ConnectDPoPError.invalidStoredKey
        }
    }

    private static let proofEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    private struct Header: Encodable {
        let typ: String
        let alg: String
        let jwk: T3ConnectDPoPPublicJWK
    }

    private struct Payload: Encodable {
        let htm: String
        let htu: String
        let jti: String
        let iat: Int
        let ath: String?
    }
}

extension Data {
    fileprivate func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
