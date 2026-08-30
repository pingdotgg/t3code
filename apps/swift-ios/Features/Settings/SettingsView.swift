import SwiftUI

public struct SettingsView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable private var model: FeatureRootModel
    @State private var settings: FeatureSettings
    @State private var isSaving = false
    @State private var appearanceSaveTask: Task<Bool, Never>?
    @State private var saveErrorMessage: String?
    @State private var showingDiscardConfirmation = false

    public init(model: FeatureRootModel) {
        self.model = model
        _settings = State(initialValue: model.snapshot.settings)
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 36) {
                    connectionSection
                    generalSection
                    preferencesSection
                    aboutSection
                }
                .padding(.top, 24)
                .padding(.bottom, 36)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(T3Colors.background)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        if hasUnsavedChanges {
                            showingDiscardConfirmation = true
                        } else {
                            dismiss()
                        }
                    }
                    .disabled(isSaving)
                    .accessibilityHint(
                        hasUnsavedChanges
                            ? "Asks before discarding unsaved changes"
                            : "Closes settings"
                    )
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving" : "Save", action: save)
                        .disabled(!canSave)
                        .accessibilityHint("Saves your preferences")
                }
            }
            .alert(
                "Couldn’t save settings",
                isPresented: Binding(
                    get: { saveErrorMessage != nil },
                    set: { if !$0 { saveErrorMessage = nil } }
                )
            ) {
                Button("OK") { saveErrorMessage = nil }
            } message: {
                Text(saveErrorMessage ?? "Something went wrong.")
            }
            .confirmationDialog(
                "Discard unsaved changes?",
                isPresented: $showingDiscardConfirmation,
                titleVisibility: .visible
            ) {
                Button("Discard changes", role: .destructive) { dismiss() }
                Button("Keep editing", role: .cancel) {}
            }
            .onAppear {
                model.setConnectionManagementPresented(true)
            }
            .onDisappear {
                model.setConnectionManagementPresented(false)
            }
            .onChange(of: settings.appearance) { _, appearance in
                saveAppearance(appearance)
            }
        }
        .interactiveDismissDisabled(isSaving || hasUnsavedChanges)
        .presentationBackground(T3Colors.background)
        .presentationDragIndicator(.visible)
    }

    private var connectionSection: some View {
        SettingsSection(title: "Connection") {
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
        }
    }

    private var generalSection: some View {
        SettingsSection(title: "Workspace") {
            VStack(spacing: 0) {
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
                settingsDivider
                NavigationLink {
                    UsageView(client: model.client)
                } label: {
                    SettingsNavigationRow(
                        title: "Usage",
                        systemImage: "chart.bar.xaxis"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Shows provider usage")
            }
        }
    }

    private var preferencesSection: some View {
        SettingsSection(
            title: "Preferences",
            footer: "Auto-settle preferences are saved on this device."
        ) {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    SettingsRowIcon(systemName: "circle.lefthalf.filled")
                    Text("Theme")
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textPrimary)
                    Spacer(minLength: 12)
                    Picker("Theme", selection: $settings.appearance) {
                        Text("System").tag(FeatureAppearance.system)
                        Text("Light").tag(FeatureAppearance.light)
                        Text("Dark").tag(FeatureAppearance.dark)
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .tint(T3Colors.textSecondary)
                    .accessibilityLabel("Theme")
                }
                .padding(.horizontal, 20)
                .frame(minHeight: 56)

                settingsDivider
                SettingsToggleRow(
                    title: "Haptics",
                    systemImage: "iphone.radiowaves.left.and.right",
                    isOn: $settings.hapticsEnabled
                )
                settingsDivider
                SettingsToggleRow(
                    title: "Notifications",
                    systemImage: "bell",
                    isOn: $settings.notificationsEnabled
                )
                settingsDivider
                SettingsToggleRow(
                    title: "Live Activities",
                    systemImage: "waveform.path.ecg.rectangle",
                    isOn: $settings.liveActivitiesEnabled
                )
                settingsDivider
                SettingsToggleRow(
                    title: "Auto-settle merged threads",
                    systemImage: "arrow.triangle.merge",
                    isOn: $settings.autoSettleOnMerge
                )
                settingsDivider
                SettingsToggleRow(
                    title: "Auto-settle inactive threads",
                    systemImage: "clock",
                    isOn: Binding(
                        get: { settings.autoSettleAfterDays != nil },
                        set: { enabled in
                            settings.autoSettleAfterDays = enabled
                                ? (settings.autoSettleAfterDays ?? 3)
                                : nil
                        }
                    )
                )
                if let days = settings.autoSettleAfterDays {
                    settingsDivider
                    HStack(spacing: 12) {
                        SettingsRowIcon(systemName: "calendar")
                        Text("Inactive for \(days) \(days == 1 ? "day" : "days")")
                            .font(T3Typography.threadBody)
                            .foregroundStyle(T3Colors.textPrimary)
                        Spacer(minLength: 12)
                        Stepper(
                            "Inactivity days",
                            value: Binding(
                                get: { settings.autoSettleAfterDays ?? 3 },
                                set: { settings.autoSettleAfterDays = $0 }
                            ),
                            in: 1 ... 90
                        )
                        .labelsHidden()
                    }
                    .padding(.horizontal, 20)
                    .frame(minHeight: 56)
                }
            }
        }
    }

    private var aboutSection: some View {
        SettingsSection(title: "About", footer: "Version \(appVersionLabel)") {
            Link(destination: URL(string: "https://github.com/pingdotgg/t3code")!) {
                SettingsNavigationRow(
                    title: "Source code",
                    systemImage: "chevron.left.forwardslash.chevron.right",
                    trailingSystemImage: "arrow.up.right"
                )
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens GitHub in your browser")
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

    private var hasUnsavedChanges: Bool {
        settings != model.snapshot.settings
    }

    private var canSave: Bool {
        !isSaving && hasUnsavedChanges
    }

    @MainActor
    private func saveAppearance(_ appearance: FeatureAppearance) {
        let previousSave = appearanceSaveTask
        appearanceSaveTask = Task {
            _ = await previousSave?.value

            let didSave = await model.saveAppearance(appearance)
            if !didSave, settings.appearance == appearance {
                settings.appearance = model.snapshot.settings.appearance
                saveErrorMessage = model.errorMessage
                    ?? "Theme preference could not be saved."
            }
            return didSave
        }
    }

    @MainActor
    private func save() {
        let pendingAppearanceSave = appearanceSaveTask
        isSaving = true
        Task {
            let appearanceDidSave = await pendingAppearanceSave?.value ?? true
            if !appearanceDidSave, !hasUnsavedChanges {
                isSaving = false
                return
            }

            let didSave = await model.saveSettings(settings)
            isSaving = false
            if didSave {
                saveErrorMessage = nil
                dismiss()
            } else {
                saveErrorMessage = model.errorMessage ?? "Settings could not be saved."
            }
        }
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
