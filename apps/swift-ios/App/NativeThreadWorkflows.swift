import Foundation

extension NativeFeatureClient: FeatureThreadWorkflowClient {
    func forkThread(threadID: String, source: FeatureThreadWorkflowSource) async throws -> String {
        let context = try await v2ActionContext(threadID: threadID)
        let displayed = try await workflowProjection(client: context.client, wireID: context.wireID)
        guard let displayedRow = displayed.visibleTurnItems.first(where: { $0.source == source }),
              FeatureThreadWorkflows.canFork(itemType: displayedRow.item.type, status: displayedRow.item.status,
                  runID: displayedRow.item.runId, capabilities: displayed.capabilities(for: displayedRow)) else {
            throw FeatureThreadWorkflowError.responseUnavailable
        }
        // Inherited responses use their original session's capabilities, never the fork's session.
        let original: FeatureThreadWorkflows.Projection
        if source.threadID == context.wireID {
            original = displayed
        } else {
            original = try await workflowProjection(client: context.client, wireID: source.threadID)
        }
        guard let row = original.visibleTurnItems.first(where: { $0.source == source }),
              FeatureThreadWorkflows.canFork(itemType: row.item.type, status: row.item.status,
                  runID: row.item.runId, capabilities: original.capabilities(for: row)) else {
            throw FeatureThreadWorkflowError.responseUnavailable
        }
        let targetID = UUID().uuidString
        try Task.checkCancellation()
        guard try await context.client.orchestrationVersion() == .v2 else {
            throw FeatureThreadWorkflowError.unavailable
        }
        _ = try await context.client.dispatch(OrchestrationV2Commands.fork(
            sourceThreadID: source.threadID, targetThreadID: targetID,
            runID: source.runID, title: "\(displayed.thread.title) fork"
        ))
        return FeatureScopedID.thread(environmentID: context.environmentID, wireID: targetID)
    }

    func mergeBackThread(threadID: String) async throws -> String {
        let context = try await v2ActionContext(threadID: threadID)
        let projection = try await workflowProjection(client: context.client, wireID: context.wireID)
        guard let targetID = projection.mergeBackTargetID, let run = projection.latestMergeBackRun else {
            throw FeatureThreadWorkflowError.mergeBackUnavailable
        }
        try Task.checkCancellation()
        guard try await context.client.orchestrationVersion() == .v2 else {
            throw FeatureThreadWorkflowError.unavailable
        }
        _ = try await context.client.dispatch(OrchestrationV2Commands.mergeBack(
            sourceThreadID: context.wireID, targetThreadID: targetID, runID: run.id
        ))
        return FeatureScopedID.thread(environmentID: context.environmentID, wireID: targetID)
    }

    private func workflowProjection(
        client: T3Client, wireID: String
    ) async throws -> FeatureThreadWorkflows.Projection {
        let snapshot = try await client.fullThreadSnapshot(id: wireID)
        guard snapshot.orchestrationProtocolVersion == 2,
              let control = snapshot.thread.orchestrationV2Control else {
            throw FeatureThreadWorkflowError.unavailable
        }
        let projection = try control.decode(FeatureThreadWorkflows.Projection.self)
        guard projection.thread.id == wireID else { throw OrchestrationV2StateError.wrongThread }
        return projection
    }
}

public enum FeatureThreadWorkflowError: LocalizedError, Sendable {
    case unavailable, responseUnavailable, mergeBackUnavailable

    public var errorDescription: String? {
        switch self {
        case .unavailable: "Thread workflows require a V2 connection."
        case .responseUnavailable: "This response can no longer be forked. Refresh the thread and try again."
        case .mergeBackUnavailable: "Finish this fork's current run before sending its context back to the source thread."
        }
    }
}
