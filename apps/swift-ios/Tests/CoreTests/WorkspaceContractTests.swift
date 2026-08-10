import XCTest
@testable import T3Code

@MainActor
final class WorkspaceContractTests: XCTestCase {
    func testLatestNewTaskRequestWaitsForCurrentDismissalAndGetsFreshIdentity() {
        let first = FeatureNewTaskPresentationRequest.newTask(initialProjectID: "project-1")
        let replacement = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-2")
        var coordinator = FeatureNewTaskPresentationCoordinator()

        let initial = coordinator.request(first, deferredByModal: false)
        let firstID = try! XCTUnwrap(initial.presentation?.id)
        XCTAssertEqual(initial.presentation?.request, first)

        let queued = coordinator.request(replacement, deferredByModal: false)
        XCTAssertEqual(queued.dismissalID, firstID)
        XCTAssertNil(queued.presentation)
        XCTAssertEqual(coordinator.pending, replacement)

        let completed = coordinator.completeDismissal(id: firstID, deferredByModal: false)
        XCTAssertEqual(completed.released, [first])
        XCTAssertEqual(completed.presentation?.request, replacement)
        XCTAssertNotEqual(completed.presentation?.id, firstID)
    }

    func testOverwrittenPendingShareIsReleasedExactlyOnce() {
        let active = FeatureNewTaskPresentationRequest.newTask(initialProjectID: "project-1")
        let firstShare = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-1")
        let latestShare = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-2")
        var coordinator = FeatureNewTaskPresentationCoordinator()

        _ = coordinator.request(active, deferredByModal: false)
        _ = coordinator.request(firstShare, deferredByModal: false)
        let overwritten = coordinator.request(latestShare, deferredByModal: false)

        XCTAssertEqual(overwritten.released, [firstShare])
        XCTAssertEqual(coordinator.pending, latestShare)
        XCTAssertNil(coordinator.completeDismissal(id: UUID(), deferredByModal: false).presentation)
        XCTAssertEqual(coordinator.pending, latestShare)
    }

    func testDismissalCompletionIsIdempotentAndRejectsStaleCallbacks() {
        let share = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-1")
        var coordinator = FeatureNewTaskPresentationCoordinator()
        let presentation = try! XCTUnwrap(
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

        XCTAssertEqual(first.released, [share])
        XCTAssertTrue(duplicate.isEmpty)
        XCTAssertNil(coordinator.current)
    }

    func testDismissalCompletionRequiresAnExplicitMatchingDismissalStart() {
        let request = FeatureNewTaskPresentationRequest.newTask(initialProjectID: nil)
        var coordinator = FeatureNewTaskPresentationCoordinator()
        let presentation = try! XCTUnwrap(
            coordinator.request(request, deferredByModal: false).presentation
        )

        let unrelatedDisappearance = coordinator.completeDismissal(
            id: presentation.id,
            deferredByModal: false
        )

        XCTAssertTrue(unrelatedDisappearance.isEmpty)
        XCTAssertEqual(coordinator.current, presentation)
    }

    func testFallbackCompletionPromotesTheSameLatestRequest() {
        let first = FeatureNewTaskPresentationRequest.newTask(initialProjectID: "project-1")
        let replacement = FeatureNewTaskPresentationRequest.newTask(initialProjectID: "project-2")
        var coordinator = FeatureNewTaskPresentationCoordinator()
        let firstID = try! XCTUnwrap(
            coordinator.request(first, deferredByModal: false).presentation?.id
        )
        _ = coordinator.request(replacement, deferredByModal: false)

        let fallback = coordinator.completeDismissal(id: firstID, deferredByModal: false)

        XCTAssertEqual(fallback.presentation?.request, replacement)
        XCTAssertEqual(fallback.released, [first])
        XCTAssertTrue(
            coordinator.completeDismissal(id: firstID, deferredByModal: false).isEmpty
        )
    }

    func testLatestModalDeferredRequestResumesAfterModalDismissal() {
        let firstShare = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-1")
        let latest = FeatureNewTaskPresentationRequest.newTask(initialProjectID: "project-2")
        var coordinator = FeatureNewTaskPresentationCoordinator()

        let first = coordinator.request(firstShare, deferredByModal: true)
        let second = coordinator.request(latest, deferredByModal: true)

        XCTAssertTrue(first.isEmpty)
        XCTAssertEqual(second.released, [firstShare])
        XCTAssertEqual(coordinator.deferred, latest)
        let resumed = coordinator.resumeDeferred()
        XCTAssertEqual(resumed.presentation?.request, latest)
        XCTAssertTrue(coordinator.resumeDeferred().isEmpty)
    }

    func testThreadOrProjectRouteCancelsEveryQueuedNewTaskWithoutGhostReopen() {
        let active = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-1")
        let pending = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-2")
        var coordinator = FeatureNewTaskPresentationCoordinator()
        let activeID = try! XCTUnwrap(
            coordinator.request(active, deferredByModal: false).presentation?.id
        )
        _ = coordinator.request(pending, deferredByModal: false)

        let cancelled = coordinator.cancelAll()

        XCTAssertEqual(Set(cancelled.released.compactMap(\.incomingShareID)), ["share-1", "share-2"])
        XCTAssertEqual(cancelled.dismissalID, activeID)
        XCTAssertNil(coordinator.current)
        XCTAssertNil(coordinator.pending)
        XCTAssertTrue(
            coordinator.completeDismissal(id: activeID, deferredByModal: false).isEmpty
        )
        XCTAssertTrue(coordinator.resumeDeferred().isEmpty)
    }

    func testRouteCancellationAlsoClearsModalDeferredShareExactlyOnce() {
        let deferred = FeatureNewTaskPresentationRequest.sharedNewTask(shareID: "share-modal")
        var coordinator = FeatureNewTaskPresentationCoordinator()
        _ = coordinator.request(deferred, deferredByModal: true)

        let cancelled = coordinator.cancelAll()

        XCTAssertEqual(cancelled.released, [deferred])
        XCTAssertTrue(coordinator.cancelAll().released.isEmpty)
        XCTAssertTrue(coordinator.resumeDeferred().isEmpty)
    }

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
