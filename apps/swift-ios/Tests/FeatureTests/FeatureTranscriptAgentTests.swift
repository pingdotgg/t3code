import Foundation
import Testing
@testable import T3Code

@Suite("Transcript child thread links")
@MainActor
struct FeatureTranscriptAgentTests {
    @Test
    func completedRowWithoutRosterScopesChildToItsEnvironment() throws {
        let item = try workItem(subagentItem())
        let first = try #require(item.threadAgent(environmentID: "first", agents: []))
        let second = try #require(item.threadAgent(environmentID: "second", agents: []))
        #expect(first.childThreadID == FeatureScopedID.thread(environmentID: "first", wireID: "child"))
        #expect(second.childThreadID == FeatureScopedID.thread(environmentID: "second", wireID: "child"))
        #expect(first.childThreadID != second.childThreadID)
        #expect(first.status == .completed)
        #expect(first.runID == "old-run")
        #expect(first.detail == "Finished")
    }

    @Test
    func localRowUsesLiveAgentEvenOutsideCurrentRoster() throws {
        let raw = subagentItem()
        let snapshot = V2Fixture.snapshot(items: [raw], fields: [
            "runs": .array([V2Fixture.run("current", status: "running")]),
            "subagents": .array([liveAgent()]),
        ])
        let workflows = try FeatureThreadWorkflows(
            projection: #require(snapshot["projection"]), environmentID: "remote"
        )
        #expect(workflows.agentRoster == nil)
        let resolved = try #require(workItem(raw).threadAgent(environmentID: "remote", agents: workflows.agents))
        #expect(resolved == workflows.agents.first)
        #expect(resolved.childThreadID == FeatureScopedID.thread(environmentID: "remote", wireID: "live-child"))
        #expect(resolved.status == .waiting)
        #expect(resolved.detail == "Waiting for input")
    }

    @Test
    func inheritedRowDoesNotUseLocalAgentWithSameID() throws {
        let raw = V2Fixture.patch(subagentItem(), ["threadId": .string("source")])
        let item = try workItem(raw, visibility: "inherited")
        let live = try FeatureThreadAgent(OrchestrationV2Subagent(json: liveAgent()), environmentID: "remote")
        let resolved = try #require(item.threadAgent(environmentID: "remote", agents: [live]))
        #expect(resolved.childThreadID == FeatureScopedID.thread(environmentID: "remote", wireID: "child"))
        #expect(resolved.status == .completed)
        #expect(resolved.detail == "Finished")
    }

    @Test
    func providerAgentWithoutChildHasNoNavigationTarget() throws {
        let item = try workItem(V2Fixture.patch(subagentItem(), ["childThreadId": .null]))
        #expect(try #require(item.threadAgent(environmentID: "remote", agents: [])).childThreadID == nil)
        let live = try FeatureThreadAgent(OrchestrationV2Subagent(json: V2Fixture.patch(liveAgent(), [
            "childThreadId": .null,
        ])), environmentID: "remote")
        #expect(try #require(item.threadAgent(environmentID: "remote", agents: [live])).childThreadID == nil)
    }

    @Test
    func transcriptKeepsAgentVisibleThroughFoldingAndPatchesItsDelta() throws {
        let agent = subagentItem()
        let command = V2Fixture.item("command", type: "command_execution", ordinal: 2, fields: [
            "runId": .string("old-run"), "input": .string("ls"), "output": .string("done"),
            "status": .string("completed"),
        ])
        let replies = ["first", "last"].enumerated().map { index, id in
            V2Fixture.patch(V2Fixture.assistant(id, ordinal: index == 0 ? 1 : 4), [
                "runId": .string("old-run"), "status": .string("completed"), "streaming": .bool(false),
            ])
        }
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(
            items: [replies[0], command, agent, replies[1]],
            fields: ["runs": .array([V2Fixture.run("old-run", status: "completed")])]
        ))
        let renderer = FeatureV2TimelineRenderer()
        let initial = state.normalizedSnapshot().thread
        let messages = renderer.update(thread: initial, changedMessages: nil, changedActivities: nil,
            mapMessage: { FeatureMessage(id: $0.id, role: .assistant, text: $0.text) }, date: { _ in .distantPast })
        let row = try #require(messages.first { $0.v2Timeline?.itemType == "subagent" })
        #expect(row.v2WorkItems?.count == 1)
        let folded = FeatureV2TurnFolding.messages(messages, expandedIDs: [])
        #expect(folded.contains { $0.id == row.id })
        #expect(folded.contains { $0.v2FoldID != nil })

