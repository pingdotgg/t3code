import SwiftUI

/// Settings tab identifiers — public so debug harnesses (UIProbe) can open
/// the window on a specific tab.
public enum SettingsTab: Hashable {
    case general, providers, dictation, archive, iphone, connection
}

// Settings window content: `Settings { SettingsScene(model: model) }` in App.swift.
// Standard macOS Form-based settings — glass is not used here (this is a
// utility window, not a chrome surface over long-form content).
public struct SettingsScene: View {
    private let model: AppModel
    @UIState private var selectedTab: SettingsTab

    public init(model: AppModel, initialTab: SettingsTab = .general) {
        self.model = model
        _selectedTab = UIState(initialValue: initialTab)
    }

    public var body: some View {
        TabView(selection: $selectedTab) {
            GeneralSettingsTab(model: model)
                .tabItem { Label("General", systemImage: "gearshape") }
                .tag(SettingsTab.general)

            ProvidersSettingsTab(model: model)
                .tabItem { Label("Providers", systemImage: "puzzlepiece.extension") }
                .tag(SettingsTab.providers)

            DictationSettingsTab(model: model)
                .tabItem { Label("Dictation", systemImage: "mic") }
                .tag(SettingsTab.dictation)

            ArchiveSettingsTab(model: model)
                .tabItem { Label("Archive", systemImage: "archivebox") }
                .tag(SettingsTab.archive)

            PhoneSettingsTab(model: model)
                .tabItem { Label("iPhone", systemImage: "iphone") }
                .tag(SettingsTab.iphone)

            ConnectionSettingsTab(model: model)
                .tabItem { Label("Connection", systemImage: "network") }
                .tag(SettingsTab.connection)
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
                    .help("SurgeCode does not offer a manual light/dark override; it follows macOS.")
                LabeledContent("Version", value: appVersion)
            }
        }
        .formStyle(.grouped)
        .padding()
        // Loaded settings fade in over the placeholder spinner.
        .animation(Motion.settle, value: draft == nil)
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

// MARK: - Dictation

// Internal (not private) so the DEBUG UIProbe can host it directly.
struct DictationSettingsTab: View {
    @Bindable private var dictation: DictationController

    init(model: AppModel) {
        dictation = model.dictation
    }

