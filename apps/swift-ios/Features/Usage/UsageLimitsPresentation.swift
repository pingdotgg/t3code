import Foundation

public struct FeatureEnvironmentUsageLimits: Identifiable, Equatable, Sendable {
    public let environmentID: String
    public let label: String
    public let providers: [ServerProviderSnapshot]
    public let sources: [UsageLimitSourceSnapshot]
    public let isConnected: Bool
    public let errorMessage: String?
    public let isPending: Bool

    public var id: String { environmentID }

    public init(
        environmentID: String,
        label: String,
        providers: [ServerProviderSnapshot] = [],
        sources: [UsageLimitSourceSnapshot] = [],
        isConnected: Bool = true,
        errorMessage: String? = nil,
        isPending: Bool = false
    ) {
        self.environmentID = environmentID
        self.label = label
        self.providers = providers
        self.sources = sources
        self.isConnected = isConnected
        self.errorMessage = errorMessage
        self.isPending = isPending
    }
}

struct UsageLimitsGroup: Identifiable, Equatable {
    let environment: FeatureEnvironmentUsageLimits
    let providers: [ServerProviderSnapshot]
    let sources: [UsageLimitSourceRows]

    var id: String { environment.environmentID }
    var hasLimits: Bool { !providers.isEmpty || !sources.isEmpty }
}

struct UsageLimitSourceRows: Identifiable, Equatable {
    let source: UsageLimitSourceSnapshot
    let accounts: [UsageLimitSourceAccount]
    let hiddenAccountCount: Int

    var id: String { source.id }
}

enum UsageLimitsPresentation {
    private struct AccountKey: Hashable {
        let driver: String
        let email: String
    }

    /// A restarted subscription keeps its last bars until that environment answers.
    static func retainingPendingRows(
        _ incoming: [FeatureEnvironmentUsageLimits],
        previous: [FeatureEnvironmentUsageLimits]
    ) -> [FeatureEnvironmentUsageLimits] {
        let previousByID = Dictionary(uniqueKeysWithValues: previous.map { ($0.environmentID, $0) })
        return incoming.map { environment in
            guard environment.isPending, environment.providers.isEmpty, environment.sources.isEmpty,
                  let prior = previousByID[environment.environmentID] else { return environment }
            return FeatureEnvironmentUsageLimits(
                environmentID: environment.environmentID,
                label: environment.label,
                providers: prior.providers,
                sources: prior.sources,
                isConnected: prior.isConnected,
                errorMessage: environment.errorMessage,
                isPending: true
            )
        }
    }

    /// Usable provider limits take precedence over the same account in a hub.
    /// Sources remain grouped by environment even when they use the same hub.
    static func groups(_ environments: [FeatureEnvironmentUsageLimits]) -> [UsageLimitsGroup] {
        var nativeAccounts: Set<AccountKey> = []
        for environment in environments where environment.isConnected {
            for provider in providersWithLimits(environment.providers) {
                guard let limits = provider.usageLimits,
                      !limits.windows.isEmpty,
                      limits.unavailable == nil,
                      let key = accountKey(driver: provider.driver, email: provider.auth.email) else {
                    continue
                }
                nativeAccounts.insert(key)
            }
        }

        return environments.map { environment in
            UsageLimitsGroup(
                environment: environment,
                providers: providersWithLimits(environment.providers),
                sources: environment.sources.map { source in
                    let accounts = source.accounts.filter { account in
                        guard let key = accountKey(driver: account.driver, email: account.email) else {
                            return true
                        }
                        return !nativeAccounts.contains(key)
                    }
                    return UsageLimitSourceRows(
                        source: source,
                        accounts: accounts,
                        hiddenAccountCount: source.accounts.count - accounts.count
                    )
                }
            )
        }
    }

    static func providersWithLimits(_ providers: [ServerProviderSnapshot]) -> [ServerProviderSnapshot] {
        providers.filter {
            $0.enabled && $0.installed && $0.availability != "unavailable" && $0.usageLimits != nil
        }
    }

    static func providerLabel(driver: String) -> String {
        switch driver {
        case "codex": "Codex"
        case "claudeAgent": "Claude"
        case "grok": "Grok"
        case "cursor": "Cursor"
        case "opencode": "OpenCode"
        case "antigravity": "Antigravity"
        default: driver
        }
    }

