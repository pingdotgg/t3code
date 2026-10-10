import Foundation
import Testing
@testable import T3Code

@Suite("V2 thread workflows")
struct FeatureThreadWorkflowTests {
    @Test(arguments: ["preparing", "starting", "running"])
    func newerActiveWorkBlocksMergeBack(_ status: String) throws {
        let workflows = try self.workflows(runs: [
            V2Fixture.run("older", status: "completed", ordinal: 1),
            V2Fixture.run("newer", status: status, ordinal: 3),
            V2Fixture.run("waiting", status: "waiting", ordinal: 2),
        ])
        #expect(workflows.mergeBack == nil)
    }

    @Test(arguments: ["queued", "failed", "cancelled", "interrupted", "rolled_back"])
    func waitingRunIsLatestMergeBackPointDespiteNewerNonblockingRun(_ status: String) throws {
        let workflows = try self.workflows(runs: [
            V2Fixture.run("waiting", status: "waiting", ordinal: 4),
            V2Fixture.run("newer", status: status, ordinal: 5),
            V2Fixture.run("older", status: "completed", ordinal: 3),
        ])
        #expect(workflows.mergeBack?.runID == "waiting")
        #expect(workflows.mergeBack?.targetThreadID == FeatureScopedID.thread(environmentID: "remote", wireID: "source"))
    }

    @Test
    func mergeBackUsesForkSourceBeforeLineageAndOnlyForForks() throws {
        let run = V2Fixture.run("done", status: "completed")
        let fromRun = try workflows(runs: [run])
        #expect(fromRun.mergeBack?.targetThreadID == FeatureScopedID.thread(environmentID: "remote", wireID: "source"))
        let lineage = try workflows(runs: [run], forkedFrom: .null)
        #expect(lineage.mergeBack?.targetThreadID == FeatureScopedID.thread(environmentID: "remote", wireID: "parent"))
        #expect(try workflows(runs: [run], relationship: "subagent").mergeBack == nil)
        #expect(try workflows(runs: [run], relationship: nil).mergeBack == nil)
        #expect(try workflows(runs: []).mergeBack == nil)
        #expect(try workflows(runs: [V2Fixture.run(status: "running")]).mergeBack == nil)
    }

    @Test
    func providerNativeChildCanOpenItsParentWithoutMergeBack() throws {
        let child = try workflows(relationship: "subagent", creationSource: "provider")
        #expect(child.providerParentThreadID == FeatureScopedID.thread(environmentID: "remote", wireID: "parent"))
        #expect(child.mergeBack == nil)
        #expect(try workflows(relationship: "subagent", creationSource: "mobile").providerParentThreadID == nil)
        #expect(try workflows(relationship: "fork", creationSource: "provider").providerParentThreadID == nil)
        #expect(FeatureThreadWorkflows.unavailable.providerParentThreadID == nil)
    }

    @Test
    func forkRequiresCompletedAssistantWithRunAndUsesSessionForThatItem() throws {
        let cases: [(Bool, Bool, String, Bool, Bool)] = [
            (true, true, "strong", false, true),
            (true, true, "weak", false, false),
            (true, false, "strong", false, false),
            (false, true, "strong", false, false),
            (false, false, "none", true, true),
            (false, false, "none", false, false),
        ]
        for (forkThread, forkTurn, identity, handoff, expected) in cases {
            let capabilities = self.capabilities(forkThread: forkThread, forkTurn: forkTurn,
                                            identity: identity, handoff: handoff)
            let source = FeatureThreadWorkflowSource(itemID: "answer", threadID: "thread", runID: "run")
            #expect(try workflows(items: [answer()], capabilities: capabilities).canFork(source) == expected)
        }
        for status in ["running", "pending", "waiting", "failed", "cancelled"] {
            #expect(try workflows(items: [V2Fixture.patch(answer(), ["status": .string(status)])]).canFork(source) == false)
        }
        #expect(try workflows(items: [V2Fixture.patch(answer(), ["runId": .null])]).canFork(source) == false)
        #expect(try workflows(items: [V2Fixture.patch(answer(), ["type": .string("reasoning")])]).canFork(source) == false)
    }

    @Test
    func historicalAndInheritedForksKeepOriginalSourceAndMissingCapabilityFallback() throws {
        #expect(try workflows(items: [answer()]).canFork(source))
        #expect(try workflows(items: [answer()], capabilities: .object([:])).canFork(source) == false)
        let inherited = V2Fixture.patch(answer(), ["threadId": .string("original"), "runId": .string("original-run")])
        // Matching provider IDs in the child do not make its session authoritative for inherited text.
        let workflows = try self.workflows(items: [inherited], capabilities: .object([:]))
        let inheritedSource = FeatureThreadWorkflowSource(itemID: "answer", threadID: "original", runID: "original-run")
        #expect(workflows.canFork(inheritedSource))
        #expect(!workflows.canFork(source))
        let projected = try V2Fixture.row(inherited, visibility: "inherited").decode(OrchestrationV2ProjectedTurnItem.self)
        #expect(FeatureThreadWorkflowSource(projectedItem: projected) == inheritedSource)
        #expect(!FeatureThreadWorkflows.unavailable.canFork(inheritedSource))
        #expect(FeatureThreadWorkflows.unavailable.mergeBack == nil)
        #expect(!FeatureThreadWorkflows.unavailable.isAvailable)
    }

