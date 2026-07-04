import SwiftUI

// Settings window content: `Settings { SettingsScene(model: model) }` in App.swift.
// Standard macOS Form-based settings — glass is not used here (this is a
// utility window, not a chrome surface over long-form content).
public struct SettingsScene: View {
    private let model: AppModel

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        TabView {
            GeneralSettingsTab(model: model)
                .tabItem { Label("General", systemImage: "gearshape") }

            ProvidersSettingsTab(model: model)
                .tabItem { Label("Providers", systemImage: "puzzlepiece.extension") }

            ArchiveSettingsTab(model: model)
                .tabItem { Label("Archive", systemImage: "archivebox") }

            ConnectionSettingsTab(model: model)
                .tabItem { Label("Connection", systemImage: "network") }
        }
        .frame(width: 560, height: 420)
    }
}

// MARK: - General

private struct GeneralSettingsTab: View {
    let model: AppModel
    @UIState private var draft: AppSettings?

    private var appVersion: String {
        let shortVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String
        switch (shortVersion, build) {
        case let (.some(v), .some(b)):
            return "\(v) (\(b))"
        case let (.some(v), .none):
            return v
        default:
            return "—"
        }
    }

    var body: some View {
        Form {
            if let settings = draft {
                Section("Behaviour") {
                    Toggle(
                        "Stream assistant replies",
                        isOn: binding(settings, \.assistantStreaming))
                    Toggle(
                        "Check for provider CLI updates",
                        isOn: binding(settings, \.providerUpdateChecks))
                }

                Section("New threads") {
                    Picker("Run threads in", selection: binding(settings, \.defaultEnvMode)) {
                        ForEach(ProjectEnvMode.allCases) { mode in
                            Text(mode.displayName).tag(mode)
                        }
                    }
                    Toggle(
                        "Start new worktrees from origin",
                        isOn: binding(settings, \.newWorktreesStartFromOrigin))
                    TextField(
                        "Default projects directory",
                        text: binding(settings, \.addProjectBaseDirectory))
                }
            } else {
                Section {
                    if model.connection == .ready {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Connect to the server to edit settings.")
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section {
                LabeledContent("Appearance", value: "Follows System")
                    .help("SergeCode does not offer a manual light/dark override; it follows macOS.")
                LabeledContent("Version", value: appVersion)
            }
        }
        .formStyle(.grouped)
        .padding()
        .task {
            await model.loadSettings()
            draft = model.settings
        }
    }

    /// Edit-in-place binding that persists the whole subset patch on change.
    private func binding<Value>(
        _ current: AppSettings, _ keyPath: WritableKeyPath<AppSettings, Value>
    ) -> Binding<Value> {
        Binding(
            get: { (draft ?? current)[keyPath: keyPath] },
            set: { newValue in
                var next = draft ?? current
                next[keyPath: keyPath] = newValue
                draft = next
                Task { await model.saveSettings(next) }
            })
    }
}

// MARK: - Archive

private struct ArchiveSettingsTab: View {
    let model: AppModel

    var body: some View {
        Form {
            Section("Archived threads") {
                if model.archivedThreads.isEmpty {
                    Text("No archived threads.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.archivedThreads) { thread in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(thread.title)
                                    .lineLimit(1)
                                Text(thread.provider.displayName)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Unarchive") {
                                Task { await model.unarchiveThread(thread) }
                            }
                            Button("Delete", role: .destructive) {
                                Task { await model.deleteThread(thread) }
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

// MARK: - Providers

private struct ProvidersSettingsTab: View {
    let model: AppModel
    @UIState private var isRefreshing = false

    var body: some View {
        Form {
            Section {
                if model.providers.isEmpty {
                    ContentUnavailableView(
                        "No Providers Found",
                        systemImage: "puzzlepiece.extension",
                        description: Text("Refresh to detect installed agent CLIs.")
                    )
                } else {
                    ForEach(model.providers) { provider in
                        ProviderRow(provider: provider, model: model)
                    }
                }
            } header: {
                HStack {
                    Text("Installed Providers")
                    Spacer()
                    Button {
                        refresh()
                    } label: {
                        if isRefreshing {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                    }
                    .disabled(isRefreshing)
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    private func refresh() {
        guard !isRefreshing else { return }
        isRefreshing = true
        Task {
            // Ask the server to re-probe installed CLIs (not just re-read
            // the cached list), then re-pull local state.
            await model.refreshProviders()
            await model.refreshAll()
            isRefreshing = false
        }
    }
}

private struct ProviderRow: View {
    let provider: ProviderInstance
    let model: AppModel
    @UIState private var isUpdating = false

    var body: some View {
        HStack {
            Image(systemName: provider.kind.symbolName)
                .frame(width: 20)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 2) {
                Text(provider.kind.displayName)
                if let version = provider.version {
                    Text(version)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            if provider.availability == .available {
                Button {
                    guard !isUpdating else { return }
                    isUpdating = true
                    Task {
                        await model.updateProvider(instanceID: provider.id)
                        isUpdating = false
                    }
                } label: {
                    if isUpdating {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Update CLI")
                    }
                }
                .controlSize(.small)
                .disabled(isUpdating)
                .help("Run \(provider.kind.cliCommand)'s own updater")
            }

            AvailabilityBadge(availability: provider.availability, kind: provider.kind)
        }
        .padding(.vertical, 2)
    }
}

private struct AvailabilityBadge: View {
    let availability: ProviderAvailability
    let kind: ProviderKind

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Label(title, systemImage: symbolName)
                .labelStyle(.titleAndIcon)
                .foregroundStyle(color)
                .font(.callout)

            if let hint {
                Text(hint)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var title: String {
        switch availability {
        case .available: "Available"
        case .authRequired: "Sign-in Required"
        case .missing: "Not Installed"
        }
    }

    private var symbolName: String {
        switch availability {
        case .available: "checkmark.circle.fill"
        case .authRequired: "key.fill"
        case .missing: "xmark.circle"
        }
    }

    private var color: Color {
        switch availability {
        case .available: .green
        case .authRequired: .orange
        case .missing: .secondary
        }
    }

    private var hint: String? {
        switch availability {
        case .available: nil
        case .authRequired: "run \(kind.cliCommand) login in Terminal"
        case .missing: "install \(kind.cliCommand) to use this provider"
        }
    }
}

private extension ProviderKind {
    var symbolName: String {
        switch self {
        case .claude: "sparkles"
        case .codex: "chevron.left.forwardslash.chevron.right"
        case .cursor: "cursorarrow"
        case .opencode: "curlybraces"
        }
    }

    var cliCommand: String {
        switch self {
        case .claude: "claude"
        case .codex: "codex"
        case .cursor: "cursor-agent"
        case .opencode: "opencode"
        }
    }
}

// MARK: - Connection

private struct ConnectionSettingsTab: View {
    let model: AppModel

    var body: some View {
        Form {
            Section {
                LabeledContent("Status") {
                    Label(model.connection.statusText, systemImage: model.connection.symbolName)
                        .foregroundStyle(model.connection.statusColor)
                }
            }

            Section("Server") {
                LabeledContent("Host", value: "127.0.0.1 (loopback)")
                LabeledContent("Mode", value: "desktop-managed-local")
                Text("The t3 server runs as a supervised local child process; no remote or cloud connection is used in v1.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private extension ConnectionPhase {
    var statusText: String {
        switch self {
        case .launchingServer: "Launching Server…"
        case .connecting: "Connecting…"
        case .ready: "Connected"
        case .reconnecting(let attempt): "Reconnecting (attempt \(attempt))…"
        case .failed(let message): "Failed: \(message)"
        }
    }

    var symbolName: String {
        switch self {
        case .launchingServer, .connecting, .reconnecting: "arrow.triangle.2.circlepath"
        case .ready: "checkmark.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        }
    }

    var statusColor: Color {
        switch self {
        case .launchingServer, .connecting, .reconnecting: .secondary
        case .ready: .green
        case .failed: .red
        }
    }
}
