import Foundation

/// Visible attachment rows resolve their own URLs. Opening a thread does not
/// request signed URLs for images that are still outside the viewport.
@MainActor
public protocol FeatureAttachmentAssetResolving: AnyObject {
    func attachmentAssetURL(
        threadID: String,
        attachment: FeatureMessageAttachment
    ) async throws -> URL
}

struct FeatureAttachmentContext: Equatable {
    let threadID: String
    let resolver: any FeatureAttachmentAssetResolving

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.threadID == rhs.threadID && lhs.resolver === rhs.resolver
    }
}
