import Foundation
import Testing
@testable import T3Code

@Suite("Subscription usage widget snapshots")
struct PlatformSubscriptionUsageTests {
    @Test
    func startupKeepsSameScopesLastReadingUntilCatchUpCompletes() throws {
        let environment = FeatureEnvironment(id: "a", name: "A", endpoint: "https://a.example.com")
        let scope = PlatformSubscriptionUsageObservationKey(isActive: true, environments: [environment], accountID: "user-a").scopeID
        var saved = PlatformSubscriptionUsageSnapshot.make([.init(environmentID: "a", label: "A", providers: [
            try UsageLimitTestFixtures.provider(used: 80),
        ])])
        saved.scopeID = scope
        var pending = PlatformSubscriptionUsageSnapshot.make([.init(environmentID: "a", label: "A", isPending: true)])
        pending.scopeID = scope
        let retained = PlatformSubscriptionUsageSnapshot.retainingPendingSnapshot(pending, previous: saved, isPending: true)
        let provider = try #require(retained.providers.first)
        #expect(provider.windows.first?.remaining == 20)
        #expect(provider.hasPartialData)
        #expect(provider.checkedAt == saved.providers.first?.checkedAt)
        #expect(provider.expiresAt == saved.providers.first?.expiresAt)
        #expect(provider.detail(at: UsageLimitTestFixtures.now) == "Some limits unavailable")
        #expect(provider.visibleWindows(period: "both", limit: 2, at: UsageLimitTestFixtures.now.addingTimeInterval(15 * 60)).isEmpty)

        var current = PlatformSubscriptionUsageSnapshot.make([.init(environmentID: "a", label: "A", providers: [
            try UsageLimitTestFixtures.provider(used: 10),
        ])])
        current.scopeID = scope
        #expect(PlatformSubscriptionUsageSnapshot.retainingPendingSnapshot(current, previous: saved, isPending: false) == current)
    }

    @Test
    func changedUserEnabledEnvironmentSetOrAddressCannotReuseSavedQuotas() throws {
        let environment = FeatureEnvironment(id: "a", name: "A", endpoint: "https://a.example.com")
        let scope = PlatformSubscriptionUsageObservationKey(isActive: true, environments: [environment], accountID: "user-a").scopeID
        var saved = PlatformSubscriptionUsageSnapshot.make([.init(environmentID: "a", label: "A", providers: [try UsageLimitTestFixtures.provider()])])
        saved.scopeID = scope
        let changedScopes = [
            PlatformSubscriptionUsageObservationKey(isActive: true, environments: [], accountID: "user-a"),
            PlatformSubscriptionUsageObservationKey(isActive: true, environments: [environment], accountID: "user-b"),
            PlatformSubscriptionUsageObservationKey(isActive: true, environments: [environment], accountID: nil),
            PlatformSubscriptionUsageObservationKey(isActive: true, environments: [.init(id: "a", name: "A", endpoint: "https://b.example.com")], accountID: "user-a"),
        ]
        for key in changedScopes {
            var pending = T3SubscriptionUsageSnapshot.empty
            pending.scopeID = key.scopeID
            let result = PlatformSubscriptionUsageSnapshot.retainingPendingSnapshot(pending, previous: saved, isPending: true)
            #expect(result.providers.allSatisfy(\.windows.isEmpty))
        }
        let encoded = try #require(String(data: JSONEncoder().encode(saved), encoding: .utf8))
        #expect(!encoded.contains("user-a"))
        #expect(!encoded.contains("a.example.com"))
    }

    @Test
    func changingTheSelectedEnvironmentDoesNotRestartWidgetSubscriptions() {
        var environment = FeatureEnvironment(id: "a", name: "A", endpoint: "https://a.example.com")
        let previous = PlatformSubscriptionUsageObservationKey(isActive: true, environments: [environment])
        environment.isActive = true
        environment.connectionDetail = "A thread became active"
        #expect(PlatformSubscriptionUsageObservationKey(isActive: true, environments: [environment]) == previous)
        environment.endpoint = "https://b.example.com"
        #expect(PlatformSubscriptionUsageObservationKey(isActive: true, environments: [environment]) != previous)
    }

