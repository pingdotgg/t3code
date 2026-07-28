import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Workflow task presentation")
@MainActor
struct WorkflowTaskPresentationTests {
    @Test("workflow chrome never describes the task as an agent")
    func workflowChromeUsesWorkflowLanguage() {
        let task = workflow()

        #expect(SubagentTaskPresentation.title(for: task) == "Workflow")
        #expect(
            SubagentTaskPresentation.entityIconName(for: task)
                == "point.3.connected.trianglepath.dotted")
        #expect(SubagentTaskPresentation.stopActionLabel(for: task) == "Stop workflow")
        #expect(
            SubagentTaskPresentation.identityBadge(for: task, modelDisplayNames: [:])
                == "review-changes")
    }

    @Test("workflow description remains the card title")
    func workflowDescriptionWins() {
        var task = workflow()
        task.description = "Review and repair the connector"

        #expect(
            SubagentTaskPresentation.title(for: task)
                == "Review and repair the connector")
    }

    private func workflow() -> SubagentTaskItem {
        SubagentTaskItem(
            taskId: "workflow-1",
            taskType: "local_workflow",
            entityKind: .workflow,
            description: nil,
            workflowName: "review-changes",
            state: .running,
            latestProgress: nil,
            startedAt: Date(timeIntervalSince1970: 1_000),
            duration: nil)
    }
}
