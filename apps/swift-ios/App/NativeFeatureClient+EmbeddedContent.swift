import Foundation

extension NativeFeatureClient: FeatureEmbeddedContentClient {
    func embeddedAsset(threadID: String, resource: AssetResource) async throws -> ResolvedAssetURL {
        let context = try await v2ActionContext(threadID: threadID)
        return try await context.client.resolvedAsset(resource: resource)
    }

    func embeddedItem(threadID: String, source: OrchestrationV2TimelineMetadata) async throws -> JSONValue {
        let context = try await v2ActionContext(threadID: threadID)
        guard let item = try await context.client.orchestrationTurnItem(
            threadID: source.sourceThreadID, itemID: source.itemID, revision: source.detailRevision
        ) else { throw RPCError.protocolViolation("App tool result is unavailable") }
        return item.raw
    }

    func embeddedRequest(threadID: String, source: OrchestrationV2TimelineMetadata,
                         operation: FeatureMCPOperation, payload: JSONValue) async throws -> JSONValue {
        let context = try await v2ActionContext(threadID: threadID)
        return try await context.client.mcpAppRequest(operation: operation,
            sourceThreadID: source.sourceThreadID, itemID: source.itemID,
            conversationThreadID: context.wireID, payload: payload)
    }
}
