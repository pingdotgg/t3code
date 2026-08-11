import Foundation
import Testing
@testable import T3Code

@Suite("Sidebar v2")
struct DailyUXSidebarTests {
    @Test
    func threadDeletionConfirmationCanBeCancelledAndReplaced() {
        var confirmation = HomeThreadDeleteConfirmation()

        confirmation.present(threadID: "thread-1", title: "Investigate swipe behavior")
        #expect(
            confirmation.request
                == HomeThreadDeleteRequest(
                    id: "thread-1",
                    title: "Investigate swipe behavior"
                )
        )

        confirmation.present(threadID: "thread-2", title: "Keep me")
        confirmation.cancel()
        #expect(confirmation.request == nil)

        confirmation.present(threadID: "thread-3", title: "Replace me")
        confirmation.present(threadID: "thread-4", title: "Delete me")
        #expect(confirmation.request?.id == "thread-4")
    }

    private let now = Date(timeIntervalSince1970: 2_000_000)

    @Test
    func swipePlanKeepsDeleteOutOfTheFullSwipeSlot() {
        let active = thread(id: "active", created: -20, updated: -10)
        let settled = thread(
            id: "settled",
            created: -20,
            updated: -10,
            isSettled: true
        )
        let settledButWorking = thread(
            id: "settled-working",
            created: -20,
            updated: -10,
            state: .working,
            isSettled: true
        )
        let pinned = thread(
            id: "pinned",
            created: -20,
            updated: -10,
            pinned: -5
        )
        let archiveOnly = thread(
            id: "archive-only",
            created: -20,
            updated: -10,
            supportsSettlement: false
        )

        let activePlan = HomeThreadSwipeActionPlan.make(
            thread: active,
            isArchived: false,
            now: now
        )
        let settledPlan = HomeThreadSwipeActionPlan.make(
            thread: settled,
            isArchived: false,
            now: now
        )
        let settledButWorkingPlan = HomeThreadSwipeActionPlan.make(
            thread: settledButWorking,
            isArchived: false,
            now: now
        )
        let archivedPlan = HomeThreadSwipeActionPlan.make(
            thread: active,
            isArchived: true,
            now: now
        )
        let pinnedPlan = HomeThreadSwipeActionPlan.make(
            thread: pinned,
            isArchived: false,
            now: now
        )
        let archiveOnlyPlan = HomeThreadSwipeActionPlan.make(
            thread: archiveOnly,
            isArchived: false,
            now: now
        )

        #expect(activePlan.actions == [.settle, .delete])
        #expect(settledPlan.actions == [.reopen, .delete])
        #expect(settledButWorkingPlan.actions == [.reopen, .delete])
        #expect(archivedPlan.actions == [.restore, .delete])
        #expect(pinnedPlan.actions == [.unpin, .delete])
        #expect(archiveOnlyPlan.actions == [.archive, .delete])
        #expect(activePlan.performsFirstActionWithFullSwipe)
        #expect(settledPlan.performsFirstActionWithFullSwipe)
        #expect(settledButWorkingPlan.performsFirstActionWithFullSwipe)
        #expect(!archivedPlan.performsFirstActionWithFullSwipe)
        #expect(!pinnedPlan.performsFirstActionWithFullSwipe)
        #expect(!archiveOnlyPlan.performsFirstActionWithFullSwipe)
    }

    @Test
    func settleUndoCapturesOnlyStateThatSettlementClears() {
        let snoozeUntil = now.addingTimeInterval(300)
        let pinnedAndSnoozed = thread(
            id: "pinned",
            created: -20,
            updated: -10,
            pinned: -5,
            snoozedUntil: snoozeUntil
        )
        let snoozedOnly = thread(
            id: "snoozed",
            created: -20,
            updated: -10,
            snoozedUntil: snoozeUntil
        )

        #expect(
            HomeThreadSettleUndoRestoration.capture(from: pinnedAndSnoozed)
                == HomeThreadSettleUndoRestoration(
                    restoresPin: true,
                    restoresSnoozeUntil: snoozeUntil
                )
        )
        #expect(
            HomeThreadSettleUndoRestoration.capture(from: snoozedOnly)
                == HomeThreadSettleUndoRestoration(
                    restoresPin: false,
                    restoresSnoozeUntil: nil
                )
        )
    }

    @Test
    func reopeningDoesNotSupersedeAnInFlightSettleNotice() {
        let settleRequestID = UUID()
        var state = HomeThreadSettleUndoState()

        #expect(
            state.beginSettleRequest(ifSettling: true, id: settleRequestID)
                == settleRequestID
        )
        #expect(state.beginSettleRequest(ifSettling: false) == nil)
        #expect(state.latestSettleRequestID == settleRequestID)
    }

    @Test
    func settleUndoDismissesOnlyTheMatchingThread() {
        var state = HomeThreadSettleUndoState()
        let requestID = state.beginSettleRequest()
        state.present(
            requestID: requestID,
            threadID: "target",
            title: "Target",
            restoresPin: false,
            restoresSnoozeUntil: nil
        )

        state.dismiss(threadID: "other")
        #expect(state.notice?.threadID == "target")
        state.dismiss(threadID: "target")
        #expect(state.notice == nil)
    }

    @Test
    func dismissingAThreadCancelsOnlyItsPendingSettleNotice() {
        var state = HomeThreadSettleUndoState()
        let targetRequestID = state.beginSettleRequest(threadID: "target")

        state.dismiss(threadID: "other")
        #expect(state.latestSettleRequestID == targetRequestID)
        #expect(state.latestSettleThreadID == "target")

        state.dismiss(threadID: "target")
        #expect(state.latestSettleRequestID == nil)
        #expect(state.latestSettleThreadID == nil)
        #expect(
            state.present(
                requestID: targetRequestID,
                threadID: "target",
                title: "Target",
                restoresPin: false,
                restoresSnoozeUntil: nil
            ) == nil
        )
    }

    @Test
    func settleUndoRejectsAThreadThatDoesNotMatchTheRequest() {
        var state = HomeThreadSettleUndoState()
        let requestID = state.beginSettleRequest(threadID: "target")

        #expect(
            state.present(
                requestID: requestID,
                threadID: "other",
                title: "Other",
                restoresPin: false,
                restoresSnoozeUntil: nil
            ) == nil
        )
        #expect(state.notice == nil)
        #expect(state.latestSettleRequestID == requestID)
        #expect(state.latestSettleThreadID == "target")
    }

    @Test
    func settleUndoRequestCanPresentOnlyOnce() {
        var state = HomeThreadSettleUndoState()
        let requestID = state.beginSettleRequest(threadID: "target")

        #expect(
            state.present(
                requestID: requestID,
                threadID: "target",
                title: "Target",
                restoresPin: false,
                restoresSnoozeUntil: nil
            ) != nil
        )
        #expect(
            state.present(
                requestID: requestID,
                threadID: "target",
                title: "Target again",
                restoresPin: false,
                restoresSnoozeUntil: nil
            ) == nil
        )
        #expect(state.notice?.title == "Target")
    }

    @Test
    func settleUndoTargetsOnlyTheLatestNoticeOnce() {
        let firstID = UUID()
        let secondID = UUID()
        var state = HomeThreadSettleUndoState()
        let firstRequestID = state.beginSettleRequest()

        state.present(
            requestID: firstRequestID,
            threadID: "first",
            title: "First thread",
            restoresPin: false,
            restoresSnoozeUntil: nil,
            id: firstID
        )
        let secondRequestID = state.beginSettleRequest()
        state.present(
            requestID: secondRequestID,
            threadID: "second",
            title: "Second thread",
            restoresPin: true,
            restoresSnoozeUntil: now.addingTimeInterval(300),
            id: secondID
        )

        state.expire(id: firstID)
        #expect(state.notice?.threadID == "second")
        #expect(state.takeUndo(id: firstID) == nil)
        let undo = state.takeUndo(id: secondID)
        #expect(undo?.restoresPin == true)
        #expect(undo?.restoresSnoozeUntil == now.addingTimeInterval(300))
        #expect(state.takeUndo(id: secondID) == nil)
    }

    @Test
    func settleUndoExpiresOnlyItsCurrentNotice() {
        let noticeID = UUID()
        var state = HomeThreadSettleUndoState()
        let requestID = state.beginSettleRequest()

        state.present(
            requestID: requestID,
            threadID: "thread",
            title: "Thread",
            restoresPin: false,
            restoresSnoozeUntil: nil,
            id: noticeID
        )
        state.expire(id: noticeID)

        #expect(state.notice == nil)
    }

    @Test
    func settleUndoRejectsAnOlderRequestThatFinishesLast() {
        var state = HomeThreadSettleUndoState()
        let firstRequestID = state.beginSettleRequest()
        let secondRequestID = state.beginSettleRequest()

        let stale = state.present(
            requestID: firstRequestID,
            threadID: "first",
            title: "First",
            restoresPin: false,
            restoresSnoozeUntil: nil
        )
        let current = state.present(
            requestID: secondRequestID,
            threadID: "second",
            title: "Second",
            restoresPin: false,
            restoresSnoozeUntil: nil
        )

        #expect(stale == nil)
        #expect(current?.threadID == "second")
        #expect(state.notice?.threadID == "second")
    }

    @Test
    func settleUndoAppearsOnlyAfterAConfirmedSettlement() {
        let settled = thread(
            id: "settled",
            created: -20,
            updated: -10,
            isSettled: true
        )
        let active = thread(id: "active", created: -20, updated: -10)

        #expect(
            HomeThreadSettleUndoState.shouldPresent(
                afterRequesting: true,
                didSucceed: true,
                updatedThread: settled
            )
        )
        #expect(
            !HomeThreadSettleUndoState.shouldPresent(
                afterRequesting: false,
                didSucceed: true,
                updatedThread: settled
            )
        )
        #expect(
            !HomeThreadSettleUndoState.shouldPresent(
                afterRequesting: true,
                didSucceed: false,
                updatedThread: settled
            )
        )
        #expect(
            !HomeThreadSettleUndoState.shouldPresent(
                afterRequesting: true,
                didSucceed: true,
                updatedThread: active
            )
        )
        #expect(
            !HomeThreadSettleUndoState.shouldPresent(
                afterRequesting: true,
                didSucceed: true,
                updatedThread: nil
            )
        )
    }

    @Test
    func settleUndoTargetRequiresTheSameSettledUnarchivedThread() {
        let notice = HomeThreadSettleUndoNotice(
            id: UUID(),
            threadID: "target",
            title: "Target",
            restoresPin: false,
            restoresSnoozeUntil: nil
        )
        let settled = thread(
            id: "target",
            created: -20,
            updated: -10,
            isSettled: true
        )
        let active = thread(id: "target", created: -20, updated: -10)
        let archived = thread(
            id: "target",
            created: -20,
            updated: -10,
            isArchived: true,
            isSettled: true
        )
        let other = thread(
            id: "other",
            created: -20,
            updated: -10,
            isSettled: true
        )

        #expect(HomeThreadSettleUndoState.targetIsValid(notice: notice, in: [settled]))
        #expect(!HomeThreadSettleUndoState.targetIsValid(notice: notice, in: [active]))
        #expect(!HomeThreadSettleUndoState.targetIsValid(notice: notice, in: [archived]))
        #expect(!HomeThreadSettleUndoState.targetIsValid(notice: notice, in: [other]))
        #expect(!HomeThreadSettleUndoState.targetIsValid(notice: notice, in: []))
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
        isArchived: Bool = false,
        isSettled: Bool = false,
        pinned: TimeInterval? = nil,
        snoozedUntil: Date? = nil,
        supportsSettlement: Bool? = nil
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            projectID: projectID,
            title: title,
            createdAt: now.addingTimeInterval(created),
            updatedAt: now.addingTimeInterval(updated),
            state: state,
            isArchived: isArchived,
            isSettled: isSettled,
            lastActivityAt: now.addingTimeInterval(updated),
            snoozedUntil: snoozedUntil,
            snoozedAt: snoozedUntil.map { _ in now.addingTimeInterval(updated) },
            pinnedAt: pinned.map(now.addingTimeInterval),
            supportsSettlement: supportsSettlement
        )
    }
}
