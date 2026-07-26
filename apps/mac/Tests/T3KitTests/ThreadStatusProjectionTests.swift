import Testing

@testable import T3Kit

@Suite("Thread status projection")
struct ThreadStatusProjectionTests {
    private let now = "2026-07-04T10:00:00.000Z"

    @Test func errorBeatsBackgroundWorkAndApprovals() {
        let session = OrchestrationSession(
            threadId: "thread-1", status: .error, updatedAt: now)
        let status = ThreadStatusProjection.project(
            session: session, latestTurn: nil, archivedAt: nil, settledOverride: nil,
            hasPendingApprovals: true, activeSubagentCount: 2)
        #expect(status == .error)
    }

    @Test func waitingApprovalBeatsRunningAndBackgroundWork() {
        let session = OrchestrationSession(
            threadId: "thread-1", status: .running, updatedAt: now)
        let status = ThreadStatusProjection.project(
            session: session, latestTurn: nil, archivedAt: nil, settledOverride: nil,
            hasPendingApprovals: true, activeSubagentCount: 2)
        #expect(status == .waitingApproval)
    }

    @Test func runningBeatsBackgroundWork() {
        let latestTurn = OrchestrationLatestTurn(
            turnId: "turn-1", state: .running, requestedAt: now)
        let status = ThreadStatusProjection.project(
            session: nil, latestTurn: latestTurn, archivedAt: nil, settledOverride: nil,
            hasPendingApprovals: false, activeSubagentCount: 2)
        #expect(status == .running)
    }

    @Test func activeSubagentsProjectBackgroundWorkWhenMainTurnIdle() {
        let session = OrchestrationSession(
            threadId: "thread-1", status: .idle, updatedAt: now)
        let latestTurn = OrchestrationLatestTurn(
            turnId: "turn-1", state: .completed, requestedAt: now)
        let status = ThreadStatusProjection.project(
            session: session, latestTurn: latestTurn, archivedAt: nil, settledOverride: nil,
            hasPendingApprovals: false, activeSubagentCount: 1)
        #expect(status == .backgroundWork)
    }

    @Test func archivedWinsAfterBackgroundWorkCheckIsNotActive() {
        let status = ThreadStatusProjection.project(
            session: nil, latestTurn: nil, archivedAt: now, settledOverride: nil,
            hasPendingApprovals: false, activeSubagentCount: 0)
        #expect(status == .archived)
    }

    @Test func settledOverrideProjectsSettledWhenIdle() {
        let status = ThreadStatusProjection.project(
            session: nil, latestTurn: nil, archivedAt: nil, settledOverride: "settled",
            hasPendingApprovals: false, activeSubagentCount: 0)
        #expect(status == .settled)
    }

    @Test func fixingPhaseBeatsRunningSessionAndTurn() {
        let session = OrchestrationSession(
            threadId: "thread-1", status: .running, updatedAt: now)
        let latestTurn = OrchestrationLatestTurn(
            turnId: "turn-1", state: .running, requestedAt: now)
        let status = ThreadStatusProjection.project(
            session: session, latestTurn: latestTurn, archivedAt: nil, settledOverride: nil,
            hasPendingApprovals: false, activeSubagentCount: 0, autoReviewPhase: "fixing")
        #expect(status == .fixing)
    }

    @Test func reviewingPhaseBeatsRunningSessionAndTurn() {
        let session = OrchestrationSession(
            threadId: "thread-1", status: .running, updatedAt: now)
        let latestTurn = OrchestrationLatestTurn(
            turnId: "turn-1", state: .running, requestedAt: now)
        let status = ThreadStatusProjection.project(
            session: session, latestTurn: latestTurn, archivedAt: nil, settledOverride: nil,
            hasPendingApprovals: false, activeSubagentCount: 0, autoReviewPhase: "reviewing")
        #expect(status == .reviewing)
    }

