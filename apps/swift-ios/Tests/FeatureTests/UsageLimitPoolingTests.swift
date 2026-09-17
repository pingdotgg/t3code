import Foundation
import Testing
@testable import T3Code

@Suite("Pooled subscription limits")
struct UsageLimitPoolingTests {
    @Test
    func sameAccountOnTwoComputersAndAHubUsesOneQuotaAndKeepsBothComputerNames() throws {
        let environments = [
            FeatureEnvironmentUsageLimits(environmentID: "a", label: "Laptop", providers: [try UsageLimitTestFixtures.provider(email: " USER@example.com ", used: 20)]),
            FeatureEnvironmentUsageLimits(environmentID: "b", label: "Desktop", providers: [try UsageLimitTestFixtures.provider(email: "user@EXAMPLE.com", used: 40)]),
            FeatureEnvironmentUsageLimits(environmentID: "c", label: "Server", sources: [UsageLimitTestFixtures.source(accounts: [
                .init(id: "hub-user", driver: "codex", email: "user@example.com", usageLimits: UsageLimitTestFixtures.limits(used: 80, checkedAt: "2026-09-13T12:01:00Z")),
            ])]),
        ]
        let accounts = UsageLimitPooling.accounts(environments)
        let account = try #require(accounts.first)
        #expect(accounts.count == 1)
        #expect(account.environments.map(\.id) == ["a", "b"])
        #expect(account.locationLabel == "Laptop, Desktop")
        #expect(account.sourceLabel == nil)
        #expect(account.limits.windows.first?.usedPercent == 80)
        #expect(UsageLimitPooling.pools(accounts, now: UsageLimitTestFixtures.now).first?.windows.first?.remainingPercent == 20)
    }

    @Test
    func freshestCreditBalanceAndHubRedemptionAreIndependent() throws {
        let nativeLimits = UsageLimitTestFixtures.limits(used: 10, checkedAt: "2026-09-13T12:02:00Z", credits: .init(availableCount: 2))
        let native = try UsageLimitTestFixtures.provider(email: "user@example.com", limits: nativeLimits)
        let hubLimits = UsageLimitTestFixtures.limits(used: 80, credits: .init(availableCount: 1, nextCreditId: "hub-credit"))
        let environments = [FeatureEnvironmentUsageLimits(environmentID: "native", label: "Laptop", providers: [native]),
                            FeatureEnvironmentUsageLimits(environmentID: "hub", label: "Hub", sources: [UsageLimitTestFixtures.source(accounts: [
                                .init(id: "hub-user", driver: "codex", email: "user@example.com", usageLimits: hubLimits),
                            ])])]
        let account = try #require(UsageLimitPooling.accounts(environments).first)
        #expect(account.limits.windows.first?.usedPercent == 10)
        #expect(account.limits.resetCredits?.availableCount == 2)
        #expect(account.redeem?.environmentID == "hub")
        #expect(account.redeem?.input == .source(sourceID: "hub", accountID: "hub-user", creditID: "hub-credit"))
    }

