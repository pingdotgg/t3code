import Foundation

public enum ImageAttachmentError: LocalizedError, Equatable, Sendable {
    case empty
    case tooLarge(actualBytes: Int, maximumBytes: Int)
    case invalidName
    case invalidMIMEType

    public var errorDescription: String? {
        switch self {
        case .empty: "The selected image is empty."
        case let .tooLarge(actualBytes, maximumBytes):
            "The image is \(actualBytes) bytes. T3 accepts up to \(maximumBytes) bytes."
        case .invalidName: "The image needs a valid file name."
        case .invalidMIMEType: "The selected file is not a supported image."
        }
    }
}

public enum FileAttachmentError: LocalizedError, Equatable, Sendable {
    case empty
    case tooLarge(actualBytes: Int, maximumBytes: Int)
    case invalidName
    case invalidMIMEType
    case invalidFileURL
    case unsupported
    case tooMany(maximum: Int)

    public var errorDescription: String? {
        switch self {
        case .empty: "The selected file is empty."
        case let .tooLarge(actualBytes, maximumBytes):
            "The file is \(actualBytes) bytes. T3 accepts up to \(maximumBytes) bytes."
        case .invalidName: "The file needs a valid name."
        case .invalidMIMEType: "The file needs a valid MIME type."
        case .invalidFileURL: "The attachment file is no longer available."
        case .unsupported: "This environment does not support file attachments."
        case let .tooMany(maximum): "You can attach up to \(maximum) files per message."
        }
    }
}

public struct UploadedAttachmentReference: Codable, Equatable, Sendable {
    public let environmentID: String
    public let attachmentID: String

    public init(environmentID: String, attachmentID: String) {
        self.environmentID = environmentID
        self.attachmentID = attachmentID
    }
}

/// A validated turn attachment. Images can remain inline for older servers.
/// Generic files always stay file-backed and require the upload capability.
public struct UploadChatAttachment: Equatable, Sendable {
    public static let maximumBytes = 10 * 1024 * 1024
    public static let maximumFileBytes = 50 * 1024 * 1024

    enum Source: Equatable, Sendable {
        case imageData(Data)
        case file(URL)
    }

    public let id: UUID
    public let type: String
    public let name: String
    public let mimeType: String
    public let sizeBytes: Int
    public let uploadedReference: UploadedAttachmentReference?
    let source: Source

    public init(
        id: UUID = UUID(),
        data: Data,
        name: String,
        mimeType: String,
        uploadedReference: UploadedAttachmentReference? = nil
    ) throws {
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
        self.id = id
        type = "image"
        self.name = normalizedName
        self.mimeType = normalizedMIME
        sizeBytes = data.count
        self.uploadedReference = uploadedReference
        source = .imageData(data)
    }

    public init(
        id: UUID = UUID(),
        fileURL: URL,
        name: String,
        mimeType: String,
        sizeBytes: Int,
        uploadedReference: UploadedAttachmentReference? = nil
    ) throws {
        guard fileURL.isFileURL else { throw FileAttachmentError.invalidFileURL }
        guard sizeBytes > 0 else { throw FileAttachmentError.empty }
        guard sizeBytes <= Self.maximumFileBytes else {
            throw FileAttachmentError.tooLarge(
                actualBytes: sizeBytes,
                maximumBytes: Self.maximumFileBytes
            )
        }
        let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedName.isEmpty, normalizedName.count <= 255 else {
            throw FileAttachmentError.invalidName
        }
        let normalizedMIME = mimeType.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalizedMIME.isEmpty, normalizedMIME.count <= 100,
              !normalizedMIME.contains(where: { $0.isWhitespace || $0.isNewline }) else {
            throw FileAttachmentError.invalidMIMEType
        }
        self.id = id
        type = "file"
        self.name = normalizedName
        self.mimeType = normalizedMIME
        self.sizeBytes = sizeBytes
        self.uploadedReference = uploadedReference
        source = .file(fileURL)
    }

    var jsonValue: JSONValue {
        var value: [String: JSONValue] = [
            "type": .string(type),
            "name": .string(name),
            "mimeType": .string(mimeType),
            "sizeBytes": .number(Double(sizeBytes)),
        ]
        if case let .imageData(data) = source {
            value["dataUrl"] = .string(
                "data:\(mimeType);base64,\(data.base64EncodedString())"
            )
        }
        return .object(value)
    }

    func uploadedJSONValue(id: String) -> JSONValue {
        .object([
            "type": .string(type),
            "id": .string(id),
            "name": .string(name),
            "mimeType": .string(mimeType),
            "sizeBytes": .number(Double(sizeBytes)),
        ])
    }
}

/// Keeps the existing image API and call sites source-compatible.
public typealias UploadChatImageAttachment = UploadChatAttachment

public struct AttachmentCreateUploadURLResult: Codable, Equatable, Sendable {
    public let attachmentId: String
    public let relativeUrl: String
    public let expiresAt: Double
}

public enum AssetResource: Equatable, Sendable {
    case workspaceFile(threadID: String, path: String)
    case mediaFile(threadID: String, path: String)
    case attachment(id: String, fileName: String? = nil, mimeType: String? = nil)
    case projectFavicon(cwd: String)
    case nativeAppIcon(ToolNativeAppReference)

    var jsonValue: JSONValue {
        switch self {
        case let .nativeAppIcon(app):
            var reference: [String: JSONValue] = ["_tag": .string(app._tag)]
            if let id = app.appId { reference["appId"] = .string(id) }
            if let name = app.displayName { reference["displayName"] = .string(name) }
            return .object(["_tag": .string("native-app-icon"), "app": .object(reference)])
        case let .workspaceFile(threadID, path):
            return .object([
                "_tag": .string("workspace-file"),
                "threadId": .string(threadID),
                "path": .string(path),
            ])
        case let .mediaFile(threadID, path):
            return .object([
                "_tag": .string("media-file"),
                "threadId": .string(threadID),
                "path": .string(path),
            ])
        case let .attachment(id, fileName, mimeType):
            var value: [String: JSONValue] = [
                "_tag": .string("attachment"),
                "attachmentId": .string(id),
            ]
            if let fileName { value["fileName"] = .string(fileName) }
            if let mimeType { value["mimeType"] = .string(mimeType) }
            return .object(value)
        case let .projectFavicon(cwd):
            return .object([
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
