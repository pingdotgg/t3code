import Foundation
import Testing
@testable import T3Code

@Suite("V2 fork and merge-back commands")
struct OrchestrationV2WorkflowCommandTests {
    @Test
    func forkDispatchesSourceAndTargetWithoutSingleThreadGuard() throws {
        let command = OrchestrationV2Commands.fork(
            sourceThreadID: "original-thread", targetThreadID: "new-thread", runID: "original-run",
            title: "Task fork", commandID: "fork-command"
        )
        let plan = try OrchestrationV2Commands.plan(command)
        let request = try #require(plan.requests.first)
        #expect(plan.requests.count == 1)
        #expect(request.method == "orchestration.dispatchCommand")
        #expect(request.responseKind == .dispatch)
        #expect(request.payload == .object([
            "type": .string("thread.fork"), "commandId": .string("fork-command"),
            "createdBy": .string("user"), "creationSource": .string("mobile"),
            "sourceThreadId": .string("original-thread"), "targetThreadId": .string("new-thread"),
            "sourcePoint": .object(["type": .string("run"), "runId": .string("original-run")]),
            "title": .string("Task fork"),
        ]))
        #expect(request.payload["threadId"] == nil)
        #expect(!OrchestrationV2Commands.requiresProjection(command))
    }

    @Test
    func mergeBackLeavesTransferStrategyToServer() throws {
        let command = OrchestrationV2Commands.mergeBack(
            sourceThreadID: "fork", targetThreadID: "parent", runID: "waiting-run", commandID: "merge-command"
        )
        let request = try #require(OrchestrationV2Commands.plan(command).requests.first)
        #expect(request.payload == .object([
            "type": .string("thread.merge_back"), "commandId": .string("merge-command"),
            "createdBy": .string("user"), "creationSource": .string("mobile"),
            "sourceThreadId": .string("fork"), "targetThreadId": .string("parent"),
            "sourcePoint": .object(["type": .string("run"), "runId": .string("waiting-run")]),
        ]))
        #expect(request.payload["strategy"] == nil)
        #expect(request.payload["threadId"] == nil)
        #expect(try OrchestrationV2Commands.plan(command) == OrchestrationV2Commands.plan(command))
    }

    @Test(arguments: ["thread.fork", "thread.merge_back"])
    func malformedTransferIdentityFailsBeforeDispatch(_ type: String) throws {
        let valid = V2Fixture.patch(OrchestrationV2Commands.mergeBack(
            sourceThreadID: "source", targetThreadID: "target", runID: "run", commandID: "command"
        ), ["type": .string(type)])
        for field in ["sourceThreadId", "targetThreadId"] {
            #expect(throws: OrchestrationV2Commands.AdapterError.missingField(field)) {
                try OrchestrationV2Commands.plan(V2Fixture.patch(valid, [field: .null]))
            }
        }
        #expect(throws: OrchestrationV2Commands.AdapterError.invalidField("targetThreadId")) {
            try OrchestrationV2Commands.plan(V2Fixture.patch(valid, ["targetThreadId": .string("source")]))
        }
        #expect(throws: OrchestrationV2Commands.AdapterError.missingField("sourcePoint.runId")) {
            try OrchestrationV2Commands.plan(V2Fixture.patch(valid, ["sourcePoint": .object(["type": .string("run")])]))
        }
        #expect(throws: OrchestrationV2Commands.AdapterError.invalidField("sourcePoint.type")) {
            try OrchestrationV2Commands.plan(V2Fixture.patch(valid, ["sourcePoint": .object(["type": .string("message")])]))
        }
        #expect(throws: OrchestrationV2Commands.AdapterError.projectionMismatch) {
            try OrchestrationV2Commands.plan(valid, projection: .object(["thread": .object(["id": .string("target")])]))
        }
        #expect(try OrchestrationV2Commands.plan(valid,
            projection: .object(["thread": .object(["id": .string("source")])])).requests.count == 1)
    }

    @Test
    func transferPlannerPreservesOtherValidV2SourcePoints() throws {
        let command = OrchestrationV2Commands.fork(sourceThreadID: "source", targetThreadID: "target", runID: "run")
        let points: [JSONValue] = [
            .object(["type": .string("latest_stable")]),
            .object(["type": .string("checkpoint"), "checkpointId": .string("checkpoint")]),
        ]
        for point in points {
            let plan = try OrchestrationV2Commands.plan(V2Fixture.patch(command, ["sourcePoint": point]))
            #expect(plan.requests.first?.payload["sourcePoint"] == point)
        }
    }
}