    @Test
    func failedCreditProbeDoesNotEraseOlderSuccessfulBalance() throws {
        let source = UsageLimitTestFixtures.source(accounts: [.init(
            id: "hub-user", driver: "codex", email: "user@example.com",
            usageLimits: UsageLimitTestFixtures.limits(used: 90, credits: .init(availableCount: 1, nextCreditId: "credit"))
        )])
        let native = try UsageLimitTestFixtures.provider(email: "user@example.com", limits: UsageLimitTestFixtures.limits(used: 20, checkedAt: "2026-09-13T12:03:00Z"))
        let account = try #require(UsageLimitPooling.accounts([
            .init(environmentID: "native", label: "Laptop", providers: [native], sources: [source]),
        ]).first)
        #expect(account.limits.resetCredits?.availableCount == 1)
        #expect(account.limits.windows.first?.usedPercent == 20)
    }

    @Test
    func hubBalanceWithoutACreditIDDoesNotFallBackToNativeRedemption() throws {
        let source = UsageLimitTestFixtures.source(accounts: [.init(
            id: "hub-user", driver: "codex", email: "user@example.com",
            usageLimits: UsageLimitTestFixtures.limits(used: 90, credits: .init(availableCount: 1))
        )])
        let native = try UsageLimitTestFixtures.provider(email: "user@example.com")
        let account = try #require(UsageLimitPooling.accounts([
            .init(environmentID: "native", label: "Laptop", providers: [native], sources: [source]),
        ]).first)
        #expect(account.limits.resetCredits?.availableCount == 1)
        #expect(account.redeem == nil)
    }

    @Test
    func failedHubAccountHasANoticeEvenWhenTheHubReadSucceeded() {
        let source = UsageLimitTestFixtures.source(accounts: [.init(
            id: "private@example.com", driver: "codex",
            usageLimits: .init(checkedAt: "2026-09-13T12:00:00Z", windows: [], unavailable: .init(reason: .probeFailed))
        )])
        let environments = [FeatureEnvironmentUsageLimits(environmentID: "hub", label: "Server", sources: [source])]
        #expect(UsageLimitPooling.accounts(environments).isEmpty)
        #expect(UsageLimitPooling.notices(environments) == ["Hub · Codex account 1: Could not read limits."])
    }

    @Test
    func anonymousNativeInstancesAndDifferentDriversStaySeparate() throws {
        let accounts = UsageLimitPooling.accounts([
            .init(environmentID: "a", label: "A", providers: [try UsageLimitTestFixtures.provider(), try UsageLimitTestFixtures.provider(id: "named", email: "same@example.com")]),
            .init(environmentID: "b", label: "B", providers: [try UsageLimitTestFixtures.provider()], sources: [UsageLimitTestFixtures.source(accounts: [
                .init(id: "claude", driver: "claudeAgent", email: "same@example.com", usageLimits: UsageLimitTestFixtures.limits()),
            ])]),
        ])
        #expect(accounts.count == 4)
        #expect(Set(accounts.map(\.id)).count == 4)
    }

    @Test
    func pooledRowsSeparateKindsKeepMissingColumnsAndUseSessionResetOrder() throws {
        let early = UsageLimitTestFixtures.limits(windows: [
            .init(id: "primary", kind: .session, label: "Session", usedPercent: 20, resetsAt: "2026-09-13T13:00:00Z", windowDurationMins: 120),
            .init(id: "weekly", kind: .weekly, label: "Weekly", usedPercent: 90),
        ])
        let late = UsageLimitTestFixtures.limits(windows: [
            .init(id: "primary", kind: .session, label: "Session", usedPercent: 80, resetsAt: "2026-09-13T14:00:00Z"),
        ])
        let monthly = UsageLimitTestFixtures.limits(windows: [
            .init(id: "primary", kind: .monthly, label: "Monthly", usedPercent: 10),
        ])
        let accounts = UsageLimitPooling.accounts([.init(environmentID: "a", label: "A", providers: [
            try UsageLimitTestFixtures.provider(id: "late", email: "late@example.com", limits: late),
            try UsageLimitTestFixtures.provider(id: "monthly", email: "monthly@example.com", limits: monthly),
            try UsageLimitTestFixtures.provider(id: "early", email: "early@example.com", limits: early),
        ])])
        let pool = try #require(UsageLimitPooling.pools(accounts, now: UsageLimitTestFixtures.now).first)
        #expect(pool.accounts.map(\.email) == ["early@example.com", "late@example.com", "monthly@example.com"])
        #expect(pool.windows.map(\.kind) == [.session, .weekly, .monthly])
        let session = try #require(pool.windows.first)
        #expect(session.remainingPercent == 50)
        #expect(session.pace == .under)
        #expect(session.columns.map { $0 != nil } == [true, true, false])
        #expect(session.resets.map(\.restoresPercent) == [10, 40])
        #expect(pool.windows[1].columns.map { $0 != nil } == [true, false, false])
        #expect(pool.windows[2].remainingPercent == 90)
    }

    @Test
    func failedAndPendingEnvironmentsStayVisibleWithoutInventingAccounts() throws {
        let failed = ServerProviderUsageLimits(checkedAt: "2026-09-13T12:00:00Z", windows: [], unavailable: .init(reason: .probeFailed))
        let unsupported = ServerProviderUsageLimits(checkedAt: "2026-09-13T12:00:00Z", windows: [], unavailable: .init(reason: .unsupported))
        let environments = [FeatureEnvironmentUsageLimits(environmentID: "a", label: "Laptop", providers: [
            try UsageLimitTestFixtures.provider(id: "failed", limits: failed),
            try UsageLimitTestFixtures.provider(id: "unsupported", limits: unsupported),
        ]), .init(environmentID: "b", label: "Desktop", isPending: true)]
        #expect(UsageLimitPooling.accounts(environments).isEmpty)
        let notices = UsageLimitPooling.notices(environments)
        #expect(notices.count == 2)
        #expect(notices.contains("Desktop: Waiting for limits."))
        #expect(notices.contains(where: { $0.contains("Could not read limits.") }))
    }
}

enum UsageLimitTestFixtures {
    static let now = Date(timeIntervalSince1970: 1_789_300_800) // 2026-09-13 12:00 UTC

    static func limits(
        used: Double = 20,
        checkedAt: String = "2026-09-13T12:00:00Z",
        credits: ServerProviderResetCredits? = nil,
        windows: [ServerProviderUsageWindow]? = nil
    ) -> ServerProviderUsageLimits {
        .init(checkedAt: checkedAt, windows: windows ?? [.init(id: "primary", kind: .session, label: "Session", usedPercent: used)], resetCredits: credits)
    }

    static func source(accounts: [UsageLimitSourceAccount]) -> UsageLimitSourceSnapshot {
        .init(id: "hub", label: "Hub", checkedAt: "2026-09-13T12:00:00Z", accounts: accounts)
    }

    static func provider(id: String = "codex", email: String? = nil, used: Double = 20, limits: ServerProviderUsageLimits? = nil) throws -> ServerProviderSnapshot {
        let value = JSONValue.object([
            "instanceId": .string(id), "driver": .string("codex"),
            "displayName": .string(id),
            "enabled": .bool(true), "installed": .bool(true), "status": .string("ready"),
            "auth": .object(["status": .string("authenticated"), "email": email.map(JSONValue.string) ?? .null]),
            "checkedAt": .string("2026-09-13T12:00:00Z"), "models": .array([]),
            "usageLimits": try JSONValue.encode(limits ?? Self.limits(used: used)),
        ])
        return try JSONDecoder.t3.decode(ServerProviderSnapshot.self, from: JSONEncoder.t3.encode(value))
    }
}
