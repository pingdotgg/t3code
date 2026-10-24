import Foundation
import XCTest
@testable import T3Code

final class OrchestrationV2ThreadLifecycleTests: XCTestCase {
    private func shell(_ changes: [String: JSONValue] = [:]) throws -> OrchestrationV2ThreadShell {
        let fixture = try V2Fixture.load("v2-shell-snapshot")
        let original = try XCTUnwrap(fixture["threads"]?.v2Array?.first)
        return try OrchestrationV2ThreadShell(json: V2Fixture.patch(original, changes))
    }

    func testWatchOnlyThreadHoldsCompletionWithoutAnyRunOrProviderThread() throws {
        for runs in [[], [V2Fixture.run(status: "completed")]] {
            for source in ["manual", "stack-dismissed"] {
                let link = V2Fixture.watchedPullRequest(source: source)
                let raw = V2Fixture.snapshot(fields: [
                    "thread": V2Fixture.patch(V2Fixture.thread, ["pullRequests": .array([link]), "archivedAt": .string(V2Fixture.now)]),
                    "runs": .array(runs),
                ])
                var projection = try raw.decode(OrchestrationV2ThreadSnapshot.self).projection
                let facts = OrchestrationV2ThreadLifecycle(projection: projection)
                XCTAssertEqual(facts.runtimeStatus, source == "manual" ? "idle" : (runs.isEmpty ? nil : "completed"))
                XCTAssertNil(facts.activeRunID)
                let normalized = try OrchestrationV2ThreadState(snapshot: raw).normalizedSnapshot()
                let carried = try XCTUnwrap(normalized.thread.orchestrationV2Control?["lifecycle"])
                    .decode(OrchestrationV2ThreadLifecycle.self)
                XCTAssertEqual(carried, facts)
                projection.thread = try OrchestrationV2AppThread(json: V2Fixture.patch(projection.thread.raw, ["pullRequests": .array([])]))
                XCTAssertEqual(OrchestrationV2ThreadLifecycle(projection: projection).runtimeStatus, runs.isEmpty ? nil : "completed")
            }
        }
        let watched = try shell([
            "latestRunId": .null, "activeProviderThreadId": .null, "activeRunId": .null, "status": .string("idle"),
            "pendingBackgroundTasks": .array([]), "pullRequests": .array([V2Fixture.watchedPullRequest()]),
        ])
        XCTAssertEqual(OrchestrationV2ThreadLifecycle(shell: watched).runtimeStatus, "idle")
        XCTAssertEqual(OrchestrationV2Presentation.shellThread(watched).backgroundLiveness, .monitoring)
    }

