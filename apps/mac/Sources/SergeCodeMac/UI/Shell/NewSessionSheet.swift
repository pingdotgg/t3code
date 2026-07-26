import AppKit
import SwiftUI

/// Glass sheet for starting a new session: pick an existing project or add
/// a new one via a native folder picker (or typed path), choose a provider,
/// then create the thread.
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
        case existing = "Existing Project"
        case new = "New Project"
        var id: String { rawValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // The scene the created thread will be named after — a frosted
            // preview band so the sheet carries the scenery identity too.
            // Populated in `.task`: `peekNextScene()` samples and writes
            // `SceneryStore.pendingScene` on the first call, so calling it
            // here would mutate observable state during a view update.
            VStack(alignment: .leading, spacing: 10) {
                FrostedSceneryBackdrop(
                    scenery: scenery,
                    photo: nextScene,
                    fallbackSeed: "new-session")
                    .id(nextScene?.id ?? "next")
                    .frame(height: 68)
                    .clipShape(RoundedRectangle(cornerRadius: 12))

                HStack(alignment: .firstTextBaseline) {
                    Text("New Session")
                        .font(.title2.bold())
                    Spacer()
                    if let nextScene {
                        Text(scenery.threadTitle(for: nextScene))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if !multi.remoteSessions.isEmpty {
                Picker("Device", selection: $selectedDeviceID) {
                    Text("This Mac").tag(DeviceID.local)
                    ForEach(multi.remoteSessions) { session in
                        Text(session.descriptor.name).tag(session.id)
                    }
                }
                .onChange(of: selectedDeviceID) {
                    mode = .existing
                    selectDefaultProject()
                    syncProviderSelection()
                    projectSearch = ""
                    clearError()
                }
            }

            if model.capabilities.canBrowseLocalFolders {
                Picker("", selection: $mode) {
                    ForEach(Mode.allCases) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
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

            Group {
                switch mode {
                case .existing:
                    if model.projects.isEmpty {
                        ContentUnavailableView {
                            Label("No Projects on This Mac", systemImage: "folder")
                        } description: {
                            Text(
                                model.capabilities.canBrowseLocalFolders
                                    ? "Choose New Project, then select a project folder."
                                    : "Add a project on the remote Mac, then try again."
                            )
                        }
                        .frame(height: 96)
                    } else {
                        ProjectChoiceList(
                            projects: model.projects,
                            selectedProjectID: $selectedProjectID,
                            searchText: $projectSearch)
                        .onChange(of: selectedProjectID) {
                            clearError()
                        }
                    }
                case .new:
                    HStack(spacing: 8) {
                        TextField("Project folder", text: $newProjectPath)
                            .textFieldStyle(.roundedBorder)
                        Button {
                            pickFolder()
                        } label: {
                            Label("Browse…", systemImage: "folder")
                        }
                        .buttonStyle(.glass)
                    }
                    .onChange(of: newProjectPath) {
                        clearError()
                    }
                }
            }
            .id(mode)
            .transition(Motion.paneChange)

            Picker("Provider", selection: $provider) {
                if configuredProviderKinds.isEmpty {
                    Text("No providers found").tag(provider)
                }
                ForEach(configuredProviderKinds) { kind in
                    ProviderLabel(provider: kind).tag(kind)
                }
            }
            .onChange(of: provider) {
                clearError()
            }

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            } else if let providerReadinessMessage {
                Label(providerReadinessMessage, systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
            }

            HStack {
                Spacer()
                Button("Cancel") { isPresented = false }
                    .buttonStyle(.glass)
                    .keyboardShortcut(.cancelAction)
                Button("Create Session") {
                    Task { await create() }
                }
                .buttonStyle(.glass)
                .tint(AlpineTheme.accent)
                .disabled(isBusy || !canCreate)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 420)
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

private struct ProjectChoiceList: View {
    let projects: [Project]
    @Binding var selectedProjectID: String?
    @Binding var searchText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Search projects", text: $searchText)
                    .textFieldStyle(.plain)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 8))

            if filteredProjects.isEmpty {
                ContentUnavailableView(
                    "No Matching Projects",
                    systemImage: "magnifyingglass",
                    description: Text("Try a different project name or path."))
                    .frame(height: 104)
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
                }
                .frame(height: 128)
            }
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
                Image(systemName: "folder")
                    .foregroundStyle(.secondary)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 2) {
                    Text(project.name).foregroundStyle(.primary).lineLimit(1)
                    Text(project.path)
                        .font(.caption)
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
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
            .background(
                isSelected ? AlpineTheme.accent.opacity(0.12)
                    : isHovering ? Color.primary.opacity(0.06) : Color.clear,
                in: RoundedRectangle(cornerRadius: 8))
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
