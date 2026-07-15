/// Pure predicate for when the native UI should offer a one-click "Merge PR".
///
/// Ready only when:
/// - the PR is open
/// - the PR is not a draft
/// - every review thread is resolved (count known and zero)
/// - the review decision is nil or `APPROVED`
///
/// A nil review decision is normal for repositories without required reviewers.
/// The known-zero unresolved-thread count is the real signal that review feedback
/// has all been fixed; an unknown thread count remains not-ready.
enum MergeReadiness {
    static func isReady(for status: VcsStatus) -> Bool {
        guard status.prState == .open else { return false }
        guard status.isDraftPR != true else { return false }
        guard let unresolved = status.unresolvedReviewThreadCount, unresolved == 0 else {
            return false
        }
        switch status.reviewDecision {
        case nil, .approved:
            return true
        case .changesRequested, .reviewRequired:
            return false
        }
    }
}
