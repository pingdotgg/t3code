import Foundation

struct T3IncomingShareImage: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var fileName: String
    var typeIdentifier: String
    var relativePath: String
    var byteCount: Int
}

struct T3IncomingShareEnvelope: Codable, Hashable, Identifiable, Sendable {
    static let schemaVersion = 1

    var schemaVersion: Int
    var id: String
    var createdAt: Date
    var text: String
    var images: [T3IncomingShareImage]
    var warnings: [String]
}

struct T3PendingShareImage: Sendable {
    var stagedFileURL: URL
    var byteCount: Int
    var suggestedName: String?
    var typeIdentifier: String
}

enum T3IncomingShareStoreError: LocalizedError {
    case appGroupUnavailable
    case noSupportedContent

    var errorDescription: String? {
        switch self {
        case .appGroupUnavailable:
            "T3 Code could not access its shared inbox."
        case .noSupportedContent:
            "This app did not provide text, a URL, or a supported image."
        }
    }
}

/// A crash-safe handoff from the short-lived share extension to the host app.
/// Each share gets its own UUID directory and an atomically-written manifest.
enum T3IncomingShareStore {
    static let inboxRelativePath = "Library/Application Support/T3Code/IncomingShares"
    static let manifestFileName = "manifest.json"
    static let maximumImageCount = 8
    static let maximumImageBytes = 10 * 1_024 * 1_024

    static func write(
        textFragments: [String],
        images: [T3PendingShareImage],
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
        }

        let normalizedText = deduplicatedText(textFragments)
        let itemDirectory = containerURL
            .appending(path: inboxRelativePath, directoryHint: .isDirectory)
            .appending(path: id, directoryHint: .isDirectory)
        var warnings = initialWarnings
        var savedImages: [T3IncomingShareImage] = []
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

            if validOverflowCount > 0 {
                warnings.append("Only the first \(maximumImageCount) shared images were attached.")
            }

            guard !normalizedText.isEmpty || !savedImages.isEmpty else {
                throw T3IncomingShareStoreError.noSupportedContent
            }

            let envelope = T3IncomingShareEnvelope(
                schemaVersion: T3IncomingShareEnvelope.schemaVersion,
                id: id,
                createdAt: now,
                text: normalizedText,
                images: savedImages,
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
        .filter { $0.schemaVersion == T3IncomingShareEnvelope.schemaVersion }
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
        guard let root = T3SharedContainer.rootURL?.standardizedFileURL else { return nil }
        let inbox = root.appending(path: inboxRelativePath, directoryHint: .isDirectory)
            .standardizedFileURL
        let url = root.appending(path: image.relativePath, directoryHint: .notDirectory)
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
