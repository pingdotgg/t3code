import SwiftUI

public struct AddProjectView: View {
    private struct PendingCloneRegistration: Equatable {
        let environmentID: String
        let remoteURL: String
        let destinationPath: String
        let clonedPath: String
    }

    private enum ProjectMode: String, CaseIterable, Identifiable {
        case newProject
        case folder
        case repository

        var id: String { rawValue }
        var label: String { switch self { case .newProject: "New"; case .folder: "Folder"; case .repository: "Clone" } }
        var icon: String { switch self { case .newProject: "plus"; case .folder: "folder"; case .repository: "arrow.down.circle" } }
    }

    private enum Field: Hashable {
        case localPath
        case repository
        case destination
    }

    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    private let onNewProjectCreated: @MainActor (String, FeatureProjectCloneIdentity?) -> Void

    @State private var selectedEnvironmentID: String?
    @State private var mode = ProjectMode.newProject
    @State private var newProjectName = ""
    @State private var publishesToGitHub = false
    @State private var createdNewProject: ProjectCreateNewResult?
    @State private var localPath = "~/"
    @State private var source = ProjectRemoteSource.url
    @State private var repositoryInput = ""
    @State private var destinationPath = "~/"
    @State private var resolvedRepository: SourceControlRepositoryInfo?
    @State private var didEditDestination = false
    @State private var pendingCloneRegistration: PendingCloneRegistration?
    @State private var pendingManagedClone: FeaturePendingManagedProjectClone?
    @State private var cloneController = FeatureProjectCloneController()
    @State private var cloneSubscriptionRevision = 0

    @State private var browsePath = "~/"
    @State private var browseResult: FilesystemBrowseResult?
    @State private var isBrowsing = false
    @State private var browseError: String?
    @State private var browseRequestID: UUID?

    @State private var discovery: SourceControlDiscoveryResult?
    @State private var isDiscovering = false
    @State private var discoveryError: String?
    @State private var discoveryRequestID: UUID?

    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var cloneRequestID: UUID?
    @FocusState private var focusedField: Field?

    public init(model: FeatureRootModel, onNewProjectCreated: @escaping @MainActor (String, FeatureProjectCloneIdentity?) -> Void = { _, _ in }) {
        self.model = model
        self.onNewProjectCreated = onNewProjectCreated
    }

