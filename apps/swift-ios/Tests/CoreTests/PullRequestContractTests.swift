import XCTest
@testable import T3Code

final class PullRequestContractTests: XCTestCase {
    func testThreadLinkedPullRequestDecodesCurrentWireShape() throws {
        let linked = try JSONDecoder.t3.decode(
            ThreadLinkedPullRequest.self,
            from: Data(
                #"{"projectId":"project-1","repository":"pingdotgg/t3code","number":5178,"url":"https://github.com/pingdotgg/t3code/pull/5178"}"#.utf8
            )
        )

        XCTAssertEqual(linked.projectId, "project-1")
        XCTAssertEqual(linked.repository, "pingdotgg/t3code")
        XCTAssertEqual(linked.number, 5178)
    }

    func testListResultDecodesCurrentWireShape() throws {
        let data = Data(
            #"""
            {
              "viewers":{"github.com":"theo"},
              "providers":[{
                "host":"github.com","kind":"github","searchesOnHost":true,
                "projectCount":1,"configured":true,"detail":null
              }],
              "entries":[{
                "provider":"github","host":"github.com","projectId":"project-1",
                "projectTitle":"T3 Code","repository":"pingdotgg/t3code","number":5178,
                "title":"Native SwiftUI app","url":"https://github.com/pingdotgg/t3code/pull/5178",
                "author":{"login":"theo","name":"Theo","avatarUrl":null},
                "headBranch":"native","baseBranch":"main","state":"open","isDraft":false,
                "mergeability":"mergeable","additions":20,"deletions":4,
                "createdAt":"2026-08-18T12:00:00.000Z","updatedAt":"2026-08-18T13:00:00.000Z",
                "viewerReviewRequested":false,"labels":[],"reviewDecision":"approved",
                "checksState":"passing"
              }],
              "errors":[],"truncated":false,"nextCursors":{}
            }
            """#.utf8
        )

        let result = try JSONDecoder.t3.decode(PullRequestListResult.self, from: data)

        XCTAssertEqual(result.entries.first?.number, 5178)
        XCTAssertEqual(result.entries.first?.reviewDecision, .approved)
        XCTAssertEqual(result.providers.first?.kind, .github)
    }

    func testReferenceEncodesExactRpcPayload() throws {
        let reference = PullRequestRef(
            projectId: "project-1",
            repository: "pingdotgg/t3code",
            number: 5178
        )

        XCTAssertEqual(
            try JSONValue.encode(reference),
            .object([
                "projectId": .string("project-1"),
                "repository": .string("pingdotgg/t3code"),
                "number": .number(5178),
            ])
        )
    }

    func testListPagesPreserveRowsAndAdvanceCursors() {
        let first = PullRequestListResult(
            viewers: ["github.com": "theo"],
            providers: [],
            entries: [],
            errors: [],
            truncated: true,
            nextCursors: ["github.com t3/repo": "first"]
        )
        let second = PullRequestListResult(
            viewers: ["gitlab.com": "maintainer"],
            providers: [],
            entries: [],
            errors: [],
            truncated: false,
            nextCursors: [:]
        )

        let combined = first.appending(second)

        XCTAssertEqual(combined.viewers["github.com"], "theo")
        XCTAssertEqual(combined.viewers["gitlab.com"], "maintainer")
        XCTAssertFalse(combined.truncated)
        XCTAssertTrue(combined.nextCursors.isEmpty)
    }
}
