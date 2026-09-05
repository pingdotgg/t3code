import Foundation
import Observation
import Testing
import UIKit
@testable import T3Code

@MainActor
@Suite("Home row trailing swipe actions")
struct HomeThreadSwipeActionTests {
    private let now = Date(timeIntervalSince1970: 20_000)

    @Test
    func backKeepsTheMostRecentlyOpenedThreadHighlighted() {
        var selection = WorkspaceThreadSelection()
        selection.open("first")
        selection.close()
        #expect(selection.selectedID == nil)
        #expect(selection.highlightedID == "first")

        selection.open("second")
        #expect(selection.selectedID == "second")
        #expect(selection.highlightedID == "second")
        selection.close()
        #expect(selection.highlightedID == "second")
    }

    @Test
    func settlementOwnsTheEdgeSlotSoAFullSwipeSettles() {
        let active = thread(id: "active")
        let actions = HomeThreadSwipeAction.trailingActions(
            for: active,
            isArchived: false,
            at: now
        )

        #expect(actions == [.settle, .delete])
        #expect(actions.first == .settle)
        #expect(actions.first?.intent == .setSettled(true))
        #expect(HomeThreadSwipeAction.performsFullSwipe(with: actions))
        #expect(actions.map(\.title) == ["Settle", "Delete"])
    }

    @Test
    func pinnedRowsSettleFromTheEdgeAndKeepUnpinBesideIt() {
        let pinned = thread(id: "pinned", pinnedAt: now.addingTimeInterval(-30))
        let actions = HomeThreadSwipeAction.trailingActions(
            for: pinned,
            isArchived: false,
            at: now
        )

        #expect(actions == [.settle, .unpin, .delete])
        #expect(HomeThreadSwipeAction.performsFullSwipe(with: actions))
        #expect(actions.map(\.title) == ["Settle", "Unpin", "Delete"])
        #expect(actions.map(\.systemImage) == ["checkmark", "pin.slash", "trash"])
    }

    /// The pinned shelf also holds settled threads, so the edge action has to be
    /// able to reverse instead of settling a second time.
    @Test
    func settledRowsPutReopenAtTheEdge() {
        var settled = thread(id: "settled")
        settled.settlementFacts = .init(settlementOverride: .settled)
        let settledActions = HomeThreadSwipeAction.trailingActions(
            for: settled,
            isArchived: false,
            at: now
        )
        #expect(settledActions == [.reopen, .delete])
        #expect(settledActions.first?.intent == .setSettled(false))
        #expect(HomeThreadSwipeAction.performsFullSwipe(with: settledActions))

        var pinnedSettled = thread(id: "pinned-settled", pinnedAt: now.addingTimeInterval(-30))
        pinnedSettled.settlementFacts = .init(settlementOverride: .settled)
        #expect(
            HomeThreadSwipeAction.trailingActions(
                for: pinnedSettled,
                isArchived: false,
                at: now
            ) == [.reopen, .unpin, .delete]
        )

