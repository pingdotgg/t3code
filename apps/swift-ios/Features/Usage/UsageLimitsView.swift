import SwiftUI

struct UsageLimitsView: View {
    let client: any FeatureClient
    @Binding var resetCreditStates: [UsageResetCreditTarget: UsageResetCreditState]
    /// The parent keeps this view mounted behind the usage tab. Only the visible
    /// tab may add toolbar items.
    var isActive = true

    @State private var environments: [FeatureEnvironmentUsageLimits] = []
    @State private var groups: [UsageLimitsGroup] = []
    @State private var hasSnapshot = false
    @State private var isRefreshing = false
    @State private var streamError: String?
    @State private var refreshError: String?
    @State private var refreshErrors: [String: String] = [:]
    @State private var now = Date()
    @State private var subscriptionID = UUID()
    /// Subscriptions start on the first visit and then outlive tab switches.
    @State private var hasActivated = false

    private var hasLimits: Bool { groups.contains(where: \.hasLimits) }
    private var isWaiting: Bool {
        !hasSnapshot || (!environments.isEmpty && environments.allSatisfy {
            $0.isPending && $0.providers.isEmpty && $0.sources.isEmpty
        })
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                if let streamError { notice(streamError) }
                if let refreshError { notice(refreshError) }
                if isRefreshing {
                    notice("Refreshing limits...")
                } else if hasLimits, environments.contains(where: \.isPending) {
                    notice("Some environments are still reporting limits.")
                }

                if isWaiting, streamError == nil {
                    Text("Loading subscription limits")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 64)
                } else if environments.isEmpty {
                    ContentUnavailableView {
                        Label("No limits available", systemImage: "chart.bar.xaxis")
                    } description: {
                        Text("Connect an environment to see subscription limits.")
                    }
                } else {
                    ForEach(groups) { group in
                        environmentSection(group)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 32)
        }
        .scrollIndicators(.hidden)
        .refreshable { await refresh() }
        .toolbar {
            if isActive {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Refresh limits", systemImage: "arrow.clockwise") {
                        Task { await refresh() }
                    }
                    .disabled(isRefreshing)
                }
            }
        }
        .onChange(of: isActive, initial: true) { _, active in
            if active { hasActivated = true }
        }
        .task(id: hasActivated ? subscriptionID : nil) {
            guard hasActivated else { return }
            let subscription = subscriptionID
            do {
                for try await snapshot in client.usageLimitsUpdates() {
                    try Task.checkCancellation()
                    guard subscription == subscriptionID else { return }
                    receive(snapshot)
                    streamError = nil
                }
            } catch is CancellationError {
                return
            } catch {
                streamError = "Could not load live limits. Refresh to check the latest values."
            }
        }
    }

    private func environmentSection(_ group: UsageLimitsGroup) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(group.environment.label)
                .font(T3Typography.threadHeading3)
                .foregroundStyle(T3Colors.textPrimary)

            if let error = refreshErrors[group.id] {
                notice("Could not refresh limits. \(error)")
            }
            if let error = group.environment.errorMessage,
               error != refreshErrors[group.id] {
                notice(error)
            } else if !group.environment.isConnected, !group.environment.isPending {
                notice(group.hasLimits
                    ? "Disconnected. Showing the last known limits."
                    : "Connect this environment to see limits.")
            }

            if !group.hasLimits {
                if group.environment.isPending {
                    notice("Waiting for this environment...")
                } else if group.environment.isConnected, group.environment.errorMessage == nil {
                    notice("No provider reports subscription limits.")
                }
            }

            ForEach(Array(group.providers.enumerated()), id: \.element.instanceId) { index, provider in
                if index > 0 { Divider().overlay(T3Colors.separator) }
                if let limits = provider.usageLimits {
                    VStack(alignment: .leading, spacing: 12) {
                        UsageLimitsAccountView(
                            driver: provider.driver,
                            instanceID: provider.instanceId,
                            label: provider.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
                                .nonEmpty ?? UsageLimitsPresentation.providerLabel(driver: provider.driver),
                            detail: provider.auth.label,
                            limits: limits,
                            now: now
                        )
                        if let credits = limits.resetCredits {
                            UsageResetCreditsView(
                                client: client,
                                environmentID: group.environment.environmentID,
                                input: .provider(instanceID: provider.instanceId),
                                isConnected: group.environment.isConnected && !group.environment.isPending,
                                credits: credits,
                                now: now,
                                state: resetState(environmentID: group.id, account: .provider(provider.instanceId))
                            )
                        }
                    }
                }
            }

            ForEach(group.sources) { source in
                sourceSection(source, environment: group.environment)
            }
        }
    }

    private func sourceSection(_ row: UsageLimitSourceRows, environment: FeatureEnvironmentUsageLimits) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(row.source.label)
                .font(T3Typography.control)
                .foregroundStyle(T3Colors.textPrimary)
            if let error = row.source.error {
                notice(error)
            } else if row.accounts.isEmpty {
                notice(row.hiddenAccountCount > 0
                    ? "These accounts are shown by connected providers."
                    : "No accounts reported.")
            } else {
                ForEach(row.accounts) { account in
                    UsageLimitsAccountView(
                        driver: account.driver,
                        instanceID: account.id,
                        label: UsageLimitsPresentation.providerLabel(driver: account.driver),
                        detail: account.plan,
                        limits: account.usageLimits,
                        now: now
                    )
                    if let credits = account.usageLimits.resetCredits {
                        UsageResetCreditsView(
                            client: client,
                            environmentID: environment.id,
                            input: credits.nextCreditId.map {
                                .source(sourceID: row.id, accountID: account.id, creditID: $0)
                            },
                            isConnected: environment.isConnected && !environment.isPending,
                            credits: credits,
                            now: now,
                            state: resetState(
                                environmentID: environment.id,
                                account: .source(sourceID: row.id, accountID: account.id)
                            )
                        )
                    }
                }
            }
        }
        .padding(.top, 8)
    }

    private func notice(_ message: String) -> some View {
        Text(message)
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func receive(_ snapshot: [FeatureEnvironmentUsageLimits]) {
        environments = UsageLimitsPresentation.retainingPendingRows(snapshot, previous: environments)
        groups = UsageLimitsPresentation.groups(environments)
        hasSnapshot = true
        now = Date()
        let ids = Set(snapshot.map(\.environmentID))
        refreshErrors = refreshErrors.filter { ids.contains($0.key) }
    }

    private func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        refreshError = nil
        refreshErrors = [:]
        defer {
            isRefreshing = false
            // A failed stream has ended. Only then does a manual refresh start a
            // new subscription. A healthy stream keeps its sockets open.
            if !Task.isCancelled, streamError != nil { subscriptionID = UUID() }
        }
        do {
            let result = try await client.refreshUsageLimits()
            try Task.checkCancellation()
            // Live config carries the new bars. Keep operation errors separate
            // so a later config snapshot cannot silently remove them.
            refreshErrors = Dictionary(uniqueKeysWithValues: result.compactMap { environment in
                environment.errorMessage.map { (environment.environmentID, $0) }
            })
            if !hasSnapshot || streamError != nil { receive(result) }
            now = Date()
        } catch is CancellationError {
            return
        } catch {
            refreshError = "Could not refresh limits. Showing the last known values."
        }
    }

    private func resetState(environmentID: String, account: UsageResetCreditTarget.Account) -> Binding<UsageResetCreditState> {
        let target = UsageResetCreditTarget(environmentID: environmentID, account: account)
        return Binding(
            get: { resetCreditStates[target] ?? UsageResetCreditState() },
            set: { resetCreditStates[target] = $0 }
        )
    }
}

