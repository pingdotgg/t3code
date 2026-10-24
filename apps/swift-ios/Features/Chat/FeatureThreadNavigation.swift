import Foundation

@MainActor
protocol FeatureThreadNavigating {
    func loadRelatedThread(id: String, from threadID: String) async throws -> FeatureThreadDetail
}

extension OrchestrationV2TimelineMetadata {
    var workflowSource: FeatureThreadWorkflowSource? {
        guard itemType == "assistant_message", let runID else { return nil }
        return FeatureThreadWorkflowSource(itemID: itemID, threadID: sourceThreadID, runID: runID)
    }
}
