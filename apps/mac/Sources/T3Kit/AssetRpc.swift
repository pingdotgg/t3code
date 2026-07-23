// assets.* RPC family (packages/contracts/src/assets.ts): signed URL minting
// for workspace files, chat attachments, and project favicons.

import Foundation

/// Wire `AssetResource` for chat attachments (`{ _tag: "attachment", attachmentId }`).
public struct AssetAttachmentResource: Encodable, Sendable {
    public let _tag = "attachment"
    public var attachmentId: String

    public init(attachmentId: String) {
        self.attachmentId = attachmentId
    }
}

public struct AssetCreateUrlInput: Encodable, Sendable {
    public var resource: AssetAttachmentResource

    public init(attachmentId: String) {
        self.resource = AssetAttachmentResource(attachmentId: attachmentId)
    }
}

public struct AssetCreateUrlResult: Decodable, Sendable {
    /// Path-absolute URL under the server HTTP root, e.g. `/api/assets/<token>/<name>`.
    public var relativeUrl: String
    /// Epoch milliseconds when the signed URL expires.
    public var expiresAt: Double
}

extension T3Client {
    /// Mints a short-lived HTTP URL for a persisted chat attachment.
    public func createAttachmentAssetURL(attachmentId: String) async throws -> AssetCreateUrlResult {
        try await call("assets.createUrl", AssetCreateUrlInput(attachmentId: attachmentId))
    }
}

/// Resolve a relative asset path against the server's HTTP base.
public func resolveAssetURL(httpBaseURL: URL, relativeUrl: String) -> URL? {
    URL(string: relativeUrl, relativeTo: httpBaseURL)?.absoluteURL
}