    func testGoalSurvivesShellAndProviderUpdatesAndExplicitNullClearsIt() throws {
        let goal: JSONValue = .object(["objective": .string("Finish the task"), "status": .string("active")])
        XCTAssertNil(try shell().goal)
        let value = try shell(["goal": goal, "status": .string("completed"), "activityRunStatus": .null, "activeRunId": .null, "pendingBackgroundTasks": .array([])])
        XCTAssertEqual(value.goal?.objective, "Finish the task")
        XCTAssertEqual(OrchestrationV2Presentation.shellThread(value).v2Lifecycle?.goal, value.goal)
        XCTAssertEqual(OrchestrationV2ThreadLifecycle(shell: value).runtimeStatus, "completed")
        let frame: JSONValue = .object([
            "kind": .string("thread.updated"), "sequence": .number(11), "location": .string("active"),
            "thread": V2Fixture.patch(value.raw, ["goal": .null]),
        ])
        guard case let .threadUpserted(_, updated) = OrchestrationV2Presentation.shellStreamItem(frame) else {
            return XCTFail("Expected shell update")
        }
        XCTAssertNil(updated.v2Lifecycle?.goal)
        let fixture = try V2Fixture.load("v2-thread-bounded-snapshot")
        let original = try XCTUnwrap(fixture["projection"]?["providerThreads"]?.v2Array?.first)
        let provider = V2Fixture.patch(original, ["id": .string("provider-thread"), "appThreadId": .string("thread")])
        let raw = V2Fixture.snapshot(fields: [
            "thread": V2Fixture.patch(V2Fixture.thread, ["activeProviderThreadId": .string("provider-thread")]),
            "providerThreads": .array([provider]), "runs": .array([V2Fixture.run(status: "interrupted")]),
        ])
        var state = try OrchestrationV2ThreadState(snapshot: raw)
        for (index, next) in [goal, V2Fixture.patch(goal, ["status": .string("complete")]), .null].enumerated() {
            XCTAssertFalse(state.apply([V2Fixture.event("provider-thread.updated", payload: V2Fixture.patch(provider, ["goal": next]), sequence: 11 + index)]).refreshRequired)
            let lifecycle = OrchestrationV2ThreadLifecycle(projection: state.projection)
            XCTAssertEqual(lifecycle.goal?.status.rawValue, next["status"]?.stringValue)
            XCTAssertEqual(lifecycle.runtimeStatus, "interrupted", "A goal never implies active work")
            let control = try XCTUnwrap(state.normalizedSnapshot().thread.orchestrationV2Control?["lifecycle"])
                .decode(OrchestrationV2ThreadLifecycle.self)
            XCTAssertEqual(control.goal, lifecycle.goal)
        }
    }

    func testQueuedLatestRunDoesNotReplaceTheActiveRuntimeOrLoseWaiting() throws {
        let shell = try shell([
            "status": .string("queued"), "latestRunId": .string("queued-run"),
            "activeRunId": .string("active-run"), "activityRunStatus": .string("waiting"),
            "pendingBackgroundTasks": .array([]),
        ])
        let facts = OrchestrationV2ThreadLifecycle(shell: shell)
        XCTAssertEqual(facts.runtimeStatus, "waiting")
        XCTAssertEqual(facts.activeRunID, "active-run")
        XCTAssertEqual(facts.latestRunStatus, "queued")
        XCTAssertEqual(facts.latestRunID, "queued-run")
        XCTAssertEqual(facts.latestRunRequestedAt, shell.latestRunRequestedAt)
        XCTAssertEqual(facts.latestRunStartedAt, shell.latestRunStartedAt)
        XCTAssertEqual(facts.latestRunCompletedAt, shell.latestRunCompletedAt)
    }

    func testNonCommandBackgroundWorkParksAtIdleButDoesNotHideUsageFailure() throws {
        for kind in ["subagent", "monitor", "background_task", "command"] {
            let value = try shell([
                "status": .string("completed"), "activityRunStatus": .null,
                "pendingBackgroundTasks": .array([.object(["kind": .string(kind)])]),
            ])
            let facts = OrchestrationV2ThreadLifecycle(shell: value)
            XCTAssertEqual(facts.runtimeStatus, kind == "command" ? "completed" : "idle")
            XCTAssertEqual(facts.latestRunStatus, "completed")
        }
        let failed = try shell([
            "status": .string("failed"), "activityRunStatus": .null,
            "pendingBackgroundTasks": .array([.object(["kind": .string("subagent")])]),
            "lastErrorClass": .string("usage_limit"),
            "usageLimitResetAt": .string("2026-10-04T20:00:00Z"),
        ])
        let facts = OrchestrationV2ThreadLifecycle(shell: failed)
        XCTAssertEqual(facts.runtimeStatus, "failed")
        XCTAssertEqual(facts.lastErrorClass, "usage_limit")
        XCTAssertEqual(facts.usageLimitResetAt, "2026-10-04T20:00:00Z")
    }

