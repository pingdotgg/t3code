import Foundation
import Testing
@testable import T3Code

@Suite("Subagent status")
struct SubagentStatusTests {
    @Test
    func countsOnlyExplicitLiveSubagents() {
        var tracker = FeatureActiveSubagentTracker()

        tracker.apply(activity(
            id: "agent-start",
            kind: "task.started",
            payload: ["taskId": .string("agent-1"), "agentKind": .string("agent")]
        ))
        tracker.apply(activity(
            id: "background-start",
            kind: "task.started",
            payload: ["taskId": .string("monitor-1"), "agentKind": .string("background")]
        ))
        tracker.apply(activity(
            id: "legacy-start",
            kind: "task.started",
            payload: ["taskId": .string("legacy-1")]
        ))

        #expect(tracker.activeCount == 1)
    }

    @Test
    func terminalRowsInheritKnownAgentMembership() {
        var tracker = FeatureActiveSubagentTracker()
        tracker.apply(activity(
            id: "start",
            kind: "task.started",
            payload: ["taskId": .string("agent-1"), "agentKind": .string("agent")]
        ))
        tracker.apply(activity(
            id: "complete",
            kind: "task.completed",
            payload: ["taskId": .string("agent-1"), "status": .string("completed")]
        ))

        #expect(tracker.activeCount == 0)
    }

    @Test
    func idleAgentsCanStartAgainButTerminalAgentsDoNotReopenFromLateStarts() {
        var tracker = FeatureActiveSubagentTracker()
        tracker.apply(activity(
            id: "start",
            kind: "task.started",
            payload: ["taskId": .string("agent-1"), "agentKind": .string("agent")]
        ))
        tracker.apply(activity(
            id: "idle",
            kind: "task.updated",
            payload: ["taskId": .string("agent-1"), "status": .string("idle")]
        ))
        #expect(tracker.activeCount == 0)

        tracker.apply(activity(
            id: "restart",
            kind: "task.started",
            payload: ["taskId": .string("agent-1")]
        ))
        #expect(tracker.activeCount == 1)

        tracker.apply(activity(
            id: "failed",
            kind: "task.updated",
            payload: ["taskId": .string("agent-1"), "status": .string("failed")]
        ))
        tracker.apply(activity(
            id: "late-start",
            kind: "task.started",
            payload: ["taskId": .string("agent-1")]
        ))
        #expect(tracker.activeCount == 0)
    }

    @Test
    func monitoringRemainsDistinctFromActiveAgentWork() {
        let working = NativeFeatureClient.resolveThreadState(
            latestTurn: nil,
            session: nil,
            hasApprovals: false,
            hasUserInput: false,
            backgroundLiveness: .working
        )
        let monitoring = NativeFeatureClient.resolveThreadState(
            latestTurn: nil,
            session: nil,
            hasApprovals: false,
            hasUserInput: false,
            backgroundLiveness: .monitoring
        )

        #expect(working == .working)
        #expect(monitoring == .monitoring)
    }

    @Test(arguments: [
        OrchestrationBackgroundLiveness.working,
        OrchestrationBackgroundLiveness.monitoring,
    ])
    func threadShellDecodesBackgroundLiveness(
        _ backgroundLiveness: OrchestrationBackgroundLiveness
    ) throws {
        let shell = OrchestrationThreadShell(
            id: "thread-1",
            projectId: "project-1",
            title: "Subagents",
            modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            interactionMode: .default,
            branch: nil,
            worktreePath: nil,
            latestTurn: nil,
            createdAt: "2026-08-08T00:00:00Z",
            updatedAt: "2026-08-08T00:00:00Z",
            archivedAt: nil,
            settledOverride: nil,
            settledAt: nil,
            snoozedUntil: nil,
            snoozedAt: nil,
            pinnedAt: nil,
            session: nil,
            latestUserMessageAt: nil,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
            backgroundLiveness: backgroundLiveness
        )

        let decoded = try JSONDecoder.t3.decode(
            OrchestrationThreadShell.self,
            from: JSONEncoder.t3.encode(shell)
        )

        #expect(decoded.backgroundLiveness == backgroundLiveness)
    }

    private func activity(
        id: String,
        kind: String,
        payload: [String: JSONValue]
    ) -> OrchestrationActivity {
        OrchestrationActivity(
            id: id,
            tone: "info",
            kind: kind,
            summary: kind,
            payload: .object(payload),
            turnId: "turn-1",
            sequence: nil,
            createdAt: "2026-08-08T00:00:00Z"
        )
    }
}
