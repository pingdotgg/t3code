import Foundation

public struct FeatureEnvironmentUsage: Identifiable, Equatable, Sendable {
    public let environmentID: String
    public let label: String
    public let summary: UsageSummary?
    public let errorMessage: String?

    public var id: String { environmentID }

    public init(
        environmentID: String,
        label: String,
        summary: UsageSummary?,
        errorMessage: String?
    ) {
        self.environmentID = environmentID
        self.label = label
        self.summary = summary
        self.errorMessage = errorMessage
    }
}

struct UsageProviderTotals: Identifiable, Equatable {
    let provider: UsageProviderKind
    let costUsd: Double
    let totalTokens: Int
    let records: Int
    let costShare: Double
    let tokenShare: Double

    var id: UsageProviderKind { provider }
}

struct UsageModelTotals: Identifiable, Equatable {
    let model: String
    let provider: UsageProviderKind
    let costUsd: Double
    let totalTokens: Int
    let records: Int
    let costShare: Double

    var id: String { "\(provider.rawValue):\(model)" }
}

struct UsageProviderValue: Equatable {
    var costUsd = 0.0
    var totalTokens = 0
}

struct UsageDailyTotals: Identifiable, Equatable {
    let day: String
    let costUsd: Double
    let totalTokens: Int
    let byProvider: [UsageProviderKind: UsageProviderValue]

    var id: String { day }
}

struct UsageCostQuality: Equatable {
    let providerReportedShare: Double
    let modelPricedShare: Double
    let unpricedShare: Double
    let cacheSavingsUsd: Double
}

struct MergedUsage: Equatable {
    var costUsd = 0.0
    var uncachedInputTokens = 0
    var cachedInputTokens = 0
    var cacheCreationTokens = 0
    var outputTokens = 0
    var reasoningTokens = 0
    var totalTokens = 0
    var records = 0
    var sessions = 0
    var providers: [UsageProviderTotals] = []
    var models: [UsageModelTotals] = []
    var daily: [UsageDailyTotals] = []
    var costQuality = UsageCostQuality(
        providerReportedShare: 0,
        modelPricedShare: 0,
        unpricedShare: 0,
        cacheSavingsUsd: 0
    )
    var duplicateSources: [String] = []
    var contributingEnvironments: [String] = []
    var staleEnvironments: [String] = []
}

struct UsageLoadRequest: Equatable {
    let id: UUID
    let days: Int
    let input: UsageSummaryInput
}

struct UsageLoadState: Equatable {
    private(set) var windowDays: Int
    private(set) var windowInput: UsageSummaryInput
    private(set) var environments: [FeatureEnvironmentUsage] = []
    private(set) var merged = MergedUsage()
    private(set) var isLoading = true
    private(set) var errorMessage: String?
    private var activeLoadID: UUID?

    init(
        days: Int = 30,
        now: Date = Date(),
        timeZone: TimeZone = .current
    ) {
        windowDays = days
        windowInput = UsageWindow.make(days: days, now: now, timeZone: timeZone)
    }

    mutating func begin(
        days: Int,
        now: Date = Date(),
        timeZone: TimeZone = .current
    ) -> UsageLoadRequest {
        selectWindow(days: days, now: now, timeZone: timeZone)
        let request = UsageLoadRequest(
            id: UUID(),
            days: days,
            input: UsageWindow.make(days: days, now: now, timeZone: timeZone)
        )
        activeLoadID = request.id
        isLoading = true
        errorMessage = nil
        return request
    }

    mutating func selectWindow(
        days: Int,
        now: Date = Date(),
        timeZone: TimeZone = .current
    ) {
        guard days != windowDays else { return }
        windowDays = days
        windowInput = UsageWindow.make(days: days, now: now, timeZone: timeZone)
        environments = []
        merged = MergedUsage()
        isLoading = true
        errorMessage = nil
    }

    @discardableResult
    mutating func receive(
        _ result: [FeatureEnvironmentUsage],
        for request: UsageLoadRequest
    ) -> Bool {
        guard activeLoadID == request.id, request.days == windowDays else { return false }
        windowInput = request.input
        environments = result
        merged = UsageMerger.merge(result)
        errorMessage = nil
        return true
    }

    @discardableResult
    mutating func fail(
        _ error: any Error,
        for request: UsageLoadRequest
    ) -> Bool {
        guard activeLoadID == request.id, request.days == windowDays else { return false }
        errorMessage = error.localizedDescription
        return true
    }

