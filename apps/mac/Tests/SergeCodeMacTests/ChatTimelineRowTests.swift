import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Chat timeline subagent row")
@MainActor
struct ChatTimelineRowTests {
    @Test("an empty task keeps hover actions available without expandable content")
    func emptyTaskHasNoExpandableContent() {
        let task = SubagentTaskItem(
            taskId: "task-empty", taskType: "explore", description: "No output yet",
            subagentType: "Explore", model: "claude-sonnet-5", state: .running,
            latestProgress: nil, error: nil, startedAt: Date(), duration: nil,
            progressLog: [])

        #expect(!SubagentTaskPresentation.hasExpandableContent(for: task, stopError: nil))
    }
}
