import Foundation
import Security

public protocol CredentialStore: Sendable {
    func credential(for environmentID: String) async throws -> EnvironmentCredential?
    func setCredential(_ credential: EnvironmentCredential, for environmentID: String) async throws
    func removeCredential(for environmentID: String) async throws
}

public enum CredentialStoreError: LocalizedError, Sendable {
    case keychain(OSStatus)
    case invalidData

    public var errorDescription: String? {
        switch self {
        case let .keychain(status):
            SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)."
        case .invalidData:
            "The saved environment credential is invalid."
        }
    }
}

/// Access tokens are deliberately isolated from the environment catalog so
/// catalog exports and backups never contain authentication material.
public actor KeychainCredentialStore: CredentialStore {
    private let service: String
    private let accessibility: CFString

    public init(
        service: String = "codes.t3.swift-ios.environment-credentials",
        accessibility: CFString = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ) {
        self.service = service
        self.accessibility = accessibility
    }

    public func credential(for environmentID: String) throws -> EnvironmentCredential? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: environmentID,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw CredentialStoreError.keychain(status) }
        guard let data = item as? Data else { throw CredentialStoreError.invalidData }
        do {
            return try JSONDecoder.t3.decode(EnvironmentCredential.self, from: data)
        } catch {
            throw CredentialStoreError.invalidData
        }
    }

    public func setCredential(
        _ credential: EnvironmentCredential,
        for environmentID: String
    ) throws {
        let data = try JSONEncoder.t3.encode(credential)
        let lookup: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: environmentID,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: accessibility,
        ]
        let updateStatus = SecItemUpdate(lookup as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecItemNotFound {
            var insertion = lookup
            attributes.forEach { insertion[$0.key] = $0.value }
            let status = SecItemAdd(insertion as CFDictionary, nil)
            guard status == errSecSuccess else { throw CredentialStoreError.keychain(status) }
        } else if updateStatus != errSecSuccess {
            throw CredentialStoreError.keychain(updateStatus)
        }
    }

    public func removeCredential(for environmentID: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: environmentID,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CredentialStoreError.keychain(status)
        }
    }
}

public actor InMemoryCredentialStore: CredentialStore {
    private var credentials: [String: EnvironmentCredential]

    public init(credentials: [String: EnvironmentCredential] = [:]) {
        self.credentials = credentials
    }

    public func credential(for environmentID: String) -> EnvironmentCredential? {
        credentials[environmentID]
    }

    public func setCredential(
        _ credential: EnvironmentCredential,
        for environmentID: String
    ) {
        credentials[environmentID] = credential
    }

    public func removeCredential(for environmentID: String) {
        credentials.removeValue(forKey: environmentID)
    }
}

public actor EnvironmentStore {
    private struct Document: Codable {
        let version: Int
        var environments: [Environment]
        var activeEnvironmentID: String?
    }

    public let fileURL: URL

    /// Snapshot publishes read the catalog several times a second, so the
    /// decoded document is cached and invalidated by writes on this actor.
    private var cached: Document?

    public init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let root = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first!
            self.fileURL = root
                .appendingPathComponent("T3CodeSwift", isDirectory: true)
                .appendingPathComponent("environments.json", isDirectory: false)
        }
    }

    public func load() throws -> [Environment] {
        try loadDocument().environments
    }

    public func activeEnvironmentID() throws -> String? {
        try loadDocument().activeEnvironmentID
    }

    public func setActiveEnvironment(id: String?) throws {
        var document = try loadDocument()
        document.activeEnvironmentID = id
        try save(document)
    }

    public func save(_ environments: [Environment]) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        var document = try loadDocument()
        document.environments = environments
        try save(document)
    }

    @discardableResult
    public func upsert(_ environment: Environment) throws -> [Environment] {
        var environments = try load()
        if let index = environments.firstIndex(where: { $0.id == environment.id }) {
            environments[index] = environment
        } else {
            environments.append(environment)
        }
        try save(environments)
        return environments
    }

    @discardableResult
    public func remove(id: String) throws -> [Environment] {
        var document = try loadDocument()
        document.environments.removeAll { $0.id == id }
        if document.activeEnvironmentID == id {
            document.activeEnvironmentID = document.environments.first?.id
        }
        try save(document)
        return document.environments
    }

    private func loadDocument() throws -> Document {
        if let cached { return cached }
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return Document(version: 1, environments: [], activeEnvironmentID: nil)
        }
        let data = try Data(contentsOf: fileURL)
        let document = try JSONDecoder.t3.decode(Document.self, from: data)
        cached = document
        return document
    }

    private func save(_ document: Document) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder.t3.encode(document).write(to: fileURL, options: .atomic)
        cached = document
    }
}
