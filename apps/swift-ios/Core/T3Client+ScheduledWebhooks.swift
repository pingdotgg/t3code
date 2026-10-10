import Foundation

extension T3Client {
    public func rotateScheduledTaskWebhookToken(id: String) async throws -> ScheduledTask {
        let result = try await rpc.request("scheduledTasks.rotateWebhookToken",
            payload: .object(["id": .string(id)]), as: ScheduledTaskMutationResult.self)
        return result.task
    }
}
