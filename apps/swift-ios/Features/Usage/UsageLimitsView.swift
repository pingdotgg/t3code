import SwiftUI

struct UsageLimitsView: View {
    let client: any FeatureClient
    @Binding var resetCreditStates: [UsageResetCreditTarget: UsageResetCreditState]

    @State private var environments: [FeatureEnvironmentUsageLimits] = []
    @State private var hasSnapshot = false
    @State private var isRefreshing = false
    @State private var streamError: String?
    @State private var refreshError: String?
    @State private var refreshErrors: [String: String] = [:]
    @State private var now = Date()
    @State private var subscriptionID = UUID()

    private var groups: [UsageLimitsGroup] { UsageLimitsPresentation.groups(environments) }
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
                    Text("Loading subscription limits...")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
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
            ToolbarItem(placement: .topBarTrailing) {
                Button("Refresh limits", systemImage: "arrow.clockwise") {
                    Task { await refresh() }
                }
                .disabled(isRefreshing)
            }
        }
        .task(id: subscriptionID) {
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
                                instanceID: provider.instanceId,
                                isConnected: group.environment.isConnected && !group.environment.isPending,
                                credits: credits,
                                now: now,
                                state: resetState(environmentID: group.id, instanceID: provider.instanceId)
                            )
                        }
                    }
                }
            }

            ForEach(group.sources) { source in
                sourceSection(source)
            }
        }
    }

    private func sourceSection(_ row: UsageLimitSourceRows) -> some View {
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
            // A failed environment's stream has ended. A manual refresh starts
            // a new subscription so that environment can report live updates again.
            if !Task.isCancelled { subscriptionID = UUID() }
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

    private func resetState(environmentID: String, instanceID: String) -> Binding<UsageResetCreditState> {
        let target = UsageResetCreditTarget(environmentID: environmentID, instanceID: instanceID)
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
                Text(label)
                    .font(T3Typography.control)
                    .foregroundStyle(T3Colors.textPrimary)
                if let detail {
                    Text(detail)
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

private struct UsageLimitWindowView: View {
    let window: ServerProviderUsageWindow
    let driver: String
    let now: Date

    var body: some View {
        let used = UsageLimitsMath.usedPercent(window)
        let elapsed = UsageLimitsMath.elapsedShare(window, now: now)
        let pace = UsageLimitsMath.pace(window, now: now)
        let resetsIn = UsageLimitsMath.resetsIn(window, now: now)
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(window.label)
                Spacer(minLength: 8)
                Text("\(Int(used.rounded()))%")
                    .monospacedDigit()
            }
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textPrimary)

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(T3Colors.subtleStrong)
                        .frame(height: 6)
                    Capsule().fill(barColor(used: used))
                        .frame(width: geometry.size.width * used / 100, height: 6)
                    if let elapsed {
                        Rectangle().fill(T3Colors.textSecondary)
                            .frame(width: 1, height: 12)
                            .offset(x: max(0, geometry.size.width - 1) * elapsed)
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

    private func barColor(used: Double) -> Color {
        if used >= 90 { return T3Colors.danger }
        if used >= 70 { return T3Colors.warning }
        return driver == "claudeAgent"
            ? Color(red: 0.851, green: 0.467, blue: 0.341)
            : T3Colors.textPrimary
    }
}

private struct UsageResetCreditsView: View {
    let client: any FeatureClient
    let environmentID: String
    let instanceID: String
    let isConnected: Bool
    let credits: ServerProviderResetCredits
    let now: Date
    @Binding var state: UsageResetCreditState

    @State private var confirmationPresented = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(UsageLimitsMath.creditSummary(credits, now: now))
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
            if credits.availableCount > 0 || state.isPending {
                Button(state.isPending ? "Using credit..." : "Use a reset credit") {
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
        guard state.begin(availableCount: credits.availableCount, isConnected: isConnected) else { return }
        do {
            let result = try await client.consumeResetCredit(environmentID: environmentID, instanceID: instanceID)
            state.finish(result.outcome)
        } catch {
            state.fail(error)
        }
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
