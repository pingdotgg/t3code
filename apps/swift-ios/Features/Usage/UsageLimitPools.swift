import Foundation

struct UsageLimitAccount: Identifiable, Equatable, Sendable {
    struct Environment: Equatable, Sendable {
        let id: String
        let label: String
    }

    struct Redemption: Equatable, Sendable {
        let environmentID: String
        let input: ProviderConsumeResetCreditInput
        let isConnected: Bool

        var target: UsageResetCreditTarget {
            let account: UsageResetCreditTarget.Account = switch input {
            case let .provider(instanceID): .provider(instanceID)
            case let .source(sourceID, accountID, _): .source(sourceID: sourceID, accountID: accountID)
            }
            return UsageResetCreditTarget(environmentID: environmentID, account: account)
        }
    }

    let id: String
    let driver: String
    var displayName: String?
    let email: String?
    var plan: String?
    var environments: [Environment]
    var sourceLabel: String?
    var redeem: Redemption?
    var limits: ServerProviderUsageLimits

    var label: String { displayName ?? email ?? UsageLimitsPresentation.providerLabel(driver: driver) }
    var locationLabel: String { environments.isEmpty ? sourceLabel ?? "" : environments.map(\.label).joined(separator: ", ") }
}

struct UsageLimitPool: Identifiable, Equatable, Sendable {
    let driver: String
    let accounts: [UsageLimitAccount]
    let windows: [UsageLimitPoolWindow]
    var id: String { driver }
}

struct UsageLimitPoolWindow: Identifiable, Equatable, Sendable {
    struct Member: Equatable, Sendable {
        let account: UsageLimitAccount
        let window: ServerProviderUsageWindow
    }

    struct Reset: Equatable, Sendable {
        let accountID: String
        let at: Date
        let restoresPercent: Int
    }

    let windowID: String
    let kind: ServerProviderUsageWindow.Kind
    let label: String
    let members: [Member]
    /// Keep account positions fixed when a subscription lacks this window.
    let columns: [ServerProviderUsageWindow?]
    let remainingPercent: Int
    let pace: UsageLimitPace?
    let resets: [Reset]
    var id: String { "\(kind.rawValue):\(windowID)" }
}

/// Mirrors packages/shared/usageLimits. Email identifies a subscription across
/// computers and hubs. Anonymous native instances keep their environment identity.
enum UsageLimitPooling {
    static func accounts(_ environments: [FeatureEnvironmentUsageLimits]) -> [UsageLimitAccount] {
        var order: [String] = []
        var collected: [String: UsageLimitAccount] = [:]
        var credits: [String: UsageLimitAccount] = [:]
        var hubRedeems: [String: UsageLimitAccount] = [:]

        func merge(_ next: UsageLimitAccount) {
            let key = next.id
            if let redeem = next.redeem, case .source = redeem.input,
               hubRedeems[key].map({ checkedAt(next) > checkedAt($0) }) ?? true {
                hubRedeems[key] = next
            }
            if next.limits.resetCredits != nil,
               credits[key].map({ checkedAt(next) > checkedAt($0) }) ?? true {
                credits[key] = next
            }
            guard var previous = collected[key] else {
                order.append(key)
                collected[key] = next
                return
            }
            let winner = checkedAt(next) > checkedAt(previous) ? next : previous
            previous.displayName = previous.displayName ?? next.displayName
            previous.plan = previous.plan ?? next.plan
            for environment in next.environments where !previous.environments.contains(where: { $0.id == environment.id }) {
                previous.environments.append(environment)
            }
            previous.sourceLabel = previous.environments.isEmpty ? previous.sourceLabel ?? next.sourceLabel : nil
            // Display the newest successful credit balance, but redeem through a
            // hub when possible so its account-routing cooldown is cleared too.
            previous.redeem = hubRedeems[key]?.redeem
                ?? (credits[key] != nil
                    ? credits[key]?.redeem
                    : winner.redeem ?? previous.redeem ?? next.redeem)
            previous.limits = ServerProviderUsageLimits(
                checkedAt: winner.limits.checkedAt,
                windows: winner.limits.windows,
                resetCredits: credits[key]?.limits.resetCredits,
                unavailable: winner.limits.unavailable
            )
            collected[key] = previous
        }

        for environment in environments {
            for provider in UsageLimitsPresentation.providersWithLimits(environment.providers) {
                guard let limits = provider.usageLimits,
                      UsageLimitsPresentation.limitsNotice(limits) == nil else { continue }
                merge(UsageLimitAccount(
                    id: accountKey(driver: provider.driver, email: provider.auth.email)
                        ?? "native:\(environment.id):\(provider.instanceId)",
                    driver: provider.driver,
                    displayName: provider.displayName.flatMap(nonEmpty),
                    email: provider.auth.email,
                    plan: provider.auth.label,
                    environments: [.init(id: environment.id, label: environment.label)],
                    sourceLabel: nil,
                    redeem: .init(
                        environmentID: environment.id,
                        input: .provider(instanceID: provider.instanceId),
                        isConnected: environment.isConnected && !environment.isPending
                    ),
                    limits: limits
                ))
            }
        }
        for environment in environments {
            for source in environment.sources {
                for account in source.accounts {
                    guard UsageLimitsPresentation.limitsNotice(account.usageLimits) == nil else { continue }
                    merge(UsageLimitAccount(
                        id: accountKey(driver: account.driver, email: account.email)
                            ?? "hub:\(source.id):\(account.id)",
                        driver: account.driver,
                        displayName: account.email == nil
                            ? account.id.replacingOccurrences(of: "(?i)\\.json$", with: "", options: .regularExpression) : nil,
                        email: account.email,
                        plan: account.plan,
                        environments: [],
                        sourceLabel: environments.count > 1 ? "\(environment.label) · \(source.label)" : source.label,
                        redeem: account.usageLimits.resetCredits?.nextCreditId.map {
                            .init(
                                environmentID: environment.id,
                                input: .source(sourceID: source.id, accountID: account.id, creditID: $0),
                                isConnected: environment.isConnected && !environment.isPending
                            )
                        },
                        limits: account.usageLimits
                    ))
                }
            }
        }
        return order.compactMap { collected[$0] }
    }

