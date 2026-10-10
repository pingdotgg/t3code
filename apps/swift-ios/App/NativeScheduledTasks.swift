import Foundation

extension NativeFeatureClient: FeatureScheduledTaskManaging {
    func listScheduledTasks(environmentID: String) async throws -> [ScheduledTask] {
        let client = try await environmentServiceClient(environmentID: environmentID)
        do {
            return try await client.listScheduledTasks().tasks
        } catch {
            if FeatureScheduledTaskError.isUnsupportedRPC(error, method: "scheduledTasks.list") {
                throw FeatureScheduledTaskError.unsupported
            }
            throw error
        }
    }

    func scheduledTaskUpdates(environmentID: String) -> AsyncThrowingStream<FeatureScheduledTaskSnapshot, Error> {
        // Each event is a complete list, so a slow consumer only needs the latest one.
        AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task { @MainActor in
                do {
                    let client = try await self.environmentServiceClient(environmentID: environmentID)
                    do {
                        for try await result in await client.scheduledTaskUpdates() {
                            try Task.checkCancellation()
                            continuation.yield(.init(tasks: result.tasks, receivesLiveUpdates: true))
                        }
                    } catch {
                        guard FeatureScheduledTaskError.isUnsupportedRPC(error, method: "scheduledTasks.subscribe") else {
                            throw error
                        }
                        // Hosts with only the list endpoint still support management and manual refresh.
                        let tasks = try await self.listScheduledTasks(environmentID: environmentID)
                        try Task.checkCancellation()
                        continuation.yield(.init(tasks: tasks, receivesLiveUpdates: false))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func upsertScheduledTask(environmentID: String, input: ScheduledTaskUpsertInput) async throws -> ScheduledTask {
        let client = try await environmentServiceClient(environmentID: environmentID)
        try await requireScope("orchestration:operate", client: client)
        return try await client.upsertScheduledTask(input)
    }

    func setScheduledTaskEnabled(_ target: FeatureScheduledTaskTarget, enabled: Bool) async throws -> ScheduledTask {
        let client = try await environmentServiceClient(environmentID: target.environmentID)
        try await requireScope("orchestration:operate", client: client)
        return try await client.setScheduledTaskEnabled(id: target.taskID, enabled: enabled)
    }

    func runScheduledTaskNow(_ target: FeatureScheduledTaskTarget) async throws -> ScheduledTask {
        let client = try await environmentServiceClient(environmentID: target.environmentID)
        try await requireScope("orchestration:operate", client: client)
        return try await client.runScheduledTaskNow(id: target.taskID)
    }

    func rotateScheduledTaskWebhookToken(_ target: FeatureScheduledTaskTarget) async throws -> ScheduledTask {
        let client = try await environmentServiceClient(environmentID: target.environmentID)
        try await requireScope("orchestration:operate", client: client)
        return try await client.rotateScheduledTaskWebhookToken(id: target.taskID)
    }

    func deleteScheduledTask(_ target: FeatureScheduledTaskTarget) async throws {
        let client = try await environmentServiceClient(environmentID: target.environmentID)
        try await requireScope("orchestration:operate", client: client)
        try await client.deleteScheduledTask(id: target.taskID)
    }
}
