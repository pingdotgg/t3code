import Foundation

extension NativeFeatureClient: FeatureReviewGuideClient {
    func reviewGuideAccess(_ target: FeaturePullRequestTarget) async throws -> FeatureReviewGuideAccess {
        let client = try await projectCreationClient(environmentID: target.environmentID)
        let enabled = try await client.reviewGuidesEnabled()
        guard enabled else { return .init(enabled: false, canWrite: false) }
        do {
            try await requireScope("orchestration:operate", client: client)
            return .init(enabled: true, canWrite: await client.liveConnectionActive())
        } catch is EnvironmentPermissionDeniedError {
            return .init(enabled: true, canWrite: false)
        }
    }

    func pullRequestReviewGuide(_ target: FeaturePullRequestTarget) async throws -> PullRequestReviewGuideResult {
        let client = try await projectCreationClient(environmentID: target.environmentID)
        return try await client.pullRequestReviewGuide(target.reference)
    }

    func generatePullRequestReviewGuide(_ target: FeaturePullRequestTarget) async throws -> PullRequestReviewGuideResult {
        // Guides belong to one server. Routing to another host would read or start a different tour.
        let client = try await projectCreationClient(environmentID: target.environmentID)
        try await requireScope("orchestration:operate", client: client)
        guard try await client.reviewGuidesEnabled() else {
            throw FeatureCapabilityUnavailable("Review guides")
        }
        return try await client.generatePullRequestReviewGuide(target.reference)
    }
}
