import Testing
import XCTest
@testable import T3Code

@Suite("New task presentation lifecycle")
@MainActor
struct FeatureNewTaskPresentationCoordinatorTests {
    @Test func latestRequestWaitsForCurrentDismissalAndGetsFreshIdentity() throws {
        let first = FeatureNewTaskPresentationRequest.newTask(initialProjectID: "project-1")
        let replacement = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-2")
        var coordinator = FeatureNewTaskPresentationCoordinator()

        let initial = coordinator.request(first, deferredByModal: false)
        let firstID = try #require(initial.presentation?.id)
        #expect(initial.presentation?.request == first)

        let queued = coordinator.request(replacement, deferredByModal: false)
        #expect(queued.dismissalID == firstID)
        #expect(queued.presentation == nil)
        #expect(coordinator.pending == replacement)

        let completed = coordinator.completeDismissal(id: firstID, deferredByModal: false)
        #expect(completed.released == [first])
        #expect(completed.presentation?.request == replacement)
        #expect(completed.presentation?.id != firstID)
    }

    @Test func overwrittenPendingShareIsReleasedExactlyOnce() {
        let active = FeatureNewTaskPresentationRequest.newTask(initialProjectID: "project-1")
        let firstShare = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-1")
        let latestShare = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-2")
        var coordinator = FeatureNewTaskPresentationCoordinator()

        _ = coordinator.request(active, deferredByModal: false)
        _ = coordinator.request(firstShare, deferredByModal: false)
        let overwritten = coordinator.request(latestShare, deferredByModal: false)

        #expect(overwritten.released == [firstShare])
        #expect(coordinator.pending == latestShare)
        #expect(coordinator.completeDismissal(
            id: UUID(),
            deferredByModal: false
        ).presentation == nil)
        #expect(coordinator.pending == latestShare)
    }

    @Test func dismissalCompletionIsIdempotentAndRejectsStaleCallbacks() throws {
        let share = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-1")
        var coordinator = FeatureNewTaskPresentationCoordinator()
        let presentation = try #require(
            coordinator.request(share, deferredByModal: false).presentation
        )
        _ = coordinator.beginDismissal(id: presentation.id)

        let first = coordinator.completeDismissal(
            id: presentation.id,
            deferredByModal: false
        )
        let duplicate = coordinator.completeDismissal(
            id: presentation.id,
            deferredByModal: false
        )

        #expect(first.released == [share])
        #expect(duplicate.isEmpty)
        #expect(coordinator.current == nil)
    }

    @Test func dismissalCompletionRequiresAnExplicitMatchingDismissalStart() throws {
        let request = FeatureNewTaskPresentationRequest.newTask(initialProjectID: nil)
        var coordinator = FeatureNewTaskPresentationCoordinator()
        let presentation = try #require(
            coordinator.request(request, deferredByModal: false).presentation
        )

        let unrelatedDisappearance = coordinator.completeDismissal(
            id: presentation.id,
            deferredByModal: false
        )

        #expect(unrelatedDisappearance.isEmpty)
        #expect(coordinator.current == presentation)
    }

    @Test func fallbackCompletionPromotesTheSameLatestRequest() throws {
        let first = FeatureNewTaskPresentationRequest.newTask(initialProjectID: "project-1")
        let replacement = FeatureNewTaskPresentationRequest.newTask(initialProjectID: "project-2")
        var coordinator = FeatureNewTaskPresentationCoordinator()
        let firstID = try #require(
            coordinator.request(first, deferredByModal: false).presentation?.id
        )
        _ = coordinator.request(replacement, deferredByModal: false)

        let fallback = coordinator.completeDismissal(id: firstID, deferredByModal: false)

        #expect(fallback.presentation?.request == replacement)
        #expect(fallback.released == [first])
        #expect(
            coordinator.completeDismissal(id: firstID, deferredByModal: false).isEmpty
        )
    }

    @Test func latestModalDeferredRequestResumesAfterModalDismissal() {
        let firstShare = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-1")
        let latest = FeatureNewTaskPresentationRequest.newTask(initialProjectID: "project-2")
        var coordinator = FeatureNewTaskPresentationCoordinator()

        let first = coordinator.request(firstShare, deferredByModal: true)
        let second = coordinator.request(latest, deferredByModal: true)

        #expect(first.isEmpty)
        #expect(second.released == [firstShare])
        #expect(coordinator.deferred == latest)
        let resumed = coordinator.resumeDeferred()
        #expect(resumed.presentation?.request == latest)
        #expect(coordinator.resumeDeferred().isEmpty)
    }

    @Test func directRequestReleasesAPreviouslyDeferredShare() {
        let deferred = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-modal")
        let direct = FeatureNewTaskPresentationRequest.newTask(initialProjectID: "project-2")
        var coordinator = FeatureNewTaskPresentationCoordinator()
        _ = coordinator.request(deferred, deferredByModal: true)

        let effects = coordinator.request(direct, deferredByModal: false)

        #expect(effects.presentation?.request == direct)
        #expect(effects.released == [deferred])
        #expect(coordinator.deferred == nil)
        #expect(coordinator.current?.request == direct)
    }

    @Test func supersededRequestBeforePresentationCompletesAfterYield() throws {
        let first = FeatureNewTaskPresentationRequest.newTask(initialProjectID: "project-1")
        let replacement = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-2")
        var coordinator = FeatureNewTaskPresentationCoordinator()
        let initial = try #require(
            coordinator.request(first, deferredByModal: false).presentation
        )

        let queued = coordinator.request(replacement, deferredByModal: false)

        #expect(queued.dismissalID == initial.id)
        #expect(!FeatureNewTaskPresentationTiming.requiresDismissalCallback(
            dismissalID: initial.id,
            presentedID: nil
        ))
        #expect(!FeatureNewTaskPresentationTiming.canPresent(
            id: initial.id,
            currentID: coordinator.current?.id,
            awaitingDismissalID: queued.dismissalID,
            presentedID: nil
        ))

        let completed = coordinator.completeDismissal(
            id: initial.id,
            deferredByModal: false
        )
        #expect(completed.presentation?.request == replacement)
    }

    @Test func threadOrProjectRouteCancelsEveryQueuedTaskWithoutGhostReopen() throws {
        let active = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-1")
        let pending = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-2")
        var coordinator = FeatureNewTaskPresentationCoordinator()
        let activeID = try #require(
            coordinator.request(active, deferredByModal: false).presentation?.id
        )
        _ = coordinator.request(pending, deferredByModal: false)

        let cancelled = coordinator.cancelAll()

        #expect(Set(cancelled.released.compactMap(\.incomingShareID)) == ["share-1", "share-2"])
        #expect(cancelled.dismissalID == activeID)
        #expect(coordinator.current == nil)
        #expect(coordinator.pending == nil)
        #expect(
            coordinator.completeDismissal(id: activeID, deferredByModal: false).isEmpty
        )
        #expect(coordinator.resumeDeferred().isEmpty)
    }

    @Test func routeCancellationAlsoClearsModalDeferredShareExactlyOnce() {
        let deferred = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-modal")
        var coordinator = FeatureNewTaskPresentationCoordinator()
        _ = coordinator.request(deferred, deferredByModal: true)

        let cancelled = coordinator.cancelAll()

        #expect(cancelled.released == [deferred])
        #expect(coordinator.cancelAll().released.isEmpty)
        #expect(coordinator.resumeDeferred().isEmpty)
    }
}

