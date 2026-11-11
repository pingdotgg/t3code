import Charts
import SwiftUI

private enum UsageMetric: String, CaseIterable, Identifiable {
    case cost
    case tokens

    var id: Self { self }
    var title: String { self == .cost ? "Cost" : "Tokens" }
}

private enum UsageBreakdown {
    case model
    case time
}

private enum UsageTab: String {
    case usage
    case limits
}

private let usageWindowOptions: [(days: Int, short: String, title: String)] = [
    (1, "24h", "Last 24 hours"),
    (7, "7d", "Last 7 days"),
    (30, "30d", "Last 30 days"),
    (90, "90d", "Last 90 days"),
]

public struct UsageView: View {
    private let client: any FeatureClient

    @State private var loadState = UsageLoadState()
    /// The state shown while the user scrolls. Streamed results wait here until
    /// the scroll settles, so rows never shift under a moving finger.
    @State private var heldState: UsageLoadState?
    @State private var metric = UsageMetric.cost
    @State private var tab = UsageTab.usage
    @State private var hasActivatedUsage = false
    @State private var resetCreditStates: [UsageResetCreditTarget: UsageResetCreditState] = [:]

    public init(client: any FeatureClient, initiallyShowsLimits: Bool = false) {
        self.client = client
        _tab = State(initialValue: initiallyShowsLimits ? .limits : .usage)
    }

    private var windowDays: Binding<Int> {
        Binding(
            get: { loadState.windowDays },
            set: { loadState.selectWindow(days: $0) }
        )
    }

