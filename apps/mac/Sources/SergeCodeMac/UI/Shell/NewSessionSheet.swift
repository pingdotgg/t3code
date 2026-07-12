import AppKit
import SwiftUI

/// Glass sheet for starting a new session: pick an existing project or add
/// a new one via a native folder picker (or typed path), choose a provider
/// and scenery set, then create the thread.
struct NewSessionSheet: View {
    let model: AppModel
    let scenery: SceneryStore
    let passport: PassportStore
    @Binding var isPresented: Bool

    @UIState private var mode: Mode = .existing
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
                        Text(scenery.threadTitle(for: nextScene))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(12)
                .sceneryChrome()
            }
            .frame(height: 82)
            .clipShape(RoundedRectangle(cornerRadius: 12))

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
            .transition(Motion.paneSwap)

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
                Button("Create") {
                    Task { await create() }
                }
                .buttonStyle(.glass)
                .tint(.accentColor)
                .disabled(isBusy || !canCreate)
            }
        }
        .padding(24)
        .frame(width: 420)
        .glassEffect(.regular, in: .rect(cornerRadius: 20))
        .animation(Motion.settle, value: mode)
        .animation(Motion.fade, value: errorMessage == nil)
        .task {
            // Warm the settings so the folder picker can open at the
            // configured default projects directory.
            if model.settings == nil {
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
        switch mode {
        case .existing: return selectedProjectID != nil
        case .new: return !newProjectPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private var configuredProviderKinds: [ProviderKind] {
        model.configuredProviderKinds
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
        validScenerySetOverride
            ?? scenery.resolvedSetId(projectPath: selectedProjectPath)
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
            isPresented = false
        } else {
            errorMessage =
                model.lastError
                ?? "Couldn't create a new \(provider.displayName) session. Check provider settings and try again."
        }
    }
}
