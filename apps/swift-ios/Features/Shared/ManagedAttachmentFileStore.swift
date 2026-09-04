import Foundation

public struct FeatureUploadedAttachmentReference: Sendable, Equatable, Codable {
    public var environmentID: String
    public var attachmentID: String

    public init(environmentID: String, attachmentID: String) {
        self.environmentID = environmentID
        self.attachmentID = attachmentID
    }
}

public struct FeatureOwnedAttachmentFile: Sendable, Equatable {
    public let fileName: String
    public let url: URL
    public let byteCount: Int

    public init(fileName: String, url: URL, byteCount: Int) {
        self.fileName = fileName
        self.url = url
        self.byteCount = byteCount
    }
}

public enum ManagedAttachmentFileError: LocalizedError, Equatable, Sendable {
    case invalidSource
    case invalidFileName
    case empty
    case tooLarge(actualBytes: Int, maximumBytes: Int)
    case alreadyExists

    public var errorDescription: String? {
        switch self {
        case .invalidSource:
            "The selected attachment is not a local file."
        case .invalidFileName:
            "The attachment file name is invalid."
        case .empty:
            "The selected attachment is empty."
        case let .tooLarge(actualBytes, maximumBytes):
            "The attachment is \(actualBytes) bytes. T3 accepts up to \(maximumBytes) bytes."
        case .alreadyExists:
            "An owned attachment already exists for this ID."
        }
    }
}

/// Owns copies of provider files so drafts and outbox entries do not depend on
/// temporary document-picker URLs. It never removes the provider-owned source.
public struct ManagedAttachmentFileStore: Sendable {
    public static let maximumBytes = 50 * 1024 * 1024
    private static let chunkBytes = 256 * 1024

    public let rootURL: URL

    public init(rootURL: URL? = nil) {
        if let rootURL {
            self.rootURL = rootURL.standardizedFileURL
        } else {
            let applicationSupport = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first!
            self.rootURL = applicationSupport
                .appendingPathComponent("T3CodeSwift", isDirectory: true)
                .appendingPathComponent("attachments", isDirectory: true)
                .standardizedFileURL
        }
    }

    public func copyOwnedFile(
        from sourceURL: URL,
        attachmentID: UUID,
        originalFileName: String,
        maximumBytes: Int = Self.maximumBytes
    ) throws -> FeatureOwnedAttachmentFile {
        guard sourceURL.isFileURL else { throw ManagedAttachmentFileError.invalidSource }
        let effectiveMaximumBytes = min(Self.maximumBytes, max(0, maximumBytes))
        let fileName = try Self.ownedFileName(
            attachmentID: attachmentID,
            originalFileName: originalFileName
        )
        let destination = try resolvedFile(fileName: fileName, byteCount: 0).url
        try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
        guard !FileManager.default.fileExists(atPath: destination.path) else {
            throw ManagedAttachmentFileError.alreadyExists
        }

        let hasSecurityAccess = sourceURL.startAccessingSecurityScopedResource()
        defer {
            if hasSecurityAccess { sourceURL.stopAccessingSecurityScopedResource() }
        }

        let source = try FileHandle(forReadingFrom: sourceURL)
        defer { try? source.close() }
        guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        let output = try FileHandle(forWritingTo: destination)
        var copiedBytes = 0
        var completed = false
        defer {
            try? output.close()
            if !completed { try? FileManager.default.removeItem(at: destination) }
        }

        while let chunk = try source.read(upToCount: Self.chunkBytes), !chunk.isEmpty {
            copiedBytes += chunk.count
            guard copiedBytes <= effectiveMaximumBytes else {
                throw ManagedAttachmentFileError.tooLarge(
                    actualBytes: copiedBytes,
                    maximumBytes: effectiveMaximumBytes
                )
            }
            try output.write(contentsOf: chunk)
        }
        guard copiedBytes > 0 else { throw ManagedAttachmentFileError.empty }
        completed = true
        return FeatureOwnedAttachmentFile(
            fileName: fileName,
            url: destination,
            byteCount: copiedBytes
        )
    }

    public func resolvedFile(fileName: String, byteCount: Int) throws
        -> FeatureOwnedAttachmentFile
    {
        guard Self.isValidOwnedFileName(fileName) else {
            throw ManagedAttachmentFileError.invalidFileName
        }
        let url = rootURL.appendingPathComponent(fileName, isDirectory: false).standardizedFileURL
        guard url.deletingLastPathComponent() == rootURL else {
            throw ManagedAttachmentFileError.invalidFileName
        }
        return FeatureOwnedAttachmentFile(fileName: fileName, url: url, byteCount: byteCount)
    }

    /// Removes one known owned file. Callers must coordinate ownership before
    /// they use this helper because drafts and outbox entries can share a file.
    public func removeOwnedFile(fileName: String) throws {
        let file = try resolvedFile(fileName: fileName, byteCount: 0)
        guard FileManager.default.fileExists(atPath: file.url.path) else { return }
        try FileManager.default.removeItem(at: file.url)
    }

    private static func ownedFileName(
        attachmentID: UUID,
        originalFileName: String
    ) throws -> String {
        let pathExtension = URL(fileURLWithPath: originalFileName).pathExtension.lowercased()
        let safeExtension = pathExtension.filter {
            $0.isASCII && ($0.isLetter || $0.isNumber)
        }
        guard safeExtension.count <= 16 else { throw ManagedAttachmentFileError.invalidFileName }
        return safeExtension.isEmpty
            ? attachmentID.uuidString
            : "\(attachmentID.uuidString).\(safeExtension)"
    }

    private static func isValidOwnedFileName(_ fileName: String) -> Bool {
        guard fileName == URL(fileURLWithPath: fileName).lastPathComponent else { return false }
        let url = URL(fileURLWithPath: fileName)
        guard UUID(uuidString: url.deletingPathExtension().lastPathComponent) != nil else {
            return false
        }
        let pathExtension = url.pathExtension
        return pathExtension.count <= 16
            && pathExtension.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
    }
}
