import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Subagent task presentation")
@MainActor
struct SubagentTaskPresentationTests {
    private let now = Date(timeIntervalSince1970: 1_000)

    @Test("fresh active server health suppresses the client heuristic")
    func freshActiveHealthSuppressesHeuristic() {
        let task = runningTask(lastActivityAt: now.addingTimeInterval(-240))
        let health = ThreadHealth(stalled: false, lastActivityAt: now.addingTimeInterval(-30))

        #expect(!SubagentTaskPresentation.isStalled(task: task, at: now, threadHealth: health))
    }

    @Test("stale active server health falls back to the client heuristic")
    func staleActiveHealthFallsBackToHeuristic() {
        let task = runningTask(lastActivityAt: now.addingTimeInterval(-240))
        let health = ThreadHealth(stalled: false, lastActivityAt: now.addingTimeInterval(-181))

        #expect(SubagentTaskPresentation.isStalled(task: task, at: now, threadHealth: health))
    }

    @Test("server stalled health always stalls a running task")
    func serverStalledHealthAlwaysStalls() {
        let task = runningTask(lastActivityAt: now)
        let health = ThreadHealth(stalled: true, lastActivityAt: now)

        #expect(SubagentTaskPresentation.isStalled(task: task, at: now, threadHealth: health))
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

}
