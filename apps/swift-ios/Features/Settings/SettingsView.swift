import SwiftUI

enum FeatureSettingsDestination: Hashable {
    case appearance, scheduledTasks, projects
}

public struct SettingsView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable private var model: FeatureRootModel
    @State private var saveErrorMessage: String?
    @State private var isPresented = false
    @State private var path: [FeatureSettingsDestination] = []

    public init(model: FeatureRootModel) {
        self.model = model
    }

    init(model: FeatureRootModel, initialDestination: FeatureSettingsDestination?) {
        self.model = model
        _path = State(initialValue: initialDestination.map { [$0] } ?? [])
    }

    public var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    workspaceSection
                    appSection
                    betaSection
                    activitySection
                    supportSection
                    aboutSection
                }
                .padding(.vertical, 20)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(T3Colors.background)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .navigationDestination(for: FeatureSettingsDestination.self) { destination in
                switch destination {
                case .appearance:
                    SettingsAppearanceView(appearance: preference(\.appearance),
                        textSize: preference(\.textSize), codeSize: preference(\.codeSize))
                case .scheduledTasks:
                    ScheduledTasksView(model: model)
                case .projects:
                    ProjectsSettingsView(model: model)
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("settings-done")
                }
            }
        }
        .alert(
            "Couldn't save settings",
            isPresented: Binding(
                get: { saveErrorMessage != nil },
                set: { if !$0 { saveErrorMessage = nil } }
            )
        ) {
            Button("OK") { saveErrorMessage = nil }
        } message: {
            Text(saveErrorMessage ?? "Try changing the setting again.")
        }
        .onAppear {
            isPresented = true
            model.setConnectionManagementPresented(true)
        }
        .onDisappear {
            isPresented = false
            model.setConnectionManagementPresented(false)
        }
        .presentationBackground(T3Colors.background)
        .presentationDragIndicator(.visible)
        .t3CodeSizing(steps: model.snapshot.settings.codeSize.steps)
    }

    private var workspaceSection: some View {
        SettingsSection(title: "Workspace") {
            VStack(spacing: 0) {
                NavigationLink {
                    ConnectionsView(model: model)
                } label: {
                    SettingsNavigationRow(
                        title: "Environments",
                        value: environmentCountLabel,
                        subtitle: environmentSummary.text,
                        systemImage: "server.rack",
                        statusColor: environmentSummary.color
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Environments")
                .accessibilityValue(environmentAccessibilityValue)
                .accessibilityHint("Manage saved environments")
                settingsDivider
                NavigationLink {
                    ProjectsSettingsView(model: model)
                } label: {
                    SettingsNavigationRow(title: "Projects", systemImage: "folder")
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("settings-projects")
                settingsDivider
                NavigationLink {
                    ProvidersSettingsView(model: model)
                } label: {
                    SettingsNavigationRow(title: "Providers", systemImage: "cpu")
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var activitySection: some View {
        SettingsSection(title: "Activity") {
            VStack(spacing: 0) {
                NavigationLink {
                    UsageView(client: model.client)
                } label: {
                    SettingsNavigationRow(title: "Usage", systemImage: "chart.bar.xaxis")
                }
                .buttonStyle(.plain)
                .accessibilityHint("Shows provider usage")
                settingsDivider
                NavigationLink {
                    ScheduledTasksView(model: model)
                } label: {
                    SettingsNavigationRow(title: "Scheduled tasks", systemImage: "calendar.badge.clock")
                }
                .buttonStyle(.plain)
                settingsDivider
                NavigationLink {
                    PullRequestsView(model: model)
                } label: {
                    SettingsNavigationRow(
                        title: "Pull requests",
                        systemImage: "arrow.triangle.pull"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Shows pull requests")
            }
        }
    }

    private var appSection: some View {
        SettingsSection(title: "App") {
            VStack(spacing: 0) {
                NavigationLink {
                    SettingsAppearanceView(
                        appearance: preference(\.appearance),
                        textSize: preference(\.textSize),
                        codeSize: preference(\.codeSize)
                    )
                } label: {
                    SettingsNavigationRow(
                        title: "Appearance",
                        systemImage: "circle.lefthalf.filled"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Theme, text size, and code size")
                .accessibilityIdentifier("settings-appearance")
                settingsDivider
                NavigationLink {
                    SettingsNotificationsView(
                        model: model,
                        notificationsEnabled: preference(\.notificationsEnabled)
                    )
                } label: {
                    SettingsNavigationRow(title: "Notifications", systemImage: "bell")
                }
                .buttonStyle(.plain)
                .accessibilityHint("Notifications and Live Activities")
                .accessibilityIdentifier("settings-notifications")
                if let storage = model.client as? any FeatureClientStorageManaging {
                    settingsDivider
                    NavigationLink {
                        FeatureClientStorageView(storage: storage)
                    } label: {
                        SettingsNavigationRow(title: "Client Storage", systemImage: "internaldrive")
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Manage saved offline history on this device")
                    .accessibilityIdentifier("settings-client-storage")
                }
                settingsDivider
                SettingsToggleRow(
                    title: "Haptics",
                    systemImage: "iphone.radiowaves.left.and.right",
                    isOn: preference(\.hapticsEnabled)
                )
                .accessibilityIdentifier("settings-haptics")
                settingsDivider
                Picker("Follow-ups", selection: preference(\.followUpBehavior)) {
                    ForEach(FeatureFollowUpBehavior.allCases, id: \.self) { behavior in
                        Text(behavior.label).tag(behavior)
                    }
                }
                .padding(.horizontal, 16)
                .frame(minHeight: T3Metrics.minimumTapTarget)
                settingsDivider
                Picker("Hardware Return", selection: preference(\.composerEnterBehavior)) {
                    ForEach(FeatureComposerEnterBehavior.allCases, id: \.self) { behavior in
                        Text(behavior.title).tag(behavior)
                    }
                }
                .padding(.horizontal, 16)
                .frame(minHeight: T3Metrics.minimumTapTarget)
                Text(model.snapshot.settings.composerEnterBehavior.explanation)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
                settingsDivider
                SettingsToggleRow(title: "Legacy Plan mode", systemImage: "list.bullet.clipboard",
                    isOn: preference(\.legacyPlanModeEnabled))
            }
        }
    }

    private var supportSection: some View {
        SettingsSection(title: "Support") {
            NavigationLink {
                SettingsDiagnosticsView()
            } label: {
                SettingsNavigationRow(title: "Diagnostics", systemImage: "stethoscope")
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings-diagnostics")
        }
    }

    private var betaSection: some View {
        SettingsSection(
            title: "Beta",
            footer: "Fold working and monitoring threads into a Working section. They return to the top when they need you. Active threads use time order while this is on."
        ) {
            SettingsToggleRow(
                title: "Working section",
                systemImage: "bolt.circle",
                isOn: preference(\.workingShelfEnabled)
            )
            .accessibilityIdentifier("settings-working-section")
        }
    }

    private var aboutSection: some View {
        SettingsSection(title: "About", footer: "Version \(appVersionLabel)") {
            VStack(spacing: 0) {
                Link(destination: URL(string: "https://github.com/pingdotgg/t3code")!) {
                    SettingsNavigationRow(
                        title: "Source code",
                        systemImage: "chevron.left.forwardslash.chevron.right",
                        trailingSystemImage: "arrow.up.right"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens GitHub in your browser")
                settingsDivider
                NavigationLink {
                    SettingsLicensesView()
                } label: {
                    SettingsNavigationRow(title: "Open source licenses", systemImage: "doc.text")
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("settings-licenses")
            }
        }
    }

    private var settingsDivider: some View {
        Divider()
            .overlay(T3Colors.separator)
            .padding(.leading, 54)
            .padding(.trailing, 20)
    }

    private var environmentSummary: (text: String, color: Color) {
        let environments = model.snapshot.environments
        guard !environments.isEmpty else {
            return ("Add an environment", T3Colors.textTertiary)
        }

        let connected = connectedEnvironments
        if connected.count == 1, let environment = connected.first {
            return ("\(environment.name) online", T3Colors.success)
        }
        if connected.count > 1 {
            return ("\(connected.count) online", T3Colors.success)
        }

        let enabled = environments.filter(\.isEnabled)
        guard !enabled.isEmpty else {
            let text = environments.count == 1 ? "Off" : "All off"
            return (text, T3Colors.textTertiary)
        }

        if let connecting = enabled.first(where: {
            $0.connectionState == .connecting || $0.connectionState == .reconnecting
        }) {
            let state = connecting.connectionState == .reconnecting
                ? "reconnecting"
                : "connecting"
            return ("\(connecting.name) \(state)", T3Colors.warning)
        }

        if let checking = enabled.first(where: { $0.connectionState == nil }) {
            let text = enabled.count == 1
                ? "\(checking.name) checking"
                : "Checking environments"
            return (text, T3Colors.textTertiary)
        }

        let text = enabled.count == 1 ? "\(enabled[0].name) offline" : "All offline"
        return (text, T3Colors.danger)
    }

    private var connectedEnvironments: [FeatureEnvironment] {
        model.snapshot.environments.filter {
            ConnectionHubPresentation.status(for: $0) == .online
        }
    }

    private var environmentCountLabel: String? {
        let environments = model.snapshot.environments
        guard !environments.isEmpty else { return nil }
        return "\(connectedEnvironments.count)/\(environments.count)"
    }

    private var environmentAccessibilityValue: String {
        let environmentCount = model.snapshot.environments.count
        guard environmentCount > 0 else {
            return environmentSummary.text
        }

        let connectedCount = connectedEnvironments.count
        return "\(environmentSummary.text), \(connectedCount) of \(environmentCount) online"
    }

    private var appVersionLabel: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
            ?? "?"
        return "\(version) (\(build))"
    }

    private func preference<Value>(
        _ keyPath: WritableKeyPath<FeatureSettings, Value>
    ) -> Binding<Value> {
        Binding(
            get: { model.snapshot.settings[keyPath: keyPath] },
            set: { value in
                // The model owns queued writes, including after this sheet closes.
                Task {
                    let didSave = await model.savePreference(keyPath, value: value)
                    if !didSave, isPresented, let message = model.errorMessage {
                        saveErrorMessage = message
                        model.errorMessage = nil
                    }
                }
            }
        )
    }
}

private struct SettingsAppearanceView: View {
    @Binding var appearance: FeatureAppearance
    @Binding var textSize: FeatureTextSizeAdjustment
    @Binding var codeSize: FeatureTextSizeAdjustment

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                SettingsSection(title: "Theme") {
                    Picker("Theme", selection: $appearance) {
                        Text("System").tag(FeatureAppearance.system)
                        Text("Light").tag(FeatureAppearance.light)
                        Text("Dark").tag(FeatureAppearance.dark)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 20)
                    .accessibilityIdentifier("settings-theme")
                }
                SettingsSection(
                    title: "Text and code",
                    footer: "Sizes follow your iOS text size. Code size also applies to diffs, files, and tool output."
                ) {
                    VStack(spacing: 12) {
                        SettingsTextSizePreview()
                        SettingsTextSizeRow(
                            title: "Text size", systemImage: "textformat.size",
                            adjustment: $textSize
                        )
                        .accessibilityIdentifier("settings-text-size")
                        SettingsTextSizeRow(
                            title: "Code size", systemImage: "chevron.left.forwardslash.chevron.right",
                            adjustment: $codeSize
                        )
                        .accessibilityIdentifier("settings-code-size")
                    }
                }
            }
            .padding(.vertical, 20)
        }
        .background(T3Colors.background)
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
    }
}

private struct SettingsNotificationsView: View {
    @Bindable var model: FeatureRootModel
    @Binding var notificationsEnabled: Bool
    @State private var desiredLiveActivities = false
    private let delivery = PlatformCloudDeliveryCoordinator.shared

    private var candidates: [FeatureEnvironment] {
        model.snapshot.environments.filter { $0.isEnabled && $0.source == .direct }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SettingsToggleRow(title: "Notifications", systemImage: "bell", isOn: $notificationsEnabled)
                    .accessibilityIdentifier("settings-notifications-enabled")
                Divider().overlay(T3Colors.separator)
                SettingsToggleRow(title: "Live Activities", systemImage: "waveform.path.ecg.rectangle",
                    isOn: $desiredLiveActivities)
                    .disabled(delivery.isSettingUpLiveActivities)
                    .accessibilityIdentifier("settings-live-activities-enabled")
                Text("Show thread progress on the Lock Screen and Dynamic Island.")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                if !candidates.isEmpty {
                    Text("Computers").font(T3Typography.control)
                    ForEach(candidates) { environment in
                        Toggle(environment.name, isOn: Binding(
                            get: { delivery.selectedLiveActivityEnvironmentIDs.contains(environment.id) },
                            set: { selected in
                                if selected { delivery.selectedLiveActivityEnvironmentIDs.insert(environment.id) }
                                else { delivery.selectedLiveActivityEnvironmentIDs.remove(environment.id) }
                            }
                        ))
                        .disabled(delivery.isSettingUpLiveActivities)
                    }
                    Text("Apply updates only the selected computers. Enabling links them to your T3 Connect account.")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                Button(delivery.isSettingUpLiveActivities ? "Applying…" : "Apply Live Activity setup", action: apply)
                    .disabled(delivery.isSettingUpLiveActivities)
                    .accessibilityIdentifier("settings-live-activities-apply")
                switch delivery.liveActivitySetupStatus {
                case let .failed(error):
                    Text("Live Activity setup failed: \(error) Apply again to retry.")
                        .font(T3Typography.supporting).foregroundStyle(T3Colors.danger)
                case let .unavailable(reason):
                    Text("Local preference saved. Remote delivery unavailable: \(reason)")
                        .font(T3Typography.supporting)
                case .signedOut:
                    Text("Local preference saved. Sign in to T3 Connect, then apply again for remote delivery.")
                        .font(T3Typography.supporting)
                default:
                    EmptyView()
                }
                PlatformNotificationRegistrationView(settings: model.snapshot.settings)
            }
            .padding(20)
        }
        .background(T3Colors.background)
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .onAppear { desiredLiveActivities = model.snapshot.settings.liveActivitiesEnabled }
    }

    private func apply() {
        guard !delivery.isSettingUpLiveActivities else { return }
        let enabled = desiredLiveActivities
        let previous = model.snapshot.settings.liveActivitiesEnabled
        let selected = candidates.filter { delivery.selectedLiveActivityEnvironmentIDs.contains($0.id) }.map(\.id)
        let capability = model.client as? any FeatureLiveActivitySetup
        // This task must outlive the screen. The coordinator owns progress and
        // errors so returning to Settings still shows the setup result.
        Task { @MainActor in
            let remoteSetup: (@MainActor () async throws -> Void)? = capability.map { capability in
                { try await capability.setUpLiveActivityUpdates(enabled: enabled,
                    previousEnabled: previous, environmentIDs: selected) }
            }
            await delivery.applyLiveActivityPreference(savePreference: {
                guard await model.savePreference(\.liveActivitiesEnabled, value: enabled) else {
                    throw T3ConnectRelayError.invalidConfiguration(
                        model.errorMessage ?? "Could not save Live Activity preferences."
                    )
                }
                return model.snapshot.settings
            }, setUpRemote: remoteSetup)
            desiredLiveActivities = model.snapshot.settings.liveActivitiesEnabled
        }
    }
}

private struct SettingsTextSizePreview: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("Rewrote the failing test and re-ran the suite.")
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: "- expect(total).toBe(41)\n+ expect(total).toBe(42)")
                .font(T3Typography.code)
                .foregroundStyle(T3Colors.textSecondary)
                .t3CodeTextSize()
                .fixedSize(horizontal: false, vertical: true)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    T3Colors.surfaceRaised,
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                )
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Preview of the selected text and code sizes")
    }
}

private struct SettingsTextSizeRow: View {
    let title: String
    let systemImage: String
    @Binding var adjustment: FeatureTextSizeAdjustment

    private var steps: Binding<Double> {
        Binding(
            get: { Double(adjustment.steps) },
            set: { adjustment = FeatureTextSizeAdjustment(steps: Int($0.rounded())) }
        )
    }

    private var valueLabel: String {
        switch adjustment.steps {
        case ...(-2): "Much smaller"
        case -1: "Smaller"
        case 0: "Default"
        case 1: "Larger"
        case 2: "Much larger"
        default: "Largest"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                SettingsRowIcon(systemName: systemImage)
                Text(title)
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textPrimary)
                Spacer(minLength: 12)
                Text(valueLabel)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            .accessibilityHidden(true)
            HStack(spacing: 12) {
                Image(systemName: "textformat.size.smaller")
                    .font(T3Typography.supporting)
                Slider(
                    value: steps,
                    in: Double(FeatureTextSizeAdjustment.range.lowerBound)
                        ... Double(FeatureTextSizeAdjustment.range.upperBound),
                    step: 1
                ) {
                    Text(title)
                }
                .tint(T3Colors.accent)
                .accessibilityValue(valueLabel)
                Image(systemName: "textformat.size.larger")
                    .font(T3Typography.navigationTitle)
            }
            .foregroundStyle(T3Colors.textTertiary)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .frame(minHeight: 52)
    }
}

private struct SettingsSection<Content: View>: View {
    let title: String
    let footer: String?
    let content: Content

    init(
        title: String,
        footer: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.footer = footer
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(T3Typography.navigationTitle)
                .foregroundStyle(T3Colors.textPrimary)
                .padding(.horizontal, 20)
                .accessibilityAddTraits(.isHeader)

            content

            if let footer {
                Text(footer)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .padding(.horizontal, 20)
            }
        }
    }
}

private struct SettingsRowIcon: View {
    let systemName: String
    var color: Color = T3Colors.textSecondary

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 17, weight: .medium))
            .foregroundStyle(color)
            .frame(width: 22, height: 22)
            .accessibilityHidden(true)
    }
}

private struct SettingsNavigationRow: View {
    let title: String
    var value: String? = nil
    var subtitle: String? = nil
    let systemImage: String
    var statusColor: Color? = nil
    var trailingSystemImage = "chevron.right"

    var body: some View {
        HStack(spacing: 12) {
            SettingsRowIcon(systemName: systemImage)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textPrimary)

                if let subtitle {
                    HStack(spacing: 6) {
                        if let statusColor {
                            Circle()
                                .fill(statusColor)
                                .frame(width: 7, height: 7)
                                .accessibilityHidden(true)
                        }

                        Text(subtitle)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                            .lineLimit(1)
                    }
                }
            }

            Spacer(minLength: 8)
            if let value {
                Text(value)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
                    .layoutPriority(1)
            }
            Image(systemName: trailingSystemImage)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textTertiary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 20)
        .frame(minHeight: subtitle == nil ? 56 : 68)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct SettingsToggleRow: View {
    let title: String
    let systemImage: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            HStack(spacing: 12) {
                SettingsRowIcon(systemName: systemImage)
                Text(title)
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textPrimary)
            }
        }
        .tint(T3Colors.accent)
        .padding(.horizontal, 20)
        .frame(minHeight: 56)
    }
}