        // Age alone does not settle a row. The server decides when it moves.
        var resting = thread(id: "resting")
        resting.lastActivityAt = now.addingTimeInterval(-4 * 24 * 60 * 60)
        #expect(
            HomeThreadSwipeAction.trailingActions(
                for: resting,
                isArchived: false,
                at: now
            ) == [.settle, .delete]
        )
    }

    @Test
    func rowsWithNothingToSettleKeepAReversibleEdgeActionAndNoFullSwipe() {
        var unsupported = thread(id: "no-settlement")
        unsupported.supportsSettlement = false
        let unsupportedActions = HomeThreadSwipeAction.trailingActions(
            for: unsupported,
            isArchived: false,
            at: now
        )
        #expect(unsupportedActions == [.archive, .delete])
        #expect(!HomeThreadSwipeAction.performsFullSwipe(with: unsupportedActions))

        var pinnedUnsupported = thread(
            id: "pinned-no-settlement",
            pinnedAt: now.addingTimeInterval(-30)
        )
        pinnedUnsupported.supportsSettlement = false
        let pinnedActions = HomeThreadSwipeAction.trailingActions(
            for: pinnedUnsupported,
            isArchived: false,
            at: now
        )
        #expect(pinnedActions == [.unpin, .delete])
        #expect(!HomeThreadSwipeAction.performsFullSwipe(with: pinnedActions))

        // Archived rows stay restore-only, and restoring is not a full swipe.
        var archived = thread(id: "archived", pinnedAt: now.addingTimeInterval(-30))
        archived.isArchived = true
        archived.isSettled = true
        let archivedActions = HomeThreadSwipeAction.trailingActions(
            for: archived,
            isArchived: true,
            at: now
        )
        #expect(archivedActions == [.restore, .delete])
        #expect(!HomeThreadSwipeAction.performsFullSwipe(with: archivedActions))
    }

    @Test
    func workingRowsNeverOfferSettlementOrAFullSwipe() {
        for state in [
            FeatureThreadState.queued,
            .working,
            .monitoring,
            .waitingForApproval,
            .waitingForInput,
        ] {
            var active = thread(id: "active-\(state.rawValue)")
            active.state = state

            let actions = HomeThreadSwipeAction.trailingActions(
                for: active,
                isArchived: false,
                at: now
            )

            #expect(actions == [.archive, .delete])
            #expect(!HomeThreadSwipeAction.performsFullSwipe(with: actions))
        }
    }

    /// Delete must never reach the edge slot, because the edge slot is what a
    /// full swipe runs. This sweeps every pinned/settled/capability/archived
    /// combination rather than trusting the branch order.
    @Test
    func deleteIsNeverTheEdgeActionAndOnlySettlementArmsTheFullSwipe() {
        for isSettled in [false, true] {
            for isPinned in [false, true] {
                for supportsSettlement in [nil, true, false] as [Bool?] {
                    for supportsPinning in [nil, true, false] as [Bool?] {
                        for isArchived in [false, true] {
                            var candidate = thread(
                                id: "row",
                                pinnedAt: isPinned ? now.addingTimeInterval(-30) : nil
                            )
                            candidate.isSettled = isSettled
                            candidate.supportsSettlement = supportsSettlement
                            candidate.supportsPinning = supportsPinning
                            candidate.isArchived = isArchived

                            let actions = HomeThreadSwipeAction.trailingActions(
                                for: candidate,
                                isArchived: isArchived,
                                at: now
                            )

                            #expect(actions.last == .delete)
                            #expect(actions.first != .delete)
                            #expect(actions.count == Set(actions).count)
                            #expect(actions.filter { $0.style == .destructive } == [.delete])
                            #expect(actions.filter(\.isSettlement).count <= 1)

                            let armsFullSwipe = HomeThreadSwipeAction.performsFullSwipe(with: actions)
                            #expect(armsFullSwipe == (actions.first?.isSettlement ?? false))
                            if armsFullSwipe {
                                switch actions.first?.intent {
                                case .setSettled:
                                    break
                                default:
                                    Issue.record("A full swipe may only request settlement")
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    @Test
    func actionsRequestExactlyOneLifecycleMutationEach() {
        #expect(HomeThreadSwipeAction.settle.intent == .setSettled(true))
        #expect(HomeThreadSwipeAction.reopen.intent == .setSettled(false))
        #expect(HomeThreadSwipeAction.unpin.intent == .setPinned(false))
        #expect(HomeThreadSwipeAction.archive.intent == .setArchived(true))
        #expect(HomeThreadSwipeAction.restore.intent == .setArchived(false))
        #expect(HomeThreadSwipeAction.delete.intent == .delete)

        #expect(HomeThreadSwipeAction.settle.isSettlement)
        #expect(HomeThreadSwipeAction.reopen.isSettlement)
        #expect(!HomeThreadSwipeAction.unpin.isSettlement)
        #expect(!HomeThreadSwipeAction.delete.isSettlement)

        // The settlement actions keep the row's existing accent vocabulary and
        // never inherit the destructive style that arms a destructive swipe.
        #expect(HomeThreadSwipeAction.settle.style == .normal)
        #expect(HomeThreadSwipeAction.settle.backgroundColor == .systemGreen)
        #expect(HomeThreadSwipeAction.reopen.backgroundColor == .systemBlue)
        #expect(HomeThreadSwipeAction.reopen.systemImage == "arrow.counterclockwise")
        #expect(HomeThreadSwipeAction.delete.style == .destructive)
        #expect(HomeThreadSwipeAction.delete.backgroundColor == nil)
    }

    /// The full swipe carries no settlement logic of its own: its edge action is
    /// applied through the same `FeatureRootModel.setSettled` call the context
    /// menu uses, which reaches the client's real settlement request and clears
    /// the pin, so one motion unpins and settles.
    @Test
    func aFullSwipeOnAPinnedRowSettlesThroughTheRealPathAndClearsThePin() async throws {
        let client = SwipeSettlementClientStub()
        var pinned = thread(id: "pinned", pinnedAt: now.addingTimeInterval(-30))
        pinned.lastActivityAt = now
        client.snapshot = FeatureSnapshot(
            projects: [
                FeatureProject(
                    id: "project",
                    environmentID: "environment",
                    name: "Studio",
                    path: "/studio"
                ),
            ],
            threads: [pinned]
        )
        let model = testRootModel(client: client)
        await model.reload()

        #expect(presentation(for: model).pinned.map(\.id) == ["pinned"])

        let actions = HomeThreadSwipeAction.trailingActions(
            for: pinned,
            isArchived: false,
            at: now
        )
        let edge = try #require(actions.first)
        #expect(edge == .settle)
        #expect(HomeThreadSwipeAction.performsFullSwipe(with: actions))

        // Applying the edge action the way the row's `onSettle` closure does.
        guard case let .setSettled(settled) = edge.intent else { return }
        await model.setSettled(pinned.id, settled: settled)

        #expect(client.settlementRequests == [SettlementRequest(id: "pinned", settled: true)])
        #expect(client.pinRequests.isEmpty)
        let updated = try #require(model.snapshot.threads.first { $0.id == "pinned" })
        #expect(updated.isSettled)
        #expect(!updated.keepsActive)
        #expect(updated.settledAt != nil)
        #expect(updated.pinnedAt == nil)

        // One motion: the row leaves the pinned shelf for Settled, where its
        // edge action is now the reverse.
        let shelves = presentation(for: model)
        #expect(shelves.pinned.isEmpty)
        #expect(shelves.settled.map(\.id) == ["pinned"])
        #expect(
            HomeThreadSwipeAction.trailingActions(for: updated, isArchived: false, at: now)
                == [.reopen, .delete]
        )
    }

    @Test
    func settlementLeavesTheActiveShelfBeforeTheServerResponds() async throws {
        let client = SwipeSettlementClientStub()
        let active = thread(id: "active")
        client.snapshot = snapshot(threads: [active])
        let model = testRootModel(client: client)
        await model.reload()

        let started = AsyncStream<Void>.makeStream()
        var response: CheckedContinuation<Void, any Error>?
        client.beforeSettlementResponse = { _ in
            try await withCheckedThrowingContinuation { continuation in
                response = continuation
                started.continuation.yield()
            }
        }

        let settlement = Task { await model.setSettled(active.id, settled: true) }
        var requests = started.stream.makeAsyncIterator()
        await requests.next()

        #expect(presentation(for: model).active.isEmpty)
        #expect(presentation(for: model).settled.map(\.id) == [active.id])
        #expect(model.snapshot.threads.first?.isSettled == true)

        response?.resume()
        #expect(await settlement.value)

        #expect(client.settlementRequests == [SettlementRequest(id: active.id, settled: true)])
    }

    @Test
    func staleSnapshotsCannotRestoreThreadsWhileSettlementIsPending() async {
        let client = SwipeSettlementClientStub()
        let active = thread(id: "active")
        client.snapshot = snapshot(threads: [active])
        let model = testRootModel(client: client)
        await model.reload()

        let started = AsyncStream<Void>.makeStream()
        var response: CheckedContinuation<Void, any Error>?
        client.beforeSettlementResponse = { _ in
            try await withCheckedThrowingContinuation { continuation in
                response = continuation
                started.continuation.yield()
            }
        }

        let settlement = Task { await model.setSettled(active.id, settled: true) }
        var requests = started.stream.makeAsyncIterator()
        await requests.next()

        await model.reload()

        #expect(presentation(for: model).active.isEmpty)
        #expect(model.snapshot.threads.first?.isSettled == true)

        response?.resume()
        #expect(await settlement.value)
    }

    @Test(arguments: PendingSettlementEvent.allCases)
    func pendingSettlementSurvivesIncomingThreadAndDetailEvents(
        event: PendingSettlementEvent
    ) async {
        let client = SwipeSettlementClientStub()
        let active = thread(id: "active", pinnedAt: now.addingTimeInterval(-30))
        client.snapshot = snapshot(threads: [active])
        let model = testRootModel(client: client)

        let subscribed = AsyncStream<Void>.makeStream()
        client.onEventsSubscribed = { subscribed.continuation.yield() }
        let eventLoop = Task { await model.start() }
        var subscriptions = subscribed.stream.makeAsyncIterator()
        await subscriptions.next()

        let started = AsyncStream<Void>.makeStream()
        var response: CheckedContinuation<Void, any Error>?
        client.beforeSettlementResponse = { _ in
            try await withCheckedThrowingContinuation { continuation in
                response = continuation
                started.continuation.yield()
            }
        }

        let settlement = Task { await model.setSettled(active.id, settled: true) }
        var requests = started.stream.makeAsyncIterator()
        await requests.next()
        let settledAt = model.snapshot.threads.first?.settledAt

        var authoritative = active
        authoritative.title = "Updated on the server"
        let changed = AsyncStream<Void>.makeStream()
        withObservationTracking {
            _ = model.snapshot.threads.first?.title
        } onChange: {
            changed.continuation.yield()
        }

        switch event {
        case .thread:
            client.emit(.thread(authoritative))
        case .detail:
            client.emit(.detail(FeatureThreadDetail(thread: authoritative)))
        case .detailDelta:
            client.emit(.detailDelta(
                FeatureThreadDetail(thread: authoritative),
                FeatureDetailDelta(changedMessages: [])
            ))
        }

        var changes = changed.stream.makeAsyncIterator()
        await changes.next()

        let updated = model.snapshot.threads.first
        #expect(updated?.title == "Updated on the server")
        #expect(updated?.isSettled == true)
        #expect(updated?.settledAt == settledAt)
        #expect(updated?.pinnedAt == nil)
        #expect(presentation(for: model).active.isEmpty)
        if let detail = model.details[active.id] {
            #expect(detail.thread.isSettled)
            #expect(detail.thread.pinnedAt == nil)
        }

        response?.resume()
        #expect(await settlement.value)
        client.finishEvents()
        await eventLoop.value
    }

    @Test
    func failedSettlementPreservesNewerServerMetadataWhenRestoringItsFields() async {
        let client = SwipeSettlementClientStub()
        let pinned = thread(id: "pinned", pinnedAt: now.addingTimeInterval(-30))
        client.snapshot = snapshot(threads: [pinned])
        let model = testRootModel(client: client)
        await model.reload()

        client.beforeSettlementResponse = { _ in
            var authoritative = pinned
            authoritative.title = "Updated on the server"
            client.snapshot = snapshot(threads: [authoritative])
            await model.reload()
            throw SwipeSettlementFailure.offline
        }

        #expect(!(await model.setSettled(pinned.id, settled: true)))
        let updated = model.snapshot.threads.first
        #expect(updated?.title == "Updated on the server")
        #expect(updated?.isSettled == false)
        #expect(updated?.pinnedAt == pinned.pinnedAt)
    }

    @Test
    func settlementRejectedAfterAThreadStartsWorkingReturnsFailure() async {
        let client = SwipeSettlementClientStub()
        var working = thread(id: "working")
        working.state = .working
        client.snapshot = snapshot(threads: [working])
        let model = testRootModel(client: client)
        await model.reload()

        #expect(!(await model.setSettled(working.id, settled: true)))
        #expect(client.settlementRequests.isEmpty)
        #expect(model.snapshot.threads == [working])
    }

    @Test
    func consecutiveSettlementsLeaveTheInboxWithoutWaitingForEarlierRequests() async throws {
        let client = SwipeSettlementClientStub()
        let first = thread(id: "first")
        let second = thread(id: "second")
        let remaining = thread(id: "remaining")
        client.snapshot = snapshot(threads: [first, second, remaining])
        let model = testRootModel(client: client)
        await model.reload()

        let started = AsyncStream<String>.makeStream()
        var responses: [String: CheckedContinuation<Void, any Error>] = [:]
        client.beforeSettlementResponse = { request in
            try await withCheckedThrowingContinuation { continuation in
                responses[request.id] = continuation
                started.continuation.yield(request.id)
            }
        }

        var requests = started.stream.makeAsyncIterator()
        let firstSettlement = Task { await model.setSettled(first.id, settled: true) }
        #expect(await requests.next() == first.id)
        #expect(!presentation(for: model).active.contains { $0.id == first.id })

        let secondSettlement = Task { await model.setSettled(second.id, settled: true) }
        #expect(await requests.next() == second.id)
        #expect(presentation(for: model).active.map(\.id) == [remaining.id])

        responses[second.id]?.resume()
        #expect(await secondSettlement.value)
        responses[first.id]?.resume()
        #expect(await firstSettlement.value)

        #expect(Set(presentation(for: model).settled.map(\.id)) == [first.id, second.id])
    }

    @Test
    func failedSettlementRestoresTheOriginalPinnedThread() async {
        let client = SwipeSettlementClientStub()
        let pinned = thread(id: "pinned", pinnedAt: now.addingTimeInterval(-30))
        client.snapshot = snapshot(threads: [pinned])
        client.beforeSettlementResponse = { _ in
            throw SwipeSettlementFailure.offline
        }
        let model = testRootModel(client: client)
        await model.reload()

        await model.setSettled(pinned.id, settled: true)

        #expect(model.snapshot.threads == [pinned])
        #expect(presentation(for: model).pinned.map(\.id) == [pinned.id])
        #expect(presentation(for: model).settled.isEmpty)
        #expect(model.errorMessage == "The test environment is offline.")
    }

    @Test
    func reopeningImmediatelyMovesTheThreadToTheTopAndRestoresItsOrderOnFailure() async throws {
        let client = SwipeSettlementClientStub()
        var older = thread(id: "older")
        older.createdAt = now.addingTimeInterval(-1_000)
        older.isSettled = true
        older.settledAt = now.addingTimeInterval(-20)
        let newer = thread(id: "newer")
        client.snapshot = snapshot(threads: [older, newer])
        let model = testRootModel(client: client)
        await model.reload()

        let started = AsyncStream<Void>.makeStream()
        var response: CheckedContinuation<Void, any Error>?
        client.beforeSettlementResponse = { _ in
            try await withCheckedThrowingContinuation { continuation in
                response = continuation
                started.continuation.yield()
            }
        }

        let reopening = Task { await model.setSettled(older.id, settled: false) }
        var requests = started.stream.makeAsyncIterator()
        await requests.next()

        #expect(presentation(for: model).active.map(\.id) == ["older", "newer"])
        #expect(model.snapshot.threads.first(where: { $0.id == older.id })?.unsettledAt != nil)
        response?.resume(throwing: SwipeSettlementFailure.offline)
        #expect(!(await reopening.value))
        #expect(presentation(for: model).active.map(\.id) == ["newer"])
        let restored = try #require(model.snapshot.threads.first(where: { $0.id == older.id }))
        #expect(restored.unsettledAt == older.unsettledAt)
        #expect(restored.settledAt == older.settledAt)
    }

    @Test
    func anOlderFailedSettlementCannotUndoANewerReopen() async {
        let client = SwipeSettlementClientStub()
        let active = thread(id: "active")
        client.snapshot = snapshot(threads: [active])
        let model = testRootModel(client: client)
        await model.reload()

        let started = AsyncStream<Void>.makeStream()
        var delayedResponse: CheckedContinuation<Void, any Error>?
        client.beforeSettlementResponse = { request in
            guard request.settled else { return }
            try await withCheckedThrowingContinuation { continuation in
                delayedResponse = continuation
                started.continuation.yield()
            }
        }

        let settlement = Task { await model.setSettled(active.id, settled: true) }
        var requests = started.stream.makeAsyncIterator()
        await requests.next()
        #expect(model.snapshot.threads.first?.isSettled == true)

        await model.setSettled(active.id, settled: false)
        #expect(model.snapshot.threads.first?.isSettled == false)
        let reopenedAt = model.snapshot.threads.first?.unsettledAt
        #expect(reopenedAt != nil)

        delayedResponse?.resume(throwing: SwipeSettlementFailure.offline)
        #expect(!(await settlement.value))

        #expect(model.snapshot.threads.first?.isSettled == false)
        #expect(model.snapshot.threads.first?.keepsActive == true)
        #expect(model.snapshot.threads.first?.unsettledAt == reopenedAt)
        #expect(client.settlementRequests == [
            SettlementRequest(id: active.id, settled: true),
            SettlementRequest(id: active.id, settled: false),
        ])
    }

    @Test(arguments: [false, true])
    func settlingReplacesTheInboxCellInsteadOfMovingAndResizingIt(forceRichRows: Bool) throws {
        let client = SwipeSettlementClientStub()
        let active = thread(id: "active")
        let remaining = thread(id: "remaining")
        var previouslySettled = thread(id: "previously-settled")
        previouslySettled.isSettled = true
        previouslySettled.settledAt = now.addingTimeInterval(-60)
        let initial = threadList(
            client: client,
            snapshot: snapshot(threads: [active, remaining, previouslySettled]),
            isSettledExpanded: true,
            forceRichRows: forceRichRows
        )
        var settled = active
        settled.isSettled = true
        settled.settledAt = now
        let updated = threadList(
            client: client,
            snapshot: snapshot(threads: [settled, remaining, previouslySettled]),
            isSettledExpanded: true,
            forceRichRows: forceRichRows
        )

        let before = initial.collectionItems.map(\.id)
        let after = updated.collectionItems.map(\.id)
        let changes = after.difference(from: before).inferringMoves()
        let changedThread = changes.filter { change in
            switch change {
            case let .remove(_, identifier, _), let .insert(_, identifier, _):
                identifier.threadID == active.id
            }
        }
        #expect(changedThread.count == 2)
        for change in changedThread {
            switch change {
            case let .remove(_, _, associatedWith), let .insert(_, _, associatedWith):
                #expect(associatedWith == nil)
            }
        }
        let remainingID = try #require(before.first { $0.threadID == remaining.id })
        #expect(after.contains(remainingID))
        #expect(Set(after.compactMap(\.threadID)).count == 3)

        let reopened = before.difference(from: after).inferringMoves()
        #expect(reopened.count == 2)
    }

    @Test
    func settlingKeepsTheSameCellInSearchResults() throws {
        let client = SwipeSettlementClientStub()
        let active = thread(id: "search")
        var settled = active
        settled.isSettled = true
        let initial = threadList(client: client, snapshot: snapshot(threads: [active]), query: "Task")
        let updated = threadList(client: client, snapshot: snapshot(threads: [settled]), query: "Task")

        #expect(initial.collectionItems.map(\.id) == updated.collectionItems.map(\.id))
    }

    @Test
    func repeatedSwipeOnTheSameRowDoesNotSendAnotherSettlement() {
        let client = SwipeSettlementClientStub()
        let active = thread(id: "active")
        var requests = 0
        let initial = threadList(client: client, snapshot: snapshot(threads: [active])) { _, _, _ in
            requests += 1
        }
        let coordinator = initial.makeCoordinator()
        let collectionView = testCollectionView()
        coordinator.configure(collectionView)
        defer {
            coordinator.invalidateTimer()
            coordinator.cancelPendingSwipeActions()
        }

        var firstResult: Bool?
        var secondResult: Bool?
        coordinator.performSwipe(.settle, for: active) { firstResult = $0 }
        coordinator.performSwipe(.settle, for: active) { secondResult = $0 }

        #expect(requests == 1)
        #expect(firstResult == nil)
        #expect(secondResult == false)
        coordinator.cancelPendingSwipeActions()
        #expect(firstResult == false)
    }

    @Test
    func cancellationFinishesEachSwipeOnlyOnce() {
        let client = SwipeSettlementClientStub()
        let active = thread(id: "active")
        var respond: ((Bool) -> Void)?
        let initial = threadList(
            client: client,
            snapshot: snapshot(threads: [active]),
            settlementResult: nil
        ) { _, _, completion in
            respond = completion
        }
        let coordinator = initial.makeCoordinator()
        let collectionView = testCollectionView()
        coordinator.configure(collectionView)
        defer { coordinator.invalidateTimer() }
        var results: [Bool] = []
        coordinator.performSwipe(.settle, for: active) { results.append($0) }

        coordinator.cancelPendingSwipeActions()
        respond?(false)
        coordinator.cancelPendingSwipeActions()

        #expect(results == [false])
    }

    @Test
    func swipeCompletionWaitsUntilTheCollectionHasRemovedTheThread() async {
        let client = SwipeSettlementClientStub()
        let first = thread(id: "first")
        let remaining = thread(id: "remaining")
        let initial = snapshot(threads: [first, remaining])
        var requests: [SettlementRequest] = []
        let initialList = threadList(client: client, snapshot: initial) { thread, settled, _ in
            requests.append(SettlementRequest(id: thread.id, settled: settled))
        }
        let coordinator = initialList.makeCoordinator()
        let collectionView = testCollectionView()
        coordinator.configure(collectionView)
        defer {
            coordinator.invalidateTimer()
            coordinator.cancelPendingSwipeActions()
        }

        let completions = AsyncStream<Bool>.makeStream()
        var finished = false
        coordinator.performSwipe(.settle, for: first) { succeeded in
            finished = true
            completions.continuation.yield(succeeded)
        }

        #expect(requests == [SettlementRequest(id: first.id, settled: true)])
        #expect(!finished)

        var settled = first
        settled.isSettled = true
        settled.settledAt = now
        let updated = threadList(
            client: client,
            snapshot: snapshot(threads: [settled, remaining])
        )
        coordinator.update(parent: updated, collectionView: collectionView)

        var results = completions.stream.makeAsyncIterator()
        #expect(await results.next() == true)
        #expect(finished)
    }

    @Test
    func settledSearchRowsFinishTheSwipeWithoutLeavingTheSearchResults() async throws {
        let client = SwipeSettlementClientStub()
        let active = thread(id: "search")
        let initialList = threadList(
            client: client,
            snapshot: snapshot(threads: [active]),
            query: "Task"
        )
        let coordinator = initialList.makeCoordinator()
        let collectionView = testCollectionView()
        coordinator.configure(collectionView)
        defer {
            coordinator.invalidateTimer()
            coordinator.cancelPendingSwipeActions()
        }

        let completions = AsyncStream<Bool>.makeStream()
        coordinator.performSwipe(.settle, for: active) {
            completions.continuation.yield($0)
        }

        var settled = active
        // Modern servers can report only the authoritative override.
        settled.settlementFacts = .init(settlementOverride: .settled)
        settled.settledAt = now
        let updated = threadList(
            client: client,
            snapshot: snapshot(threads: [settled]),
            query: "Task"
        )
        coordinator.update(parent: updated, collectionView: collectionView)

        var results = completions.stream.makeAsyncIterator()
        #expect(await results.next() == true)
        #expect(collectionView.numberOfItems(inSection: 0) == 1)
        collectionView.layoutIfNeeded()
        let cell = try #require(collectionView.cellForItem(at: IndexPath(item: 0, section: 0)))
        #expect(!cell.contentView.isHidden)
    }

    @Test
    func expandedSettledShelfKeepsAdjacentRowsAtTheirFullHeight() async throws {
        let client = SwipeSettlementClientStub()
        let active = thread(id: "active")
        let remaining = thread(id: "remaining")
        let initial = threadList(
            client: client,
            snapshot: snapshot(threads: [active, remaining]),
            isSettledExpanded: true
        )
        let coordinator = initial.makeCoordinator()
        let collectionView = testCollectionView()
        coordinator.configure(collectionView)
        collectionView.layoutIfNeeded()
        defer {
            coordinator.invalidateTimer()
            coordinator.cancelPendingSwipeActions()
        }
        let original = try #require(collectionView.visibleCells.first { $0.accessibilityLabel == remaining.title })
        let originalHeight = original.bounds.height
        let completions = AsyncStream<Bool>.makeStream()
        coordinator.performSwipe(.settle, for: active) { completions.continuation.yield($0) }

        var settled = active
        settled.isSettled = true
        settled.settledAt = now
        coordinator.update(
            parent: threadList(
                client: client,
                snapshot: snapshot(threads: [settled, remaining]),
                isSettledExpanded: true
            ),
            collectionView: collectionView
        )
        var results = completions.stream.makeAsyncIterator()
        #expect(await results.next() == true)
        collectionView.layoutIfNeeded()

        let remainingCell = try #require(collectionView.visibleCells.first { $0.accessibilityLabel == remaining.title })
        let settledCell = try #require(collectionView.visibleCells.first { $0.accessibilityLabel == active.title })
        #expect(abs(remainingCell.bounds.height - originalHeight) < 0.5)
        #expect(remainingCell.frame.maxY <= settledCell.frame.minY)
        #expect(settledCell.bounds.height < remainingCell.bounds.height)
        #expect(collectionView.visibleCells.filter { $0.accessibilityLabel == active.title }.count == 1)
    }

    @Test(.timeLimit(.minutes(1)), arguments: [false, true])
    func streamUpdatesAndRollbackWaitForTheRemovalAnimation(rollbackFirst: Bool) async throws {
        let client = SwipeSettlementClientStub()
        let first = thread(id: "first")
        let second = thread(id: "second")
        let remaining = thread(id: "remaining")
        var respondToFirst: ((Bool) -> Void)?
        let initial = threadList(
            client: client,
            snapshot: snapshot(threads: [first, second, remaining]),
            isSettledExpanded: true,
            settlementResult: nil
        ) { _, _, completion in respondToFirst = completion }
        let coordinator = initial.makeCoordinator()
        let collectionView = testCollectionView()
        coordinator.configure(collectionView)
        collectionView.layoutIfNeeded()

        let controller = UIViewController()
        controller.view = collectionView
        let window = UIWindow(frame: collectionView.frame)
        window.rootViewController = controller
        window.isHidden = false
        defer {
            window.isHidden = true
            coordinator.invalidateTimer()
            coordinator.cancelPendingSwipeActions()
        }
        #expect(collectionView.window === window)
        let retainedCell = try #require(collectionView.visibleCells.first {
            $0.accessibilityLabel == remaining.title
        })

        let completions = AsyncStream<String>.makeStream()
        var swipeResults: [String: [Bool]] = [:]
        coordinator.performSwipe(.settle, for: first) { succeeded in
            swipeResults[first.id, default: []].append(succeeded)
            completions.continuation.yield(first.id)
        }
        var settledFirst = first
        settledFirst.isSettled = true
        settledFirst.settledAt = now
        coordinator.update(
            parent: threadList(
                client: client,
                snapshot: snapshot(threads: [settledFirst, second, remaining]),
                isSettledExpanded: true
            ),
            collectionView: collectionView
        )

        var latest = remaining
        for update in 0..<100 {
            latest.title = "Latest server title \(update)"
            coordinator.update(
                parent: threadList(
                    client: client,
                    snapshot: snapshot(threads: [settledFirst, second, latest]),
                    isSettledExpanded: true
                ),
                collectionView: collectionView
            )
        }
        if !UIAccessibility.isReduceMotionEnabled, UIView.areAnimationsEnabled {
            #expect(retainedCell.accessibilityLabel == remaining.title)
        }

        if rollbackFirst { respondToFirst?(false) }
        coordinator.performSwipe(.settle, for: second) { succeeded in
            swipeResults[second.id, default: []].append(succeeded)
            completions.continuation.yield(second.id)
        }
        var settledSecond = second
        settledSecond.isSettled = true
        settledSecond.settledAt = now
        coordinator.update(
            parent: threadList(
                client: client,
                snapshot: snapshot(threads: [rollbackFirst ? first : settledFirst, settledSecond, latest]),
                isSettledExpanded: true
            ),
            collectionView: collectionView
        )

        var results = completions.stream.makeAsyncIterator()
        let finished = await [results.next(), results.next()].compactMap { $0 }
        #expect(Set(finished) == [first.id, second.id])
        #expect(swipeResults[first.id]?.count == 1)
        #expect(swipeResults[second.id] == [true])
        collectionView.layoutIfNeeded()
        #expect(retainedCell.accessibilityLabel == latest.title)
        let firstCell = try #require(collectionView.visibleCells.first { $0.accessibilityLabel == first.title })
        #expect(firstCell.accessibilityValue?.contains("Settled") == !rollbackFirst)
        #expect(!firstCell.contentView.isHidden)
        #expect(!retainedCell.contentView.isHidden)
        let threadCells = collectionView.visibleCells.filter { $0.accessibilityTraits.contains(.button) }
        let frames = threadCells.map(\.frame).sorted { $0.minY < $1.minY }
        for (before, after) in zip(frames, frames.dropFirst()) {
            #expect(before.maxY <= after.minY + 0.5)
        }
    }

    @Test(.timeLimit(.minutes(1)), arguments: [false, true])
    func departingTextIsHiddenBeforeNeighborFramesChange(isSettledExpanded: Bool) async throws {
        let client = SwipeSettlementClientStub()
        let first = thread(id: "first")
        let remaining = thread(id: "remaining")
        let initial = threadList(
            client: client,
            snapshot: snapshot(threads: [first, remaining]),
            isSettledExpanded: isSettledExpanded
        )
        let coordinator = initial.makeCoordinator()
        let collectionView = testCollectionView()
        coordinator.configure(collectionView)
        collectionView.layoutIfNeeded()
        let outgoing = try #require(collectionView.visibleCells.first { $0.accessibilityLabel == first.title })
        let neighbor = try #require(collectionView.visibleCells.first { $0.accessibilityLabel == remaining.title })

        let controller = UIViewController()
        controller.view = collectionView
        let window = UIWindow(frame: collectionView.frame)
        window.rootViewController = controller
        window.isHidden = false
        defer {
            window.isHidden = true
            coordinator.invalidateTimer()
            coordinator.cancelPendingSwipeActions()
        }

        let originalIndexPath = try #require(collectionView.indexPath(for: outgoing))
        let originalNeighborFrame = neighbor.frame
        var hidBeforeSnapshot = false
        // XCTest can complete UIKit animations without rendering any frames.
        // Observe the visibility change before the collection starts its update.
        let observation = outgoing.contentView.observe(\.isHidden, options: [.new]) { _, change in
            MainActor.assumeIsolated {
                guard change.newValue == true else { return }
                if collectionView.indexPath(for: outgoing) == originalIndexPath,
                   neighbor.frame == originalNeighborFrame,
                   !neighbor.contentView.isHidden {
                    hidBeforeSnapshot = true
                }
            }
        }
        defer { observation.invalidate() }
        let completions = AsyncStream<Bool>.makeStream()
        coordinator.performSwipe(.settle, for: first) { succeeded in
            completions.continuation.yield(succeeded)
        }
        var settled = first
        settled.isSettled = true
        settled.settledAt = now
        coordinator.update(
            parent: threadList(
                client: client,
                snapshot: snapshot(threads: [settled, remaining]),
                isSettledExpanded: isSettledExpanded
            ),
            collectionView: collectionView
        )

        var results = completions.stream.makeAsyncIterator()
        #expect(await results.next() == true)
        #expect(hidBeforeSnapshot == !UIAccessibility.isReduceMotionEnabled)
        collectionView.layoutIfNeeded()
        #expect(!neighbor.contentView.isHidden)
        if isSettledExpanded {
            let settledCell = try #require(collectionView.visibleCells.first {
                $0.accessibilityLabel == first.title
            })
            #expect(!settledCell.contentView.isHidden)
        }
    }

    @Test
    func failedSettlementClosesTheSwipeWithoutACollectionUpdate() {
        let client = SwipeSettlementClientStub()
        let active = thread(id: "active")
        let initial = threadList(
            client: client,
            snapshot: snapshot(threads: [active]),
            settlementResult: false
        )
        let coordinator = initial.makeCoordinator()
        let collectionView = testCollectionView()
        coordinator.configure(collectionView)
        defer {
            coordinator.invalidateTimer()
            coordinator.cancelPendingSwipeActions()
        }

        var result: Bool?
        coordinator.performSwipe(.settle, for: active) { result = $0 }

        #expect(result == false)
    }

    @Test
    func consecutiveSwipeCompletionsResolveFromTheSameCollectionUpdate() async {
        let client = SwipeSettlementClientStub()
        let first = thread(id: "first")
        let second = thread(id: "second")
        let remaining = thread(id: "remaining")
        let initial = threadList(
            client: client,
            snapshot: snapshot(threads: [first, second, remaining])
        )
        let coordinator = initial.makeCoordinator()
        let collectionView = testCollectionView()
        coordinator.configure(collectionView)
        defer {
            coordinator.invalidateTimer()
            coordinator.cancelPendingSwipeActions()
        }

        let completions = AsyncStream<String>.makeStream()
        coordinator.performSwipe(.settle, for: first) { succeeded in
            if succeeded { completions.continuation.yield(first.id) }
        }
        coordinator.performSwipe(.settle, for: second) { succeeded in
            if succeeded { completions.continuation.yield(second.id) }
        }

        var settledFirst = first
        settledFirst.isSettled = true
        settledFirst.settledAt = now
        var settledSecond = second
        settledSecond.isSettled = true
        settledSecond.settledAt = now
        let updated = threadList(
            client: client,
            snapshot: snapshot(threads: [settledFirst, settledSecond, remaining])
        )
        coordinator.update(parent: updated, collectionView: collectionView)

        var results = completions.stream.makeAsyncIterator()
        let completed = await [results.next(), results.next()].compactMap { $0 }
        #expect(Set(completed) == [first.id, second.id])
    }

    @Test
    func threadCellsClipContentWhileTheirRowsCollapse() throws {
        let client = SwipeSettlementClientStub()
        let initial = threadList(
            client: client,
            snapshot: snapshot(threads: [thread(id: "visible")])
        )
        let coordinator = initial.makeCoordinator()
        let collectionView = testCollectionView()
        coordinator.configure(collectionView)
        collectionView.layoutIfNeeded()
        defer {
            coordinator.invalidateTimer()
            coordinator.cancelPendingSwipeActions()
        }

        let cell = try #require(collectionView.cellForItem(at: IndexPath(item: 0, section: 0)))

        #expect(cell.clipsToBounds)
        #expect(cell.contentView.clipsToBounds)
    }

    @Test
    func selectionUpdatesWhenOtherRowsArriveInTheSameSnapshot() throws {
        let client = SwipeSettlementClientStub()
        let first = thread(id: "first")
        let second = thread(id: "second")
        let initial = threadList(
            client: client, snapshot: snapshot(threads: [first, second]), selectedThreadID: first.id
        )
        let coordinator = initial.makeCoordinator()
        let collectionView = testCollectionView()
        coordinator.configure(collectionView)
        collectionView.layoutIfNeeded()
        defer {
            coordinator.invalidateTimer()
            coordinator.cancelPendingSwipeActions()
        }
        let firstCell = try #require(collectionView.visibleCells.first {
            $0.accessibilityLabel == first.title
        })
        #expect(firstCell.accessibilityTraits.contains(.selected))

        let updated = threadList(
            client: client,
            snapshot: snapshot(threads: [first, second, thread(id: "arrived")]),
            selectedThreadID: second.id
        )
        coordinator.update(parent: updated, collectionView: collectionView)
        collectionView.layoutIfNeeded()
        let selected = collectionView.visibleCells.filter { $0.accessibilityTraits.contains(.selected) }
        #expect(selected.count == 1)
        #expect(selected.first?.accessibilityLabel == second.title)
    }

    private func presentation(for model: FeatureRootModel) -> HomePresentation {
        HomePresentation(
            snapshot: model.snapshot,
            query: "",
            projectID: nil,
            now: now
        )
    }

    private func snapshot(threads: [FeatureThread]) -> FeatureSnapshot {
        FeatureSnapshot(
            projects: [
                FeatureProject(
                    id: "project",
                    environmentID: "environment",
                    name: "Studio",
                    path: "/studio"
                ),
            ],
            threads: threads
        )
    }

    private func threadList(
        client: SwipeSettlementClientStub,
        snapshot: FeatureSnapshot,
        query: String = "",
        selectedThreadID: String? = nil,
        isSettledExpanded: Bool = false,
        forceRichRows: Bool = false,
        settlementResult: Bool? = true,
        onSettle: @escaping (FeatureThread, Bool, @escaping (Bool) -> Void) -> Void = { _, _, _ in }
    ) -> HomeThreadCollectionView {
        HomeThreadCollectionView(
            presentation: HomePresentation(
                snapshot: snapshot,
                query: query,
                projectID: nil,
                now: now
            ),
            projectFaviconClient: client,
            query: query,
            selectedThreadID: selectedThreadID,
            forceRichRows: forceRichRows,
            hapticsEnabled: false,
            settings: snapshot.settings,
            pullRequestsByThreadID: [:],
            isSnoozedExpanded: false,
            isSettledExpanded: isSettledExpanded,
            isArchiveExpanded: false,
            settledLimit: 12,
            onOpen: { _ in },
            onToggleSnoozed: {},
            onToggleSettled: {},
            onToggleArchive: {},
            onShowMoreSettled: {},
            onRename: { _ in },
            onRegenerateTitle: { _ in },
            onArchive: { _, _ in },
            onSettle: { thread, settled, completion in
                onSettle(thread, settled, completion)
                if let settlementResult { completion(settlementResult) }
            },
            onSnooze: { _, _ in },
            onPin: { _, _ in },
            onDelete: { _ in },
            onPullRequestChange: { _, _, _ in }
        )
    }

    private func testCollectionView() -> UICollectionView {
        UICollectionView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            collectionViewLayout: UICollectionViewCompositionalLayout.list(
                using: UICollectionLayoutListConfiguration(appearance: .plain)
            )
        )
    }

    private func thread(
        id: String,
        pinnedAt: Date? = nil
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            projectID: "project",
            title: "Task \(id)",
            createdAt: now.addingTimeInterval(-100),
            updatedAt: now.addingTimeInterval(-50),
            state: .idle,
            lastActivityAt: now.addingTimeInterval(-50),
            pinnedAt: pinnedAt,
            supportsSettlement: true,
            supportsPinning: true
        )
    }
}

