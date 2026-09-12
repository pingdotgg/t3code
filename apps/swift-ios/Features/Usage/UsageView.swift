import Charts
import SwiftUI

private enum UsageMetric: String, CaseIterable, Identifiable {
    case cost
    case tokens

    var id: Self { self }
    var label: String { rawValue.uppercased() }
}

private enum UsageBreakdown: String, CaseIterable, Identifiable {
    case model
    case time

    var id: Self { self }
}

private enum UsageTab: String {
    case usage
    case limits
}

public struct UsageView: View {
    private let client: any FeatureClient

    @State private var loadState = UsageLoadState()
    @State private var metric = UsageMetric.cost
    @State private var breakdown = UsageBreakdown.model
    @State private var tab = UsageTab.usage
    @State private var resetCreditStates: [UsageResetCreditTarget: UsageResetCreditState] = [:]

    public init(client: any FeatureClient) {
        self.client = client
    }

    private var windowInput: UsageSummaryInput { loadState.windowInput }
    private var environments: [FeatureEnvironmentUsage] { loadState.environments }
    private var merged: MergedUsage { loadState.merged }
    private var isLoading: Bool { loadState.isLoading }
    private var errorMessage: String? { loadState.errorMessage }
    private var windowDays: Binding<Int> {
        Binding(
            get: { loadState.windowDays },
            set: { loadState.selectWindow(days: $0) }
        )
    }