    public var body: some View {
        NavigationStack {
            Group {
                if let environment = selectedEnvironment {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 22) {
                            if environments.count > 1 {
                                environmentPicker(environment).disabled(createdNewProject != nil)
                            }
                            if createdNewProject == nil { modePicker }
                            if let errorMessage {
                                errorBanner(errorMessage)
                            }
                            if let cloneClient = model.client as? any FeatureManagedProjectCloning {
                                ForEach(cloneController.clones.filter { $0.environmentID == environment.id && $0.snapshot.phase != .done }) { clone in
                                    FeatureProjectCloneStatusView(clone: clone, controller: cloneController, client: cloneClient) {
                                        if pendingManagedClone?.input.projectId == clone.snapshot.projectId {
                                            pendingManagedClone = nil
                                        }
                                    }
                                }
                                if cloneController.errorMessage != nil {
                                    Button("Refresh clone progress") { cloneSubscriptionRevision += 1 }
                                }
                            }
                            switch mode {
                            case .newProject:
                                newProjectForm(environment)
                            case .folder:
                                localProjectForm(environment)
                            case .repository:
                                repositoryProjectForm(environment)
                            }
                            if showsFolderBrowser {
                                folderBrowser(environment)
                            }
                        }
                        .padding(.horizontal, 18)
                        .padding(.top, 14)
                        .padding(.bottom, 32)
                        .disabled(isSubmitting)
                    }
                    .scrollDismissesKeyboard(.interactively)
                } else {
                    ContentUnavailableView(
                        "Environment unavailable",
                        systemImage: "server.rack",
                        description: Text("Reconnect a T3 environment before adding a project.")
                    )
                }
            }
            .background(T3Colors.background)
            .navigationTitle("Add project")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .onAppear(perform: selectEnvironmentIfNeeded)
        .onChange(of: model.snapshot.environments) {
            selectEnvironmentIfNeeded()
        }
        .onChange(of: source) {
            resolvedRepository = nil
            pendingCloneRegistration = nil
            pendingManagedClone = nil
            cloneRequestID = nil
            updateSuggestedDestination()
            errorMessage = nil
        }
        .onChange(of: repositoryInput) {
            resolvedRepository = nil
            pendingCloneRegistration = nil
            pendingManagedClone = nil
            cloneRequestID = nil
            updateSuggestedDestination()
            errorMessage = nil
        }
        .task(id: selectedEnvironmentID) {
            guard selectedEnvironmentID != nil else { return }
            resetEnvironmentState()
            await loadDirectory(browsePath, updateSelection: false)
            await loadDiscovery()
        }
        .task(id: "\(selectedEnvironmentID ?? ""): \(cloneSubscriptionRevision)") {
            guard let environmentID = selectedEnvironmentID else { return }
            await cloneController.observe(environmentID: environmentID, client: model.client as? any FeatureManagedProjectCloning)
        }
    }

    private var projectClient: (any FeatureProjectCreationClient)? {
        model.client as? any FeatureProjectCreationClient
    }

    private var environments: [FeatureEnvironment] {
        model.snapshot.environments
            .filter { $0.isEnabled && $0.connectionState == .connected }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private var selectedEnvironment: FeatureEnvironment? {
        environments.first { $0.id == selectedEnvironmentID && canCreateProject(in: $0) }
    }

    private var sourceOptions: [ProjectRemoteSourceOption] {
        ProjectRemoteSourceOptions.options(discovery: discovery)
    }

    private var selectedSourceOption: ProjectRemoteSourceOption? {
        sourceOptions.first { $0.source == source }
    }

    private var needsRepositoryLookup: Bool {
        source.provider != nil && resolvedRepository == nil
    }

    private var showsFolderBrowser: Bool {
        mode != .newProject && (mode == .folder || !needsRepositoryLookup)
    }

    private var repositoryName: String {
        ProjectCreationPath.repositoryName(
            from: resolvedRepository?.nameWithOwner ?? repositoryInput
        )
    }

    private var modePicker: some View {
        HStack(spacing: 24) {
            ForEach(ProjectMode.allCases.filter { $0 != .newProject || selectedEnvironment?.newProjectsRoot != nil }) { candidate in
                Button {
                    focusedField = nil
                    errorMessage = nil
                    mode = candidate
                } label: {
                    VStack(spacing: 9) {
                        Label(candidate.label, systemImage: candidate.icon)
                            .font(T3Typography.control)
                            .foregroundStyle(
                                mode == candidate ? T3Colors.textPrimary : T3Colors.textTertiary
                            )
                        Rectangle()
                            .fill(mode == candidate ? T3Colors.textPrimary : Color.clear)
                            .frame(height: 2)
                    }
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func environmentPicker(_ environment: FeatureEnvironment) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("Environment")
            Menu {
                ForEach(environments) { option in
                    Button {
                        selectedEnvironmentID = option.id
                    } label: {
                        if option.id == environment.id {
                            Label(option.name, systemImage: "checkmark")
                        } else {
                            Text(option.name)
                        }
                    }
                    .disabled(!canCreateProject(in: option))
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: environment.systemImage)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(environment.name)
                            .font(T3Typography.control)
                            .foregroundStyle(T3Colors.textPrimary)
                        Text(environment.endpoint)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textTertiary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 12)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(T3Colors.textTertiary)
                }
                .padding(.horizontal, 13)
                .frame(minHeight: 52)
                .background(T3Colors.input, in: RoundedRectangle(cornerRadius: 12))
                .overlay {
                    RoundedRectangle(cornerRadius: 12).stroke(T3Colors.border, lineWidth: 1)
                }
            }
            .buttonStyle(.plain)
        }
    }

    private func localProjectForm(_ environment: FeatureEnvironment) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                sectionTitle("Workspace path")
                Spacer()
                Text("on \(environment.name)")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
            }
            pathField(
                placeholder: "~/projects/my-app",
                text: $localPath,
                field: .localPath,
                browseAction: {
                    Task {
                        await loadDirectory(
                            ProjectCreationPath.directoryBrowsePath(localPath),
                            updateSelection: false
                        )
                    }
                }
            )
            primaryAction(label: "Add project", icon: "plus") {
                await addLocalProject(environment)
            }
        }
    }

    private func repositoryProjectForm(_ environment: FeatureEnvironment) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    sectionTitle("Repository source")
                    if isDiscovering {
                        ProgressView().controlSize(.small)
                    }
                }
                sourcePicker
                if let discoveryError {
                    Label(discoveryError, systemImage: "info.circle")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                sectionTitle(source == .url ? "Remote URL" : "Repository")
                TextField(source.prompt, text: $repositoryInput)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(source == .url ? .URL : .default)
                    .submitLabel(needsRepositoryLookup ? .next : .done)
                    .focused($focusedField, equals: .repository)
                    .onSubmit {
                        Task {
                            if needsRepositoryLookup {
                                await resolveRepository(environment)
                            } else {
                                focusedField = .destination
                            }
                        }
                    }
                    .t3ProjectInput()
            }

            if let resolvedRepository {
                repositorySummary(resolvedRepository)
            }

            if needsRepositoryLookup {
                primaryAction(label: "Find repository", icon: "magnifyingglass") {
                    await resolveRepository(environment)
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        sectionTitle("Clone destination")
                        Spacer()
                        Text("on \(environment.name)")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textTertiary)
                    }
                    pathField(
                        placeholder: "~/projects/\(repositoryName)",
                        text: destinationBinding,
                        field: .destination,
                        browseAction: nil
                    )
                }
                primaryAction(label: acceptedManagedCloneResult == nil ? "Clone and add" : "Open project", icon: "arrow.down.circle") {
                    await cloneProject(environment)
                }
            }
        }
    }

    private var sourcePicker: some View {
        Menu {
            ForEach(sourceOptions) { option in
                Button {
                    source = option.source
                } label: {
                    if option.source == source {
                        Label(option.source.label, systemImage: "checkmark")
                    } else if let detail = option.detail {
                        Text("\(option.source.label) · \(detail)")
                    } else {
                        Text(option.source.label)
                    }
                }
                .disabled(!option.isReady)
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: sourceIcon(source))
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(source.label)
                        .font(T3Typography.control)
                        .foregroundStyle(T3Colors.textPrimary)
                    if let detail = selectedSourceOption?.detail {
                        Text(detail)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textTertiary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 12)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(T3Colors.textTertiary)
            }
            .padding(.horizontal, 13)
            .frame(minHeight: 52)
            .background(T3Colors.input, in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12).stroke(T3Colors.border, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
    }

    private func repositorySummary(_ repository: SourceControlRepositoryInfo) -> some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: sourceIcon(source))
                .font(.body.weight(.semibold))
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(repository.nameWithOwner)
                    .font(T3Typography.control)
                    .foregroundStyle(T3Colors.textPrimary)
                Text(repository.sshUrl)
                    .font(T3Typography.supporting.monospaced())
                    .foregroundStyle(T3Colors.textTertiary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(T3Colors.success)
        }
        .padding(.vertical, 4)
    }

    private func folderBrowser(_ environment: FeatureEnvironment) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                sectionTitle("Folders on \(environment.name)")
                Spacer()
                if isBrowsing {
                    ProgressView().controlSize(.small)
                } else {
                    Button {
                        Task { await loadDirectory(browsePath, updateSelection: false) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(T3Colors.textSecondary)
                    .accessibilityLabel("Refresh folders")
                }
            }

            Text(browsePath)
                .font(T3Typography.supporting.monospaced())
                .foregroundStyle(T3Colors.textTertiary)
                .lineLimit(1)
                .truncationMode(.middle)

            Divider().overlay(T3Colors.separator)
            if let browseError {
                Text(browseError)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.warning)
                    .padding(.vertical, 8)
            }
            if let parentPath = ProjectCreationPath.parentBrowsePath(of: browsePath) {
                folderRow(name: "..", icon: "arrow.turn.left.up") {
                    await loadDirectory(parentPath, updateSelection: true)
                }
            }
            if let entries = browseResult?.entries, !entries.isEmpty {
                ForEach(entries, id: \.fullPath) { entry in
                    Divider().overlay(T3Colors.separator)
                    folderRow(name: entry.name, icon: "folder") {
                        await loadDirectory(
                            ProjectCreationPath.directoryBrowsePath(entry.fullPath),
                            updateSelection: true
                        )
                    }
                }
            } else if !isBrowsing, browseError == nil {
                Text("No folders here")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .frame(maxWidth: .infinity, minHeight: 54, alignment: .center)
            }
        }
    }

    private func folderRow(
        name: String,
        icon: String,
        action: @escaping @MainActor () async -> Void
    ) -> some View {
        Button {
            focusedField = nil
            Task { await action() }
        } label: {
            HStack(spacing: 11) {
                Image(systemName: icon)
                    .font(.body.weight(.medium))
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(width: 24)
                Text(name)
                    .font(.body.weight(.medium))
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 12)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(T3Colors.textTertiary)
            }
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isBrowsing)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(T3Typography.supportingStrong)
            .foregroundStyle(T3Colors.textSecondary)
    }

    private func pathField(
        placeholder: String,
        text: Binding<String>,
        field: Field,
        browseAction: (() -> Void)?
    ) -> some View {
        HStack(spacing: 4) {
            TextField(placeholder, text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($focusedField, equals: field)
            if let browseAction {
                Button(action: browseAction) {
                    Image(systemName: "folder")
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .foregroundStyle(T3Colors.textSecondary)
                .accessibilityLabel("Browse entered path")
            }
        }
        .t3ProjectInput()
    }

    private func primaryAction(
        label: String,
        icon: String,
        action: @escaping @MainActor () async -> Void
    ) -> some View {
        Button {
            focusedField = nil
            Task { await action() }
        } label: {
            HStack(spacing: 8) {
                if isSubmitting {
                    ProgressView()
                        .tint(T3Colors.primaryActionForeground)
                } else {
                    Image(systemName: icon)
                }
                Text(isSubmitting ? "Working…" : label)
            }
            .font(.body.weight(.semibold))
            .foregroundStyle(T3Colors.primaryActionForeground)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(T3Colors.primaryAction, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(isSubmitting)
        .opacity(isSubmitting ? 0.66 : 1)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text(message)
                .font(T3Typography.supporting)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(T3Colors.danger)
        .padding(12)
        .background(T3Colors.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }

    private var destinationBinding: Binding<String> {
        Binding(
            get: { destinationPath },
            set: { value in
                didEditDestination = true
                destinationPath = value
                pendingCloneRegistration = nil
                pendingManagedClone = nil
                cloneRequestID = nil
            }
        )
    }

    private func canCreateProject(in environment: FeatureEnvironment) -> Bool {
        environment.isEnabled && environment.connectionState != .disconnected
    }

    private func selectEnvironmentIfNeeded() {
        // Keep an uncertain clone start on its original host through reconnects.
        if let pending = pendingManagedClone,
           selectedEnvironmentID == pending.environmentID,
           model.snapshot.environments.contains(where: { $0.id == pending.environmentID && $0.isEnabled }) {
            return
        }
        if let selectedEnvironmentID,
           environments.contains(where: {
               $0.id == selectedEnvironmentID && canCreateProject(in: $0)
           }) {
            return
        }
        selectedEnvironmentID = environments.first(where: canCreateProject)?.id
    }

    private func resetEnvironmentState() {
        if mode == .newProject && selectedEnvironment?.newProjectsRoot == nil { mode = .folder }
        publishesToGitHub = false
        browsePath = "~/"
        browseResult = nil
        browseError = nil
        browseRequestID = nil
        discovery = nil
        discoveryError = nil
        discoveryRequestID = nil
        source = .url
        resolvedRepository = nil
        pendingCloneRegistration = nil
        pendingManagedClone = nil
        cloneRequestID = nil
        didEditDestination = false
        localPath = "~/"
        destinationPath = repositoryInput.isEmpty
            ? "~/"
            : ProjectCreationPath.appending(repositoryName, to: "~/")
        errorMessage = nil
    }

    private func loadDiscovery() async {
        guard let environmentID = selectedEnvironmentID,
              let projectClient else {
            discoveryError = "Git URL cloning is available. Provider discovery is unavailable."
            return
        }
        let requestID = UUID()
        discoveryRequestID = requestID
        isDiscovering = true
        defer {
            if discoveryRequestID == requestID {
                isDiscovering = false
            }
        }
        do {
            let result = try await projectClient.discoverProjectSources(
                environmentID: environmentID
            )
            guard discoveryRequestID == requestID,
                  selectedEnvironmentID == environmentID else {
                return
            }
            discovery = result
            discoveryError = nil
        } catch is CancellationError {
            return
        } catch {
            guard discoveryRequestID == requestID,
                  selectedEnvironmentID == environmentID else {
                return
            }
            discovery = nil
            discoveryError = "Provider discovery unavailable. Git URL still works."
        }
    }

    private func loadDirectory(_ path: String, updateSelection: Bool) async {
        guard let environmentID = selectedEnvironmentID,
              let projectClient else {
            browseError = "Folder browsing is unavailable. You can still enter a path directly."
            return
        }
        let requestedPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !requestedPath.isEmpty else { return }
        let requestID = UUID()
        browseRequestID = requestID
        isBrowsing = true
        browseError = nil
        defer {
            if browseRequestID == requestID {
                isBrowsing = false
            }
        }
        do {
            let result = try await projectClient.browseProjectFolders(
                environmentID: environmentID,
                partialPath: requestedPath
            )
            guard browseRequestID == requestID,
                  selectedEnvironmentID == environmentID else {
                return
            }
            let selectedDirectory = result.parentPath
            browsePath = ProjectCreationPath.directoryBrowsePath(selectedDirectory)
            browseResult = result
            if updateSelection {
                switch mode {
                case .newProject: break
                case .folder:
                    localPath = selectedDirectory
                case .repository:
                    if !didEditDestination {
                        pendingCloneRegistration = nil
                        destinationPath = ProjectCreationPath.appending(
                            repositoryName,
                            to: selectedDirectory
                        )
                    }
                }
            }
        } catch is CancellationError {
            return
        } catch {
            guard browseRequestID == requestID,
                  selectedEnvironmentID == environmentID else {
                return
            }
            browseError = "Couldn’t browse that folder. Direct path entry still works."
        }
    }

    private func newProjectForm(_ environment: FeatureEnvironment) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if let createdNewProject {
                Text("Created \(createdNewProject.workspaceRoot)")
                    .font(T3Typography.supporting).textSelection(.enabled)
                Button("Done") { dismiss() }.buttonStyle(.borderedProminent)
            } else {
                TextField("Project name", text: $newProjectName)
                    .t3ProjectInput()
                    .accessibilityIdentifier("new-project-name")
                if let root = environment.newProjectsRoot {
                    Text("Creates \(ProjectCreationPath.appending(ProjectCreationPath.newProjectFolderName(newProjectName), to: root))")
                        .font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                }
                if sourceOptions.first(where: { $0.source == .github })?.isReady == true {
                    Toggle("Create private repository on GitHub", isOn: $publishesToGitHub)
                }
                primaryAction(label: "Create project", icon: "plus") {
                    await createNewProject(environment)
                }
                .disabled(newProjectName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || newProjectName.utf16.count > 200)
            }
        }
    }

    private func createNewProject(_ environment: FeatureEnvironment) async {
        guard !isSubmitting, createdNewProject == nil, let projectClient else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            let result = try await projectClient.createNewProject(environmentID: environment.id,
                name: newProjectName.trimmingCharacters(in: .whitespacesAndNewlines))
            createdNewProject = result
            if let commitError = result.commitError {
                errorMessage = "The project was created without a first commit. \(commitError)"
                return
            }
            if publishesToGitHub, sourceOptions.first(where: { $0.source == .github })?.isReady == true {
                let account = discovery?.sourceControlProviders.first { $0.kind == .github }?.auth.account
                let folder = ProjectCreationPath.lastPathComponent(result.workspaceRoot)
                let repository = account.map { "\($0)/\(folder)" } ?? folder
                try await projectClient.publishNewProject(environmentID: environment.id,
                    cwd: result.workspaceRoot, repository: repository)
            }
            await model.reloadAfterConnection()
            let id = FeatureScopedID.project(environmentID: environment.id, wireID: result.projectId)
            guard model.snapshot.projects.contains(where: { $0.id == id }) else {
                errorMessage = "The project was created. It will appear when this connection catches up."
                return
            }
            onNewProjectCreated(id, nil)
            dismiss()
        } catch {
            errorMessage = createdNewProject == nil
                ? "Could not confirm project creation. Check the project list before trying again."
                : "The local project was created, but GitHub publishing failed. You can publish it later."
        }
    }

    private func addLocalProject(_ environment: FeatureEnvironment) async {
        errorMessage = nil
        let validated: String
        switch ProjectCreationPath.validated(localPath) {
        case let .success(path): validated = path
        case let .failure(error):
            errorMessage = error.localizedDescription
            return
        }
        if let serverPath = browseResult?.parentPath,
           !ProjectCreationPath.isCompatibleWithServerPath(
               validated,
               serverPath: serverPath
           ) {
            errorMessage = "Use a path that matches \(environment.name)’s filesystem."
            return
        }
        if let existing = existingProject(environmentID: environment.id, path: validated) {
            errorMessage = "\(existing.name) already uses this folder."
            return
        }

        isSubmitting = true
        defer { isSubmitting = false }
        do {
            if let projectClient {
                try await projectClient.addProject(
                    environmentID: environment.id,
                    path: validated
                )
                dismiss()
            } else if environments.count == 1, await model.addProject(path: validated) {
                dismiss()
            } else {
                errorMessage = model.errorMessage ?? "The project could not be added."
            }
        } catch is CancellationError {
            return
        } catch {
            errorMessage = projectErrorMessage(error)
        }
    }

    private func resolveRepository(_ environment: FeatureEnvironment) async {
        guard let provider = source.provider else { return }
        let repository = repositoryInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !repository.isEmpty else {
            errorMessage = "Enter a repository name."
            return
        }
        guard let projectClient else {
            errorMessage = "Repository lookup is unavailable on this connection."
            return
        }

        errorMessage = nil
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            let result = try await projectClient.lookupProjectRepository(
                environmentID: environment.id,
                provider: provider,
                repository: repository
            )
            guard selectedEnvironmentID == environment.id,
                  source.provider == provider,
                  repositoryInput.trimmingCharacters(in: .whitespacesAndNewlines)
                    == repository else {
                return
            }
            resolvedRepository = result
            updateSuggestedDestination()
            focusedField = .destination
        } catch is CancellationError {
            return
        } catch {
            guard selectedEnvironmentID == environment.id,
                  source.provider == provider,
                  repositoryInput.trimmingCharacters(in: .whitespacesAndNewlines)
                    == repository else {
                return
            }
            errorMessage = projectErrorMessage(error)
        }
    }

    private func cloneProject(_ environment: FeatureEnvironment) async {
        guard !isSubmitting else { return }
        let remoteURL = resolvedRepository.map(ProjectCreationPath.defaultCloneURL)
            ?? ProjectCreationPath.normalizedCloneURL(repositoryInput)
        guard !remoteURL.isEmpty else {
            errorMessage = "Enter a Git remote URL."
            return
        }
        let validatedDestination: String
        switch ProjectCreationPath.validated(destinationPath) {
        case let .success(path): validatedDestination = path
        case let .failure(error):
            errorMessage = error.localizedDescription
            return
        }
        if let serverPath = browseResult?.parentPath,
           !ProjectCreationPath.isCompatibleWithServerPath(
               validatedDestination,
               serverPath: serverPath
           ) {
            errorMessage = "Use a path that matches \(environment.name)’s filesystem."
            return
        }
        let currentManagedClone = pendingManagedClone.flatMap { pending in
            pending.environmentID == environment.id && pending.input.remoteUrl == remoteURL
                && pending.input.destinationPath == validatedDestination ? pending : nil
        }
        let acceptedResult = currentManagedClone?.acceptedResult(clones: cloneController.clones, projects: model.snapshot.projects)
        if acceptedResult == nil, let existing = existingProject(
            environmentID: environment.id,
            path: validatedDestination
        ) {
            errorMessage = "\(existing.name) already uses this destination."
            return
        }
        guard let projectClient else {
            errorMessage = "Repository cloning is unavailable on this connection."
            return
        }

        errorMessage = nil
        let requestID = UUID()
        cloneRequestID = requestID
        isSubmitting = true
        defer {
            isSubmitting = false
            if cloneRequestID == requestID {
                cloneRequestID = nil
            }
        }
        do {
            if let result = acceptedResult {
                pendingManagedClone?.result = result
                await openManagedClone(result, requestID: requestID, environmentID: environment.id,
                    remoteURL: remoteURL, destinationPath: validatedDestination)
                return
            }
            if let cloneClient = model.client as? any FeatureManagedProjectCloning,
               try await cloneClient.supportsManagedProjectClones(environmentID: environment.id) {
                let pending = currentManagedClone
                    ?? FeaturePendingManagedProjectClone(environmentID: environment.id, input: ProjectCloneStartInput(
                        projectId: UUID().uuidString,
                        title: ProjectCreationPath.lastPathComponent(validatedDestination),
                        createdAt: Date().formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)),
                        remoteUrl: remoteURL, destinationPath: validatedDestination
                    ))
                pendingManagedClone = pending
                let result = try await cloneClient.startManagedProjectClone(environmentID: environment.id, input: pending.input)
                guard cloneRequestIsCurrent(requestID, environmentID: environment.id, remoteURL: remoteURL, destinationPath: validatedDestination) else { return }
                pendingManagedClone?.result = result
                await openManagedClone(result, requestID: requestID, environmentID: environment.id,
                    remoteURL: remoteURL, destinationPath: validatedDestination)
                return
            }
            let clonedPath: String
            if let pending = pendingCloneRegistration,
               pending.environmentID == environment.id,
               pending.remoteURL == remoteURL,
               pending.destinationPath == validatedDestination {
                clonedPath = pending.clonedPath
            } else {
                let result = try await projectClient.cloneProjectRepository(
                    environmentID: environment.id,
                    remoteURL: remoteURL,
                    destinationPath: validatedDestination
                )
                guard cloneRequestIsCurrent(
                    requestID,
                    environmentID: environment.id,
                    remoteURL: remoteURL,
                    destinationPath: validatedDestination
                ) else {
                    return
                }
                clonedPath = result.cwd
                pendingCloneRegistration = PendingCloneRegistration(
                    environmentID: environment.id,
                    remoteURL: remoteURL,
                    destinationPath: validatedDestination,
                    clonedPath: result.cwd
                )
            }
            guard cloneRequestIsCurrent(
                requestID,
                environmentID: environment.id,
                remoteURL: remoteURL,
                destinationPath: validatedDestination
            ) else {
                return
            }
            try await projectClient.addProject(
                environmentID: environment.id,
                path: clonedPath
            )
            guard cloneRequestIsCurrent(
                requestID,
                environmentID: environment.id,
                remoteURL: remoteURL,
                destinationPath: validatedDestination
            ) else {
                return
            }
            pendingCloneRegistration = nil
            dismiss()
        } catch is CancellationError {
            return
        } catch {
            guard cloneRequestIsCurrent(
                requestID,
                environmentID: environment.id,
                remoteURL: remoteURL,
                destinationPath: validatedDestination
            ) else {
                return
            }
            if let result = acceptedManagedCloneResult {
                pendingManagedClone?.result = result
                await openManagedClone(result, requestID: requestID, environmentID: environment.id,
                    remoteURL: remoteURL, destinationPath: validatedDestination)
            } else if pendingCloneRegistration != nil {
                errorMessage = "Repository cloned. Try again to finish adding the project."
            } else {
                errorMessage = projectErrorMessage(error)
            }
        }
    }

    private var acceptedManagedCloneResult: ProjectCloneStartResult? {
        guard let pending = pendingManagedClone,
              pending.environmentID == selectedEnvironmentID,
              pending.input.remoteUrl == (resolvedRepository.map(ProjectCreationPath.defaultCloneURL)
                ?? ProjectCreationPath.normalizedCloneURL(repositoryInput)),
              pending.input.destinationPath == destinationPath.trimmingCharacters(in: .whitespacesAndNewlines)
        else { return nil }
        return pending.acceptedResult(clones: cloneController.clones, projects: model.snapshot.projects)
    }

    private func openManagedClone(
        _ result: ProjectCloneStartResult, requestID: UUID, environmentID: String,
        remoteURL: String, destinationPath: String
    ) async {
        await model.reloadAfterConnection()
        guard cloneRequestIsCurrent(requestID, environmentID: environmentID,
            remoteURL: remoteURL, destinationPath: destinationPath) else { return }
        let projectID = FeatureScopedID.project(environmentID: environmentID, wireID: result.projectId)
        guard model.snapshot.projects.contains(where: { $0.id == projectID }) else {
            errorMessage = "The clone has started. Open the project when this connection catches up."
            return
        }
        onNewProjectCreated(projectID, FeatureProjectCloneIdentity(environmentID: environmentID, projectID: result.projectId))
        dismiss()
    }

    private func cloneRequestIsCurrent(
        _ requestID: UUID,
        environmentID: String,
        remoteURL: String,
        destinationPath: String
    ) -> Bool {
        let currentRemoteURL = resolvedRepository.map(ProjectCreationPath.defaultCloneURL)
            ?? ProjectCreationPath.normalizedCloneURL(repositoryInput)
        return cloneRequestID == requestID
            && selectedEnvironmentID == environmentID
            && currentRemoteURL == remoteURL
            && self.destinationPath.trimmingCharacters(in: .whitespacesAndNewlines)
                == destinationPath
    }

    private func updateSuggestedDestination() {
        guard !didEditDestination, !repositoryInput.isEmpty else { return }
        destinationPath = ProjectCreationPath.appending(repositoryName, to: browsePath)
    }

    private func existingProject(environmentID: String, path: String) -> FeatureProject? {
        let normalized = ProjectCreationPath.normalizedForComparison(path)
        return model.snapshot.projects.first {
            $0.environmentID == environmentID
                && ProjectCreationPath.normalizedForComparison($0.path) == normalized
        }
    }

    private func sourceIcon(_ source: ProjectRemoteSource) -> String {
        switch source {
        case .url: "link"
        case .github: "chevron.left.forwardslash.chevron.right"
        case .forgejo: "arrow.triangle.branch"
        case .gitlab: "shippingbox"
        case .bitbucket: "shippingbox.fill"
        case .azureDevOps: "point.3.connected.trianglepath.dotted"
        }
    }

    private func projectErrorMessage(_ error: Error) -> String {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? "The server could not complete that request." : message
    }
}

private extension View {
    func t3ProjectInput() -> some View {
        font(.body)
            .foregroundStyle(T3Colors.textPrimary)
            .padding(.horizontal, 13)
            .frame(minHeight: 48)
            .background(T3Colors.input, in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12).stroke(T3Colors.border, lineWidth: 1)
            }
    }
}
