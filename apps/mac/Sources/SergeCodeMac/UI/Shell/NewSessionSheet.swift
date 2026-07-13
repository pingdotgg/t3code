import AppKit
import SwiftUI

/// Glass sheet for starting a new session: pick an existing project or add
/// a new one via a native folder picker (or typed path), choose a provider
/// and scenery set, then create the thread.
struct NewSessionSheet: View {
    let multi: MultiDeviceModel
    let scenery: SceneryStore
    let passport: PassportStore
    @Binding var isPresented: Bool

    @UIState private var mode: Mode = .existing
    @UIState private var selectedDeviceID: DeviceID = .local
    @UIState private var selectedProjectID: String?
    @UIState private var provider: ProviderKind = .claude
    @UIState private var newProjectPath: String = ""
    @UIState private var scenerySetOverride: String?
    @UIState private var isBusy = false
    @UIState private var errorMessage: String?

    private enum Mode: String, CaseIterable, Identifiable {
        case existing = "Existing Project"
        case new = "New Project"
        var id: String { rawValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // The scene the created thread will be named after — a frosted
            // preview band so the sheet carries the alpine identity too.
            // peekNextScene() reads rotationBucket via @Observable, so
            // App.onReceive bucket reevaluation repaints this strip.
            let previewSetId = selectedScenerySetId
            let nextScene = scenery.peekNextScene(
                projectPath: selectedProjectPath,
                setIdOverride: previewSetId)
            ZStack(alignment: .bottomLeading) {
                FrostedSceneryBackdrop(
                    scenery: scenery,
                    photo: nextScene,
                    setId: previewSetId,
                    fallbackSeed: "new-session")
                    .id(
                        "\(previewSetId)/\(nextScene?.id ?? "next")/\(scenery.rotationBucket.timeOfDay.rawValue)"
                    )
                VStack(alignment: .leading, spacing: 2) {
                    Text("New Session")
                        .font(.title2.bold())
                    if let nextScene {
                        Text(scenery.threadTitle(for: nextScene, setId: previewSetId))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(12)
                .sceneryChrome()
            }
            .frame(height: 82)
            .clipShape(RoundedRectangle(cornerRadius: 12))

            if !multi.remoteSessions.isEmpty {
                Picker("Device", selection: $selectedDeviceID) {
                    Text("This Mac").tag(DeviceID.local)
                    ForEach(multi.remoteSessions) { session in
                        Text(session.descriptor.name).tag(session.id)
                    }
                }
                .onChange(of: selectedDeviceID) {
                    mode = .existing
                    selectedProjectID = nil
                    scenerySetOverride = nil
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
                    selectedProjectID = nil
                    scenerySetOverride = nil
                    clearError()
                }
            }

            Group {
                switch mode {
                case .existing:
                    Picker("Project", selection: $selectedProjectID) {
                        Text("Select a project").tag(String?.none)
                        ForEach(model.projects) { project in
                            Text(project.name).tag(Optional(project.id))
                        }
                    }
                    .onChange(of: selectedProjectID) {
                        scenerySetOverride = nil
                        clearError()
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
                        scenerySetOverride = nil
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
                    Text(kind.displayName).tag(kind)
                }
            }
            .onChange(of: provider) {
                clearError()
            }

            HStack(spacing: 8) {
                Label("Scenery", systemImage: "photo.on.rectangle.angled")
                    .foregroundStyle(.secondary)
                Spacer()
                Picker("Scenery", selection: scenerySetBinding) {
                    ForEach(scenery.availableSets) { set in
                        Text(set.title).tag(set.id)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .fixedSize()
                .disabled(scenery.availableSets.isEmpty)
                .accessibilityLabel("Scenery set for new session")
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
                Button("Create") {
                    Task { await create() }
                }
                .buttonStyle(.glass)
                .tint(.accentColor)
                .disabled(isBusy || !canCreate)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 420)
        .glassEffect(.regular, in: .rect(cornerRadius: 20))
        .animation(Motion.structure, value: mode)
        .animation(Motion.reveal, value: errorMessage == nil)
        .task {
            // Warm the settings so the folder picker can open at the
            // configured default projects directory.
            if model.capabilities.canBrowseLocalFolders, model.settings == nil {
                await model.loadSettings()
            }
            syncProviderSelection()
        }
        .onChange(of: model.configuredProviderKinds) {
            syncProviderSelection()
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

    private var selectedProjectPath: String? {
        switch mode {
        case .existing:
            guard let selectedProjectID else { return nil }
            return model.projects.first(where: { $0.id == selectedProjectID })?.path
        case .new:
            let path = newProjectPath.trimmingCharacters(in: .whitespacesAndNewlines)
            return path.isEmpty ? nil : path
        }
    }

    private var validScenerySetOverride: String? {
        guard let scenerySetOverride, scenery.set(id: scenerySetOverride) != nil else {
            return nil
        }
        return scenerySetOverride
    }

    private var selectedScenerySetId: String {
        scenery.effectiveSetId(
            projectPath: selectedProjectPath,
            setIdOverride: validScenerySetOverride)
    }

    private var scenerySetBinding: Binding<String> {
        Binding(
            get: { selectedScenerySetId },
            set: { scenerySetOverride = $0 })
    }

    private var providerReadinessMessage: String? {
        guard !configuredProviderKinds.isEmpty else {
            return "No providers are configured yet. Refresh providers in Settings."
        }
        guard !model.canCreateThread(with: provider) else { return nil }
        switch model.providerAvailability(for: provider) {
        case .authRequired:
            return "\(provider.displayName) needs sign-in or an auth token. Configure it in Settings > Providers, then refresh."
        case .missing:
            return "\(provider.displayName) is not installed or is unavailable. Check Settings > Providers."
        case .available:
            return "\(provider.displayName) has no selectable models yet. Refresh providers and try again."
        case nil:
            return "\(provider.displayName) is not configured. Refresh providers in Settings."
        }
    }

    private func syncProviderSelection() {
        guard !configuredProviderKinds.isEmpty else { return }
        if !configuredProviderKinds.contains(provider), let first = configuredProviderKinds.first {
            provider = first
        }
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
                scenery: scenery,
                passport: passport,
                scenerySetId: validScenerySetOverride)
        case .new:
            let path = newProjectPath.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !path.isEmpty else { return }
            await model.addProject(path: path)
            if let project = model.projects.first(where: { $0.path == path }) {
                createdThread = await model.createSceneThread(
                    projectID: project.id,
                    provider: provider,
                    scenery: scenery,
                    passport: passport,
                    scenerySetId: validScenerySetOverride)
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

    func show(multi: MultiDeviceModel, scenery: SceneryStore, passport: PassportStore) {
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
                multi: multi, scenery: scenery, passport: passport, isPresented: dismiss))
        hosting.sizingOptions = [.preferredContentSize]
        let panel = NSWindow(contentViewController: hosting)
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
