import Foundation
import Testing

@testable import T3Kit

@Suite("Subagent task activity aggregation")
struct SubagentTaskActivityStateTests {
    private func activity(
        id: String, kind: String, at: String, payload: JSONValue,
        sequence: Int? = nil
    ) -> OrchestrationThreadActivity {
        OrchestrationThreadActivity(
            id: id, tone: .info, kind: kind, summary: kind, payload: payload,
            sequence: sequence, createdAt: at)
    }

    @Test func startedProgressCompletedMutateOneTask() {
        let start = activity(
            id: "act-start", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:00.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "taskType": .string("general-purpose"),
                "description": .string("Inspect timeline mapping"),
            ]))
        let progress = activity(
            id: "act-progress", kind: ActivityKind.taskProgress,
            at: "2026-07-04T10:00:03.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "summary": .string("Reading files"),
                "lastToolName": .string("Read"),
            ]))
        let completed = activity(
            id: "act-complete", kind: ActivityKind.taskCompleted,
            at: "2026-07-04T10:00:07.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "status": .string("completed"),
                "summary": .string("Mapped the flow"),
            ]))

        var state = T3SubagentTaskActivityState()
        let started = state.apply(activity: start, at: WireDate.parse(start.createdAt)!)
        let progressed = state.apply(activity: progress, at: WireDate.parse(progress.createdAt)!)
        let finished = state.apply(activity: completed, at: WireDate.parse(completed.createdAt)!)

        #expect(started?.id == progressed?.id)
        #expect(progressed?.id == finished?.id)
        #expect(finished?.taskType == "general-purpose")
        #expect(finished?.description == "Inspect timeline mapping")
        #expect(finished?.latestProgress == "Mapped the flow")
        #expect(finished?.state == .completed)
        #expect(finished?.duration == 7)
        #expect(state.activeTaskIDs.isEmpty)
    }

    @Test func startedBuildsRunningTaskWithMetadata() {
        let started = activity(
            id: "act-start", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:00.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "taskType": .string("general-purpose"),
                "description": .string("Inspect timeline mapping"),
            ]))

        var state = T3SubagentTaskActivityState()
        let item = state.apply(activity: started, at: WireDate.parse(started.createdAt)!)

        #expect(item?.id == "subagent-task:task-1")
        #expect(item?.taskType == "general-purpose")
        #expect(item?.description == "Inspect timeline mapping")
        #expect(item?.state == .running)
        #expect(state.activeTaskIDs == Set(["task-1"]))
    }

    @Test func progressBeforeStartedKeepsStableTaskAndBackfillsMetadata() {
        let progress = activity(
            id: "act-progress", kind: ActivityKind.taskProgress,
            at: "2026-07-04T10:00:02.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "summary": .string("Scanning"),
            ]))
        let start = activity(
            id: "act-start", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:00.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "taskType": .string("reviewer"),
                "description": .string("Review the diff"),
            ]))

        var state = T3SubagentTaskActivityState()
        _ = state.apply(activity: progress, at: WireDate.parse(progress.createdAt)!)
        let item = state.apply(activity: start, at: WireDate.parse(start.createdAt)!)

        #expect(item?.id == "subagent-task:task-1")
        #expect(item?.taskType == "reviewer")
        #expect(item?.description == "Review the diff")
        #expect(item?.latestProgress == "Scanning")
        #expect(item?.startedAt == WireDate.parse(start.createdAt))
        #expect(state.activeTaskIDs == Set(["task-1"]))
    }

    @Test func progressWithoutTextStillKeepsLiveTaskRow() {
        let progress = activity(
            id: "act-progress", kind: ActivityKind.taskProgress,
            at: "2026-07-04T10:00:02.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "detail": .string("  "),
            ]))

        var state = T3SubagentTaskActivityState()
        let item = state.apply(activity: progress, at: WireDate.parse(progress.createdAt)!)

        #expect(item?.id == "subagent-task:task-1")
        #expect(item?.latestProgress == nil)
        #expect(item?.state == .running)
        #expect(state.activeTaskIDs == Set(["task-1"]))
    }

    @Test func completionWithSummaryKeepsFinalSummary() {
        let completed = activity(
            id: "act-complete", kind: ActivityKind.taskCompleted,
            at: "2026-07-04T10:00:07.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "status": .string("completed"),
                "summary": .string("Refactored the log mapper"),
            ]))

        var state = T3SubagentTaskActivityState()
        let item = state.apply(activity: completed, at: WireDate.parse(completed.createdAt)!)

        #expect(item?.state == .completed)
        #expect(item?.completionSummary == "Refactored the log mapper")
        #expect(item?.latestProgress == "Refactored the log mapper")
        #expect(state.activeTaskIDs.isEmpty)
    }

    @Test func stoppedCompletionKeepsResultSummaryText() {
        let completed = activity(
            id: "act-complete", kind: ActivityKind.taskCompleted,
            at: "2026-07-04T10:00:07.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "status": .string("stopped"),
                "detail": .string("Interrupted while editing the mapper"),
            ]))

        var state = T3SubagentTaskActivityState()
        let item = state.apply(activity: completed, at: WireDate.parse(completed.createdAt)!)

        #expect(item?.state == .stopped)
        #expect(item?.completionSummary == "Interrupted while editing the mapper")
        #expect(state.activeTaskIDs.isEmpty)
    }

    @Test func rebuildLeavesMissingCompletedTaskRunning() throws {
        let state = T3SubagentTaskActivityState.rebuild(from: [
            activity(
                id: "act-start", kind: ActivityKind.taskStarted,
                at: "2026-07-04T10:00:00.000Z",
                payload: .object([
                    "taskId": .string("task-1"),
                    "description": .string("Investigate"),
                ])),
            activity(
                id: "act-progress", kind: ActivityKind.taskProgress,
                at: "2026-07-04T10:00:01.000Z",
                payload: .object([
                    "taskId": .string("task-1"),
                    "lastToolName": .string("Grep"),
                ])),
        ])

        #expect(state.activeTaskIDs == Set(["task-1"]))
        let item = try #require(state.items.first)
        #expect(item.state == .running)
        #expect(item.latestProgress == "Using Grep...")
    }

    @Test func completedWithoutStartedDoesNotRemainActive() {
        let completed = activity(
            id: "act-complete", kind: ActivityKind.taskCompleted,
            at: "2026-07-04T10:00:07.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "status": .string("failed"),
            ]))

        var state = T3SubagentTaskActivityState()
        let item = state.apply(activity: completed, at: WireDate.parse(completed.createdAt)!)

        #expect(item?.state == .failed)
        #expect(item?.duration == 0)
        #expect(state.activeTaskIDs.isEmpty)
    }

    @Test func lifecycleWithoutTaskIdsAggregatesIntoStartedTask() throws {
        let start = activity(
            id: "act-start", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:00.000Z",
            payload: .object([
                "taskType": .string("general-purpose"),
                "description": .string("Inspect timeline mapping"),
            ]))
        let progress = activity(
            id: "act-progress", kind: ActivityKind.taskProgress,
            at: "2026-07-04T10:00:03.000Z",
            payload: .object([
                "summary": .string("Scanning the timeline mapper"),
                "lastToolName": .string("Read"),
            ]))
        let completed = activity(
            id: "act-complete", kind: ActivityKind.taskCompleted,
            at: "2026-07-04T10:00:07.000Z",
            payload: .object([
                "status": .string("completed"),
                "summary": .string("Mapped the flow"),
            ]))

        var state = T3SubagentTaskActivityState()
        _ = state.apply(activity: start, at: WireDate.parse(start.createdAt)!)
        _ = state.apply(activity: progress, at: WireDate.parse(progress.createdAt)!)
        let finished = state.apply(activity: completed, at: WireDate.parse(completed.createdAt)!)

        #expect(state.items.count == 1)
        let item = try #require(state.items.first)
        #expect(finished?.id == item.id)
        #expect(item.id == "subagent-task:act-start")
        #expect(item.description == "Inspect timeline mapping")
        #expect(item.latestProgress == "Mapped the flow")
        #expect(item.lastToolName == "Read")
        #expect(item.state == .completed)
        #expect(item.duration == 7)
        #expect(state.activeTaskIDs.isEmpty)
    }
}