        let updated = V2Fixture.patch(agent, ["childThreadId": .string("updated-child"), "result": .string("Updated result")])
        _ = state.apply([V2Fixture.event("turn-item.updated", payload: updated, sequence: 11)])
        let next = state.normalizedSnapshot().thread
        let patched = renderer.update(thread: next, changedMessages: [], changedActivities: next.activities,
            mapMessage: { FeatureMessage(id: $0.id, role: .assistant, text: $0.text) }, date: { _ in .distantPast })
        #expect(!renderer.rebuilt)
        #expect(renderer.changedMessageIDs == [row.id])
        #expect(patched.map(\.id) == messages.map(\.id))
        let item = try #require(patched.first { $0.id == row.id }?.v2WorkItems?.first)
        let resolved = try #require(item.threadAgent(environmentID: "remote", agents: []))
        #expect(resolved.childThreadID == FeatureScopedID.thread(environmentID: "remote", wireID: "updated-child"))
        #expect(resolved.detail == "Updated result")
    }

    @Test
    func workflowProgressInvalidatesOnlyItsLocalAgentRow() throws {
        let local = try transcriptMessage(subagentItem())
        let inherited = try transcriptMessage(
            V2Fixture.patch(subagentItem(), ["threadId": .string("source")]), visibility: "inherited"
        )
        let other = try transcriptMessage(V2Fixture.patch(subagentItem(), [
            "id": .string("other-item"), "subagentId": .string("other"),
        ]))
        let answer = completedAnswer("answer")
        let messages = [FeatureMessage(id: "user", role: .user, text: "Question"),
                        try transcriptMessage(answer), local, inherited, other]
        let otherAgent = V2Fixture.patch(liveAgent(), ["id": .string("other")])
        var state = FeatureTranscriptWorkflowState()
        _ = state.update(messages: messages,
            workflows: try workflows(items: [answer], agents: [liveAgent(), otherAgent]),
            environmentID: "remote", isWorkflowBusy: false)
        let progress = V2Fixture.patch(liveAgent(), [
            "progress": .string("Reviewing the next file"), "updatedAt": .string("2026-09-01T12:01:00.000Z"),
        ])
        let updated = try workflows(items: [answer], agents: [progress, otherAgent])
        #expect(state.update(messages: messages, workflows: updated,
            environmentID: "remote", isWorkflowBusy: false) == [local.id])
        #expect(state.update(messages: messages, workflows: updated,
            environmentID: "remote", isWorkflowBusy: false).isEmpty)

        // An unshown agent and a new active roster must not invalidate these rows.
        let unrelated = try workflows(items: [answer], agents: [progress, otherAgent,
            V2Fixture.patch(liveAgent(), ["id": .string("unshown"), "runId": .string("new-run")])],
            runs: [V2Fixture.run("new-run")])
        #expect(updated != unrelated)
        #expect(state.update(messages: messages, workflows: unrelated,
            environmentID: "remote", isWorkflowBusy: false).isEmpty)
    }

    @Test
    func forkChangesInvalidateOnlyButtonsThatChangeAndNeverFoldHeaders() throws {
        let answer = completedAnswer("answer")
        let otherAnswer = completedAnswer("other-answer")
        let reply = try transcriptMessage(answer)
        let otherReply = try transcriptMessage(otherAnswer)
        var fold = FeatureMessage(id: "fold", role: .system, text: "Worked")
        fold.v2Timeline = reply.v2Timeline
        fold.v2FoldID = "fold"
        let messages = [reply, fold, otherReply, FeatureMessage(id: "legacy", role: .assistant, text: "Old reply")]
        let available = try workflows(items: [answer, otherAnswer])
        var state = FeatureTranscriptWorkflowState()
        _ = state.update(messages: messages, workflows: available,
            environmentID: "remote", isWorkflowBusy: false)
        #expect(state.update(messages: messages, workflows: available,
            environmentID: "remote", isWorkflowBusy: true) == [reply.id, otherReply.id])

        let removed = try workflows(items: [otherAnswer])
        #expect(state.update(messages: messages, workflows: removed,
            environmentID: "remote", isWorkflowBusy: true) == [reply.id])
        #expect(state.update(messages: messages, workflows: removed,
            environmentID: "remote", isWorkflowBusy: false) == [otherReply.id])
        #expect(state.update(messages: messages, workflows: available,
            environmentID: "remote", isWorkflowBusy: false) == [reply.id])

        // Hiding a reply updates the cache without reporting a removed collection ID.
        #expect(state.update(messages: [fold, otherReply], workflows: available,
            environmentID: "remote", isWorkflowBusy: false).isEmpty)
        #expect(state.update(messages: messages, workflows: available,
            environmentID: "remote", isWorkflowBusy: false) == [reply.id])
    }

    @Test
    func workflowInvalidationTracksLiveFallbackAndScopedChildChanges() throws {
        let row = try transcriptMessage(subagentItem())
        let messages = [row]
        let historical = try workflows()
        let live = try workflows(agents: [liveAgent()])
        var state = FeatureTranscriptWorkflowState()
        _ = state.update(messages: messages, workflows: historical,
            environmentID: "remote", isWorkflowBusy: false)
        #expect(state.update(messages: messages, workflows: live,
            environmentID: "remote", isWorkflowBusy: false) == [row.id])
        #expect(state.update(messages: messages, workflows: historical,
            environmentID: "remote", isWorkflowBusy: false) == [row.id])
        #expect(state.update(messages: messages, workflows: historical,
            environmentID: "another", isWorkflowBusy: false) == [row.id])
        #expect(state.update(messages: messages, workflows: historical,
            environmentID: nil, isWorkflowBusy: false) == [row.id])
        #expect(state.update(messages: messages, workflows: historical,
            environmentID: "remote", isWorkflowBusy: false) == [row.id])
    }

    private func workflows(
        items: [JSONValue] = [], agents: [JSONValue] = [], runs: [JSONValue] = []
    ) throws -> FeatureThreadWorkflows {
        let snapshot = V2Fixture.snapshot(items: items, fields: [
            "subagents": .array(agents), "runs": .array(runs),
        ])
        return try FeatureThreadWorkflows(projection: #require(snapshot["projection"]), environmentID: "remote")
    }

    private func completedAnswer(_ id: String) -> JSONValue {
        V2Fixture.patch(V2Fixture.assistant(id, ordinal: 1), [
            "status": .string("completed"), "streaming": .bool(false),
        ])
    }

    private func transcriptMessage(_ raw: JSONValue, visibility: String = "local") throws -> FeatureMessage {
        let item = try workItem(raw, visibility: visibility)
        var message = FeatureMessage(id: item.id,
            role: item.source.itemType == "assistant_message" ? .assistant : .tool,
            text: raw["text"]?.stringValue ?? item.title)
        message.v2Timeline = item.source
        if message.role == .tool { message.v2WorkItems = [item] }
        return message
    }

    private func workItem(_ raw: JSONValue, visibility: String = "local") throws -> FeatureV2WorkItem {
        let row = try V2Fixture.row(raw, visibility: visibility).decode(OrchestrationV2ProjectedTurnItem.self)
        return FeatureV2WorkItem(source: OrchestrationV2TimelineMetadata(row), raw: raw)
    }

    private func subagentItem() -> JSONValue {
        V2Fixture.item("agent-item", type: "subagent", ordinal: 3, fields: [
            "runId": .string("old-run"), "subagentId": .string("agent"), "childThreadId": .string("child"),
            "origin": .string("provider"), "driver": .string("codex"), "providerInstanceId": .string("provider"),
            "prompt": .string("Inspect the change"), "status": .string("completed"), "result": .string("Finished"),
        ])
    }

    private func liveAgent() -> JSONValue {
        .object([
            "id": .string("agent"), "threadId": .string("thread"), "runId": .string("old-run"), "parentNodeId": .string("root"),
            "origin": .string("provider"), "createdBy": .string("agent"), "driver": .string("codex"),
            "providerInstanceId": .string("provider"), "providerThreadId": .null,
            "childThreadId": .string("live-child"), "nativeTaskRef": .null,
            "prompt": .string("Inspect the change"), "title": .string("Review"), "model": .null,
            "status": .string("waiting"), "progress": .string("Waiting for input"), "result": .null,
            "startedAt": .string(V2Fixture.now), "completedAt": .null, "updatedAt": .string(V2Fixture.now),
        ])
    }
}
