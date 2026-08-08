import Foundation

public enum ImageAttachmentError: LocalizedError, Equatable, Sendable {
    case empty
    case tooLarge(actualBytes: Int, maximumBytes: Int)
    case invalidName
    case invalidMIMEType

    public var errorDescription: String? {
        switch self {
        case .empty:
            "The selected image is empty."
        case let .tooLarge(actualBytes, maximumBytes):
            "The image is \(actualBytes) bytes. T3 accepts up to \(maximumBytes) bytes."
        case .invalidName:
            "The image needs a valid file name."
        case .invalidMIMEType:
            "The selected file is not a supported image."
        }
    }
}

/// Inline upload shape accepted by `thread.turn.start`.
///
/// There is intentionally no standalone attachment-upload endpoint in the T3
/// contract. New image bytes travel as a base64 data URL on the turn command;
/// the server normalizes them into a persisted `ChatAttachment`.
public struct UploadChatImageAttachment: Codable, Equatable, Sendable {
    public static let maximumBytes = 10 * 1024 * 1024

    public let type: String
    public let name: String
    public let mimeType: String
    public let sizeBytes: Int
    public let dataUrl: String

    public init(data: Data, name: String, mimeType: String) throws {
        guard !data.isEmpty else { throw ImageAttachmentError.empty }
        guard data.count <= Self.maximumBytes else {
            throw ImageAttachmentError.tooLarge(
                actualBytes: data.count,
                maximumBytes: Self.maximumBytes
            )
        }
        let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedName.isEmpty, normalizedName.count <= 255 else {
            throw ImageAttachmentError.invalidName
        }
        let normalizedMIME = mimeType.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalizedMIME.hasPrefix("image/"), normalizedMIME.count <= 100 else {
            throw ImageAttachmentError.invalidMIMEType
        }
        type = "image"
        self.name = normalizedName
        self.mimeType = normalizedMIME
        sizeBytes = data.count
        dataUrl = "data:\(normalizedMIME);base64,\(data.base64EncodedString())"
    }

    var jsonValue: JSONValue {
        .object([
            "type": .string(type),
            "name": .string(name),
            "mimeType": .string(mimeType),
            "sizeBytes": .number(Double(sizeBytes)),
            "dataUrl": .string(dataUrl),
        ])
    }
}

public enum AssetResource: Equatable, Sendable {
    case workspaceFile(threadID: String, path: String)
    case attachment(id: String)
    case projectFavicon(cwd: String)

    var jsonValue: JSONValue {
        switch self {
        case let .workspaceFile(threadID, path):
            .object([
                "_tag": .string("workspace-file"),
                "threadId": .string(threadID),
                "path": .string(path),
            ])
        case let .attachment(id):
            .object([
                "_tag": .string("attachment"),
                "attachmentId": .string(id),
            ])
        case let .projectFavicon(cwd):
            .object([
                "_tag": .string("project-favicon"),
                "cwd": .string(cwd),
            ])
        }
    }
}

public struct AssetCreateURLResult: Codable, Equatable, Sendable {
    public let relativeUrl: String
    /// Unix epoch milliseconds from the server contract.
    public let expiresAt: Double
}

public struct ResolvedAssetURL: Equatable, Sendable {
    public let url: URL
    public let expiresAt: Date
}