    public var body: some View {
        // Both tabs stay mounted. Switching only toggles visibility, so the
        // usage load and every limit subscription survive a tab change.
        ZStack {
            ScrollView {
                UsageSummaryContent(state: heldState ?? loadState, metric: metric)
                    .padding(.horizontal, 20)
                    .padding(.top, 16)
                    .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .refreshable { await load() }
            .modifier(UsageScrollActivity { isScrolling in
                if isScrolling, heldState == nil {
                    heldState = loadState
                } else if !isScrolling, heldState != nil {
                    heldState = nil
                }
            })
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
        .background(T3Colors.background)
        .navigationTitle("Usage")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Usage view", selection: $tab) {
                    Text("Usage").tag(UsageTab.usage)
                    Text("Limits").tag(UsageTab.limits)
                }
                .pickerStyle(.segmented)
                .fixedSize()
            }
            if tab == .usage {
                ToolbarItem(placement: .topBarTrailing) { usageOptions }
            }
        }
        .t3NavigationChrome()
        .onChange(of: tab, initial: true) { _, selected in
            if selected == .usage { hasActivatedUsage = true }
        }
        .task(id: hasActivatedUsage ? loadState.windowDays : nil) {
            guard hasActivatedUsage else { return }
            await load()
        }
    }

    /// Window, chart metric, and price refresh share one bar button. The label
    /// shows the window because the content no longer does.
    private var usageOptions: some View {
        let window = usageWindowOptions.first { $0.days == loadState.windowDays }
        return Menu {
            Section("Window") {
                Picker("Window", selection: windowDays) {
                    ForEach(usageWindowOptions, id: \.days) { option in
                        Text(option.title).tag(option.days)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
            Section("Chart") {
                Picker("Chart", selection: $metric) {
                    ForEach(UsageMetric.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
            Section {
                Button("Refresh prices", systemImage: "arrow.clockwise") {
                    Task { await load(refreshPricing: true) }
                }
                .disabled(loadState.isLoading)
            }
        } label: {
            Text(window?.short ?? "\(loadState.windowDays)d")
                .monospacedDigit()
        }
        .accessibilityLabel("Usage options")
        .accessibilityValue("\(window?.title ?? ""), \(metric.title)")
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

/// Reports when the user starts and stops scrolling. iOS 17 has no scroll
/// phase, so there results always apply at once.
private struct UsageScrollActivity: ViewModifier {
    let onChange: (Bool) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content.onScrollPhaseChange { _, phase in onChange(phase.isScrolling) }
        } else {
            content
        }
    }
}

/// Everything below the toolbar. It is a plain stack on purpose: the screen
/// has a few heavy sections and at most 90 short rows, so laying them out once
/// is cheaper than a lazy stack that rebuilds the chart on every scroll pass.
private struct UsageSummaryContent: View {
    let state: UsageLoadState
    let metric: UsageMetric

    private var windowInput: UsageSummaryInput { state.windowInput }
    private var environments: [FeatureEnvironmentUsage] { state.environments }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            UsageCoverageNotice(state: state, hasCompatibleSummary: hasCompatibleSummary)

            if state.isLoading, !hasCompatibleSummary,
               environments.isEmpty || environments.contains(where: \.isPending) {
                Text("Scanning provider transcripts")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 64)
            } else if let errorMessage = state.errorMessage, environments.isEmpty {
                ContentUnavailableView {
                    Label("Couldn’t load usage", systemImage: "exclamationmark.circle")
                } description: {
                    Text(errorMessage)
                } actions: {
                    UsageRetryButton()
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
                    UsageRetryButton()
                }
            } else {
                let merged = state.merged
                let presentation = state.presentation
                let isHourly = windowInput.resolution == .hour
                UsageChartSection(merged: merged, presentation: presentation, metric: metric)
                UsageDivider()
                UsageProvidersSection(
                    providers: metric == .cost ? presentation.providersByCost : presentation.providersByTokens,
                    metric: metric
                )
                UsageDivider()
                UsageTotalsSection(merged: merged, presentation: presentation, isHourly: isHourly)
                UsageDivider()
                UsageBreakdownSection(models: merged.models, periods: presentation.periods, isHourly: isHourly)
            }
        }
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
}

/// Runs the scroll view's refresh action, which reloads usage.
private struct UsageRetryButton: View {
    @SwiftUI.Environment(\.refresh) private var refresh

    var body: some View {
        Button("Try again") { Task { await refresh?() } }
    }
}

private struct UsageCoverageNotice: View {
    let state: UsageLoadState
    let hasCompatibleSummary: Bool

    var body: some View {
        let environments = state.environments
        let merged = state.merged
        let failed = environments.filter { $0.errorMessage != nil }
        let stale = environments.filter { merged.staleEnvironments.contains($0.environmentID) }
        let hasRefreshError = state.errorMessage != nil && hasCompatibleSummary
        if hasRefreshError
            || state.isPartial
            || state.hasPendingCachedTotals
            || !failed.isEmpty
            || !stale.isEmpty
            || !merged.duplicateSources.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                if state.hasPendingCachedTotals {
                    Text(state.isPartial
                        ? "Updating usage. Totals are partial and include the last scan."
                        : "Updating usage. Some totals are from the last scan.")
                } else if state.isPartial {
                    Text("Some environments are still reporting. Totals are partial.")
                }
                if hasRefreshError {
                    Text("Couldn’t refresh usage. The totals below are from the last successful scan.")
                }
                ForEach(failed) { environment in
                    Text("\(environment.label): \(environment.errorMessage ?? "Could not report usage.")")
                }
                ForEach(stale) { environment in
                    if state.windowInput.resolution == .hour, environment.summary?.contractVersion == 3 {
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
}

private struct UsageChartSection: View {
    let merged: MergedUsage
    let presentation: UsagePresentation
    let metric: UsageMetric

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
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
                            + (merged.costQuality.unpricedShare > 0
                                ? ". Excludes \(UsageFormat.percent(merged.costQuality.unpricedShare)) unpriced records."
                                : "")
                        : "Across \(UsageFormat.count(merged.sessions)) sessions"
                )
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if metric == .cost ? presentation.hasCostActivity : presentation.hasTokenActivity {
                UsagePeriodChart(
                    segments: metric == .cost ? presentation.costSegments : presentation.tokenSegments,
                    periods: presentation.chartPeriods
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
}

private struct UsageProvidersSection: View {
    let providers: [UsageProviderTotals]
    let metric: UsageMetric

    var body: some View {
        if !providers.isEmpty {
            UsageSection(title: "Providers") {
                VStack(spacing: 0) {
                    ForEach(providers.enumerated(), id: \.element.id) { index, provider in
                        UsageProviderRow(provider: provider, metric: metric)
                            .usageRowDivider(index > 0)
                    }
                }
            }
        }
    }
}

private struct UsageProviderRow: View {
    let provider: UsageProviderTotals
    let metric: UsageMetric

    var body: some View {
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

private struct UsageTotalsSection: View {
    let merged: MergedUsage
    let presentation: UsagePresentation
    let isHourly: Bool

    var body: some View {
        UsageSection(title: "Totals") {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
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
                }
                GridRow {
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
                }
                GridRow {
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
    }
}

private struct UsageBreakdownSection: View {
    let models: [UsageModelTotals]
    let periods: [UsagePeriodRow]
    let isHourly: Bool

    @State private var breakdown = UsageBreakdown.model

    var body: some View {
        UsageSection(title: "Breakdown") {
            VStack(spacing: 4) {
                Picker("Breakdown", selection: $breakdown) {
                    Text("Model").tag(UsageBreakdown.model)
                    Text(isHourly ? "Hour" : "Day").tag(UsageBreakdown.time)
                }
                .pickerStyle(.segmented)

                if breakdown == .model ? models.isEmpty : periods.isEmpty {
                    Text("No activity in this window.")
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                } else if breakdown == .model {
                    VStack(spacing: 0) {
                        ForEach(models.enumerated(), id: \.element.id) { index, model in
                            UsageModelRow(model: model)
                                .usageRowDivider(index > 0)
                        }
                    }
                } else {
                    VStack(spacing: 0) {
                        ForEach(periods.enumerated(), id: \.element.id) { index, period in
                            UsagePeriodRowView(period: period)
                                .usageRowDivider(index > 0)
                        }
                    }
                }
            }
        }
    }
}

private struct UsageModelRow: View {
    let model: UsageModelTotals

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(model.provider.color)
                .frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.model)
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                Text("\(model.costShareLabel) · \(UsageFormat.tokens(model.totalTokens)) tokens")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            Spacer(minLength: 8)
            Text(model.costLabel)
                .font(T3Typography.threadBody)
                .monospacedDigit()
                .foregroundStyle(T3Colors.textPrimary)
        }
        .padding(.vertical, 10)
    }
}

private struct UsagePeriodRowView: View {
    let period: UsagePeriodRow

    var body: some View {
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

private struct UsageDivider: View {
    var body: some View {
        Divider().overlay(T3Colors.separator)
    }
}

private extension View {
    /// Draws the separator inside the row, so each row stays one view.
    func usageRowDivider(_ isVisible: Bool) -> some View {
        overlay(alignment: .top) {
            if isVisible { UsageDivider() }
        }
    }
}

private struct UsagePeriodChart: View {
    let segments: [UsageChartSegment]
    /// Every period in the window, so empty days or hours keep their slot.
    let periods: [String]

    var body: some View {
        Chart(segments) { segment in
            BarMark(
                x: .value("Period", segment.period),
                yStart: .value("Start", segment.start),
                yEnd: .value("End", segment.end)
            )
            .foregroundStyle(segment.provider.color)
        }
        .chartXScale(domain: periods)
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
        case .cursor: .blue
        case .opencode: .purple
        case .antigravity: .green
        }
    }
}