    public var body: some View {
        VStack(spacing: 0) {
            Picker("Usage view", selection: $tab) {
                Text("Usage").tag(UsageTab.usage)
                Text("Limits").tag(UsageTab.limits)
            }
            .pickerStyle(.segmented)
            .tint(T3Colors.textPrimary)
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 12)

            if tab == .limits {
                UsageLimitsView(client: client, resetCreditStates: $resetCreditStates)
            } else {
                usageContent
            }
        }
        .background(T3Colors.background)
        .navigationTitle("Usage")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbar {
            if tab == .usage {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Refresh prices", systemImage: "arrow.clockwise") {
                        Task { await load(refreshPricing: true) }
                    }
                    .disabled(isLoading)
                }
            }
        }
        .t3NavigationChrome()
    }

    private var usageContent: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                Picker("Usage window", selection: windowDays) {
                    Text("24h").tag(1)
                    Text("7d").tag(7)
                    Text("30d").tag(30)
                    Text("90d").tag(90)
                }
                .pickerStyle(.segmented)
                .tint(T3Colors.textPrimary)

                coverageNotice

                if isLoading, !hasCompatibleSummary,
                   environments.isEmpty || environments.contains(where: \.isPending) {
                    Text("Scanning provider transcripts…")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 64)
                } else if let errorMessage, environments.isEmpty {
                    ContentUnavailableView {
                        Label("Couldn’t load usage", systemImage: "exclamationmark.circle")
                    } description: {
                        Text(errorMessage)
                    } actions: {
                        Button("Try again") { Task { await load() } }
                    }
                } else if environments.isEmpty {
                    ContentUnavailableView {
                        Label("No environments", systemImage: "chart.bar.xaxis")
                    } description: {
                        Text("Connect an environment to see usage.")
                    }
                } else if !hasCompatibleSummary {
                    ContentUnavailableView {
                        Label("Couldn’t load usage", systemImage: "exclamationmark.circle")
                    } description: {
                        Text(hasDailyOnlySummary
                            ? "This server reports daily usage. Select 7d or 30d to see it."
                            : "No compatible usage data is available.")
                    } actions: {
                        Button("Try again") { Task { await load() } }
                    }
                } else {
                    chartCard
                    providersSection
                    totalsSection
                    breakdownSection
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 32)
        }
        .scrollIndicators(.hidden)
        .refreshable { await load() }
        .task(id: loadState.windowDays) {
            await load()
        }
    }

    @ViewBuilder
    private var coverageNotice: some View {
        let failed = environments.filter { $0.errorMessage != nil }
        let stale = environments.filter { merged.staleEnvironments.contains($0.environmentID) }
        let hasRefreshError = errorMessage != nil && hasCompatibleSummary
        if hasRefreshError
            || loadState.isPartial
            || loadState.hasPendingCachedTotals
            || !failed.isEmpty
            || !stale.isEmpty
            || !merged.duplicateSources.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                if loadState.hasPendingCachedTotals {
                    Text(loadState.isPartial
                        ? "Updating usage. Totals are partial and include the last scan."
                        : "Updating usage. Some totals are from the last scan.")
                } else if loadState.isPartial {
                    Text("Some environments are still reporting. Totals are partial.")
                }
                if hasRefreshError {
                    Text("Couldn’t refresh usage. The totals below are from the last successful scan.")
                }
                ForEach(failed) { environment in
                    Text("\(environment.label): \(environment.errorMessage ?? "Could not report usage.")")
                }
                ForEach(stale) { environment in
                    if windowInput.resolution == .hour, environment.summary?.contractVersion == 3 {
                        Text("\(environment.label) reports daily usage only. Select 7d or 30d to include it.")
                    } else {
                        Text("\(environment.label) uses an unsupported usage format and is excluded from totals.")
                    }
                }
                if !merged.duplicateSources.isEmpty {
                    Text(
                        "Counted once across environments sharing a transcript directory: "
                            + merged.duplicateSources.joined(separator: ", ")
                    )
                }
            }
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 16))
        }
    }

    private var chartCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(metric == .cost ? "Raw token cost" : "Processed tokens")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                    Text(
                        metric == .cost
                            ? "\(UsageFormat.usd(merged.costUsd))*"
                            : UsageFormat.tokens(merged.totalTokens)
                    )
                    .font(.system(.largeTitle, design: .default, weight: .bold))
                    .monospacedDigit()
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.55)
                    Text(
                        metric == .cost
                            ? "* if billed at full API rate"
                            : "Across \(UsageFormat.count(merged.sessions)) sessions"
                    )
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Picker("Chart metric", selection: $metric) {
                    ForEach(UsageMetric.allCases) { option in
                        Text(option.label).tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .tint(T3Colors.textPrimary)
            }

            if merged.daily.contains(where: {
                metric == .cost ? $0.costUsd > 0 : $0.totalTokens > 0
            }) {
                UsagePeriodChart(
                    input: windowInput,
                    daily: merged.daily,
                    hourly: merged.hourly,
                    metric: metric
                )
                .frame(height: 180)
            } else {
                Text("No activity in this window.")
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 180)
            }

            HStack(spacing: 8) {
                Text(UsageFormat.dayShort(windowInput.sinceDay))
                    .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 14) {
                    ForEach(merged.providers) { provider in
                        HStack(spacing: 5) {
                            Circle()
                                .fill(provider.provider.color)
                                .frame(width: 8, height: 8)
                            Text(provider.provider.displayName)
                        }
                    }
                }
                .fixedSize()

                Text(UsageFormat.dayShort(windowInput.untilDay))
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .font(.caption)
            .foregroundStyle(T3Colors.textTertiary)
        }
        .padding(16)
        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 24))
    }

    @ViewBuilder
    private var providersSection: some View {
        if !merged.providers.isEmpty {
            UsageSection(title: "Providers") {
                let ordered = merged.providers.sorted {
                    metric == .cost
                        ? $0.costUsd > $1.costUsd
                        : $0.totalTokens > $1.totalTokens
                }
                VStack(spacing: 0) {
                    ForEach(Array(ordered.enumerated()), id: \.element.id) { index, provider in
                        if index > 0 { usageDivider }
                        let share = metric == .cost ? provider.costShare : provider.tokenShare
                        VStack(alignment: .leading, spacing: 9) {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Circle()
                                    .fill(provider.provider.color)
                                    .frame(width: 10, height: 10)
                                Text(provider.provider.displayName)
                                    .font(.title3)
                                    .foregroundStyle(T3Colors.textPrimary)
                                Spacer(minLength: 8)
                                Text(
                                    metric == .cost
                                        ? UsageFormat.usd(provider.costUsd)
                                        : UsageFormat.tokens(provider.totalTokens)
                                )
                                .font(.title3)
                                .monospacedDigit()
                                .foregroundStyle(T3Colors.textPrimary)
                            }
                            UsageProgressBar(value: share, color: provider.provider.color)
                            Text(
                                metric == .cost
                                    ? "\(UsageFormat.percent(share)) of cost · "
                                        + "\(UsageFormat.tokens(provider.totalTokens)) tokens"
                                    : "\(UsageFormat.percent(share)) of tokens · \(UsageFormat.usd(provider.costUsd))"
                            )
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                        }
                        .padding(16)
                    }
                }
                .usageCard()
            }
        }
    }

    private var totalsSection: some View {
        UsageSection(title: "Totals") {
            let isHourly = windowInput.resolution == .hour
            let activePeriods = isHourly
                ? merged.hourly.filter { $0.totalTokens > 0 }.count
                : merged.daily.filter { $0.totalTokens > 0 }.count
            let periodAverage = activePeriods == 0 ? 0 : merged.totalTokens / activePeriods
            let observedInput = merged.uncachedInputTokens + merged.cachedInputTokens
            let cachedShare = observedInput == 0
                ? 0
                : Double(merged.cachedInputTokens) / Double(observedInput)
            LazyVGrid(
                columns: [GridItem(.flexible(), alignment: .topLeading), GridItem(.flexible(), alignment: .topLeading)],
                alignment: .leading,
                spacing: 0
            ) {
                UsageMetricCell(
                    label: "Processed tokens",
                    value: UsageFormat.tokens(merged.totalTokens),
                    detail: "\(UsageFormat.tokens(periodAverage)) per active \(isHourly ? "hour" : "day")"
                )
                UsageMetricCell(
                    label: "Cache savings",
                    value: UsageFormat.usd(merged.costQuality.cacheSavingsUsd),
                    detail: merged.costUsd > 0
                        ? String(format: "%.1fx the raw cost", merged.costQuality.cacheSavingsUsd / merged.costUsd)
                        : "vs full input rates"
                )
                UsageMetricCell(
                    label: "Cached input",
                    value: UsageFormat.tokens(merged.cachedInputTokens),
                    detail: "\(UsageFormat.percent(cachedShare)) of observed input"
                )
                UsageMetricCell(
                    label: "Uncached input",
                    value: UsageFormat.tokens(merged.uncachedInputTokens),
                    detail: "\(UsageFormat.tokens(merged.cacheCreationTokens)) cache writes"
                )
                UsageMetricCell(
                    label: "Output",
                    value: UsageFormat.tokens(merged.outputTokens),
                    detail: "incl. \(UsageFormat.tokens(merged.reasoningTokens)) reasoning"
                )
                UsageMetricCell(
                    label: "Unpriced",
                    value: UsageFormat.percent(merged.costQuality.unpricedShare),
                    detail: "of records, excluded from cost"
                )
            }
            .usageCard()
        }
    }

    private var breakdownSection: some View {
        UsageSection(title: "Breakdown") {
            VStack(spacing: 12) {
                Picker("Breakdown", selection: $breakdown) {
                    Text("Model").tag(UsageBreakdown.model)
                    Text(windowInput.resolution == .hour ? "Hour" : "Day")
                        .tag(UsageBreakdown.time)
                }
                .pickerStyle(.segmented)

                if breakdown == .model {
                    modelBreakdown
                } else {
                    timeBreakdown
                }
            }
        }
    }

    @ViewBuilder
    private var modelBreakdown: some View {
        if merged.models.isEmpty {
            Text("No activity in this window.")
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity)
                .padding(24)
                .usageCard()
        } else {
                VStack(spacing: 0) {
                    ForEach(Array(merged.models.enumerated()), id: \.element.id) { index, model in
                        if index > 0 { usageDivider }
                        HStack(spacing: 12) {
                            Circle()
                                .fill(model.provider.color)
                                .frame(width: 10, height: 10)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(model.model)
                                    .font(T3Typography.threadBody)
                                    .foregroundStyle(T3Colors.textPrimary)
                                    .lineLimit(1)
                                Text(
                                    "\(UsageFormat.percent(model.costShare)) of cost · "
                                        + "\(UsageFormat.tokens(model.totalTokens)) tokens"
                                )
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textSecondary)
                            }
                            Spacer(minLength: 8)
                            Text(UsageFormat.usd(model.costUsd))
                                .font(T3Typography.threadBody)
                                .monospacedDigit()
                                .foregroundStyle(T3Colors.textPrimary)
                        }
                        .padding(16)
                    }
                }
                .usageCard()
        }
    }

    @ViewBuilder
    private var timeBreakdown: some View {
        let periods = usagePeriods
        if periods.isEmpty {
            Text("No activity in this window.")
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity)
                .padding(24)
                .usageCard()
        } else {
            LazyVStack(spacing: 0) {
                ForEach(Array(periods.enumerated()), id: \.element.id) { index, period in
                    if index > 0 { usageDivider }
                    HStack(spacing: 12) {
                        Text(period.label)
                            .font(T3Typography.threadBody)
                            .foregroundStyle(T3Colors.textPrimary)
                        Spacer(minLength: 8)
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(UsageFormat.usd(period.costUsd))
                                .font(T3Typography.threadBody)
                                .monospacedDigit()
                                .foregroundStyle(T3Colors.textPrimary)
                            Text(UsageFormat.tokens(period.totalTokens))
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                    }
                    .padding(16)
                }
            }
            .usageCard()
        }
    }

    private var usagePeriods: [UsagePeriodPresentation] {
        if windowInput.resolution == .hour {
            return merged.hourly.reversed().map {
                UsagePeriodPresentation(
                    id: $0.hourStart,
                    label: UsageFormat.hourShort($0.hourStart, timeZone: windowInput.timeZone),
                    costUsd: $0.costUsd,
                    totalTokens: $0.totalTokens
                )
            }
        }
        return merged.daily.reversed().map {
            UsagePeriodPresentation(
                id: $0.day,
                label: UsageFormat.dayShort($0.day),
                costUsd: $0.costUsd,
                totalTokens: $0.totalTokens
            )
        }
    }

    private var usageDivider: some View {
        Divider().overlay(T3Colors.separator)
    }

    private var hasCompatibleSummary: Bool {
        environments.contains {
            $0.summary.map {
                isCompatibleUsageContractVersion($0.contractVersion, resolution: windowInput.resolution)
            } == true
        }
    }

    private var hasDailyOnlySummary: Bool {
        windowInput.resolution == .hour
            && environments.contains { $0.summary?.contractVersion == 3 }
    }

    private func load(refreshPricing: Bool = false) async {
        let request = loadState.begin(days: loadState.windowDays)
        defer { loadState.finish(request) }
        do {
            for try await result in client.usageSummaryUpdates(request.input, refreshPricing: refreshPricing) {
                try Task.checkCancellation()
                loadState.receive(result, for: request)
            }
        } catch is CancellationError {
            return
        } catch {
            loadState.fail(error, for: request)
        }
    }
}

