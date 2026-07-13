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

    @Test("agent roster requires the exact tool title prefix")
    func agentRosterUsesExactTitlePrefix() {
        #expect(AgentsPanel.isSiblingAgentThread(thread(title: "Agent: reviewer")))
        #expect(!AgentsPanel.isSiblingAgentThread(thread(title: "agent: reviewer")))
        #expect(!AgentsPanel.isSiblingAgentThread(thread(title: "Agent:\treviewer")))
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

    private func thread(title: String) -> ChatThread {
        ChatThread(
            id: "thread-1",
            projectID: "project-1",
            title: title,
            provider: .codex,
            status: .running,
            updatedAt: now)
    }
}