@MainActor
final class WorkspaceContractTests: XCTestCase {
    func testVCSStatusSnapshotDecodesTaggedEffectRPCShape() throws {
        let data = Data(
            """
            {
              "_tag": "snapshot",
              "local": {
                "isRepo": true,
                "sourceControlProvider": {
                  "kind": "github",
                  "name": "GitHub",
                  "baseUrl": "https://github.com"
                },
                "hasPrimaryRemote": true,
                "isDefaultRef": false,
                "refName": "feat/swift",
                "hasWorkingTreeChanges": true,
                "workingTree": {
                  "files": [{"path":"Core/T3Client.swift","insertions":12,"deletions":2}],
                  "insertions": 12,
                  "deletions": 2
                }
              },
              "remote": {
                "hasUpstream": true,
                "aheadCount": 1,
                "behindCount": 0,
                "aheadOfDefaultCount": 3,
                "pr": null
              }
            }
            """.utf8
        )

        let event = try JSONDecoder.t3.decode(VCSStatusEvent.self, from: data)
        guard case let .snapshot(local, remote) = event else {
            return XCTFail("Expected snapshot")
        }
        XCTAssertEqual(local.refName, "feat/swift")
        XCTAssertEqual(local.workingTree.files.first?.insertions, 12)
        XCTAssertEqual(remote?.aheadCount, 1)
    }

