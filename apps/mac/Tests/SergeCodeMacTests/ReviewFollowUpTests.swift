import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Review follow-up lifecycle")
struct ReviewFollowUpTests {
    private func status(
        prNumber: Int? = 1,
        prState: PullRequestState? = .open,
        reviewDecision: PullRequestReviewDecision? = nil,
        unresolvedReviewThreadCount: Int? = 0,
        actionableReviewItemCount: Int? = 0,
        reviewLifecycle: PullRequestReviewLifecycle? = nil
    ) -> VcsStatus {
        VcsStatus(
            isRepo: true, branch: "feat/review", isDefaultBranch: false,
            changedFileCount: 0, insertions: 0, deletions: 0, aheadCount: 0,
            behindCount: 0, hasUpstream: true, hasPrimaryRemote: true,
            prNumber: prNumber, prTitle: "Ship it",
            prURL: "https://github.com/SergeSerb2/SergeCode/pull/1",
            prState: prState,
            reviewDecision: reviewDecision,
            unresolvedReviewThreadCount: unresolvedReviewThreadCount,
            actionableReviewItemCount: actionableReviewItemCount,
            reviewLifecycle: reviewLifecycle)
    }

    private func answeredTimeline(lastUserMessage: String? = nil) -> [TimelineItem] {
        var timeline: [TimelineItem] = [
            .userMessage(id: "u1", text: "add the thing", attachments: [], at: Date(timeIntervalSince1970: 1)),
            .assistantMessage(
                id: "a1", markdown: "done", isStreaming: false, at: Date(timeIntervalSince1970: 2)),
        ]
        if let lastUserMessage {
            timeline.append(
                .userMessage(id: "u2", text: lastUserMessage, attachments: [], at: Date(timeIntervalSince1970: 3)))
        }
        return timeline
    }

    @Test("offers the fix with a count while comments are unresolved")
    func offersFixWhenCommentsAreUnresolved() {
        #expect(
            ReviewLifecycle.followUp(
                threadStatus: .idle,
                vcs: status(
                    unresolvedReviewThreadCount: 3, actionableReviewItemCount: 3,
                    reviewLifecycle: .actionableComments),
                timeline: answeredTimeline()) == .fixReviews(actionableCount: 3))
    }

    @Test("stays quiet once the review is complete with nothing left to fix")
    func quietWhenReviewComplete() {
        #expect(
            ReviewLifecycle.followUp(
                threadStatus: .idle,
                vcs: status(unresolvedReviewThreadCount: 0, reviewLifecycle: .reviewComplete),
                timeline: answeredTimeline()) == ReviewFollowUp.none)
    }

    @Test("stays quiet when a PR has no review feedback yet")
    func quietWhenNothingReviewedYet() {
        #expect(
            ReviewLifecycle.followUp(
                threadStatus: .idle,
                vcs: status(unresolvedReviewThreadCount: 0),
                timeline: answeredTimeline()) == ReviewFollowUp.none)
    }

    @Test("reports the bot's review instead of offering a fix that would race it")
    func reportsReviewInProgress() {
        #expect(
            ReviewLifecycle.followUp(
                threadStatus: .idle,
                vcs: status(unresolvedReviewThreadCount: 2, reviewLifecycle: .reviewInProgress),
                timeline: answeredTimeline()) == .reviewInProgress)
    }

    @Test("reports our own fix turn while it runs")
    func reportsFixesInProgress() {
        #expect(
            ReviewLifecycle.followUp(
                threadStatus: .running,
                vcs: status(unresolvedReviewThreadCount: 2, reviewLifecycle: .actionableComments),
                timeline: answeredTimeline(
                    lastUserMessage: ReviewLifecycle.fixReviewCommentsPrompt))
                == .fixesInProgress)
    }

    @Test("stays quiet while the agent runs unrelated work")
    func quietWhileUnrelatedTurnRuns() {
        #expect(
            ReviewLifecycle.followUp(
                threadStatus: .running,
                vcs: status(unresolvedReviewThreadCount: 2, reviewLifecycle: .actionableComments),
                timeline: answeredTimeline(lastUserMessage: "rename the module"))
                == ReviewFollowUp.none)
    }

    @Test("stays quiet when changes were requested without an actionable thread")
    func quietOnChangesRequestedWithoutActionableThread() {
        #expect(
            ReviewLifecycle.followUp(
                threadStatus: .idle,
                vcs: status(
                    reviewDecision: .changesRequested, unresolvedReviewThreadCount: 0,
                    reviewLifecycle: .reviewComplete),
                timeline: answeredTimeline()) == ReviewFollowUp.none)
    }

    @Test("stays quiet when the actionable count is unknown")
    func quietWhenActionableCountUnknown() {
        #expect(
            ReviewLifecycle.followUp(
                threadStatus: .idle,
                vcs: status(
                    unresolvedReviewThreadCount: nil, actionableReviewItemCount: nil),
                timeline: answeredTimeline()) == ReviewFollowUp.none)
    }

    @Test("stays quiet when unresolved threads have no actionable content")
    func quietWhenUnresolvedThreadsAreNotActionable() {
        #expect(
            ReviewLifecycle.followUp(
                threadStatus: .idle,
                vcs: status(
                    unresolvedReviewThreadCount: 2, actionableReviewItemCount: 0,
                    reviewLifecycle: .actionableComments),
                timeline: answeredTimeline()) == ReviewFollowUp.none)
    }

    @Test("stays quiet without an open PR")
    func quietWithoutOpenPullRequest() {
        #expect(
            ReviewLifecycle.followUp(
                threadStatus: .idle, vcs: status(prState: .merged, unresolvedReviewThreadCount: 2),
                timeline: answeredTimeline()) == ReviewFollowUp.none)
        #expect(
            ReviewLifecycle.followUp(
                threadStatus: .idle, vcs: status(prNumber: nil, unresolvedReviewThreadCount: 2),
                timeline: answeredTimeline()) == ReviewFollowUp.none)
    }

    @Test("stays quiet in a thread the agent has not answered in yet")
    func quietBeforeFirstAnswer() {
        #expect(
            ReviewLifecycle.followUp(
                threadStatus: .idle, vcs: status(unresolvedReviewThreadCount: 2),
                timeline: [
                    .userMessage(id: "u1", text: "hi", attachments: [], at: Date(timeIntervalSince1970: 1))
                ]) == ReviewFollowUp.none)
    }
}
