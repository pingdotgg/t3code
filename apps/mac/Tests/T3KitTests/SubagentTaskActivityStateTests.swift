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

    // MARK: - Progress log

    @Test func progressLogAccumulatesInOrder() throws {
        let start = activity(
            id: "act-start", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:00.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "description": .string("Investigate"),
            ]))
        let p1 = activity(
            id: "act-p1", kind: ActivityKind.taskProgress,
            at: "2026-07-04T10:00:02.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "summary": .string("Reading files"),
                "lastToolName": .string("Read"),
            ]))
        let p2 = activity(
            id: "act-p2", kind: ActivityKind.taskProgress,
            at: "2026-07-04T10:00:04.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "summary": .string("Searching symbols"),
                "lastToolName": .string("Grep"),
            ]))
        let p3 = activity(
            id: "act-p3", kind: ActivityKind.taskProgress,
            at: "2026-07-04T10:00:06.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "detail": .string("Still thinking"),
            ]))

        var state = T3SubagentTaskActivityState()
        _ = state.apply(activity: start, at: WireDate.parse(start.createdAt)!)
        _ = state.apply(activity: p1, at: WireDate.parse(p1.createdAt)!)
        _ = state.apply(activity: p2, at: WireDate.parse(p2.createdAt)!)
        let item = state.apply(activity: p3, at: WireDate.parse(p3.createdAt)!)

        let log = try #require(item?.progressLog)
        #expect(log.count == 3)
        #expect(log[0].text == "Reading files")
        #expect(log[0].toolName == "Read")
        #expect(log[0].at == WireDate.parse(p1.createdAt))
        #expect(log[1].text == "Searching symbols")
        #expect(log[1].toolName == "Grep")
        #expect(log[2].text == "Still thinking")
        #expect(log[2].toolName == nil)
    }

    @Test func progressLogDedupesConsecutiveDuplicates() throws {
        let p1 = activity(
            id: "act-p1", kind: ActivityKind.taskProgress,
            at: "2026-07-04T10:00:01.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "summary": .string("Reading files"),
                "lastToolName": .string("Read"),
            ]))
        // Same tool + text — should be dropped.
        let p2 = activity(
            id: "act-p2", kind: ActivityKind.taskProgress,
            at: "2026-07-04T10:00:02.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "summary": .string("Reading files"),
                "lastToolName": .string("Read"),
            ]))
        // Same text, different tool — kept.
        let p3 = activity(
            id: "act-p3", kind: ActivityKind.taskProgress,
            at: "2026-07-04T10:00:03.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "summary": .string("Reading files"),
                "lastToolName": .string("Grep"),
            ]))
        // Whitespace-only — no entry.
        let p4 = activity(
            id: "act-p4", kind: ActivityKind.taskProgress,
            at: "2026-07-04T10:00:04.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "summary": .string("  "),
                "lastToolName": .string("Grep"),
            ]))

        var state = T3SubagentTaskActivityState()
        _ = state.apply(activity: p1, at: WireDate.parse(p1.createdAt)!)
        _ = state.apply(activity: p2, at: WireDate.parse(p2.createdAt)!)
        _ = state.apply(activity: p3, at: WireDate.parse(p3.createdAt)!)
        let item = state.apply(activity: p4, at: WireDate.parse(p4.createdAt)!)

        let log = try #require(item?.progressLog)
        #expect(log.count == 2)
        #expect(log[0].toolName == "Read")
        #expect(log[1].toolName == "Grep")
        #expect(log.map(\.text) == ["Reading files", "Reading files"])
    }

    @Test func progressLogCapsAtMaxEntriesDroppingOldest() throws {
        var state = T3SubagentTaskActivityState()
        let max = T3SubagentTaskItem.maxProgressLogEntries
        let total = max + 25
        for i in 0..<total {
            let act = activity(
                id: "act-p-\(i)", kind: ActivityKind.taskProgress,
                at: "2026-07-04T10:00:\(String(format: "%02d", i % 60)).000Z",
                payload: .object([
                    "taskId": .string("task-1"),
                    "summary": .string("step-\(i)"),
                ]),
                sequence: i)
            // Spread timestamps so WireDate order stays unique enough with sequence.
            let at = Date(timeIntervalSince1970: 1_720_000_000 + Double(i))
            _ = state.apply(activity: act, at: at)
        }

        let item = try #require(state.items.first)
        #expect(item.progressLog.count == max)
        #expect(item.progressLog.first?.text == "step-\(total - max)")
        #expect(item.progressLog.last?.text == "step-\(total - 1)")
    }

    @Test func completionAppendsFinalLogEntryWhenNew() throws {
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
        _ = state.apply(activity: progress, at: WireDate.parse(progress.createdAt)!)
        let finished = state.apply(activity: completed, at: WireDate.parse(completed.createdAt)!)

        let log = try #require(finished?.progressLog)
        #expect(log.count == 2)
        #expect(log[0].text == "Reading files")
        #expect(log[1].text == "Mapped the flow")
        #expect(log[1].at == WireDate.parse(completed.createdAt))
    }

    @Test func completionDoesNotDuplicateIdenticalFinalEntry() throws {
        let progress = activity(
            id: "act-progress", kind: ActivityKind.taskProgress,
            at: "2026-07-04T10:00:03.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "summary": .string("Done already"),
            ]))
        let completed = activity(
            id: "act-complete", kind: ActivityKind.taskCompleted,
            at: "2026-07-04T10:00:07.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "status": .string("completed"),
                "summary": .string("Done already"),
            ]))

        var state = T3SubagentTaskActivityState()
        _ = state.apply(activity: progress, at: WireDate.parse(progress.createdAt)!)
        let finished = state.apply(activity: completed, at: WireDate.parse(completed.createdAt)!)

        #expect(finished?.progressLog.count == 1)
        #expect(finished?.progressLog.first?.text == "Done already")
    }

    @Test func completionDoesNotDuplicateIdenticalTextWhenLastEntryHadToolBadge() throws {
        let progress = activity(
            id: "act-progress", kind: ActivityKind.taskProgress,
            at: "2026-07-04T10:00:03.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "summary": .string("Done already"),
                "lastToolName": .string("Read"),
            ]))
        let completed = activity(
            id: "act-complete", kind: ActivityKind.taskCompleted,
            at: "2026-07-04T10:00:07.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "status": .string("completed"),
                "summary": .string("Done already"),
            ]))

        var state = T3SubagentTaskActivityState()
        _ = state.apply(activity: progress, at: WireDate.parse(progress.createdAt)!)
        let finished = state.apply(activity: completed, at: WireDate.parse(completed.createdAt)!)

        #expect(finished?.progressLog.count == 1)
        #expect(finished?.progressLog.first?.text == "Done already")
        #expect(finished?.progressLog.first?.toolName == "Read")
    }

    @Test func rebuildProducesSameProgressLogAsIncrementalApply() throws {
        let activities = [
            activity(
                id: "act-start", kind: ActivityKind.taskStarted,
                at: "2026-07-04T10:00:00.000Z",
                payload: .object([
                    "taskId": .string("task-1"),
                    "taskType": .string("explore"),
                    "description": .string("Find the mapper"),
                ]),
                sequence: 1),
            activity(
                id: "act-p1", kind: ActivityKind.taskProgress,
                at: "2026-07-04T10:00:02.000Z",
                payload: .object([
                    "taskId": .string("task-1"),
                    "summary": .string("Opening files"),
                    "lastToolName": .string("Read"),
                ]),
                sequence: 2),
            // Duplicate — should be dropped in both paths.
            activity(
                id: "act-p1b", kind: ActivityKind.taskProgress,
                at: "2026-07-04T10:00:02.500Z",
                payload: .object([
                    "taskId": .string("task-1"),
                    "summary": .string("Opening files"),
                    "lastToolName": .string("Read"),
                ]),
                sequence: 3),
            activity(
                id: "act-p2", kind: ActivityKind.taskProgress,
                at: "2026-07-04T10:00:04.000Z",
                payload: .object([
                    "taskId": .string("task-1"),
                    "summary": .string("Grepping"),
                    "lastToolName": .string("Grep"),
                ]),
                sequence: 4),
            activity(
                id: "act-complete", kind: ActivityKind.taskCompleted,
                at: "2026-07-04T10:00:08.000Z",
                payload: .object([
                    "taskId": .string("task-1"),
                    "status": .string("completed"),
                    "summary": .string("Found it"),
                ]),
                sequence: 5),
        ]

        var incremental = T3SubagentTaskActivityState()
        for act in activities {
            _ = incremental.apply(activity: act, at: WireDate.parse(act.createdAt)!)
        }
        let rebuilt = T3SubagentTaskActivityState.rebuild(from: activities.shuffled())

        let left = try #require(incremental.items.first)
        let right = try #require(rebuilt.items.first)
        #expect(left.progressLog == right.progressLog)
        #expect(left.progressLog.map(\.text) == ["Opening files", "Grepping", "Found it"])
        #expect(left.state == right.state)
        #expect(left.completionSummary == right.completionSummary)
        #expect(left.latestProgress == right.latestProgress)
        #expect(left.duration == right.duration)
    }

    @Test func startedStoresIdentityMetadata() {
        let started = activity(
            id: "act-start", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:00.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "taskType": .string("local_agent"),
                "description": .string("Explore auth"),
                "subagentType": .string("Explore"),
                "model": .string("claude-opus-4-6"),
                "effort": .string("xhigh"),
                "workflowName": .string("spec"),
                "toolUseId": .string("toolu-1"),
            ]))

        var state = T3SubagentTaskActivityState()
        let item = state.apply(activity: started, at: WireDate.parse(started.createdAt)!)

        #expect(item?.subagentType == "Explore")
        #expect(item?.model == "claude-opus-4-6")
        #expect(item?.effort == "xhigh")
        #expect(item?.workflowName == "spec")
        #expect(item?.toolUseId == "toolu-1")
    }

    @Test func taskUpdatedAppliesModelAndPreservesWhenOmitted() {
        let started = activity(
            id: "act-start", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:00.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "description": .string("Explore without model yet"),
            ]))
        let modelUpdate = activity(
            id: "act-model", kind: ActivityKind.taskUpdated,
            at: "2026-07-04T10:00:03.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "model": .string("grok-4-5"),
            ]))
        let statusOnly = activity(
            id: "act-status", kind: ActivityKind.taskUpdated,
            at: "2026-07-04T10:00:05.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "status": .string("running"),
                "isBackgrounded": .bool(true),
            ]))

        var state = T3SubagentTaskActivityState()
        let initial = state.apply(activity: started, at: WireDate.parse(started.createdAt)!)
        #expect(initial?.model == nil)

        let withModel = state.apply(activity: modelUpdate, at: WireDate.parse(modelUpdate.createdAt)!)
        #expect(withModel?.model == "grok-4-5")

        let preserved = state.apply(activity: statusOnly, at: WireDate.parse(statusOnly.createdAt)!)
        #expect(preserved?.model == "grok-4-5")
        #expect(preserved?.isBackgrounded == true)
        #expect(preserved?.state == .running)
    }

    @Test func taskUpdatedPatchesBackgroundErrorAndTerminalStatus() {
        let started = activity(
            id: "act-start", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:00.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "description": .string("Long runner"),
            ]))
        let updated = activity(
            id: "act-updated", kind: ActivityKind.taskUpdated,
            at: "2026-07-04T10:00:05.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "status": .string("running"),
                "isBackgrounded": .bool(true),
                "error": .string("soft warning"),
            ]))
        let terminal = activity(
            id: "act-terminal", kind: ActivityKind.taskUpdated,
            at: "2026-07-04T10:00:09.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "status": .string("killed"),
                "error": .string("aborted by host"),
            ]))

        var state = T3SubagentTaskActivityState()
        _ = state.apply(activity: started, at: WireDate.parse(started.createdAt)!)
        let running = state.apply(activity: updated, at: WireDate.parse(updated.createdAt)!)
        #expect(running?.isBackgrounded == true)
        #expect(running?.error == "soft warning")
        #expect(running?.state == .running)
        #expect(state.activeTaskIDs == Set(["task-1"]))

        let finished = state.apply(activity: terminal, at: WireDate.parse(terminal.createdAt)!)
        #expect(finished?.state == .stopped)
        #expect(finished?.error == "aborted by host")
        #expect(finished?.completionSummary == "aborted by host")
        #expect(state.activeTaskIDs.isEmpty)
    }

    @Test func taskUpdatedPausedIsNonTerminalAndNotActive() {
        let started = activity(
            id: "act-start", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:00.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "description": .string("Long runner"),
            ]))
        let paused = activity(
            id: "act-paused", kind: ActivityKind.taskUpdated,
            at: "2026-07-04T10:00:05.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "status": .string("paused"),
            ]))
        let resumed = activity(
            id: "act-resumed", kind: ActivityKind.taskUpdated,
            at: "2026-07-04T10:00:08.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "status": .string("running"),
            ]))

        var state = T3SubagentTaskActivityState()
        _ = state.apply(activity: started, at: WireDate.parse(started.createdAt)!)
        #expect(state.activeTaskIDs == Set(["task-1"]))

        let pausedItem = state.apply(activity: paused, at: WireDate.parse(paused.createdAt)!)
        #expect(pausedItem?.state == .paused)
        #expect(pausedItem?.completedAt == nil)
        #expect(state.activeTaskIDs.isEmpty)

        let runningItem = state.apply(activity: resumed, at: WireDate.parse(resumed.createdAt)!)
        #expect(runningItem?.state == .running)
        #expect(runningItem?.completedAt == nil)
        #expect(state.activeTaskIDs == Set(["task-1"]))
    }

    @Test func terminalTaskUpdatedDoesNotFlipAlreadyCompletedState() {
        let started = activity(
            id: "act-start", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:00.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "description": .string("Review"),
            ]))
        let completed = activity(
            id: "act-done", kind: ActivityKind.taskCompleted,
            at: "2026-07-04T10:00:08.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "status": .string("completed"),
                "summary": .string("All good"),
            ]))
        // Late/coalesced terminal patch must not overwrite completed → stopped.
        let lateTerminal = activity(
            id: "act-late", kind: ActivityKind.taskUpdated,
            at: "2026-07-04T10:00:09.000Z",
            payload: .object([
                "taskId": .string("task-1"),
                "status": .string("killed"),
                "error": .string("stale stop race"),
                "isBackgrounded": .bool(true),
            ]))

        var state = T3SubagentTaskActivityState()
        _ = state.apply(activity: started, at: WireDate.parse(started.createdAt)!)
        let done = state.apply(activity: completed, at: WireDate.parse(completed.createdAt)!)
        #expect(done?.state == .completed)
        #expect(done?.completionSummary == "All good")

        let afterLate = state.apply(
            activity: lateTerminal, at: WireDate.parse(lateTerminal.createdAt)!)
        #expect(afterLate?.state == .completed)
        #expect(afterLate?.completedAt == done?.completedAt)
        // Non-state fields still fold.
        #expect(afterLate?.isBackgrounded == true)
        #expect(afterLate?.error == "stale stop race")
        #expect(afterLate?.completionSummary == "All good")
    }

    @Test("explicit entity type maps command and workflow tasks")
    func explicitEntityTypeMapping() throws {
        let command = activity(
            id: "act-command", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:00.000Z",
            payload: .object([
                "taskId": .string("command-1"),
                "entityType": .string("command"),
                "taskType": .string("local_bash"),
            ]))
        let workflow = activity(
            id: "act-workflow", kind: ActivityKind.taskStarted,
            at: "2026-07-04T10:00:01.000Z",
            payload: .object([
                "taskId": .string("workflow-1"),
                "entityType": .string("workflow"),
            ]))

        var state = T3SubagentTaskActivityState()
        let commandResult = state.apply(activity: command, at: WireDate.parse(command.createdAt)!)
        let workflowResult = state.apply(
            activity: workflow, at: WireDate.parse(workflow.createdAt)!)
        let commandItem = try #require(commandResult)
        let workflowItem = try #require(workflowResult)

        #expect(commandItem.entityKind == .command)
        #expect(workflowItem.entityKind == .workflow)
    }

    @Test("legacy task types infer command kind when entity type is absent")
    func legacyCommandTaskTypeFallback() throws {
        let commandTypes = ["local_bash", "bash", "command", "command_execution"]

        for (index, taskType) in commandTypes.enumerated() {
            let started = activity(
                id: "act-legacy-\(index)", kind: ActivityKind.taskStarted,
                at: "2026-07-04T10:00:0\(index).000Z",
                payload: .object([
                    "taskId": .string("legacy-\(index)"),
                    "taskType": .string(taskType),
                ]))
            var state = T3SubagentTaskActivityState()
            let result = state.apply(activity: started, at: WireDate.parse(started.createdAt)!)
            let item = try #require(result)
            #expect(item.entityKind == .command)
        }

        #expect(T3SubagentTaskEntityKind(nil, taskType: "general-purpose") == .subagent)
        #expect(T3SubagentTaskEntityKind(nil, taskType: nil) == .subagent)
    }
}
