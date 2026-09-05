import Foundation
import Testing
@testable import T3Code

@Suite("Subscription limits")
struct UsageLimitsPresentationTests {
    @Test
    func providersMustBeEnabledInstalledAndAvailable() throws {
        let providers = try [
            provider(id: "ready"),
            provider(id: "disabled", enabled: false),
            provider(id: "missing", installed: false),
            provider(id: "unavailable", available: false),
            provider(id: "unsupported", limits: nil),
        ]

        #expect(UsageLimitsPresentation.providersWithLimits(providers).map(\.instanceId) == ["ready"])
    }

    @Test
    func nativeAccountHidesOnlyTheMatchingHubAccountAcrossEnvironments() throws {
        let native = try provider(id: "codex", email: " ACCOUNT@example.com ")
        let source = UsageLimitSourceSnapshot(
            id: "shared-hub",
            label: "Hub",
            checkedAt: checkedAt,
            accounts: [
                account(id: "duplicate", email: "account@EXAMPLE.com"),
                account(id: "other-driver", driver: "claudeAgent", email: "account@example.com"),
                account(id: "unnamed", email: nil),
            ]
        )
        let groups = UsageLimitsPresentation.groups([
            .init(environmentID: "left", label: "Left", providers: [native], sources: [source]),
            .init(environmentID: "right", label: "Right", providers: [native], sources: [source]),
        ])

        #expect(groups.map(\.id) == ["left", "right"])
        for group in groups {
            #expect(group.providers.map(\.instanceId) == ["codex"])
            #expect(group.sources.first?.accounts.map(\.id) == ["other-driver", "unnamed"])
            #expect(group.sources.first?.hiddenAccountCount == 1)
        }
    }

    @Test
    func unusableNativeLimitsDoNotHideAUsableHubAccount() throws {
        let cases: [(limits: ServerProviderUsageLimits, isConnected: Bool)] = [
            (.init(checkedAt: checkedAt, windows: []), true),
            (.init(checkedAt: checkedAt, windows: [], unavailable: .init(reason: .unsupported)), true),
            (.init(checkedAt: checkedAt, windows: [], unavailable: .init(reason: .probeFailed)), true),
            (limits(), false),
        ]
        for testCase in cases {
            let native = try provider(email: "account@example.com", limits: testCase.limits)
            let groups = UsageLimitsPresentation.groups([
                .init(
                    environmentID: "native", label: "Native", providers: [native],
                    isConnected: testCase.isConnected
                ),
                .init(
                    environmentID: "hub", label: "Hub",
                    sources: [.init(
                        id: "hub", label: "Hub", checkedAt: checkedAt,
                        accounts: [account(id: "account", email: "account@example.com")]
                    )]
                ),
            ])

            #expect(groups.last?.sources.first?.accounts.map(\.id) == ["account"])
            #expect(groups.last?.sources.first?.hiddenAccountCount == 0)
        }
    }

    @Test
    func paceUsesFivePercentagePointTolerance() throws {
        let now = try #require(ISO8601DateFormatter().date(from: checkedAt))
        let cases: [(Double, UsageLimitPace)] = [
            (44, .under), (45, .on), (50, .on), (55, .on), (56, .ahead),
        ]
        for (percent, expected) in cases {
            let window = ServerProviderUsageWindow(
                id: "session", kind: .session, label: "Session", usedPercent: percent,
                resetsAt: "2026-09-05T15:00:00.000Z", windowDurationMins: 360
            )
            #expect(UsageLimitsMath.elapsedShare(window, now: now) == 0.5)
            #expect(UsageLimitsMath.pace(window, now: now) == expected)
            #expect(UsageLimitsMath.resetsIn(window, now: now) == "Resets in 3h 0m")
        }
    }

    @Test
    func reconnectKeepsBarsUntilThatEnvironmentAnswersAndThenClearsOldSources() throws {
        let previous = FeatureEnvironmentUsageLimits(
            environmentID: "environment", label: "Environment", providers: [try provider()],
            sources: [.init(id: "hub", label: "Hub", checkedAt: checkedAt, accounts: [])],
            isConnected: false, errorMessage: "Disconnected"
        )
        let pending = FeatureEnvironmentUsageLimits(
            environmentID: "environment", label: "Environment", isPending: true
        )
        let retained = UsageLimitsPresentation.retainingPendingRows([pending], previous: [previous])
        #expect(retained.first?.providers == previous.providers)
        #expect(retained.first?.sources == previous.sources)
        #expect(retained.first?.isPending == true)
        #expect(retained.first?.errorMessage == nil)

        let connected = FeatureEnvironmentUsageLimits(
            environmentID: "environment", label: "Environment", providers: [try provider()]
        )
        let current = UsageLimitsPresentation.retainingPendingRows([connected], previous: retained)
        #expect(current == [connected])
        #expect(current.first?.isConnected == true)
        #expect(current.first?.sources.isEmpty == true)
    }