    static func pools(_ accounts: [UsageLimitAccount], now: Date) -> [UsageLimitPool] {
        var drivers: [String] = []
        for account in accounts where !drivers.contains(account.driver) { drivers.append(account.driver) }
        return drivers.map { driver in
            let members = accounts.filter { $0.driver == driver }
            let orderWindow = members.flatMap(\.limits.windows).min { rank($0.kind) < rank($1.kind) }
            func reset(_ account: UsageLimitAccount) -> Date {
                account.limits.windows.first {
                    $0.id == orderWindow?.id && $0.kind == orderWindow?.kind
                }?.resetsAt.flatMap(UsageFormat.isoDate) ?? .distantFuture
            }
            let sorted = members.sorted { left, right in
                if reset(left) != reset(right) { return reset(left) < reset(right) }
                let leftName = (left.displayName ?? left.email ?? left.id).lowercased()
                let rightName = (right.displayName ?? right.email ?? right.id).lowercased()
                return leftName == rightName ? left.id < right.id : leftName.localizedStandardCompare(rightName) == .orderedAscending
            }
            return UsageLimitPool(driver: driver, accounts: sorted, windows: windows(sorted, now: now))
        }
    }

    static func notices(_ environments: [FeatureEnvironmentUsageLimits]) -> [String] {
        var result: [String] = []
        for environment in environments {
            if environment.isPending { result.append("\(environment.label): Waiting for limits.") }
            else if let error = environment.errorMessage { result.append("\(environment.label): \(error)") }
            else if !environment.isConnected { result.append("\(environment.label): Disconnected. Showing last known limits.") }
            func label(_ value: String) -> String { environments.count > 1 ? "\(environment.label) · \(value)" : value }
            for provider in UsageLimitsPresentation.providersWithLimits(environment.providers) {
                guard let limits = provider.usageLimits, limits.unavailable?.reason != .unsupported,
                      let notice = UsageLimitsPresentation.limitsNotice(limits) else { continue }
                result.append("\(label(provider.displayName.flatMap(nonEmpty) ?? UsageLimitsPresentation.providerLabel(driver: provider.driver))): \(notice)")
            }
            for source in environment.sources {
                if let error = source.error { result.append("\(label(source.label)): \(error)") }
                else if source.accounts.isEmpty { result.append("\(label(source.label)): No accounts reported.") }
                for (index, account) in source.accounts.enumerated() {
                    guard account.usageLimits.unavailable?.reason != .unsupported,
                          let notice = UsageLimitsPresentation.limitsNotice(account.usageLimits) else { continue }
                    result.append("\(label(source.label)) · \(UsageLimitsPresentation.providerLabel(driver: account.driver)) account \(index + 1): \(notice)")
                }
            }
        }
        return result
    }

    private static func windows(_ accounts: [UsageLimitAccount], now: Date) -> [UsageLimitPoolWindow] {
        var order: [String] = []
        var members: [String: [UsageLimitPoolWindow.Member]] = [:]
        for account in accounts {
            for window in account.limits.windows {
                let key = "\(window.kind.rawValue):\(window.id)"
                if members[key] == nil { order.append(key) }
                members[key, default: []].append(.init(account: account, window: window))
            }
        }
        return order.compactMap { key -> UsageLimitPoolWindow? in
            guard let rows = members[key], let first = rows.first?.window else { return nil }
            let count = Double(rows.count)
            let used = rows.reduce(0) { $0 + UsageLimitsMath.usedPercent($1.window) } / count
            let timed = rows.compactMap { member -> (used: Double, elapsed: Double)? in
                UsageLimitsMath.elapsedShare(member.window, now: now).map {
                    (UsageLimitsMath.usedPercent(member.window), $0)
                }
            }
            let gap = timed.isEmpty ? nil : timed.reduce(0) { $0 + $1.used - $1.elapsed * 100 } / Double(timed.count)
            let resets = rows.compactMap { member -> UsageLimitPoolWindow.Reset? in
                guard let at = member.window.resetsAt.flatMap(UsageFormat.isoDate) else { return nil }
                return .init(accountID: member.account.id, at: at, restoresPercent: Int((UsageLimitsMath.usedPercent(member.window) / count).rounded()))
            }.sorted { $0.at < $1.at }
            return UsageLimitPoolWindow(
                windowID: first.id, kind: first.kind, label: first.label, members: rows,
                columns: accounts.map { account in rows.first { $0.account.id == account.id }?.window },
                remainingPercent: Int((100 - used).rounded()),
                pace: gap.map { $0 > 5 ? .ahead : $0 < -5 ? .under : .on },
                resets: resets
            )
        }.sorted { rank($0.kind) < rank($1.kind) }
    }

    private static func rank(_ kind: ServerProviderUsageWindow.Kind) -> Int {
        switch kind { case .session: 0; case .weekly: 1; case .monthly: 2; case .other: 3 }
    }

    private static func checkedAt(_ account: UsageLimitAccount) -> Date {
        UsageFormat.isoDate(account.limits.checkedAt) ?? .distantPast
    }

    private static func accountKey(driver: String, email: String?) -> String? {
        email.flatMap(nonEmpty).map { "\(driver):\($0.lowercased())" }
    }

    private static func nonEmpty(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