    func testOnlyAbsentCompletionFieldsOnOlderTerminalShellsFallBackToUpdatedAt() throws {
        let completedAt = "2026-10-04T12:00:00.123Z"
        for status in ["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back",
                       "preparing", "queued", "starting", "running", "waiting"] {
            let value = try shell([
                "status": .string(status), "updatedAt": .string(completedAt),
                "latestRunId": .string("run"), "latestRunCompletedAt": .null,
            ])
            XCTAssertNil(OrchestrationV2ThreadLifecycle(shell: value).latestRunCompletedAt)
            var absent = value.raw.v2Object
            absent.removeValue(forKey: "latestRunCompletedAt")
            let facts = OrchestrationV2ThreadLifecycle(shell: try OrchestrationV2ThreadShell(json: .object(absent)))
            let terminal = ["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back"].contains(status)
            XCTAssertEqual(facts.latestRunCompletedAt, terminal ? completedAt : nil)
            XCTAssertEqual(facts.latestRunStatus, status == "idle" ? "completed" : status)
            absent["latestRunId"] = .null
            XCTAssertNil(OrchestrationV2ThreadLifecycle(shell: try OrchestrationV2ThreadShell(json: .object(absent)))
                .latestRunCompletedAt)
        }
        let explicit = try shell(["status": .string("completed"), "latestRunCompletedAt": .string(completedAt)])
        XCTAssertEqual(OrchestrationV2ThreadLifecycle(shell: explicit).latestRunCompletedAt, completedAt)
    }

    func testNeverStartedThreadsHaveNoRuntimeAndVisitsPreserveNullVersusAbsent() throws {
        let empty = try shell([
            "latestRunId": .null, "activeProviderThreadId": .null,
            "lastVisitedAt": .null,
        ])
        let facts = OrchestrationV2ThreadLifecycle(shell: empty)
        XCTAssertNil(facts.runtimeStatus)
        XCTAssertNil(facts.latestRunStatus)
        XCTAssertNil(facts.lastVisitedAt)
        XCTAssertTrue(facts.lastVisitedAtIsPresent)
        var fields = empty.raw.v2Object
        fields.removeValue(forKey: "lastVisitedAt")
        let older = try OrchestrationV2ThreadShell(json: .object(fields))
        XCTAssertFalse(OrchestrationV2ThreadLifecycle(shell: older).lastVisitedAtIsPresent)
    }

    // Exercises the one-line shell conversion integration required from the timeline owner.
    func testPresentationRetainsLifecycleFactsInsteadOfOnlyLegacyTurnState() throws {
        let value = try shell([
            "status": .string("interrupted"), "activityRunStatus": .null,
            "lastVisitedAt": .string("2026-10-04T10:00:00Z"),
        ])
        let mapped = OrchestrationV2Presentation.shellThread(value)
        XCTAssertEqual(mapped.v2Lifecycle, OrchestrationV2ThreadLifecycle(shell: value))
        let roundTrip = try JSONValue.encode(mapped).decode(OrchestrationThreadShell.self)
        XCTAssertEqual(roundTrip.v2Lifecycle?.latestRunStatus, "interrupted")
        XCTAssertEqual(roundTrip.v2Lifecycle?.lastVisitedAt, "2026-10-04T10:00:00Z")
    }

    func testFullDetailLifecycleWorksWithoutAnyShellAndKeepsLatestAndActiveRunsSeparate() throws {
        let active = V2Fixture.run("active", status: "waiting", ordinal: 1)
        let queued = V2Fixture.run("queued", status: "queued", ordinal: 2)
        let raw = V2Fixture.snapshot(fields: [
            "thread": V2Fixture.patch(V2Fixture.thread, [
                "archivedAt": .string(V2Fixture.now), "lastVisitedAt": .string("2026-08-31T12:00:00Z"),
            ]),
            "runs": .array([active, queued]),
        ])
        let projection = try raw.decode(OrchestrationV2ThreadSnapshot.self).projection
        let facts = OrchestrationV2ThreadLifecycle(projection: projection)
        XCTAssertEqual(facts.runtimeStatus, "waiting")
        XCTAssertNil(facts.activeRunID, "Waiting is activity, not an interruptible provider run")
        XCTAssertEqual(facts.latestRunID, "queued")
        XCTAssertEqual(facts.latestRunStatus, "queued")
        XCTAssertEqual(facts.lastVisitedAt, "2026-08-31T12:00:00Z")
        XCTAssertTrue(facts.lastVisitedAtIsPresent)
        let detail = try OrchestrationV2ThreadState(snapshot: raw).normalizedSnapshot()
        let controlFacts = try XCTUnwrap(detail.thread.orchestrationV2Control?["lifecycle"])
            .decode(OrchestrationV2ThreadLifecycle.self)
        XCTAssertEqual(controlFacts, facts)
    }

