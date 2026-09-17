import Foundation

public let usageContractVersion = 5
public let minimumCompatibleUsageContractVersion = 3

/// Version 3 supports daily totals. Hourly windows require version 4 or later.
public func isCompatibleUsageContractVersion(
    _ version: Int,
    resolution: UsageResolution? = nil
) -> Bool {
    let minimum = resolution == .hour ? 4 : minimumCompatibleUsageContractVersion
    return (minimum ... usageContractVersion).contains(version)
}

public enum UsageProviderKind: String, Codable, CaseIterable, Sendable {
    case codex
    case claude
    case grok

    public var displayName: String {
        switch self {
        case .codex: "Codex"
        case .claude: "Claude Code"
        case .grok: "Grok Build"
        }
    }
}

public enum UsageCostSource: String, Codable, Sendable {
    case providerReported
    case modelPriced
    case unpriced
}

public enum UsageResolution: String, Codable, Equatable, Sendable {
    case day
    case hour
}

public struct UsageSummaryInput: Codable, Equatable, Sendable {
    public let sinceDay: String
    public let untilDay: String
    public let timeZone: String
    public let resolution: UsageResolution?
    public let sinceTime: String?
    public let untilTime: String?

    public init(
        sinceDay: String,
        untilDay: String,
        timeZone: String,
        resolution: UsageResolution? = nil,
        sinceTime: String? = nil,
        untilTime: String? = nil
    ) {
        self.sinceDay = sinceDay
        self.untilDay = untilDay
        self.timeZone = timeZone
        self.resolution = resolution
        self.sinceTime = sinceTime
        self.untilTime = untilTime
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
    public let hourStart: String?
    public let provider: UsageProviderKind
    public let model: String
    public let totals: UsageTokenTotals
    public let costUsd: Double
    public let cacheSavingsUsd: Double
    public let costSource: UsageCostSource
    public let records: Int
    public let unpricedRecords: Int
    public let sessions: Int

    public init(
        day: String,
        hourStart: String? = nil,
        provider: UsageProviderKind,
        model: String,
        totals: UsageTokenTotals,
        costUsd: Double,
        cacheSavingsUsd: Double,
        costSource: UsageCostSource,
        records: Int,
        unpricedRecords: Int,
        sessions: Int
    ) {
        self.day = day
        self.hourStart = hourStart
        self.provider = provider
        self.model = model
        self.totals = totals
        self.costUsd = costUsd
        self.cacheSavingsUsd = cacheSavingsUsd
        self.costSource = costSource
        self.records = records
        self.unpricedRecords = unpricedRecords
        self.sessions = sessions
    }
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
