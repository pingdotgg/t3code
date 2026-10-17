import Foundation

extension NativeFeatureClient: FeatureSubagentStopping {
    func stoppableSubagentIDs(threadID: String) async throws -> Set<String> {
        let route = try await v2ActionContext(threadID: threadID)
        let snapshot = try await route.client.fullThreadSnapshot(id: route.wireID)
        guard let control = snapshot.thread.orchestrationV2Control else { return [] }
        return Set(try FeatureSubagentStopPolicy.targets(projection: control, threadID: route.wireID).keys)
    }

    func stopSubagent(threadID: String, subagentID: String) async throws {
        let route = try await v2ActionContext(threadID: threadID)
        let snapshot = try await route.client.fullThreadSnapshot(id: route.wireID)
        guard let control = snapshot.thread.orchestrationV2Control else {
            throw FeatureCapabilityUnavailable("Individual agent stop")
        }
        let command = try FeatureSubagentStopPolicy.command(
            projection: control, threadID: route.wireID, subagentID: subagentID
        )
        try await requireScope("orchestration:operate", client: route.client)
        let current = try await v2ActionContext(threadID: threadID)
        guard current.client === route.client, current.wireID == route.wireID else { throw RPCError.disconnected }
        try Task.checkCancellation()
        _ = try await route.client.dispatch(command)
    }
}
