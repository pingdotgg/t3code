import Foundation

struct T3IncomingShareImage: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var fileName: String
    var typeIdentifier: String
    var relativePath: String
    var byteCount: Int
}

struct T3IncomingShareVideo: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var fileName: String
    var typeIdentifier: String
    var relativePath: String
    var byteCount: Int
}

struct T3IncomingShareDestination: Codable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable {
        case newThread
        case existingThread
    }

    var kind: Kind
    var environmentID: String?
    var threadID: String?

    static let newThread = T3IncomingShareDestination(
        kind: .newThread,
        environmentID: nil,
        threadID: nil
    )

    static func existingThread(
        environmentID: String?,
        threadID: String
    ) -> T3IncomingShareDestination {
        T3IncomingShareDestination(
            kind: .existingThread,
            environmentID: environmentID,
            threadID: threadID
        )
    }
}

struct T3IncomingShareEnvelope: Codable, Hashable, Identifiable, Sendable {
    static let schemaVersion = 2
    static let supportedSchemaVersions = 1...schemaVersion

    var schemaVersion: Int
    var id: String
    var createdAt: Date
    var text: String
    var images: [T3IncomingShareImage]
    var videos: [T3IncomingShareVideo]
    var destination: T3IncomingShareDestination?
    var warnings: [String]

    init(
        schemaVersion: Int = Self.schemaVersion,
        id: String,
        createdAt: Date,
        text: String,
        images: [T3IncomingShareImage],
        videos: [T3IncomingShareVideo] = [],
        destination: T3IncomingShareDestination? = nil,
        warnings: [String]
    ) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.createdAt = createdAt
        self.text = text
        self.images = images
        self.videos = videos
        self.destination = destination
        self.warnings = warnings
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case id
        case createdAt
        case text
        case images
        case videos
        case destination
        case warnings
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        id = try container.decode(String.self, forKey: .id)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        text = try container.decode(String.self, forKey: .text)
        images = try container.decodeIfPresent([T3IncomingShareImage].self, forKey: .images) ?? []
        videos = try container.decodeIfPresent([T3IncomingShareVideo].self, forKey: .videos) ?? []
        destination = try container.decodeIfPresent(
            T3IncomingShareDestination.self,
            forKey: .destination
        )
        warnings = try container.decodeIfPresent([String].self, forKey: .warnings) ?? []
    }
}

struct T3PendingShareImage: Sendable {
    var stagedFileURL: URL
    var byteCount: Int
    var suggestedName: String?
    var typeIdentifier: String
}

struct T3PendingShareVideo: Sendable {
    var stagedFileURL: URL
    var byteCount: Int
    var suggestedName: String?
    var typeIdentifier: String
}

struct T3SharedRecentThreadRecord: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let environmentID: String?
    let wireID: String
    let title: String
    let environmentName: String?
    let updatedAt: Date
}

enum T3SharedAppearance: String, Codable, Equatable, Sendable {
    case system
    case light
    case dark
}

final class T3SharedAppearanceStore: @unchecked Sendable {
    static let shared = T3SharedAppearanceStore()

    private let defaults: UserDefaults?
    private let key: String
    private let lock = NSLock()

    init(
        defaults: UserDefaults? = UserDefaults(suiteName: T3SharedContainer.appGroupID),
        key: String = "swift-ios.shared-appearance.v1"
    ) {
        self.defaults = defaults
        self.key = key
    }

    func update(_ appearance: T3SharedAppearance) {
        lock.withLock {
            defaults?.set(appearance.rawValue, forKey: key)
        }
    }

    func appearance() -> T3SharedAppearance {
        lock.withLock {
            guard let rawValue = defaults?.string(forKey: key) else { return .system }
            return T3SharedAppearance(rawValue: rawValue) ?? .system
        }
    }
}

final class T3SharedRecentThreadStore: @unchecked Sendable {
    static let shared = T3SharedRecentThreadStore()
    static let maximumCount = 100

    private let defaults: UserDefaults?
    private let key: String
    private let lock = NSLock()

    init(
        defaults: UserDefaults? = UserDefaults(suiteName: T3SharedContainer.appGroupID),
        key: String = "swift-ios.shared-recent-threads.v1"
    ) {
        self.defaults = defaults
        self.key = key
    }

    func update(_ records: [T3SharedRecentThreadRecord]) {
        lock.withLock {
            defaults?.set(try? JSONEncoder().encode(records), forKey: key)
        }
    }

    func records() -> [T3SharedRecentThreadRecord] {
        lock.withLock {
            guard let data = defaults?.data(forKey: key) else { return [] }
            return (try? JSONDecoder().decode([T3SharedRecentThreadRecord].self, from: data)) ?? []
        }
    }
}

enum T3IncomingShareStoreError: LocalizedError {
    case appGroupUnavailable
    case noSupportedContent