enum PendingSettlementEvent: CaseIterable {
    case thread
    case detail
    case detailDelta
}

@MainActor
private func testRootModel(client: SwipeSettlementClientStub) -> FeatureRootModel {
    FeatureRootModel(
        client: client,
        outboxStore: FeatureOutboxStore(
            fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("t3-swipe-settlement-outbox-\(UUID().uuidString).json")
        )
    )
}

private struct SettlementRequest: Equatable {
    let id: String
    let settled: Bool
}

private enum SwipeSettlementFailure: LocalizedError {
    case offline

    var errorDescription: String? {
        "The test environment is offline."
    }
}

/// Records the settlement requests the feature client actually receives, so the
/// swipe action's wiring is proved against the real client call rather than a
/// view-local shortcut.
@MainActor
private final class SwipeSettlementClientStub: FeatureClient {
    private let eventStream: AsyncStream<FeatureEvent>
    private let eventContinuation: AsyncStream<FeatureEvent>.Continuation
    var snapshot = FeatureSnapshot()
    var settlementRequests: [SettlementRequest] = []
    var pinRequests: [String] = []
    var beforeSettlementResponse: ((SettlementRequest) async throws -> Void)?
    var onEventsSubscribed: (() -> Void)?

    init() {
        let events = AsyncStream<FeatureEvent>.makeStream()
        eventStream = events.stream
        eventContinuation = events.continuation
    }

