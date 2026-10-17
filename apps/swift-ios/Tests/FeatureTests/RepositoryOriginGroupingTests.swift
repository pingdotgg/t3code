import Testing
@testable import T3Code

@Suite("Repository origin grouping")
struct RepositoryOriginGroupingTests {
    @Test func forksStaySeparateWhileTheSameForkGroupsAcrossEnvironments() throws {
        let upstreamIdentity = FeatureRepositoryIdentity(
            canonicalKey: "github.com/upstream/repo", displayName: "Upstream"
        )
        var forkIdentity = upstreamIdentity
        forkIdentity.origin = .init(canonicalKey: "github.com/theo/repo", displayName: "Theo's fork")
        let upstream = project(id: "upstream", environment: "one", identity: upstreamIdentity)
        let fork = project(id: "fork", environment: "one", identity: forkIdentity)
        let remoteFork = project(id: "remote-fork", environment: "two", identity: forkIdentity)
        let groups = DailyUXProjectGrouping.groups(projects: [upstream, fork, remoteFork])
        #expect(groups.count == 2)
        let forkGroup = try #require(DailyUXProjectGrouping.group(containing: fork.id, in: groups))
        #expect(forkGroup.name == "Theo's fork")
        #expect(forkGroup.memberProjectIDs == [fork.id, remoteFork.id])
        #expect(!forkGroup.memberProjectIDs.contains(upstream.id))
        // Grouping must not alter the canonical identity used for PR association.
        #expect(fork.repositoryIdentity?.canonicalKey == upstream.repositoryIdentity?.canonicalKey)
    }

    @Test func originWithoutLabelUsesOriginKey() throws {
        var identity = FeatureRepositoryIdentity(canonicalKey: "upstream", displayName: "Upstream")
        identity.origin = .init(canonicalKey: "github.com/theo/repo", displayName: nil)
        let groups = DailyUXProjectGrouping.groups(projects: [project(id: "fork", environment: "one", identity: identity)])
        #expect(groups.first?.name == "github.com/theo/repo")
    }

    private func project(id: String, environment: String, identity: FeatureRepositoryIdentity) -> FeatureProject {
        .init(id: id, environmentID: environment, name: id, path: "/work/\(id)", repositoryIdentity: identity)
    }
}