    var body: some View {
        Form {
            Section("Speech model") {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Parakeet v3 (on-device)")
                        Text("25 languages · ~2.5 GB · runs on the Neural Engine")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    modelStatusControl
                }
                .padding(.vertical, 2)

                LabeledContent("Storage") {
                    Text(dictation.modelCacheDirectory.path(percentEncoded: false))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            Section("Transcript cleanup") {
                Toggle(
                    "Clean up transcript with on-device AI",
                    isOn: $dictation.cleanupEnabled)
                    .disabled(!dictation.cleanupAvailable)
                Text(
                    dictation.cleanupAvailable
                        ? "Fixes punctuation and removes filler words with the built-in Apple Intelligence model. Nothing leaves this Mac."
                        : "Requires Apple Intelligence. Until it's enabled, dictation inserts the raw transcript."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Section("Language") {
                Picker("Spoken language", selection: $dictation.languageCode) {
                    Text("Auto-detect").tag(DictationController.autoLanguage)
                    ForEach(DictationController.supportedLanguageCodes, id: \.self) { code in
                        Text(Self.languageName(for: code)).tag(code)
                    }
                }
            }

            Section {
                Text("Dictation is fully local: audio and transcripts never leave this Mac.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
        .animation(Motion.ambient, value: dictation.modelStatus)
    }

    @ViewBuilder
    private var modelStatusControl: some View {
        switch dictation.modelStatus {
        case .notDownloaded:
            Button("Download") { dictation.downloadModel() }
        case .downloading(let fraction):
            HStack(spacing: 8) {
                ProgressView(value: fraction)
                    .frame(width: 90)
                Text(fraction.formatted(.percent.precision(.fractionLength(0))))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        case .ready:
            HStack(spacing: 10) {
                Label("Downloaded", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.callout)
                Button("Remove") { dictation.removeModel() }
                    .controlSize(.small)
            }
        }
    }

    private static func languageName(for code: String) -> String {
        Locale.current.localizedString(forLanguageCode: code)?.capitalized ?? code
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
                        .transition(Motion.rise)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .padding()
        .animation(Motion.settle, value: model.archivedThreads.map(\.id))
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
                                .transition(.opacity)
                        } else {
                            Label("Refresh", systemImage: "arrow.clockwise")
                                .transition(.opacity)
                        }
                    }
                    .disabled(isRefreshing)
                    .animation(Motion.fade, value: isRefreshing)
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
                            .transition(.opacity)
                    } else {
                        Text("Update CLI")
                            .transition(.opacity)
                    }
                }
                .controlSize(.small)
                .disabled(isUpdating)
                .animation(Motion.fade, value: isUpdating)
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
        case .claudeSynthero: "link"
        case .codex: "chevron.left.forwardslash.chevron.right"
        case .cursor: "cursorarrow"
        case .grok: "bolt"
        case .fugu: "fish"
        case .opencode: "curlybraces"
        }
    }

    var cliCommand: String {
        switch self {
        case .claude: "claude"
        case .claudeSynthero: "claude"
        case .codex: "codex"
        case .cursor: "cursor-agent"
        case .grok: "grok"
        case .fugu: "codex"
        case .opencode: "opencode"
        }
    }
}

// MARK: - iPhone (mobile pairing)

private struct PhoneSettingsTab: View {
    let model: AppModel
    @UIState private var allowConnections = MobileAccessPreference.isEnabled
    @UIState private var lanReachable = false
    @UIState private var checkedReachability = false
    @UIState private var pairing: MobilePairingInfo?
    @UIState private var pairingError: String?
    /// Bumped by "New Code" to restart the mint loop with a fresh credential.
    @UIState private var mintGeneration = 0

    var body: some View {
        Form {
            Section {
                Toggle(
                    "Allow iPhone connections on your local network",
                    isOn: Binding(
                        get: { allowConnections },
                        set: { newValue in
                            allowConnections = newValue
                            MobileAccessPreference.setEnabled(newValue)
                        }))
                Text(
                    "Pair the SergeCode app on your iPhone to chat with this Mac's sessions over Wi‑Fi. Every connection needs a one-time code from below; macOS may ask to allow incoming network connections."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            if allowConnections && checkedReachability {
                if lanReachable {
                    Section("Pair your iPhone") {
                        pairingContent
                    }
                } else {
                    Section {
                        Label(
                            "Quit and reopen SurgeCode to start accepting iPhone connections.",
                            systemImage: "arrow.counterclockwise.circle"
                        )
                        .foregroundStyle(.orange)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .padding()
        .animation(Motion.settle, value: allowConnections)
        .animation(Motion.settle, value: pairing)
        // Re-probe whenever the connection phase moves (the sidecar may
        // still be launching when Settings opens) or the toggle flips —
        // a one-shot .task would leave `lanReachable` stale.
        .task(id: "\(String(describing: model.connection))-\(allowConnections)") {
            lanReachable = await model.isServerLanReachable()
            checkedReachability = true
        }
        .task(id: "\(allowConnections)-\(lanReachable)-\(mintGeneration)") {
            await runMintLoop()
        }
    }

    @ViewBuilder
    private var pairingContent: some View {
        if let pairing {
            HStack(alignment: .top, spacing: 16) {
                QRCodePairingView(text: pairing.pairingURL.absoluteString)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Open SergeCode on your iPhone, choose Scan QR Code, and point it here.")
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)

                    LabeledContent("Code") {
                        Text(pairing.credential)
                            .font(.body.monospaced())
                            .textSelection(.enabled)
                    }
                    LabeledContent("Address") {
                        Text(pairing.pairingURL.host() ?? "—")
                            .textSelection(.enabled)
                    }

                    HStack(spacing: 12) {
                        // A minted code lives ~5 minutes; the loop below
                        // replaces it automatically just before expiry.
                        HStack(spacing: 4) {
                            Text("Expires in")
                            Text(pairing.expiresAt, style: .timer)
                                .monospacedDigit()
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)

                        Button("New Code") { mintGeneration += 1 }
                            .controlSize(.small)
                    }
                }
            }
            .padding(.vertical, 4)
        } else if let pairingError {
            Label(pairingError, systemImage: "exclamationmark.triangle")
                .foregroundStyle(.red)
            Button("Try Again") { mintGeneration += 1 }
        } else {
            ProgressView()
                .frame(maxWidth: .infinity)
        }
    }

    /// Mints a pairing code, then re-mints shortly before each expiry so
    /// the QR on screen is always redeemable. Cancelled (via `.task(id:)`)
    /// whenever the toggle, reachability, or generation changes.
    private func runMintLoop() async {
        guard allowConnections, lanReachable else { return }
        while !Task.isCancelled {
            do {
                pairingError = nil
                let minted = try await model.mintMobilePairing()
                pairing = minted
                let refreshIn = max(5, minted.expiresAt.timeIntervalSinceNow - 15)
                try await Task.sleep(nanoseconds: UInt64(refreshIn * 1_000_000_000))
            } catch is CancellationError {
                return
            } catch {
                pairing = nil
                pairingError = Self.friendlyMintError(error)
                return
            }
        }
    }

    private static func friendlyMintError(_ error: Error) -> String {
        switch error {
        case LiveBackendError.noLanAddress:
            return "This Mac doesn't appear to be on a network — join Wi‑Fi and try again."
        case LiveBackendError.mobileAccessDisabled:
            return "Quit and reopen SurgeCode to start accepting iPhone connections."
        case LiveBackendError.notConnected:
            return "Waiting for the local server — try again once the app shows Connected."
        default:
            return "Couldn't create a pairing code: \(error)"
        }
    }
}

/// The scannable pairing QR: always dark modules on a white tile so it scans
/// in dark mode too.
private struct QRCodePairingView: View {
    let text: String

    var body: some View {
        if let cgImage = QRCodeRenderer.image(for: text) {
            Image(decorative: cgImage, scale: 1)
                .resizable()
                .interpolation(.none)
                .frame(width: 148, height: 148)
                .padding(10)
                .background(.white, in: RoundedRectangle(cornerRadius: 10))
                .accessibilityLabel("Pairing QR code")
        } else {
            RoundedRectangle(cornerRadius: 10)
                .fill(.quaternary)
                .frame(width: 168, height: 168)
                .overlay {
                    Label("QR unavailable", systemImage: "qrcode")
                        .foregroundStyle(.secondary)
                }
        }
    }
}

// MARK: - Connection

private struct ConnectionSettingsTab: View {
    let model: AppModel
    @UIState private var lanReachable = false

    var body: some View {
        Form {
            Section {
                LabeledContent("Status") {
                    Label(model.connection.statusText, systemImage: model.connection.symbolName)
                        .foregroundStyle(model.connection.statusColor)
                        .contentTransition(.symbolEffect(.replace))
                        .animation(Motion.ambient, value: model.connection)
                }
            }

            Section("Server") {
                LabeledContent(
                    "Host", value: lanReachable ? "0.0.0.0 (local network)" : "127.0.0.1 (loopback)")
                LabeledContent(
                    "Mode", value: lanReachable ? "remote-reachable" : "desktop-managed-local")
                Text(
                    lanReachable
                        ? "The t3 server runs as a supervised local child process and accepts paired devices from your local network (Settings ▸ iPhone)."
                        : "The t3 server runs as a supervised local child process; no remote or cloud connection is used."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
        // Keyed to the connection phase so the row updates if the server
        // comes up (or restarts) after the Settings window opened.
        .task(id: model.connection) { lanReachable = await model.isServerLanReachable() }
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