    @Test
    func publishesOnePooledQuotaWithoutAccountOrEnvironmentIdentity() throws {
        let environments = [
            FeatureEnvironmentUsageLimits(environmentID: "private-server", label: "Private machine", providers: [
                try UsageLimitTestFixtures.provider(email: "private@example.com", used: 80),
            ]),
            .init(environmentID: "other-server", label: "Other machine", providers: [
                try UsageLimitTestFixtures.provider(email: "private@example.com", used: 80),
                try UsageLimitTestFixtures.provider(id: "second", email: "second@example.com", used: 20),
            ]),
        ]
        let snapshot = PlatformSubscriptionUsageSnapshot.make(environments)
        let provider = try #require(snapshot.providers.first)
        #expect(provider.accountCount == 2)
        #expect(provider.windows.first?.remaining == 50)
        #expect(provider.detail(at: UsageLimitTestFixtures.now) == "2 accounts · pooled")
        let data = try JSONEncoder().encode(snapshot)
        let text = try #require(String(data: data, encoding: .utf8))
        #expect(!text.contains("example.com"))
        #expect(!text.contains("private-server"))
        #expect(!text.contains("Private machine"))
        #expect(try JSONDecoder().decode(T3SubscriptionUsageSnapshot.self, from: data) == snapshot)
    }

    @Test
    func timelineExpiresAtOldestCheckOrNextResetWithoutInventingFreshQuota() throws {
        let now = UsageLimitTestFixtures.now
        let limits = UsageLimitTestFixtures.limits(windows: [
            .init(id: "primary", kind: .session, label: "Session", usedPercent: 80, resetsAt: "2026-09-13T12:05:00Z"),
        ])
        let snapshot = PlatformSubscriptionUsageSnapshot.make([.init(environmentID: "a", label: "A", providers: [
            try UsageLimitTestFixtures.provider(limits: limits),
        ])])
        let provider = try #require(snapshot.providers.first)
        #expect(provider.expiresAt == now.addingTimeInterval(5 * 60))
        #expect(snapshot.timelineDates(from: now) == [now, now.addingTimeInterval(5 * 60)])
        #expect(provider.visibleWindows(period: "both", limit: 2, at: now).count == 1)
        #expect(provider.visibleWindows(period: "both", limit: 2, at: now.addingTimeInterval(5 * 60)).isEmpty)
        #expect(provider.detail(at: now.addingTimeInterval(5 * 60)) == "Open T3 to refresh")
        #expect(provider.windows.first?.remaining == 20)
        #expect(snapshot.timelineDates(from: now.addingTimeInterval(20 * 60)) == [now.addingTimeInterval(20 * 60)])
    }

    @Test
    func freshAccountCannotHideAnOlderAccountsExpiredSnapshot() throws {
        let snapshot = PlatformSubscriptionUsageSnapshot.make([.init(environmentID: "a", label: "A", providers: [
            try UsageLimitTestFixtures.provider(id: "old", email: "old@example.com", limits: UsageLimitTestFixtures.limits(checkedAt: "2026-09-13T11:44:00Z")),
            try UsageLimitTestFixtures.provider(id: "fresh", email: "fresh@example.com"),
        ])])
        let provider = try #require(snapshot.providers.first)
        #expect(provider.expiresAt == UsageLimitTestFixtures.now.addingTimeInterval(-60))
        #expect(provider.visibleWindows(period: "both", limit: 2, at: UsageLimitTestFixtures.now).isEmpty)
    }

