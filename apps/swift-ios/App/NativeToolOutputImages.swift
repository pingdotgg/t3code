import Foundation

extension NativeFeatureClient: FeatureToolOutputImageResolving {
    public func toolOutputImageURL(threadID: String, source: OrchestrationV2TimelineMetadata, index: Int) async throws -> URL {
        guard (0..<FeatureToolOutputImages.maximumCount).contains(index) else {
            throw RPCError.protocolViolation("The tool image index is invalid.")
        }
        let context = try await v2ActionContext(threadID: threadID)
        return try await context.client.resolvedAssetURL(resource: .toolOutputImage(
            threadID: source.sourceThreadID, itemID: source.itemID, index: index
        ))
    }
}
