import AppKit
import SwiftUI
import T3Kit

/// Settings tab identifiers — public so debug harnesses (UIProbe) can open
/// the window on a specific tab.
public enum SettingsTab: Hashable, CaseIterable, Identifiable {
    case general, providers, dictation, archive, scenery, devices, remoteMacs, connection

    public var id: Self { self }

    var title: String {
        switch self {
        case .general: "General"
        case .providers: "Providers"
        case .dictation: "Dictation"
        case .archive: "Archive"
        case .scenery: "Scenery"
        case .devices: "Devices"
        case .remoteMacs: "Remote Macs"
        case .connection: "Connection"
        }
    }

    var symbolName: String {
        switch self {
        case .general: "gearshape"
        case .providers: "puzzlepiece.extension"
        case .dictation: "mic"
        case .archive: "archivebox"
        case .scenery: "photo.on.rectangle.angled"
        case .devices: "macbook.and.iphone"
        case .remoteMacs: "desktopcomputer"
        case .connection: "network"
        }
    }
}

// Settings window content: `Settings { SettingsScene(...) }` in App.swift.
// Standard macOS Form-based settings — glass is not used here (this is a
// utility window, not a chrome surface over long-form content).
public struct SettingsScene: View {
    private let model: AppModel
    private let multi: MultiDeviceModel
    private let scenery: SceneryStore
    /// Mounted here (not at app root): Phase 5 Create Set flow only.
    /// Held in `@UIState` so App.body redraws that reconstruct `Settings {
    /// SettingsScene(...) }` do not drop in-flight create-set work.
    @UIState private var sceneSetComposer: SceneSetComposer
    @UIState private var selectedTab: SettingsTab

    public init(
        model: AppModel,
        scenery: SceneryStore,
        backend: any BackendService,
        multi: MultiDeviceModel? = nil,
        initialTab: SettingsTab = .general
    ) {
        self.model = model
        self.multi = multi ?? MultiDeviceModel(local: model)
        self.scenery = scenery
        _sceneSetComposer = UIState(
            initialValue: SceneSetComposer(store: scenery, backend: backend))
        _selectedTab = UIState(initialValue: initialTab)
    }

    public var body: some View {
        NavigationSplitView {
            List(selection: selectedTabBinding) {
                Section {
                    settingsRow(.general)
                }
                Section("Agents") {
                    settingsRow(.providers)
                    settingsRow(.dictation)
                }
                Section("Workspace") {
                    settingsRow(.archive)
                    settingsRow(.scenery)
                }
                Section("Devices") {
                    settingsRow(.devices)
                    settingsRow(.remoteMacs)
                    settingsRow(.connection)
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 170, ideal: 184, max: 210)
            .navigationTitle("Settings")
        } detail: {
            settingsDetail
                .navigationTitle(selectedTab.title)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: 760, height: 560)
        // Composer is owned by this scene only. Cancel in-flight create when
        // the Settings window closes so Unsplash work does not keep running
        // (and so `runCreate` can drop its self retain → deinit cancel).
        .onDisappear { sceneSetComposer.cancel() }
    }

    private var selectedTabBinding: Binding<SettingsTab?> {
        Binding(
            get: { selectedTab },
            set: { if let tab = $0 { selectedTab = tab } })
    }

    private func settingsRow(_ tab: SettingsTab) -> some View {
        Label(tab.title, systemImage: tab.symbolName)
            .tag(tab)
            .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
    }

    @ViewBuilder
    private var settingsDetail: some View {
        switch selectedTab {
        case .general:
            GeneralSettingsTab(model: model)
        case .providers:
            ProvidersSettingsTab(model: model)
        case .dictation:
            DictationSettingsTab(model: model)
        case .archive:
            ArchiveSettingsTab(model: model)
        case .scenery:
            ScenerySettingsTab(model: model, scenery: scenery, composer: sceneSetComposer)
        case .devices:
            PhoneSettingsTab(model: model)
        case .remoteMacs:
            RemoteMacsSettingsTab(multi: multi)
        case .connection:
            ConnectionSettingsTab(model: model)
        }
    }
}

// MARK: - General

private struct GeneralSettingsTab: View {
    let model: AppModel
    @UIState private var draft: AppSettings?
    @FocusState private var projectsDirectoryFocused: Bool

