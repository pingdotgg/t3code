import Foundation
import Testing
import UIKit
@testable import T3Code

@MainActor
@Suite("Home row trailing swipe actions")
struct HomeThreadSwipeActionTests {
    private let now = Date(timeIntervalSince1970: 20_000)

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
        settled.isSettled = true
        let settledActions = HomeThreadSwipeAction.trailingActions(
            for: settled,
            isArchived: false,
            at: now
        )
        #expect(settledActions == [.reopen, .delete])
        #expect(settledActions.first?.intent == .setSettled(false))
        #expect(HomeThreadSwipeAction.performsFullSwipe(with: settledActions))

        var pinnedSettled = thread(id: "pinned-settled", pinnedAt: now.addingTimeInterval(-30))
        pinnedSettled.isSettled = true
        #expect(
            HomeThreadSwipeAction.trailingActions(
                for: pinnedSettled,
                isArchived: false,
                at: now
            ) == [.reopen, .unpin, .delete]
        )

        // A row that aged into automatic settlement reads the same way.
        var resting = thread(id: "resting")
        resting.lastActivityAt = now.addingTimeInterval(-4 * 24 * 60 * 60)
        #expect(
            HomeThreadSwipeAction.trailingActions(
                for: resting,
                isArchived: false,
                at: now
            ) == [.reopen, .delete]
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

    private func presentation(for model: FeatureRootModel) -> HomePresentation {
        HomePresentation(
            snapshot: model.snapshot,
            query: "",
            projectID: nil,
            now: now
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
            pinnedAt: pinnedAt
        )
    }
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

/// Records the settlement requests the feature client actually receives, so the
/// swipe action's wiring is proved against the real client call rather than a
/// view-local shortcut.
@MainActor
private final class SwipeSettlementClientStub: FeatureClient {
    var snapshot = FeatureSnapshot()
    var settlementRequests: [SettlementRequest] = []
    var pinRequests: [String] = []

    func initialSnapshot() async throws -> FeatureSnapshot { snapshot }

    func setThreadSettled(id: String, settled: Bool) async throws {
        settlementRequests.append(SettlementRequest(id: id, settled: settled))
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
