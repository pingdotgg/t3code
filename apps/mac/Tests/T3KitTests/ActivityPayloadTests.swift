import Foundation
import Testing

@testable import T3Kit

// Fixtures mirror the server's ProviderRuntimeIngestion.ts projections and
// packages/contracts/src/providerRuntime.ts shapes.

@Suite("Typed activity payloads")
struct ActivityPayloadTests {
    private func activity(kind: String, payloadJSON: String) throws -> OrchestrationThreadActivity {
        let json = """
            {
              "id": "act-1",
              "tone": "info",
              "kind": "\(kind)",
              "summary": "s",
              "payload": \(payloadJSON),
              "createdAt": "2026-07-04T12:00:00.000Z"
            }
            """
        return try WireCoding.decoder.decode(
            OrchestrationThreadActivity.self, from: Data(json.utf8))
    }

    @Test("user-input.requested decodes questions with options and multiSelect default")
    func userInputRequested() throws {
        let activity = try activity(
            kind: ActivityKind.userInputRequested,
            payloadJSON: """
                {
                  "requestId": "req-9",
                  "questions": [
                    {
                      "id": "q1",
                      "header": "Sort",
                      "question": "Which order?",
                      "options": [
                        {"label": "A", "description": "first"},
                        {"label": "B"}
                      ]
                    },
                    {
                      "id": "q2",
                      "header": "Multi",
                      "question": "Pick many",
                      "options": [],
                      "multiSelect": true
                    }
                  ]
                }
                """)
        let payload = try #require(activity.decodePayload(UserInputRequestedActivityPayload.self))
        #expect(payload.requestId == "req-9")
        #expect(payload.questions.count == 2)
        #expect(payload.questions[0].multiSelect == false)
        #expect(payload.questions[0].options.count == 2)
        #expect(payload.questions[0].options[1].description == nil)
        #expect(payload.questions[1].multiSelect == true)
    }