    var errorDescription: String? {
        switch self {
        case .appGroupUnavailable:
            "This build of T3 Code does not have access to its shared inbox. Install an App Group-enabled build and try again."
        case .noSupportedContent:
            "This app did not provide text, a URL, or supported media."
        }
    }
}

/// A crash-safe handoff from the short-lived share extension to the host app.
/// Each share gets its own UUID directory and an atomically-written manifest.
enum T3IncomingShareStore {
    static let inboxRelativePath = "Library/Application Support/T3Code/IncomingShares"
    static let manifestFileName = "manifest.json"
    static let maximumAttachmentCount = 8
    static let maximumImageCount = 8
    static let maximumImageBytes = 10 * 1_024 * 1_024
    static let maximumVideoCount = 1
    static let maximumVideoBytes = 250 * 1_024 * 1_024

    static func write(
        textFragments: [String],
        images: [T3PendingShareImage],
        videos: [T3PendingShareVideo] = [],
        destination: T3IncomingShareDestination? = nil,
        warnings initialWarnings: [String] = [],
        now: Date = Date(),
        id: String = UUID().uuidString.lowercased()
    ) throws -> T3IncomingShareEnvelope {
        guard let containerURL = T3SharedContainer.rootURL else {
            throw T3IncomingShareStoreError.appGroupUnavailable
        }
        defer {
            for image in images {
                try? FileManager.default.removeItem(at: image.stagedFileURL)
            }
            for video in videos {
                try? FileManager.default.removeItem(at: video.stagedFileURL)
            }
        }

        let normalizedText = deduplicatedText(textFragments)
        let itemDirectory = containerURL
            .appending(path: inboxRelativePath, directoryHint: .isDirectory)
            .appending(path: id, directoryHint: .isDirectory)
        var warnings = initialWarnings
        var savedImages: [T3IncomingShareImage] = []
        var savedVideos: [T3IncomingShareVideo] = []
        var validOverflowCount = 0

        do {
            try FileManager.default.createDirectory(
                at: itemDirectory,
                withIntermediateDirectories: true
            )

            for image in images {
                let values = try? image.stagedFileURL.resourceValues(forKeys: [
                    .fileSizeKey,
                    .isRegularFileKey,
                ])
                guard values?.isRegularFile == true,
                      let byteCount = values?.fileSize,
                      byteCount > 0,
                      byteCount <= maximumImageBytes,
                      byteCount == image.byteCount else {
                    warnings.append("One shared image exceeded the 10 MB attachment limit.")
                    continue
                }
                guard savedImages.count < maximumImageCount else {
                    validOverflowCount += 1
                    continue
                }

                let attachmentID = UUID().uuidString.lowercased()
                let fileName = safeFileName(
                    image.suggestedName,
                    fallback: "shared-image-\(savedImages.count + 1).\(fileExtension(for: image.typeIdentifier))"
                )
                let storedName = "\(attachmentID)-\(fileName)"
                let fileURL = itemDirectory.appending(path: storedName, directoryHint: .notDirectory)
                try FileManager.default.copyItem(at: image.stagedFileURL, to: fileURL)
                savedImages.append(
                    T3IncomingShareImage(
                        id: attachmentID,
                        fileName: fileName,
                        typeIdentifier: image.typeIdentifier,
                        relativePath: "\(inboxRelativePath)/\(id)/\(storedName)",
                        byteCount: byteCount
                    )
                )
            }

            for video in videos {
                let values = try? video.stagedFileURL.resourceValues(forKeys: [
                    .fileSizeKey,
                    .isRegularFileKey,
                ])
                guard values?.isRegularFile == true,
                      let byteCount = values?.fileSize,
                      byteCount > 0,
                      byteCount <= maximumVideoBytes,
                      byteCount == video.byteCount else {
                    warnings.append("One shared video exceeded the 250 MB import limit.")
                    continue
                }
                guard savedVideos.count < maximumVideoCount,
                      savedImages.count + savedVideos.count < maximumAttachmentCount else {
                    validOverflowCount += 1
                    continue
                }

                let attachmentID = UUID().uuidString.lowercased()
                let fileName = safeFileName(
                    video.suggestedName,
                    fallback: "shared-video-\(savedVideos.count + 1).\(fileExtension(for: video.typeIdentifier))"
                )
                let storedName = "\(attachmentID)-\(fileName)"
                let fileURL = itemDirectory.appending(path: storedName, directoryHint: .notDirectory)
                try FileManager.default.copyItem(at: video.stagedFileURL, to: fileURL)
                savedVideos.append(
                    T3IncomingShareVideo(
                        id: attachmentID,
                        fileName: fileName,
                        typeIdentifier: video.typeIdentifier,
                        relativePath: "\(inboxRelativePath)/\(id)/\(storedName)",
                        byteCount: byteCount
                    )
                )
            }

            if validOverflowCount > 0 {
                warnings.append("Only the first \(maximumAttachmentCount) shared media items were kept.")
            }

            guard !normalizedText.isEmpty || !savedImages.isEmpty || !savedVideos.isEmpty else {
                throw T3IncomingShareStoreError.noSupportedContent
            }

            let envelope = T3IncomingShareEnvelope(
                schemaVersion: T3IncomingShareEnvelope.schemaVersion,
                id: id,
                createdAt: now,
                text: normalizedText,
                images: savedImages,
                videos: savedVideos,
                destination: destination,
                warnings: warnings
            )
            let manifestURL = itemDirectory.appending(
                path: manifestFileName,
                directoryHint: .notDirectory
            )
            try encoder.encode(envelope).write(to: manifestURL, options: .atomic)
            return envelope
        } catch {
            try? FileManager.default.removeItem(at: itemDirectory)
            throw error
        }
    }

