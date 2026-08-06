import SwiftUI

public struct SettingsView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable private var model: FeatureRootModel
    @State private var settings: FeatureSettings
    @State private var isSaving = false
    @State private var showingDisconnect = false
    @State private var showingAddEnvironment = false
    @State private var removalTarget: FeatureEnvironment?

    public init(model: FeatureRootModel) {
        self.model = model
        _settings = State(initialValue: model.snapshot.settings)
    }

    public var body: some View {
        NavigationStack {
            Form {
                connectionSection
                t3ConnectSection
                agentSection
                preferencesSection
                aboutSection
            }
            .scrollContentBackground(.hidden)
            .background(Color.black)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        save()
                    }
                    .disabled(isSaving || settings == model.snapshot.settings)
                }
            }
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
            .onAppear {
                model.setConnectionManagementPresented(true)
            }
            .onDisappear {
                model.setConnectionManagementPresented(false)
            }
        }
    }

    private var connectionSection: some View {
        Section("Connections") {
            HStack(spacing: 12) {
                Image(systemName: connectionSymbol)
                    .foregroundStyle(connectionColor)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.snapshot.connection.environmentName ?? "T3 server")
                        .font(T3Typography.homeTitle)
                    Text(connectionDescription)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                }
                Spacer()
                Text(connectionStatus)
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(connectionColor)
            }
            .accessibilityElement(children: .combine)

            NavigationLink {
                DevicesView(manager: deviceManager)
            } label: {
                Label("Devices and sessions", systemImage: "laptopcomputer.and.iphone")
            }

            ForEach(model.snapshot.environments) { environment in
                Button {
                    guard !environment.isActive else { return }
                    Task { await model.activateEnvironment(environment.id) }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "desktopcomputer")
                            .foregroundStyle(.secondary)
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(environment.name)
                                .font(T3Typography.threadBody)
                                .foregroundStyle(.primary)
                            Text(environment.endpoint)
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textSecondary)
                                .lineLimit(1)
                        }
                        Spacer()
                        let status = environmentStatus(for: environment)
                        Label(status.title, systemImage: status.symbol)
                            .font(T3Typography.supportingStrong)
                            .foregroundStyle(status.color)
                    }
                }
                .swipeActions {
                    Button(role: .destructive) {
                        removalTarget = environment
                    } label: {
                        Label("Remove", systemImage: "trash")
                    }
                }
                .contextMenu {
                    Button(role: .destructive) {
                        removalTarget = environment
                    } label: {
                        Label("Remove saved server", systemImage: "trash")
                    }
                }
            }

            Button {
                showingAddEnvironment = true
            } label: {
                Label("Add another server", systemImage: "plus")
            }

            Button("Disconnect", role: .destructive) {
                showingDisconnect = true
            }
        }
    }

    private var agentSection: some View {
        Section("Default agent") {
            ProviderModelPicker(
                providers: model.snapshot.providers,
                selection: $settings.defaultSelection
            )
            if let provider = selectedProvider, let selectedModel {
                LabeledContent("Provider", value: provider.name)
                if let detail = selectedModel.detail {
                    Text(detail)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }
        }
    }

    private var t3ConnectSection: some View {
        Section("T3 Connect") {
            if let capability = model.client as? any T3ConnectCapable {
                NavigationLink {
                    T3ConnectView(capability: capability)
                } label: {
                    Label("Cloud environments", systemImage: "cloud")
                }
            } else {
                LabeledContent {
                    Text("Unavailable")
                        .foregroundStyle(T3Colors.textTertiary)
                } label: {
                    Label("Cloud environments", systemImage: "cloud.slash")
                }
            }

            Text("Optional account sync for relay-managed environments.")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
        }
    }

    private var preferencesSection: some View {
        Section("Preferences") {
            Picker("Theme", selection: $settings.appearance) {
                Text("System").tag(FeatureAppearance.system)
                Text("Dark").tag(FeatureAppearance.dark)
            }
            Toggle("Haptics", isOn: $settings.hapticsEnabled)
            Toggle("Notifications", isOn: $settings.notificationsEnabled)
            Toggle("Live Activities", isOn: $settings.liveActivitiesEnabled)
        }
    }

    private var aboutSection: some View {
        Section("About") {
            LabeledContent("App", value: appDisplayName)
            LabeledContent("Platform", value: "Native SwiftUI")
            Link("Open source", destination: URL(string: "https://github.com/pingdotgg/t3code")!)
        }
    }

    private var appDisplayName: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? "T3 Code SwiftUI"
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
                title: "Live",
                symbol: "dot.radiowaves.left.and.right",
                color: T3Colors.accent
            )
        case .connected:
            return EnvironmentStatusPresentation(
                title: "Available",
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
            await model.saveSettings(settings)
            isSaving = false
            if model.snapshot.settings == settings {
                dismiss()
            }
        }
    }
}

private struct EnvironmentStatusPresentation {
    let title: String
    let symbol: String
    let color: Color
}