    @Test("user-input.resolved decodes with and without requestId")
    func userInputResolved() throws {
        let with = try activity(
            kind: ActivityKind.userInputResolved,
            payloadJSON: #"{"requestId": "req-9", "answers": {"q1": "A"}}"#)
        #expect(with.decodePayload(UserInputResolvedActivityPayload.self)?.requestId == "req-9")

        let without = try activity(
            kind: ActivityKind.userInputResolved, payloadJSON: #"{"answers": {}}"#)
        let payload = try #require(without.decodePayload(UserInputResolvedActivityPayload.self))
        #expect(payload.requestId == nil)
    }

    @Test("turn.plan.updated decodes steps, tolerating unknown statuses")
    func turnPlanUpdated() throws {
        let activity = try activity(
            kind: ActivityKind.turnPlanUpdated,
            payloadJSON: """
                {
                  "plan": [
                    {"step": "one", "status": "completed"},
                    {"step": "two", "status": "inProgress"},
                    {"step": "three"},
                    {"step": "four", "status": "some-future-status"}
                  ],
                  "explanation": "why"
                }
                """)
        let payload = try #require(activity.decodePayload(TurnPlanUpdatedActivityPayload.self))
        #expect(payload.plan.count == 4)
        #expect(payload.plan[0].status == .completed)
        #expect(payload.plan[1].status == .inProgress)
        #expect(payload.plan[2].status == nil)
        #expect(payload.plan[3].status == nil)
        #expect(payload.explanation == "why")
    }

    @Test("context-window.updated decodes the meter fields")
    func contextWindowUpdated() throws {
        let activity = try activity(
            kind: ActivityKind.contextWindowUpdated,
            payloadJSON: """
                {
                  "usedTokens": 72000,
                  "maxTokens": 200000,
                  "inputTokens": 60000,
                  "outputTokens": 12000,
                  "compactsAutomatically": true,
                  "toolUses": 14
                }
                """)
        let payload = try #require(activity.decodePayload(ContextWindowUpdatedActivityPayload.self))
        #expect(payload.usedTokens == 72000)
        #expect(payload.maxTokens == 200000)
        #expect(payload.compactsAutomatically == true)
    }

    @Test("context-window.updated without maxTokens still decodes")
    func contextWindowNoMax() throws {
        let activity = try activity(
            kind: ActivityKind.contextWindowUpdated, payloadJSON: #"{"usedTokens": 10}"#)
        let payload = try #require(activity.decodePayload(ContextWindowUpdatedActivityPayload.self))
        #expect(payload.usedTokens == 10)
        #expect(payload.maxTokens == nil)
    }

    @Test("task.started decodes Claude SDK task fields")
    func taskStarted() throws {
        let activity = try activity(
            kind: ActivityKind.taskStarted,
            payloadJSON: """
                {
                  "taskId": "task-1",
                  "entityType": "subagent",
                  "taskType": "general-purpose",
                  "description": "Inspect timeline mapping",
                  "subagentType": "Explore",
                  "model": "claude-sonnet-4-5",
                  "workflowName": "spec",
                  "toolUseId": "toolu-1"
                }
                """)
        let payload = try #require(activity.decodePayload(TaskStartedActivityPayload.self))
        #expect(payload.taskId == "task-1")
        #expect(payload.entityType == "subagent")
        #expect(payload.taskType == "general-purpose")
        #expect(payload.description == "Inspect timeline mapping")
        #expect(payload.subagentType == "Explore")
        #expect(payload.model == "claude-sonnet-4-5")
        #expect(payload.workflowName == "spec")
        #expect(payload.toolUseId == "toolu-1")
    }

    @Test("task.started decodes legacy payloads without new identity fields")
    func taskStartedLegacy() throws {
        let activity = try activity(
            kind: ActivityKind.taskStarted,
            payloadJSON: """
                {
                  "taskId": "task-1",
                  "taskType": "general-purpose",
                  "description": "Inspect timeline mapping"
                }
                """)
        let payload = try #require(activity.decodePayload(TaskStartedActivityPayload.self))
        #expect(payload.taskId == "task-1")
        #expect(payload.subagentType == nil)
        #expect(payload.model == nil)
        #expect(payload.workflowName == nil)
        #expect(payload.toolUseId == nil)
    }

    @Test("task.progress decodes description, summary, last tool and usage")
    func taskProgress() throws {
        let activity = try activity(
            kind: ActivityKind.taskProgress,
            payloadJSON: """
                {
                  "taskId": "task-1",
                  "entityType": "command",
                  "description": "Inspect timeline mapping",
                  "summary": "Reading the mapper",
                  "lastToolName": "Read",
                  "subagentType": "Explore",
                  "toolUseId": "toolu-1",
                  "usage": {"input_tokens": 12, "output_tokens": 4}
                }
                """)
        let payload = try #require(activity.decodePayload(TaskProgressActivityPayload.self))
        #expect(payload.taskId == "task-1")
        #expect(payload.entityType == "command")
        #expect(payload.description == "Inspect timeline mapping")
        #expect(payload.summary == "Reading the mapper")
        #expect(payload.lastToolName == "Read")
        #expect(payload.subagentType == "Explore")
        #expect(payload.toolUseId == "toolu-1")
        #expect(payload.usage?["input_tokens"]?.intValue == 12)
    }

    @Test("task.updated decodes patch fields")
    func taskUpdated() throws {
        let activity = try activity(
            kind: ActivityKind.taskUpdated,
            payloadJSON: """
                {
                  "taskId": "task-1",
                  "status": "running",
                  "description": "Still going",
                  "error": "transient blip",
                  "isBackgrounded": true,
                  "endTime": 1710000000,
                  "totalPausedMs": 1200
                }
                """)
        let payload = try #require(activity.decodePayload(TaskUpdatedActivityPayload.self))
        #expect(payload.taskId == "task-1")
        #expect(payload.status == "running")
        #expect(payload.description == "Still going")
        #expect(payload.error == "transient blip")
        #expect(payload.isBackgrounded == true)
        #expect(payload.endTime == 1_710_000_000)
        #expect(payload.totalPausedMs == 1200)
    }

    @Test("task.completed decodes status, summary and usage")
    func taskCompleted() throws {
        let activity = try activity(
            kind: ActivityKind.taskCompleted,
            payloadJSON: """
                {
                  "taskId": "task-1",
                  "entityType": "command",
                  "status": "completed",
                  "summary": "Found the right mapping point",
                  "usage": {"input_tokens": 20},
                  "outputFile": "/tmp/out.txt"
                }
                """)
        let payload = try #require(activity.decodePayload(TaskCompletedActivityPayload.self))
        #expect(payload.taskId == "task-1")
        #expect(payload.entityType == "command")
        #expect(payload.status == "completed")
        #expect(payload.summary == "Found the right mapping point")
        #expect(payload.usage?["input_tokens"]?.intValue == 20)
        #expect(payload.outputFile == "/tmp/out.txt")
    }

    @Test("mismatched payload degrades to nil instead of throwing")
    func mismatchedPayload() throws {
        let activity = try activity(
            kind: ActivityKind.contextWindowUpdated, payloadJSON: #"{"unexpected": true}"#)
        #expect(activity.decodePayload(ContextWindowUpdatedActivityPayload.self) == nil)
    }

    @Test("mode-set command wrappers encode wire tags and modes")
    func modeSetCommands() throws {
        let runtime = ClientOrchestrationCommand.threadRuntimeModeSet(
            ThreadRuntimeModeSetCommand(
                commandId: "c1", threadId: "t1", runtimeMode: .approvalRequired,
                createdAt: "2026-07-04T12:00:00.000Z"))
        let runtimeJSON = try WireCoding.encoder.encode(runtime)
        let runtimeObject =
            try JSONSerialization.jsonObject(with: runtimeJSON) as? [String: Any] ?? [:]
        #expect(runtimeObject["type"] as? String == "thread.runtime-mode.set")
        #expect(runtimeObject["runtimeMode"] as? String == "approval-required")

        let interaction = ClientOrchestrationCommand.threadInteractionModeSet(
            ThreadInteractionModeSetCommand(
                commandId: "c2", threadId: "t1", interactionMode: .plan,
                createdAt: "2026-07-04T12:00:00.000Z"))
        let interactionJSON = try WireCoding.encoder.encode(interaction)
        let interactionObject =
            try JSONSerialization.jsonObject(with: interactionJSON) as? [String: Any] ?? [:]
        #expect(interactionObject["type"] as? String == "thread.interaction-mode.set")
        #expect(interactionObject["interactionMode"] as? String == "plan")
    }

    @Test("tool.completed decodes the typed skill presentation")
    func toolPresentationSkill() throws {
        let activity = try activity(
            kind: ActivityKind.toolCompleted,
            payloadJSON: """
                {
                  "itemType": "dynamic_tool_call",
                  "status": "completed",
                  "presentation": {
                    "surface": "skill",
                    "title": "Skill: cavecrew",
                    "subtitle": "review the diff",
                    "state": "succeeded",
                    "provenance": {
                      "origin": "plugin",
                      "toolName": "Skill",
                      "pluginName": "caveman",
                      "skillName": "cavecrew",
                      "displayName": "cavecrew",
                      "provider": "claudeAgent"
                    },
                    "inputs": [{ "label": "skill", "value": "caveman:cavecrew", "kind": "text" }],
                    "result": { "text": "done", "paths": [] }
                  }
                }
                """)
        let payload = activity.decodePayload(ToolLifecycleActivityPayload.self)
        let presentation = try #require(payload?.presentation)

        #expect(presentation.surface == .skill)
        #expect(presentation.title == "Skill: cavecrew")
        #expect(presentation.state == .succeeded)
        #expect(presentation.provenance.origin == .plugin)
        #expect(presentation.provenance.pluginName == "caveman")
        #expect(presentation.inputs.first?.value == "caveman:cavecrew")
        #expect(presentation.result?.text == "done")
    }

    @Test("an unknown surface or origin degrades to generic rather than failing the decode")
    func toolPresentationUnknownSurface() throws {
        let activity = try activity(
            kind: ActivityKind.toolCompleted,
            payloadJSON: """
                {
                  "itemType": "dynamic_tool_call",
                  "presentation": {
                    "surface": "holodeck",
                    "title": "AcmeDoThing",
                    "state": "warping",
                    "provenance": { "origin": "starfleet" },
                    "inputs": []
                  }
                }
                """)
        let presentation = try #require(
            activity.decodePayload(ToolLifecycleActivityPayload.self)?.presentation)

        #expect(presentation.surface == .generic)
        #expect(presentation.state == .running)
        #expect(presentation.provenance.origin == .unknown)
        #expect(presentation.title == "AcmeDoThing")
    }

    @Test("a tool payload without a presentation still decodes")
    func toolPresentationAbsent() throws {
        let activity = try activity(
            kind: ActivityKind.toolCompleted,
            payloadJSON: """
                { "itemType": "command_execution", "status": "completed", "detail": "ls" }
                """)
        let payload = try #require(activity.decodePayload(ToolLifecycleActivityPayload.self))

        #expect(payload.presentation == nil)
        #expect(payload.detail == "ls")
    }

    @Test("turn.start encodes sourceProposedPlan when present, omits when nil")
    func turnStartSourcePlan() throws {
        let command = ClientOrchestrationCommand.threadTurnStart(
            ThreadTurnStartCommand(
                commandId: "c3", threadId: "t1",
                message: ChatMessageInput(messageId: "m1", text: "go"),
                sourceProposedPlan: SourceProposedPlanReference(threadId: "t1", planId: "p1"),
                createdAt: "2026-07-04T12:00:00.000Z"))
        let json = try WireCoding.encoder.encode(command)
        let object = try JSONSerialization.jsonObject(with: json) as? [String: Any] ?? [:]
        let plan = object["sourceProposedPlan"] as? [String: Any]
        #expect(plan?["planId"] as? String == "p1")

        let bare = ClientOrchestrationCommand.threadTurnStart(
            ThreadTurnStartCommand(
                commandId: "c4", threadId: "t1",
                message: ChatMessageInput(messageId: "m2", text: "go"),
                createdAt: "2026-07-04T12:00:00.000Z"))
        let bareJSON = try WireCoding.encoder.encode(bare)
        let bareObject = try JSONSerialization.jsonObject(with: bareJSON) as? [String: Any] ?? [:]
        #expect(bareObject["sourceProposedPlan"] == nil)
    }
}
