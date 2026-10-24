import SwiftUI

@MainActor
protocol FeatureThreadUsageLimitsProviding {
    func threadUsageLimits(threadID: String, providerID: String) -> FeatureEnvironmentUsageLimits?
}

enum FeatureThreadUsageLimits {
    static func isCommand(_ text: String, hasAttachments: Bool) -> Bool {
        !hasAttachments && text.trimmingCharacters(in: .whitespacesAndNewlines) == "/usage-limits"
    }

    /// Use the selected provider's driver and this thread's environment only.
    static func report(
        _ environment: FeatureEnvironmentUsageLimits, providerID: String
    ) -> FeatureEnvironmentUsageLimits? {
        guard let selected = environment.providers.first(where: { $0.instanceId == providerID }) else { return nil }
        let providers = UsageLimitsPresentation.providersWithLimits(environment.providers)
            .filter { $0.driver == selected.driver }
        let sources = environment.sources.compactMap { source -> UsageLimitSourceSnapshot? in
            let accounts = source.accounts.filter { $0.driver == selected.driver }
            guard !accounts.isEmpty || (source.error != nil && source.accounts.isEmpty) else { return nil }
            return UsageLimitSourceSnapshot(id: source.id, kind: source.kind, label: source.label,
                checkedAt: source.checkedAt, accounts: accounts, error: source.error)
        }
        guard !providers.isEmpty || !sources.isEmpty else { return nil }
        return FeatureEnvironmentUsageLimits(environmentID: environment.id, label: environment.label,
            providers: providers, sources: sources, isConnected: environment.isConnected,
            errorMessage: environment.errorMessage, isPending: environment.isPending)
    }
}

struct FeatureThreadUsageLimitsView: View {
    let client: any FeatureClient
    let report: FeatureEnvironmentUsageLimits
    let onClose: () -> Void
    @State private var resetStates: [UsageResetCreditTarget: UsageResetCreditState] = [:]
    private let now = Date()

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Usage limits").font(T3Typography.control)
                Spacer()
                Button("Close", systemImage: "xmark", action: onClose)
                    .labelStyle(.iconOnly)
                    .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(UsageLimitPooling.accounts([report])) { account in
                        UsageLimitsAccountView(driver: account.driver, instanceID: account.id,
                            label: account.label, detail: account.plan, limits: account.limits, now: now)
                        if let credits = account.limits.resetCredits {
                            if let redeem = account.redeem {
                                UsageResetCreditsView(client: client, environmentID: redeem.environmentID,
                                    input: redeem.input, isConnected: redeem.isConnected, credits: credits,
                                    now: now, state: Binding(
                                        get: { resetStates[redeem.target] ?? UsageResetCreditState() },
                                        set: { resetStates[redeem.target] = $0 }
                                    ))
                            } else {
                                Text(UsageLimitsMath.creditSummary(credits, now: now))
                                    .font(T3Typography.supporting)
                            }
                        }
                    }
                    ForEach(report.sources) { source in
                        if let error = source.error {
                            Text("\(source.label): \(error)").font(T3Typography.supporting)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, 12)
            }
            .frame(maxHeight: 230)
        }
        .padding(.horizontal, 18)
        .foregroundStyle(T3Colors.textPrimary)
        .background(T3Colors.background)
    }
}