private struct UsagePeriodChart: View {
    let input: UsageSummaryInput
    let daily: [UsageDailyTotals]
    let hourly: [UsageHourlyTotals]
    let metric: UsageMetric

    private var segments: [UsageChartSegment] {
        if input.resolution == .hour {
            let hourlyByStart = Dictionary(uniqueKeysWithValues: hourly.map { ($0.hourStart, $0) })
            return UsageWindow.hours(in: input).flatMap { hourStart in
                chartSegments(
                    period: hourStart,
                    byProvider: hourlyByStart[hourStart]?.byProvider ?? [:]
                )
            }
        }
        let dailyByDay = Dictionary(uniqueKeysWithValues: daily.map { ($0.day, $0) })
        return UsageWindow.days(in: input).flatMap { day in
            chartSegments(period: day, byProvider: dailyByDay[day]?.byProvider ?? [:])
        }
    }

    private func chartSegments(
        period: String,
        byProvider: [UsageProviderKind: UsageProviderValue]
    ) -> [UsageChartSegment] {
        var start = 0.0
        return UsageProviderKind.allCases.map { provider in
            let totals = byProvider[provider]
            let value = metric == .cost
                ? totals?.costUsd ?? 0
                : Double(totals?.totalTokens ?? 0)
            defer { start += value }
            return UsageChartSegment(
                period: period,
                provider: provider,
                start: start,
                end: start + value
            )
        }
    }