    func testTerminalAttachEventsDecodeSnapshotAndOutputShapes() throws {
        let snapshotData = Data(
            """
            {
              "type": "snapshot",
              "snapshot": {
                "threadId": "thread-1",
                "terminalId": "term-1",
                "cwd": "/workspace",
                "worktreePath": null,
                "status": "running",
                "pid": 42,
                "history": "$ ",
                "exitCode": null,
                "exitSignal": null,
                "label": "Shell",
                "updatedAt": "2026-07-30T12:00:00.000Z",
                "sequence": 4
              }
            }
            """.utf8
        )
        let outputData = Data(
            """
            {
              "type": "output",
              "threadId": "thread-1",
              "terminalId": "term-1",
              "sequence": 5,
              "data": "hello\\r\\n"
            }
            """.utf8
        )

        let snapshot = try JSONDecoder.t3.decode(TerminalEvent.self, from: snapshotData)
        let output = try JSONDecoder.t3.decode(TerminalEvent.self, from: outputData)
        XCTAssertEqual(snapshot.snapshot?.pid, 42)
        XCTAssertEqual(snapshot.snapshot?.sequence, 4)
        XCTAssertEqual(output.data, "hello\r\n")
        XCTAssertEqual(output.sequence, 5)
    }

    func testReviewAndProjectFileResultsDecodeExactServerFields() throws {
        let reviewData = Data(
            """
            {
              "cwd": "/workspace",
              "generatedAt": "2026-07-30T12:00:00.000Z",
              "sources": [{
                "id": "working-tree",
                "kind": "working-tree",
                "title": "Working tree",
                "baseRef": null,
                "headRef": null,
                "diff": "diff --git a/file b/file",
                "diffHash": "abc123",
                "truncated": false
              }]
            }
            """.utf8
        )
        let fileData = Data(
            """
            {
              "relativePath": "README.md",
              "contents": "# T3",
              "byteLength": 4,
              "truncated": false
            }
            """.utf8
        )

        let review = try JSONDecoder.t3.decode(ReviewDiffPreview.self, from: reviewData)
        let file = try JSONDecoder.t3.decode(ProjectReadFileResult.self, from: fileData)
        XCTAssertEqual(review.sources.first?.kind, "working-tree")
        XCTAssertEqual(review.sources.first?.diffHash, "abc123")
        XCTAssertEqual(file.relativePath, "README.md")
        XCTAssertFalse(file.truncated)
    }

    func testWorkspaceRPCMethodNamesMatchContractConstants() {
        XCTAssertEqual(RPCMethod.projectsListEntries.rawValue, "projects.listEntries")
        XCTAssertEqual(RPCMethod.vcsRefreshStatus.rawValue, "vcs.refreshStatus")
        XCTAssertEqual(RPCMethod.reviewDiffPreview.rawValue, "review.getDiffPreview")
        XCTAssertEqual(
            RPCMethod.getArchivedShellSnapshot.rawValue,
            "orchestration.getArchivedShellSnapshot"
        )
        XCTAssertEqual(RPCMethod.terminalAttach.rawValue, "terminal.attach")
        XCTAssertEqual(RPCMethod.subscribeTerminalEvents.rawValue, "subscribeTerminalEvents")
    }
}
