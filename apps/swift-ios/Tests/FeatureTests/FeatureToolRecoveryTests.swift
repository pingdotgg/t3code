import Foundation
import Testing
@testable import T3Code

@Suite("Tool failure recovery")
struct FeatureToolRecoveryTests {
    private struct StubError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private func failedState(
        _ operation: FeatureSourceControlOperation = .action(.push, message: nil),
        message: String = "remote rejected: non-fast-forward"
    ) -> FeatureToolFailureState<FeatureSourceControlOperation> {
        var state = FeatureToolFailureState<FeatureSourceControlOperation>()
        state.begin(operation)
        state.recordFailure(operation, error: StubError(message: message))
        return state
    }

    @Test
    func failureRetainsContentAndNamesTheOperation() {
        let state = failedState()

        #expect(state.failure?.title == "Push failed")
        #expect(state.failure?.message == "remote rejected: non-fast-forward")
        #expect(state.failure?.isRetrying == false)
        #expect(state.retryOperation == .action(.push, message: nil))
        #expect(state.focusTarget == .failure)
    }

    @Test
    func retryKeepsFailureContentVisibleWhileItRuns() {
        var state = failedState()

        state.begin(.action(.push, message: nil))

        #expect(state.failure?.message == "remote rejected: non-fast-forward")
        #expect(state.failure?.isRetrying == true)
        #expect(state.focusTarget == .failure)
        #expect(state.failure?.accessibilityLabel.hasSuffix("Retrying.") == true)
    }

    @Test
    func unrelatedWorkDoesNotMarkTheRetainedFailureAsRetrying() {
        var state = failedState()

        state.begin(.load)

        #expect(state.failure?.message == "remote rejected: non-fast-forward")
        #expect(state.failure?.isRetrying == false)
    }

    @Test("An unrelated success preserves the failed operation", .bug(id: 3801994163))
    func unrelatedSuccessDoesNotConsumeTheRetainedFailure() {
        var state = failedState()

        state.begin(.load)
        state.recordSuccess(.load)

        #expect(state.failure?.message == "remote rejected: non-fast-forward")
        #expect(state.retryOperation == .action(.push, message: nil))
        #expect(state.recoveryAnnouncement == nil)
    }

    @Test
    func repeatedFailureUpdatesContentAndPresentsANewFocusIdentity() {
        var state = failedState()
        let firstID = state.failure?.id

        state.begin(.action(.push, message: nil))
        state.recordFailure(
            .action(.push, message: nil),
            error: StubError(message: "remote rejected: still behind")
        )

        #expect(state.failure?.message == "remote rejected: still behind")
        #expect(state.failure?.isRetrying == false)
        #expect(state.failure?.id != firstID)
    }

    @Test
    func cancellationNeverCreatesAFailure() {
        var state = FeatureToolFailureState<FeatureSourceControlOperation>()
        state.begin(.load)

        state.recordFailure(.load, error: CancellationError())

        #expect(state.failure == nil)
        #expect(state.retryOperation == nil)
        #expect(state.focusTarget == .recoveredContent)
    }

    @Test
    func cancellingARetryPreservesTheOriginalFailureContent() {
        var state = failedState()
        state.begin(.action(.push, message: nil))

        state.recordFailure(
            .action(.push, message: nil),
            error: URLError(.cancelled)
        )

        #expect(state.failure?.message == "remote rejected: non-fast-forward")
        #expect(state.failure?.isRetrying == false)
        #expect(state.retryOperation == .action(.push, message: nil))
    }

    @Test
    func cancellationIsRecognizedAcrossTheErrorsAThreadDismissalProduces() {
        typealias State = FeatureToolFailureState<FeatureSourceControlOperation>

        #expect(State.isCancellation(CancellationError()))
        #expect(State.isCancellation(URLError(.cancelled)))
        #expect(State.isCancellation(CocoaError(.userCancelled)))
        #expect(State.isCancellation(URLError(.timedOut)) == false)
        #expect(State.isCancellation(StubError(message: "boom")) == false)
    }

    @Test
    func recoveryClearsTheFailureAndAnnouncesItOnce() {
        var state = failedState()

        state.begin(.action(.push, message: nil))
        state.recordSuccess(.action(.push, message: nil))

        #expect(state.failure == nil)
        #expect(state.retryOperation == nil)
        #expect(state.focusTarget == .recoveredContent)
        #expect(state.takeRecoveryAnnouncement() == "Push succeeded. Repository status updated.")
        #expect(state.takeRecoveryAnnouncement() == nil)
    }

