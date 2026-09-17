import CryptoKit
import Foundation

struct FeatureProjectFaviconCacheKey: Codable, Hashable, Sendable {
    let environmentID: String
    let workspaceRoot: String

    init(environmentID: String, workspaceRoot: String) {
        self.environmentID = environmentID
        self.workspaceRoot = Self.normalize(workspaceRoot)
    }

    private static func normalize(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return trimmed }
        return URL(fileURLWithPath: trimmed).standardizedFileURL.path
    }

    var fingerprint: String {
        let input = Data("\(environmentID)\u{0}\(workspaceRoot)".utf8)
        return SHA256.hash(data: input).map { String(format: "%02x", $0) }.joined()
    }
}

struct FeatureProjectFaviconCacheValue: Equatable, Sendable {
    let data: Data?
    let revision: String?
    let lastCheckedAt: Date
}

enum FeatureProjectFaviconStoreError: Error, Equatable {
    case invalidDataSize
}

/// Persists the last known project icon independently of the server's signed
/// asset URL. A later missing icon or unreachable environment updates the
/// refresh time but does not discard bytes that were already shown to a user.
actor FeatureProjectFaviconStore {
    private struct Metadata: Codable {
        let key: FeatureProjectFaviconCacheKey
        var revision: String?
        var dataFileName: String?
        var lastCheckedAt: Date
    }

    private struct Document: Codable {
        var version = 1
        var entries: [String: Metadata]
    }

    static let maximumEntryCount = 256
    static let maximumDataSize = 1 * 1_024 * 1_024

    let directoryURL: URL
    private let fileManager: FileManager
    private var cachedDocument: Document?

    init(directoryURL: URL? = nil, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        if let directoryURL {
            self.directoryURL = directoryURL
        } else {
            let root = fileManager.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first!
            self.directoryURL = root
                .appendingPathComponent("T3CodeSwift", isDirectory: true)
                .appendingPathComponent("project-favicons", isDirectory: true)
        }
    }

    func value(for key: FeatureProjectFaviconCacheKey) throws
        -> FeatureProjectFaviconCacheValue?
    {
        let document = try loadDocument()
        guard let metadata = document.entries[key.fingerprint], metadata.key == key else {
            return nil
        }
        let data = metadata.dataFileName.flatMap { fileName in
            try? Data(contentsOf: directoryURL.appendingPathComponent(fileName))
        }
        return FeatureProjectFaviconCacheValue(
            data: data,
            revision: metadata.revision,
            lastCheckedAt: metadata.lastCheckedAt
        )
    }

    /// Records a refresh attempt. Passing no data preserves the last known
    /// icon, including when the server no longer has an icon for the project.
    func record(
        data: Data?,
        revision: String?,
        for key: FeatureProjectFaviconCacheKey,
        checkedAt: Date = .now
    ) throws {
        if let data, data.isEmpty || data.count > Self.maximumDataSize {
            throw FeatureProjectFaviconStoreError.invalidDataSize
        }

        try fileManager.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true
        )
        var document = try loadDocument()
        let fingerprint = key.fingerprint
        var metadata = document.entries[fingerprint] ?? Metadata(
            key: key,
            revision: nil,
            dataFileName: nil,
            lastCheckedAt: checkedAt
        )

        if let data {
            let fileName = "\(fingerprint).icon"
            try data.write(
                to: directoryURL.appendingPathComponent(fileName),
                options: .atomic
            )
            metadata.dataFileName = fileName
            metadata.revision = revision
        }
        metadata.lastCheckedAt = checkedAt
        document.entries[fingerprint] = metadata
        try prune(&document)
        try persist(document)
    }

    private var manifestURL: URL {
        directoryURL.appendingPathComponent("manifest.json")
    }

    private func loadDocument() throws -> Document {
        if let cachedDocument { return cachedDocument }
        guard fileManager.fileExists(atPath: manifestURL.path) else {
            let document = Document(entries: [:])
            cachedDocument = document
            return document
        }
        do {
            let document = try JSONDecoder.t3.decode(
                Document.self,
                from: Data(contentsOf: manifestURL)
            )
            guard document.version == 1 else { throw CocoaError(.fileReadCorruptFile) }
            cachedDocument = document
            return document
        } catch {
            // A disposable cache must recover without blocking the home screen.
            let document = Document(entries: [:])
            cachedDocument = document
            return document
        }
    }

    private func persist(_ document: Document) throws {
        try fileManager.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true
        )
        try JSONEncoder.t3.encode(document).write(to: manifestURL, options: .atomic)
        cachedDocument = document
    }

    private func prune(_ document: inout Document) throws {
        guard document.entries.count > Self.maximumEntryCount else { return }
        let removed = document.entries
            .sorted { $0.value.lastCheckedAt > $1.value.lastCheckedAt }
            .dropFirst(Self.maximumEntryCount)
        for (fingerprint, metadata) in removed {
            document.entries.removeValue(forKey: fingerprint)
            if let dataFileName = metadata.dataFileName {
                try? fileManager.removeItem(
                    at: directoryURL.appendingPathComponent(dataFileName)
                )
            }
        }
    }
}
