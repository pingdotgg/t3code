import Testing

@testable import T3Kit

@Suite("ActivityRows derivation")
struct ActivityRowTests {
    private func activity(
        id: String = "a1", tone: OrchestrationThreadActivityTone = .tool, kind: String,
        summary: String, payload: JSONValue = .null
    ) -> OrchestrationThreadActivity {
        OrchestrationThreadActivity(
            id: id, tone: tone, kind: kind, summary: summary, payload: payload,
            createdAt: "2026-07-04T10:00:00.000Z")
    }

    // MARK: Lifecycle noise

    @Test func toolStartedIsSkipped() {
        let row = ActivityRows.row(
            for: activity(kind: "tool.started", summary: "Read started"))
        #expect(row == nil)
    }

    @Test func taskStartedIsSkipped() {
        let row = ActivityRows.row(
            for: activity(
                tone: .info, kind: "task.started", summary: "local_agent task started"))
        #expect(row == nil)
    }

    @Test func checkpointCapturedNoticeIsSkipped() {
        let row = ActivityRows.row(
            for: activity(tone: .info, kind: "checkpoint", summary: "Checkpoint captured"))
        #expect(row == nil)
    }

    // MARK: Tool lifecycle

    @Test func toolUpdatedUsesSummaryAsTitleAndPayloadDetail() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.updated", summary: "Read",
                payload: .object([
                    "itemType": .string("file_read"),
                    "status": .string("inProgress"),
                    "detail": .string("Sources/App/Main.swift"),
                ])))
        #expect(row == .tool(id: "a1", title: "Read", detail: "Sources/App/Main.swift", phase: .running))
    }

    @Test func toolLifecycleSharesRowIdViaToolCallId() {
        let updated = ActivityRows.row(
            for: activity(
                id: "a1", kind: "tool.updated", summary: "Bash",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "data": .object(["toolCallId": .string("call-7")]),
                ])))
        let completed = ActivityRows.row(
            for: activity(
                id: "a2", kind: "tool.completed", summary: "Bash",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "data": .object(["toolCallId": .string("call-7")]),
                ])))
        #expect(updated == .tool(id: "tool:call-7", title: "Bash", detail: "", phase: .running))
        #expect(completed == .tool(id: "tool:call-7", title: "Bash", detail: "", phase: .succeeded))
    }

    @Test func toolCompletedStripsExitCodeMarkerAndCompletedSuffix() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Terminal completed",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "detail": .string("swift build <exited with exit code 0>"),
                ])))
        #expect(row == .tool(id: "a1", title: "Terminal", detail: "swift build", phase: .succeeded))
    }

    @Test func toolFailureStatusMapsToFailedPhase() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.updated", summary: "Edit",
                payload: .object(["status": .string("failed")])))
        #expect(row == .tool(id: "a1", title: "Edit", detail: "", phase: .failed))
    }

    @Test func emptySummaryFallsBackToHumanizedItemType() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.updated", summary: "",
                payload: .object(["itemType": .string("web_search")])))
        #expect(row == .tool(id: "a1", title: "Web search", detail: "", phase: .running))
    }

    @Test func detailDuplicatingTitleIsDropped() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Read file",
                payload: .object(["detail": .string("  read   FILE ")])))
        #expect(row == .tool(id: "a1", title: "Read file", detail: "", phase: .succeeded))
    }

    // MARK: Task progress / completion

    @Test func taskProgressSurfacesReasoningTextWithStableId() {
        let row = ActivityRows.row(
            for: activity(
                tone: .info, kind: "task.progress", summary: "Reasoning update",
                payload: .object([
                    "taskId": .string("task-1"),
                    "summary": .string("Scanning the timeline mapper"),
                ])))
        #expect(row == .reasoning(id: "task:task-1:reasoning", text: "Scanning the timeline mapper"))
    }

    @Test func taskProgressWithoutTextIsSkipped() {
        let row = ActivityRows.row(
            for: activity(
                tone: .info, kind: "task.progress", summary: "Reasoning update",
                payload: .object(["taskId": .string("task-1"), "detail": .string("  ")])))
        #expect(row == nil)
    }

    @Test func successfulTaskCompletionWithoutSummaryIsSkipped() {
        let row = ActivityRows.row(
            for: activity(
                tone: .info, kind: "task.completed", summary: "Task completed",
                payload: .object(["taskId": .string("task-1"), "status": .string("completed")])))
        #expect(row == nil)
    }

    @Test func taskCompletionWithSummaryBecomesExpandableRow() {
        let row = ActivityRows.row(
            for: activity(
                tone: .info, kind: "task.completed", summary: "Task completed",
                payload: .object([
                    "status": .string("completed"),
                    "detail": .string("Refactored the log mapper"),
                ])))
        #expect(
            row == .tool(id: "a1", title: "Task completed", detail: "Refactored the log mapper", phase: .succeeded))
    }

    @Test func failedTaskCompletionAlwaysSurfacesAsFailedRow() {
        let row = ActivityRows.row(
            for: activity(
                tone: .error, kind: "task.completed", summary: "Task failed",
                payload: .object(["status": .string("failed")])))
        #expect(row == .tool(id: "a1", title: "Task failed", detail: "", phase: .failed))
    }

    // MARK: Tone fallbacks

    @Test func errorToneUsesSummaryAsTitleAndPayloadMessageAsDetail() {
        let row = ActivityRows.row(
            for: activity(
                tone: .error, kind: "turn.error", summary: "Turn failed",
                payload: .object(["message": .string("provider crashed")])))
        #expect(row == .tool(id: "a1", title: "Turn failed", detail: "provider crashed", phase: .failed))
    }

    @Test func infoToneBecomesNotice() {
        let row = ActivityRows.row(
            for: activity(tone: .info, kind: "system-message", summary: "Session resumed"))
        #expect(row == .notice(id: "a1", text: "Session resumed"))
    }
}