    @Test
    func unknownWindowTimingHasNoPaceAndExpiredWindowsClamp() throws {
        let now = try #require(ISO8601DateFormatter().date(from: checkedAt))
        let unknown = ServerProviderUsageWindow(
            id: "unknown", kind: .other, label: "Other", usedPercent: 10
        )
        #expect(UsageLimitsMath.pace(unknown, now: now) == nil)
        #expect(UsageLimitsMath.elapsedShare(unknown, now: now) == nil)
        #expect(UsageLimitsMath.resetsIn(unknown, now: now) == nil)

        let expired = ServerProviderUsageWindow(
            id: "expired", kind: .session, label: "Session", usedPercent: 110,
            resetsAt: "2026-09-05T11:00:00Z", windowDurationMins: 300
        )
        #expect(UsageLimitsMath.usedPercent(expired) == 100)
        #expect(UsageLimitsMath.elapsedShare(expired, now: now) == 1)
        #expect(UsageLimitsMath.resetsIn(expired, now: now) == "Resets now")

        let invalid = ServerProviderUsageWindow(
            id: "invalid", kind: .session, label: "Session", usedPercent: -10,
            resetsAt: "invalid", windowDurationMins: 0
        )
        #expect(UsageLimitsMath.usedPercent(invalid) == 0)
        #expect(UsageLimitsMath.elapsedShare(invalid, now: now) == nil)
        #expect(UsageLimitsMath.resetsIn(invalid, now: now) == nil)
    }

    @Test
    func unsupportedAndFailedProbesHaveDifferentNotices() {
        #expect(UsageLimitsPresentation.limitsNotice(limits()) == nil)
        #expect(UsageLimitsPresentation.limitsNotice(.init(checkedAt: checkedAt, windows: []))
            == "No limits reported.")
        #expect(UsageLimitsPresentation.limitsNotice(.init(
            checkedAt: checkedAt, windows: [], unavailable: .init(reason: .unsupported)
        )) == "This account has no subscription limits.")
        #expect(UsageLimitsPresentation.limitsNotice(.init(
            checkedAt: checkedAt, windows: [], unavailable: .init(reason: .probeFailed)
        )) == "Could not read limits.")

        let previous = limits()
        let failed = ServerProviderUsageLimits(
            checkedAt: checkedAt, windows: previous.windows, unavailable: .init(reason: .probeFailed)
        )
        #expect(UsageLimitsPresentation.limitsNotice(failed) != nil)
        #expect(UsageLimitsPresentation.visibleWindows(failed) == previous.windows)
        #expect(UsageLimitsPresentation.visibleWindows(.init(
            checkedAt: checkedAt, windows: previous.windows, unavailable: .init(reason: .unsupported)
        )).isEmpty)
    }

    @Test
    func resetCreditActionBlocksRepeatSubmissionsAndKeepsOutcomes() {
        var state = UsageResetCreditState()
        let offline = state.begin(availableCount: 1, isConnected: false)
        let noCredit = state.begin(availableCount: 0, isConnected: true)
        #expect(!offline)
        #expect(!noCredit)
        #expect(!state.isPending)

        let began = state.begin(availableCount: 1, isConnected: true)
        let duplicate = state.begin(availableCount: 1, isConnected: true)
        #expect(began)
        #expect(!duplicate)
        #expect(state.isPending)

        state.fail(UsageCreditTestError.confirmationFailed)
        #expect(!state.isPending)
        #expect(state.statusMessage == "Reset applied, but the new limits could not be confirmed.")

        let outcomes: [(ProviderConsumeResetCreditOutcome, String)] = [
            (.reset, "Reset applied. Your current limits are cleared."),
            (.nothingToReset, "Nothing to reset right now."),
            (.noCredit, "No reset credit left."),
            (.alreadyRedeemed, "That credit was already redeemed."),
        ]
        for (outcome, message) in outcomes {
            let started = state.begin(availableCount: 1, isConnected: true)
            #expect(started)
            state.finish(outcome)
            #expect(!state.isPending)
            #expect(state.statusMessage == message)
        }
    }

    private var checkedAt: String { "2026-09-05T12:00:00Z" }

    private func limits() -> ServerProviderUsageLimits {
        .init(checkedAt: checkedAt, windows: [
            .init(id: "session", kind: .session, label: "Session", usedPercent: 25)
        ])
    }

    private func account(id: String, driver: String = "codex", email: String?) -> UsageLimitSourceAccount {
        .init(id: id, driver: driver, email: email, usageLimits: limits())
    }

    private func provider(
        id: String = "provider",
        email: String? = nil,
        enabled: Bool = true,
        installed: Bool = true,
        available: Bool = true,
        limits: ServerProviderUsageLimits? = .init(checkedAt: "2026-09-05T12:00:00Z", windows: [
            .init(id: "session", kind: .session, label: "Session", usedPercent: 25)
        ])
    ) throws -> ServerProviderSnapshot {
        let value = JSONValue.object([
            "instanceId": .string(id),
            "driver": .string("codex"),
            "enabled": .bool(enabled),
            "installed": .bool(installed),
            "status": .string("ready"),
            "auth": .object([
                "status": .string("authenticated"),
                "email": email.map(JSONValue.string) ?? .null,
            ]),
            "checkedAt": .string(checkedAt),
            "availability": .string(available ? "available" : "unavailable"),
            "models": .array([]),
            "usageLimits": try limits.map { try JSONValue.encode($0) } ?? .null,
        ])
        return try JSONDecoder.t3.decode(ServerProviderSnapshot.self, from: JSONEncoder.t3.encode(value))
    }
}

private enum UsageCreditTestError: LocalizedError {
    case confirmationFailed

    var errorDescription: String? {
        "Reset applied, but the new limits could not be confirmed."
    }
}
