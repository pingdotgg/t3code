import Foundation
import XCTest
@testable import T3Code

final class UsageLimitsContractTests: XCTestCase {
    func testUsageLimitsDecodeFractionalPercentWithoutOptionalFields() throws {
        let data = Data(
            #"""
            {
              "checkedAt": "2026-09-05T12:00:00.000Z",
              "windows": [{
                "id": "primary",
                "kind": "session",
                "label": "Session",
                "usedPercent": 12.5
              }]
            }
            """#.utf8
        )

        let limits = try JSONDecoder.t3.decode(ServerProviderUsageLimits.self, from: data)

        XCTAssertEqual(limits, ServerProviderUsageLimits(
            checkedAt: "2026-09-05T12:00:00.000Z",
            windows: [ServerProviderUsageWindow(
                id: "primary", kind: .session, label: "Session", usedPercent: 12.5
            )]
        ))
    }

    func testUsageLimitsSkipUnknownAndMalformedWindows() throws {
        let data = Data(
            #"""
            {
              "checkedAt": "2026-09-05T12:00:00.000Z",
              "windows": [
                {"id":"primary","kind":"session","label":"Session","usedPercent":0},
                {"id":"future","kind":"yearly","label":"Yearly","usedPercent":10},
                null,
                42,
                {"id":"bad-percent","kind":"weekly","label":"Weekly","usedPercent":"unknown"},
                {"kind":"weekly","label":"Missing ID","usedPercent":10},
                {
                  "id": "weekly",
                  "kind": "weekly",
                  "label": "Weekly",
                  "usedPercent": 100,
                  "resetsAt": "2026-09-12T12:00:00.000Z",
                  "windowDurationMins": 10080
                }
              ],
              "resetCredits": {"availableCount":2},
              "unavailable": {"reason":"probeFailed","message":"Provider did not respond."}
            }
            """#.utf8
        )

        let limits = try JSONDecoder.t3.decode(ServerProviderUsageLimits.self, from: data)

        XCTAssertEqual(limits.windows.map(\.id), ["primary", "weekly"])
        XCTAssertEqual(limits.windows.last, ServerProviderUsageWindow(
            id: "weekly",
            kind: .weekly,
            label: "Weekly",
            usedPercent: 100,
            resetsAt: "2026-09-12T12:00:00.000Z",
            windowDurationMins: 10080
        ))
        XCTAssertEqual(limits.resetCredits, ServerProviderResetCredits(availableCount: 2))
        XCTAssertEqual(limits.unavailable, ServerProviderUsageLimits.Unavailable(
            reason: .probeFailed, message: "Provider did not respond."
        ))
    }

    func testResetCreditsAndUnavailableDecodeWithoutOptionalFields() throws {
        let data = Data(
            #"""
            {
              "checkedAt": "2026-09-05T12:00:00.000Z",
              "windows": [],
              "resetCredits": {"availableCount":0},
              "unavailable": {"reason":"unsupported"}
            }
            """#.utf8
        )

        let limits = try JSONDecoder.t3.decode(ServerProviderUsageLimits.self, from: data)

        XCTAssertEqual(limits.resetCredits, ServerProviderResetCredits(availableCount: 0))
        XCTAssertEqual(limits.unavailable, ServerProviderUsageLimits.Unavailable(reason: .unsupported))
    }

    func testUsageLimitsKeepWindowsAndCreditsWithUnknownUnavailableReason() throws {
        let data = Data(
            #"""
            {
              "checkedAt": "2026-09-05T12:00:00.000Z",
              "windows": [{
                "id": "primary",
                "kind": "session",
                "label": "Session",
                "usedPercent": 12.5
              }],
              "resetCredits": {"availableCount":2},
              "unavailable": {"reason":"futureReason","message":"A new provider notice."}
            }
            """#.utf8
        )

        let limits = try JSONDecoder.t3.decode(ServerProviderUsageLimits.self, from: data)

        XCTAssertEqual(limits, ServerProviderUsageLimits(
            checkedAt: "2026-09-05T12:00:00.000Z",
            windows: [ServerProviderUsageWindow(
                id: "primary", kind: .session, label: "Session", usedPercent: 12.5
            )],
            resetCredits: ServerProviderResetCredits(availableCount: 2)
        ))
    }

    func testUsageLimitSourceSkipsMalformedAccounts() throws {
        let data = Data(
            #"""
            {
              "id": "source-1",
              "kind": "cliproxy",
              "label": "CLI Proxy",
              "checkedAt": "2026-09-05T12:00:00.000Z",
              "accounts": [
                {
                  "id": "codex-account",
                  "driver": "codex",
                  "usageLimits": {"checkedAt":"2026-09-05T12:00:00.000Z","windows":[]}
                },
                null,
                42,
                {"id":"missing-limits","driver":"claude"},
                {"id":"bad-limits","driver":"claude","usageLimits":{"windows":[]}},
                {
                  "id": "future-account",
                  "driver": "future-provider",
                  "usageLimits": {"checkedAt":"2026-09-05T12:00:00.000Z","windows":[]}
                }
              ]
            }
            """#.utf8
        )

        let source = try JSONDecoder.t3.decode(UsageLimitSourceSnapshot.self, from: data)

        XCTAssertEqual(source.kind, .cliproxy)
        XCTAssertEqual(source.accounts.map(\.id), ["codex-account", "future-account"])
        XCTAssertEqual(source.accounts.last?.driver, "future-provider")
        XCTAssertNil(source.accounts.first?.email)
        XCTAssertNil(source.accounts.first?.plan)
        XCTAssertNil(source.error)
    }

    func testUsageLimitSourceDecodesKnownFieldsAndIgnoresNewFields() throws {
        let data = Data(
            #"""
            {
              "id": "source-1",
              "kind": "cliproxy",
              "label": "CLI Proxy",
              "checkedAt": "2026-09-05T12:00:00.000Z",
              "futureSourceField": {"enabled":true},
              "accounts": [{
                "id": "codex-account",
                "driver": "codex",
                "email": "account@example.com",
                "plan": "ChatGPT Pro",
                "futureAccountField": true,
                "usageLimits": {
                  "checkedAt": "2026-09-05T11:59:00.000Z",
                  "futureLimitsField": "ignored",
                  "windows": [
                    {
                      "id": "monthly",
                      "kind": "monthly",
                      "label": "Monthly",
                      "usedPercent": 31.25,
                      "resetsAt": "2026-10-05T12:00:00.000Z",
                      "windowDurationMins": 43200,
                      "futureWindowField": 1
                    },
                    {"id":"other","kind":"other","label":"Other","usedPercent":0}
                  ],
                  "resetCredits": {
                    "availableCount": 2,
                    "nextExpiresAt": "2026-09-06T12:00:00.000Z",
                    "futureCreditField": []
                  },
                  "unavailable": {
                    "reason": "probeFailed",
                    "message": "Account refresh failed.",
                    "futureUnavailableField": null
                  }
                }
              }],
              "error": "Some accounts could not be refreshed."
            }
            """#.utf8
        )

        let source = try JSONDecoder.t3.decode(UsageLimitSourceSnapshot.self, from: data)
        let expected = UsageLimitSourceSnapshot(
            id: "source-1",
            label: "CLI Proxy",
            checkedAt: "2026-09-05T12:00:00.000Z",
            accounts: [UsageLimitSourceAccount(
                id: "codex-account",
                driver: "codex",
                email: "account@example.com",
                plan: "ChatGPT Pro",
                usageLimits: ServerProviderUsageLimits(
                    checkedAt: "2026-09-05T11:59:00.000Z",
                    windows: [
                        ServerProviderUsageWindow(
                            id: "monthly",
                            kind: .monthly,
                            label: "Monthly",
                            usedPercent: 31.25,
                            resetsAt: "2026-10-05T12:00:00.000Z",
                            windowDurationMins: 43200
                        ),
                        ServerProviderUsageWindow(
                            id: "other", kind: .other, label: "Other", usedPercent: 0
                        ),
                    ],
                    resetCredits: ServerProviderResetCredits(
                        availableCount: 2, nextExpiresAt: "2026-09-06T12:00:00.000Z"
                    ),
                    unavailable: .init(reason: .probeFailed, message: "Account refresh failed.")
                )
            )],
            error: "Some accounts could not be refreshed."
        )

        XCTAssertEqual(source, expected)
        XCTAssertEqual(
            try JSONDecoder.t3.decode(UsageLimitSourceSnapshot.self, from: JSONEncoder.t3.encode(source)),
            expected
        )
    }

    func testUsageLimitSourceRejectsUnknownKind() {
        let data = Data(
            #"""
            {
              "id": "source-1",
              "kind": "future-source",
              "label": "New source",
              "checkedAt": "2026-09-05T12:00:00.000Z",
              "accounts": []
            }
            """#.utf8
        )

        XCTAssertThrowsError(try JSONDecoder.t3.decode(UsageLimitSourceSnapshot.self, from: data))
    }

    func testResetCreditOutcomesDecodeServerValues() throws {
        let outcomes: [(String, ProviderConsumeResetCreditOutcome)] = [
            ("reset", .reset),
            ("nothingToReset", .nothingToReset),
            ("noCredit", .noCredit),
            ("alreadyRedeemed", .alreadyRedeemed),
        ]

        for (wireValue, outcome) in outcomes {
            let data = Data(#"{"outcome":"\#(wireValue)","futureField":true}"#.utf8)
            let result = try JSONDecoder.t3.decode(ProviderConsumeResetCreditResult.self, from: data)
            XCTAssertEqual(result, ProviderConsumeResetCreditResult(outcome: outcome))
        }
    }

    func testResetCreditOutcomeRejectsUnknownValue() {
        let data = Data(#"{"outcome":"pending"}"#.utf8)

        XCTAssertThrowsError(try JSONDecoder.t3.decode(ProviderConsumeResetCreditResult.self, from: data))
    }
}