    @Test
    func rosterUsesActiveRunThenLatestUpdatedRosterAndScopesChildLinks() throws {
        let agents = [
            agent("old", run: "old", child: "old-child", updated: "2026-10-01T10:00:00Z"),
            agent("second", run: "current", child: nil, status: "waiting", started: "2026-10-01T12:01:00Z"),
            agent("first", run: "current", child: "child", status: "completed", started: "2026-10-01T12:00:00Z"),
        ]
        let workflows = try self.workflows(runs: [V2Fixture.run("current", status: "running")], agents: agents)
        let roster = try #require(workflows.agentRoster)
        #expect(roster.runID == "current")
        #expect(roster.turnActive)
        #expect(roster.agents.map(\.id) == ["first", "second"])
        #expect(roster.liveCount == 1)
        #expect(roster.settledCount == 1)
        #expect(roster.agents.first?.childThreadID == FeatureScopedID.thread(environmentID: "remote", wireID: "child"))
        #expect(roster.agents.last?.childThreadID == nil)
        #expect(roster.agents.first?.model == "model")
        #expect(roster.agents.first?.providerInstanceID == "provider")
        #expect(roster.agents.first?.detail == "Result")
        #expect(roster.agents.last?.detail == "Progress")
        #expect(workflows.agents.count == 3)
        let finished = try self.workflows(agents: agents).agentRoster
        #expect(finished?.runID == "current")
        #expect(finished?.turnActive == false)
        // A new active run with no agents must not show an older run's roster.
        #expect(try self.workflows(runs: [V2Fixture.run("new", status: "running")], agents: agents).agentRoster == nil)
    }

    @Test
    func transcriptAgentWithoutLoadedRosterStillOpensScopedChild() throws {
        let item = V2Fixture.item("item", type: "subagent", ordinal: 1, fields: [
            "subagentId": .string("agent"), "childThreadId": .string("child"),
            "origin": .string("provider"), "driver": .string("codex"), "providerInstanceId": .string("provider"),
            "prompt": .string("Inspect this"), "result": .null,
        ])
        let row = try V2Fixture.row(item).decode(OrchestrationV2ProjectedTurnItem.self)
        let agent = try #require(FeatureThreadAgent(projectedItem: row, environmentID: "remote"))
        #expect(agent.childThreadID == FeatureScopedID.thread(environmentID: "remote", wireID: "child"))
        #expect(agent.title == "Inspect this")
        #expect(agent.status == .running)
        #expect(agent.runID == "run")
    }

    private var source: FeatureThreadWorkflowSource {
        FeatureThreadWorkflowSource(itemID: "answer", threadID: "thread", runID: "run")
    }

    private func answer() -> JSONValue {
        V2Fixture.patch(V2Fixture.assistant("answer", ordinal: 1), [
            "status": .string("completed"), "streaming": .bool(false), "providerThreadId": .string("provider-thread"),
        ])
    }

    private func workflows(
        runs: [JSONValue] = [], items: [JSONValue] = [], agents: [JSONValue] = [],
        relationship: String? = "fork", creationSource: String = "mobile",
        forkedFrom: JSONValue? = nil, capabilities: JSONValue? = nil
    ) throws -> FeatureThreadWorkflows {
        let thread = V2Fixture.patch(V2Fixture.thread, [
            "creationSource": .string(creationSource),
            "lineage": .object([
                "relationshipToParent": relationship.map(JSONValue.string) ?? .null,
                "parentThreadId": .string("parent"), "rootThreadId": .string("parent"),
            ]),
            "forkedFrom": forkedFrom ?? .object(["type": .string("run"), "threadId": .string("source"), "runId": .string("source-run")]),
        ])
        let sessions = capabilities.map { [V2Fixture.patch(V2Fixture.session("session"), ["capabilities": $0])] } ?? []
        let snapshot = V2Fixture.snapshot(items: items, fields: [
            "thread": thread, "runs": .array(runs), "subagents": .array(agents),
            "providerThreads": .array([.object(["id": .string("provider-thread"), "providerSessionId": .string("session")])]),
            "providerSessions": .array(sessions),
        ])
        return try FeatureThreadWorkflows(projection: #require(snapshot["projection"]), environmentID: "remote")
    }

    private func capabilities(forkThread: Bool, forkTurn: Bool, identity: String, handoff: Bool) -> JSONValue {
        .object([
            "threads": .object(["canForkThread": .bool(forkThread), "canForkFromTurn": .bool(forkTurn)]),
            "identity": .object(["nativeThreadIds": .string(identity)]),
            "context": .object(["supportsFullThreadHandoff": .bool(handoff)]),
        ])
    }

    private func agent(
        _ id: String, run: String, child: String?, status: String = "running",
        started: String? = nil, updated: String = "2026-10-01T12:10:00Z"
    ) -> JSONValue {
        .object([
            "id": .string(id), "threadId": .string("thread"), "runId": .string(run), "parentNodeId": .string("root"),
            "origin": .string("app"), "createdBy": .string("agent"), "driver": .string("codex"),
            "providerInstanceId": .string("provider"), "providerThreadId": .null,
            "childThreadId": child.map(JSONValue.string) ?? .null, "nativeTaskRef": .null,
            "prompt": .string("Inspect this"), "title": .string(id), "model": .string("model"),
            "status": .string(status), "progress": .string("Progress"), "result": .string("Result"),
            "startedAt": started.map(JSONValue.string) ?? .null, "completedAt": .null, "updatedAt": .string(updated),
        ])
    }
}
