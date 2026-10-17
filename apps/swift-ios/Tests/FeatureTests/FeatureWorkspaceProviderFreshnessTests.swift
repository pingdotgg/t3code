import Foundation
import Testing
@testable import T3Code

@Suite("Workspace provider freshness")
struct FeatureWorkspaceProviderFreshnessTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let key = FeatureWorkspaceProviderFreshness.Key(
        environmentID: "remote", cwd: "/project", instanceID: "codex"
    )

    @Test
    func currentSnapshotExpiresAtFiveMinutes() {
        var freshness = FeatureWorkspaceProviderFreshness()
        let startsRefresh1 = freshness.beginRefresh(key: key, checkedAt: now, commandsPending: false, now: now)
        #expect(!startsRefresh1)
        let startsRefresh2 = freshness.beginRefresh(
            key: key, checkedAt: now, commandsPending: false, now: now.addingTimeInterval(299)
        )
        #expect(!startsRefresh2)
        let startsRefresh3 = freshness.beginRefresh(
            key: key, checkedAt: now, commandsPending: false, now: now.addingTimeInterval(300)
        )
        #expect(startsRefresh3)
    }

    @Test
    func staleAndMissingSnapshotsStartDiscovery() {
        var stale = FeatureWorkspaceProviderFreshness()
        let startsRefresh4 = stale.beginRefresh(
            key: key, checkedAt: now.addingTimeInterval(-300), commandsPending: false, now: now
        )
        #expect(startsRefresh4)
        var missing = FeatureWorkspaceProviderFreshness()
        let startsRefresh5 = missing.beginRefresh(key: key, checkedAt: nil, commandsPending: false, now: now)
        #expect(startsRefresh5)
    }

    @Test
    func onlyOneRequestForTheSameKeyCanRunEvenAfterTTL() {
        var freshness = FeatureWorkspaceProviderFreshness()
        let startsRefresh6 = freshness.beginRefresh(key: key, checkedAt: nil, commandsPending: false, now: now)
        #expect(startsRefresh6)
        let startsRefresh7 = freshness.beginRefresh(
            key: key, checkedAt: nil, commandsPending: false, now: now.addingTimeInterval(600)
        )
        #expect(!startsRefresh7)
        freshness.finishRefresh(key: key, complete: true, now: now.addingTimeInterval(600))
        let startsRefresh8 = freshness.beginRefresh(
            key: key, checkedAt: now, commandsPending: false, now: now.addingTimeInterval(601)
        )
        #expect(!startsRefresh8)
    }

    @Test
    func pendingDiscoveryRetriesOnUseAfterCooldown() {
        var freshness = FeatureWorkspaceProviderFreshness()
        let startsRefresh9 = freshness.beginRefresh(key: key, checkedAt: now, commandsPending: true, now: now)
        #expect(startsRefresh9)
        freshness.finishRefresh(key: key, complete: false, now: now.addingTimeInterval(1))
        let startsRefresh10 = freshness.beginRefresh(
            key: key, checkedAt: now, commandsPending: true, now: now.addingTimeInterval(9)
        )
        #expect(!startsRefresh10)
        let startsRefresh11 = freshness.beginRefresh(
            key: key, checkedAt: now, commandsPending: true, now: now.addingTimeInterval(10)
        )
        #expect(startsRefresh11)
        freshness.finishRefresh(key: key, complete: true, now: now.addingTimeInterval(11))
        let startsRefresh12 = freshness.beginRefresh(
            key: key, checkedAt: now, commandsPending: false, now: now.addingTimeInterval(20)
        )
        #expect(!startsRefresh12)
    }

    @Test
    func failedOrCancelledRequestDoesNotBecomeAFreshSnapshot() {
        var freshness = FeatureWorkspaceProviderFreshness()
        let stale = now.addingTimeInterval(-600)
        let startsRefresh13 = freshness.beginRefresh(key: key, checkedAt: stale, commandsPending: false, now: now)
        #expect(startsRefresh13)
        freshness.finishRefresh(key: key, complete: false, now: now.addingTimeInterval(1))
        let startsRefresh14 = freshness.beginRefresh(
            key: key, checkedAt: stale, commandsPending: false, now: now.addingTimeInterval(2)
        )
        #expect(!startsRefresh14)
        let startsRefresh15 = freshness.beginRefresh(
            key: key, checkedAt: stale, commandsPending: false, now: now.addingTimeInterval(10)
        )
        #expect(startsRefresh15)
    }

    @Test
    func environmentProviderAndDirectoryHaveIndependentRequests() {
        var freshness = FeatureWorkspaceProviderFreshness()
        let keys: [FeatureWorkspaceProviderFreshness.Key] = [
            key,
            .init(environmentID: "relay", cwd: key.cwd, instanceID: key.instanceID),
            .init(environmentID: key.environmentID, cwd: "/worktree", instanceID: key.instanceID),
            .init(environmentID: key.environmentID, cwd: key.cwd, instanceID: "claude"),
        ]
        for key in keys {
            let startsRefresh16 = freshness.beginRefresh(key: key, checkedAt: nil, commandsPending: false, now: now)
            #expect(startsRefresh16)
        }
        freshness.finishRefresh(key: keys[1], complete: false, now: now)
        let startsRefresh17 = freshness.beginRefresh(
            key: key, checkedAt: nil, commandsPending: false, now: now.addingTimeInterval(10)
        )
        #expect(!startsRefresh17)
        let startsRefresh18 = freshness.beginRefresh(
            key: keys[1], checkedAt: nil, commandsPending: false, now: now.addingTimeInterval(10)
        )
        #expect(startsRefresh18)
    }

    @Test
    func clientClockAheadOfServerUsesLocalCompletionTime() {
        var freshness = FeatureWorkspaceProviderFreshness()
        let serverTime = now.addingTimeInterval(-3_600)
        let startsRefresh19 = freshness.beginRefresh(key: key, checkedAt: serverTime, commandsPending: false, now: now)
        #expect(startsRefresh19)
        freshness.finishRefresh(key: key, complete: true, now: now.addingTimeInterval(20))
        let startsRefresh20 = freshness.beginRefresh(
            key: key, checkedAt: serverTime, commandsPending: false, now: now.addingTimeInterval(319)
        )
        #expect(!startsRefresh20)
        let startsRefresh21 = freshness.beginRefresh(
            key: key, checkedAt: serverTime, commandsPending: false, now: now.addingTimeInterval(320)
        )
        #expect(startsRefresh21)
    }

    @Test
    func serverClockAheadCannotKeepSnapshotFreshForever() {
        var freshness = FeatureWorkspaceProviderFreshness()
        let serverTime = now.addingTimeInterval(3_600)
        let startsRefresh22 = freshness.beginRefresh(key: key, checkedAt: serverTime, commandsPending: false, now: now)
        #expect(!startsRefresh22)
        let startsRefresh23 = freshness.beginRefresh(
            key: key, checkedAt: serverTime, commandsPending: false, now: now.addingTimeInterval(300)
        )
        #expect(startsRefresh23)
        freshness.finishRefresh(key: key, complete: true, now: now.addingTimeInterval(301))
        let startsRefresh24 = freshness.beginRefresh(
            key: key, checkedAt: serverTime, commandsPending: false, now: now.addingTimeInterval(601)
        )
        #expect(startsRefresh24)
    }

    @Test
    func invalidatedOrPendingSnapshotDoesNotWaitForPriorCompletionTTL() {
        var freshness = FeatureWorkspaceProviderFreshness()
        let startsRefresh25 = freshness.beginRefresh(key: key, checkedAt: now, commandsPending: false, now: now)
        #expect(!startsRefresh25)
        let startsRefresh26 = freshness.beginRefresh(
            key: key, checkedAt: now, commandsPending: true, now: now.addingTimeInterval(1)
        )
        #expect(startsRefresh26)
        freshness.finishRefresh(key: key, complete: true, now: now.addingTimeInterval(2))
        let startsRefresh27 = freshness.beginRefresh(
            key: key, checkedAt: nil, commandsPending: false, now: now.addingTimeInterval(11)
        )
        #expect(startsRefresh27)
    }
}