    @Test func pendingApprovalBeatsAutoReviewPhase() {
        let status = ThreadStatusProjection.project(
            session: nil, latestTurn: nil, archivedAt: nil, settledOverride: nil,
            hasPendingApprovals: true, activeSubagentCount: 0, autoReviewPhase: "fixing")
        #expect(status == .waitingApproval)
    }

    @Test func errorBeatsAutoReviewPhase() {
        let session = OrchestrationSession(
            threadId: "thread-1", status: .error, updatedAt: now)
        let status = ThreadStatusProjection.project(
            session: session, latestTurn: nil, archivedAt: nil, settledOverride: nil,
            hasPendingApprovals: false, activeSubagentCount: 0, autoReviewPhase: "reviewing")
        #expect(status == .error)
    }

    @Test func readyToMergeOnlyWhenThreadNotBusy() {
        let runningSession = OrchestrationSession(
            threadId: "thread-1", status: .running, updatedAt: now)
        let busy = ThreadStatusProjection.project(
            session: runningSession, latestTurn: nil, archivedAt: nil, settledOverride: nil,
            hasPendingApprovals: false, activeSubagentCount: 0,
            autoReviewPhase: "readyToMerge")
        #expect(busy == .running)

        let completedTurn = OrchestrationLatestTurn(
            turnId: "turn-1", state: .completed, requestedAt: now)
        let ready = ThreadStatusProjection.project(
            session: nil, latestTurn: completedTurn, archivedAt: nil, settledOverride: nil,
            hasPendingApprovals: false, activeSubagentCount: 0,
            autoReviewPhase: "readyToMerge")
        #expect(ready == .readyToMerge)
    }

    @Test func archivedOutranksReadyToMergePhase() {
        let status = ThreadStatusProjection.project(
            session: nil, latestTurn: nil, archivedAt: now, settledOverride: nil,
            hasPendingApprovals: false, activeSubagentCount: 0,
            autoReviewPhase: "readyToMerge")
        #expect(status == .archived)
    }

    @Test func settledOverrideOutranksReadyToMergePhase() {
        let status = ThreadStatusProjection.project(
            session: nil, latestTurn: nil, archivedAt: nil, settledOverride: "settled",
            hasPendingApprovals: false, activeSubagentCount: 0,
            autoReviewPhase: "readyToMerge")
        #expect(status == .settled)
    }

    @Test func doneRequiresCompletedLatestTurn() {
        let completedTurn = OrchestrationLatestTurn(
            turnId: "turn-1", state: .completed, requestedAt: now)
        let done = ThreadStatusProjection.project(
            session: nil, latestTurn: completedTurn, archivedAt: nil, settledOverride: nil,
            hasPendingApprovals: false, activeSubagentCount: 0)
        #expect(done == .done)

        let idle = ThreadStatusProjection.project(
            session: nil, latestTurn: nil, archivedAt: nil, settledOverride: nil,
            hasPendingApprovals: false, activeSubagentCount: 0)
        #expect(idle == .idle)

        let interruptedTurn = OrchestrationLatestTurn(
            turnId: "turn-2", state: .interrupted, requestedAt: now)
        let interrupted = ThreadStatusProjection.project(
            session: nil, latestTurn: interruptedTurn, archivedAt: nil, settledOverride: nil,
            hasPendingApprovals: false, activeSubagentCount: 0)
        #expect(interrupted == .idle)
    }

    @Test func readyToMergePhaseBeatsCompletedTurnDone() {
        let completedTurn = OrchestrationLatestTurn(
            turnId: "turn-1", state: .completed, requestedAt: now)
        let status = ThreadStatusProjection.project(
            session: nil, latestTurn: completedTurn, archivedAt: nil, settledOverride: nil,
            hasPendingApprovals: false, activeSubagentCount: 0,
            autoReviewPhase: "readyToMerge")
        #expect(status == .readyToMerge)
    }
}
