import Foundation
import Testing
@testable import T3Code

@Suite("Sidebar v2")
struct DailyUXSidebarTests {
    private let now = Date(timeIntervalSince1970: 2_000_000)

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
    func pinPromotesSettledThreadsButSnoozeStillWins() {
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

        #expect(index.pinned.map(\.id) == ["pinned-settled"])
        #expect(index.snoozed.map(\.id) == ["pinned-snoozed"])
        #expect(index.active.isEmpty)
        #expect(index.settled.isEmpty)
        #expect(DailyUXSidebarRefresh.nextBoundary(for: [pinnedSettled], after: now) == nil)
    }

    @Test
    func pinnedThreadSwipeIncludesUnpinAndSettle() {
        var pinned = thread(
            id: "pinned",
            created: -100,
            updated: -50,
            state: .idle
        )
        pinned.pinnedAt = now

        let actions = HomeThreadSwipeActions.kinds(
            for: pinned,
            isArchived: false,
            now: now
        )

        #expect(actions == [.settle, .unpin, .delete])
        #expect(actions.first == .settle)
        #expect(actions.last == .delete)
    }

    @Test(arguments: [
        FeatureThreadState.queued,
        .working,
        .monitoring,
        .waitingForApproval,
        .waitingForInput,
    ])
    func blockedThreadsDoNotOfferSettleAsAFullSwipe(state: FeatureThreadState) {
        let blocked = thread(
            id: state.rawValue,
            created: -100,
            updated: -50,
            state: state,
            settlementEligible: false
        )

        #expect(blocked.canSettle == false)
        #expect(
            HomeThreadSwipeActions.kinds(
                for: blocked,
                isArchived: false,
                now: now
            ) == [.archive, .delete]
        )
        #expect(
            !HomeThreadSwipeActions.allowsFullSwipe(
                for: blocked,
                isArchived: false,
                now: now
            )
        )
    }

    @Test
    func freshUnadoptedUserMessageBlocksSettlementProjection() {
        let eligible = FeatureSettlementProjection.canSettle(
            FeatureSettlementProjectionInput(
                hasPendingApprovals: false,
                hasPendingUserInput: false,
                sessionStatus: nil,
                latestUserMessageAt: now.addingTimeInterval(-30).ISO8601Format(),
                latestTurnRequestedAt: nil,
                latestTurnStartedAt: nil,
                latestTurnCompletedAt: nil
            ),
            now: now
        )

        #expect(!eligible)
    }

    @Test
    func fractionalSecondUserMessageBlocksSettlementProjection() {
        let eligible = FeatureSettlementProjection.canSettle(
            FeatureSettlementProjectionInput(
                hasPendingApprovals: false,
                hasPendingUserInput: false,
                sessionStatus: nil,
                latestUserMessageAt: "1970-01-24T03:32:50.000Z",
                latestTurnRequestedAt: nil,
                latestTurnStartedAt: nil,
                latestTurnCompletedAt: nil
            ),
            now: now
        )

        #expect(!eligible)
    }

    @Test
    func queuedTurnAndFutureMessageBlockSettlementProjection() {
        let queued = FeatureSettlementProjectionInput(
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            sessionStatus: nil,
            latestUserMessageAt: now.addingTimeInterval(-30).ISO8601Format(),
            latestTurnRequestedAt: now.addingTimeInterval(-20).ISO8601Format(),
            latestTurnStartedAt: nil,
            latestTurnCompletedAt: nil
        )
        let future = FeatureSettlementProjectionInput(
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            sessionStatus: nil,
            latestUserMessageAt: now.addingTimeInterval(300).ISO8601Format(),
            latestTurnRequestedAt: nil,
            latestTurnStartedAt: nil,
            latestTurnCompletedAt: nil
        )

        #expect(!FeatureSettlementProjection.canSettle(queued, now: now))
        #expect(!FeatureSettlementProjection.canSettle(future, now: now))
    }

    @Test(arguments: [FeatureThreadState.working, .monitoring])
    func backgroundOnlyShellsRemainSettlementEligible(state: FeatureThreadState) {
        let eligible = FeatureSettlementProjection.canSettle(
            FeatureSettlementProjectionInput(
                hasPendingApprovals: false,
                hasPendingUserInput: false,
                sessionStatus: nil,
                latestUserMessageAt: now.addingTimeInterval(-300).ISO8601Format(),
                latestTurnRequestedAt: nil,
                latestTurnStartedAt: nil,
                latestTurnCompletedAt: nil
            ),
            now: now
        )
        let projected = thread(
            id: state.rawValue,
            created: -300,
            updated: -300,
            state: state,
            settlementEligible: eligible
        )

        #expect(eligible)
        #expect(projected.canSettle)
        #expect(
            HomeThreadSwipeActions.kinds(for: projected, isArchived: false, now: now).first
                == .settle
        )
    }

    @Test
    func detailPendingRequestsKeepHomeSettlementAndFullSwipeBlocked() {
        let base = FeatureSettlementProjectionInput(
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            sessionStatus: nil,
            latestUserMessageAt: now.addingTimeInterval(-300).ISO8601Format(),
            latestTurnRequestedAt: nil,
            latestTurnStartedAt: nil,
            latestTurnCompletedAt: nil
        )
        var pendingApproval = thread(
            id: "approval",
            created: -300,
            updated: -300,
            settlementEligible: true
        )
        pendingApproval.settlementInput = base.withPendingRequests(
            approvals: true,
            userInput: false
        )
        var pendingInput = thread(
            id: "input",
            created: -300,
            updated: -300,
            settlementEligible: true
        )
        pendingInput.settlementInput = base.withPendingRequests(
            approvals: false,
            userInput: true
        )

        for thread in [pendingApproval, pendingInput] {
            #expect(!thread.canSettle)
            #expect(
                HomeThreadSwipeActions.kinds(for: thread, isArchived: false, now: now)
                    == [.archive, .delete]
            )
            #expect(
                !HomeThreadSwipeActions.allowsFullSwipe(for: thread, isArchived: false, now: now)
            )
        }
    }

    @Test
    func fullSwipeAlwaysChoosesAReversibleAction() {
        let settled = thread(
            id: "settled",
            created: -100,
            updated: -50,
            state: .idle,
            isSettled: true
        )
        var fallback = thread(id: "fallback", created: -100, updated: -50, state: .idle)
        fallback.supportsSettlement = false
        let shapes = [
            HomeThreadSwipeActions.kinds(for: fallback, isArchived: true, now: now),
            HomeThreadSwipeActions.kinds(for: settled, isArchived: false, now: now),
            HomeThreadSwipeActions.kinds(for: fallback, isArchived: false, now: now),
        ]

        #expect(shapes[0] == [.restore, .delete])
        #expect(shapes[1].first == .reopen)
        #expect(shapes[2] == [.archive, .delete])
        #expect(shapes.allSatisfy { $0.first != .delete })
    }

    @Test
    func pinActionsTolerateMissingCapabilitiesAndKeepPinsReversible() {
        var legacyDescriptor = thread(id: "legacy", created: -20, updated: -10)
        legacyDescriptor.supportsPinning = nil
        #expect(legacyDescriptor.canTogglePin)

        var explicitlyUnsupported = thread(id: "unsupported", created: -20, updated: -10)
        explicitlyUnsupported.supportsPinning = false
        #expect(!explicitlyUnsupported.canTogglePin)

        explicitlyUnsupported.pinnedAt = now
        #expect(explicitlyUnsupported.canTogglePin)
    }

    @Test
    func pinnedBlockedThreadCanFullSwipeToUnpin() {
        var pinned = thread(
            id: "pinned-blocked",
            created: -20,
            updated: -10,
            state: .queued,
            settlementEligible: false
        )
        pinned.pinnedAt = now.addingTimeInterval(-5)

        #expect(
            HomeThreadSwipeActions.kinds(for: pinned, isArchived: false, now: now).first
                == .unpin
        )
        #expect(HomeThreadSwipeActions.allowsFullSwipe(for: pinned, isArchived: false, now: now))
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
        #expect(legacy.canToggleSettlement)
        #expect(legacy.canToggleSnooze)
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
                == now.addingTimeInterval(45)
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
        isSettled: Bool = false,
        settlementEligible: Bool = true
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
            settlementInput: FeatureSettlementProjectionInput(
                hasPendingApprovals: !settlementEligible,
                hasPendingUserInput: false,
                sessionStatus: nil,
                latestUserMessageAt: nil,
                latestTurnRequestedAt: nil,
                latestTurnStartedAt: nil,
                latestTurnCompletedAt: nil
            )
        )
    }
}
