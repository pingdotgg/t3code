import Foundation
import Testing
@testable import T3Code

@Suite("Thread lifecycle parity")
struct FeatureThreadLifecyclePolicyTests {
    private let now = Date(timeIntervalSince1970: 10_000)

    private func thread(runtime: String = "completed", run: String = "completed") -> FeatureThread {
        FeatureThread(
            id: "computer:thread", projectID: "project", environmentID: "computer", title: "Task",
            updatedAt: now, state: .completed, snoozedUntil: now.addingTimeInterval(300),
            snoozedAt: now.addingTimeInterval(-100), supportsSettlement: true, supportsSnooze: true,
            settlementFacts: .init(latestUserMessageAt: now, latestTurn: .init(requestedAt: now)),
            inboxFacts: .init(
                runtimeStatus: runtime, latestRunID: "run", latestRunStatus: run,
                latestRunRequestedAt: now, latestRunCompletedAt: now,
                orchestrationVersion: 2, runtimeUpdatedAt: now,
                lastVisitedAt: now.addingTimeInterval(-1).ISO8601Format(), lastVisitedAtIsPresent: true
            )
        )
    }

    @Test
    func archiveUsesTheV2RuntimeInsteadOfLegacyWorkingAndRequestLabels() {
        var value = thread(runtime: "queued", run: "queued")
        value.state = .queued
        #expect(value.canArchive)
        value.inboxFacts?.activeRunID = "active"
        #expect(!value.canArchive)
        for status in ["preparing", "starting", "running"] {
            value.inboxFacts?.runtimeStatus = status
            #expect(!value.canArchive)
        }
        for status in ["waiting", "idle", "completed", "interrupted", "failed", "cancelled"] {
            value.state = .waitingForInput
            value.inboxFacts?.runtimeStatus = status
            #expect(value.canArchive)
        }
        value.inboxFacts?.orchestrationVersion = nil
        #expect(!value.canArchive)
    }

    @Test
    func v2SettlementDelegatesAsyncQuestionAndAutomaticQueueValidationToTheServer() {
        var value = thread(runtime: "completed")
        value.state = .waitingForInput
        value.settlementFacts?.hasPendingUserInput = true
        #expect(FeatureThreadLifecyclePolicy.canSettle(value, at: now))
        value.inboxFacts?.runtimeStatus = "queued"
        #expect(FeatureThreadLifecyclePolicy.canSettle(value, at: now))
        value.inboxFacts?.orchestrationVersion = nil
        #expect(!FeatureThreadLifecyclePolicy.canSettle(value, at: now))
        value.inboxFacts?.orchestrationVersion = 2
        value.supportsSettlement = false
        #expect(!FeatureThreadLifecyclePolicy.canSettle(value, at: now))
    }

    @Test(arguments: ["preparing", "queued", "starting"])
    func queuedStartBlocksSnoozeEvenAfterTimestampAdoption(runtime: String) {
        let value = thread(runtime: runtime, run: runtime)
        #expect(!value.canSnoozeNow(at: now))
        #expect(!value.canSnoozeNow(at: now.addingTimeInterval(3_600)))
        #expect(FeatureThreadLifecyclePolicy.queuedSettlementBoundary(value, after: now) == nil)
    }

    @Test
    func legacyQueuedStartKeepsTheBoundedClockSkewAndAdoptionRules() {
        var value = thread(runtime: "running", run: "running")
        value.inboxFacts?.orchestrationVersion = nil
        value.settlementFacts?.sessionStatus = "ready"
        #expect(value.canSnoozeNow(at: now))
        value.settlementFacts?.latestTurn = nil
        #expect(!value.canSnoozeNow(at: now))
        #expect(value.canSnoozeNow(at: now.addingTimeInterval(121)))
        #expect(value.canSnoozeNow(at: now.addingTimeInterval(-121)))
        value.settlementFacts?.sessionStatus = "error"
        #expect(value.canSnoozeNow(at: now))
    }

    @Test
    func v2QueuedFollowupAfterFailureDoesNotUseTheLegacyErrorSessionShortcut() {
        var value = thread(runtime: "failed", run: "failed")
        value.settlementFacts?.sessionStatus = "error"
        value.inboxFacts?.latestRunRequestedAt = now.addingTimeInterval(-10)
        value.inboxFacts?.latestRunCompletedAt = now.addingTimeInterval(-5)
        #expect(!value.canSnoozeNow(at: now))
        value.settlementFacts?.latestUserMessageAt = now.addingTimeInterval(-10)
        #expect(value.canSnoozeNow(at: now))
    }

    @Test
    func interruptedAndCancelledRunsKeepTheirSnoozeWhileCompletionWakes() {
        for status in ["interrupted", "cancelled", "rolled_back", "running", "waiting"] {
            let value = thread(runtime: status, run: status)
            #expect(FeatureThreadLifecyclePolicy.isSnoozed(value, at: now))
        }
        var value = thread()
        #expect(!FeatureThreadLifecyclePolicy.isSnoozed(value, at: now))
        value.inboxFacts?.latestRunCompletedAt = value.snoozedAt
        #expect(FeatureThreadLifecyclePolicy.isSnoozed(value, at: now))
        value.snoozedUntil = now
        #expect(!FeatureThreadLifecyclePolicy.isSnoozed(value, at: now))
    }

