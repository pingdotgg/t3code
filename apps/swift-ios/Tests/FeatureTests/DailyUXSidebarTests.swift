import Foundation
import Testing
@testable import T3Code

@Suite("Sidebar v2")
struct DailyUXSidebarTests {
    private let now = Date(timeIntervalSince1970: 2_000_000)

    @Test
    func snoozePresetsUseUsefulLocalClockBoundaries() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let now = try #require(
            ISO8601DateFormatter().date(from: "2026-08-18T17:00:00Z")
        )

        let presets = DailyUXSnoozePresets.resolve(now: now, calendar: calendar)

        #expect(presets.map(\.id) == [.hour, .threeHours, .evening, .tomorrow, .nextWeek])
        #expect(presets[0].until == now.addingTimeInterval(3_600))
        #expect(presets[1].until == now.addingTimeInterval(10_800))
        #expect(calendar.component(.hour, from: presets[2].until) == 18)
        #expect(calendar.component(.hour, from: presets[3].until) == 9)
        #expect(calendar.component(.weekday, from: presets[4].until) == 2)
        #expect(calendar.component(.hour, from: presets[4].until) == 9)
    }

    @Test
    func snoozePresetsHideEveningWhenItIsTooClose() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let now = try #require(
            ISO8601DateFormatter().date(from: "2026-08-19T00:30:00Z")
        )

        let presets = DailyUXSnoozePresets.resolve(now: now, calendar: calendar)

        #expect(!presets.map(\.id).contains(.evening))
    }

    @Test
    func activeOrderUsesCreationTimeAndDoesNotJumpWithActivity() {
        let olderCreationRecentActivity = thread(
            id: "old",
            created: -500,
            updated: -5,
            state: .working
        )
        let newerCreationOlderActivity = thread(
            id: "new",
            created: -100,
            updated: -80,
            state: .working
        )

        let index = makeIndex([olderCreationRecentActivity, newerCreationOlderActivity])

        #expect(index.active.map(\.id) == ["new", "old"])
    }

    @Test
    func reopenedThreadsReturnToTheTopWithoutReorderingOnOrdinaryActivity() {
        var reopened = thread(id: "old", created: -1_000, updated: -5)
        reopened.unsettledAt = now.addingTimeInterval(-10)
        let newer = thread(id: "new", created: -100, updated: 0, state: .working)

        #expect(makeIndex([newer, reopened]).active.map(\.id) == ["old", "new"])

        reopened.unsettledAt = now.addingTimeInterval(-2_000)
        #expect(makeIndex([newer, reopened]).active.map(\.id) == ["new", "old"])
    }

    @Test
    func settledUsesExplicitStateOrThreeDayRestingAge() {
        let explicitlySettled = thread(
            id: "explicit",
            created: -10,
            updated: -10,
            state: .idle,
            isSettled: true
        )
        let resting = thread(
            id: "resting",
            created: -400_000,
            updated: -300_000,
            state: .idle
        )
        let oldButWorking = thread(
            id: "working",
            created: -400_000,
            updated: -300_000,
            state: .working
        )
        let settledButWorking = thread(
            id: "settled-working",
            created: -400_000,
            updated: -300_000,
            state: .working,
            isSettled: true
        )
        let oldButWaiting = thread(
            id: "waiting",
            created: -400_000,
            updated: -300_000,
            state: .waitingForApproval
        )

        let index = makeIndex([
            explicitlySettled,
            resting,
            oldButWorking,
            settledButWorking,
            oldButWaiting,
        ])

        #expect(Set(index.settled.map(\.id)) == ["explicit", "resting"])
        #expect(Set(index.active.map(\.id)) == ["working", "settled-working", "waiting"])
    }

    @Test
    func explicitActiveOverridePreventsAutoSettlement() {
        var reopened = thread(
            id: "reopened",
            created: -400_000,
            updated: -300_000,
            state: .idle
        )
        reopened.keepsActive = true

        let index = makeIndex([reopened])

        #expect(index.active.map(\.id) == ["reopened"])
        #expect(index.settled.isEmpty)
    }

    @Test
    func settlementUsesServerActivityFactsInsteadOfDisplayState() {
        var staleRunningTurn = thread(
            id: "stale-running",
            created: -400_000,
            updated: -300_000,
            state: .working
        )
        staleRunningTurn.settlementFacts = facts(
            latestTurn: .init(
                requestedAt: now.addingTimeInterval(-300_100),
                startedAt: now.addingTimeInterval(-300_000)
            )
        )

        var monitor = staleRunningTurn
        monitor = FeatureThread(
            id: "monitor",
            projectID: monitor.projectID,
            title: monitor.title,
            createdAt: monitor.createdAt,
            updatedAt: monitor.updatedAt,
            state: .monitoring,
            lastActivityAt: monitor.lastActivityAt,
            supportsSettlement: true,
            settlementFacts: facts(latestUserMessageAt: now.addingTimeInterval(-300_000))
        )

        var live = staleRunningTurn
        live = FeatureThread(
            id: "live",
            projectID: live.projectID,
            title: live.title,
            createdAt: live.createdAt,
            updatedAt: live.updatedAt,
            state: .idle,
            lastActivityAt: live.lastActivityAt,
            supportsSettlement: true,
            settlementFacts: facts(sessionStatus: "running")
        )

        let index = makeIndex([staleRunningTurn, monitor, live])
        #expect(Set(index.settled.map(\.id)) == ["stale-running", "monitor"])
        #expect(index.active.map(\.id) == ["live"])
    }

    @Test
    func explicitSettlementHonorsQueuedServerAdjudication() {
        let messageAt = now.addingTimeInterval(-30)
        var queued = thread(id: "queued", created: -100, updated: -30, state: .queued)
        queued.settlementFacts = facts(
            override: .settled,
            latestUserMessageAt: messageAt,
            latestTurn: .init(requestedAt: now.addingTimeInterval(-90))
        )
        queued.isSettled = true
        queued.settledAt = messageAt.addingTimeInterval(1)

        #expect(queued.hasQueuedTurnStart(at: now))
        #expect(queued.isEffectivelySettled(at: now))
        #expect(HomeThreadSwipeAction.trailingActions(
            for: queued,
            isArchived: false,
            at: now
        ).first == .reopen)

        queued.settledAt = messageAt.addingTimeInterval(-1)
        #expect(!queued.isEffectivelySettled(at: now))
        #expect(queued.queuedSettlementBoundary(after: now) == now.addingTimeInterval(90.001))

        queued.settlementFacts?.hasPendingApprovals = true
        queued.settledAt = messageAt.addingTimeInterval(1)
        #expect(!queued.isEffectivelySettled(at: now))
        #expect(!queued.canSettleNow(at: now))
    }

    @Test
    func pullRequestSettlementMatchesTerminalStateAndUserActivity() {
        var thread = thread(id: "pr", created: -400_000, updated: -300_000)
        thread.settlementFacts = facts(
            latestUserMessageAt: now.addingTimeInterval(-300_000),
            latestTurn: .init(requestedAt: now.addingTimeInterval(-300_000))
        )
        let merged = HomeThreadPullRequestPresentation(
            number: 42,
            state: .merged,
            updatedAt: now.addingTimeInterval(-400)
        )
        let closed = HomeThreadPullRequestPresentation(
            number: 42,
            state: .closed,
            updatedAt: now.addingTimeInterval(-400)
        )
        let open = HomeThreadPullRequestPresentation(
            number: 42,
            state: .open,
            updatedAt: now.addingTimeInterval(-400)
        )
        let disabled = FeatureSettings(autoSettleOnMerge: false, autoSettleAfterDays: nil)

        #expect(thread.isEffectivelySettled(at: now, pullRequest: merged))
        #expect(!thread.isEffectivelySettled(at: now, settings: disabled, pullRequest: merged))
        #expect(thread.isEffectivelySettled(at: now, settings: disabled, pullRequest: closed))
        #expect(!thread.isEffectivelySettled(at: now, pullRequest: open))

        let inheritedMerge = HomeThreadPullRequestPresentation(
            number: 42,
            state: .merged,
            updatedAt: thread.createdAt.addingTimeInterval(-1)
        )
        #expect(!thread.isEffectivelySettled(
            at: now,
            settings: FeatureSettings(autoSettleAfterDays: nil),
            pullRequest: inheritedMerge
        ))
        #expect(thread.isEffectivelySettled(
            at: now,
            pullRequest: HomeThreadPullRequestPresentation(
                number: 42,
                state: .merged,
                updatedAt: nil
            )
        ))

        thread.settlementFacts?.latestUserMessageAt = now.addingTimeInterval(-300)
        #expect(!thread.isEffectivelySettled(at: now, pullRequest: merged))

        thread.settlementFacts?.latestUserMessageAt = now.addingTimeInterval(-300_000)
        thread.settlementFacts?.sessionStatus = "running"
        #expect(!thread.isEffectivelySettled(at: now, pullRequest: merged))
        thread.settlementFacts?.sessionStatus = "idle"
        #expect(thread.isEffectivelySettled(at: now, pullRequest: merged))
    }

    @Test
    func inactivityUsesCustomStrictBoundaryAndCanBeDisabled() {
        var thread = thread(id: "inactive", created: -200_000, updated: -86_400)
        thread.settlementFacts = facts(latestUserMessageAt: now.addingTimeInterval(-86_400))
        let oneDay = FeatureSettings(autoSettleAfterDays: 1)

        #expect(!thread.isEffectivelySettled(at: now, settings: oneDay))
        #expect(thread.isEffectivelySettled(at: now.addingTimeInterval(0.001), settings: oneDay))
        #expect(!thread.isEffectivelySettled(
            at: now.addingTimeInterval(0.001),
            settings: FeatureSettings(autoSettleAfterDays: nil)
        ))

        thread.pinnedAt = now.addingTimeInterval(-10)
        let boundary = DailyUXSidebarRefresh.nextBoundary(
            for: [thread],
            after: now.addingTimeInterval(-1),
            settings: oneDay
        )
        #expect(boundary == now.addingTimeInterval(0.001))
    }

    @Test
    func settledAndSnoozedThreadsStayInTheirShelvesWhenPinned() {
        var pinnedSettled = thread(
            id: "pinned-settled",
            created: -100,
            updated: -400_000,
            state: .idle,
            isSettled: true
        )
        pinnedSettled.pinnedAt = now.addingTimeInterval(-20)

        var pinnedSnoozed = thread(
            id: "pinned-snoozed",
            created: -50,
            updated: -10
        )
        pinnedSnoozed.pinnedAt = now.addingTimeInterval(-10)
        pinnedSnoozed.snoozedUntil = now.addingTimeInterval(3_600)

        let index = makeIndex([pinnedSettled, pinnedSnoozed])

        #expect(index.pinned.isEmpty)
        #expect(index.snoozed.map(\.id) == ["pinned-snoozed"])
        #expect(index.active.isEmpty)
        #expect(index.settled.map(\.id) == ["pinned-settled"])
        #expect(DailyUXSidebarRefresh.nextBoundary(for: [pinnedSettled], after: now) == nil)
    }

    @Test
    func pinActionsRequireCapabilitiesAndKeepPinsReversible() {
        var legacyDescriptor = thread(id: "legacy", created: -20, updated: -10)
        legacyDescriptor.supportsPinning = nil
        #expect(!legacyDescriptor.canTogglePin)

        var explicitlyUnsupported = thread(id: "unsupported", created: -20, updated: -10)
        explicitlyUnsupported.supportsPinning = false
        #expect(!explicitlyUnsupported.canTogglePin)

        explicitlyUnsupported.pinnedAt = now
        #expect(explicitlyUnsupported.canTogglePin)
    }

    @Test
    func lifecycleActionsHonorCapabilitiesAndKeepReverseActionsReachable() {
        var capabilityThread = thread(id: "capabilities", created: -20, updated: -10)
        capabilityThread.supportsSettlement = false
        capabilityThread.supportsSnooze = false
        #expect(!capabilityThread.canToggleSettlement)
        #expect(!capabilityThread.canToggleSnooze)

        capabilityThread.isSettled = true
        capabilityThread.snoozedUntil = now.addingTimeInterval(3_600)
        #expect(capabilityThread.canToggleSettlement)
        #expect(capabilityThread.canToggleSnooze)

        var legacy = thread(id: "legacy-capabilities", created: -20, updated: -10)
        legacy.supportsSettlement = nil
        legacy.supportsSnooze = nil
        #expect(!legacy.canToggleSettlement)
        #expect(!legacy.canToggleSnooze)
    }

    @Test
    func snoozedThreadsHaveAReachableReverseState() {
        var snoozed = thread(id: "snoozed", created: -20, updated: -10)
        snoozed.snoozedUntil = now.addingTimeInterval(3_600)
        var archived = thread(id: "archived", created: -30, updated: -20)
        archived.isArchived = true
        let visible = thread(id: "visible", created: -10, updated: -5)

        let index = makeIndex([snoozed, archived, visible])

        #expect(index.active.map(\.id) == ["visible"])
        #expect(index.snoozed.map(\.id) == ["snoozed"])
        #expect(index.settled.isEmpty)
    }

    @Test
    func snoozeExpiresAtTheClockBoundary() {
        var thread = thread(id: "timed", created: -20, updated: -10)
        thread.snoozedUntil = now.addingTimeInterval(30)

        #expect(makeIndex([thread]).snoozed.map(\.id) == ["timed"])
        let expired = DailyUXSidebarIndex(
            snapshot: FeatureSnapshot(threads: [thread]),
            query: "",
            now: now.addingTimeInterval(31)
        )
        #expect(expired.active.map(\.id) == ["timed"])
    }

    @Test
    func parentRefreshIgnoresWorkingTimersAndTargetsShelfBoundaries() {
        var working = thread(
            id: "working",
            created: -20,
            updated: -10,
            state: .working
        )
        working.workingStartedAt = now.addingTimeInterval(-90)

        #expect(DailyUXSidebarRefresh.nextBoundary(for: [working], after: now) == nil)

        var laterSnooze = thread(id: "later", created: -30, updated: -20)
        laterSnooze.snoozedUntil = now.addingTimeInterval(600)
        var earlierSnooze = thread(id: "earlier", created: -40, updated: -30)
        earlierSnooze.snoozedUntil = now.addingTimeInterval(120)

        #expect(
            DailyUXSidebarRefresh.nextBoundary(
                for: [working, laterSnooze, earlierSnooze],
                after: now
            ) == earlierSnooze.snoozedUntil
        )
    }

    @Test
    func parentRefreshIncludesAutomaticSettlementBoundary() {
        var resting = thread(
            id: "resting",
            created: -100,
            updated: -100,
            state: .idle
        )
        resting.lastActivityAt = now.addingTimeInterval(-(3 * 24 * 60 * 60) + 45)

        #expect(
            DailyUXSidebarRefresh.nextBoundary(for: [resting], after: now)
                == now.addingTimeInterval(45.001)
        )

        resting.keepsActive = true
        #expect(DailyUXSidebarRefresh.nextBoundary(for: [resting], after: now) == nil)
    }

    @Test
    func onlyFailuresRaisedAfterSnoozingWakeTheThread() {
        var acknowledged = thread(
            id: "acknowledged",
            created: -30,
            updated: -10,
            state: .failed
        )
        acknowledged.snoozedUntil = now.addingTimeInterval(3_600)
        acknowledged.snoozedAt = now.addingTimeInterval(-10)
        acknowledged.attentionAt = now.addingTimeInterval(-20)

        var fresh = acknowledged
        fresh = FeatureThread(
            id: "fresh",
            projectID: fresh.projectID,
            title: fresh.title,
            createdAt: fresh.createdAt,
            updatedAt: fresh.updatedAt,
            state: .failed,
            lastActivityAt: fresh.lastActivityAt,
            snoozedUntil: fresh.snoozedUntil,
            snoozedAt: fresh.snoozedAt,
            attentionAt: now.addingTimeInterval(-5)
        )

        let index = makeIndex([acknowledged, fresh])

        #expect(index.snoozed.map(\.id) == ["acknowledged"])
        #expect(index.active.map(\.id) == ["fresh"])
    }

    @Test
    func projectFilterAndSearchUseRepositoryContext() {
        let projects = [
            FeatureProject(id: "p1", environmentID: "e", name: "Mobile", path: "/work/mobile"),
            FeatureProject(id: "p2", environmentID: "e", name: "Server", path: "/work/server"),
        ]
        let mobile = thread(id: "mobile", projectID: "p1", title: "Polish picker", created: -10, updated: -5)
        let server = thread(id: "server", projectID: "p2", title: "Compression", created: -20, updated: -5)
        let snapshot = FeatureSnapshot(projects: projects, threads: [mobile, server])

        let filtered = DailyUXSidebarIndex(snapshot: snapshot, query: "", projectID: "p1", now: now)
        let searched = DailyUXSidebarIndex(snapshot: snapshot, query: "server", now: now)

        #expect(filtered.active.map(\.id) == ["mobile"])
        #expect(searched.searchResults.map(\.id) == ["server"])
    }

    @Test
    func searchHandlesScopedClonesAndLegacyDuplicateProjectIDs() {
        let localProjectID = FeatureScopedID.project(
            environmentID: "local",
            wireID: "project-shared"
        )
        let remoteProjectID = FeatureScopedID.project(
            environmentID: "remote",
            wireID: "project-shared"
        )
        let projects = [
            FeatureProject(
                id: localProjectID,
                wireID: "project-shared",
                environmentID: "local",
                name: "Mobile",
                path: "/work/mobile"
            ),
            FeatureProject(
                id: remoteProjectID,
                wireID: "project-shared",
                environmentID: "remote",
                name: "Server",
                path: "/work/server"
            ),
        ]
        let local = thread(
            id: "local-thread",
            projectID: localProjectID,
            title: "Polish",
            created: -10,
            updated: -5
        )
        let remote = thread(
            id: "remote-thread",
            projectID: remoteProjectID,
            title: "Compression",
            created: -20,
            updated: -5
        )
        let scoped = FeatureSnapshot(projects: projects, threads: [local, remote])

        #expect(
            DailyUXSidebarIndex(snapshot: scoped, query: "server", now: now)
                .searchResults.map(\.id) == ["remote-thread"]
        )

        let legacyDuplicates = FeatureSnapshot(
            projects: projects.map {
                FeatureProject(
                    id: "project-shared",
                    environmentID: $0.environmentID,
                    name: $0.name,
                    path: $0.path
                )
            },
            threads: [
                thread(
                    id: "legacy",
                    projectID: "project-shared",
                    title: "Legacy",
                    created: -10,
                    updated: -5
                ),
            ]
        )
        #expect(
            DailyUXSidebarIndex(snapshot: legacyDuplicates, query: "server", now: now)
                .searchResults.map(\.id) == ["legacy"]
        )
    }

    @Test
    func attentionScopesRemainFocusedSubsetsOfActive() {
        let approval = thread(
            id: "approval",
            title: "Approve schema",
            created: -10,
            updated: -5,
            state: .waitingForApproval
        )
        let input = thread(
            id: "input",
            title: "Answer migration question",
            created: -20,
            updated: -5,
            state: .waitingForInput
        )
        let failed = thread(
            id: "failed",
            title: "Failed build",
            created: -30,
            updated: -5,
            state: .failed
        )
        let working = thread(
            id: "working",
            title: "Build application",
            created: -40,
            updated: -5,
            state: .working
        )

        let snapshot = FeatureSnapshot(threads: [approval, input, failed, working])
        let index = DailyUXSidebarIndex(snapshot: snapshot, query: "", now: now)

        #expect(index.active.map(\.id) == ["approval", "input", "failed", "working"])
        #expect(index.needsInput.map(\.id) == ["approval", "input"])
        #expect(index.failed.map(\.id) == ["failed"])
        #expect(
            DailyUXSidebarIndex.matchingThreads(
                index.failed,
                snapshot: snapshot,
                query: "build"
            ).map(\.id) == ["failed"]
        )
        #expect(
            DailyUXSidebarIndex.matchingThreads(
                index.needsInput,
                snapshot: snapshot,
                query: "build"
            ).isEmpty
        )
    }

    @Test
    func largeWorkingCollectionKeepsStableOrderWithoutParentTimerRefresh() {
        let threads = (0..<5_000).map { offset in
            thread(
                id: "thread-\(offset)",
                created: -Double(offset),
                updated: -Double(offset),
                state: .working
            )
        }

        let index = makeIndex(threads)

        #expect(index.active.count == threads.count)
        #expect(index.active.prefix(3).map(\.id) == ["thread-0", "thread-1", "thread-2"])
        #expect(index.active.last?.id == "thread-4999")
        #expect(DailyUXSidebarRefresh.nextBoundary(for: threads, after: now) == nil)
    }

    @Test
    func compactRelativeAgeClampsFutureDatesAndUsesStableUnits() {
        #expect(
            SidebarRelativeAge.compact(
                since: now.addingTimeInterval(5),
                now: now
            ) == "now"
        )
        #expect(
            SidebarRelativeAge.compact(
                since: now.addingTimeInterval(-125),
                now: now
            ) == "2m"
        )
        #expect(
            SidebarRelativeAge.compact(
                since: now.addingTimeInterval(-7_300),
                now: now
            ) == "2h"
        )
        #expect(
            SidebarRelativeAge.accessibility(
                since: now.addingTimeInterval(-3_600),
                now: now
            ) == "Updated 1 hour ago"
        )
    }

    private func makeIndex(_ threads: [FeatureThread]) -> DailyUXSidebarIndex {
        DailyUXSidebarIndex(
            snapshot: FeatureSnapshot(threads: threads),
            query: "",
            now: now
        )
    }

    private func thread(
        id: String,
        projectID: String = "project",
        title: String = "Task",
        created: TimeInterval,
        updated: TimeInterval,
        state: FeatureThreadState = .idle,
        isSettled: Bool = false
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            projectID: projectID,
            title: title,
            createdAt: now.addingTimeInterval(created),
            updatedAt: now.addingTimeInterval(updated),
            state: state,
            isSettled: isSettled,
            lastActivityAt: now.addingTimeInterval(updated),
            supportsSettlement: true,
            supportsSnooze: true,
            supportsPinning: true
        )
    }

    private func facts(
        override: FeatureThreadSettlementOverride? = nil,
        sessionStatus: String? = nil,
        hasPendingApprovals: Bool = false,
        hasPendingUserInput: Bool = false,
        latestUserMessageAt: Date? = nil,
        latestTurn: FeatureThreadSettlementFacts.LatestTurn? = nil
    ) -> FeatureThreadSettlementFacts {
        FeatureThreadSettlementFacts(
            settlementOverride: override,
            sessionStatus: sessionStatus,
            hasPendingApprovals: hasPendingApprovals,
            hasPendingUserInput: hasPendingUserInput,
            latestUserMessageAt: latestUserMessageAt,
            latestTurn: latestTurn
        )
    }
}
