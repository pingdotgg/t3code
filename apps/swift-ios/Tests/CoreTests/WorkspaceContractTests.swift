import XCTest
@testable import T3Code

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
