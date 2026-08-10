import SwiftUI

public struct SettingsView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable private var model: FeatureRootModel
    @State private var settings: FeatureSettings
    @State private var isSaving = false
    @State private var showingDisconnect = false
    @State private var showingAddEnvironment = false
    @State private var showingDevices = false
    @State private var showingT3Connect = false
    @State private var removalTarget: FeatureEnvironment?
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
                        t3ConnectSection
                        generalSection
                        agentSection
                        preferencesSection
                        aboutSection
                    }
                    .padding(.vertical, 18)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .background(T3Colors.background)
            .toolbar(.hidden, for: .navigationBar)
            .confirmationDialog(
                "Disconnect from this server?",
                isPresented: $showingDisconnect,
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) {
                    Task {
                        await model.disconnect()
                        dismiss()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Your saved server and credentials will stay on this iPhone.")
            }
            .alert(
                "Remove saved server?",
                isPresented: Binding(
                    get: { removalTarget != nil },
                    set: { if !$0 { removalTarget = nil } }
                ),
                presenting: removalTarget
            ) { environment in
                Button("Remove", role: .destructive) {
                    Task {
                        await model.removeEnvironment(environment.id)
                        removalTarget = nil
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: { environment in
                Text("\(environment.name) will need a new pairing code to be added again.")
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
            .sheet(isPresented: $showingAddEnvironment) {
                ConnectionOnboardingView(
                    model: model,
                    onConnected: {
                        showingAddEnvironment = false
                    },
                    onCancel: {
                        showingAddEnvironment = false
                    }
                )
            }
            .sheet(isPresented: $showingDevices) {
                NavigationStack {
                    DevicesView(manager: deviceManager)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Done") { showingDevices = false }
                            }
                        }
                }
                .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingT3Connect) {
                if let capability = model.client as? any T3ConnectCapable {
                    NavigationStack {
                        T3ConnectView(capability: capability)
                            .toolbar {
                                ToolbarItem(placement: .cancellationAction) {
                                    Button("Done") { showingT3Connect = false }
                                }
                            }
                    }
                    .presentationDragIndicator(.visible)
                }
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
            VStack(spacing: 0) {
                if model.snapshot.environments.isEmpty {
                    connectionFallbackRow
                } else {
                    ForEach(Array(model.snapshot.environments.enumerated()), id: \.element.id) {
                        index, environment in
                        if index > 0 {
                            settingsDivider
                        }
                        environmentRow(environment)
                    }
                }

                settingsDivider

                Button {
                    showingDevices = true
                } label: {
                    SettingsNavigationRow(
                        title: "Devices and sessions",
                        systemImage: "laptopcomputer.and.iphone"
                    )
                }
                .buttonStyle(.plain)

                settingsDivider

                Button {
                    showingAddEnvironment = true
                } label: {
                    SettingsActionRow(
                        title: "Add server",
                        systemImage: "plus"
                    )
                }
                .buttonStyle(.plain)

                settingsDivider

                Button(role: .destructive) {
                    showingDisconnect = true
                } label: {
                    SettingsActionRow(
                        title: "Disconnect current server",
                        systemImage: "rectangle.portrait.and.arrow.right",
                        color: T3Colors.danger
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var agentSection: some View {
        SettingsSection(title: "Default agent") {
            VStack(spacing: 0) {
                ProviderModelPicker(
                    providers: model.snapshot.providers,
                    selection: $settings.defaultSelection
                )
                .padding(.horizontal, 20)
                .frame(minHeight: 58)

                if let provider = selectedProvider {
                    settingsDivider

                    SettingsValueRow(title: "Provider", value: provider.name)
                }

                if let detail = selectedModel?.detail {
                    settingsDivider

                    Text(detail)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
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

    private var t3ConnectSection: some View {
        SettingsSection(
            title: "T3 Connect",
            footer: "Optional account sync for relay-managed environments."
        ) {
            if model.client is any T3ConnectCapable {
                Button {
                    showingT3Connect = true
                } label: {
                    SettingsNavigationRow(
                        title: "Cloud environments",
                        systemImage: "cloud"
                    )
                }
                .buttonStyle(.plain)
            } else {
                SettingsValueRow(
                    title: "Cloud environments",
                    value: "Unavailable",
                    systemImage: "cloud.slash"
                )
            }
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

    private var connectionFallbackRow: some View {
        HStack(spacing: 12) {
            SettingsRowIcon(systemName: connectionSymbol, color: connectionColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.snapshot.connection.environmentName ?? "T3 server")
                    .font(T3Typography.homeTitle)
                    .foregroundStyle(T3Colors.textPrimary)
                Text(connectionDescription)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(connectionStatus)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(connectionColor)
        }
        .padding(.horizontal, 20)
        .frame(minHeight: 58)
        .accessibilityElement(children: .combine)
    }

    private func environmentRow(_ environment: FeatureEnvironment) -> some View {
        Button {
            guard !environment.isActive else { return }
            Task { await model.activateEnvironment(environment.id) }
        } label: {
            HStack(spacing: 12) {
                let status = environmentStatus(for: environment)
                let activeIsConnected = environment.isActive
                    && model.snapshot.connection.state == .connected
                SettingsRowIcon(
                    systemName: activeIsConnected ? "checkmark.circle.fill" : "desktopcomputer",
                    color: activeIsConnected ? T3Colors.success : T3Colors.textTertiary
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text(environment.name)
                        .font(T3Typography.homeTitle)
                        .foregroundStyle(T3Colors.textPrimary)
                        .lineLimit(1)
                    Text(environment.endpoint)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }

                Spacer(minLength: 8)

                Label(status.title, systemImage: status.symbol)
                    .labelStyle(SettingsStatusLabelStyle())
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(status.color)

            }
            .padding(.leading, 20)
            .padding(.trailing, environment.isActive ? 20 : 56)
            .frame(minHeight: 62)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint(environment.isActive ? "Current server" : "Switch to this server")
        .overlay(alignment: .trailing) {
            if !environment.isActive {
                Menu {
                    Button(role: .destructive) {
                        removalTarget = environment
                    } label: {
                        Label("Remove saved server", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(T3Typography.control)
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(width: T3Metrics.minimumTapTarget, height: 62)
                        .contentShape(Rectangle())
                }
                .padding(.trailing, 8)
                .accessibilityLabel("Actions for \(environment.name)")
            }
        }
        .contextMenu {
            if !environment.isActive {
                Button(role: .destructive) {
                    removalTarget = environment
                } label: {
                    Label("Remove saved server", systemImage: "trash")
                }
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

    private var deviceManager: any FeatureDeviceManaging {
        (model.client as? any FeatureDeviceManaging) ?? EmptyFeatureDeviceManager.shared
    }

    private var selectedProvider: FeatureProvider? {
        guard let selection = settings.defaultSelection else { return nil }
        return model.snapshot.providers.first { $0.id == selection.providerID }
    }

    private var selectedModel: FeatureModel? {
        guard let selection = settings.defaultSelection else { return nil }
        return selectedProvider?.models.first { $0.id == selection.modelID }
    }

    private var connectionStatus: String {
        switch model.snapshot.connection.state {
        case .connected: "Online"
        case .connecting: "Connecting"
        case .reconnecting: "Reconnecting"
        case .disconnected: "Offline"
        }
    }

    private var connectionSymbol: String {
        model.snapshot.connection.state == .connected ? "checkmark.circle.fill" : "network.slash"
    }

    private var connectionColor: Color {
        model.snapshot.connection.state == .connected ? .green : .secondary
    }

    private var connectionDescription: String {
        model.snapshot.connection.endpoint ?? "No active server"
    }

    private func environmentStatus(
        for environment: FeatureEnvironment
    ) -> EnvironmentStatusPresentation {
        let state = environment.isActive
            ? model.snapshot.connection.state
            : environment.connectionState
        switch state {
        case .connected where environment.isActive:
            return EnvironmentStatusPresentation(
                title: "Active",
                symbol: "dot.radiowaves.left.and.right",
                color: T3Colors.accent
            )
        case .connected:
            return EnvironmentStatusPresentation(
                title: "Ready",
                symbol: "network",
                color: T3Colors.textSecondary
            )
        case .connecting, .reconnecting:
            return EnvironmentStatusPresentation(
                title: "Checking",
                symbol: "arrow.triangle.2.circlepath",
                color: T3Colors.warning
            )
        case .disconnected:
            return EnvironmentStatusPresentation(
                title: "Offline",
                symbol: "network.slash",
                color: T3Colors.danger
            )
        case nil:
            return EnvironmentStatusPresentation(
                title: "Saved",
                symbol: "bookmark",
                color: T3Colors.textTertiary
            )
        }
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

private struct EnvironmentStatusPresentation {
    let title: String
    let symbol: String
    let color: Color
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
    let systemImage: String
    var trailingSystemImage = "chevron.right"

    var body: some View {
        HStack(spacing: 12) {
            SettingsRowIcon(systemName: systemImage)
            Text(title)
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textPrimary)
            Spacer(minLength: 8)
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