    @UIState private var notificationsMasterEnabled = AgentNotificationPreferences.isMasterEnabled
    @UIState private var notifyFinished = AgentNotificationPreferences.isEnabled(.finished)
    @UIState private var notifyStalled = AgentNotificationPreferences.isEnabled(.stalled)
    @UIState private var notifyApproval = AgentNotificationPreferences.isEnabled(.needsApproval)
    @UIState private var notifyInput = AgentNotificationPreferences.isEnabled(.needsInput)
    @UIState private var notifyFailed = AgentNotificationPreferences.isEnabled(.failed)

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
                        text: textBinding(settings, \.addProjectBaseDirectory))
                        .focused($projectsDirectoryFocused)
                        .onSubmit { commitProjectsDirectory() }
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
                Toggle("Agent notifications", isOn: $notificationsMasterEnabled)
                    .onChange(of: notificationsMasterEnabled) { _, enabled in
                        AgentNotificationPreferences.isMasterEnabled = enabled
                        if enabled {
                            AgentNotificationService.shared.requestAuthorizationIfNeeded()
                        }
                    }
                Text(
                    "Banner when agents finish, stall, fail, or need your input — suppressed while that thread is frontmost."
                )
                .font(.caption)
                .foregroundStyle(.secondary)

                if notificationsMasterEnabled {
                    Toggle(AgentNotificationKind.finished.settingsLabel, isOn: $notifyFinished)
                        .onChange(of: notifyFinished) { _, enabled in
                            AgentNotificationPreferences.setEnabled(.finished, enabled)
                        }
                        .help(AgentNotificationKind.finished.settingsHelp)
                    Toggle(AgentNotificationKind.stalled.settingsLabel, isOn: $notifyStalled)
                        .onChange(of: notifyStalled) { _, enabled in
                            AgentNotificationPreferences.setEnabled(.stalled, enabled)
                        }
                        .help(AgentNotificationKind.stalled.settingsHelp)
                    Toggle(AgentNotificationKind.needsApproval.settingsLabel, isOn: $notifyApproval)
                        .onChange(of: notifyApproval) { _, enabled in
                            AgentNotificationPreferences.setEnabled(.needsApproval, enabled)
                        }
                        .help(AgentNotificationKind.needsApproval.settingsHelp)
                    Toggle(AgentNotificationKind.needsInput.settingsLabel, isOn: $notifyInput)
                        .onChange(of: notifyInput) { _, enabled in
                            AgentNotificationPreferences.setEnabled(.needsInput, enabled)
                        }
                        .help(AgentNotificationKind.needsInput.settingsHelp)
                    Toggle(AgentNotificationKind.failed.settingsLabel, isOn: $notifyFailed)
                        .onChange(of: notifyFailed) { _, enabled in
                            AgentNotificationPreferences.setEnabled(.failed, enabled)
                        }
                        .help(AgentNotificationKind.failed.settingsHelp)
                }
            } header: {
                Text("Notifications")
            }

            Section {
                LabeledContent("Appearance", value: "Dark")
                    .help("SurgeCode uses its dark appearance independently of macOS system appearance.")
                LabeledContent("Version", value: Bundle.main.appVersionDisplay)
            }
        }
        .formStyle(.grouped)
        .padding()
        // Loaded settings fade in over the placeholder spinner.
        .animation(Motion.reveal, value: draft == nil)
        .task {
            await model.loadSettings()
            draft = model.settings
        }
        // Blur (not just Return) also commits — clicking another field, a
        // tab, or closing the window shouldn't silently drop the edit.
        .onChange(of: projectsDirectoryFocused) { wasFocused, isFocused in
            if wasFocused && !isFocused {
                commitProjectsDirectory()
            }
        }
        .onDisappear { commitProjectsDirectory() }
    }

    /// Edit-in-place binding that persists the whole subset patch on change.
    /// Fine for toggles/pickers: every change is one deliberate action, not a
    /// stream of keystrokes.
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

    /// Text-field binding: updates the local draft on every keystroke (so
    /// typing feels normal) but does not save — callers commit on submit/
    /// blur instead, so a full-settings RPC doesn't fire per keystroke.
    private func textBinding(
        _ current: AppSettings, _ keyPath: WritableKeyPath<AppSettings, String>
    ) -> Binding<String> {
        Binding(
            get: { (draft ?? current)[keyPath: keyPath] },
            set: { newValue in
                var next = draft ?? current
                next[keyPath: keyPath] = newValue
                draft = next
            })
    }

    private func commitProjectsDirectory() {
        guard let draft else { return }
        Task { await model.saveSettings(draft) }
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
    @UIState private var deleteTarget: ChatThread?
    @UIState private var searchText = ""

    var body: some View {
        Form {
            Section("Archived threads") {
                if model.archivedThreadsLoading && model.archivedThreads.isEmpty {
                    ProgressView("Loading archived threads…")
                } else if let error = model.archivedThreadsError {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Could not load archived threads", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button("Try Again") {
                            Task { await model.refreshArchivedThreads() }
                        }
                    }
                } else if model.archivedThreads.isEmpty {
                    Text("No archived threads.")
                        .foregroundStyle(.secondary)
                } else {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(.secondary)
                        TextField("Search archived threads", text: $searchText)
                            .textFieldStyle(.plain)
                    }
                    .padding(.vertical, 4)

                    if filteredThreads.isEmpty {
                        ContentUnavailableView(
                            "No Matching Threads",
                            systemImage: "magnifyingglass",
                            description: Text("Try a different title or provider name."))
                    }

                    ForEach(filteredThreads) { thread in
                        HStack {
                            ProviderIcon(
                                provider: thread.provider, modelID: thread.modelID, size: 16
                            )
                            .foregroundStyle(.secondary)
                            .frame(width: 20)
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
                            Menu {
                                Button("Delete Permanently", role: .destructive) {
                                    deleteTarget = thread
                                }
                            } label: {
                                Image(systemName: "ellipsis.circle")
                            }
                            .menuStyle(.borderlessButton)
                            .menuIndicator(.hidden)
                            .fixedSize()
                            .accessibilityLabel("More actions for \(thread.title)")
                        }
                        .padding(.vertical, 2)
                        .transition(Motion.rise)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .padding()
        .task { await model.refreshArchivedThreads() }
        .animation(Motion.structure, value: model.archivedThreads.map(\.id))
        .alert(
            "Delete Session?",
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            )
        ) {
            Button("Delete", role: .destructive) {
                if let target = deleteTarget {
                    deleteTarget = nil
                    Task { await model.deleteThread(target) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let target = deleteTarget {
                Text("“\(target.title)” will be permanently deleted. This can't be undone.")
            }
        }
    }

    private var filteredThreads: [ChatThread] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return model.archivedThreads }
        return model.archivedThreads.filter {
            $0.title.localizedCaseInsensitiveContains(query)
                || $0.provider.displayName.localizedCaseInsensitiveContains(query)
        }
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
                    .animation(Motion.reveal, value: isRefreshing)
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
            ProviderIcon(provider: provider.kind, size: 16)
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

            if provider.availability == .available {
                if isUpdating {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 22)
                        .transition(.opacity)
                } else {
                    Menu {
                        Button("Run \(provider.kind.cliCommand) Updater") {
                            guard !isUpdating else { return }
                            isUpdating = true
                            Task {
                                await model.updateProvider(instanceID: provider.id)
                                isUpdating = false
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .accessibilityLabel("Actions for \(provider.kind.displayName)")
                    .help("Provider actions")
                    .transition(.opacity)
                }
            }
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
        case .available: "Ready"
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
        case .authRequired: "Run \(kind.cliCommand) login in Terminal."
        case .missing: "Install \(kind.cliCommand) to use this provider."
        }
    }
}

private extension ProviderKind {
    var cliCommand: String {
        switch self {
        case .claude: "claude"
        case .claudeWork: "claude"
        case .claudex: "claudex"
        case .claudeSynthero: "claude"
        case .codex: "codex"
        case .grok: "grok"
        case .fugu: "codex-fugu"
        case .legacyCursor: "cursor"
        }
    }
}

// MARK: - Devices (host-side mobile pairing)

private struct PhoneSettingsTab: View {
    let model: AppModel
    @UIState private var allowConnections = MobileAccessPreference.isEnabled
    @UIState private var tailscaleEnabled = TailscaleAccessPreference.isEnabled
    @UIState private var lanReachable = false
    /// MagicDNS hostname while `tailscale serve` is active on the running
    /// sidecar; nil when serve is off, unavailable, or not recorded yet.
    @UIState private var tailnetHostname: String?
    @UIState private var checkedReachability = false
    @UIState private var pairing: MobilePairingInfo?
    @UIState private var pairingError: String?
    /// Bumped by "New Code" to restart the mint loop with a fresh credential.
    @UIState private var mintGeneration = 0

    var body: some View {
        Form {
            Section {
                Toggle(
                    "Remote access over Tailscale",
                    isOn: Binding(
                        get: { tailscaleEnabled },
                        set: { newValue in
                            tailscaleEnabled = newValue
                            TailscaleAccessPreference.setEnabled(newValue)
                        }))
                Text(
                    "Reach this Mac from anywhere your Tailscale network extends. When active, pairing links use this Mac's tailnet address (\(tailnetHostname ?? "your MagicDNS name")) instead of a local-network IP."
                )
                .font(.caption)
                .foregroundStyle(.secondary)

                if checkedReachability {
                    LabeledContent("Remote address") {
                        Text(remoteAddressText)
                            .textSelection(.enabled)
                    }
                }
            }

            Section {
                Toggle(
                    "Allow iPhone and Mac connections on your local network",
                    isOn: Binding(
                        get: { allowConnections },
                        set: { newValue in
                            allowConnections = newValue
                            MobileAccessPreference.setEnabled(newValue)
                        }))
                Text(
                    "Pair SurgeCode on an iPhone or another Mac to chat with this Mac's sessions over Wi‑Fi. The same one-time link or QR code below works for either device; macOS may ask to allow incoming network connections."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            // The sidecar's bind host and Tailscale-serve flag are captured
            // at launch and can't change for the life of the process (see
            // MobileAccessPreference / TailscaleAccessPreference doc
            // comments); `lanReachable`/`tailnetHostname` reflect that frozen
            // state, while the toggles are the live preferences. Whenever
            // they disagree — in EITHER direction — a toggle's current
            // position is not what the server is actually doing, and that's
            // security-relevant when it disagrees by still being open.
            if checkedReachability && !tailscaleEnabled && tailnetHostname != nil {
                Section {
                    Label(
                        "Tailscale access is still on for this session — quit and reopen SurgeCode to stop serving over your tailnet.",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .foregroundStyle(.red)
                }
            }
            if checkedReachability && tailscaleEnabled && tailnetHostname == nil {
                Section {
                    Label(
                        "Tailscale isn't serving yet — if you just turned this on, quit and reopen SurgeCode; otherwise make sure Tailscale is installed and signed in on this Mac.",
                        systemImage: "info.circle"
                    )
                    .foregroundStyle(.secondary)
                }
            }
            if checkedReachability && allowConnections != lanReachable {
                Section {
                    Label(
                        relaunchWarningText,
                        systemImage: relaunchWarningSymbol
                    )
                    .foregroundStyle(relaunchWarningColor)
                }
            }

            if pairingAvailable {
                Section("Pair a device") {
                    pairingContent
                }
            }
        }
        .formStyle(.grouped)
        .padding()
        .animation(Motion.structure, value: allowConnections)
        .animation(Motion.structure, value: tailscaleEnabled)
        .animation(Motion.structure, value: pairing)
        // Re-probe whenever the connection phase moves (the sidecar may
        // still be launching when Settings opens) or a toggle flips —
        // a one-shot .task would leave the frozen-state mirrors stale.
        .task(
            id: "\(String(describing: model.connection))-\(allowConnections)-\(tailscaleEnabled)"
        ) {
            await refreshRemoteAccess()
        }
        .task(
            id: "\(allowConnections)-\(lanReachable)-\(tailnetHostname ?? "no-tailnet")-\(mintGeneration)"
        ) {
            await runMintLoop()
        }
    }

    /// Pairing works whenever the server is reachable beyond this process:
    /// over the tailnet (serve proxies loopback — no LAN bind needed), or
    /// over the LAN when the mobile-access bind is active.
    private var pairingAvailable: Bool {
        checkedReachability && (tailnetHostname != nil || (allowConnections && lanReachable))
    }

    /// The address remote devices will actually use, in preference order:
    /// tailnet hostname, LAN IP, loopback (nothing reachable).
    private var remoteAddressText: String {
        if let tailnetHostname { return tailnetHostname }
        if lanReachable, let lanAddress = LanAddressResolver.primaryIPv4() {
            return "\(lanAddress) (local network)"
        }
        return "127.0.0.1 (this Mac only)"
    }

    private func refreshRemoteAccess() async {
        let status = await model.remoteAccessStatus()
        lanReachable = status.lanReachable
        tailnetHostname = status.tailnetHostname
        checkedReachability = true
        // The serve record can land a few seconds after sidecar boot;
        // re-poll briefly so the tailnet address appears without having to
        // reopen Settings.
        var attempts = 0
        while tailscaleEnabled, tailnetHostname == nil, attempts < 5, !Task.isCancelled {
            try? await Task.sleep(for: .seconds(2))
            let refreshed = await model.remoteAccessStatus()
            lanReachable = refreshed.lanReachable
            tailnetHostname = refreshed.tailnetHostname
            attempts += 1
        }
    }

    @ViewBuilder
    private var pairingContent: some View {
        if let pairing {
            HStack(alignment: .top, spacing: 16) {
                QRCodePairingView(text: pairing.pairingURL.absoluteString)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Open SurgeCode on an iPhone or another Mac, then scan this QR code or paste the link.")
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

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Pairing link")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        HStack(alignment: .top, spacing: 8) {
                            Text(pairing.pairingURL.absoluteString)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)

                            Button {
                                Pasteboard.copy(pairing.pairingURL.absoluteString)
                            } label: {
                                Label("Copy Link", systemImage: "doc.on.doc")
                            }
                            .controlSize(.small)
                        }
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
    /// whenever the toggles, reachability, or generation change.
    private func runMintLoop() async {
        guard tailnetHostname != nil || (allowConnections && lanReachable) else { return }
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

    /// `allowConnections` (ON) but the launch-captured bind is still
    /// loopback-only: informational, connections aren't accepted yet.
    /// `allowConnections` (OFF) but the launch-captured bind is still
    /// open: security-relevant — the port is still listening on the LAN
    /// even though the toggle reads off.
    private var relaunchWarningText: String {
        allowConnections
            ? "Off until you quit and reopen SurgeCode — this Mac isn't yet accepting iPhone or Mac connections."
            : "Still on for this session — quit and reopen SurgeCode to fully stop accepting local network connections."
    }

    private var relaunchWarningSymbol: String {
        allowConnections ? "arrow.counterclockwise.circle" : "exclamationmark.triangle.fill"
    }

    private var relaunchWarningColor: Color {
        allowConnections ? .orange : .red
    }

    private static func friendlyMintError(_ error: Error) -> String {
        switch error {
        case LiveBackendError.noLanAddress:
            return "This Mac doesn't appear to be on a network — join Wi‑Fi and try again."
        case LiveBackendError.mobileAccessDisabled:
            return "Quit and reopen SurgeCode to start accepting iPhone or Mac connections."
        case LiveBackendError.notConnected:
            return "Waiting for the local server — try again once the app shows Connected."
        default:
            return "Couldn't create a pairing code: \(error)"
        }
    }
}

// MARK: - Remote Macs

struct RemoteMacsSettingsTab: View {
    let multi: MultiDeviceModel

    @UIState private var pairingLink = ""
    @UIState private var isPairing = false
    @UIState private var pairingError: String?
    /// True when `pairingError` is the macOS Local Network privacy denial —
    /// shows the "Open Local Network Settings" shortcut instead of just text.
    @UIState private var pairingErrorIsLocalNetworkDenial = false
    @UIState private var forgetTarget: DeviceID?

    var body: some View {
        Form {
            Section("Add a Mac") {
                HStack(spacing: 8) {
                    TextField("Paste pairing link…", text: $pairingLink)
                        .textFieldStyle(.roundedBorder)
                        .disabled(isPairing)
                    Button("Connect") { connect() }
                        .disabled(isPairing || pairingLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                if isPairing {
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                if let pairingError {
                    Label(pairingError, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                    if pairingErrorIsLocalNetworkDenial {
                        Button("Open Local Network Settings") { openLocalNetworkSettings() }
                            .controlSize(.small)
                    }
                }

                Text("On the other Mac, open Settings ▸ Devices and copy its pairing link or scan its QR code.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Paired Macs") {
                if multi.remoteSessions.isEmpty {
                    Text("No Macs paired yet.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(multi.remoteSessions) { session in
                        remoteMacRow(session)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .padding()
        .confirmationDialog(
            "Forget Mac?",
            isPresented: Binding(
                get: { forgetTarget != nil },
                set: { if !$0 { forgetTarget = nil } }
            )
        ) {
            Button("Forget", role: .destructive) {
                if let id = forgetTarget {
                    forgetTarget = nil
                    Task { await multi.removeRemoteDevice(id: id) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            let name = forgetTarget.flatMap { id in
                multi.remoteSessions.first { $0.id == id }?.descriptor.name
            } ?? "this Mac"
            Text("Remove “\(name)” and its saved pairing from this Mac?")
        }
    }

    @ViewBuilder
    private func remoteMacRow(_ session: RemoteDeviceSession) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.descriptor.name)
                    Text(address(for: session))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                Spacer(minLength: 8)
                if session.connection != .ready {
                    Button("Retry Now") {
                        Task { await multi.reconnect(id: session.id) }
                    }
                    .controlSize(.small)
                }
                Button("Forget", role: .destructive) {
                    forgetTarget = session.id
                }
                .controlSize(.small)
            }

            Label(
                session.connection.statusText,
                systemImage: session.connection.symbolName)
                .font(.caption)
                .foregroundStyle(session.connection.statusColor)
                .contentTransition(
                    Motion.reduceMotion ? .identity : .symbolEffect(.replace))
                .animation(Motion.ambient, value: session.connection)

            if expiresSoon(session) {
                Text("Expires soon")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }

            if session.connection == .unauthorized {
                Label(
                    "Re-pair: paste a fresh link from this Mac in Add a Mac above.",
                    systemImage: "arrow.triangle.2.circlepath")
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            } else if session.connection.needsAttention {
                Label(
                    "This Mac is not responding. Retry now, or paste a fresh pairing link above.",
                    systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 3)
    }

    private func address(for session: RemoteDeviceSession) -> String {
        if let port = session.descriptor.port {
            return "\(session.descriptor.host):\(port)"
        }
        return session.descriptor.host
    }

    private func expiresSoon(_ session: RemoteDeviceSession) -> Bool {
        guard let expiresAt = session.descriptor.sessionExpiresAt else { return false }
        let remaining = expiresAt.timeIntervalSinceNow
        return remaining > 0 && remaining <= 3 * 24 * 60 * 60
    }

    private func connect() {
        let link = pairingLink.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !link.isEmpty, !isPairing else { return }
        isPairing = true
        pairingError = nil
        pairingErrorIsLocalNetworkDenial = false
        Task {
            do {
                _ = try await multi.addRemoteDevice(pairingLink: link)
                pairingLink = ""
            } catch {
                if case PairingClientError.localNetworkDenied = error {
                    pairingErrorIsLocalNetworkDenial = true
                    pairingError =
                        "macOS is blocking local network access for SurgeCode. Enable SurgeCode under Privacy & Security → Local Network, then try again."
                } else {
                    pairingError = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
                }
            }
            isPairing = false
        }
    }

    private func openLocalNetworkSettings() {
        let url = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork")!
        NSWorkspace.shared.open(url)
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
    @UIState private var access = ServerRemoteAccessStatus(
        lanReachable: false, tailnetHostname: nil)

    var body: some View {
        Form {
            Section {
                LabeledContent("Status") {
                    Label(model.connection.statusText, systemImage: model.connection.symbolName)
                        .foregroundStyle(model.connection.statusColor)
                        .contentTransition(
                            Motion.reduceMotion ? .identity : .symbolEffect(.replace))
                        .animation(Motion.ambient, value: model.connection)
                }
            }

            Section("Server") {
                LabeledContent(
                    "Host",
                    value: access.lanReachable
                        ? "0.0.0.0 (local network)" : "127.0.0.1 (loopback)")
                LabeledContent(
                    "Mode",
                    value: access.lanReachable || access.tailnetHostname != nil
                        ? "remote-reachable" : "desktop-managed-local")
                LabeledContent("Tailscale") {
                    Text(access.tailnetHostname ?? "Off")
                        .textSelection(.enabled)
                }
                Text(serverCaption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
        // Keyed to the connection phase so the rows update if the server
        // comes up (or restarts) after the Settings window opened. The serve
        // record can arrive shortly after the sidecar becomes reachable.
        .task(id: model.connection) { await refreshRemoteAccess() }
    }

    private func refreshRemoteAccess() async {
        access = await model.remoteAccessStatus()
        var attempts = 0
        while TailscaleAccessPreference.isEnabled,
            access.tailnetHostname == nil,
            attempts < 5,
            !Task.isCancelled
        {
            try? await Task.sleep(for: .seconds(2))
            access = await model.remoteAccessStatus()
            attempts += 1
        }
    }

    private var serverCaption: String {
        if access.tailnetHostname != nil {
            return "The t3 server runs as a supervised local child process; Tailscale serve makes it reachable at its tailnet address for paired devices (Settings ▸ Devices)."
        }
        return access.lanReachable
            ? "The t3 server runs as a supervised local child process and accepts paired devices from your local network (Settings ▸ Devices)."
            : "The t3 server runs as a supervised local child process; no remote or cloud connection is used."
    }
}
