import Testing

@testable import SergeCodeMac

@Suite("Merge readiness")
struct MergeReadinessTests {
    private func status(
        prState: PullRequestState? = .open,
        isDraftPR: Bool? = false,
        reviewDecision: PullRequestReviewDecision? = .approved,
        unresolvedReviewThreadCount: Int? = 0
    ) -> VcsStatus {
        VcsStatus(
            isRepo: true, branch: "feat/merge", isDefaultBranch: false,
            changedFileCount: 0, insertions: 0, deletions: 0, aheadCount: 0,
            behindCount: 0, hasUpstream: true, hasPrimaryRemote: true,
            prNumber: 1, prTitle: "Ship it",
            prURL: "https://github.com/SergeSerb2/SergeCode/pull/1",
            prState: prState,
            isDraftPR: isDraftPR,
            reviewDecision: reviewDecision,
            unresolvedReviewThreadCount: unresolvedReviewThreadCount)
    }

    @Test("ready when open, approved, and all threads resolved")
    func readyWhenApprovedAndClean() {
        #expect(MergeReadiness.isReady(for: status()))
    }

    @Test("not ready to merge while the PR is a draft")
    func notReadyWhileDraft() {
        #expect(!MergeReadiness.isReady(for: status(isDraftPR: true)))
    }

    @Test("ready when review decision is nil and all threads are resolved")
    func readyWithoutRequiredReviewers() {
        #expect(
            MergeReadiness.isReady(
                for: status(reviewDecision: nil, unresolvedReviewThreadCount: 0)))
    }

    @Test("not ready when review is required")
    func notReadyWhenReviewRequired() {
        #expect(
            !MergeReadiness.isReady(
                for: status(reviewDecision: .reviewRequired, unresolvedReviewThreadCount: 0)))
    }

    @Test("not ready when review decision is CHANGES_REQUESTED")
    func notReadyWhenChangesRequested() {
        #expect(
            !MergeReadiness.isReady(
                for: status(reviewDecision: .changesRequested, unresolvedReviewThreadCount: 0)))
    }

    @Test("not ready when unresolved threads remain")
    func notReadyWithUnresolvedThreads() {
        #expect(
            !MergeReadiness.isReady(
                for: status(reviewDecision: .approved, unresolvedReviewThreadCount: 2)))
    }

    @Test("not ready when unresolved thread count is unknown")
    func notReadyWhenThreadCountUnknown() {
        #expect(
            !MergeReadiness.isReady(
                for: status(reviewDecision: .approved, unresolvedReviewThreadCount: nil)))
    }

    @Test("not ready when PR is not open")
    func notReadyWhenMergedOrClosed() {
        #expect(!MergeReadiness.isReady(for: status(prState: .merged)))
        #expect(!MergeReadiness.isReady(for: status(prState: .closed)))
        #expect(!MergeReadiness.isReady(for: status(prState: nil)))
    }
}
