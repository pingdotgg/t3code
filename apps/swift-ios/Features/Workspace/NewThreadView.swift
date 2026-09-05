import SwiftUI

public struct NewThreadView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @Bindable var model: FeatureRootModel
    let submit: (NewTaskRequest) async -> FeatureThread?
    let onCreated: (FeatureThread) -> Void
    let onCreateProject: @MainActor () -> Void
    private let draftStore: FeatureComposerDraftStore
    private let initialProjectID: String?

    @State private var projectID = ""
    @State private var projectSelectionIsExplicit = false
    @State private var isAwaitingRecentProject = false
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
    @State private var submissionValidationError: String?
    @State private var restoredDraftProjectID: String?
    @State private var draftRestoreContext: NewTaskDraftRestoreContext?
    @State private var draftSaveTask: Task<Void, Never>?
    @State private var draftSaveError: String?
    @State private var immediateDraftSaveTasks: [String: Task<Void, Never>] = [:]
    @State private var submittedSuccessfully = false
    @State private var restoresPromptAfterPickerDismissal = false
    // Plain state, not `FocusState`; see the note on `composerFocused` in
    // ThreadDetailView.
    @State private var promptFocused = false

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
                } else if !usesCompactProjectContext {
                    hero
                        .padding(.top, 82)
                }
                Spacer(minLength: 0)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !creationProjects.isEmpty {
                VStack(spacing: 0) {
                    if usesCompactProjectContext {
                        compactProjectContext
                    }

                    if let submissionValidationError {
                        Label(submissionValidationError, systemImage: "exclamationmark.circle")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 18)
                            .padding(.vertical, 6)
                            .accessibilityElement(children: .combine)
                    }

                    workspaceControls

                    FeatureComposerView(
                        text: $prompt,
                        selection: selectionBinding,
                        attachments: attachmentBinding,
                        draftOwnerID: selectedProject.map {
                            "new-task:\($0.environmentID):\($0.id)"
                        } ?? "new-task:unselected",
                        environmentID: selectedProject?.environmentID,
                        draftStorageKey: currentDraftKey,
                        environmentIsConnected: selectedProject.flatMap { project in
                            model.snapshot.environments.first {
                                $0.id == project.environmentID
                            }?.connectionState
                        } == .connected,
                        attachmentUploads: model.attachmentUploads,
                        attachmentPreferences: environmentPreferences,
                        providers: creationProviders,
                        threadSelection: nil,
                        isSending: isSubmitting,
                        isWorking: false,
                        focused: $promptFocused,
                        onSend: startTask,
                        onStop: {},
                        forceExpanded: true,
                        powerFeatures: composerPowerFeatures,
                        onDismissKeyboard: { promptFocused = false },
                        onRefreshModels: refreshSelectedEnvironmentModels,
                        draftSaveError: draftSaveError,
                        onRetryDraftSave: persistCurrentDraftImmediately
                    )
                }
                .background(T3Colors.background)
            }
        }
        .onAppear {
            if projectID.isEmpty {
                let recentProject = DailyUXCreationContext.recentProjects(
                    in: model.snapshot
                ).first?.project
                let initialID = DailyUXCreationContext.initialProject(
                    in: model.snapshot,
                    requestedProjectID: initialProjectID
                )?.id ?? ""
                isAwaitingRecentProject = initialProjectID == nil && recentProject == nil
                selectInitialProject(initialID)
            }
        }
        .onChange(of: projectID) { prepareProjectIfNeeded(projectID) }
        .onChange(of: creationProjectIDs) { _, ids in
            guard !ids.contains(projectID) else { return }
            if projectID.isEmpty {
                let recentProject = DailyUXCreationContext.recentProjects(
                    in: model.snapshot
                ).first?.project
                let initialID = DailyUXCreationContext.initialProject(
                    in: model.snapshot,
                    requestedProjectID: initialProjectID
                )?.id ?? ""
                isAwaitingRecentProject = initialProjectID == nil && recentProject == nil
                selectInitialProject(initialID)
                return
            }
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
        .onChange(of: model.homePresentationRevision) { _, _ in
            refreshAutomaticProjectIfNeeded()
        }
        .onChange(of: prompt) { scheduleDraftSave() }
        .onChange(of: selection) { scheduleDraftSave() }
        .onChange(of: workspaceMode) { scheduleDraftSave() }
        .onChange(of: selectedBranch) { scheduleDraftSave() }
        .onChange(of: startFromOrigin) { scheduleDraftSave() }
        .onChange(of: submissionValidationMessage) { _, _ in
            submissionValidationError = nil
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active, !submittedSuccessfully {
                persistCurrentDraftImmediately()
            }
        }
        .task(id: projectID) { await restoreDraftAndLoadBranches() }
        .environment(\.providerSetupContext, selectedProject.map {
            ProviderSetupContext(model: model, environmentID: $0.environmentID)
        })
        .task(id: "\(selectedProject?.id ?? ""):\(selection?.providerID ?? "")") {
            if let project = selectedProject, let instanceID = selection?.providerID {
                await model.refreshWorkspaceProviders(environmentID: project.environmentID, cwd: project.path, instanceID: instanceID)
            }
        }
        .onDisappear {
            guard !submittedSuccessfully else { return }
            persistCurrentDraftImmediately()
        }
        .sheet(item: $activePicker, onDismiss: {
            let shouldRestorePrompt = restoresPromptAfterPickerDismissal
            restoresPromptAfterPickerDismissal = false
            if shouldRestorePrompt, !creationProjects.isEmpty, !isSubmitting {
                promptFocused = true
            }
        }) { picker in
            switch picker {
            case .project:
                NewTaskProjectPicker(
                    groups: creationProjectGroups,
                    environments: model.snapshot.environments,
                    recentGroupIDs: recentProjectGroupIDs,
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
            // Refocus on dismissal, not on failure: the alert takes first
            // responder, so an earlier refocus never survives it.
            Button("OK") { promptFocused = true }
        } message: {
            Text("Check your connection and try again.")
        }
        .interactiveDismissDisabled(isSubmitting)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private var usesCompactProjectContext: Bool {
        NewThreadComposerLayout.usesCompactContext(
            prompt: prompt,
            isFocused: promptFocused,
            hasAttachments: !attachments.isEmpty
        )
    }

    private var topBar: some View {
        HStack {
            Button("Cancel") { dismiss() }
                .font(.body)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(minHeight: 44)
                .disabled(isSubmitting)
                .accessibilityLabel("Cancel new task")
            Spacer()
        }
        .padding(.horizontal, 16)
        .frame(height: 48)
    }

    private var hero: some View {
        VStack(spacing: 8) {
            VStack(spacing: 4) {
                Text("What should we build")

                HStack(spacing: 0) {
                    Text("in")

                    Button {
                        presentPicker(.project)
                    } label: {
                        Text(selectedProjectGroup?.name ?? selectedProject?.name ?? "a project")
                            .lineLimit(1)
                            .truncationMode(.middle)
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
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(isSubmitting)
                    .padding(.leading, 5)
                    .layoutPriority(1)
                    .accessibilityLabel("Choose project")
                    .accessibilityValue(
                        selectedProjectGroup?.name ?? selectedProject?.name ?? "Not selected"
                    )

                    Text("?")
                }
            }
            .font(T3Typography.threadHeading1.weight(.regular))
            .foregroundStyle(T3Colors.textPrimary)
            .multilineTextAlignment(.center)

            environmentPicker
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }

    private var compactProjectContext: some View {
        HStack(spacing: 12) {
            Button {
                presentPicker(.project)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "folder")
                        .font(.system(size: 11, weight: .medium))
                    Text(
                        selectedProjectGroup?.name
                            ?? selectedProject?.name
                            ?? "Choose project"
                    )
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textPrimary)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isSubmitting)
            .layoutPriority(1)
            .accessibilityLabel("Choose project")
            .accessibilityValue(
                selectedProjectGroup?.name ?? selectedProject?.name ?? "Not selected"
            )

            Spacer(minLength: 0)

            environmentPicker
        }
        .padding(.horizontal, 18)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }

    private var environmentPicker: some View {
        Menu {
            ForEach(creationEnvironments) { environment in
                Button {
                    selectEnvironment(environment.id)
                } label: {
                    if environment.id == selectedProject?.environmentID {
                        Label(environmentLabel(environment), systemImage: "checkmark")
                    } else {
                        Text(environmentLabel(environment))
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: creationEnvironments.first { $0.id == selectedProject?.environmentID }?.systemImage ?? "server.rack")
                    .font(.system(size: 11, weight: .medium))
                Text(environmentName)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let environmentStatus {
                    Text(environmentStatus)
                        .foregroundStyle(T3Colors.warning)
                }
                if creationEnvironments.count > 1 {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .bold))
                }
            }
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isSubmitting || creationEnvironments.count < 2)
        .accessibilityLabel("Environment")
        .accessibilityValue(environmentAccessibilityValue)
    }

    private var noProjects: some View {
        VStack(spacing: 14) {
            Image(systemName: "folder.badge.plus")
                .font(.system(size: 28, weight: .regular))
                .foregroundStyle(T3Colors.textSecondary)
            Text("No projects")
                .font(T3Typography.threadHeading1.weight(.regular))
                .foregroundStyle(T3Colors.textPrimary)
            Button("Add project") {
                dismiss()
                Task { @MainActor in
                    await Task.yield()
                    onCreateProject()
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
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

    private var recentProjectGroupIDs: [String] {
        DailyUXCreationContext.recentProjects(in: model.snapshot).map(\.group.id)
    }

    private var selectedProjectGroup: DailyUXProjectGroup? {
        DailyUXProjectGrouping.group(containing: projectID, in: creationProjectGroups)
    }

    private var workspaceControls: some View {
        ScrollView(.horizontal, showsIndicators: false) {
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
                .accessibilityLabel("Workspace")
                .accessibilityValue(workspaceMode.title)

                if workspaceMode == .worktree {
                    Button {
                        presentPicker(.branch)
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
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(
                        startFromOrigin ? T3Colors.textSecondary : T3Colors.textTertiary
                    )
                    .disabled(isSubmitting)
                    .accessibilityLabel("Start from latest origin")
                    .accessibilityValue(startFromOrigin ? "On" : "Off")
                } else if let selectedBranch {
                    Label(selectedBranch.name, systemImage: "arrow.triangle.branch")
                        .lineLimit(1)
                        .foregroundStyle(T3Colors.textTertiary)
                        .accessibilityLabel("Current branch, \(selectedBranch.name)")
                }
            }
            .padding(.horizontal, 18)
        }
        .font(T3Typography.supporting)
        .frame(minHeight: 44)
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
        .frame(minHeight: 44)
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

    private var selectedEnvironment: FeatureEnvironment? {
        guard let environmentID = selectedProject?.environmentID else { return nil }
        return model.snapshot.environments.first { $0.id == environmentID }
    }

    private var environmentName: String {
        if let selectedEnvironment { return selectedEnvironment.name }
        return model.snapshot.connection.environmentName ?? "this server"
    }

    private var environmentStatus: String? {
        guard let selectedEnvironment else { return nil }
        return environmentStatus(selectedEnvironment)
    }

    private var environmentAccessibilityValue: String {
        guard let environmentStatus else { return environmentName }
        return "\(environmentName), \(environmentStatus)"
    }

    private func environmentLabel(_ environment: FeatureEnvironment) -> String {
        guard let status = environmentStatus(environment) else { return environment.name }
        return "\(environment.name) · \(status)"
    }

    private func environmentStatus(_ environment: FeatureEnvironment) -> String? {
        guard environment.isEnabled else { return "Off" }
        switch environment.connectionState {
        case .disconnected: return "Offline"
        case .connecting: return "Connecting"
        case .reconnecting: return "Reconnecting"
        case .connected, .none: return nil
        }
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

    private func refreshSelectedEnvironmentModels() async throws {
        guard let environmentID = selectedProject?.environmentID else { return }
        guard await model.refreshProviders(environmentID: environmentID) else {
            throw FeatureModelRefreshError()
        }
    }

    private var selectionBinding: Binding<FeatureSelection?> {
        Binding(
            get: { selection },
            set: { value in
                let materializesProjectDefault = !selectionIsExplicit
                    && value == initialSelection
                selection = value
                guard !materializesProjectDefault else { return }
                selectionIsExplicit = true
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
            slashCommands: provider?.workspaceCatalog(cwd: project.path).slashCommands ?? [],
            skills: provider?.workspaceCatalog(cwd: project.path).skills ?? [],
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
        !isSubmitting && submissionValidationMessage == nil
    }

    private var submissionValidationMessage: String? {
        guard selectedProject != nil else { return "Choose a project." }
        if let selectedEnvironment {
            guard selectedEnvironment.isEnabled else { return "Environment is off." }
        }
        guard restoredDraftProjectID == projectID else { return "Project is loading." }
        guard concreteSelection != nil else {
            guard !creationProviders.isEmpty else { return "No providers available." }
            guard creationProviders.contains(where: \.isAvailable) else {
                return "No providers are online."
            }
            guard creationProviders.contains(where: { $0.isAvailable && !$0.models.isEmpty })
            else {
                return "No models available."
            }
            return "Choose a model."
        }
        guard !trimmedPrompt.isEmpty || !attachments.isEmpty else {
            return "Add a message or image."
        }
        guard attachments.isEmpty || imagesAllowed else {
            return "This model does not support images."
        }
        guard workspaceMode != .worktree || selectedBranch != nil else {
            if branchesLoading { return "Branches are loading." }
            return branchLoadFailed ? "Could not load branches." : "Choose a base branch."
        }
        return nil
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
        guard creationProviders.contains(where: { $0.isAvailable && !$0.models.isEmpty }) else {
            return nil
        }
        return ProviderModelSelectionResolver.materialized(selection, in: creationProviders)
    }

    private func presentPicker(_ picker: NewTaskPicker) {
        restoresPromptAfterPickerDismissal = promptFocused
        promptFocused = false
        activePicker = picker
    }

    private func startTask() {
        guard !isSubmitting else { return }
        guard canSubmit,
              let project = selectedProject,
              let concreteSelection else {
            submissionValidationError = submissionValidationMessage
            if submissionValidationError == "Choose a base branch."
                || submissionValidationError == "Could not load branches." {
                presentPicker(.branch)
            }
            return
        }
        submissionValidationError = nil
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
            attachments: model.attachmentUploads.attachmentsForSend(
                draftKey: draftKey ?? FeatureComposerDraftStore.newTaskKey(project: project),
                environmentID: project.environmentID,
                attachments: attachments
            )
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
                persistCurrentDraftImmediately()
                submissionFailed = true
            }
        }
    }

    @discardableResult
    private func selectProject(_ id: String) -> Bool {
        guard creationProjects.contains(where: { $0.id == id }) else { return false }
        projectSelectionIsExplicit = true
        isAwaitingRecentProject = false
        guard id != projectID else { return true }
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
        projectSelectionIsExplicit = true
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

    private func refreshAutomaticProjectIfNeeded() {
        guard isAwaitingRecentProject else { return }
        let nextProjectID = DailyUXCreationContext.recentProjects(
            in: model.snapshot
        ).first?.project.id
        guard let nextProjectID else { return }
        if nextProjectID == projectID {
            isAwaitingRecentProject = false
            return
        }
        let draftRestoreIsComplete = restoredDraftProjectID == projectID
        guard DailyUXCreationContext.shouldAdoptAutomaticProject(
            currentProjectID: projectID,
            nextRecentProjectID: nextProjectID,
            isAwaitingRecentActivity: isAwaitingRecentProject,
            projectSelectionIsExplicit: projectSelectionIsExplicit,
            modelSelectionIsExplicit: selectionIsExplicit,
            workspaceSelectionIsExplicit: workspaceSelectionIsExplicit,
            hasDraftContent: !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !attachments.isEmpty,
            draftRestoreIsComplete: draftRestoreIsComplete
        ) else {
            if draftRestoreIsComplete {
                isAwaitingRecentProject = false
            }
            return
        }
        isAwaitingRecentProject = false
        selectInitialProject(nextProjectID)
    }

    private func prepareProjectIfNeeded(_ id: String) {
        guard draftRestoreContext?.projectID != id else { return }

        if selectionIsExplicit, let selection {
            preferredSelection = selection
        }

        restoredDraftProjectID = nil
        draftSaveError = nil
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
        } else if saved != nil {
            model.attachmentUploads.syncOwner(
                draftKey: key,
                environmentID: project.environmentID,
                attachments: restored.attachments
            )
        }
        refreshAutomaticProjectIfNeeded()
        guard projectID == requestedProjectID else { return }
        await loadBranches()
    }

    private var currentDraftKey: String? {
        guard let project = selectedProject else { return nil }
        return draftKey(for: project)
    }

    private var attachmentBinding: Binding<[FeatureDraftAttachment]> {
        Binding(
            get: { attachments },
            set: { value in
                attachments = value
                if restoredDraftProjectID == projectID {
                    persistCurrentDraftImmediately()
                }
            }
        )
    }

    private func draftKey(for project: FeatureProject) -> String {
        FeatureComposerDraftStore.newTaskKey(project: project, in: model.snapshot)
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
        let environmentID = selectedProject?.environmentID
        let immediateSave = immediateDraftSaveTasks[key]
        draftSaveTask = Task {
            await NewTaskDraftWriteFence.wait(pendingDraftSaveTask)
            await NewTaskDraftWriteFence.wait(immediateSave)
            do {
                try await Task.sleep(for: .milliseconds(220))
                try Task.checkCancellation()
                try await draftStore.setDraft(snapshot, for: key)
                guard !Task.isCancelled else { return }
                if currentDraftKey == key { draftSaveError = nil }
                if let environmentID {
                    model.attachmentUploads.syncOwner(
                        draftKey: key,
                        environmentID: environmentID,
                        attachments: snapshot.attachments
                    )
                }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, currentDraftKey == key else { return }
                draftSaveError = "Could not save draft. \(error.localizedDescription)"
            }
        }
    }

    private func persistCurrentDraftImmediately() {
        guard !submittedSuccessfully, !isSubmitting,
              let key = currentDraftKey else {
            return
        }
        let pendingDraftSaveTask = draftSaveTask
        pendingDraftSaveTask?.cancel()
        draftSaveTask = nil
        let snapshot = composerDraft
        let restoreContext = draftRestoreContext
        let draftProjectID = projectID
        let environmentID = selectedProject?.environmentID
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
                do {
                    try await draftStore.setDraft(merged, for: key)
                    guard !Task.isCancelled else { return }
                    if currentDraftKey == key { draftSaveError = nil }
                    if let environmentID {
                        model.attachmentUploads.syncOwner(
                            draftKey: key,
                            environmentID: environmentID,
                            attachments: merged.attachments
                        )
                    }
                } catch {
                    guard !Task.isCancelled, currentDraftKey == key else { return }
                    draftSaveError = "Could not save draft. \(error.localizedDescription)"
                }
            } else {
                do {
                    try await draftStore.setDraft(snapshot, for: key)
                    guard !Task.isCancelled else { return }
                    if currentDraftKey == key { draftSaveError = nil }
                    if let environmentID {
                        model.attachmentUploads.syncOwner(
                            draftKey: key,
                            environmentID: environmentID,
                            attachments: snapshot.attachments
                        )
                    }
                } catch {
                    guard !Task.isCancelled, currentDraftKey == key else { return }
                    draftSaveError = "Could not save draft. \(error.localizedDescription)"
                }
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

enum NewThreadComposerLayout {
    /// The full prompt is useful before editing starts. Once a draft needs
    /// room, a compact row keeps the project and environment visible while the
    /// editor uses the rest of the hero's space.
    static func usesCompactContext(
        prompt: String,
        isFocused: Bool,
        hasAttachments: Bool
    ) -> Bool {
        !prompt.isEmpty || isFocused || hasAttachments
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

enum NewTaskProjectPickerSearch {
    static func matching(
        _ groups: [DailyUXProjectGroup],
        query: String,
        environments: [FeatureEnvironment]
    ) -> [DailyUXProjectGroup] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return groups }

        let environmentNames = Dictionary(
            environments.map { ($0.id, $0.name) },
            uniquingKeysWith: { first, _ in first }
        )

        return groups.filter { group in
            group.name.localizedCaseInsensitiveContains(query)
                || group.projects.contains { project in
                    project.path.localizedCaseInsensitiveContains(query)
                        || environmentNames[project.environmentID]?
                            .localizedCaseInsensitiveContains(query) == true
                }
        }
    }
}

private struct NewTaskProjectPicker: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let groups: [DailyUXProjectGroup]
    let environments: [FeatureEnvironment]
    let recentGroupIDs: [String]
    let selectionID: String?
    let onSelect: (DailyUXProjectGroup) -> Void

    @State private var query = ""

    var body: some View {
        NavigationStack {
            Group {
                if groups.isEmpty {
                    ContentUnavailableView(
                        "No projects",
                        systemImage: "folder"
                    )
                } else if filteredGroups.isEmpty {
                    ContentUnavailableView(
                        "No matching projects",
                        systemImage: "magnifyingglass"
                    )
                } else {
                    let sections = DailyUXProjectPickerSections(
                        groups: filteredGroups,
                        recentGroupIDs: recentGroupIDs
                    )
                    List {
                        if sections.recents.isEmpty {
                            ForEach(sections.others) { group in
                                projectRow(group)
                            }
                        } else {
                            Section("Recent") {
                                ForEach(sections.recents) { group in
                                    projectRow(group)
                                }
                            }

                            if !sections.others.isEmpty {
                                Section("Other projects") {
                                    ForEach(sections.others) { group in
                                        projectRow(group)
                                    }
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .scrollDismissesKeyboard(.interactively)
                }
            }
            .background(T3Colors.background)
            .navigationTitle("Project")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Search projects")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(T3Colors.background)
    }

    private func projectRow(_ group: DailyUXProjectGroup) -> some View {
        Button {
            onSelect(group)
        } label: {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(group.name)
                        .foregroundStyle(T3Colors.textPrimary)

                    Text(projectLocation(group))
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }

                Spacer(minLength: 10)

                if group.id == selectionID {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(T3Colors.accent)
                }
            }
            .frame(minHeight: 46)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(group.name)
        .accessibilityValue(projectLocation(group))
        .accessibilityAddTraits(
            group.id == selectionID ? .isSelected : []
        )
        .listRowBackground(T3Colors.background)
    }

    private var filteredGroups: [DailyUXProjectGroup] {
        NewTaskProjectPickerSearch.matching(
            groups,
            query: query,
            environments: environments
        )
    }

    private func projectLocation(_ group: DailyUXProjectGroup) -> String {
        guard let firstProject = group.projects.first else { return "" }

        var seenEnvironmentIDs = Set<String>()
        let allNames = group.projects.compactMap { project -> String? in
            guard seenEnvironmentIDs.insert(project.environmentID).inserted else { return nil }
            return environments.first { $0.id == project.environmentID }?.name
                ?? project.environmentID
        }
        let names = Array(allNames.prefix(2))
        let additionalCount = allNames.count - names.count
        let additionalLocations = additionalCount > 0 ? " +\(additionalCount)" : ""

        return "\(names.joined(separator: ", "))\(additionalLocations) · \(firstProject.path)"
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
                            loadFailed
                                ? "Could not load branches"
                                : query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                    ? "No branches available"
                                    : "No matching branches",
                            systemImage: loadFailed
                                ? "exclamationmark.triangle"
                                : "arrow.triangle.branch"
                        )
                    } description: {
                        EmptyView()
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
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(
                            branch.badge.map { "\(branch.name), \($0)" } ?? branch.name
                        )
                        .accessibilityAddTraits(
                            branch.id == selection?.id ? .isSelected : []
                        )
                        .listRowBackground(T3Colors.background)
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .scrollDismissesKeyboard(.interactively)
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
