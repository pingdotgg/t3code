import Foundation
import Testing
@testable import T3Code

@Suite("Working section beta")
struct FeatureInboxPolicyTests {
    private let now = Date(timeIntervalSince1970: 10_000)

    private func thread(_ id: String, runtime: String = "running") -> FeatureThread {
        FeatureThread(
            id: "computer:\(id)", wireID: id, projectID: "project", environmentID: "computer",
            title: "Task \(id)", createdAt: now.addingTimeInterval(-1_000), updatedAt: now,
            state: runtime == "idle" ? .monitoring : .working,
            supportsSettlement: true, supportsSnooze: true, supportsPinning: true,
            supportsPinReorder: true, supportsActiveReorder: true,
            inboxFacts: .init(
                runtimeStatus: runtime, activeRunID: "run", latestRunID: "run",
                latestRunStatus: "running", latestRunRequestedAt: now.addingTimeInterval(-100)
            )
        )
    }

    @Test(arguments: ["preparing", "queued", "starting", "running", "waiting", "idle"])
    func busyAndMonitoringThreadsFoldUnlessTheUserMustAct(runtime: String) {
        var busy = thread("busy", runtime: runtime)
        #expect(FeatureInboxPolicy.isWorking(busy))
        for state in [FeatureThreadState.waitingForApproval, .waitingForInput, .failed] {
            busy.state = state
            #expect(!FeatureInboxPolicy.isWorking(busy))
        }
        busy.state = .working
        busy.settlementFacts = .init(hasPendingApprovals: true)
        #expect(!FeatureInboxPolicy.isWorking(busy))
        busy.settlementFacts = .init(hasPendingUserInput: true)
        #expect(!FeatureInboxPolicy.isWorking(busy))
        busy.settlementFacts = nil
        busy.inboxFacts?.runtimeStatus = "ready"
        #expect(!FeatureInboxPolicy.isWorking(busy))
        busy.inboxFacts?.runtimeStatus = nil
        #expect(!FeatureInboxPolicy.isWorking(busy))
    }

    @Test
    func finishedPlanPromptsOutrankBackgroundWorkButRunningPlansStayWorking() {
        var plan = thread("plan", runtime: "idle")
        plan.interactionMode = .plan
        plan.inboxFacts?.hasActionableProposedPlan = true
        plan.inboxFacts?.latestRunStatus = "completed"
        plan.inboxFacts?.activeRunID = nil
        #expect(!FeatureInboxPolicy.isWorking(plan))
        plan.inboxFacts?.activeRunID = "run"
        #expect(FeatureInboxPolicy.isWorking(plan))
        plan.inboxFacts?.activeRunID = nil
        plan.inboxFacts?.latestRunStatus = "running"
        #expect(FeatureInboxPolicy.isWorking(plan))
        plan.inboxFacts?.latestRunStatus = "completed"
        plan.interactionMode = .standard
        #expect(FeatureInboxPolicy.isWorking(plan))
        plan.interactionMode = .plan
        plan.inboxFacts?.latestRunID = nil
        #expect(FeatureInboxPolicy.isWorking(plan))
    }

    @Test
    func sendsStayOrderedAcrossWakesAndOnlyMissingAuthoredFieldsFallBack() {
        var older = thread("older")
        older.inboxFacts?.latestUserAuthoredMessageAtIsPresent = true
        older.inboxFacts?.latestUserAuthoredMessageAt = now.addingTimeInterval(-300)
        var newer = thread("newer")
        newer.inboxFacts?.latestUserAuthoredMessageAtIsPresent = true
        newer.inboxFacts?.latestUserAuthoredMessageAt = now.addingTimeInterval(-200)
        older.inboxFacts?.latestRunRequestedAt = now
        older.inboxFacts?.latestRunCompletedAt = now
        older.updatedAt = now.addingTimeInterval(500)
        #expect(FeatureInboxPolicy.sortWorking([older, newer]).map(\.id) == [newer.id, older.id])

        var absent = thread("absent")
        absent.inboxFacts?.latestRunRequestedAt = now.addingTimeInterval(-50)
        var explicitNull = thread("null")
        explicitNull.inboxFacts?.latestUserAuthoredMessageAtIsPresent = true
        explicitNull.inboxFacts?.latestRunRequestedAt = now
        #expect(FeatureInboxPolicy.sortWorking([explicitNull, newer, absent]).map(\.id)
            == [absent.id, newer.id, explicitNull.id])

