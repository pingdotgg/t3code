import Charts
import SwiftUI

private enum UsageMetric: String, CaseIterable, Identifiable {
    case cost
    case tokens

    var id: Self { self }
    var label: String { rawValue.uppercased() }
}

private enum UsageBreakdown {
    case model
    case time
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
    private var presentation: UsagePresentation { loadState.presentation }
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

            // Both tabs stay mounted. Switching only toggles visibility, so the
            // usage load and every limit subscription survive a tab change.
            ZStack {
                usageContent
                    .opacity(tab == .usage ? 1 : 0)
                    .allowsHitTesting(tab == .usage)
                    .accessibilityHidden(tab != .usage)
                UsageLimitsView(
                    client: client,
                    resetCreditStates: $resetCreditStates,
                    isActive: tab == .limits
                )
                .opacity(tab == .limits ? 1 : 0)
                .allowsHitTesting(tab == .limits)
                .accessibilityHidden(tab != .limits)
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
        .task(id: loadState.windowDays) {
            await load()
        }
    }

    private var usageContent: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
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
                    Text("Scanning provider transcripts")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
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
                    chartSection
                    usageDivider
                    providersSection
                    usageDivider
                    totalsSection
                    usageDivider
                    breakdownSection
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 32)
        }
        .scrollIndicators(.hidden)
        .refreshable { await load() }
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
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var chartSection: some View {
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

            if metric == .cost ? presentation.hasCostActivity : presentation.hasTokenActivity {
                UsagePeriodChart(
                    segments: metric == .cost ? presentation.costSegments : presentation.tokenSegments
                )
                .frame(height: 180)
            } else {
                Text("No activity in this window.")
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(maxWidth: .infinity, minHeight: 180)
            }

            HStack(spacing: 8) {
                Text(presentation.sinceLabel)
                    .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 14) {
                    ForEach(presentation.providersByCost) { provider in
                        HStack(spacing: 5) {
                            Circle()
                                .fill(provider.provider.color)
                                .frame(width: 8, height: 8)
                            Text(provider.provider.displayName)
                        }
                    }
                }
                .fixedSize()

                Text(presentation.untilLabel)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .font(.caption)
            .foregroundStyle(T3Colors.textTertiary)
        }
    }

    @ViewBuilder
    private var providersSection: some View {
        let ordered = metric == .cost ? presentation.providersByCost : presentation.providersByTokens
        if !ordered.isEmpty {
            UsageSection(title: "Providers") {
                VStack(spacing: 0) {
                    ForEach(Array(ordered.enumerated()), id: \.element.id) { index, provider in
                        if index > 0 { usageDivider }
                        let share = metric == .cost ? provider.costShare : provider.tokenShare
                        VStack(alignment: .leading, spacing: 8) {
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
                        .padding(.vertical, 10)
                    }
                }
            }
        }
    }

    private var totalsSection: some View {
        UsageSection(title: "Totals") {
            let isHourly = windowInput.resolution == .hour
            LazyVGrid(
                columns: [GridItem(.flexible(), alignment: .topLeading), GridItem(.flexible(), alignment: .topLeading)],
                alignment: .leading,
                spacing: 0
            ) {
                UsageMetricCell(
                    label: "Processed tokens",
                    value: UsageFormat.tokens(merged.totalTokens),
                    detail: "\(UsageFormat.tokens(presentation.periodAverageTokens)) per active \(isHourly ? "hour" : "day")"
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
                    detail: "\(UsageFormat.percent(presentation.cachedInputShare)) of observed input"
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
        }
    }

    private var breakdownSection: some View {
        UsageSection(title: "Breakdown") {
            VStack(spacing: 4) {
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
            noActivity
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
                    .padding(.vertical, 10)
                }
            }
        }
    }

    @ViewBuilder
    private var timeBreakdown: some View {
        if presentation.periods.isEmpty {
            noActivity
        } else {
            LazyVStack(spacing: 0) {
                ForEach(Array(presentation.periods.enumerated()), id: \.element.id) { index, period in
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
                    .padding(.vertical, 10)
                }
            }
        }
    }

    private var noActivity: some View {
        Text("No activity in this window.")
            .font(T3Typography.threadBody)
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
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
    let segments: [UsageChartSegment]

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

private struct UsageSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(T3Typography.navigationTitle)
                .foregroundStyle(T3Colors.textPrimary)
                .accessibilityAddTraits(.isHeader)
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
        .padding(.vertical, 8)
        .padding(.trailing, 12)
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

extension UsageProviderKind {
    /// Claude's brand orange. Usage charts and limit bars share this one value.
    static let claudeColor = Color(red: 0.851, green: 0.467, blue: 0.341)

    var color: Color {
        switch self {
        case .codex: T3Colors.textPrimary
        case .claude: Self.claudeColor
        case .grok: T3Colors.textSecondary
        }
    }
}
