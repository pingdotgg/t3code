import Foundation

public struct FeatureEnvironmentUsage: Identifiable, Equatable, Sendable {
    public let environmentID: String
    public let label: String
    public let summary: UsageSummary?
    public let errorMessage: String?
    public let isPending: Bool

    public var id: String { environmentID }

    public init(
        environmentID: String,
        label: String,
        summary: UsageSummary?,
        errorMessage: String? = nil,
        isPending: Bool = false
    ) {
        self.environmentID = environmentID
        self.label = label
        self.summary = summary
        self.errorMessage = errorMessage
        self.isPending = isPending
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

struct UsageHourlyTotals: Identifiable, Equatable {
    let hourStart: String
    let costUsd: Double
    let totalTokens: Int
    let byProvider: [UsageProviderKind: UsageProviderValue]

    var id: String { hourStart }
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
    var hourly: [UsageHourlyTotals] = []
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
    private(set) var presentation = UsagePresentation()
    private(set) var isLoading = true
    private(set) var errorMessage: String?
    private var activeLoadID: UUID?

    var isPartial: Bool {
        environments.contains {
            $0.summary.map {
                isCompatibleUsageContractVersion($0.contractVersion, resolution: windowInput.resolution)
            } == true
        }
            && environments.contains { $0.isPending && $0.summary == nil }
    }

    var hasPendingCachedTotals: Bool {
        environments.contains { $0.isPending && $0.summary != nil }
    }

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
        presentation = UsagePresentation()
        isLoading = true
        errorMessage = nil
    }

    @discardableResult
    mutating func receive(
        _ result: [FeatureEnvironmentUsage],
        for request: UsageLoadRequest
    ) -> Bool {
        guard activeLoadID == request.id, request.days == windowDays else { return false }
        // A pending row may retain the last scan only for the same window.
        // Results from a previous day or rolling hour must not enter new totals.
        let previous = windowInput == request.input
            ? Dictionary(uniqueKeysWithValues: environments.map { ($0.environmentID, $0) })
            : [:]
        windowInput = request.input
        environments = result.map { environment in
            guard environment.isPending,
                  environment.summary == nil,
                  let summary = previous[environment.environmentID]?.summary else {
                return environment
            }
            return FeatureEnvironmentUsage(
                environmentID: environment.environmentID,
                label: environment.label,
                summary: summary,
                errorMessage: environment.errorMessage,
                isPending: true
            )
        }
        merged = UsageMerger.merge(environments, resolution: request.input.resolution)
        presentation = UsagePresentation.make(merged, input: request.input)
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
        resolution: UsageResolution? = nil
    ) -> MergedUsage {
        let available = environments.compactMap { environment -> (FeatureEnvironmentUsage, UsageSummary)? in
            guard let summary = environment.summary else { return nil }
            return (environment, summary)
        }
        let current = available.filter {
            isCompatibleUsageContractVersion($0.1.contractVersion, resolution: resolution)
        }
        let staleEnvironmentIDs = available.compactMap { environment, summary in
            isCompatibleUsageContractVersion(summary.contractVersion, resolution: resolution)
                ? nil
                : environment.environmentID
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
        var hourly: [String: DailyAccumulator] = [:]

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

                if let hourStart = bucket.hourStart {
                    var hour = hourly[hourStart] ?? DailyAccumulator()
                    hour.costUsd += bucket.costUsd
                    hour.totalTokens += tokens
                    var hourProvider = hour.byProvider[bucket.provider] ?? UsageProviderValue()
                    hourProvider.costUsd += bucket.costUsd
                    hourProvider.totalTokens += tokens
                    hour.byProvider[bucket.provider] = hourProvider
                    hourly[hourStart] = hour
                }
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
        result.hourly = hourly.map { hourStart, totals in
            UsageHourlyTotals(
                hourStart: hourStart,
                costUsd: totals.costUsd,
                totalTokens: totals.totalTokens,
                byProvider: totals.byProvider
            )
        }
        .sorted { $0.hourStart < $1.hourStart }
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
        if days == 1 {
            let untilTimeInterval = floor(now.timeIntervalSince1970 / 60) * 60
            let untilTime = Date(timeIntervalSince1970: untilTimeInterval)
            let sinceTime = untilTime.addingTimeInterval(-24 * 60 * 60)
            return UsageSummaryInput(
                sinceDay: formatter.string(from: sinceTime),
                untilDay: formatter.string(from: untilTime),
                timeZone: timeZone.identifier,
                resolution: .hour,
                sinceTime: isoString(sinceTime),
                untilTime: isoString(untilTime)
            )
        }
        return UsageSummaryInput(
            sinceDay: formatter.string(from: since),
            untilDay: formatter.string(from: until),
            timeZone: timeZone.identifier,
            resolution: .day
        )
    }

    static func hours(in input: UsageSummaryInput) -> [String] {
        guard let sinceValue = input.sinceTime,
              let untilValue = input.untilTime,
              let since = isoDate(sinceValue),
              let until = isoDate(untilValue),
              since < until else {
            return []
        }
        var result: [String] = []
        var cursor = since
        while cursor < until {
            result.append(isoString(cursor))
            cursor = cursor.addingTimeInterval(60 * 60)
        }
        return result
    }

    private static func isoString(_ date: Date) -> String {
        UsageFormat.isoString(date)
    }

    private static func isoDate(_ value: String) -> Date? {
        UsageFormat.isoDate(value)
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

/// Chart bars stack one segment per provider for each day or hour in the window.
struct UsageChartSegment: Identifiable, Equatable {
    let period: String
    let provider: UsageProviderKind
    let start: Double
    let end: Double

    var id: String { "\(period):\(provider.rawValue)" }
}

struct UsagePeriodRow: Identifiable, Equatable {
    let id: String
    let label: String
    let costUsd: Double
    let totalTokens: Int
}

/// Sorted, labelled, and charted values the usage screen renders. Computed once
/// per received result so the view body only reads stored values.
struct UsagePresentation: Equatable {
    var providersByCost: [UsageProviderTotals] = []
    var providersByTokens: [UsageProviderTotals] = []
    var costSegments: [UsageChartSegment] = []
    var tokenSegments: [UsageChartSegment] = []
    var hasCostActivity = false
    var hasTokenActivity = false
    /// Newest period first.
    var periods: [UsagePeriodRow] = []
    var activePeriodCount = 0
    var periodAverageTokens = 0
    var cachedInputShare = 0.0
    var sinceLabel = ""
    var untilLabel = ""

    static func make(_ merged: MergedUsage, input: UsageSummaryInput) -> UsagePresentation {
        var result = UsagePresentation()
        result.providersByCost = merged.providers.sorted { $0.costUsd > $1.costUsd }
        result.providersByTokens = merged.providers.sorted { $0.totalTokens > $1.totalTokens }
        result.hasCostActivity = merged.daily.contains { $0.costUsd > 0 }
        result.hasTokenActivity = merged.daily.contains { $0.totalTokens > 0 }
        result.sinceLabel = UsageFormat.dayShort(input.sinceDay)
        result.untilLabel = UsageFormat.dayShort(input.untilDay)

        let periodKeys: [String]
        let byPeriod: [String: [UsageProviderKind: UsageProviderValue]]
        if input.resolution == .hour {
            let hourStyle = UsageFormat.hourStyle(timeZone: input.timeZone)
            periodKeys = UsageWindow.hours(in: input)
            byPeriod = Dictionary(uniqueKeysWithValues: merged.hourly.map { ($0.hourStart, $0.byProvider) })
            result.periods = merged.hourly.reversed().map {
                UsagePeriodRow(
                    id: $0.hourStart,
                    label: UsageFormat.hourShort($0.hourStart, style: hourStyle),
                    costUsd: $0.costUsd,
                    totalTokens: $0.totalTokens
                )
            }
            result.activePeriodCount = merged.hourly.filter { $0.totalTokens > 0 }.count
        } else {
            periodKeys = UsageWindow.days(in: input)
            byPeriod = Dictionary(uniqueKeysWithValues: merged.daily.map { ($0.day, $0.byProvider) })
            result.periods = merged.daily.reversed().map {
                UsagePeriodRow(
                    id: $0.day,
                    label: UsageFormat.dayShort($0.day),
                    costUsd: $0.costUsd,
                    totalTokens: $0.totalTokens
                )
            }
            result.activePeriodCount = merged.daily.filter { $0.totalTokens > 0 }.count
        }
        result.costSegments = segments(periodKeys, byPeriod: byPeriod) { $0.costUsd }
        result.tokenSegments = segments(periodKeys, byPeriod: byPeriod) { Double($0.totalTokens) }
        result.periodAverageTokens = result.activePeriodCount == 0
            ? 0
            : merged.totalTokens / result.activePeriodCount
        let observedInput = merged.uncachedInputTokens + merged.cachedInputTokens
        result.cachedInputShare = observedInput == 0
            ? 0
            : Double(merged.cachedInputTokens) / Double(observedInput)
        return result
    }

    private static func segments(
        _ periods: [String],
        byPeriod: [String: [UsageProviderKind: UsageProviderValue]],
        value: (UsageProviderValue) -> Double
    ) -> [UsageChartSegment] {
        periods.flatMap { period in
            let totals = byPeriod[period] ?? [:]
            var start = 0.0
            return UsageProviderKind.allCases.map { provider in
                let amount = totals[provider].map(value) ?? 0
                defer { start += amount }
                return UsageChartSegment(period: period, provider: provider, start: start, end: start + amount)
            }
        }
    }
}

/// Format styles are Sendable values, so each one is built once here instead of
/// once per call. All of them follow the current locale.
enum UsageFormat {
    private static let isoFractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let isoWholeSeconds = Date.ISO8601FormatStyle()
    private static let dayParser = Date.ISO8601FormatStyle().year().month().day()
    private static let dayLabel = Date.FormatStyle(timeZone: .gmt).month(.abbreviated).day()
    private static let usdStyle = FloatingPointFormatStyle<Double>.Currency(code: "USD")
        .precision(.fractionLength(2))
    private static let countStyle = IntegerFormatStyle<Int>()
    private static let percentStyle = FloatingPointFormatStyle<Double>.Percent()
        .precision(.fractionLength(1))

    static func usd(_ value: Double) -> String {
        usdStyle.format(value)
    }

    static func count(_ value: Int) -> String {
        countStyle.format(value)
    }

    static func tokens(_ value: Int) -> String {
        let magnitude = abs(Double(value))
        if magnitude >= 1_000_000_000_000 { return compact(Double(value) / 1_000_000_000_000, suffix: "T") }
        if magnitude >= 1_000_000_000 { return compact(Double(value) / 1_000_000_000, suffix: "B") }
        if magnitude >= 1_000_000 { return compact(Double(value) / 1_000_000, suffix: "M") }
        if magnitude >= 1_000 { return compact(Double(value) / 1_000, suffix: "K") }
        return count(value)
    }

    static func percent(_ value: Double) -> String {
        percentStyle.format(value)
    }

    /// "2026-08-18" becomes "Aug 18" in the current locale.
    static func dayShort(_ day: String) -> String {
        (try? dayParser.parse(day)).map(dayLabel.format) ?? day
    }

    /// One style per window, since the label follows the window's time zone.
    static func hourStyle(timeZone: String) -> Date.FormatStyle {
        Date.FormatStyle(timeZone: TimeZone(identifier: timeZone) ?? .current)
            .weekday(.abbreviated)
            .hour(.defaultDigits(amPM: .abbreviated))
    }

    static func hourShort(_ value: String, style: Date.FormatStyle) -> String {
        isoDate(value).map(style.format) ?? value
    }

    static func isoString(_ date: Date) -> String {
        isoFractional.format(date)
    }

    static func isoDate(_ value: String) -> Date? {
        (try? isoFractional.parse(value)) ?? (try? isoWholeSeconds.parse(value))
    }

    private static func compact(_ value: Double, suffix: String) -> String {
        let digits = abs(value) >= 100 ? 0 : abs(value) >= 10 ? 1 : 2
        var formatted = String(format: "%.*f", digits, value)
        while formatted.hasSuffix("0"), formatted.contains(".") {
            formatted.removeLast()
        }
        if formatted.hasSuffix(".") { formatted.removeLast() }
        return formatted + suffix
    }
}