    var body: some View {
        Chart(segments) { segment in
            BarMark(
                x: .value("Period", segment.period),
                yStart: .value("Start", segment.start),
                yEnd: .value("End", segment.end)
            )
            .foregroundStyle(segment.provider.color)
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
    }
}

private struct UsageChartSegment: Identifiable {
    let period: String
    let provider: UsageProviderKind
    let start: Double
    let end: Double

    var id: String { "\(period):\(provider.rawValue)" }
}

private struct UsagePeriodPresentation: Identifiable {
    let id: String
    let label: String
    let costUsd: Double
    let totalTokens: Int
}

private struct UsageSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textSecondary)
                .padding(.horizontal, 14)
            content
        }
    }
}

private struct UsageMetricCell: View {
    let label: String
    let value: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
            Text(value)
                .font(.title3.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(detail)
                .font(.caption)
                .foregroundStyle(T3Colors.textTertiary)
                .lineLimit(2)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct UsageProgressBar: View {
    let value: Double
    let color: Color

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(T3Colors.subtle)
                Capsule()
                    .fill(color)
                    .frame(width: geometry.size.width * min(max(value, 0), 1))
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }
}

private extension View {
    func usageCard() -> some View {
        background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 24))
    }
}

private extension UsageProviderKind {
    var color: Color {
        switch self {
        case .codex: T3Colors.textPrimary
        case .claude: Color(red: 0.851, green: 0.467, blue: 0.341)
        case .grok: T3Colors.textSecondary
        }
    }
}

private enum UsageFormat {
    static func usd(_ value: Double) -> String {
        value.formatted(
            .currency(code: "USD")
                .locale(Locale(identifier: "en_US"))
                .precision(.fractionLength(2))
        )
    }

    static func count(_ value: Int) -> String {
        value.formatted(.number.locale(Locale(identifier: "en_US")))
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
        String(format: "%.1f%%", value * 100)
    }

    static func dayShort(_ day: String) -> String {
        let components = day.split(separator: "-")
        guard components.count == 3,
              let month = Int(components[1]),
              let dayOfMonth = Int(components[2]),
              (1...12).contains(month) else {
            return day
        }
        let months = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun",
            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ]
        return "\(months[month - 1]) \(dayOfMonth)"
    }

    static func hourShort(_ value: String, timeZone: String) -> String {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = withFractional.date(from: value)
                ?? ISO8601DateFormatter().date(from: value) else {
            return value
        }
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.timeZone = TimeZone(identifier: timeZone) ?? .current
        formatter.setLocalizedDateFormatFromTemplate("EEEha")
        return formatter.string(from: date)
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