    mutating func finish(_ request: UsageLoadRequest) {
        guard activeLoadID == request.id, request.days == windowDays else { return }
        activeLoadID = nil
        isLoading = false
    }
}

enum UsageMerger {
    private struct OwnedContribution {
        let buckets: [UsageBucket]
        let sessions: Int
    }

    private struct ProviderAccumulator {
        var costUsd = 0.0
        var totalTokens = 0
        var records = 0
    }

    private struct ModelAccumulator {
        let provider: UsageProviderKind
        var costUsd = 0.0
        var totalTokens = 0
        var records = 0
    }

    private struct DailyAccumulator {
        var costUsd = 0.0
        var totalTokens = 0
        var byProvider: [UsageProviderKind: UsageProviderValue] = [:]
    }

    static func merge(
        _ environments: [FeatureEnvironmentUsage],
        expectedContractVersion: Int = usageContractVersion
    ) -> MergedUsage {
        let available = environments.compactMap { environment -> (FeatureEnvironmentUsage, UsageSummary)? in
            guard let summary = environment.summary else { return nil }
            return (environment, summary)
        }
        let current = available.filter { $0.1.contractVersion == expectedContractVersion }
        let staleEnvironmentIDs = available.compactMap { environment, summary in
            summary.contractVersion == expectedContractVersion ? nil : environment.environmentID
        }
        let claims = claimSources(current)

        var result = MergedUsage()
        result.duplicateSources = claims.duplicates
        result.staleEnvironments = staleEnvironmentIDs

        var cacheSavingsUsd = 0.0
        var providerReportedRecords = 0
        var unpricedRecords = 0
        var providers: [UsageProviderKind: ProviderAccumulator] = [:]
        var models: [String: ModelAccumulator] = [:]
        var daily: [String: DailyAccumulator] = [:]

        for (environment, summary) in current {
            let contribution = ownedContribution(
                environment: environment,
                summary: summary,
                ownerByFingerprint: claims.ownerByFingerprint
            )
            if !contribution.buckets.isEmpty {
                result.contributingEnvironments.append(environment.environmentID)
            }
            result.sessions += contribution.sessions

            for bucket in contribution.buckets {
                let tokens = totalTokens(bucket)
                result.costUsd += bucket.costUsd
                result.uncachedInputTokens += bucket.totals.uncachedInputTokens
                result.cachedInputTokens += bucket.totals.cachedInputTokens
                result.cacheCreationTokens += bucket.totals.cacheCreationTokens
                result.outputTokens += bucket.totals.outputTokens
                result.reasoningTokens += bucket.totals.reasoningTokens
                result.records += bucket.records
                cacheSavingsUsd += bucket.cacheSavingsUsd
                unpricedRecords += bucket.unpricedRecords
                if bucket.costSource == .providerReported {
                    providerReportedRecords += bucket.records
                }

                var provider = providers[bucket.provider] ?? ProviderAccumulator()
                provider.costUsd += bucket.costUsd
                provider.totalTokens += tokens
                provider.records += bucket.records
                providers[bucket.provider] = provider

                let modelKey = "\(bucket.provider.rawValue) \(bucket.model)"
                var model = models[modelKey] ?? ModelAccumulator(provider: bucket.provider)
                model.costUsd += bucket.costUsd
                model.totalTokens += tokens
                model.records += bucket.records
                models[modelKey] = model

                var day = daily[bucket.day] ?? DailyAccumulator()
                day.costUsd += bucket.costUsd
                day.totalTokens += tokens
                var dayProvider = day.byProvider[bucket.provider] ?? UsageProviderValue()
                dayProvider.costUsd += bucket.costUsd
                dayProvider.totalTokens += tokens
                day.byProvider[bucket.provider] = dayProvider
                daily[bucket.day] = day
            }
        }

        result.totalTokens = result.uncachedInputTokens
            + result.cachedInputTokens
            + result.cacheCreationTokens
            + result.outputTokens
        result.providers = providers.map { provider, totals in
            UsageProviderTotals(
                provider: provider,
                costUsd: totals.costUsd,
                totalTokens: totals.totalTokens,
                records: totals.records,
                costShare: result.costUsd == 0 ? 0 : totals.costUsd / result.costUsd,
                tokenShare: result.totalTokens == 0
                    ? 0
                    : Double(totals.totalTokens) / Double(result.totalTokens)
            )
        }
        .sorted { $0.costUsd > $1.costUsd }
        result.models = models.map { key, totals in
            UsageModelTotals(
                model: String(key.split(separator: " ", maxSplits: 1).last ?? ""),
                provider: totals.provider,
                costUsd: totals.costUsd,
                totalTokens: totals.totalTokens,
                records: totals.records,
                costShare: result.costUsd == 0 ? 0 : totals.costUsd / result.costUsd
            )
        }
        .sorted {
            $0.costUsd == $1.costUsd
                ? $0.totalTokens > $1.totalTokens
                : $0.costUsd > $1.costUsd
        }
        result.daily = daily.map { day, totals in
            UsageDailyTotals(
                day: day,
                costUsd: totals.costUsd,
                totalTokens: totals.totalTokens,
                byProvider: totals.byProvider
            )
        }
        .sorted { $0.day < $1.day }
        result.costQuality = UsageCostQuality(
            providerReportedShare: result.records == 0
                ? 0
                : Double(providerReportedRecords) / Double(result.records),
            modelPricedShare: result.records == 0
                ? 0
                : Double(result.records - providerReportedRecords - unpricedRecords)
                    / Double(result.records),
            unpricedShare: result.records == 0
                ? 0
                : Double(unpricedRecords) / Double(result.records),
            cacheSavingsUsd: cacheSavingsUsd
        )
        return result
    }