    @Test
    func successWithoutAPriorFailureAnnouncesNothing() {
        var state = FeatureToolFailureState<FeatureSourceControlOperation>()

        state.begin(.load)
        state.recordSuccess(.load)

        #expect(state.takeRecoveryAnnouncement() == nil)
        #expect(state.focusTarget == .recoveredContent)
    }

    @Test
    func startingAnotherAttemptDropsAStaleRecoveryAnnouncement() {
        var state = failedState(.load)
        state.recordSuccess(.load)

        state.begin(.action(.pull, message: nil))

        #expect(state.recoveryAnnouncement == nil)
    }

    @Test
    func retryReplaysTheExactFailedOperationIncludingItsCommitMessage() {
        let operation = FeatureSourceControlOperation.action(.commit, message: "fix: retry me")
        var state = FeatureToolFailureState<FeatureSourceControlOperation>()

        state.begin(operation)
        state.recordFailure(operation, error: StubError(message: "pre-commit hook failed"))

        #expect(state.retryOperation == operation)
        #expect(state.failure?.retryAccessibilityLabel == "Retry commit changes")
    }

    @Test("A post-action refresh failure retries only the refresh", .bug(id: 3801994206))
    func postActionRefreshFailureCannotRepeatTheCompletedAction() {
        let completedAction = FeatureSourceControlOperation.action(
            .commit,
            message: "fix: do not run twice"
        )
        var state = FeatureToolFailureState<FeatureSourceControlOperation>()

        state.begin(completedAction)
        state.recordFollowUpFailure(
            .load,
            afterCompletionOf: completedAction,
            error: StubError(message: "connection lost during refresh")
        )

        #expect(state.failure?.title == "Repository status failed to load")
        #expect(state.retryOperation == .load)
        #expect(state.retryOperation != completedAction)
    }

    @Test("A cancelled post-action refresh cannot leave the action retryable")
    func cancelledPostActionRefreshDropsTheCompletedActionFailure() {
        let completedAction = FeatureSourceControlOperation.action(.push, message: nil)
        var state = failedState(completedAction)

        state.begin(completedAction)
        state.recordFollowUpFailure(
            .load,
            afterCompletionOf: completedAction,
            error: CancellationError()
        )

        #expect(state.failure == nil)
        #expect(state.retryOperation == nil)
        #expect(state.recoveryAnnouncement == nil)
    }

    @Test
    func retryLabelIsStableAcrossRepeatedFailuresOfTheSameOperation() {
        var state = failedState()
        let firstLabel = state.failure?.retryAccessibilityLabel

        state.begin(.action(.push, message: nil))
        state.recordFailure(.action(.push, message: nil), error: StubError(message: "again"))

        #expect(firstLabel == "Retry push")
        #expect(state.failure?.retryAccessibilityLabel == firstLabel)
    }

    @Test
    func everySourceControlOperationHasDistinctFailureAndRetryWording() {
        let operations: [FeatureSourceControlOperation] = [.load]
            + FeatureSourceControlAction.allCases.map { .action($0, message: nil) }

        let failureTitles = operations.map(\.failureTitle)
        let retryLabels = operations.map(\.retryAccessibilityLabel)

        #expect(Set(failureTitles).count == operations.count)
        #expect(Set(retryLabels).count == operations.count)
        #expect(retryLabels.allSatisfy { $0.hasPrefix("Retry ") })
        #expect(failureTitles.contains("Repository status failed to load"))
        #expect(retryLabels.contains("Retry loading repository status"))
    }

    @Test
    func emptyErrorTextStillLeavesReadableFailureContent() {
        var state = FeatureToolFailureState<FeatureSourceControlOperation>()

        state.recordFailure(.load, error: StubError(message: "   "))

        #expect(state.failure?.message == "The operation could not be completed.")
        #expect(state.failure?.accessibilityLabel.isEmpty == false)
    }

    @Test
    func loadOperationIsDistinguishedFromActions() {
        #expect(FeatureSourceControlOperation.load.isLoad)
        #expect(FeatureSourceControlOperation.action(.pull, message: nil).isLoad == false)
    }

    @Test("Only one source-control request can own the recovery state", .bug(id: 3802036872))
    func runStateRejectsOverlappingOperations() {
        var state = FeatureToolRunState<FeatureSourceControlOperation>()
        let action = FeatureSourceControlOperation.action(.push, message: nil)

        let actionDidBegin = state.begin(action)
        let overlappingLoadDidBegin = state.begin(.load)

        #expect(actionDidBegin)
        #expect(state.isBusy)
        #expect(overlappingLoadDidBegin == false)
        #expect(state.operation == action)

        state.finish(.load)
        #expect(state.operation == action)

        state.finish(action)
        #expect(state.isBusy == false)
        #expect(state.operation == nil)
    }
}
