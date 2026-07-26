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

    /// A live foreground command is part of the running turn, and session/turn
    /// liveness — not the task count — is what projects that. Feeding it into
    /// `activeSubagentCount` only mattered after the turn went quiet, where it
    /// pinned an otherwise finished thread to `backgroundWork` (and put a
    /// count in the sidebar's background badge) for a shell call nobody is
    /// waiting on. Backgrounded commands still count: those genuinely outlive
    /// the turn.
    @Test("a live foreground command projects running, not background work")
    func foregroundCommandDoesNotOutliveItsTurn() {
        let started = activity(
            id: "act-cmd-start", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:00.000Z",
            payload: .object([
                "taskId": .string("cmd-1"),
                "entityType": .string("command"),
                "taskType": .string("local_bash"),
            ]))
        var state = T3SubagentTaskActivityState()
        _ = state.apply(activity: started, at: WireDate.parse(started.createdAt)!)
        #expect(state.activeTaskCount == 1)
        #expect(state.activeBackgroundWorkCount == 0)

        // Mid-turn: the turn's own liveness projects running.
        let runningTurn = OrchestrationLatestTurn(
            turnId: "turn-1", state: .running, requestedAt: now)
        #expect(
            ThreadStatusProjection.project(
                session: OrchestrationSession(threadId: "thread-1", status: .running, updatedAt: now),
                latestTurn: runningTurn, archivedAt: nil, settledOverride: nil,
                hasPendingApprovals: false,
                activeSubagentCount: state.activeBackgroundWorkCount) == .running)

        // Turn over, command task never closed: the thread settles instead of
        // spinning on background work forever.
        let completedTurn = OrchestrationLatestTurn(
            turnId: "turn-1", state: .completed, requestedAt: now)
        #expect(
            ThreadStatusProjection.project(
                session: OrchestrationSession(threadId: "thread-1", status: .idle, updatedAt: now),
                latestTurn: completedTurn, archivedAt: nil, settledOverride: nil,
                hasPendingApprovals: false,
                activeSubagentCount: state.activeBackgroundWorkCount) == .done)
    }

    @Test("a backgrounded command keeps the thread in background work")
    func backgroundedCommandProjectsBackgroundWork() {
        let started = activity(
            id: "act-cmd-start", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:00.000Z",
            payload: .object([
                "taskId": .string("cmd-1"),
                "entityType": .string("command"),
                "taskType": .string("local_bash"),
            ]))
        let detached = activity(
            id: "act-cmd-bg", kind: ActivityKind.taskUpdated,
            at: "2026-07-04T10:00:02.000Z",
            payload: .object([
                "taskId": .string("cmd-1"),
                "entityType": .string("command"),
                "isBackgrounded": .bool(true),
            ]))
        var state = T3SubagentTaskActivityState()
        _ = state.apply(activity: started, at: WireDate.parse(started.createdAt)!)
        _ = state.apply(activity: detached, at: WireDate.parse(detached.createdAt)!)
        #expect(state.activeBackgroundWorkCount == 1)

        let completedTurn = OrchestrationLatestTurn(
            turnId: "turn-1", state: .completed, requestedAt: now)
        #expect(
            ThreadStatusProjection.project(
                session: OrchestrationSession(threadId: "thread-1", status: .idle, updatedAt: now),
                latestTurn: completedTurn, archivedAt: nil, settledOverride: nil,
                hasPendingApprovals: false,
                activeSubagentCount: state.activeBackgroundWorkCount) == .backgroundWork)
    }

    private func activity(
        id: String, kind: String, at: String, payload: JSONValue
    ) -> OrchestrationThreadActivity {
        OrchestrationThreadActivity(
            id: id, tone: .info, kind: kind, summary: kind, payload: payload,
            sequence: nil, createdAt: at)
    }
}
