import Foundation

extension NativeFeatureClient: FeatureCommandOutputStreaming {
    func commandOutput(threadID: String, source: OrchestrationV2TimelineMetadata)
        async throws -> AsyncThrowingStream<CommandOutputFrame, Error>? {
        let route = try await v2ActionContext(threadID: threadID)
        guard try await route.client.serverConfig().environment?.capabilities.commandOutputStreaming == true else {
            return nil
        }
        try Task.checkCancellation()
        // Inherited items retain their source identity within the selected environment.
        return await route.client.commandOutput(threadID: source.sourceThreadID, itemID: source.itemID)
    }
}
