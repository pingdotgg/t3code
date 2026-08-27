import Foundation
import Security

public protocol CredentialStore: Sendable {
    func credential(for environmentID: String) async throws -> EnvironmentCredential?
    func setCredential(_ credential: EnvironmentCredential, for environmentID: String) async throws
    func swapCredential(
        _ credential: EnvironmentCredential,
        for environmentID: String
    ) async throws -> EnvironmentCredential?
    func replaceCredential(
        _ credential: EnvironmentCredential,
        ifMatching expected: EnvironmentCredential,
        for environmentID: String
    ) async throws -> Bool
    func removeCredential(for environmentID: String) async throws
    func removeCredential(
        ifMatching expected: EnvironmentCredential,
        for environmentID: String
    ) async throws -> Bool
}

protocol KeychainCredentialBackend: Sendable {
    func credential(for environmentID: String) throws -> EnvironmentCredential?
    func setCredential(_ credential: EnvironmentCredential, for environmentID: String) throws
    func removeCredential(for environmentID: String) throws
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
    private static let keychainLock = NSLock()
    private let service: String
    private let accessibility: CFString
    private let backend: (any KeychainCredentialBackend)?

    public init(
        service: String = "codes.t3.swift-ios.environment-credentials",
        accessibility: CFString = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ) {
        self.service = service
        self.accessibility = accessibility
        backend = nil
    }

    init(
        service: String,
        backend: any KeychainCredentialBackend,
        accessibility: CFString = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ) {
        self.service = service
        self.accessibility = accessibility
        self.backend = backend
    }

    public func credential(for environmentID: String) throws -> EnvironmentCredential? {
        try Self.keychainLock.withLock {
            try readCredential(for: environmentID)
        }
    }

    public func setCredential(
        _ credential: EnvironmentCredential,
        for environmentID: String
    ) throws {
        try Self.keychainLock.withLock {
            try writeCredential(credential, for: environmentID)
        }
    }

    public func removeCredential(for environmentID: String) throws {
        try Self.keychainLock.withLock {
            try deleteCredential(for: environmentID)
        }
    }

    public func swapCredential(
        _ credential: EnvironmentCredential,
        for environmentID: String
    ) throws -> EnvironmentCredential? {
        try Self.keychainLock.withLock {
            let previousCredential = try readCredential(for: environmentID)
            try writeCredential(credential, for: environmentID)
            return previousCredential
        }
    }

    public func replaceCredential(
        _ credential: EnvironmentCredential,
        ifMatching expected: EnvironmentCredential,
        for environmentID: String
    ) throws -> Bool {
        try Self.keychainLock.withLock {
            guard try readCredential(for: environmentID) == expected else { return false }
            try writeCredential(credential, for: environmentID)
            return true
        }
    }

    public func removeCredential(
        ifMatching expected: EnvironmentCredential,
        for environmentID: String
    ) throws -> Bool {
        try Self.keychainLock.withLock {
            guard try readCredential(for: environmentID) == expected else { return false }
            try deleteCredential(for: environmentID)
            return true
        }
    }

    private func readCredential(for environmentID: String) throws -> EnvironmentCredential? {
        if let backend {
            return try backend.credential(for: environmentID)
        }
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

    private func writeCredential(
        _ credential: EnvironmentCredential,
        for environmentID: String
    ) throws {
        if let backend {
            try backend.setCredential(credential, for: environmentID)
            return
        }
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

    private func deleteCredential(for environmentID: String) throws {
        if let backend {
            try backend.removeCredential(for: environmentID)
            return
        }
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

    public func swapCredential(
        _ credential: EnvironmentCredential,
        for environmentID: String
    ) -> EnvironmentCredential? {
        credentials.updateValue(credential, forKey: environmentID)
    }

    public func replaceCredential(
        _ credential: EnvironmentCredential,
        ifMatching expected: EnvironmentCredential,
        for environmentID: String
    ) -> Bool {
        guard credentials[environmentID] == expected else { return false }
        credentials[environmentID] = credential
        return true
    }

    public func removeCredential(
        ifMatching expected: EnvironmentCredential,
        for environmentID: String
    ) -> Bool {
        guard credentials[environmentID] == expected else { return false }
        credentials.removeValue(forKey: environmentID)
        return true
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

    @discardableResult
    public func setEnabled(id: String, enabled: Bool) throws -> [Environment] {
        var document = try loadDocument()
        guard let index = document.environments.firstIndex(where: { $0.id == id }) else {
            return document.environments
        }
        document.environments[index].isEnabled = enabled
        if !enabled, document.activeEnvironmentID == id {
            document.activeEnvironmentID = document.environments.first {
                $0.isEnabled && $0.id != id
            }?.id
        }
        try save(document)
        return document.environments
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
            document.activeEnvironmentID = document.environments.first(where: \.isEnabled)?.id
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
