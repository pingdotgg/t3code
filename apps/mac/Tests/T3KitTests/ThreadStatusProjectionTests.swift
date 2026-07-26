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
}
