import Foundation

public struct ServerProviderUsageWindow: Codable, Identifiable, Equatable, Sendable {
    public enum Kind: String, Codable, CaseIterable, Sendable {
        case session
        case weekly
        case monthly
        case other
    }

    public let id: String
    public let kind: Kind
    public let label: String
    public let usedPercent: Double
    public let resetsAt: String?
    public let windowDurationMins: Int?

    public init(
        id: String,
        kind: Kind,
        label: String,
        usedPercent: Double,
        resetsAt: String? = nil,
        windowDurationMins: Int? = nil
    ) {
        self.id = id
        self.kind = kind
        self.label = label
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
        self.windowDurationMins = windowDurationMins
    }
}

public struct ServerProviderResetCredits: Codable, Equatable, Sendable {
    public let availableCount: Int
    public let nextExpiresAt: String?

    public init(availableCount: Int, nextExpiresAt: String? = nil) {
        self.availableCount = availableCount
        self.nextExpiresAt = nextExpiresAt
    }
}

public struct ServerProviderUsageLimits: Codable, Equatable, Sendable {
    public struct Unavailable: Codable, Equatable, Sendable {
        public enum Reason: String, Codable, CaseIterable, Sendable {
            case unsupported
            case probeFailed
        }

        public let reason: Reason
        public let message: String?

        public init(reason: Reason, message: String? = nil) {
            self.reason = reason
            self.message = message
        }
    }

    public let checkedAt: String
    @ForwardCompatibleArray public var windows: [ServerProviderUsageWindow]
    public let resetCredits: ServerProviderResetCredits?
    public let unavailable: Unavailable?

    public init(
        checkedAt: String,
        windows: [ServerProviderUsageWindow],
        resetCredits: ServerProviderResetCredits? = nil,
        unavailable: Unavailable? = nil
    ) {
        self.checkedAt = checkedAt
        self.windows = windows
        self.resetCredits = resetCredits
        self.unavailable = unavailable
    }

    private enum CodingKeys: String, CodingKey {
        case checkedAt, windows, resetCredits, unavailable
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        checkedAt = try container.decode(String.self, forKey: .checkedAt)
        _windows = try container.decode(ForwardCompatibleArray<ServerProviderUsageWindow>.self, forKey: .windows)
        resetCredits = try container.decodeIfPresent(ServerProviderResetCredits.self, forKey: .resetCredits)
        // A new limits notice must not remove the provider from the config.
        unavailable = try? container.decodeIfPresent(Unavailable.self, forKey: .unavailable)
    }
}

public struct UsageLimitSourceAccount: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let driver: String
    public let email: String?
    public let plan: String?
    public let usageLimits: ServerProviderUsageLimits

    public init(
        id: String,
        driver: String,
        email: String? = nil,
        plan: String? = nil,
        usageLimits: ServerProviderUsageLimits
    ) {
        self.id = id
        self.driver = driver
        self.email = email
        self.plan = plan
        self.usageLimits = usageLimits
    }
}

public struct UsageLimitSourceSnapshot: Codable, Identifiable, Equatable, Sendable {
    public enum Kind: String, Codable, CaseIterable, Sendable {
        case cliproxy
    }

    public let id: String
    public let kind: Kind
    public let label: String
    public let checkedAt: String
    @ForwardCompatibleArray public var accounts: [UsageLimitSourceAccount]
    public let error: String?

    public init(
        id: String,
        kind: Kind = .cliproxy,
        label: String,
        checkedAt: String,
        accounts: [UsageLimitSourceAccount],
        error: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.label = label
        self.checkedAt = checkedAt
        self.accounts = accounts
        self.error = error
    }
}

public enum ProviderConsumeResetCreditOutcome: String, Codable, CaseIterable, Sendable {
    case reset
    case nothingToReset
    case noCredit
    case alreadyRedeemed
}

public struct ProviderConsumeResetCreditResult: Codable, Equatable, Sendable {
    public let outcome: ProviderConsumeResetCreditOutcome

    public init(outcome: ProviderConsumeResetCreditOutcome) {
        self.outcome = outcome
    }
}
