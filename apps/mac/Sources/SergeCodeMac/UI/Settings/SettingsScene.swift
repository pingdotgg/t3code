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
            GeneralSettingsTab()
                .tabItem { Label("General", systemImage: "gearshape") }

            ProvidersSettingsTab(model: model)
                .tabItem { Label("Providers", systemImage: "puzzlepiece.extension") }

            ConnectionSettingsTab(model: model)
                .tabItem { Label("Connection", systemImage: "network") }
        }
        .frame(width: 520, height: 360)
    }
}

// MARK: - General

private struct GeneralSettingsTab: View {
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
            Section {
                LabeledContent("Appearance", value: "Follows System")
                    .help("SergeCode does not offer a manual light/dark override; it follows macOS.")
            }

            Section {
                LabeledContent("Version", value: appVersion)
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
                        ProviderRow(provider: provider)
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
            await model.refreshAll()
            isRefreshing = false
        }
    }
}

private struct ProviderRow: View {
    let provider: ProviderInstance

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
