import Testing
@testable import T3Code

struct FeaturePullRequestLinkInputTests {
    @Test(arguments: ["123", "#123", "gh pr checkout 123", "  #123  "])
    func bareReferencesUseTheThreadRepository(_ reference: String) throws {
        #expect(try FeaturePullRequestLinkInput.resolve(reference, repository: .init(canonicalKey: "github.com/pingdotgg/t3code"))
            == "https://github.com/pingdotgg/t3code/pull/123")
    }

    @Test func fullReferencesNeedNoProject() throws {
        let url = "https://gitlab.example/team/subgroup/repo/-/merge_requests/42"
        #expect(try FeaturePullRequestLinkInput.resolve(url, repository: nil) == url)
    }

    @Test func otherHostsUseTheirOwnRoute() throws {
        #expect(try FeaturePullRequestLinkInput.resolve("#42", repository: .init(
            canonicalKey: "code.example/team/repo", provider: "forgejo", webURL: "https://code.example/team/repo"
        )) == "https://code.example/team/repo/pulls/42")
        #expect(try FeaturePullRequestLinkInput.resolve("42", repository: .init(
            canonicalKey: "gitlab.example/team/subgroup/repo", provider: "gitlab"
        )) == "https://gitlab.example/team/subgroup/repo/-/merge_requests/42")
    }

    @Test(arguments: ["0", "#-1", "1e2", "1.5", "42 trailing text", "9007199254740992", "https://example.com/path"])
    func invalidReferencesAreRejected(_ reference: String) {
        #expect(throws: FeaturePullRequestLinkInput.InputError.self) {
            try FeaturePullRequestLinkInput.resolve(reference, repository: .init(canonicalKey: "github.com/a/b"))
        }
    }

    @Test func httpsRemotePreservesSelfHostedPorts() throws {
        #expect(try FeaturePullRequestLinkInput.resolve("42", repository: .init(
            canonicalKey: "code.example/team/repo", provider: "forgejo", remoteURL: "https://code.example:8443/team/repo.git"
        )) == "https://code.example:8443/team/repo/pulls/42")
    }

    @Test func unknownRepositoryRequiresAFullURL() {
        #expect(throws: FeaturePullRequestLinkInput.InputError.self) {
            try FeaturePullRequestLinkInput.resolve("42", repository: nil)
        }
    }
}