private struct UsageLimitsAccountView: View {
    let driver: String
    let instanceID: String
    let label: String
    let detail: String?
    let limits: ServerProviderUsageLimits
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                ProviderIcon(driver: driver, providerID: instanceID, fallbackName: label, size: 18)
                UsageAccountLabel(value: label)
                    .font(T3Typography.control)
                    .foregroundStyle(T3Colors.textPrimary)
                if let detail {
                    UsageAccountLabel(value: detail)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(2)
                }
            }
            if let notice = UsageLimitsPresentation.limitsNotice(limits) {
                Text(notice)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            ForEach(UsageLimitsPresentation.visibleWindows(limits)) { window in
                UsageLimitWindowView(window: window, driver: driver, now: now)
            }
        }
    }
}

private struct UsageAccountLabel: View {
    let value: String
    @State private var isRevealed = false

    var body: some View {
        if value.contains("@") {
            Button {
                isRevealed.toggle()
            } label: {
                Text(isRevealed ? value : "••••••@••••••")
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isRevealed ? "Hide account label" : "Reveal account label")
            .onChange(of: value) { isRevealed = false }
        } else {
            Text(value)
        }
    }
}

private struct UsageLimitWindowView: View {
    let window: ServerProviderUsageWindow
    let driver: String
    let now: Date

