import XCTest
@testable import T3Code

final class ThreadPullRequestsTests: XCTestCase {
    func testStackOrderSelectsHighestOpenLayerAndHidesDismissedMembers() throws {
        var first = link(1, head: "one", base: "main")
        let second = link(2, head: "two", base: "one")
        var hidden = link(3, head: "three", base: "two")
        hidden.source = "stack-dismissed"
        XCTAssertEqual(ThreadPullRequests.chains([second, hidden, first]).map { $0.map(\.number) }, [[1, 2]])
        XCTAssertEqual(ThreadPullRequests.current([first, second, hidden])?.number, 2)
        XCTAssertFalse(ThreadPullRequests.searchTerms([hidden], legacy: nil).contains("#3"))
        first.snapshot = snapshot(state: .merged, head: "one", base: "main")
        XCTAssertEqual(ThreadPullRequests.current([first, second])?.number, 2)
    }

    func testNativeStackWinsOverBranchNamesAndCompletedStackKeepsTop() throws {
        let stack = try JSONDecoder.t3.decode(ThreadPullRequestStack.self, from: Data(#"""
        {"kind":"native","id":"stack-1","number":1,"url":"https://github.com/org/repo/stack/1",
         "base":"main","layers":[{"number":2,"headBranch":"second","state":"merged"},
         {"number":1,"headBranch":"first","state":"merged"}]}
        """#.utf8))
        var first = link(1, head: "first", base: "main")
        var second = link(2, head: "second", base: "main")
        first.stack = stack
        second.stack = stack
        first.snapshot = snapshot(state: .merged, head: "first", base: "main")
        second.snapshot = snapshot(state: .merged, head: "second", base: "main")
        XCTAssertEqual(ThreadPullRequests.chains([first, second]).first?.map(\.number), [2, 1])
        XCTAssertEqual(ThreadPullRequests.current([first, second])?.number, 1)
    }

    func testHostsAndPortsDoNotShareIdentityOrBranchChains() {
        let github = link(1, head: "one", base: "main")
        let enterprise = ThreadPullRequestLink(host: "github.example.com", repository: "org/repo",
            number: 1, url: "https://github.example.com/org/repo/pull/1", source: "manual",
            linkedAt: "2026-09-01T00:00:00Z", snapshot: snapshot(head: "two", base: "one"), stack: nil)
        XCTAssertNotEqual(github.id, enterprise.id)
        XCTAssertEqual(ThreadPullRequests.chains([github, enterprise]).count, 2)
        XCTAssertNotEqual(ThreadPullRequests.parseURL("http://git.local:3000/org/repo/pulls/1"),
                          ThreadPullRequests.parseURL("http://git.local:4000/org/repo/pulls/1"))
        XCTAssertEqual(ThreadPullRequests.parseURL("https://GITHUB.COM/Org/Repo/pull/2")?.repository, "org/repo")
        XCTAssertNil(ThreadPullRequests.parseURL("javascript:alert(1)"))
        XCTAssertNil(ThreadPullRequests.parseURL("https://github.com/org/repo/issues/2"))
        XCTAssertNil(ThreadPullRequests.parseURL("https://github.com/org/repo/pull/0"))
    }

    func testLinkCommandsNegotiateMultipleAndLegacyServers() throws {
        let key = ThreadPullRequestKey(host: "GITHUB.COM", repository: "Org/Repo", number: 1)
        let multiple = try XCTUnwrap(ThreadPullRequests.mutation(threadID: "thread", key: key,
            url: "https://github.com/org/repo/pull/1", linked: true, multiple: true,
            legacyProjectID: nil, commandID: "command"))
        XCTAssertEqual(multiple["type"], .string("thread.pull-request.link"))
        XCTAssertEqual(multiple["host"], .string("github.com"))
        XCTAssertEqual(multiple["source"], .string("manual"))
        XCTAssertNil(ThreadPullRequests.mutation(threadID: "thread", key: key, url: "url",
            linked: true, multiple: false, legacyProjectID: nil))
        let legacy = ThreadPullRequests.mutation(threadID: "thread", key: key, url: "url",
            linked: false, multiple: false, legacyProjectID: nil)
        XCTAssertEqual(legacy?["type"], .string("thread.meta.update"))
        XCTAssertEqual(legacy?["linkedPullRequest"], .null)
    }

    func testUnsyncedAndFutureSourcesRemainVisible() throws {
        var unsynced = link(1, head: "one", base: "main")
        unsynced.source = "future-source"
        unsynced.snapshot = nil
        XCTAssertTrue(unsynced.isOpen)
        XCTAssertEqual(ThreadPullRequests.current([unsynced])?.number, 1)
        let roundTrip = try JSONDecoder.t3.decode(ThreadPullRequestLink.self, from: JSONEncoder.t3.encode(unsynced))
        XCTAssertEqual(roundTrip, unsynced)
        XCTAssertEqual(try JSONDecoder.t3.decode(SourceControlProviderKind.self, from: Data(#""forgejo""#.utf8)), .forgejo)
        XCTAssertEqual(try JSONDecoder.t3.decode(SourceControlProviderKind.self, from: Data(#""future-host""#.utf8)), .unknown)
    }

    private func link(_ number: Int, head: String, base: String) -> ThreadPullRequestLink {
        ThreadPullRequestLink(host: "github.com", repository: "org/repo", number: number,
            url: "https://github.com/org/repo/pull/\(number)", source: "manual",
            linkedAt: "2026-09-01T00:00:00Z", snapshot: snapshot(head: head, base: base), stack: nil)
    }

    private func snapshot(state: PullRequestState = .open, head: String, base: String) -> ThreadPullRequestSnapshot {
        ThreadPullRequestSnapshot(state: state, title: "Update \(head)", headBranch: head, baseBranch: base,
            isDraft: false, updatedAt: nil, syncedAt: "2026-09-01T00:00:00Z")
    }
}
