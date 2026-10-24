import Foundation

extension NativeFeatureClient: FeatureThreadVisiting {
    func visitThread(threadID: String, visitedAt: String) async throws {
        let context = try await v2ActionContext(threadID: threadID)
        try Task.checkCancellation()
        _ = try await context.client.dispatch(.object([
            "type": .string("thread.visit"),
            "commandId": .string(UUID().uuidString),
            "threadId": .string(context.wireID),
            "visitedAt": .string(visitedAt),
        ]))
    }
}