    @Test
    func missingAndInvalidChecksNeverShowPercentages() throws {
        let empty = PlatformSubscriptionUsageSnapshot.make([])
        #expect(empty.providers.map(\.name) == ["Codex", "Claude"])
        #expect(empty.checkedAt == nil)
        #expect(empty.providers.allSatisfy { !$0.isFresh(at: UsageLimitTestFixtures.now) })
        let invalid = PlatformSubscriptionUsageSnapshot.make([.init(environmentID: "a", label: "A", providers: [
            try UsageLimitTestFixtures.provider(limits: UsageLimitTestFixtures.limits(checkedAt: "invalid")),
        ])])
        #expect(invalid.providers.first?.expiresAt == nil)
        #expect(invalid.providers.first?.detail(at: UsageLimitTestFixtures.now) == "Open T3 to refresh")
    }

    @Test
    func pendingAndFailedEnvironmentsMarkAnOtherwiseFreshPoolAsPartial() throws {
        let current = FeatureEnvironmentUsageLimits(environmentID: "a", label: "A", providers: [try UsageLimitTestFixtures.provider()])
        for other in [
            FeatureEnvironmentUsageLimits(environmentID: "pending", label: "Pending", isPending: true),
            FeatureEnvironmentUsageLimits(environmentID: "failed", label: "Failed", isConnected: false, errorMessage: "Offline"),
        ] {
            let snapshot = PlatformSubscriptionUsageSnapshot.make([current, other])
            let provider = try #require(snapshot.providers.first)
            #expect(provider.hasPartialData)
            #expect(provider.detail(at: UsageLimitTestFixtures.now) == "Some limits unavailable")
            #expect(provider.windows.first?.remaining == 80)
        }
    }

    @Test
    func storageBudgetRetainsSessionAndWeeklyAndSelectionsStayIndependent() throws {
        let windows: [ServerProviderUsageWindow] = (0..<8).map {
            .init(id: "other-\($0)", kind: .other, label: "Other \($0)", usedPercent: Double(90 - $0))
        } + [
            .init(id: "session", kind: .session, label: "Session", usedPercent: 10),
            .init(id: "weekly", kind: .weekly, label: "Weekly", usedPercent: 20),
        ]
        let snapshot = PlatformSubscriptionUsageSnapshot.make([.init(environmentID: "a", label: "A", providers: [
            try UsageLimitTestFixtures.provider(limits: UsageLimitTestFixtures.limits(windows: windows)),
        ])])
        let provider = try #require(snapshot.providers.first)
        #expect(provider.windows.count == 6)
        #expect(provider.totalWindows == 10)
        #expect(provider.visibleWindows(period: "both", limit: 2, at: UsageLimitTestFixtures.now).map(\.kind) == ["session", "weekly"])
        #expect(provider.visibleWindows(period: "session", limit: 2, at: UsageLimitTestFixtures.now).map(\.kind) == ["session"])
        #expect(provider.visibleWindows(period: "weekly", limit: 2, at: UsageLimitTestFixtures.now).map(\.kind) == ["weekly"])
        #expect(provider.visibleWindows(period: "both", limit: 2, at: UsageLimitTestFixtures.now, tightestOnly: true).first?.remaining == 10)
        #expect(snapshot.providers.last?.windows.isEmpty == true)
    }

    @Test
    func sameProviderWithDifferentWindowKindsDoesNotPoolMonthlyIntoSession() throws {
        let snapshot = PlatformSubscriptionUsageSnapshot.make([.init(environmentID: "a", label: "A", providers: [
            try UsageLimitTestFixtures.provider(id: "paid", limits: UsageLimitTestFixtures.limits(used: 80)),
            try UsageLimitTestFixtures.provider(id: "free", limits: UsageLimitTestFixtures.limits(windows: [
                .init(id: "primary", kind: .monthly, label: "Monthly", usedPercent: 0),
            ])),
        ])])
        let provider = try #require(snapshot.providers.first)
        #expect(provider.windows.count == 2)
        #expect(provider.windows.first(where: { $0.kind == "session" })?.remaining == 20)
        #expect(provider.windows.first(where: { $0.kind == "monthly" })?.remaining == 100)
    }
}