    @Test
    func onlyFreshFailureWakesUnlessTheSnoozeTimestampIsMissing() {
        var value = thread(runtime: "failed", run: "failed")
        #expect(!FeatureThreadLifecyclePolicy.isSnoozed(value, at: now))
        value.inboxFacts?.runtimeUpdatedAt = value.snoozedAt
        #expect(FeatureThreadLifecyclePolicy.isSnoozed(value, at: now))
        value.inboxFacts?.runtimeUpdatedAt = nil
        #expect(FeatureThreadLifecyclePolicy.isSnoozed(value, at: now))
        value.snoozedAt = nil
        #expect(!FeatureThreadLifecyclePolicy.isSnoozed(value, at: now))
        value.inboxFacts = nil
        value.state = .failed
        #expect(!FeatureThreadLifecyclePolicy.isSnoozed(value, at: now))
    }

    @Test
    func requestsOutrankSnoozeAndBackgroundOrLimitedLabels() {
        var value = thread(runtime: "idle")
        #expect(value.isWaitingForBackgroundWork)
        value.settlementFacts?.hasPendingApprovals = true
        #expect(!value.isWaitingForBackgroundWork)
        #expect(!value.canSnoozeNow(at: now))
        #expect(!FeatureThreadLifecyclePolicy.isSnoozed(value, at: now))
        value.settlementFacts?.hasPendingApprovals = false
        value.inboxFacts?.runtimeStatus = "failed"
        value.inboxFacts?.lastErrorClass = "usage_limit"
        value.inboxFacts?.usageLimitResetAt = now.addingTimeInterval(100)
        #expect(value.isUsageLimited)
        #expect(value.usageLimitResetAt == now.addingTimeInterval(100))
        value.settlementFacts?.hasPendingUserInput = true
        #expect(!value.isUsageLimited)
    }

    @Test
    func doneUsesTheServerVisitWatermarkWithoutMarkingOldHistoryUnread() {
        var value = thread()
        #expect(value.hasUnseenCompletion)
        value.inboxFacts?.lastVisitedAt = now.ISO8601Format()
        #expect(!value.hasUnseenCompletion)
        value.inboxFacts?.lastVisitedAt = nil
        #expect(!value.hasUnseenCompletion)
        #expect(value.supportsVisitTracking)
        value.inboxFacts?.lastVisitedAtIsPresent = false
        #expect(!value.supportsVisitTracking)
        value.inboxFacts?.lastVisitedAtIsPresent = true
        value.inboxFacts?.lastVisitedAt = "invalid"
        #expect(value.hasUnseenCompletion)
    }

    @Test
    @MainActor
    func equalFractionalRunAndVisitTimestampsDoNotShowDone() throws {
        for raw in ["2026-10-04T12:00:00.123Z", "2026-10-04T12:00:00.456Z", "2026-10-04T12:00:00.999Z"] {
            var value = thread()
            let completedAt = try #require(NativeTimestampParser.parse(raw))
            value.inboxFacts?.latestRunCompletedAt = completedAt
            value.inboxFacts?.lastVisitedAt = raw
            #expect(value.lastVisitedAt == completedAt)
            #expect(!value.hasUnseenCompletion)
            value.inboxFacts?.latestRunCompletedAt = completedAt.addingTimeInterval(0.001)
            #expect(value.hasUnseenCompletion)
        }
    }

    @Test
    func localOutboxReopensTheShelfWithoutChangingTheServerOverride() {
        var value = thread()
        value.isSettled = true
        value.settlementFacts?.settlementOverride = .settled
        #expect(FeatureThreadLifecyclePolicy.isSettled(value))
        value.hasPendingLocalMessages = true
        #expect(!FeatureThreadLifecyclePolicy.isSettled(value))
        #expect(value.isSettled)
        #expect(value.settlementFacts?.settlementOverride == .settled)
        value.hasPendingLocalMessages = false
        #expect(FeatureThreadLifecyclePolicy.isSettled(value))
    }

    @Test
    func olderCachedInboxFactsAndThreadsRemainDecodable() throws {
        var fields = try JSONValue.encode(thread().inboxFacts).v2Object
        for key in ["orchestrationVersion", "runtimeUpdatedAt", "latestRunStartedAt", "latestRunHasInvalidTimestamp",
                    "lastErrorClass", "usageLimitResetAt", "lastVisitedAt", "lastVisitedAtIsPresent"] {
            fields.removeValue(forKey: key)
        }
        let facts = try JSONValue.object(fields).decode(FeatureThreadInboxFacts.self)
        #expect(facts.orchestrationVersion == nil)
        #expect(facts.latestRunStatus == "completed")
        let cached = try JSONValue.encode(thread()).decode(FeatureThread.self)
        #expect(cached.hasPendingLocalMessages == nil)
        #expect(cached.rawUpdatedAt == nil)
    }
}