    private static func claimSources(
        _ environments: [(FeatureEnvironmentUsage, UsageSummary)]
    ) -> (ownerByFingerprint: [UsageSourceFingerprint: String], duplicates: [String]) {
        var selected: [
            UsageSourceFingerprint: (environmentID: String, status: UsageSourceStatus)
        ] = [:]
        var duplicates: [String] = []
        let ordered = environments.sorted { $0.0.environmentID < $1.0.environmentID }

        for (environment, summary) in ordered {
            for source in summary.sources where source.status != .missing {
                if let current = selected[source.fingerprint] {
                    if source.status.ownershipPriority > current.status.ownershipPriority {
                        selected[source.fingerprint] = (environment.environmentID, source.status)
                    }
                } else {
                    selected[source.fingerprint] = (environment.environmentID, source.status)
                }
            }
        }

        let owners = selected.mapValues(\.environmentID)
        for (environment, summary) in ordered {
            for source in summary.sources where source.status != .missing {
                if owners[source.fingerprint] != environment.environmentID {
                    duplicates.append(
                        "\(environment.label): \(source.fingerprint.resolvedHomePath)"
                    )
                }
            }
        }
        return (owners, duplicates)
    }

    private static func ownedContribution(
        environment: FeatureEnvironmentUsage,
        summary: UsageSummary,
        ownerByFingerprint: [UsageSourceFingerprint: String]
    ) -> OwnedContribution {
        var providers: Set<UsageProviderKind> = []
        var sessions = 0
        for source in summary.sources where source.status != .missing {
            if ownerByFingerprint[source.fingerprint] == environment.environmentID {
                providers.insert(source.fingerprint.provider)
                sessions += source.distinctSessions
            }
        }
        return OwnedContribution(
            buckets: summary.buckets.filter { providers.contains($0.provider) },
            sessions: sessions
        )
    }

    private static func totalTokens(_ bucket: UsageBucket) -> Int {
        bucket.totals.uncachedInputTokens
            + bucket.totals.cachedInputTokens
            + bucket.totals.cacheCreationTokens
            + bucket.totals.outputTokens
    }
}

private extension UsageSourceStatus {
    var ownershipPriority: Int {
        switch self {
        case .missing: 0
        case .failed: 1
        case .partial: 2
        case .ok: 3
        }
    }
}

enum UsageWindow {
    static func make(
        days: Int,
        now: Date = Date(),
        timeZone: TimeZone = .current
    ) -> UsageSummaryInput {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let until = calendar.startOfDay(for: now)
        let since = calendar.date(byAdding: .day, value: -(days - 1), to: until) ?? until
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return UsageSummaryInput(
            sinceDay: formatter.string(from: since),
            untilDay: formatter.string(from: until),
            timeZone: timeZone.identifier
        )
    }

    static func days(in input: UsageSummaryInput) -> [String] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let parser = DateFormatter()
        parser.calendar = calendar
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = TimeZone(secondsFromGMT: 0)
        parser.dateFormat = "yyyy-MM-dd"
        guard let start = parser.date(from: input.sinceDay),
              let end = parser.date(from: input.untilDay),
              start <= end else {
            return []
        }

        var result: [String] = []
        var cursor = start
        while cursor <= end {
            result.append(parser.string(from: cursor))
            guard let next = calendar.date(
                byAdding: .day,
                value: 1,
                to: cursor
            ) else { break }
            cursor = next
        }
        return result
    }
}
