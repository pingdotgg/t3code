import Foundation
import Testing
@testable import T3Code

@Suite("GitHub current settings contract")
struct GitHubCurrentSettingsContractTests {
    private let redacted = "••••••"

    @Test func currentEnvelopeDecodesRedactedTokensAndHostDefaults() throws {
        let settings = try JSONValue.object([
            "sourceControlHosts": .object([
                "github": .object([
                    "hosts": .object([
                        "github.com": .object(["account": .string("theo")]),
                        "work.example": .object(["enabled": .bool(false)]),
                    ]),
                    "tokens": .object(["tokens.example": .string(redacted)]),
                ]),
                "future-forge": .object(["custom": .array([.number(1)])]),
            ]),
        ]).decode(ServerSettingsSnapshot.self)
        let github = try #require(settings.github)
        #expect(github.hosts["github.com"] == .init(account: "theo"))
        #expect(github.hosts["work.example"] == .init(enabled: false))
        #expect(github.tokens == ["tokens.example": redacted])
        let host = try #require(GitHubSettingsHosts.groups(settings: github, auth: nil)
            .first { $0.host == "tokens.example" })
        #expect(host.hasSavedToken)
        let encoded = try JSONValue.encode(settings)
        #expect(encoded["github"] == nil)
        #expect(encoded["sourceControlHosts"]?["future-forge"] == .object([
            "custom": .array([.number(1)]),
        ]))
    }

    @Test func emptyHostRegistryAllowsFirstGitHubConfiguration() throws {
        let registries: [JSONValue] = [.object([:]), .object(["github": .object([:])])]
        for registry in registries {
            let settings = try JSONValue.object(["sourceControlHosts": registry])
                .decode(ServerSettingsSnapshot.self)
            #expect(settings.github == ServerGitHubSettings())
            #expect(!settings.unsupportedPreferenceKeys.contains("sourceControlHosts"))
        }
    }

    @Test func removedLegacyKeyDoesNotAdvertiseCurrentSettingsSupport() throws {
        let settings = try JSONValue.object([
            "github": .object(["tokens": .object(["github.com": .string(redacted)])]),
        ]).decode(ServerSettingsSnapshot.self)
        #expect(settings.github == nil)
        #expect(settings.unsupportedPreferenceKeys.contains("sourceControlHosts"))
    }

    @Test func malformedGitHubFieldsRefuseWritesAndKeepTheRawMaps() throws {
        let invalidFields: [JSONValue] = [
            .object(["tokens": .bool(false)]),
            .object(["tokens": .null]),
            .object(["tokens": .object(["work.example": .number(1)])]),
            .object([
                "hosts": .bool(false),
                "tokens": .object(["work.example": .string(redacted)]),
            ]),
            .object([
                "hosts": .null,
                "tokens": .object(["work.example": .string(redacted)]),
            ]),
        ]
        for fields in invalidFields {
            let registry = JSONValue.object(["github": fields])
            let settings = try JSONValue.object([
                "sourceControlHosts": registry,
                "newWorktreesStartFromOrigin": .bool(false),
            ]).decode(ServerSettingsSnapshot.self)
            #expect(settings.github == nil)
            #expect(!settings.newWorktreesStartFromOrigin)
            #expect(try JSONValue.encode(settings)["sourceControlHosts"] == registry)
        }
    }

    @Test func tokenReplacementKeepsOtherRedactedSecretsInTheWholeMap() throws {
        let current = ServerGitHubSettings(tokens: [
            "github.com": redacted, "work.example": redacted,
        ])
        let patch = try FeatureGitHubSettingsChange.token(host: " GitHub.COM ", token: " replacement ")
            .patch(current: current)
        #expect(patch == .object(["sourceControlHosts": .object(["github": .object([
            "tokens": .object([
                "github.com": .string("replacement"), "work.example": .string(redacted),
            ]),
        ])])]))
        #expect(current.tokens["github.com"] == redacted)
    }

    @Test func removingOneTokenKeepsTheOtherSecretMarkers() throws {
        let patch = try FeatureGitHubSettingsChange.token(host: "work.example", token: " \n ")
            .patch(current: .init(tokens: ["github.com": redacted, "work.example": redacted]))
        #expect(patch["sourceControlHosts"]?["github"]?["tokens"] == .object([
            "github.com": .string(redacted), "work.example": .string(""),
        ]))
    }

    @Test func clearingAnAccountReplacesHostsWithoutSendingAnyTokens() throws {
        let patch = try FeatureGitHubSettingsChange.host(" GitHub.COM ", .account(nil))
            .patch(current: .init(hosts: [
                "github.com": .init(account: "theo"),
                "work.example": .init(account: "work", enabled: false),
            ], tokens: ["github.com": redacted]))
        #expect(patch == .object(["sourceControlHosts": .object(["github": .object([
            "hosts": .object([
                "work.example": .object(["account": .string("work"), "enabled": .bool(false)]),
            ]),
        ])])]))
    }

    @Test func hostToggleKeepsTheAccountPinAndAccountChangeKeepsDisabledState() throws {
        let current = ServerGitHubSettings(hosts: ["work.example": .init(account: "work", enabled: false)])
        let enabled = try FeatureGitHubSettingsChange.host("work.example", .enabled(true)).patch(current: current)
        #expect(enabled["sourceControlHosts"]?["github"]?["hosts"]?["work.example"] == .object([
            "account": .string("work"), "enabled": .bool(true),
        ]))
        let account = try FeatureGitHubSettingsChange.host("work.example", .account(" personal ")).patch(current: current)
        #expect(account["sourceControlHosts"]?["github"]?["hosts"]?["work.example"] == .object([
            "account": .string("personal"), "enabled": .bool(false),
        ]))
    }

    @Test func sharedPreferencesNeverIncludeHostSettingsOrSecretMarkers() throws {
        let settings = try JSONValue.object([
            "sourceControlHosts": .object(["github": .object([
                "tokens": .object(["github.com": .string(redacted)]),
            ])]),
        ]).decode(ServerSettingsSnapshot.self)
        for supportsRestart in [false, true] {
            let patch = settings.sharedPatch(supportsRestartContinuation: supportsRestart)
            #expect(patch["github"] == nil)
            #expect(patch["sourceControlHosts"] == nil)
        }
    }
}
