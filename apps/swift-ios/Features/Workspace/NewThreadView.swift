import SwiftUI

public struct NewThreadView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    let submit: (NewTaskRequest) async -> FeatureThread?
    let onCreated: (FeatureThread) -> Void
    let onCreateProject: @MainActor () -> Void
    private let draftStore: FeatureComposerDraftStore
    private let initialProjectID: String?

    @State private var projectID = ""
    @State private var prompt = ""
    @State private var selection: FeatureSelection?
    @State private var selectionIsExplicit = false
    @State private var preferredSelection: FeatureSelection?
    @State private var attachments: [FeatureDraftAttachment] = []
    @State private var workspaceMode: FeatureWorkspaceMode = .local
    @State private var workspaceSelectionIsExplicit = false
    @State private var branches: [FeatureWorkspaceBranch] = []
    @State private var selectedBranch: FeatureWorkspaceBranch?
    @State private var startFromOrigin = true
    @State private var branchesLoading = false
    @State private var branchLoadFailed = false
    @State private var activePicker: NewTaskPicker?
    @State private var isSubmitting = false
    @State private var submissionFailed = false
    @State private var restoredDraftProjectID: String?
    @State private var draftRestoreContext: NewTaskDraftRestoreContext?
    @State private var draftSaveTask: Task<Void, Never>?
    @State private var immediateDraftSaveTasks: [String: Task<Void, Never>] = [:]
    @State private var submittedSuccessfully = false
    @FocusState private var promptFocused: Bool

    public init(
        model: FeatureRootModel,
        submit: @escaping (NewTaskRequest) async -> FeatureThread?,
        onCreated: @escaping (FeatureThread) -> Void,
        onCreateProject: @escaping @MainActor () -> Void = {},
        initialProjectID: String? = nil,
        draftStore: FeatureComposerDraftStore = .shared
    ) {
        self.model = model
        self.submit = submit
        self.onCreated = onCreated
        self.onCreateProject = onCreateProject
        self.initialProjectID = initialProjectID
        self.draftStore = draftStore
    }

    public var body: some View {
        ZStack {
            T3Colors.background.ignoresSafeArea()

            VStack(spacing: 0) {
                topBar
                if creationProjects.isEmpty {
                    noProjects
                        .padding(.top, 82)
                } else {
                    hero
                        .padding(.top, 82)
                }
                Spacer(minLength: 140)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !creationProjects.isEmpty {
                VStack(spacing: 0) {
                    workspaceControls

                    FeatureComposerView(
                        text: $prompt,
                        selection: selectionBinding,
                        attachments: $attachments,
                        providers: creationProviders,
                        threadSelection: nil,
                        isSending: isSubmitting,
                        isWorking: false,
                        focused: $promptFocused,
                        onSend: startTask,
                        onStop: {},
                        forceExpanded: true,
                        powerFeatures: composerPowerFeatures
                    )
                }
                .background(T3Colors.background)
            }
        }
        .onAppear {
            if projectID.isEmpty {
                let initialProject = creationProjects.first { $0.id == initialProjectID }
                let initialGroup = initialProject.flatMap {
                    DailyUXProjectGrouping.group(
                        containing: $0.id,
                        in: creationProjectGroups
                    )
                }
                let initialID = initialGroup?.preferredProject(
                    environmentID: initialProject?.environmentID
                )?.id ?? creationProjectGroups.first?.projects.first?.id ?? ""
                selectInitialProject(initialID)
            }
        }
        .onChange(of: projectID) { prepareProjectIfNeeded(projectID) }
        .onChange(of: creationProjectIDs) { _, ids in
            guard !ids.contains(projectID) else { return }
            persistCurrentDraftImmediately()
            let previousProject = model.snapshot.projects.first { $0.id == projectID }
            let previousGroupID = previousProject.map {
                DailyUXCreationContext.logicalProjectID(for: $0, in: model.snapshot)
            }
            let replacement = creationProjectGroups.first { $0.id == previousGroupID }?
                .preferredProject(environmentID: previousProject?.environmentID)
                ?? creationProjectGroups.first?.projects.first
            selectInitialProject(replacement?.id ?? "")
        }
        .onChange(of: prompt) { scheduleDraftSave() }
        .onChange(of: selection) { scheduleDraftSave() }
        .onChange(of: attachments) { scheduleDraftSave() }
        .onChange(of: workspaceMode) { scheduleDraftSave() }
        .onChange(of: selectedBranch) { scheduleDraftSave() }
        .onChange(of: startFromOrigin) { scheduleDraftSave() }
        .task(id: projectID) { await restoreDraftAndLoadBranches() }
        .onDisappear {
            guard !submittedSuccessfully else { return }
            persistCurrentDraftImmediately()
        }
        .sheet(item: $activePicker) { picker in
            switch picker {
            case .project:
                NewTaskProjectPicker(
                    groups: creationProjectGroups,
                    selectionID: selectedProjectGroup?.id,
                    onSelect: { group in
                        if selectProjectGroup(group) {
                            activePicker = nil
                        }
                    }
                )
            case .branch:
                NewTaskBranchPicker(
                    branches: branches,
                    selection: selectedBranch,
                    isLoading: branchesLoading,
                    loadFailed: branchLoadFailed,
                    onSelect: { branch in
                        workspaceSelectionIsExplicit = true
                        selectedBranch = branch
                        activePicker = nil
                    },
                    onRefresh: { Task { await loadBranches(refresh: true) } }
                )
            }
        }
        .alert("Couldn’t start task", isPresented: $submissionFailed) {
            Button("OK") {}
        } message: {
            Text("Check your connection and try again.")
        }
        .interactiveDismissDisabled(isSubmitting)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private var topBar: some View {
        HStack {
            Button("Cancel") { dismiss() }
                .font(.body)
                .foregroundStyle(T3Colors.textSecondary)
                .disabled(isSubmitting)
            Spacer()
        }
        .padding(.horizontal, 16)
        .frame(height: 48)
    }

    private var hero: some View {
        VStack(spacing: 10) {
            Text("What should we build")
            HStack(spacing: 0) {
                Text("in")
                Button {
                    activePicker = .project
                } label: {
                    Text(selectedProjectGroup?.name ?? selectedProject?.name ?? "a project")
                        .foregroundStyle(T3Colors.textPrimary)
                        .overlay(alignment: .bottom) {
                            DottedUnderline()
                                .stroke(
                                    T3Colors.textPrimary.opacity(0.58),
                                    style: StrokeStyle(lineWidth: 1, dash: [2, 3])
                                )
                                .frame(height: 1)
                                .offset(y: 3)
                        }
                }
                .buttonStyle(.plain)
                .disabled(isSubmitting)
                .padding(.leading, 5)
                .accessibilityLabel("Choose project")
                .accessibilityValue(
                    selectedProjectGroup?.name ?? selectedProject?.name ?? "a project"
                )
                Text("?")
            }
        }
        .font(T3Typography.threadHeading1.weight(.regular))
        .tracking(-0.35)
        .foregroundStyle(T3Colors.textPrimary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .bottom) {
            Menu {
                ForEach(creationEnvironments) { environment in
                    Button {
                        selectEnvironment(environment.id)
                    } label: {
                        if environment.id == selectedProject?.environmentID {
                            Label(environment.name, systemImage: "checkmark")
                        } else {
                            Text(environment.name)
                        }
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "server.rack")
                        .font(.system(size: 11, weight: .medium))
                    Text("on \(environmentName)")
                    if creationEnvironments.count > 1 {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8, weight: .bold))
                    }
                }
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textTertiary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isSubmitting || creationEnvironments.count < 2)
            .accessibilityLabel("Computer")
            .accessibilityValue(environmentName)
            .offset(y: 31)
        }
        .accessibilityElement(children: .contain)
    }

    private var noProjects: some View {
        VStack(spacing: 14) {
            Image(systemName: "folder.badge.plus")
                .font(.system(size: 28, weight: .regular))
                .foregroundStyle(T3Colors.textSecondary)
            Text("Create a project first")
                .font(T3Typography.threadHeading1.weight(.regular))
                .foregroundStyle(T3Colors.textPrimary)
            Text("Tasks need a workspace on one of your connected environments.")
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textSecondary)
                .multilineTextAlignment(.center)
            Button("Create project") {
                dismiss()
                Task { @MainActor in
                    await Task.yield()
                    onCreateProject()
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(T3Colors.primaryAction)
            .foregroundStyle(T3Colors.primaryActionForeground)
            .padding(.top, 6)
        }
        .padding(.horizontal, 28)
        .frame(maxWidth: .infinity)
    }

    private var selectedProject: FeatureProject? {
        creationProjects.first { $0.id == projectID }
    }

    private var creationProjectGroups: [DailyUXProjectGroup] {
        DailyUXCreationContext.projectGroups(in: model.snapshot)
    }

    private var selectedProjectGroup: DailyUXProjectGroup? {
        DailyUXProjectGrouping.group(containing: projectID, in: creationProjectGroups)
    }

    private var workspaceControls: some View {
        HStack(spacing: 14) {
            Menu {
                Button {
                    setWorkspaceMode(.local)
                } label: {
                    Label(
                        FeatureWorkspaceMode.local.title,
                        systemImage: workspaceMode == .local ? "checkmark" : "folder"
                    )
                }
                Button {
                    setWorkspaceMode(.worktree)
                } label: {
                    Label(
                        FeatureWorkspaceMode.worktree.title,
                        systemImage: workspaceMode == .worktree
                            ? "checkmark"
                            : "arrow.triangle.branch"
                    )
                }
            } label: {
                workspaceControlLabel(
                    workspaceMode.title,
                    systemImage: workspaceMode.systemImage,
                    showsChevron: true
                )
            }
            .disabled(isSubmitting)

            if workspaceMode == .worktree {
                Button {
                    activePicker = .branch
                } label: {
                    workspaceControlLabel(
                        selectedBranch?.name
                            ?? (branchesLoading ? "Loading branches" : "Choose branch"),
                        systemImage: "arrow.triangle.branch",
                        showsChevron: true
                    )
                }
                .buttonStyle(.plain)
                .disabled(isSubmitting)
                .accessibilityLabel("Base branch")
                .accessibilityValue(selectedBranch?.name ?? "Not selected")

                Button {
                    workspaceSelectionIsExplicit = true
                    startFromOrigin.toggle()
                } label: {
                    Label(
                        "Latest origin",
                        systemImage: startFromOrigin ? "checkmark.circle.fill" : "circle"
                    )
                    .lineLimit(1)
                }
                .buttonStyle(.plain)
                .foregroundStyle(
                    startFromOrigin ? T3Colors.textSecondary : T3Colors.textTertiary
                )
                .disabled(isSubmitting)
                .accessibilityValue(startFromOrigin ? "On" : "Off")
            } else if let selectedBranch {
                Label(selectedBranch.name, systemImage: "arrow.triangle.branch")
                    .lineLimit(1)
                    .foregroundStyle(T3Colors.textTertiary)
                    .accessibilityLabel("Current branch, \(selectedBranch.name)")
            }

            Spacer(minLength: 0)
        }
        .font(T3Typography.supporting)
        .padding(.horizontal, 18)
        .frame(minHeight: 38)
        .animation(.snappy(duration: 0.18), value: workspaceMode)
    }

    private func workspaceControlLabel(
        _ title: String,
        systemImage: String,
        showsChevron: Bool
    ) -> some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage)
                .font(.system(size: 12, weight: .medium))
            Text(title)
                .lineLimit(1)
            if showsChevron {
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
            }
        }
        .foregroundStyle(T3Colors.textSecondary)
        .contentShape(Rectangle())
    }

    private var creationProjects: [FeatureProject] {
        DailyUXCreationContext.projects(in: model.snapshot)
    }

    private var creationProjectIDs: [String] {
        creationProjectGroups.flatMap(\.projects).map(\.id)
    }

    private var creationEnvironments: [FeatureEnvironment] {
        let environmentIDs = Set(selectedProjectGroup?.projects.map(\.environmentID) ?? [])
        return model.snapshot.environments.filter { environmentIDs.contains($0.id) }
    }

    private var environmentName: String {
        if let environmentID = selectedProject?.environmentID,
           let environment = model.snapshot.environments.first(where: { $0.id == environmentID }) {
            return environment.name
        }
        return model.snapshot.connection.environmentName ?? "this server"
    }

    private var initialSelection: FeatureSelection? {
        ProviderModelSelectionResolver.materialized(
            DailyUXCreationContext.initialSelection(
                for: selectedProject,
                in: model.snapshot
            ),
            in: creationProviders
        )
    }

    private var environmentPreferences: FeatureEnvironmentPreferences {
        DailyUXCreationContext.environmentPreferences(
            for: selectedProject,
            in: model.snapshot
        )
    }

    private var selectionBinding: Binding<FeatureSelection?> {
        Binding(
            get: { selection },
            set: { value in
                selectionIsExplicit = true
                selection = value
                preferredSelection = value
            }
        )
    }

    /// Model and provider capabilities belong to the project's environment,
    /// which may not be the connection currently selected in Settings.
    private var creationProviders: [FeatureProvider] {
        ProviderModelCatalogNormalizer.normalized(
            DailyUXCreationContext.providers(
                for: selectedProject,
                in: model.snapshot
            )
        )
    }

    private var composerPowerFeatures: FeatureComposerPowerFeatures {
        let provider = creationProviders.first {
            $0.id == selection?.providerID
        }
        guard let project = selectedProject else {
            return FeatureComposerPowerFeatures(
                slashCommands: provider?.slashCommands ?? [],
                skills: provider?.skills ?? []
            )
        }
        return FeatureComposerPowerFeatures(
            slashCommands: provider?.slashCommands ?? [],
            skills: provider?.skills ?? [],
            pathSearchScopeID: project.id,
            searchPaths: { query in
                try await model.client.searchProjectFiles(
                    projectID: project.id,
                    query: query,
                    limit: 20
                ).map(Self.composerPathEntry)
            }
        )
    }

    private static func composerPathEntry(_ entry: FeatureFileEntry) -> FeatureComposerPathEntry {
        FeatureComposerPathEntry(
            path: entry.path,
            kind: entry.kind == .directory ? .directory : .file
        )
    }

    private var canSubmit: Bool {
        !isSubmitting
            && selectedProject != nil
            && restoredDraftProjectID == projectID
            && concreteSelection != nil
            && (!trimmedPrompt.isEmpty || !attachments.isEmpty)
            && (attachments.isEmpty || imagesAllowed)
            && (workspaceMode != .worktree || selectedBranch != nil)
    }

    private var trimmedPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var imagesAllowed: Bool {
        DailyUXModelOptions.supportsImages(
            selection: concreteSelection,
            providers: creationProviders
        )
    }

    private var concreteSelection: FeatureSelection? {
        ProviderModelSelectionResolver.materialized(selection, in: creationProviders)
    }

    private func startTask() {
        guard canSubmit,
              let project = selectedProject,
              let concreteSelection else {
            return
        }
        promptFocused = false
        isSubmitting = true
        let pendingDraftSaveTask = draftSaveTask
        pendingDraftSaveTask?.cancel()
        draftSaveTask = nil
        let draftKey = currentDraftKey
        let draftSnapshot = composerDraft
        let immediateDraftSaveTask = draftKey.flatMap {
            immediateDraftSaveTasks.removeValue(forKey: $0)
        }
        let request = NewTaskRequest(
            projectID: project.id,
            prompt: trimmedPrompt,
            selection: concreteSelection,
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            workspaceMode: workspaceMode,
            branch: selectedBranch?.name,
            worktreePath: workspaceMode == .local
                ? NewTaskWorkspaceDefaults.normalizedWorktreePath(
                    for: selectedBranch,
                    projectPath: project.path
                )
                : nil,
            startFromOrigin: startFromOrigin,
            attachments: attachments
        )

        Task { @MainActor in
            await NewTaskDraftWriteFence.cancelAndWait(pendingDraftSaveTask)
            await NewTaskDraftWriteFence.cancelAndWait(immediateDraftSaveTask)
            if let draftKey {
                try? await draftStore.setDraft(draftSnapshot, for: draftKey)
            }
            if let thread = await submit(request) {
                submittedSuccessfully = true
                let trailingDraftSaveTask = draftSaveTask
                draftSaveTask = nil
                await NewTaskDraftWriteFence.cancelAndWait(trailingDraftSaveTask)
                if let draftKey {
                    let trailingSave = immediateDraftSaveTasks.removeValue(forKey: draftKey)
                    await NewTaskDraftWriteFence.cancelAndWait(trailingSave)
                    try? await draftStore.removeDraft(for: draftKey)
                }
                onCreated(thread)
            } else {
                isSubmitting = false
                submissionFailed = true
                promptFocused = true
            }
        }
    }

    @discardableResult
    private func selectProject(_ id: String) -> Bool {
        guard id != projectID else { return true }
        guard creationProjects.contains(where: { $0.id == id }) else { return false }
        persistCurrentDraftImmediately()
        projectID = id
        prepareProjectIfNeeded(id)
        return true
    }

    @discardableResult
    private func selectProjectGroup(_ group: DailyUXProjectGroup) -> Bool {
        guard let target = DailyUXProjectGrouping.selectionTarget(
            groupID: group.id,
            preferredEnvironmentID: selectedProject?.environmentID,
            in: creationProjectGroups
        ) else { return false }
        guard group.id != selectedProjectGroup?.id else { return true }
        return selectProject(target.id)
    }

    private func selectEnvironment(_ id: String) {
        guard selectedProject?.environmentID != id else { return }
        let project = selectedProjectGroup?.project(in: id)
        guard let project else { return }
        selectProject(project.id)
    }

    private func selectInitialProject(_ id: String) {
        projectID = id
        prepareProjectIfNeeded(id)
    }

    private func prepareProjectIfNeeded(_ id: String) {
        guard draftRestoreContext?.projectID != id else { return }

        if selectionIsExplicit, let selection {
            preferredSelection = selection
        }

        restoredDraftProjectID = nil
        draftSaveTask?.cancel()
        draftSaveTask = nil
        prompt = ""
        attachments = []
        selectionIsExplicit = false
        workspaceSelectionIsExplicit = false
        branches = []
        selectedBranch = nil
        branchLoadFailed = false
        branchesLoading = false

        guard let project = creationProjects.first(where: { $0.id == id }) else {
            selection = nil
            workspaceMode = .local
            startFromOrigin = true
            draftRestoreContext = nil
            return
        }

        let providers = ProviderModelCatalogNormalizer.normalized(
            DailyUXCreationContext.providers(for: project, in: model.snapshot)
        )
        let carriedSelection = DailyUXModelOptions.validated(preferredSelection, in: providers)
        selection = ProviderModelSelectionResolver.materialized(
            DailyUXCreationContext.selection(
                carrying: preferredSelection,
                to: project,
                in: model.snapshot
            ),
            in: providers
        )
        selectionIsExplicit = carriedSelection != nil
        let preferences = DailyUXCreationContext.environmentPreferences(
            for: project,
            in: model.snapshot
        )
        workspaceMode = preferences.defaultWorkspaceMode
        startFromOrigin = preferences.newWorktreesStartFromOrigin
        draftRestoreContext = NewTaskDraftRestoreContext(
            projectID: id,
            baseline: FeatureComposerDraft()
        )
    }

    private func setWorkspaceMode(_ mode: FeatureWorkspaceMode) {
        workspaceSelectionIsExplicit = true
        workspaceMode = mode
        selectedBranch = switch mode {
        case .local: NewTaskWorkspaceDefaults.localBranch(in: branches)
        case .worktree: NewTaskWorkspaceDefaults.worktreeBase(in: branches)
        }
    }

    @MainActor
    private func loadBranches(refresh: Bool = false) async {
        let requestedProjectID = projectID
        guard !requestedProjectID.isEmpty else { return }

        branchesLoading = true
        branchLoadFailed = false
        do {
            let loaded = try await model.workspaceBranches(
                projectID: requestedProjectID,
                refresh: refresh
            )
            guard !Task.isCancelled, projectID == requestedProjectID else { return }
            branches = loaded.sorted(by: Self.branchSort)

            if let selectedBranch,
               let updated = branches.first(where: { $0.name == selectedBranch.name }) {
                self.selectedBranch = updated
            } else {
                self.selectedBranch = switch workspaceMode {
                case .local: NewTaskWorkspaceDefaults.localBranch(in: branches)
                case .worktree: NewTaskWorkspaceDefaults.worktreeBase(in: branches)
                }
            }
        } catch is CancellationError {
            return
        } catch {
            guard projectID == requestedProjectID else { return }
            branchLoadFailed = true
        }
        guard projectID == requestedProjectID else { return }
        branchesLoading = false
    }

    @MainActor
    private func restoreDraftAndLoadBranches() async {
        let requestedProjectID = projectID
        guard let project = selectedProject,
              let context = draftRestoreContext,
              context.projectID == requestedProjectID,
              !requestedProjectID.isEmpty else {
            return
        }
        let key = draftKey(for: project)
        let pendingImmediateSave = immediateDraftSaveTasks[key]
        await NewTaskDraftWriteFence.wait(pendingImmediateSave)
        guard !Task.isCancelled,
              projectID == requestedProjectID,
              draftRestoreContext?.projectID == requestedProjectID else {
            return
        }
        let saved = try? await draftStore.draft(for: key)
        guard !Task.isCancelled,
              projectID == requestedProjectID,
              draftRestoreContext?.projectID == requestedProjectID else {
            return
        }

        let liveDraft = composerDraft
        let liveSelectionIsExplicit = selectionIsExplicit
        let liveWorkspaceSelectionIsExplicit = workspaceSelectionIsExplicit
        let restored = context.merging(
            saved: saved,
            current: liveDraft,
            fallbackSelection: initialSelection,
            fallbackWorkspace: FeatureComposerWorkspaceDraft(
                mode: environmentPreferences.defaultWorkspaceMode,
                branch: nil,
                worktreePath: nil,
                startFromOrigin: environmentPreferences.newWorktreesStartFromOrigin
            )
        )
        prompt = restored.text
        attachments = restored.attachments
        selection = DailyUXModelOptions.validated(restored.selection, in: creationProviders)
            ?? initialSelection
        selectionIsExplicit = liveSelectionIsExplicit || saved?.selection != nil
        if selectionIsExplicit, let selection {
            preferredSelection = selection
        }
        if let workspace = restored.workspace {
            workspaceMode = workspace.mode
            selectedBranch = workspace.branch.map {
                FeatureWorkspaceBranch(
                    name: $0,
                    worktreePath: workspace.worktreePath
                )
            }
            startFromOrigin = workspace.startFromOrigin
        }
        workspaceSelectionIsExplicit = liveWorkspaceSelectionIsExplicit
            || saved?.workspace != nil
        restoredDraftProjectID = requestedProjectID
        if liveDraft != context.baseline {
            scheduleDraftSave()
        }
        await loadBranches()
    }

    private var currentDraftKey: String? {
        guard let project = selectedProject else { return nil }
        return draftKey(for: project)
    }

    private func draftKey(for project: FeatureProject) -> String {
        guard project.repositoryIdentity != nil,
              let group = DailyUXProjectGrouping.group(
                  containing: project.id,
                  in: creationProjectGroups
              ) else {
            return FeatureComposerDraftStore.newTaskKey(project: project)
        }
        return FeatureComposerDraftStore.newTaskKey(logicalProjectID: group.id)
    }

    private var composerDraft: FeatureComposerDraft {
        FeatureComposerDraft(
            text: prompt,
            attachments: attachments,
            selection: selectionIsExplicit ? selection : nil,
            workspace: workspaceSelectionIsExplicit
                ? FeatureComposerWorkspaceDraft(
                    mode: workspaceMode,
                    branch: selectedBranch?.name,
                    worktreePath: workspaceMode == .local
                        ? NewTaskWorkspaceDefaults.normalizedWorktreePath(
                            for: selectedBranch,
                            projectPath: selectedProject?.path ?? ""
                        )
                        : nil,
                    startFromOrigin: startFromOrigin
                )
                : nil
        )
    }

    private func scheduleDraftSave() {
        guard restoredDraftProjectID == projectID,
              !isSubmitting,
              !submittedSuccessfully,
              let key = currentDraftKey else {
            return
        }
        let pendingDraftSaveTask = draftSaveTask
        pendingDraftSaveTask?.cancel()
        draftSaveTask = nil
        let snapshot = composerDraft
        draftSaveTask = Task {
            await NewTaskDraftWriteFence.wait(pendingDraftSaveTask)
            do {
                try await Task.sleep(for: .milliseconds(220))
                try Task.checkCancellation()
                try await draftStore.setDraft(snapshot, for: key)
            } catch is CancellationError {
                return
            } catch {
                return
            }
        }
    }

    private func persistCurrentDraftImmediately() {
        guard !submittedSuccessfully,
              let key = currentDraftKey else {
            return
        }
        let pendingDraftSaveTask = draftSaveTask
        pendingDraftSaveTask?.cancel()
        draftSaveTask = nil
        let snapshot = composerDraft
        let restoreContext = draftRestoreContext
        let draftProjectID = projectID
        let needsRestoreMerge = restoredDraftProjectID != draftProjectID
        let previousSave = immediateDraftSaveTasks[key]
        previousSave?.cancel()
        let task = Task { @MainActor in
            await NewTaskDraftWriteFence.wait(pendingDraftSaveTask)
            await NewTaskDraftWriteFence.wait(previousSave)
            guard !Task.isCancelled else { return }
            if needsRestoreMerge,
               let restoreContext,
               restoreContext.projectID == draftProjectID {
                let saved = try? await draftStore.draft(for: key)
                guard !Task.isCancelled else { return }
                let merged = restoreContext.merging(saved: saved, current: snapshot)
                try? await draftStore.setDraft(merged, for: key)
            } else {
                try? await draftStore.setDraft(snapshot, for: key)
            }
        }
        immediateDraftSaveTasks[key] = task
    }

    private static func branchSort(
        _ lhs: FeatureWorkspaceBranch,
        _ rhs: FeatureWorkspaceBranch
    ) -> Bool {
        let lhsRank = lhs.isCurrent ? 0 : lhs.isDefault ? 1 : lhs.isRemote ? 3 : 2
        let rhsRank = rhs.isCurrent ? 0 : rhs.isDefault ? 1 : rhs.isRemote ? 3 : 2
        if lhsRank != rhsRank { return lhsRank < rhsRank }
        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
    }
}

