import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Subagent task presentation")
@MainActor
struct SubagentTaskPresentationTests {
    private let now = Date(timeIntervalSince1970: 1_000)

    @Test("fresh running task is not marked as silently running")
    func freshTaskIsNotSilent() {
        let task = runningTask(lastActivityAt: now.addingTimeInterval(-30))

        #expect(!SubagentTaskPresentation.isRunningSilently(task: task, at: now))
    }

    @Test("quiet running task is shown as running silently")
    func quietTaskIsRunningSilently() {
        let task = runningTask(lastActivityAt: now.addingTimeInterval(-181))

        #expect(SubagentTaskPresentation.isRunningSilently(task: task, at: now))
    }

    @Test("silence does not relabel a terminal task")
    func silenceDoesNotRelabelTerminalTask() {
        var task = runningTask(lastActivityAt: now.addingTimeInterval(-181))
        task.state = .completed

        #expect(!SubagentTaskPresentation.isRunningSilently(task: task, at: now))
    }

    @Test("agent roster requires the exact tool title prefix or parentThreadId")
    func agentRosterUsesExactTitlePrefix() {
        #expect(AgentsPanel.isSiblingAgentThread(thread(title: "Agent: reviewer")))
        #expect(!AgentsPanel.isSiblingAgentThread(thread(title: "agent: reviewer")))
        #expect(!AgentsPanel.isSiblingAgentThread(thread(title: "Agent:\treviewer")))
        #expect(
            AgentsPanel.isSiblingAgentThread(
                thread(title: "Custom title", parentThreadId: "parent-1")))
    }

    @Test("identity badge shows reasoning effort after the model name")
    func identityBadgeShowsEffort() {
        var task = runningTask(lastActivityAt: now)
        task.subagentType = "Explore"
        task.model = "claude-sonnet-5"
        task.effort = "xhigh"

        #expect(
            SubagentTaskPresentation.identityBadge(
                for: task, modelDisplayNames: ["claude-sonnet-5": "Sonnet 5"]
            ) == "Explore · Sonnet 5 · Extra High")
    }

    @Test("identity badge hides effort until the model is known")
    func identityBadgeHidesEffortWithoutModel() {
        var task = runningTask(lastActivityAt: now)
        task.subagentType = "Explore"
        task.effort = "high"

        #expect(
            SubagentTaskPresentation.identityBadge(for: task, modelDisplayNames: [:]) == "Explore")
    }

    private func runningTask(lastActivityAt: Date) -> SubagentTaskItem {
        SubagentTaskItem(
            taskId: "task-1",
            taskType: "reviewer",
            description: "Review the changes",
            state: .running,
            latestProgress: nil,
            startedAt: now.addingTimeInterval(-300),
            lastActivityAt: lastActivityAt,
            duration: nil)
    }

    private func thread(title: String, parentThreadId: String? = nil) -> ChatThread {
        ChatThread(
            id: "thread-1",
            projectID: "project-1",
            title: title,
            provider: .codex,
            status: .running,
            updatedAt: now,
            parentThreadId: parentThreadId)
    }
}