    func testFullDetailKeepsTheUsageLimitVisibleBehindNewQueuedRuns() throws {
        let failure = V2Fixture.item("error", type: "error", ordinal: 1, fields: [
            "status": .string("failed"), "failure": .object([
                "class": .string("usage_limit"), "message": .string("Limit reached"),
                "code": .null, "retryable": .bool(true), "resetAt": .string("2026-09-02T12:00:00Z"),
            ]),
        ])
        let failed = V2Fixture.patch(V2Fixture.run(status: "failed"), ["completedAt": .string(V2Fixture.now)])
        var projection = try V2Fixture.snapshot(items: [failure], fields: [
            "runs": .array([failed, V2Fixture.run("next", status: "queued", ordinal: 2)]),
        ]).decode(OrchestrationV2ThreadSnapshot.self).projection
        let facts = OrchestrationV2ThreadLifecycle(projection: projection)
        XCTAssertEqual(facts.latestRunID, "run")
        XCTAssertEqual(facts.runtimeStatus, "failed")
        XCTAssertEqual(facts.lastErrorClass, "usage_limit")
        XCTAssertEqual(facts.usageLimitResetAt, "2026-09-02T12:00:00Z")
        let session = V2Fixture.patch(V2Fixture.session("session"), ["lastError": .string("Disconnected")])
        projection.providerSessions = [try OrchestrationV2ProviderSession(json: session)]
        let disconnected = OrchestrationV2ThreadLifecycle(projection: projection)
        XCTAssertEqual(disconnected.latestRunID, "next")
        XCTAssertEqual(disconnected.runtimeStatus, "queued")
        XCTAssertNil(disconnected.lastErrorClass)
    }

    func testFullDetailBackgroundWaitExcludesPersistentAndRolledBackWork() throws {
        let work = V2Fixture.item("monitor", type: "dynamic_tool", ordinal: 1, fields: [
            "toolName": .string("monitor"), "input": .object([:]), "output": .null,
        ])
        let completed = V2Fixture.patch(V2Fixture.run(status: "completed"), ["completedAt": .string(V2Fixture.now)])
        func facts(_ item: JSONValue, runs: [JSONValue]) throws -> OrchestrationV2ThreadLifecycle {
            let projection = try V2Fixture.snapshot(items: [item], fields: ["runs": .array(runs)])
                .decode(OrchestrationV2ThreadSnapshot.self).projection
            return OrchestrationV2ThreadLifecycle(projection: projection)
        }
        XCTAssertEqual(try facts(work, runs: [completed]).runtimeStatus, "idle")
        let persistent = V2Fixture.patch(work, ["input": .object(["persistent": .bool(true)])])
        XCTAssertEqual(try facts(persistent, runs: [completed]).runtimeStatus, "completed")
        let rolledBack = V2Fixture.run("old", status: "rolled_back", ordinal: 0)
        let oldWork = V2Fixture.patch(work, ["runId": .string("old")])
        XCTAssertEqual(try facts(oldWork, runs: [rolledBack, completed]).runtimeStatus, "completed")
        let foreground = V2Fixture.run("active", status: "running", ordinal: 2)
        XCTAssertEqual(try facts(work, runs: [completed, foreground]).runtimeStatus, "running")
    }
}
