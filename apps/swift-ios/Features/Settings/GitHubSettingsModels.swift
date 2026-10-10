import Foundation

public enum FeatureGitHubHostChange: Sendable, Equatable {
    case enabled(Bool)
    case account(String?)
}

/// Apply host changes to fresh settings. The server replaces hosts, but merges tokens.
public enum FeatureGitHubSettingsChange: Sendable, Equatable {
    case host(String, FeatureGitHubHostChange)
    case token(host: String, token: String)

    public func patch(current: ServerGitHubSettings) throws -> JSONValue {
        let rawHost: String
        switch self {
        case let .host(host, _), let .token(host, _): rawHost = host
        }
        let host = GitHubSettingsHosts.normalize(rawHost)
        guard !host.isEmpty else { throw RPCError.remote("Enter a GitHub host.") }
        let github: JSONValue
        switch self {
        case let .host(_, change):
            var hosts = current.hosts
            var settings = hosts[host] ?? ServerGitHubHostSettings()
            switch change {
            case let .enabled(enabled): settings.enabled = enabled
            case let .account(account):
                let trimmed = account?.trimmingCharacters(in: .whitespacesAndNewlines)
                settings.account = trimmed?.isEmpty == false ? trimmed : nil
            }
            hosts[host] = settings.enabled && settings.account == nil ? nil : settings
            github = .object(["hosts": .object(hosts.mapValues { value in
                var fields: [String: JSONValue] = ["enabled": .bool(value.enabled)]
                if let account = value.account { fields["account"] = .string(account) }
                return .object(fields)
            })])
        case let .token(_, token):
            github = .object(["tokens": .object([
                host: .string(token.trimmingCharacters(in: .whitespacesAndNewlines)),
            ])])
        }
        return .object(["github": github])
    }
}

struct GitHubSettingsHost: Identifiable, Equatable {
    let host: String
    let settings: ServerGitHubHostSettings
    let hasSavedToken: Bool
    let activeAccount: String?
    let selectableAccounts: [String]
    let brokenAccounts: [SourceControlProviderAccount]
    let environmentVariable: String?
    var id: String { host }
}

enum GitHubSettingsHosts {
    static func normalize(_ host: String) -> String {
        host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func groups(
        settings: ServerGitHubSettings,
        auth: SourceControlProviderAuth?
    ) -> [GitHubSettingsHost] {
        var accounts = auth?.accounts ?? []
        // Older discovery responses only contain a single CLI account.
        if auth?.accounts == nil, let account = auth?.account, let host = auth?.host {
            accounts.append(.init(
                host: host, account: account, active: true,
                authenticated: auth?.status == .authenticated,
                error: auth?.status == .authenticated ? nil : auth?.detail
            ))
        }
        let hosts = Set(["github.com"] + Array(settings.hosts.keys) + Array(settings.tokens.keys)
            + accounts.map(\.host)).map(normalize).filter { !$0.isEmpty }
        return Set(hosts).sorted().map { host in
            let entries = accounts.filter { normalize($0.host) == host }
            let stored = entries.filter { $0.environmentVariable == nil }
            let usable = stored.filter(\.authenticated)
            return GitHubSettingsHost(
                host: host,
                settings: settings.hosts[host] ?? .init(),
                hasSavedToken: settings.tokens[host]?.isEmpty == false,
                activeAccount: usable.first(where: \.active)?.account ?? usable.first?.account,
                selectableAccounts: Array(Set(usable.map(\.account))).sorted(),
                brokenAccounts: stored.filter { !$0.authenticated },
                environmentVariable: entries.compactMap(\.environmentVariable).first
            )
        }
    }
}