    func initialSnapshot() async throws -> FeatureSnapshot { snapshot }

    func events() -> AsyncStream<FeatureEvent> {
        onEventsSubscribed?()
        return eventStream
    }

    func emit(_ event: FeatureEvent) {
        eventContinuation.yield(event)
    }

    func finishEvents() {
        eventContinuation.finish()
    }

    func setThreadSettled(id: String, settled: Bool) async throws {
        let request = SettlementRequest(id: id, settled: settled)
        settlementRequests.append(request)
        try await beforeSettlementResponse?(request)
    }

    func setThreadPinned(id: String, pinned: Bool) async throws {
        pinRequests.append(id)
    }

    func pair(endpoint: String, token: String?) async throws {}

    func createThread(
        projectID: String,
        title: String?,
        selection: FeatureSelection?
    ) async throws -> FeatureThread {
        FeatureThread(id: "created", projectID: projectID, title: title ?? "Created")
    }

    func renameThread(id: String, title: String) async throws {}
    func setThreadArchived(id: String, archived: Bool) async throws {}
    func deleteThread(id: String) async throws {}

    func loadThread(id: String) async throws -> FeatureThreadDetail {
        FeatureThreadDetail(
            thread: snapshot.threads.first { $0.id == id }
                ?? FeatureThread(id: id, projectID: "project", title: "Task")
        )
    }

    func sendMessage(threadID: String, text: String, selection: FeatureSelection?) async throws {}
    func cancelTurn(threadID: String) async throws {}
    func resolveApproval(id: String, decision: FeatureApprovalDecision) async throws {}
    func saveSettings(_ settings: FeatureSettings) async throws {}
}
