import Foundation

public let usageContractVersion = 3

public enum UsageProviderKind: String, Codable, CaseIterable, Sendable {
    case codex
    case claude

    public var displayName: String {
        switch self {
        case .codex: "Codex"
        case .claude: "Claude Code"
        }
    }
}

public enum UsageCostSource: String, Codable, Sendable {
    case providerReported
    case modelPriced
    case unpriced
}

public struct UsageSummaryInput: Codable, Equatable, Sendable {
    public let sinceDay: String
    public let untilDay: String
    public let timeZone: String

    public init(sinceDay: String, untilDay: String, timeZone: String) {
        self.sinceDay = sinceDay
        self.untilDay = untilDay
        self.timeZone = timeZone
    }
}

public struct UsageTokenTotals: Codable, Equatable, Sendable {
    public let uncachedInputTokens: Int
    public let cachedInputTokens: Int
    public let cacheCreationTokens: Int
    public let outputTokens: Int
    public let reasoningTokens: Int
}

public struct UsageBucket: Codable, Equatable, Sendable {
    public let day: String
    public let provider: UsageProviderKind
    public let model: String
    public let totals: UsageTokenTotals
    public let costUsd: Double
    public let cacheSavingsUsd: Double
    public let costSource: UsageCostSource
    public let records: Int
    public let unpricedRecords: Int
    public let sessions: Int
}

public struct UsageSourceFingerprint: Codable, Equatable, Hashable, Sendable {
    public let hostId: String
    public let provider: UsageProviderKind
    public let resolvedHomePath: String
    public let volumeId: String
}

public enum UsageSourceStatus: String, Codable, Sendable {
    case ok
    case missing
    case partial
    case failed
}

public struct UsageSource: Codable, Equatable, Sendable {
    public let fingerprint: UsageSourceFingerprint
    public let status: UsageSourceStatus
    public let scannedFiles: Int
    public let skippedFiles: Int
    public let malformedRecords: Int
    public let distinctSessions: Int
    public let message: String?
}

public enum UsagePricingStatus: String, Codable, Sendable {
    case fresh
    case cached
    case unavailable
}

public struct UsagePricing: Codable, Equatable, Sendable {
    public let status: UsagePricingStatus
    public let source: String
    public let fetchedAt: String?
    public let knownModels: Int
}

public struct UsageSummary: Codable, Equatable, Sendable {
    public let contractVersion: Int
    public let readAt: String
    public let timeZone: String
    public let sinceDay: String
    public let untilDay: String
    public let buckets: [UsageBucket]
    public let sources: [UsageSource]
    public let pricing: UsagePricing
    public let scanDurationMs: Int
}
