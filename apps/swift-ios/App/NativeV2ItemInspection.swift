import Foundation

extension NativeFeatureClient: FeatureV2ItemInspecting {
    public func inspectV2Item(
        threadID: String, source: OrchestrationV2TimelineMetadata
    ) async throws -> OrchestrationV2TurnItem? {
        let context = try await v2ActionContext(threadID: threadID)
        // The source is a wire ID, not a route. Use the selected thread's
        // client so inherited rows cannot switch environments.
        return try await context.client.orchestrationTurnItem(
            threadID: source.sourceThreadID, itemID: source.itemID,
            revision: source.detailRevision
        )
    }
}
