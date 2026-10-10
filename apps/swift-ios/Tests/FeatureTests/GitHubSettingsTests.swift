import Foundation
import Testing
@testable import T3Code

@Suite("GitHub host settings")
struct GitHubSettingsTests {
    @Test func hostChangesPreserveOtherHostsAndNeverResendTokens() throws {
        let current = ServerGitHubSettings(hosts: [
            "github.com": .init(account: "theo"),
            "git.example.com": .init(account: "work", enabled: false),
        ], tokens: ["github.com": "<redacted>"])
        let cleared = try FeatureGitHubSettingsChange.host(" GitHub.COM ", .account(nil)).patch(current: current)
        #expect(cleared["github"]?["hosts"]?["github.com"] == nil)
        #expect(cleared["github"]?["hosts"]?["git.example.com"] == .object([
            "account": .string("work"), "enabled": .bool(false),
        ]))
        #expect(cleared["github"]?["tokens"] == nil)
        let disabled = try FeatureGitHubSettingsChange.host("github.com", .enabled(false)).patch(current: current)
        #expect(disabled["github"]?["hosts"]?["github.com"] == .object([
            "account": .string("theo"), "enabled": .bool(false),
        ]))
        let enabled = try FeatureGitHubSettingsChange.host("github.com", .enabled(true)).patch(
            current: .init(hosts: ["github.com": .init(enabled: false)])
        )
        #expect(enabled == .object(["github": .object(["hosts": .object([:])])]))
        #expect(current.tokens["github.com"] == "<redacted>")
    }

    @Test func tokenPatchesTouchOnlyOneHostAndEmptyStringRemoves() throws {
        let current = ServerGitHubSettings(tokens: ["other.example": "<redacted>"])
        #expect(try FeatureGitHubSettingsChange.token(host: " GitHub.COM ", token: " test-token ").patch(current: current)
            == .object(["github": .object(["tokens": .object(["github.com": .string("test-token")])])]))
        #expect(try FeatureGitHubSettingsChange.token(host: "github.com", token: "").patch(current: current)
            == .object(["github": .object(["tokens": .object(["github.com": .string("")])])]))
    }

    @Test func configuredAndTokenOnlyHostsRemainVisibleWithoutCLI() {
        let groups = GitHubSettingsHosts.groups(settings: .init(
            hosts: ["work.example": .init(enabled: false)], tokens: ["tokens.example": "<redacted>"]
        ), auth: nil)
        #expect(groups.map(\.host) == ["github.com", "tokens.example", "work.example"])
        #expect(groups.first { $0.host == "tokens.example" }?.hasSavedToken == true)
        #expect(groups.first { $0.host == "work.example" }?.settings.enabled == false)
    }

    @Test func environmentTokensAreSeparateFromSelectableAndBrokenCLIAccounts() throws {
        let auth = SourceControlProviderAuth(status: .authenticated, accounts: [
            .init(host: "GitHub.COM", account: "env", active: true, authenticated: true, environmentVariable: "GH_TOKEN"),
            .init(host: "github.com", account: "active", active: true, authenticated: true),
            .init(host: "github.com", account: "other", active: false, authenticated: true),
            .init(host: "github.com", account: "expired", active: false, authenticated: false, error: "Expired"),
        ])
        let host = try #require(GitHubSettingsHosts.groups(settings: .init(), auth: auth).first)
        #expect(host.activeAccount == "active")
        #expect(host.selectableAccounts == ["active", "other"])
        #expect(host.brokenAccounts.map(\.account) == ["expired"])
        #expect(host.environmentVariable == "GH_TOKEN")
    }

    @Test func olderDiscoveryKeepsItsSingleAccount() throws {
        let auth = SourceControlProviderAuth(status: .authenticated, account: "theo", host: "github.com")
        let host = try #require(GitHubSettingsHosts.groups(settings: .init(), auth: auth).first)
        #expect(host.selectableAccounts == ["theo"])
        #expect(host.activeAccount == "theo")
    }
}
