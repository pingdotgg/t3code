import Foundation

extension T3Client {
    /// Send to the origin after a routed detail read so its linked thread badges refresh.
    public func reportPullRequestState(_ reference: PullRequestRef, state: PullRequestState) async throws {
        try await rpc.request(
            "pullRequests.reportState",
            payload: try JSONValue.encode(PullRequestReportStateInput(reference: reference, state: state))
        )
    }
}
