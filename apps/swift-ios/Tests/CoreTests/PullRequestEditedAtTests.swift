import Foundation
import Testing
@testable import T3Code

@Suite("Pull request comment edit timestamps")
struct PullRequestEditedAtTests {
    @Test func optionalEditTimePreservesOlderResponsesAndChangesEquality() throws {
        var fields: [String: JSONValue] = [
            "id": .string("comment"), "kind": .string("issue-comment"),
            "body": .string("Review"), "createdAt": .string("2026-10-01T00:00:00Z"),
        ]
        let base = JSONValue.object(fields)
        let old = try base.decode(PullRequestComment.self)
        let oldThread = try base.decode(PullRequestThreadComment.self)
        #expect(old.editedAt == nil)
        #expect(oldThread.editedAt == nil)
        fields["editedAt"] = .string("2026-10-02T00:00:00Z")
        let edited = try JSONValue.object(fields).decode(PullRequestComment.self)
        let editedThread = try JSONValue.object(fields).decode(PullRequestThreadComment.self)
        #expect(edited.editedAt == "2026-10-02T00:00:00Z")
        #expect(edited != old)
        #expect(editedThread != oldThread)
        fields["editedAt"] = .null
        #expect(try JSONValue.object(fields).decode(PullRequestComment.self) == old)
    }
    @Test func changeRequestHeadSHAIsOptional() throws {
        var fields: [String: JSONValue] = [
            "number": .number(10), "title": .string("Fix"),
            "url": .string("https://github.com/example/repo/pull/10"),
            "baseRef": .string("main"), "headRef": .string("fix"), "state": .string("open"),
        ]
        #expect(try JSONValue.object(fields).decode(VCSChangeRequest.self).headSha == nil)
        fields["headSha"] = .string("abc123")
        #expect(try JSONValue.object(fields).decode(VCSChangeRequest.self).headSha == "abc123")
    }

}
