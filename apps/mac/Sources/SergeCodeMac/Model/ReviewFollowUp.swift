import Foundation

/// What the follow-up bar offers for the review of an open pull request.
enum ReviewFollowUp: Equatable {
    /// Nothing to do: no review feedback outstanding, or the agent is busy
    /// with unrelated work.
    case none
    /// A review bot is looking at the current changes; fixing now would race it.
    case reviewInProgress
    /// The agent is running the fix turn we asked for.
    case fixesInProgress
    /// Actionable comments are waiting.
    case fixReviews(actionableCount: Int)
}

/// Pure model of the review lifecycle of the branch's pull request, as the
/// follow-up bar sees it.
///
/// A review is not one event but a cycle: the bot picks up the new commits and
/// reviews them, posts actionable comments, the agent fixes and pushes, and the
/// bot starts over. Offering "Fix Reviews" throughout that cycle asks the agent
/// to fix comments that do not exist yet, or that it already fixed. So each
/// phase gets its own answer, and "no comments left" gets no button at all.
///
/// The server reports the phase (`VcsStatus.reviewLifecycle`) from what the bot
/// left on the PR; "fixes in progress" is local — it is our own turn running.
enum ReviewLifecycle {
    /// The turn the agent is asked to run for "Fix Reviews". Plain user-message
    /// text, so it works identically across providers. Also the marker that
    /// identifies a running fix turn in the timeline.
    static let fixReviewCommentsPrompt = """
        Please fix the actionable review comments on this pull request.

        Guidelines:
        - Use the gh CLI to fetch PR comments and review threads, including human reviewers and bot reviewers such as CodeRabbit.
        - Start with gh pr view --comments, then use gh api graphql to inspect review threads and their resolved/outdated state.
        - Ignore comments that are resolved, outdated, purely informational, or nitpick-level unless they block correctness.
        - Implement the fixes, run the relevant checks, commit, and push to the PR branch.
        - Reply to each addressed comment with what changed, and resolve the corresponding review threads with gh api graphql where possible.
        - Summarize any comments you intentionally skipped and why.
        """

    static func followUp(
        threadStatus: ThreadStatus, vcs: VcsStatus, timeline: [TimelineItem]
    ) -> ReviewFollowUp {
        guard vcs.prNumber != nil, vcs.prState == .open else { return .none }

        if !threadStatus.isSettled {
            return isFixTurnRunning(timeline: timeline) ? .fixesInProgress : .none
        }
        // Only once the agent has actually answered in this thread, so a freshly
        // opened chat on a branch with a PR is not immediately nagged.
        guard threadStatus == .idle, timeline.hasCompletedAssistantMessage else {
            return .none
        }

        if vcs.reviewLifecycle == .reviewInProgress { return .reviewInProgress }

        guard let actionable = vcs.actionableReviewItemCount, actionable > 0 else {
            return .none
        }
        return .fixReviews(actionableCount: actionable)
    }

    /// True while the running turn is the fix turn we asked for — matched by the
    /// prompt we sent, so no extra thread state has to be tracked.
    private static func isFixTurnRunning(timeline: [TimelineItem]) -> Bool {
        for item in timeline.reversed() {
            if case .userMessage(_, let text, _) = item {
                return text == fixReviewCommentsPrompt
            }
        }
        return false
    }
}