    static func loadAll() -> [T3IncomingShareEnvelope] {
        guard let containerURL = T3SharedContainer.rootURL else { return [] }
        let inboxURL = containerURL.appending(path: inboxRelativePath, directoryHint: .isDirectory)
        guard let directories = try? FileManager.default.contentsOfDirectory(
            at: inboxURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        return directories.compactMap { directory in
            let manifestURL = directory.appending(path: manifestFileName, directoryHint: .notDirectory)
            guard let data = try? Data(contentsOf: manifestURL) else { return nil }
            return try? decoder.decode(T3IncomingShareEnvelope.self, from: data)
        }
        .filter { T3IncomingShareEnvelope.supportedSchemaVersions.contains($0.schemaVersion) }
        .sorted { $0.createdAt < $1.createdAt }
    }

    static func remove(id: String) throws {
        guard let containerURL = T3SharedContainer.rootURL else {
            throw T3IncomingShareStoreError.appGroupUnavailable
        }
        guard UUID(uuidString: id) != nil else {
            throw T3IncomingShareStoreError.noSupportedContent
        }
        let inboxURL = containerURL
            .appending(path: inboxRelativePath, directoryHint: .isDirectory)
            .standardizedFileURL
        let itemURL = inboxURL
            .appending(path: id, directoryHint: .isDirectory)
            .standardizedFileURL
        guard itemURL.deletingLastPathComponent() == inboxURL else {
            throw T3IncomingShareStoreError.noSupportedContent
        }
        guard FileManager.default.fileExists(atPath: itemURL.path) else { return }
        try FileManager.default.removeItem(at: itemURL)
    }

    static func fileURL(for image: T3IncomingShareImage) -> URL? {
        fileURL(relativePath: image.relativePath)
    }

    static func fileURL(for video: T3IncomingShareVideo) -> URL? {
        fileURL(relativePath: video.relativePath)
    }

    static func hostAppURL(for envelopeID: String) -> URL? {
        guard UUID(uuidString: envelopeID) != nil else { return nil }
        var components = URLComponents()
        components.scheme = T3SharedContainer.urlScheme
        components.host = "share"
        components.queryItems = [URLQueryItem(name: "id", value: envelopeID)]
        return components.url
    }

    private static func fileURL(relativePath: String) -> URL? {
        guard let root = T3SharedContainer.rootURL?.standardizedFileURL else { return nil }
        let inbox = root.appending(path: inboxRelativePath, directoryHint: .isDirectory)
            .standardizedFileURL
        let url = root.appending(path: relativePath, directoryHint: .notDirectory)
            .standardizedFileURL
        guard url.path.hasPrefix(inbox.path + "/") else { return nil }
        return url
    }

    private static func deduplicatedText(_ fragments: [String]) -> String {
        var seen: Set<String> = []
        return fragments.compactMap { fragment in
            let value = fragment.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, seen.insert(value).inserted else { return nil }
            return value
        }.joined(separator: "\n\n")
    }

    private static func safeFileName(_ proposed: String?, fallback: String) -> String {
        let candidate = proposed?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let lastPathComponent = URL(fileURLWithPath: candidate).lastPathComponent
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ".-_ "))
        let sanitized = String(lastPathComponent.unicodeScalars.filter(allowed.contains)).prefix(96)
        return sanitized.isEmpty ? fallback : String(sanitized)
    }

    private static func fileExtension(for typeIdentifier: String) -> String {
        switch typeIdentifier.lowercased() {
        case "public.jpeg", "public.jpg", "image/jpeg": "jpg"
        case "public.heic", "image/heic": "heic"
        case "public.webp", "image/webp": "webp"
        case "com.compuserve.gif", "image/gif": "gif"
        case "public.mpeg-4", "video/mp4": "mp4"
        case "com.apple.quicktime-movie", "video/quicktime": "mov"
        case "public.movie": "mov"
        case "public.mpeg", "video/mpeg": "mpeg"
        default: "png"
        }
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