enum NewTaskDraftWriteFence {
    static func wait(_ task: Task<Void, Never>?) async {
        await task?.value
    }

    static func cancelAndWait(_ task: Task<Void, Never>?) async {
        task?.cancel()
        await task?.value
    }
}

/// Captures the clean target-project state before its persisted draft is read.
/// Async restore results can then merge live typing without ever borrowing state
/// from the project that was previously selected.
struct NewTaskDraftRestoreContext: Equatable {
    let projectID: String
    let baseline: FeatureComposerDraft

    func merging(
        saved: FeatureComposerDraft?,
        current: FeatureComposerDraft,
        fallbackSelection: FeatureSelection? = nil,
        fallbackWorkspace: FeatureComposerWorkspaceDraft? = nil
    ) -> FeatureComposerDraft {
        FeatureComposerDraftRestoration.merge(
            saved: saved,
            baseline: baseline,
            current: current,
            fallbackSelection: fallbackSelection,
            fallbackWorkspace: fallbackWorkspace
        )
    }
}

private struct DottedUnderline: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return path
    }
}

private enum NewTaskPicker: String, Identifiable {
    case project
    case branch

    var id: String { rawValue }
}

private struct NewTaskProjectPicker: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let groups: [DailyUXProjectGroup]
    let selectionID: String?
    let onSelect: (DailyUXProjectGroup) -> Void

    var body: some View {
        NavigationStack {
            Group {
                if groups.isEmpty {
                    ContentUnavailableView(
                        "No projects available",
                        systemImage: "folder",
                        description: Text("Reconnect an environment or add a project to continue.")
                    )
                } else {
                    List(groups) { group in
                        Button {
                            onSelect(group)
                        } label: {
                            HStack(spacing: 12) {
                                Text(group.name)
                                    .foregroundStyle(T3Colors.textPrimary)

                                Spacer(minLength: 10)

                                if group.id == selectionID {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(T3Colors.accent)
                                }
                            }
                            .frame(minHeight: 34)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(
                            group.id == selectionID ? .isSelected : []
                        )
                        .listRowBackground(T3Colors.background)
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            }
            .background(T3Colors.background)
            .navigationTitle("Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(T3Colors.background)
    }
}

private struct NewTaskBranchPicker: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss

    let branches: [FeatureWorkspaceBranch]
    let selection: FeatureWorkspaceBranch?
    let isLoading: Bool
    let loadFailed: Bool
    let onSelect: (FeatureWorkspaceBranch) -> Void
    let onRefresh: () -> Void

    @State private var query = ""

    var body: some View {
        NavigationStack {
            Group {
                if isLoading, branches.isEmpty {
                    ProgressView("Loading branches")
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if filteredBranches.isEmpty {
                    ContentUnavailableView {
                        Label(
                            loadFailed ? "Branches unavailable" : "No branches found",
                            systemImage: loadFailed
                                ? "exclamationmark.triangle"
                                : "arrow.triangle.branch"
                        )
                    } description: {
                        Text(
                            loadFailed
                                ? "Check the connection and try again."
                                : "Try a different search."
                        )
                    } actions: {
                        if loadFailed {
                            Button("Try again", action: onRefresh)
                        }
                    }
                } else {
                    List(filteredBranches) { branch in
                        Button {
                            onSelect(branch)
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "arrow.triangle.branch")
                                    .foregroundStyle(T3Colors.textTertiary)

                                Text(branch.name)
                                    .foregroundStyle(T3Colors.textPrimary)
                                    .lineLimit(1)

                                Spacer(minLength: 10)

                                if let badge = branch.badge {
                                    Text(badge)
                                        .font(T3Typography.supporting)
                                        .foregroundStyle(T3Colors.textTertiary)
                                }

                                if branch.id == selection?.id {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(T3Colors.accent)
                                }
                            }
                            .frame(minHeight: 34)
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(T3Colors.background)
                    }
                    .listStyle(.plain)
                    .refreshable { onRefresh() }
                }
            }
            .background(T3Colors.background)
            .navigationTitle("Base branch")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Search branches")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(action: onRefresh) {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(isLoading)
                    .accessibilityLabel("Refresh branches")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(T3Colors.background)
    }

    private var filteredBranches: [FeatureWorkspaceBranch] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return branches }
        return branches.filter {
            $0.name.localizedCaseInsensitiveContains(trimmed)
        }
    }
}
