import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Subagent task cross-thread aggregation")
@MainActor
struct SubagentTaskAggregatorTests {
    @Test("running count excludes tasks from stale threads")
    func runningCountOnlyUsesLiveThreads() {
        let aggregator = SubagentTaskAggregator()
        aggregator.updateThread(thread(id: "live", title: "Live thread"))
        aggregator.updateThread(thread(id: "stale", title: "Stale thread"))
        aggregator.replaceTasks([task(id: "live-task", state: .running)], for: "live")
        aggregator.replaceTasks([task(id: "stale-task", state: .running)], for: "stale")
        aggregator.setLive(true, for: "live")

        #expect(aggregator.runningCount == 1)
        #expect(aggregator.entries.count == 2)
        #expect(aggregator.entries.first { $0.threadID == "stale" }?.isLive == false)
    }

    @Test("closing a subscription freezes entries and marks them stale")
    func staleEntriesRemainVisible() {
        let aggregator = SubagentTaskAggregator()
        aggregator.updateThread(thread(id: "thread-1", title: "Review the diff"))
        aggregator.replaceTasks([task(id: "task-1", state: .running)], for: "thread-1")
        aggregator.setLive(true, for: "thread-1")

        aggregator.setLive(false, for: "thread-1")

        #expect(aggregator.runningCount == 0)
        #expect(aggregator.entries.count == 1)
        #expect(aggregator.entries[0].task.taskId == "task-1")
        #expect(!aggregator.entries[0].isLive)
        #expect(aggregator.threadGroups[0].title == "Review the diff")
    }

    @Test("task upserts do not discard other frozen rows")
    func upsertPreservesFrozenRows() {
        let aggregator = SubagentTaskAggregator()
        aggregator.updateThread(thread(id: "thread-1", title: "Background work"))
        aggregator.replaceTasks(
            [
                task(id: "task-1", state: .running),
                task(id: "task-2", state: .paused),
            ],
            for: "thread-1")
        aggregator.setLive(false, for: "thread-1")

        aggregator.upsert(task(id: "task-1", state: .stopped), for: "thread-1")

        #expect(aggregator.entries.map { $0.task.taskId } == ["task-1", "task-2"])
        #expect(aggregator.entries.first { $0.task.taskId == "task-1" }?.task.state == .stopped)
        #expect(aggregator.entries.allSatisfy { !$0.isLive })
    }

    private func thread(id: String, title: String) -> ChatThread {
        ChatThread(
            id: id,
            projectID: "project-1",
            title: title,
            provider: .claude,
            status: .backgroundWork,
            updatedAt: Date(timeIntervalSince1970: 1))
    }

    private func task(id: String, state: SubagentTaskState) -> SubagentTaskItem {
        SubagentTaskItem(
            taskId: id,
            taskType: "reviewer",
            description: "Inspect the current changes",
            state: state,
            latestProgress: nil,
            startedAt: Date(timeIntervalSince1970: 10),
            duration: state == .running ? nil : 5)
    }
}
