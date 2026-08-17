import Foundation
import Testing
import UIKit
@testable import T3Code

@MainActor
@Suite("Home row trailing swipe actions")
struct HomeThreadSwipeActionTests {
    private let now = Date(timeIntervalSince1970: 20_000)

    @Test
    func pinnedRowsRevealSettleBesideUnpin() {
        let pinned = thread(id: "pinned", pinnedAt: now.addingTimeInterval(-30))

        let actions = HomeThreadSwipeAction.trailingActions(
            for: pinned,
            isArchived: false,
            at: now
        )

        #expect(actions == [.delete, .unpin, .settle])
        #expect(actions.map(\.title) == ["Delete", "Unpin", "Settle"])
        #expect(actions.map(\.systemImage) == ["trash", "pin.slash", "checkmark"])
    }

    /// The pinned shelf also holds settled threads, so a pinned row has to be
    /// able to offer the reverse action instead of a second settle.
    @Test
    func pinnedSettledRowsRevealReopenInsteadOfSettle() {
        var pinnedSettled = thread(id: "pinned-settled", pinnedAt: now.addingTimeInterval(-30))
        pinnedSettled.isSettled = true

        let actions = HomeThreadSwipeAction.trailingActions(
            for: pinnedSettled,
            isArchived: false,
            at: now
        )

        #expect(actions == [.delete, .unpin, .reopen])
        #expect(actions.map(\.title) == ["Delete", "Unpin", "Reopen"])

        // A pinned row that has aged into automatic settlement reads the same way.
        var restingPinned = thread(id: "resting-pinned", pinnedAt: now.addingTimeInterval(-30))
        restingPinned.lastActivityAt = now.addingTimeInterval(-4 * 24 * 60 * 60)
        #expect(
            HomeThreadSwipeAction.trailingActions(
                for: restingPinned,
                isArchived: false,
                at: now
            ) == [.delete, .unpin, .reopen]
        )
    }

    @Test
    func pinnedRowsWithoutSettlementSupportKeepOnlyUnpin() {
        var unsupported = thread(id: "unsupported", pinnedAt: now.addingTimeInterval(-30))
        unsupported.supportsSettlement = false

        #expect(
            HomeThreadSwipeAction.trailingActions(
                for: unsupported,
                isArchived: false,
                at: now
            ) == [.delete, .unpin]
        )

        // An already settled thread keeps its reverse action even when the
        // environment reports no settlement capability.
        unsupported.isSettled = true
        #expect(
            HomeThreadSwipeAction.trailingActions(
                for: unsupported,
                isArchived: false,
                at: now
            ) == [.delete, .unpin, .reopen]
        )
    }

    @Test
    func unpinnedAndArchivedRowsKeepTheirExistingActions() {
        let active = thread(id: "active")
        #expect(
            HomeThreadSwipeAction.trailingActions(for: active, isArchived: false, at: now)
                == [.delete, .settle]
        )

        var settled = thread(id: "settled")
        settled.isSettled = true
        #expect(
            HomeThreadSwipeAction.trailingActions(for: settled, isArchived: false, at: now)
                == [.delete, .reopen]
        )

        var unsupported = thread(id: "no-settlement")
        unsupported.supportsSettlement = false
        #expect(
            HomeThreadSwipeAction.trailingActions(for: unsupported, isArchived: false, at: now)
                == [.delete, .archive]
        )

        // Archived rows stay restore-only, including a pinned or settled one.
        var archived = thread(id: "archived", pinnedAt: now.addingTimeInterval(-30))
        archived.isArchived = true
        archived.isSettled = true
        #expect(
            HomeThreadSwipeAction.trailingActions(for: archived, isArchived: true, at: now)
                == [.delete, .restore]
        )
    }

    /// Delete stays in the outermost slot on every row and the configuration
    /// disables the first-action full swipe, so widening a pinned row's actions
    /// cannot turn a long swipe into a destructive one.
    @Test
    func everyRowKeepsOneDestructiveOutermostActionAndNoDuplicates() {
        var candidates: [(FeatureThread, Bool)] = []
        for isSettled in [false, true] {
            for isPinned in [false, true] {
                for supportsSettlement in [nil, true, false] as [Bool?] {
                    for isArchived in [false, true] {
                        var candidate = thread(
                            id: "row-\(isSettled)-\(isPinned)-\(String(describing: supportsSettlement))",
                            pinnedAt: isPinned ? now.addingTimeInterval(-30) : nil
                        )
                        candidate.isSettled = isSettled
                        candidate.supportsSettlement = supportsSettlement
                        candidate.isArchived = isArchived
                        candidates.append((candidate, isArchived))
                    }
                }
            }
        }

        for (candidate, isArchived) in candidates {
            let actions = HomeThreadSwipeAction.trailingActions(
                for: candidate,
                isArchived: isArchived,
                at: now
            )
            #expect(actions.first == .delete)
            #expect(actions.count == Set(actions).count)
            #expect(actions.filter { $0.style == .destructive } == [.delete])
            #expect(actions.filter { [.settle, .reopen].contains($0) }.count <= 1)
            #expect(!actions.isEmpty)
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

        // The settlement actions keep the row's existing accent vocabulary and
        // never inherit the destructive style.
        #expect(HomeThreadSwipeAction.settle.style == .normal)
        #expect(HomeThreadSwipeAction.settle.backgroundColor == .systemGreen)
        #expect(HomeThreadSwipeAction.reopen.backgroundColor == .systemBlue)
        #expect(HomeThreadSwipeAction.reopen.systemImage == "arrow.counterclockwise")
        #expect(HomeThreadSwipeAction.delete.style == .destructive)
        #expect(HomeThreadSwipeAction.delete.backgroundColor == nil)
    }

    /// The swipe action carries no settlement logic of its own: its intent is
    /// applied through the same `FeatureRootModel.setSettled` call the row's
    /// context menu uses, which reaches the client's real settlement request.
    @Test
    func settlingAPinnedRowTakesTheRealSettlementPathAndClearsThePin() async throws {
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

        let settle = try #require(
            HomeThreadSwipeAction.trailingActions(
                for: pinned,
                isArchived: false,
                at: now
            ).last
        )
        #expect(settle == .settle)
        #expect(settle.intent == .setSettled(true))

        // Applying that intent the way the row's `onSettle` closure does.
        guard case let .setSettled(settled) = settle.intent else { return }
        await model.setSettled(pinned.id, settled: settled)

        #expect(client.settlementRequests == [SettlementRequest(id: "pinned", settled: true)])
        let updated = try #require(model.snapshot.threads.first { $0.id == "pinned" })
        #expect(updated.isSettled)
        #expect(!updated.keepsActive)
        #expect(updated.settledAt != nil)
        #expect(updated.pinnedAt == nil)

        // The row leaves the pinned shelf for Settled, where its swipe now
        // offers the reverse action instead.
        let shelves = presentation(for: model)
        #expect(shelves.pinned.isEmpty)
        #expect(shelves.settled.map(\.id) == ["pinned"])
        #expect(
            HomeThreadSwipeAction.trailingActions(for: updated, isArchived: false, at: now)
                == [.delete, .reopen]
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

    func initialSnapshot() async throws -> FeatureSnapshot { snapshot }

    func setThreadSettled(id: String, settled: Bool) async throws {
        settlementRequests.append(SettlementRequest(id: id, settled: settled))
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