    static func limitsNotice(_ limits: ServerProviderUsageLimits) -> String? {
        if let unavailable = limits.unavailable {
            return unavailable.message ?? (unavailable.reason == .unsupported
                ? "This account has no subscription limits."
                : "Could not read limits.")
        }
        return limits.windows.isEmpty ? "No limits reported." : nil
    }

    static func visibleWindows(_ limits: ServerProviderUsageLimits) -> [ServerProviderUsageWindow] {
        limits.unavailable?.reason == .unsupported ? [] : limits.windows
    }

    private static func accountKey(driver: String, email: String?) -> AccountKey? {
        guard let normalized = email?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !normalized.isEmpty else { return nil }
        return AccountKey(driver: driver, email: normalized)
    }
}

enum UsageLimitPace: Equatable {
    case ahead
    case on
    case under

    var label: String {
        switch self {
        case .ahead: "Ahead of pace"
        case .on: "On pace"
        case .under: "Under pace"
        }
    }
}

enum UsageLimitsMath {
    static func usedPercent(_ window: ServerProviderUsageWindow) -> Double {
        window.usedPercent.isFinite ? min(100, max(0, window.usedPercent)) : 0
    }

    static func elapsedShare(_ window: ServerProviderUsageWindow, now: Date) -> Double? {
        guard let minutes = window.windowDurationMins,
              minutes > 0,
              let reset = window.resetsAt.flatMap(date) else { return nil }
        let duration = Double(minutes) * 60
        return min(1, max(0, (duration - reset.timeIntervalSince(now)) / duration))
    }

    static func pace(_ window: ServerProviderUsageWindow, now: Date) -> UsageLimitPace? {
        guard let elapsed = elapsedShare(window, now: now) else { return nil }
        let gap = usedPercent(window) - elapsed * 100
        if gap > 5 { return .ahead }
        if gap < -5 { return .under }
        return .on
    }

    static func resetsIn(_ window: ServerProviderUsageWindow, now: Date) -> String? {
        guard let reset = window.resetsAt.flatMap(date) else { return nil }
        let remaining = reset.timeIntervalSince(now)
        return remaining <= 0 ? "Resets now" : "Resets in \(duration(remaining))"
    }

    static func creditSummary(_ credits: ServerProviderResetCredits, now: Date) -> String {
        guard credits.availableCount > 0 else { return "No reset credits available." }
        let count = credits.availableCount
        var summary = "\(count) reset \(count == 1 ? "credit" : "credits") available."
        if let expiration = credits.nextExpiresAt.flatMap(date) {
            let remaining = expiration.timeIntervalSince(now)
            summary += remaining <= 0
                ? " Next expires now."
                : " Next expires in \(duration(remaining))."
        }
        return summary
    }

    static func duration(_ seconds: TimeInterval) -> String {
        guard seconds.isFinite else { return "0m" }
        let minutes = Int(max(0, seconds) / 60)
        let days = minutes / (24 * 60)
        let hours = minutes / 60 % 24
        if days > 0 { return "\(days)d \(hours)h" }
        if hours > 0 { return "\(hours)h \(minutes % 60)m" }
        return "\(minutes)m"
    }

    private static func date(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

struct UsageResetCreditTarget: Hashable {
    let environmentID: String
    let instanceID: String
}

/// A confirmed request can spend one credit. Keep failures visible and never retry it automatically.
struct UsageResetCreditState: Equatable {
    private(set) var isPending = false
    private(set) var statusMessage: String?

    mutating func begin(availableCount: Int, isConnected: Bool) -> Bool {
        guard !isPending, availableCount > 0, isConnected else { return false }
        isPending = true
        statusMessage = nil
        return true
    }

    mutating func finish(_ outcome: ProviderConsumeResetCreditOutcome) {
        isPending = false
        statusMessage = switch outcome {
        case .reset: "Reset applied. Your current limits are cleared."
        case .nothingToReset: "Nothing to reset right now."
        case .noCredit: "No reset credit left."
        case .alreadyRedeemed: "That credit was already redeemed."
        }
    }

    mutating func fail(_ error: any Error) {
        isPending = false
        statusMessage = error.localizedDescription
    }
}
