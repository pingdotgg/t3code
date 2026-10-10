import Foundation
import Testing
@testable import T3Code

@Suite("V2 thread recovery")
struct FeatureThreadRecoveryTests {
    private let failedAt = "2026-10-04T12:00:00Z"
    private let resetAt = "2026-10-04T14:00:00Z"

    @Test func usageChoicesAndReverseActionsPreserveTheOtherChoice() throws {
        let now = try #require(FeatureUsageLimitRecovery.date(failedAt))
        let recovery = try #require(FeatureThreadRecovery(projection: projection(
            recovery: .object([
                "runId": .string("failed"), "resetAt": .string(resetAt),
                "autoResume": .bool(true), "snooze": .bool(true),
            ]), snoozedUntil: resetAt
        )).usageLimit)
        #expect(recovery.autoResume && recovery.snooze)
        for enabled in [true, false] {
            let resume = try recovery.metadataUpdate(choice: .autoResume, enabled: enabled, now: now)
            #expect(resume["autoResume"] == .bool(enabled))
            #expect(resume["snooze"] == nil)
            let snooze = try recovery.metadataUpdate(choice: .snooze, enabled: enabled, now: now)
            #expect(snooze["snooze"] == .bool(enabled))
            #expect(snooze["autoResume"] == nil)
            #expect(snooze["runId"] == .string("failed"))
            #expect(snooze["resetAt"] == .string(resetAt))
        }
    }

    @Test func recoveryChoicesBelongToExactRunAndResetAndCurrentSnooze() throws {
        for (runID, timestamp) in [("previous", resetAt), ("failed", "2026-10-04T15:00:00Z")] {
            let recovery = try #require(FeatureThreadRecovery(projection: projection(recovery: .object([
                "runId": .string(runID), "resetAt": .string(timestamp),
                "autoResume": .bool(true), "snooze": .bool(true),
            ]), snoozedUntil: resetAt)).usageLimit)
            #expect(!recovery.autoResume && !recovery.snooze)
        }
        let awake = try #require(FeatureThreadRecovery(projection: projection(recovery: .object([
            "runId": .string("failed"), "resetAt": .string(resetAt),
            "autoResume": .bool(true), "snooze": .bool(true),
        ]))).usageLimit)
        #expect(awake.autoResume && !awake.snooze)
    }

    @Test func normalizedTimelineSuppliesRecoveryWithoutChangingErrorPayloadMapping() throws {
        let error = V2Fixture.item("limited", type: "error", ordinal: 1, fields: [
            "status": .string("failed"), "failure": .object([
                "class": .string("usage_limit"), "message": .string("Limit reached"),
                "code": .null, "retryable": .bool(true), "resetAt": .string(resetAt),
            ]),
        ])
        let snapshot = V2Fixture.snapshot(items: [error], fields: [
            "runs": .array([V2Fixture.patch(V2Fixture.run(status: "failed"), ["completedAt": .string(failedAt)])]),
        ])
        let thread = try OrchestrationV2ThreadState(snapshot: snapshot).normalizedSnapshot().thread
        let recovery = try #require(FeatureThreadRecovery(thread: thread)?.usageLimit)
        #expect(recovery.runID == "run")
        #expect(recovery.resetAt == resetAt)
        #expect(recovery.canSchedule)
        var legacy = thread
        legacy.orchestrationV2Control = nil
        #expect(FeatureThreadRecovery(thread: legacy) == nil)
    }

    @Test func missingAndExpiredResetDoNotScheduleButExpiredChoicesCanBeReversed() throws {
        let now = try #require(FeatureUsageLimitRecovery.date("2026-10-04T15:00:00Z"))
        let expired = try #require(FeatureThreadRecovery(projection: projection()).usageLimit)
        #expect(!expired.canChange(.snooze, enabled: true, now: now))
        #expect(!expired.canChange(.autoResume, enabled: true, now: now))
        #expect(expired.canChange(.snooze, enabled: false, now: now))
        #expect(expired.canChange(.autoResume, enabled: false, now: now))
        let missing = try #require(FeatureThreadRecovery(projection: projection(reset: .null)).usageLimit)
        #expect(!missing.canSchedule)
        #expect(missing.action(.autoResume, enabled: true) == nil)
        let invalid = try #require(FeatureThreadRecovery(projection: projection(reset: .string(failedAt))).usageLimit)
        #expect(!invalid.canSchedule)
    }

    @Test func queuedAndCancelledFollowupsDoNotHideLimitButNewWorkAndDifferentFailuresDo() throws {
        for status in ["queued", "cancelled"] {
            let raw = projection(extraRuns: [run("later", ordinal: 2, status: status, started: false)])
            #expect(FeatureThreadRecovery(projection: raw).usageLimit?.runID == "failed")
        }
        for status in ["preparing", "running", "completed"] {
            let raw = projection(extraRuns: [run("later", ordinal: 2, status: status)])
            #expect(FeatureThreadRecovery(projection: raw).usageLimit == nil)
        }
        #expect(FeatureThreadRecovery(projection: projection(sessionError: "Connection failed")).usageLimit == nil)
        let raw = projection()
        for patch: [String: JSONValue] in [
            ["status": .string("cancelled")], ["nodeId": .string("child")],
        ] {
            let item = V2Fixture.patch(try #require(raw["turnItems"]?.v2Array?.first), patch)
            #expect(FeatureThreadRecovery(projection: raw, errorItems: [item]).usageLimit == nil)
        }
    }

    @Test func newestMatchingProviderSessionOwnsTheLimitRegardlessOfArrayOrder() {
        for latestError in ["Limit reached", "Connection failed"] {
            let older: JSONValue = .object([
                "providerInstanceId": .string("provider"),
                "updatedAt": .string("2026-10-04T11:00:00Z"),
                "lastError": .string(latestError == "Limit reached" ? "Connection failed" : "Limit reached"),
            ])
            let latest: JSONValue = .object([
                "providerInstanceId": .string("provider"), "updatedAt": .string(failedAt),
                "lastError": .string(latestError),
            ])
            let other: JSONValue = .object([
                "providerInstanceId": .string("other"), "updatedAt": .string(resetAt),
                "lastError": .string("Unrelated failure"),
            ])
            for sessions in [[latest, older, other], [older, other, latest]] {
                let raw = V2Fixture.patch(projection(), ["providerSessions": .array(sessions)])
                #expect((FeatureThreadRecovery(projection: raw).usageLimit != nil) == (latestError == "Limit reached"))
            }
        }
    }

    @Test func retryOnlyAppliesToCurrentFailedWorkspaceRunAndLocalFailedError() throws {
        let snapshot = try V2Fixture.load("v2-thread-bounded-snapshot")
        let base = try #require(snapshot["projection"])
        let originalRun = try #require(base["runs"]?.v2Array?.first)
        let runID = try #require(originalRun["id"]?.stringValue)
        let threadID = try #require(base["thread"]?["id"]?.stringValue)
        let item: JSONValue = .object([
            "threadId": .string(threadID), "type": .string("error"), "runId": .string(runID),
            "status": .string("failed"), "failure": .object(["code": .string("workspace_preparation_failed")]),
        ])
        for status in ["failed", "preparing", "running", "completed", "cancelled"] {
            let raw = V2Fixture.patch(base, ["runs": .array([V2Fixture.patch(originalRun, [
                "status": .string(status), "workspacePreparation": .object(["type": .string("project-root")]),
            ])])])
            let execution = try FeatureThreadExecution(projection: raw)
            #expect(execution.canRetryWorkspacePreparation(runID: runID) == (status == "failed"))
            #expect(FeatureThreadRecovery.canRetryWorkspacePreparation(item: item, threadID: threadID, execution: execution)
                == (status == "failed"))
            #expect(!FeatureThreadRecovery.canRetryWorkspacePreparation(item: item, threadID: "fork", execution: execution))
            #expect(!FeatureThreadRecovery.canRetryWorkspacePreparation(
                item: V2Fixture.patch(item, ["status": .string("cancelled")]), threadID: threadID, execution: execution
            ))
        }
        let oldServer = try FeatureThreadExecution(projection: V2Fixture.patch(base, [
            "runs": .array([V2Fixture.patch(originalRun, ["status": .string("failed"), "workspacePreparation": .null])]),
        ]))
        #expect(!oldServer.canRetryWorkspacePreparation(runID: runID))
    }

    private func run(_ id: String, ordinal: Int, status: String, started: Bool = true) -> JSONValue {
        .object([
            "id": .string(id), "ordinal": .number(Double(ordinal)), "status": .string(status),
            "rootNodeId": .string("root"), "startedAt": started ? .string(failedAt) : .null,
            "completedAt": status == "failed" ? .string(failedAt) : .null,
        ])
    }

    private func projection(
        recovery: JSONValue = .null, snoozedUntil: String? = nil, reset: JSONValue? = nil,
        extraRuns: [JSONValue] = [], sessionError: String? = nil
    ) -> JSONValue {
        .object([
            "thread": .object([
                "id": .string("thread"), "providerInstanceId": .string("provider"),
                "updatedAt": .string(failedAt), "limitRecovery": recovery,
                "snoozedUntil": snoozedUntil.map(JSONValue.string) ?? .null,
            ]),
            "runs": .array([run("failed", ordinal: 1, status: "failed")] + extraRuns),
            "providerSessions": .array([.object([
                "providerInstanceId": .string("provider"), "lastError": sessionError.map(JSONValue.string) ?? .null,
            ])]),
            "turnItems": .array([.object([
                "id": .string("error"), "type": .string("error"), "status": .string("failed"),
                "runId": .string("failed"), "nodeId": .string("root"), "ordinal": .number(1),
                "updatedAt": .string(failedAt), "failure": .object([
                    "class": .string("usage_limit"), "message": .string("Limit reached"),
                    "resetAt": reset ?? .string(resetAt),
                ]),
            ])]),
        ])
    }
}