        var legacy = thread("legacy")
        legacy.inboxFacts = nil
        legacy.settlementFacts = .init(latestTurn: .init(requestedAt: now))
        #expect(FeatureInboxPolicy.sortWorking([newer, legacy]).first?.id == legacy.id)
    }

    @Test
    func equalTimestampsUseWireIdentityThenEnvironment() {
        var first = thread("same")
        first.environmentID = "a"
        var second = thread("same")
        second.environmentID = "b"
        let last = thread("z")
        #expect(FeatureInboxPolicy.sortWorking([last, second, first]).map(\.environmentID)
            == ["a", "b", "computer"])
        #expect(FeatureInboxPolicy.sortInbox([last, second, first]).map(\.environmentID)
            == ["a", "b", "computer"])
    }

    @Test
    func shelfPrecedenceAndDisablingRestoreTheSavedArrangement() {
        var pinned = thread("pin")
        pinned.pinnedAt = now
        var snoozed = thread("snooze")
        snoozed.pinnedAt = now
        snoozed.isSettled = true
        snoozed.snoozedUntil = now.addingTimeInterval(60)
        var settled = thread("settled")
        settled.pinnedAt = now
        settled.isSettled = true
        var busy = thread("busy")
        busy.activeOrderKey = "b"
        var inbox = thread("inbox", runtime: "ready")
        inbox.state = .completed
        inbox.activeOrderKey = "m"
        var legacy = thread("legacy")
        legacy.inboxFacts = nil
        legacy.supportsSettlement = false
        legacy.isSettled = true
        legacy.activeOrderKey = "t"
        var snapshot = FeatureSnapshot(
            threads: [inbox, settled, snoozed, legacy, busy, pinned],
            settings: .init(workingShelfEnabled: true)
        )
        let enabled = DailyUXSidebarIndex(snapshot: snapshot, now: now)
        #expect(enabled.pinned.map(\.id) == [pinned.id])
        #expect(enabled.snoozed.map(\.id) == [snoozed.id])
        #expect(enabled.settled.map(\.id) == [settled.id])
        #expect(enabled.active.map(\.id) == [inbox.id])
        #expect(Set(enabled.working.map(\.id)) == [busy.id, legacy.id])
        snapshot.settings.workingShelfEnabled = false
        let disabled = DailyUXSidebarIndex(snapshot: snapshot, now: now)
        #expect(disabled.working.isEmpty)
        #expect(disabled.active.map(\.id) == [busy.id, inbox.id, legacy.id])
        #expect(disabled.active.map(\.activeOrderKey) == ["b", "m", "t"])
    }

    @Test
    func returnsTrackTransitionsAcrossEnvironmentsWithoutStampingTheBaseline() {
        var tracker = FeatureInboxReturnTracker()
        var first = thread("same")
        var second = thread("same")
        second.environmentID = "other"
        let transition0 = tracker.observe([first, second], at: now)
        #expect(!transition0)
        #expect(tracker.returnedAt(for: first) == nil)
        first.state = .waitingForApproval
        let transition1 = tracker.observe([first, second], at: now.addingTimeInterval(1))
        #expect(transition1)
        #expect(tracker.returnedAt(for: first) == now.addingTimeInterval(1))
        #expect(tracker.returnedAt(for: second) == nil)
        let transition2 = tracker.observe([first, second], at: now.addingTimeInterval(2))
        #expect(!transition2)
        #expect(tracker.returnedAt(for: first) == now.addingTimeInterval(1))
        first.state = .working
        tracker.observe([first, second], at: now.addingTimeInterval(3))
        first.inboxFacts?.runtimeStatus = "ready"
        tracker.observe([first, second], at: now.addingTimeInterval(4))
        #expect(tracker.returnedAt(for: first) == now.addingTimeInterval(4))
        tracker.observe([second], at: now.addingTimeInterval(5))
        #expect(tracker.returnedAt(for: first) == nil)
        second.state = .waitingForInput
        tracker.observe([second], at: now.addingTimeInterval(6))
        #expect(tracker.returnedAt(for: second) != nil)
        tracker.observe(nil)
        #expect(tracker.returnedAt(for: second) == nil)
        let transition3 = tracker.observe([first, second], at: now.addingTimeInterval(7))
        #expect(!transition3)
        #expect(tracker.returnedAt(for: first) == nil)
    }

    @Test
    func inboxUsesTheNewestServerOrObservedReturn() {
        var returned = thread("returned")
        var recent = thread("recent", runtime: "ready")
        recent.inboxFacts?.latestRunCompletedAt = now.addingTimeInterval(-10)
        var tracker = FeatureInboxReturnTracker()
        tracker.observe([returned, recent], at: now.addingTimeInterval(-5))
        returned.state = .waitingForInput
        #expect(FeatureInboxPolicy.sortInbox([returned, recent]).first?.id == recent.id)
        tracker.observe([returned, recent], at: now)
        #expect(FeatureInboxPolicy.sortInbox([recent, returned], returns: tracker).first?.id == returned.id)
        recent.unsettledAt = now.addingTimeInterval(1)
        #expect(FeatureInboxPolicy.sortInbox([returned, recent], returns: tracker).first?.id == recent.id)
    }

    @Test
    func activeDropsAreBlockedWhilePinsAndSavedKeysRemainAvailable() {
        var moved = thread("moved", runtime: "ready")
        moved.activeOrderKey = "t"
        var neighbor = thread("neighbor", runtime: "ready")
        neighbor.activeOrderKey = "b"
        let threads = [neighbor, moved]
        let active = ThreadArrangementDestination(section: .active, targetID: neighbor.id)
        #expect(ThreadArrangementPlanner.plan(
            id: moved.id, destination: active, threads: threads,
            connectedEnvironmentIDs: ["computer"], now: now, workingShelfEnabled: true
        ) == nil)
        #expect(ThreadOrderPlanner.planDrop(
            ordered: [moved, neighbor], all: threads, section: .active,
            connectedEnvironmentIDs: ["computer"], movedID: moved.id, workingShelfEnabled: true
        ) == nil)
        #expect(ThreadArrangementPlanner.plan(
            id: moved.id, destination: .init(section: .pinned), threads: threads,
            connectedEnvironmentIDs: ["computer"], now: now, workingShelfEnabled: true
        )?.section == .pinned)
        #expect(ThreadArrangementPlanner.plan(
            id: moved.id, destination: active, threads: threads,
            connectedEnvironmentIDs: ["computer"], now: now, workingShelfEnabled: false
        )?.orderedIDs == [moved.id, neighbor.id])
        #expect(threads.map(\.activeOrderKey) == ["b", "t"])
    }

    @Test
    func settingsDecodeOffByDefaultAndPersistTheOptIn() throws {
        let decoder = JSONDecoder()
        #expect(try !decoder.decode(FeatureSettings.self, from: Data("{}".utf8)).workingShelfEnabled)
        let settings = FeatureSettings(workingShelfEnabled: true)
        #expect(try decoder.decode(FeatureSettings.self, from: JSONEncoder().encode(settings)) == settings)
    }

    @Test @MainActor
    func cacheTracksToggleReturnsAndSearchesHiddenWorkingPreviews() {
        let cache = HomePresentationCache()
        var busy = thread("busy")
        busy.preview = "Needle"
        var ready = thread("ready", runtime: "ready")
        ready.inboxFacts?.latestRunCompletedAt = now.addingTimeInterval(-10)
        var snapshot = FeatureSnapshot(threads: [busy, ready])
        var returns = FeatureInboxReturnTracker()
        func presentation(query: String = "", rowRevision: UInt64 = 1) -> HomePresentation {
            cache.presentation(
                snapshot: snapshot, revision: 1, rowRevision: rowRevision, query: query,
                projectID: nil, now: now, inboxReturns: returns
            )
        }
        #expect(presentation().working.isEmpty)
        snapshot.settings.workingShelfEnabled = true
        returns.observe(snapshot.threads, at: now)
        #expect(presentation().working.map(\.id) == [busy.id])
        #expect(presentation(query: "needle").searchResults.map(\.id) == [busy.id])
        snapshot.threads[0].preview = "Changed output"
        #expect(presentation(query: "needle", rowRevision: 2).searchResults.isEmpty)
        #expect(presentation(rowRevision: 2).working.first?.preview == "Changed output")
        snapshot.threads[0].state = .waitingForApproval
        returns.observe(snapshot.threads, at: now.addingTimeInterval(1))
        #expect(presentation(rowRevision: 3).active.map(\.id) == [busy.id, ready.id])
        #expect(presentation(rowRevision: 3).working.isEmpty)
    }

    @Test
    func v2StreamingAndVisitEchoesOnlyInvalidateTheirRows() {
        var original = thread("busy")
        original.inboxFacts?.orchestrationVersion = 2
        original.inboxFacts?.runtimeUpdatedAt = now
        original.rawUpdatedAt = now.ISO8601Format()
        var changed = original
        changed.updatedAt = now.addingTimeInterval(1)
        changed.rawUpdatedAt = changed.updatedAt.ISO8601Format()
        changed.inboxFacts?.runtimeUpdatedAt = changed.updatedAt
        #expect(HomeOrderKey(changed) == HomeOrderKey(original))
        changed.inboxFacts?.lastVisitedAt = changed.rawUpdatedAt
        changed.inboxFacts?.lastVisitedAtIsPresent = true
        #expect(HomeOrderKey(changed) == HomeOrderKey(original))
        #expect(changed != original)
    }

    @Test
    func failureTimestampsAffectOrderOnlyWhenTheyCanWakeASnoozedThread() {
        var original = thread("failed", runtime: "failed")
        original.state = .failed
        original.inboxFacts?.orchestrationVersion = 2
        original.inboxFacts?.runtimeUpdatedAt = now
        var changed = original
        changed.inboxFacts?.runtimeUpdatedAt = now.addingTimeInterval(1)
        #expect(HomeOrderKey(changed) == HomeOrderKey(original))
        original.snoozedUntil = now.addingTimeInterval(300)
        original.snoozedAt = now
        changed.snoozedUntil = original.snoozedUntil
        changed.snoozedAt = original.snoozedAt
        #expect(HomeOrderKey(changed) != HomeOrderKey(original))
        #expect(original.isEffectivelySnoozed(at: now))
        #expect(!changed.isEffectivelySnoozed(at: now))
        original.inboxFacts?.runtimeStatus = "running"
        changed.inboxFacts?.runtimeStatus = "running"
        #expect(HomeOrderKey(changed) == HomeOrderKey(original))
    }

    @Test
    func classificationAndSortFactsInvalidateTheHomeOrderKey() {
        let original = thread("busy")
        var changed = original
        changed.inboxFacts?.latestUserAuthoredMessageAtIsPresent = true
        #expect(HomeOrderKey(changed) != HomeOrderKey(original))
        changed = original
        changed.inboxFacts?.hasActionableProposedPlan = true
        #expect(HomeOrderKey(changed) != HomeOrderKey(original))
        changed = original
        changed.settlementFacts = .init(hasPendingApprovals: true)
        #expect(HomeOrderKey(changed) != HomeOrderKey(original))
        changed = original
        changed.interactionMode = .plan
        #expect(HomeOrderKey(changed) != HomeOrderKey(original))
        changed = original
        changed.updatedAt = now.addingTimeInterval(1)
        changed.preview = "Streamed token"
        #expect(HomeOrderKey(changed) == HomeOrderKey(original))
    }
}
