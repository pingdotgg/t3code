import Foundation

/// Tracks only workflow values used by displayed transcript rows.
struct FeatureTranscriptWorkflowState {
    private struct Row: Equatable {
        let agent: FeatureThreadAgent?
        // Nil means the button is absent; false means it is enabled.
        let forkIsBusy: Bool?
    }

    private var rows: [String: Row] = [:]

    mutating func update(
        messages: [FeatureMessage],
        workflows: FeatureThreadWorkflows,
        environmentID: String?,
        isWorkflowBusy: Bool
    ) -> Set<String> {
        var nextRows: [String: Row] = [:]
        for message in messages {
            let agent: FeatureThreadAgent?
            if message.role == .tool, let environmentID,
               let items = message.v2WorkItems, items.count == 1, let item = items.first {
                agent = item.threadAgent(environmentID: environmentID, agents: workflows.agents)
            } else {
                agent = nil
            }
            let canFork = message.v2FoldID == nil
                && message.v2Timeline?.workflowSource.map { workflows.canFork($0) } == true
            nextRows[message.id] = agent != nil || canFork
                ? Row(agent: agent, forkIsBusy: canFork ? isWorkflowBusy : nil)
                : nil
        }
        // Removed rows need no reconfiguration. Their removal belongs to the collection snapshot.
        let changedIDs = Set(messages.compactMap { message in
            rows[message.id] != nextRows[message.id] ? message.id : nil
        })
        rows = nextRows
        return changedIDs
    }
}
