import XCTest
@testable import T3Code

final class PullRequestContractTests: XCTestCase {
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
}
