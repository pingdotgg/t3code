import AppKit
import SwiftUI

/// Glass sheet for starting a new session: pick a project (existing or a new
/// folder), choose a provider, then create the thread.
///
/// Layout: a full-bleed frosted scenery header previews the scene the thread
/// will be named after; below it, labeled sections walk the choices top to
/// bottom — device (only when remotes are connected), project, provider —
/// with tappable option cards instead of menu pickers so every choice stays
/// visible at a glance.
struct NewSessionSheet: View {
    let multi: MultiDeviceModel
    let scenery: SceneryStore
    @Binding var isPresented: Bool

    @UIState private var mode: Mode = .existing
    @UIState private var selectedDeviceID: DeviceID = .local
    @UIState private var selectedProjectID: String?
    @UIState private var projectSearch = ""
    @UIState private var provider: ProviderKind = .claudex
    @UIState private var newProjectPath: String = ""
    @UIState private var isBusy = false
    @UIState private var errorMessage: String?
    /// Preview of the scene the created thread will be named after. Sampled
    /// in `.task` (never in body — `peekNextScene()` mutates the store).
    @UIState private var nextScene: SceneryPhoto?

    private enum Mode: String, CaseIterable, Identifiable {
        case existing = "Existing"
        case new = "New Folder"
        var id: String { rawValue }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .entrance(.card, index: 0)

