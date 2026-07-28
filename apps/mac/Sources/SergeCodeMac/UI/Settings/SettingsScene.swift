import AppKit
import SwiftUI
import T3Kit

/// Settings tab identifiers — public so debug harnesses (UIProbe) can open
/// the window on a specific tab.
public enum SettingsTab: Hashable, CaseIterable, Identifiable {
    case general, providers, workflows, dictation, autoReview, archive, scenery, devices, remoteMacs,
        connection

    public var id: Self { self }

    var title: String {
        switch self {
        case .general: "General"
        case .providers: "Providers"
        case .workflows: "Workflows"
        case .dictation: "Dictation"
        case .autoReview: "Auto Review"
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
        case .workflows: "point.3.connected.trianglepath.dotted"
        case .dictation: "mic"
        case .autoReview: "text.magnifyingglass"
        case .archive: "archivebox"
        case .scenery: "photo.on.rectangle.angled"
        case .devices: "macbook.and.iphone"
        case .remoteMacs: "desktopcomputer"
        case .connection: "network"
        }
    }
}

// Settings window content: `Settings { SettingsScene(...) }` in App.swift.
// Alpine-skinned custom chrome (see SettingsChrome.swift) — glass is not
// used here (this is a utility window, not a chrome surface over long-form
// content), so surfaces are plain dark fills and materials.
public struct SettingsScene: View {
    private let model: AppModel
    private let multi: MultiDeviceModel
    private let scenery: SceneryStore
    @UIState private var selectedTab: SettingsTab

    public init(
        model: AppModel,
        scenery: SceneryStore,
        multi: MultiDeviceModel? = nil,
        initialTab: SettingsTab = .general
    ) {
        self.model = model
        self.multi = multi ?? MultiDeviceModel(local: model)
        self.scenery = scenery
        _selectedTab = UIState(initialValue: initialTab)
    }

