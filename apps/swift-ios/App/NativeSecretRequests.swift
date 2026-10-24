import Foundation

extension NativeFeatureClient: FeatureSecretRequestAnswering {
    public func answerSecretRequest(threadID: String, source: OrchestrationV2TimelineMetadata, answer: SecretRequestAnswer) async throws {
        do {
            let context = try await v2ActionContext(threadID: threadID)
            guard source.itemType == "secret_request", source.visibility == "local",
                  source.sourceThreadID == context.wireID else { throw RPCError.disconnected }
            try await requireScope("orchestration:operate", client: context.client)
            try await context.client.answerSecretRequest(threadID: context.wireID, turnItemID: source.itemID, answer: answer)
        } catch {
            throw SecretRequestSafeError(error)
        }
    }
}