            VStack(alignment: .leading, spacing: 16) {
                if !multi.remoteSessions.isEmpty {
                    deviceSection
                        .entrance(.card, index: 1)
                }
                projectSection
                    .entrance(.card, index: 2)
                providerSection
                    .entrance(.card, index: 3)
                footer
                    .entrance(.card, index: 4)
            }
            .padding(20)
        }
        .frame(width: 484)
        .glassEffect(.regular, in: .rect(cornerRadius: AlpineTheme.Corners.hero))
        .animation(Motion.structure, value: mode)
        .animation(Motion.reveal, value: errorMessage == nil)
        .animation(Motion.reveal, value: providerReadinessMessage == nil)
        .task {
            // Warm the settings so the folder picker can open at the
            // configured default projects directory.
            if model.capabilities.canBrowseLocalFolders, model.settings == nil {
                await model.loadSettings()
            }
            syncProviderSelection()
            selectDefaultProject()
            // Sample the scene preview outside body evaluation; start() is
            // idempotent and waits for the initial pool fetch, so the first
            // peek can't lose the cold-start race and come back nil.
            await scenery.start()
            if nextScene == nil {
                nextScene = scenery.peekNextScene(excludingThreadKeys: model.activeSceneThreadKeys)
            }
        }
        .onChange(of: model.configuredProviderKinds) {
            syncProviderSelection()
        }
        .onChange(of: model.activeSceneThreadKeys) {
            // Keep the preview aligned with what createSceneThread will
            // commit: re-peek when occupancy changes. The store keeps the
            // pending pick while it is still unoccupied, so unrelated
            // thread activity leaves the preview untouched.
            nextScene = scenery.peekNextScene(excludingThreadKeys: model.activeSceneThreadKeys)
        }
    }

    // MARK: - Header

    /// Full-bleed frosted scene band with the title overlaid. Populated in
    /// `.task`: `peekNextScene()` samples and writes `SceneryStore.pendingScene`
    /// on the first call, so calling it here would mutate observable state
    /// during a view update.
    private var header: some View {
        ZStack(alignment: .bottomLeading) {
            FrostedSceneryBackdrop(
                scenery: scenery,
                photo: nextScene,
                fallbackSeed: "new-session")
                .id(nextScene?.id ?? "next")
            // Extra bottom scrim so the title stays legible over bright
            // scenes; the backdrop's own wash alone is tuned for icon chrome.
            LinearGradient(
                colors: [.clear, .black.opacity(0.45)],
                startPoint: .top, endPoint: .bottom)

            VStack(alignment: .leading, spacing: 3) {
                Text("New Session")
                    .font(.title2.bold())
                Text(
                    nextScene.map { scenery.threadTitle(for: $0) }
                        ?? "Pick a project and a provider to get started."
                )
                .font(.callout)
                .foregroundStyle(.white.opacity(0.82))
                .contentTransition(Motion.reduceMotion ? .identity : .opacity)
                .animation(Motion.ambient, value: nextScene?.id)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .sceneryChrome()
        }
        .frame(maxWidth: .infinity)
        .frame(height: 108)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: AlpineTheme.Corners.hero,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: AlpineTheme.Corners.hero,
                style: .continuous))
    }

    // MARK: - Device

    private var deviceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("Device")
            // Adaptive grid (same as the provider section) so 3+ remotes
            // wrap instead of crushing names inside the fixed-width sheet.
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 132), spacing: 8)],
                spacing: 8
            ) {
                OptionCard(
                    title: "This Mac",
                    isSelected: selectedDeviceID == .local,
                    action: { selectDevice(.local) }
                ) {
                    Image(systemName: "laptopcomputer")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                ForEach(multi.remoteSessions) { session in
                    OptionCard(
                        title: session.descriptor.name,
                        isSelected: selectedDeviceID == session.id,
                        action: { selectDevice(session.id) }
                    ) {
                        Image(systemName: "network")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func selectDevice(_ id: DeviceID) {
        guard id != selectedDeviceID else { return }
        selectedDeviceID = id
        mode = .existing
        selectDefaultProject()
        syncProviderSelection()
        projectSearch = ""
        clearError()
    }

    // MARK: - Project

    private var projectSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                sectionLabel("Project")
                Spacer()
                if model.capabilities.canBrowseLocalFolders {
                    Picker("", selection: $mode) {
                        ForEach(Mode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                    .controlSize(.small)
                    .onChange(of: mode) {
                        if mode == .existing {
                            selectDefaultProject()
                        } else {
                            selectedProjectID = nil
                        }
                        projectSearch = ""
                        clearError()
                    }
                }
            }

            Group {
                switch mode {
                case .existing:
                    existingProjectContent
                case .new:
                    newProjectContent
                }
            }
            .id(mode)
            .transition(Motion.paneChange)
        }
    }

    private var existingProjectContent: some View {
        VStack(spacing: 0) {
            if model.projects.isEmpty {
                ContentUnavailableView {
                    Label(
                        model.capabilities.canBrowseLocalFolders
                            ? "No Projects on This Mac"
                            : "No Projects on This Device",
                        systemImage: "folder")
                } description: {
                    Text(
                        model.capabilities.canBrowseLocalFolders
                            ? "Choose New Folder above, then select a project folder."
                            : "Add a project on the remote Mac, then try again."
                    )
                }
                .frame(height: 150)
            } else {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField("Search projects", text: $projectSearch)
                        .textFieldStyle(.plain)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)

                Rectangle()
                    .fill(Color.primary.opacity(0.08))
                    .frame(height: 1)

                ProjectChoiceList(
                    projects: model.projects,
                    selectedProjectID: $selectedProjectID,
                    searchText: $projectSearch)
                .onChange(of: selectedProjectID) {
                    clearError()
                }
            }
        }
        .background(cardFill, in: cardShape)
        .overlay(cardShape.stroke(cardStroke, lineWidth: 1))
    }

    private var newProjectContent: some View {
        HStack(spacing: 10) {
            Image(systemName: "folder.badge.plus")
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(width: 28, height: 28)
                .background(
                    Color.primary.opacity(0.06),
                    in: RoundedRectangle(
                        cornerRadius: AlpineTheme.Corners.control, style: .continuous))
            TextField("Project folder path", text: $newProjectPath)
                .textFieldStyle(.plain)
                .onChange(of: newProjectPath) {
                    clearError()
                }
            Button {
                pickFolder()
            } label: {
                Text("Browse…")
            }
            .buttonStyle(.glass)
            .controlSize(.small)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(cardFill, in: cardShape)
        .overlay(cardShape.stroke(cardStroke, lineWidth: 1))
    }

    // MARK: - Provider

    private var providerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("Provider")
            if configuredProviderKinds.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.circle")
                        .foregroundStyle(.secondary)
                    Text("No providers found")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(cardFill, in: cardShape)
                .overlay(cardShape.stroke(cardStroke, lineWidth: 1))
            } else {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 132), spacing: 8)],
                    spacing: 8
                ) {
                    ForEach(configuredProviderKinds) { kind in
                        OptionCard(
                            title: kind.displayName,
                            isSelected: provider == kind,
                            // Match the Create gate exactly: available runtime
                            // AND a selectable model, so a provider with no
                            // models yet is badged too.
                            showsWarning: !model.canCreateThread(with: kind),
                            action: {
                                provider = kind
                                clearError()
                            }
                        ) {
                            ProviderIcon(provider: kind, size: 13)
                                .foregroundStyle(provider == kind ? AlpineTheme.accent : .secondary)
                        }
                    }
                }
            }

            if let providerReadinessMessage {
                Label(providerReadinessMessage, systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }

            HStack {
                Spacer()
                Button("Cancel") { isPresented = false }
                    .buttonStyle(.glass)
                    .keyboardShortcut(.cancelAction)
                Button {
                    Task { await create() }
                } label: {
                    HStack(spacing: 6) {
                        if isBusy {
                            ProgressView()
                                .controlSize(.small)
                                .scaleEffect(0.7)
                        }
                        Text(isBusy ? "Creating…" : "Create Session")
                    }
                    // Pin the width so the spinner never re-lays the footer out.
                    .frame(minWidth: 108)
                }
                .buttonStyle(.glass)
                .tint(AlpineTheme.accent)
                .disabled(isBusy || !canCreate)
                .keyboardShortcut(.defaultAction)
            }
        }
    }

    // MARK: - Shared chrome

    private var cardShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous)
    }

    private var cardFill: Color {
        Color.primary.opacity(0.04)
    }

    private var cardStroke: Color {
        Color.primary.opacity(0.10)
    }

    private func sectionLabel(_ title: String) -> some View {
        Text(title)
            .font(.callout.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    // MARK: - Actions

    /// Native directory chooser; fills the path field with the selection.
    private func pickFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = "Choose"
        panel.message = "Choose the project folder"
        let typed = newProjectPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = model.settings?.addProjectBaseDirectory ?? ""
        if !typed.isEmpty {
            panel.directoryURL = URL(
                fileURLWithPath: (typed as NSString).expandingTildeInPath, isDirectory: true)
        } else if !base.isEmpty {
            panel.directoryURL = URL(
                fileURLWithPath: (base as NSString).expandingTildeInPath, isDirectory: true)
        }
        if panel.runModal() == .OK, let url = panel.url {
            newProjectPath = url.path
        }
    }

    private var canCreate: Bool {
        guard model.canCreateThread(with: provider) else { return false }
        guard model.capabilities.canBrowseLocalFolders || mode == .existing else { return false }
        switch mode {
        case .existing: return selectedProjectID != nil
        case .new: return !newProjectPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private var configuredProviderKinds: [ProviderKind] {
        model.configuredProviderKinds
    }

    private var model: AppModel {
        multi.model(for: selectedDeviceID) ?? multi.local
    }

    private var providerReadinessMessage: String? {
        guard !configuredProviderKinds.isEmpty else {
            return "No providers are ready. Open Settings ▸ Providers and refresh."
        }
        guard !model.canCreateThread(with: provider) else { return nil }
        switch model.providerAvailability(for: provider) {
        case .authRequired:
            return "\(provider.displayName) needs sign-in or an auth token. Configure it in Settings ▸ Providers, then refresh."
        case .missing:
            return "\(provider.displayName) is not installed or is unavailable. Check Settings ▸ Providers."
        case .available:
            return "\(provider.displayName) has no selectable models yet. Refresh providers and try again."
        case nil:
            return "\(provider.displayName) is not configured. Refresh it in Settings ▸ Providers."
        }
    }

    private func syncProviderSelection() {
        guard !configuredProviderKinds.isEmpty else { return }
        if !configuredProviderKinds.contains(provider), let first = configuredProviderKinds.first {
            provider = first
        }
    }

    private func selectDefaultProject() {
        guard mode == .existing else { return }
        if let selectedProjectID,
            model.projects.contains(where: { $0.id == selectedProjectID })
        {
            return
        }
        selectedProjectID = model.projects.first?.id
    }

    private func clearError() {
        errorMessage = nil
    }

    private func create() async {
        clearError()
        Haptics.play(.commit)
        isBusy = true
        defer { isBusy = false }
        var createdThread: ChatThread?
        switch mode {
        case .existing:
            guard let projectID = selectedProjectID else { return }
            createdThread = await model.createSceneThread(
                projectID: projectID,
                provider: provider,
                scenery: scenery)
        case .new:
            let path = newProjectPath.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !path.isEmpty else { return }
            await model.addProject(path: path)
            // The server normalizes added paths (~ expansion, standardization),
            // so compare normalized forms — a typed path rarely matches verbatim.
            if let project = model.projects.first(where: {
                GeneralWorkspace.pathsMatch($0.path, path)
            }) {
                createdThread = await model.createSceneThread(
                    projectID: project.id,
                    provider: provider,
                    scenery: scenery)
            }
        }
        if createdThread != nil {
            if let createdThread {
                multi.select(threadID: createdThread.id, on: model.deviceID)
            }
            isPresented = false
        } else {
            errorMessage =
                model.lastError
                ?? "Couldn't create a new \(provider.displayName) session. Check provider settings and try again."
        }
    }
}

/// Tappable choice tile for the device and provider sections: icon tile,
/// title, and an accent treatment when selected. Replaces the menu pickers so
/// every option stays visible without opening a dropdown.
private struct OptionCard<Icon: View>: View {
    let title: String
    let isSelected: Bool
    var showsWarning: Bool = false
    let action: () -> Void
    @ViewBuilder var icon: Icon

    @UIState private var isHovering = false

    var body: some View {
        Button {
            Haptics.play(.selection)
            action()
        } label: {
            HStack(spacing: 8) {
                icon
                    .frame(width: 24, height: 24)
                    .background(
                        isSelected ? AlpineTheme.accent.opacity(0.22) : Color.primary.opacity(0.06),
                        in: RoundedRectangle(
                            cornerRadius: AlpineTheme.Corners.control, style: .continuous))
                Text(title)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 4)
                if showsWarning {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                } else if isSelected {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(AlpineTheme.accent)
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .contentShape(
                RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous))
            .background(
                isSelected
                    ? AlpineTheme.accent.opacity(0.14)
                    : Color.primary.opacity(isHovering ? 0.07 : 0.04),
                in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous)
                    .stroke(
                        isSelected ? AlpineTheme.accent.opacity(0.55) : Color.primary.opacity(0.10),
                        lineWidth: 1))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
        .animation(Motion.feedback, value: isSelected)
        .accessibilityLabel(title)
        // The warning triangle is decorative-only; say it out loud so an
        // unready but unselected provider doesn't read as normal.
        .accessibilityValue(showsWarning ? "Needs attention" : "")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private struct ProjectChoiceList: View {
    let projects: [Project]
    @Binding var selectedProjectID: String?
    @Binding var searchText: String

    var body: some View {
        content
            // Keep the selection inside the filtered set: a hidden selection
            // would still be submitted by Create Session. Retarget to the
            // first match (nil when nothing matches) instead of clearing, so
            // typing a query never strands the user without a selection.
            .onChange(of: filteredProjects.map(\.id)) {
                if let selectedProjectID,
                    filteredProjects.contains(where: { $0.id == selectedProjectID })
                {
                    return
                }
                selectedProjectID = filteredProjects.first?.id
            }
    }

    @ViewBuilder
    private var content: some View {
        if filteredProjects.isEmpty {
            ContentUnavailableView(
                "No Matching Projects",
                systemImage: "magnifyingglass",
                description: Text("Try a different project name or path."))
                .frame(height: 150)
        } else {
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(filteredProjects) { project in
                        ProjectChoiceRow(
                            project: project,
                            isSelected: selectedProjectID == project.id
                        ) {
                            selectedProjectID = project.id
                        }
                    }
                }
                .padding(6)
            }
            .frame(height: 176)
        }
    }

    private var filteredProjects: [Project] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return projects }
        return projects.filter {
            $0.name.localizedCaseInsensitiveContains(query)
                || $0.path.localizedCaseInsensitiveContains(query)
        }
    }
}