    public var body: some View {
        HStack(spacing: 0) {
            SettingsSidebar(selection: sidebarSelection)
            Rectangle()
                .fill(Color.white.opacity(0.09))
                .frame(width: 1)
            settingsDetailPane
        }
        .frame(width: 780, height: 560)
        .navigationTitle("Settings")
        .background {
            // Same dark base as the main window's solid plate, plus the
            // shared diagonal nature wash used on picker surfaces.
            ZStack {
                Color(nsColor: .windowBackgroundColor)
                LinearGradient(
                    colors: [
                        AlpineTheme.accent.opacity(0.075),
                        Color.clear,
                        AlpineTheme.sky.opacity(0.045),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing)
            }
        }
    }

    /// Selection is never nil: the sidebar binding only ever writes a tab.
    private var sidebarSelection: Binding<SettingsTab> {
        Binding(
            get: { selectedTab },
            set: { selectedTab = $0 })
    }

    private var settingsDetailPane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                paneHeader
                // The composer is the only other renderer of the global
                // `lastError`, and this window never hosts one — without this
                // banner every failed save/refresh started here is silent.
                if let lastError = model.lastError {
                    errorBanner(lastError)
                }
                settingsDetail
            }
            .animation(Motion.reveal, value: model.lastError)
            .padding(.horizontal, 22)
            .padding(.vertical, 20)
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Every tab body arrives the same way. Keying on the tab makes
        // each switch a fresh identity, so this one call covers all of
        // them rather than each tab hand-rolling its own arrival.
        .entrance(.pane)
        .id(selectedTab)
        .animation(Motion.structure, value: selectedTab)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.red)
            Text(message)
                .font(.caption)
                .foregroundStyle(.red)
                .textSelection(.enabled)
            Spacer(minLength: 8)
            Button {
                model.lastError = nil
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss error")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color.red.opacity(0.12),
            in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous))
        .transition(Motion.rise)
    }

    /// Accent-tile icon + tab title, mirroring the composer picker header.
    private var paneHeader: some View {
        HStack(spacing: 10) {
            Image(systemName: selectedTab.symbolName)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(AlpineTheme.forest)
                .frame(width: 30, height: 30)
                .background(
                    AlpineTheme.accent.opacity(0.9),
                    in: RoundedRectangle(
                        cornerRadius: AlpineTheme.Corners.control, style: .continuous))
            Text(selectedTab.title)
                .font(.title3.bold())
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var settingsDetail: some View {
        switch selectedTab {
        case .general:
            GeneralSettingsTab(model: model)
        case .providers:
            ProvidersSettingsTab(model: model)
        case .workflows:
            WorkflowRoutingSettingsTab(model: model)
        case .dictation:
            DictationSettingsTab(model: model)
        case .autoReview:
            AutoReviewSettingsTab(model: model)
        case .archive:
            ArchiveSettingsTab(model: model)
        case .scenery:
            ScenerySettingsTab(model: model, scenery: scenery)
        case .devices:
            PhoneSettingsTab(model: model)
        case .remoteMacs:
            RemoteMacsSettingsTab(multi: multi)
        case .connection:
            ConnectionSettingsTab(model: model, multi: multi)
        }
    }
}

// MARK: - General

private struct GeneralSettingsTab: View {
    let model: AppModel
    @UIState private var draft: AppSettings?
    @UIState private var loadError: String?
    @FocusState private var projectsDirectoryFocused: Bool

    @UIState private var notificationsMasterEnabled = AgentNotificationPreferences.isMasterEnabled
    @UIState private var notifyFinished = AgentNotificationPreferences.isEnabled(.finished)
    @UIState private var notifyStalled = AgentNotificationPreferences.isEnabled(.stalled)
    @UIState private var notifyApproval = AgentNotificationPreferences.isEnabled(.needsApproval)
    @UIState private var notifyInput = AgentNotificationPreferences.isEnabled(.needsInput)
    @UIState private var notifyFailed = AgentNotificationPreferences.isEnabled(.failed)
    @UIState private var notificationsDenied = false
    @UIState private var hapticsEnabled = HapticsPreferences.isEnabled
    @UIState private var playfulMotionEnabled = PlayfulMotionPreferences.isEnabled

    var body: some View {
        VStack(spacing: 18) {
            if let settings = draft {
                SettingsSection(header: "Behaviour") {
                    SettingsToggleRow(
                        title: "Stream assistant replies",
                        isOn: binding(settings, \.assistantStreaming))
                    SettingsDivider()
                    SettingsToggleRow(
                        title: "Check for provider CLI updates",
                        isOn: binding(settings, \.providerUpdateChecks))
                }

                SettingsSection(header: "New threads") {
                    SettingsPickerRow(
                        "Run threads in",
                        selection: binding(settings, \.defaultEnvMode)
                    ) {
                        ForEach(ProjectEnvMode.allCases) { mode in
                            Text(mode.displayName).tag(mode)
                        }
                    }
                    SettingsDivider()
                    SettingsToggleRow(
                        title: "Require latest origin/main for new worktrees",
                        isOn: binding(settings, \.newWorktreesStartFromOrigin))
                    SettingsDivider()
                    SettingsCardRow {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Default projects directory")
                                .font(.callout)
                            TextField(
                                "Default projects directory",
                                text: textBinding(settings, \.addProjectBaseDirectory))
                                .textFieldStyle(.settings)
                                .focused($projectsDirectoryFocused)
                                .onSubmit { commitProjectsDirectory() }
                        }
                    }
                }
            } else {
                SettingsSection {
                    SettingsCardRow {
                        if let loadError {
                            VStack(alignment: .leading, spacing: 8) {
                                Label(
                                    "Could not load settings",
                                    systemImage: "exclamationmark.triangle"
                                )
                                .foregroundStyle(.red)
                                Text(loadError)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Button("Try Again") {
                                    Task { await loadDraft() }
                                }
                                .controlSize(.small)
                            }
                        } else if model.connection == .ready {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("Connect to the server to edit settings.")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            SettingsSection(header: "Feedback") {
                SettingsToggleRow(
                    title: "Haptic feedback",
                    description:
                        "Trackpad taps confirm sends, approvals, level changes, and merges. Needs a Force Touch trackpad; ignored on other pointing devices.",
                    isOn: $hapticsEnabled)
                    // Persist + acknowledge in one call: the tap has to land on
                    // the enabled side of the write, or switching haptics off
                    // would be the one toggle in the app with no feedback.
                    .onChange(of: hapticsEnabled) { _, enabled in
                        Haptics.setPreference(enabled: enabled)
                    }
                SettingsDivider()
                SettingsToggleRow(
                    title: "Playful motion",
                    description:
                        "The animated activity indicator while the agent works, and the auto-review terrier. Turning this off leaves the status badges; macOS Reduce Motion stills them instead.",
                    isOn: $playfulMotionEnabled)
                    .onChange(of: playfulMotionEnabled) { _, enabled in
                        PlayfulMotionPreferences.isEnabled = enabled
                    }
            }

            SettingsSection(header: "Notifications") {
                // Every toggle below is a no-op while macOS is refusing to
                // deliver, and the toggles keep reading ON — say so, and offer
                // the one place that can change it.
                if notificationsDenied {
                    SettingsCardRow {
                        VStack(alignment: .leading, spacing: 8) {
                            Label(
                                "macOS is blocking notifications for SurgeCode, so these settings have no effect.",
                                systemImage: "exclamationmark.triangle.fill"
                            )
                            .font(.callout)
                            .foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                            Button("Open Notification Settings") {
                                openNotificationSettings()
                            }
                            .controlSize(.small)
                        }
                    }
                    SettingsDivider()
                }
                SettingsToggleRow(
                    title: "Agent notifications",
                    description:
                        "Banner when agents finish, stall, fail, or need your input — suppressed while that thread is frontmost.",
                    isOn: $notificationsMasterEnabled)
                    .onChange(of: notificationsMasterEnabled) { _, enabled in
                        AgentNotificationPreferences.isMasterEnabled = enabled
                        if enabled {
                            AgentNotificationService.shared.requestAuthorizationIfNeeded()
                        }
                    }

                if notificationsMasterEnabled {
                    SettingsDivider()
                    SettingsToggleRow(
                        title: AgentNotificationKind.finished.settingsLabel,
                        isOn: $notifyFinished)
                        .onChange(of: notifyFinished) { _, enabled in
                            AgentNotificationPreferences.setEnabled(.finished, enabled)
                        }
                        .help(AgentNotificationKind.finished.settingsHelp)
                    SettingsDivider()
                    SettingsToggleRow(
                        title: AgentNotificationKind.stalled.settingsLabel,
                        isOn: $notifyStalled)
                        .onChange(of: notifyStalled) { _, enabled in
                            AgentNotificationPreferences.setEnabled(.stalled, enabled)
                        }
                        .help(AgentNotificationKind.stalled.settingsHelp)
                    SettingsDivider()
                    SettingsToggleRow(
                        title: AgentNotificationKind.needsApproval.settingsLabel,
                        isOn: $notifyApproval)
                        .onChange(of: notifyApproval) { _, enabled in
                            AgentNotificationPreferences.setEnabled(.needsApproval, enabled)
                        }
                        .help(AgentNotificationKind.needsApproval.settingsHelp)
                    SettingsDivider()
                    SettingsToggleRow(
                        title: AgentNotificationKind.needsInput.settingsLabel,
                        isOn: $notifyInput)
                        .onChange(of: notifyInput) { _, enabled in
                            AgentNotificationPreferences.setEnabled(.needsInput, enabled)
                        }
                        .help(AgentNotificationKind.needsInput.settingsHelp)
                    SettingsDivider()
                    SettingsToggleRow(
                        title: AgentNotificationKind.failed.settingsLabel,
                        isOn: $notifyFailed)
                        .onChange(of: notifyFailed) { _, enabled in
                            AgentNotificationPreferences.setEnabled(.failed, enabled)
                        }
                        .help(AgentNotificationKind.failed.settingsHelp)
                }
            }

            SettingsSection(header: "About") {
                SettingsValueRow(title: "Appearance", value: "Dark")
                    .help(
                        "SurgeCode uses its dark appearance independently of macOS system appearance."
                    )
                SettingsDivider()
                SettingsValueRow(
                    title: "Version", value: Bundle.main.appVersionDisplay, technical: true)
            }
        }
        // Loaded settings fade in over the placeholder spinner.
        .animation(Motion.reveal, value: draft == nil)
        // A tab opened while the sidecar is still booting would load nothing
        // and never retry, so key the task on the connection phase. Gated on
        // `.ready` because `.reconnecting(attempt:)` bumps on every restart
        // attempt and each of those loads could only fail again.
        .task(id: model.connection) {
            guard draft == nil, model.connection == .ready else { return }
            await loadDraft()
        }
        .task {
            notificationsDenied = await AgentNotificationService.shared.isAuthorizationDenied()
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
                // A rejected save must not leave the row showing a value the
                // server never accepted.
                Task {
                    if await model.saveSettings(next) == false { draft = model.settings }
                }
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

    /// `loadSettings()` swallows its throw into the global `lastError` and
    /// leaves `settings` untouched, so a still-nil `settings` afterwards is
    /// the only signal that the load failed — without it the tab would sit on
    /// an indeterminate spinner forever.
    private func loadDraft() async {
        loadError = nil
        await model.loadSettings()
        draft = model.settings
        if draft == nil {
            loadError = model.lastError ?? "The server did not return settings."
        }
    }

    private func openNotificationSettings() {
        let url = URL(
            string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!
        NSWorkspace.shared.open(url)
    }

    private func commitProjectsDirectory() {
        guard let pending = draft else { return }
        Task {
            if await model.saveSettings(pending) == false { draft = model.settings }
        }
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
        VStack(spacing: 18) {
            SettingsSection(header: "Speech model") {
                SettingsCardRow {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Parakeet v3 (on-device)")
                                .font(.callout)
                            Text("25 languages · ~2.5 GB · runs on the Neural Engine")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        modelStatusControl
                    }
                }
                // The composer's banner for this failure self-dismisses and is
                // hidden behind the frontmost Settings window anyway, so the
                // download's only visible outcome would be a button flipping
                // back to "Download".
                if let downloadError = dictation.lastDownloadError {
                    SettingsDivider()
                    SettingsCardRow {
                        Text(downloadError)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                SettingsDivider()
                SettingsValueRow(title: "Storage") {
                    Text(dictation.modelCacheDirectory.path(percentEncoded: false))
                        .font(SurgeTypography.technicalMetadata)
                        .textSelection(.enabled)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            SettingsSection(header: "Transcript cleanup") {
                SettingsToggleRow(
                    title: "Clean up transcript with on-device AI",
                    description:
                        dictation.cleanupAvailable
                        ? "Fixes punctuation and removes filler words with the built-in Apple Intelligence model. The raw transcript is inserted first, then polished in place. Nothing leaves this Mac."
                        : "Requires Apple Intelligence. Until it's enabled, dictation inserts the raw transcript.",
                    isOn: $dictation.cleanupEnabled)
                    .disabled(!dictation.cleanupAvailable)
            }

            SettingsSection(
                header: "Language",
                footer: "Dictation is fully local: audio and transcripts never leave this Mac."
            ) {
                SettingsPickerRow("Spoken language", selection: $dictation.languageCode) {
                    Text("Auto-detect").tag(DictationController.autoLanguage)
                    ForEach(DictationController.supportedLanguageCodes, id: \.self) { code in
                        Text(Self.languageName(for: code)).tag(code)
                    }
                }
            }
        }
        .animation(Motion.ambient, value: dictation.modelStatus)
        .animation(Motion.reveal, value: dictation.lastDownloadError)
    }

    @ViewBuilder
    private var modelStatusControl: some View {
        switch dictation.modelStatus {
        case .notDownloaded:
            Button("Download") { dictation.downloadModel() }
        case .downloading:
            // FluidAudio reports `fractionCompleted` per sub-download, so a
            // determinate bar visibly runs backwards between files.
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Downloading…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
    @UIState private var draft: AppSettings?
    @FocusState private var autoArchiveValueFocused: Bool

    private static let hourMs: Double = 3_600_000
    private static let dayMs: Double = 86_400_000
    /// Preselected window when the toggle is flipped on.
    private static let defaultAutoArchiveAfterMs: Double = 3 * dayMs

    var body: some View {
        VStack(spacing: 18) {
            if let settings = draft {
                SettingsSection(header: "Auto-archive") {
                    SettingsToggleRow(
                        title: "Auto-archive settled threads",
                        description:
                            "Threads that have been settled — explicitly or by inactivity — are archived automatically once they have sat longer than this.",
                        isOn: Binding(
                            get: { (draft ?? settings).autoArchiveSettledAfterMs != nil },
                            set: { enabled in
                                var next = draft ?? settings
                                next.autoArchiveSettledAfterMs =
                                    enabled ? Self.defaultAutoArchiveAfterMs : nil
                                draft = next
                                // A rejected save must not leave the toggle
                                // showing a value the server never accepted.
                                Task {
                                    if await model.saveSettings(next) == false {
                                        draft = model.settings
                                    }
                                }
                            }))
                    if (draft ?? settings).autoArchiveSettledAfterMs != nil {
                        SettingsDivider()
                        autoArchiveAfterRow(settings)
                    }
                }
            }

            SettingsSection(header: "Archived threads") {
                if model.archivedThreadsLoading && model.archivedThreads.isEmpty {
                    SettingsCardRow {
                        ProgressView("Loading archived threads…")
                    }
                } else if let error = model.archivedThreadsError {
                    SettingsCardRow {
                        VStack(alignment: .leading, spacing: 8) {
                            Label(
                                "Could not load archived threads",
                                systemImage: "exclamationmark.triangle"
                            )
                            .foregroundStyle(.red)
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Button("Try Again") {
                                Task { await model.refreshArchivedThreads() }
                            }
                            .controlSize(.small)
                        }
                    }
                } else if model.archivedThreads.isEmpty {
                    SettingsCardRow {
                        Text("No archived threads.")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    SettingsCardRow {
                        SettingsSearchField(
                            prompt: "Search archived threads", text: $searchText)
                    }

                    if filteredThreads.isEmpty {
                        SettingsDivider()
                        ContentUnavailableView(
                            "No Matching Threads",
                            systemImage: "magnifyingglass",
                            description: Text("Try a different title or provider name."))
                            .padding(.vertical, 8)
                    }

                    ForEach(filteredThreads) { thread in
                        SettingsDivider()
                        archivedThreadRow(thread)
                    }

                    SettingsDivider()
                    SettingsCardRow {
                        Text(
                            "Showing \(model.archivedThreads.count) of \(model.archivedThreadsTotal) archived threads"
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }

                    if model.archivedThreadsNextCursor != nil {
                        SettingsDivider()
                        SettingsCardRow {
                            Button {
                                Task { await model.loadMoreArchivedThreads() }
                            } label: {
                                HStack(spacing: 8) {
                                    Text("Load more")
                                    if model.archivedThreadsLoading
                                        && !model.archivedThreads.isEmpty
                                    {
                                        ProgressView()
                                            .controlSize(.small)
                                    }
                                }
                            }
                            .disabled(model.archivedThreadsLoading)
                            .transition(Motion.rise)
                        }
                    }
                }
            }
        }
        // Re-runs when the sidecar finishes connecting: a tab opened during
        // launch would otherwise keep an empty auto-archive section forever.
        .task(id: model.connection) {
            guard model.connection == .ready else { return }
            if draft == nil {
                await model.loadSettings()
                draft = model.settings
            }
            await model.refreshArchivedThreads()
        }
        .animation(Motion.structure, value: model.archivedThreads.map(\.id))
        .onChange(of: autoArchiveValueFocused) { wasFocused, isFocused in
            if wasFocused && !isFocused { commitAutoArchiveValue() }
        }
        .onDisappear { commitAutoArchiveValue() }
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

    private func archivedThreadRow(_ thread: ChatThread) -> some View {
        HStack {
            ProviderIcon(
                provider: thread.provider, modelID: thread.modelID, size: 16
            )
            .foregroundStyle(.secondary)
            .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(thread.title)
                    .font(.callout)
                    .lineLimit(1)
                Text(thread.provider.displayName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Unarchive") {
                Task { await model.unarchiveThread(thread) }
            }
            .controlSize(.small)
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
        .padding(.horizontal, 13)
        .padding(.vertical, 6)
        .transition(Motion.rise)
    }

    private var filteredThreads: [ChatThread] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return model.archivedThreads }
        return model.archivedThreads.filter {
            Self.searchMatches($0.title, query)
                || Self.searchMatches($0.provider.displayName, query)
        }
    }

    /// Search folds diacritics as well as case, matching the sidebar: threads
    /// are auto-titled after scenery locations ("Skógafoss"), so a query typed
    /// on an ASCII keyboard has to reach them.
    private static func searchMatches(_ haystack: String, _ term: String) -> Bool {
        haystack.range(
            of: term, options: [.caseInsensitive, .diacriticInsensitive], locale: .current) != nil
    }

    /// Amount + unit editor for the auto-archive window. The amount field
    /// edits the draft only and commits on submit/blur (a full-settings RPC
    /// per keystroke would be noisy); the unit picker saves immediately.
    private func autoArchiveAfterRow(_ settings: AppSettings) -> some View {
        let ms = (draft ?? settings).autoArchiveSettledAfterMs ?? Self.defaultAutoArchiveAfterMs
        let unit = ms.truncatingRemainder(dividingBy: Self.dayMs) == 0 ? "days" : "hours"
        let divisor = unit == "days" ? Self.dayMs : Self.hourMs
        return SettingsCardRow {
            HStack(spacing: 8) {
                Text("Archive after")
                    .font(.callout)
                Spacer()
                TextField(
                    "amount",
                    value: Binding(
                        get: { max(1, Int(ms / divisor)) },
                        set: { newValue in
                            var next = draft ?? settings
                            next.autoArchiveSettledAfterMs = Double(max(1, newValue)) * divisor
                            draft = next
                        }),
                    format: .number
                )
                .textFieldStyle(.settings)
                .frame(width: 64)
                .multilineTextAlignment(.trailing)
                .focused($autoArchiveValueFocused)
                .onSubmit { commitAutoArchiveValue() }
                AlpineSegmentedControl(
                    segments: [
                        AlpineSegmentedControl<String>.Segment(value: "hours", title: "hours"),
                        AlpineSegmentedControl<String>.Segment(value: "days", title: "days"),
                    ],
                    selection: Binding(
                        get: { unit },
                        set: { newUnit in
                            var next = draft ?? settings
                            let amount = max(1, Int(ms / divisor))
                            next.autoArchiveSettledAfterMs =
                                Double(amount) * (newUnit == "days" ? Self.dayMs : Self.hourMs)
                            draft = next
                            Task {
                                if await model.saveSettings(next) == false {
                                    draft = model.settings
                                }
                            }
                        }),
                    height: 26
                )
                .frame(width: 120)
            }
        }
    }

    private func commitAutoArchiveValue() {
        guard let pending = draft else { return }
        Task {
            if await model.saveSettings(pending) == false { draft = model.settings }
        }
    }
}

// MARK: - Providers

private struct ProvidersSettingsTab: View {
    let model: AppModel
    @UIState private var isRefreshing = false

    var body: some View {
        VStack(spacing: 18) {
            SettingsSection(
                header: "Installed Providers",
                headerTrailing: {
                    Button {
                        refresh()
                    } label: {
                        if isRefreshing {
                            ProgressView()
                                .controlSize(.small)
                                .transition(.opacity)
                        } else {
                            Label("Refresh", systemImage: "arrow.clockwise")
                                .font(.caption.weight(.medium))
                                .transition(.opacity)
                        }
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .disabled(isRefreshing)
                    .animation(Motion.reveal, value: isRefreshing)
                }
            ) {
                if model.providers.isEmpty {
                    ContentUnavailableView(
                        "No Providers Found",
                        systemImage: "puzzlepiece.extension",
                        description: Text("Refresh to detect installed agent CLIs.")
                    )
                    .padding(.vertical, 8)
                } else {
                    ForEach(Array(model.providers.enumerated()), id: \.element.id) { index, provider in
                        if index > 0 { SettingsDivider() }
                        SettingsCardRow {
                            ProviderRow(provider: provider, model: model)
                        }
                    }
                }
            }
        }
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
                    .font(.callout)
                if let version = provider.version {
                    Text(version)
                        .font(SurgeTypography.technicalMetadata)
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
        case .claude, .claudeWork: "claude"
        case .codex: "codex"
        case .grok: "grok"
        case .kimi: "kimi"
        case .legacyClaudex: "claudex"
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
        VStack(spacing: 18) {
            SettingsSection(header: "Tailscale") {
                SettingsToggleRow(
                    title: "Remote access over Tailscale",
                    description:
                        "Reach this Mac from anywhere your Tailscale network extends. When active, pairing links use this Mac's tailnet address (\(tailnetHostname ?? "your MagicDNS name")) instead of a local-network IP.",
                    isOn: Binding(
                        get: { tailscaleEnabled },
                        set: { newValue in
                            tailscaleEnabled = newValue
                            TailscaleAccessPreference.setEnabled(newValue)
                        }))
                if checkedReachability {
                    SettingsDivider()
                    SettingsValueRow(title: "Remote address") {
                        Text(remoteAddressText)
                            .font(SurgeTypography.technicalMetadata)
                            .textSelection(.enabled)
                    }
                }
            }

            SettingsSection(header: "Local network") {
                SettingsToggleRow(
                    title: "Allow iPhone and Mac connections on your local network",
                    description:
                        "Pair SurgeCode on an iPhone or another Mac to chat with this Mac's sessions over Wi‑Fi. The same one-time link or QR code below works for either device; macOS may ask to allow incoming network connections.",
                    isOn: Binding(
                        get: { allowConnections },
                        set: { newValue in
                            allowConnections = newValue
                            MobileAccessPreference.setEnabled(newValue)
                        }))
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
                SettingsSection {
                    SettingsCardRow {
                        Label(
                            "Tailscale access is still on for this session — quit and reopen SurgeCode to stop serving over your tailnet.",
                            systemImage: "exclamationmark.triangle.fill"
                        )
                        .font(.callout)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if checkedReachability && tailscaleEnabled && tailnetHostname == nil {
                SettingsSection {
                    SettingsCardRow {
                        Label(
                            "Tailscale isn't serving yet — if you just turned this on, quit and reopen SurgeCode; otherwise make sure Tailscale is installed and signed in on this Mac.",
                            systemImage: "info.circle"
                        )
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if checkedReachability && allowConnections != lanReachable {
                SettingsSection {
                    SettingsCardRow {
                        Label(
                            relaunchWarningText,
                            systemImage: relaunchWarningSymbol
                        )
                        .font(.callout)
                        .foregroundStyle(relaunchWarningColor)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            if pairingAvailable {
                SettingsSection(header: "Pair a device") {
                    SettingsCardRow {
                        pairingContent
                    }
                }
            }
        }
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
                            .font(SurgeTypography.technicalMetadata)
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
        } else if let pairingError {
            VStack(alignment: .leading, spacing: 8) {
                Label(pairingError, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Try Again") { mintGeneration += 1 }
                    .controlSize(.small)
            }
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

// Internal (not private) so the DEBUG UIProbe can host it directly.
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
        VStack(spacing: 18) {
            SettingsSection(
                header: "Add a Mac",
                footer:
                    "On the other Mac, open Settings ▸ Devices and copy its pairing link or scan its QR code."
            ) {
                SettingsCardRow {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            TextField("Paste pairing link…", text: $pairingLink)
                                .textFieldStyle(.settings)
                                .disabled(isPairing)
                            Button("Connect") { connect() }
                                .disabled(
                                    isPairing
                                        || pairingLink.trimmingCharacters(in: .whitespacesAndNewlines)
                                            .isEmpty)
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
                                Button("Open Local Network Settings") {
                                    openLocalNetworkSettings()
                                }
                                .controlSize(.small)
                            }
                        }
                    }
                }
            }

            SettingsSection(header: "Paired Macs") {
                if multi.remoteSessions.isEmpty {
                    SettingsCardRow {
                        Text("No Macs paired yet.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(Array(multi.remoteSessions.enumerated()), id: \.element.id) {
                        index, session in
                        if index > 0 { SettingsDivider() }
                        SettingsCardRow {
                            remoteMacRow(session)
                        }
                    }
                }
            }
        }
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
                        .font(.callout.weight(.medium))
                    Text(address(for: session))
                        .font(SurgeTypography.technicalMetadata)
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
                    pairingError =
                        (error as? LocalizedError)?.errorDescription ?? String(describing: error)
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
    let multi: MultiDeviceModel
    @UIState private var access = ServerRemoteAccessStatus(
        lanReachable: false, tailnetHostname: nil)
    @UIState private var isRetrying = false

    var body: some View {
        VStack(spacing: 18) {
            SettingsSection {
                SettingsValueRow(title: "Status") {
                    HStack(spacing: 10) {
                        Label(model.connection.statusText, systemImage: model.connection.symbolName)
                            .foregroundStyle(model.connection.statusColor)
                            .contentTransition(
                                Motion.reduceMotion ? .identity : .symbolEffect(.replace))
                            .fixedSize(horizontal: false, vertical: true)
                        // A sidecar that failed to launch has nothing left
                        // retrying itself — without this the only way back is
                        // quitting the app.
                        if model.connection.needsAttention {
                            Button("Retry") { retry() }
                                .controlSize(.small)
                                .disabled(isRetrying)
                        }
                    }
                    .animation(Motion.ambient, value: model.connection)
                }
            }

            SettingsSection(header: "Server", footer: serverCaption) {
                SettingsValueRow(
                    title: "Host",
                    value: access.lanReachable
                        ? "0.0.0.0 (local network)" : "127.0.0.1 (loopback)",
                    technical: true)
                SettingsDivider()
                SettingsValueRow(
                    title: "Mode",
                    value: access.lanReachable || access.tailnetHostname != nil
                        ? "remote-reachable" : "desktop-managed-local",
                    technical: true)
                SettingsDivider()
                SettingsValueRow(title: "Tailscale") {
                    Text(access.tailnetHostname ?? "Off")
                        .font(SurgeTypography.technicalMetadata)
                        .textSelection(.enabled)
                }
            }
        }
        // Keyed to the connection phase so the rows update if the server
        // comes up (or restarts) after the Settings window opened. The serve
        // record can arrive shortly after the sidecar becomes reachable.
        .task(id: model.connection) { await refreshRemoteAccess() }
    }

    /// Full backend restart: `shutdown()` then `start()`, which is the only
    /// recovery from a terminal launch failure (see `MultiDeviceModel.reconnect`).
    private func retry() {
        guard !isRetrying else { return }
        isRetrying = true
        Task {
            await multi.reconnect(id: model.deviceID)
            isRetrying = false
        }
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