    var body: some View {
        if window.resetsAt != nil {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                content(now: context.date)
            }
        } else {
            content(now: now)
        }
    }

    private func content(now: Date) -> some View {
        let remaining = UsageLimitsMath.remainingPercent(window)
        let timeLeft = UsageLimitsMath.elapsedShare(window, now: now).map { 1 - $0 }
        let pace = UsageLimitsMath.pace(window, now: now)
        let resetsIn = UsageLimitsMath.resetsIn(window, now: now)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(window.label)
                Spacer(minLength: 8)
                Text("\(Int(remaining))% left")
                    .monospacedDigit()
            }
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textPrimary)

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(T3Colors.subtleStrong)
                        .frame(height: 6)
                    Capsule().fill(barColor(remaining: remaining))
                        .frame(width: geometry.size.width * remaining / 100, height: 6)
                    if let timeLeft {
                        Rectangle().fill(T3Colors.textSecondary)
                            .frame(width: 1, height: 12)
                            .offset(x: max(0, geometry.size.width - 1) * timeLeft)
                    }
                }
                .frame(height: 12)
            }
            .frame(height: 12)
            .accessibilityHidden(true)

            if pace != nil || resetsIn != nil {
                HStack(alignment: .firstTextBaseline) {
                    if let pace { Text(pace.label) }
                    Spacer(minLength: 8)
                    if let resetsIn { Text(resetsIn).monospacedDigit() }
                }
                .font(.caption)
                .foregroundStyle(T3Colors.textTertiary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func barColor(remaining: Double) -> Color {
        if remaining <= 10 { return T3Colors.danger }
        if remaining <= 30 { return T3Colors.warning }
        return driver == "claudeAgent" ? UsageProviderKind.claudeColor : T3Colors.textPrimary
    }
}

private struct UsageResetCreditsView: View {
    let client: any FeatureClient
    let environmentID: String
    let input: ProviderConsumeResetCreditInput?
    let isConnected: Bool
    let credits: ServerProviderResetCredits
    let now: Date
    @Binding var state: UsageResetCreditState

    @State private var confirmationPresented = false
    @State private var confirmedInput: ProviderConsumeResetCreditInput?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(UsageLimitsMath.creditSummary(credits, now: now))
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
            if (credits.availableCount > 0 && input != nil) || state.isPending {
                Button(state.isPending ? "Using credit..." : "Use a reset credit") {
                    confirmedInput = input
                    confirmationPresented = true
                }
                .font(T3Typography.control)
                .foregroundStyle(T3Colors.textPrimary)
                .frame(minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
                .disabled(state.isPending || !isConnected)
            }
            if let status = state.statusMessage {
                Text(status)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
        }
        .alert("Use a reset credit?", isPresented: $confirmationPresented) {
            Button("Cancel", role: .cancel) {}
            Button("Use credit") { Task { await redeem() } }
        } message: {
            Text("This uses one credit on your account and clears the current rate-limit windows. You cannot undo it.")
        }
    }

    private func redeem() async {
        // Live updates can replace the next credit while the confirmation is open.
        // Send the credit the user saw, never a later one.
        guard let confirmedInput,
              state.begin(availableCount: credits.availableCount, isConnected: isConnected) else { return }
        do {
            let result = try await client.consumeResetCredit(environmentID: environmentID, input: confirmedInput)
            state.finish(result.outcome, warning: result.warning)
        } catch {
            state.fail(error)
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