private struct ProjectChoiceRow: View {
    let project: Project
    let isSelected: Bool
    let onSelect: () -> Void

    @UIState private var isHovering = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 10) {
                Image(systemName: "folder.fill")
                    .font(.callout)
                    .foregroundStyle(isSelected ? AlpineTheme.forest : .secondary)
                    .frame(width: 28, height: 28)
                    .background(
                        isSelected ? AlpineTheme.accent : Color.primary.opacity(0.06),
                        in: RoundedRectangle(
                            cornerRadius: AlpineTheme.Corners.control, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(project.name)
                        .font(SurgeTypography.sidebarTaskTitle)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(project.path)
                        .font(SurgeTypography.technicalMetadata)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(AlpineTheme.accent)
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
            .background(
                isSelected ? AlpineTheme.accent.opacity(0.12)
                    : isHovering ? Color.primary.opacity(0.05) : Color.clear,
                in: RoundedRectangle(
                    cornerRadius: AlpineTheme.Corners.control, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
        .animation(Motion.feedback, value: isSelected)
        .accessibilityLabel("\(project.name), \(project.path)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// Presents `NewSessionSheet` in a standalone AppKit window so the ⌘N menu
/// command (registered in a `CommandGroup`) can open it without reaching
/// into `RootView`'s own `@UIState` sheet-presentation flag — a custom View
/// with `@Environment(\.openWindow)` inside a `CommandGroup` crashes AppKit
/// menu layout on this SDK (see `AboutWindowController`), and `RootView`'s
/// sheet flag lives outside this batch's file scope.
@MainActor
final class NewSessionWindowController: NSObject, NSWindowDelegate {
    static let shared = NewSessionWindowController()
    private var window: NSWindow?

    func show(multi: MultiDeviceModel, scenery: SceneryStore) {
        // Defer one runloop turn: callers reach this from popover rows (the
        // sidebar "Choose Target…" item), and creating the window
        // synchronously lands its first layout pass inside the still-open
        // CATransaction from the popover dismissal. On macOS 26/27 the
        // `.fullSizeContentView` hosting view then invalidates safe area
        // insets mid-pass, which trips AppKit's layout-feedback-loop guard
        // (NSInternalInconsistency in _postWindowNeedsUpdateConstraints →
        // hard crash). Same deferral pattern as the toolbar buttons in
        // ContentView.
        DispatchQueue.main.async { [self] in
            present(multi: multi, scenery: scenery)
        }
    }

    private func present(multi: MultiDeviceModel, scenery: SceneryStore) {
        // Always mint a fresh sheet — reusing a cached window would leak the
        // previous invocation's typed path/selected provider into this one.
        window?.close()

        let dismiss = Binding<Bool>(
            get: { true },
            set: { [weak self] isPresented in
                guard !isPresented else { return }
                self?.window?.close()
            })
        let hosting = NSHostingController(
            rootView: NewSessionSheet(
                multi: multi, scenery: scenery, isPresented: dismiss))
        hosting.sizingOptions = [.preferredContentSize]
        let panel = NSWindow(contentViewController: hosting)
        DarkAppearanceConfigurator.applyAppearance(to: panel)
        panel.styleMask = [.titled, .closable, .fullSizeContentView]
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.title = "New Session"
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        panel.center()
        window = panel
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        window = nil
    }
}
