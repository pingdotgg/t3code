import SwiftUI

public struct SettingsView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable private var model: FeatureRootModel
    @State private var settings: FeatureSettings
    @State private var isSaving = false
    @State private var saveErrorMessage: String?

    public init(model: FeatureRootModel) {
        self.model = model
        _settings = State(initialValue: model.snapshot.settings)
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                settingsHeader

                Divider()
                    .overlay(T3Colors.border)

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 28) {
                        connectionSection
                        generalSection
                        preferencesSection
                        aboutSection
                    }
                    .padding(.vertical, 18)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .background(T3Colors.background)
            .toolbar(.hidden, for: .navigationBar)
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
            .onAppear {
                model.setConnectionManagementPresented(true)
            }
            .onDisappear {
                model.setConnectionManagementPresented(false)
            }
            .onChange(of: settings.appearance) { _, appearance in
                Task {
                    let didSave = await model.saveAppearance(appearance)
                    if !didSave {
                        settings.appearance = model.snapshot.settings.appearance
                        saveErrorMessage = model.errorMessage
                            ?? "Theme preference could not be saved."
                    }
                }
            }
        }
        .presentationDragIndicator(.visible)
    }

    private var settingsHeader: some View {
        HStack(spacing: 12) {
            Button("Cancel") { dismiss() }
                .frame(width: 72, alignment: .leading)
                .foregroundStyle(T3Colors.accent)

            Spacer(minLength: 0)

            Text("Settings")
                .font(T3Typography.navigationTitle)
                .foregroundStyle(T3Colors.textPrimary)

            Spacer(minLength: 0)

            Button(isSaving ? "Saving…" : "Save") {
                save()
            }
            .fontWeight(.semibold)
            .frame(width: 72, alignment: .trailing)
            .foregroundStyle(canSave ? T3Colors.accent : T3Colors.textTertiary)
            .disabled(!canSave)
        }
        .font(T3Typography.control)
        .padding(.horizontal, 20)
        .frame(minHeight: 54)
    }

    private var connectionSection: some View {
        SettingsSection(title: "Connections") {
            NavigationLink {
                ConnectionsView(model: model)
            } label: {
                SettingsNavigationRow(
                    title: "Connections",
                    value: connectionSummary,
                    systemImage: "server.rack"
                )
            }
            .buttonStyle(.plain)
        }
    }

    private var generalSection: some View {
        SettingsSection(title: "General") {
            NavigationLink {
                UsageView(client: model.client)
            } label: {
                SettingsNavigationRow(
                    title: "Usage",
                    systemImage: "chart.bar.xaxis"
                )
            }
            .buttonStyle(.plain)
        }
    }


    private var preferencesSection: some View {
        SettingsSection(title: "Preferences") {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    SettingsRowIcon(systemName: "circle.lefthalf.filled")
                    Text("Theme")
                        .font(T3Typography.threadBody)
                    Spacer(minLength: 12)
                    Picker("Theme", selection: $settings.appearance) {
                        Text("System").tag(FeatureAppearance.system)
                        Text("Light").tag(FeatureAppearance.light)
                        Text("Dark").tag(FeatureAppearance.dark)
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .tint(T3Colors.textSecondary)
                }
                .padding(.horizontal, 20)
                .frame(minHeight: 52)

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
            }
        }
    }

    private var aboutSection: some View {
        SettingsSection(title: "About") {
            VStack(spacing: 0) {
                SettingsValueRow(title: "App", value: appDisplayName)
                settingsDivider
                SettingsValueRow(title: "Platform", value: "Native SwiftUI")
                settingsDivider
                Link(destination: URL(string: "https://github.com/pingdotgg/t3code")!) {
                    SettingsNavigationRow(
                        title: "Open source",
                        systemImage: "chevron.left.forwardslash.chevron.right",
                        trailingSystemImage: "arrow.up.right"
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var settingsDivider: some View {
        Divider()
            .overlay(T3Colors.separator)
            .padding(.leading, 54)
            .padding(.trailing, 20)
    }

    private var appDisplayName: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? "T3 Code SwiftUI"
    }

    private var canSave: Bool {
        !isSaving && settings != model.snapshot.settings
    }

    private var connectionSummary: String {
        let environments = model.snapshot.environments
        let online = environments.count {
            $0.isEnabled && $0.connectionState == .connected
        }
        return "\(online) online · \(environments.count) saved"
    }

    @MainActor
    private func save() {
        isSaving = true
        Task {
            let didSave = await model.saveSettings(settings)
            isSaving = false
            if didSave {
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
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textSecondary)
                .padding(.horizontal, 20)

            content

            if let footer {
                Text(footer)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .padding(.horizontal, 20)
                    .padding(.top, 2)
            }
        }
    }
}

private struct SettingsRowIcon: View {
    let systemName: String
    var color: Color = T3Colors.accent

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
    let systemImage: String
    var trailingSystemImage = "chevron.right"

    var body: some View {
        HStack(spacing: 12) {
            SettingsRowIcon(systemName: systemImage)
            Text(title)
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textPrimary)
            Spacer(minLength: 8)
            if let value {
                Text(value)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
            }
            Image(systemName: trailingSystemImage)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textTertiary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 20)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }
}

private struct SettingsActionRow: View {
    let title: String
    let systemImage: String
    var color: Color = T3Colors.accent

    var body: some View {
        HStack(spacing: 12) {
            SettingsRowIcon(systemName: systemImage, color: color)
            Text(title)
                .font(T3Typography.threadBody)
                .foregroundStyle(color)
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 20)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }
}

private struct SettingsValueRow: View {
    let title: String
    let value: String
    var systemImage: String? = nil

    var body: some View {
        HStack(spacing: 12) {
            if let systemImage {
                SettingsRowIcon(systemName: systemImage)
            }
            Text(title)
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textPrimary)
            Spacer(minLength: 12)
            Text(value)
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 20)
        .frame(minHeight: 52)
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
        .frame(minHeight: 52)
    }
}

private struct SettingsStatusLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
            configuration.title
        }
    }
}
