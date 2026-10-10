import SwiftUI
import UIKit

struct FeatureWorkspaceNavigationRequest: Equatable, Sendable {
    enum Destination: Equatable, Sendable {
        case thread(id: String)
        case threadDestination(id: String, destination: FeatureThreadDestination)
        case project(id: String)
        case newTask(projectID: String?)
        case usageLimits
    }

    let id: UUID
    let destination: Destination

    init(id: UUID = UUID(), destination: Destination) {
        self.id = id
        self.destination = destination
    }
}

public struct WorkspaceView: View {
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @Bindable var model: FeatureRootModel
    private let navigationRequest: FeatureWorkspaceNavigationRequest?
    private let onNavigationRequestConsumed: @MainActor (UUID) -> Void
    private let submitNewTask: (NewTaskRequest) async -> FeatureThread?
    private let submitMessage: (FeatureMessageSubmission) async -> Bool

    @State private var threadSelection = WorkspaceThreadSelection()
    @State private var requestedThreadDestination: FeatureThreadDestination?
    @State private var requestedThreadDestinationID: UUID?
    @State private var activeToolDestination: FeatureThreadDestination?
    @State private var selectedProjectID: String?
    @State private var searchText = ""
    @State private var isSearching = false
    @State private var contentSearch = FeatureThreadContentSearch()
    @State private var paletteSearch = FeatureThreadContentSearch()
    @State private var paletteQuery = ""
    @State private var keyboardDispatcher = FeatureKeyboardDispatcher()
    @State private var columnVisibility = NavigationSplitViewVisibility.automatic
    @AppStorage("t3.swiftui.home.snoozedExpanded") private var isSnoozedExpanded = false
    @AppStorage("t3.swiftui.home.workingExpanded") private var isWorkingExpanded = false
    @AppStorage("t3.swiftui.home.settledExpanded") private var isSettledExpanded = true
    @AppStorage("t3.swiftui.home.archiveExpanded") private var isArchiveExpanded = false
    @State private var settledLimit = 10
    private struct NewTaskPresentation: Identifiable {
        let id = UUID()
        let projectID: String?
        var managedClone: FeatureProjectCloneIdentity? = nil
        var sourceThread: FeatureThread? = nil
        var recoveryID: String? = nil
    }
    @State private var newTaskPresentation: NewTaskPresentation?
    @State private var pendingWorkspaceAction: (@MainActor () -> Void)?
    @State private var workspacePresentationIsVisible = false
    @State private var pendingNavigationRequest: FeatureWorkspaceNavigationRequest?
    @State private var consumedNavigationRequestID: UUID?
    @State private var rootNavigationDismissalID: UUID?
    @State private var showingAddProject = false
    @State private var createdProjectID: String?
    @State private var createdManagedClone: FeatureProjectCloneIdentity?
    @State private var showingEnvironments = false
    @State private var showingSettings = false
    @State private var settingsDestination: FeatureSettingsDestination?
    @State private var showingThreadArrangement = false
    @State private var settingsProject: FeatureProject?
    @State private var showingUsageLimits = false
    @State private var renamingThread: FeatureThread?
    @State private var deletingThread: FeatureThread?
    @State private var pendingDiscardRecoveryID: String?
    @State private var customSnoozeSelection: FeatureCustomSnoozeSelection?
    @State private var renameTitle = ""
    @State private var sidebarBoundaryNow = Date.now
    @State private var preferredCompactColumn = NavigationSplitViewColumn.sidebar
    @State private var homePresentationCache = HomePresentationCache()
    @FocusState private var isSearchFocused: Bool

    /// Both submit paths go through `FeatureRootModel`, which owns the outbox
    /// and optimistic rows. Views never call the client to send a turn.
    init(
        model: FeatureRootModel,
        navigationRequest: FeatureWorkspaceNavigationRequest? = nil,
        onNavigationRequestConsumed: @escaping @MainActor (UUID) -> Void = { _ in }
    ) {
        self.model = model
        self.navigationRequest = navigationRequest
        self.onNavigationRequestConsumed = onNavigationRequestConsumed
        self.submitNewTask = { request in await model.startTask(request) }
        self.submitMessage = { submission in await model.sendMessage(submission) }
    }

    public var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: $preferredCompactColumn) {
            sidebar
                .navigationSplitViewColumnWidth(
                    min: T3Metrics.minimumSidebarWidth,
                    ideal: T3Metrics.sidebarWidth,
                    max: T3Metrics.maximumSidebarWidth
                )
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.balanced)
        .safeAreaInset(edge: .top, spacing: 0) {
            PermissionUpdateNotice(environments: model.snapshot.environments.filter(\.isEnabled).map {
                PermissionNoticeEnvironment(id: $0.id, label: $0.name, permissions: $0.permissions)
            })
        }
        .sheet(item: $newTaskPresentation, onDismiss: finishWorkspaceDismissal) { presentation in
            NewThreadView(
                model: model,
                submit: submitNewTask,
                onCreated: { thread in
                    openThread(thread.id)
                    newTaskPresentation = nil
                },
                onCreateProject: openProjectCreation,
                beforeRootAction: dismissNewTaskBeforeRootAction,
                initialProjectID: presentation.projectID,
                initialManagedClone: presentation.managedClone,
                initialWorkspaceThread: presentation.sourceThread,
                initialRecoveryID: presentation.recoveryID
            )
            .onAppear { workspacePresentationIsVisible = true }
        }
        .sheet(item: $customSnoozeSelection, onDismiss: finishWorkspaceDismissal) { selection in
            FeatureCustomSnoozeSheet(selection: selection) { id, until in
                Task { await model.setSnoozed(id, until: until) }
            }
            .onAppear { workspacePresentationIsVisible = true }
        }
        .sheet(isPresented: $showingAddProject, onDismiss: {
            workspacePresentationIsVisible = false
            if pendingWorkspaceAction != nil {
                createdProjectID = nil
                createdManagedClone = nil
                finishWorkspaceDismissal()
                return
            }
            if let id = createdProjectID {
                createdProjectID = nil
                openNewTaskOrProjectCreation(initialProjectID: id, managedClone: createdManagedClone)
            }
            createdManagedClone = nil
        }) {
            AddProjectView(model: model, onNewProjectCreated: { projectID, clone in
                createdProjectID = projectID
                createdManagedClone = clone
            })
            .onAppear { workspacePresentationIsVisible = true }
        }
        .sheet(item: $settingsProject, onDismiss: finishWorkspaceDismissal) { project in
            ProjectPreferencesSheet(model: model, projectID: project.id)
                .onAppear { workspacePresentationIsVisible = true }
        }
        .sheet(isPresented: $showingEnvironments, onDismiss: finishWorkspaceDismissal) {
            NavigationStack {
                ConnectionsView(model: model)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showingEnvironments = false }
                        }
                    }
            }
            .presentationDragIndicator(.visible)
            .onAppear {
                workspacePresentationIsVisible = true
                model.setConnectionManagementPresented(true)
            }
            .onDisappear { model.setConnectionManagementPresented(false) }
        }
        .sheet(isPresented: $showingUsageLimits, onDismiss: finishWorkspaceDismissal) {
            NavigationStack {
                UsageView(client: model.client, initiallyShowsLimits: true)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Done") { showingUsageLimits = false }
                        }
                    }
            }
            .preferredColorScheme(.dark)
            .onAppear { workspacePresentationIsVisible = true }
        }
        .sheet(isPresented: $showingSettings, onDismiss: finishWorkspaceDismissal) {
            SettingsView(model: model, initialDestination: settingsDestination)
                .onAppear { workspacePresentationIsVisible = true }
        }
        .sheet(isPresented: $showingThreadArrangement, onDismiss: finishWorkspaceDismissal) {
            ThreadArrangementView(model: model)
                .onAppear { workspacePresentationIsVisible = true }
        }
        .alert(
            "Rename thread",
            isPresented: Binding(
                get: { renamingThread != nil },
                set: { if !$0 { renamingThread = nil } }
            )
        ) {
            TextField("Thread title", text: $renameTitle)
            Button("Cancel", role: .cancel) { renamingThread = nil }
            Button("Save") {
                guard let thread = renamingThread else { return }
                let title = renameTitle
                renamingThread = nil
                Task { await model.renameThread(thread.id, title: title) }
            }
            .disabled(renameTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .alert(
            "Delete thread?",
            isPresented: Binding(
                get: { deletingThread != nil },
                set: { if !$0 { deletingThread = nil } }
            ),
            presenting: deletingThread
        ) { thread in
            Button("Delete", role: .destructive) {
                deletingThread = nil
                Task { await model.deleteThread(thread.id) }
            }
            Button("Cancel", role: .cancel) { deletingThread = nil }
        } message: { thread in
            Text("\"\(thread.title)\" and its terminal history will be permanently deleted.")
        }
        .confirmationDialog("Delete unsent message?", isPresented: Binding(
            get: { pendingDiscardRecoveryID != nil },
            set: { if !$0 { pendingDiscardRecoveryID = nil } }
        ), titleVisibility: .visible, presenting: model.submissionRecoveryDrafts.first {
            $0.id == pendingDiscardRecoveryID
        }) { recovery in
            Button("Delete", role: .destructive) {
                pendingDiscardRecoveryID = nil
                Task { await model.discardSubmissionRecovery(id: recovery.id) }
            }
            Button("Cancel", role: .cancel) { pendingDiscardRecoveryID = nil }
        } message: { _ in
            Text("This message has not been sent. Its saved text and files will be removed.")
        }
        .onChange(of: selectedThreadIsAvailable) { _, isAvailable in
            if !isAvailable {
                closeSelectedThread()
                if let id = rootNavigationDismissalID { finishThreadNavigationDismissal(id) }
            }
        }
        .onChange(of: selectedThreadID) { _, newValue in
            preferredCompactColumn = newValue == nil ? .sidebar : .detail
        }
        .onChange(of: selectedProjectIsAvailable) { _, isAvailable in
            if !isAvailable { selectedProjectID = nil }
        }
        .onChange(of: navigationRequest?.id, initial: true) { _, _ in
            consumeNavigationRequest()
        }
        // A request that arrives before its thread or project exists in the
        // snapshot stays pending; retry it as data lands so cold-start deep
        // links are not silently stranded.
        .onChange(of: model.homePresentationRevision) { _, _ in
            if navigationRequest != nil { consumeNavigationRequest() }
        }
        .task(id: nextSidebarBoundary) {
            guard let boundary = nextSidebarBoundary else { return }
            do {
                try await Task.sleep(for: .seconds(max(0, boundary.timeIntervalSinceNow)))
                sidebarBoundaryNow = max(.now, boundary)
            } catch {
                return
            }
        }
        .task(id: paletteSearchRequest) {
            await paletteSearch.search(paletteSearchRequest, using: model.client as? any FeatureThreadContentSearching)
        }
        .featureKeyboardCommands(
            dispatcher: keyboardDispatcher,
            context: keyboardContext,
            paletteContent: { commandPaletteContent },
            onPaletteQueryChange: { paletteQuery = $0 },
            onCommand: handleKeyboardCommand
        )
        .task(id: contentSearchRequest) {
            await contentSearch.search(
                contentSearchRequest,
                using: model.client as? any FeatureThreadContentSearching
            )
        }
    }

    private var sidebar: some View {
        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                homeBar
                if !model.submissionRecoveryDrafts.isEmpty {
                    submissionRecoveryRows
                }
                if isSearching {
                    searchBar
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
                threadList
            }

            composeButton
                .padding(.trailing, 16)
                .padding(.bottom, 14)
        }
        .background(T3Colors.background)
        .toolbar(.hidden, for: .navigationBar)
        .onChange(of: selectedProjectID) {
            settledLimit = 10
        }
    }

    private var submissionRecoveryRows: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(model.submissionRecoveryDrafts) { recovery in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(recovery.reason ?? "This message was not sent.")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                            .lineLimit(2)
                        HStack(spacing: 20) {
                            Button(recovery.isNewTask ? "Edit task" : "Edit message") {
                            if recovery.isNewTask || !model.snapshot.threads.contains(where: { $0.id == recovery.threadID }) {
                                newTaskPresentation = NewTaskPresentation(projectID: recovery.projectID,
                                    recoveryID: recovery.id)
                            } else {
                                openThread(recovery.threadID)
                            }
                            }
                            Button("Discard", role: .destructive) {
                                pendingDiscardRecoveryID = recovery.id
                            }
                        }
                        .font(T3Typography.control)
                        .disabled(model.recoveringSubmissionIDs.contains(recovery.id))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 8)
        }
        .frame(maxHeight: 140)
    }

    private var homePresentation: HomePresentation {
        let searchRequest = contentSearchRequest
        return homePresentationCache.presentation(
            snapshot: model.snapshot,
            revision: model.homePresentationRevision,
            rowRevision: model.threadRowRevision,
            query: searchText,
            projectID: selectedProjectID,
            now: sidebarBoundaryNow,
            inboxReturns: model.inboxReturns,
            contentMatches: contentSearch.matches(for: searchRequest),
            searchEnvironmentIDs: searchRequest.environmentIDs
        )

    }

    private var threadList: some View {
        let searchRequest = contentSearchRequest
        let presentation = homePresentation
        return VStack(spacing: 0) {
            projectFilter
            if contentSearch.isSearching, searchRequest.canSearchContent {
                Text("Searching conversations…")
                    .font(T3Typography.homeMetadata)
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 4)
            }
            HomeThreadCollectionView(
                presentation: presentation,
                projectFaviconClient: model.client,
                query: searchText,
                selectedThreadID: threadSelection.highlightedID,
                forceRichRows: dynamicTypeSize.isAccessibilitySize,
                hapticsEnabled: model.snapshot.settings.hapticsEnabled,
                isWorkingExpanded: isWorkingExpanded,
                isSnoozedExpanded: isSnoozedExpanded,
                isSettledExpanded: isSettledExpanded,
                isArchiveExpanded: isArchiveExpanded,
                settledLimit: settledLimit,
                onOpen: openThread,
                onToggleWorking: { isWorkingExpanded.toggle() },
                onToggleSnoozed: { isSnoozedExpanded.toggle() },
                onToggleSettled: { isSettledExpanded.toggle() },
                onToggleArchive: { isArchiveExpanded.toggle() },
                onShowMoreSettled: { settledLimit += 25 },
                onRename: { thread in
                    renameTitle = thread.title
                    renamingThread = thread
                },
                onRegenerateTitle: { thread in
                    Task { await model.regenerateThreadTitle(thread.id) }
                },
                onArchive: { thread, archived in
                    Task { await model.setArchived(thread.id, archived: archived) }
                },
                onSettle: { thread, settled, completion in
                    Task { completion(await model.setSettled(thread.id, settled: settled)) }
                },
                onSnooze: { thread, until in
                    Task { await model.setSnoozed(thread.id, until: until) }
                },
                onCustomSnooze: { thread in
                    customSnoozeSelection = FeatureCustomSnoozeSelection(thread: thread)
                },
                onNewTaskOnBranch: openNewTaskOnBranch,
                onAutoSettle: { thread, enabled in
                    Task { await model.setAutoSettle(thread.id, enabled: enabled) }
                },
                onPin: { thread, pinned in
                    Task { await model.setPinned(thread.id, pinned: pinned) }
                },
                onArrange: { showingThreadArrangement = true },
                onDelete: { thread in
                    deletingThread = thread
                }
            )
        }
        .background(T3Colors.background)
    }

    private var detail: some View {
        NavigationStack(path: Binding(
            get: { threadSelection.navigationPath },
            set: {
                let previousID = selectedThreadID
                threadSelection.pop(to: $0, availableIDs: availableThreadIDs)
                if selectedThreadID != previousID {
                    requestedThreadDestination = nil
                    requestedThreadDestinationID = nil
                    activeToolDestination = nil
                }
            }
        )) {
            threadDetail(threadSelection.rootID)
                .navigationDestination(for: String.self) { id in
                    threadDetail(id)
                }
        }
    }

    @ViewBuilder
    private func threadDetail(_ id: String?) -> some View {
        if let id,
           let thread = model.snapshot.threads.first(where: { $0.id == id }) {
            ThreadDetailView(
                model: model,
                thread: thread,
                submitMessage: submitMessage,
                onNavigateBack: { if selectedThreadID == id { closeSelectedThread() } },
                onOpenThread: { if selectedThreadID == id { openRelatedThread($0) } },
                onNewTaskFromThread: openNewTaskOnBranch,
                initialDestination: id == selectedThreadID ? requestedThreadDestination : nil,
                initialDestinationID: id == selectedThreadID ? requestedThreadDestinationID : nil,
                onToolDestinationChange: { if id == selectedThreadID { activeToolDestination = $0 } },
                rootNavigationDismissalID: id == selectedThreadID ? rootNavigationDismissalID : nil,
                onRootNavigationDismissed: finishThreadNavigationDismissal,
                isPresentedThread: id == selectedThreadID
            )
            .id(id)
        } else {
            VStack(spacing: 14) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 30, weight: .light))
                    .foregroundStyle(T3Colors.textTertiary)
                Text("Start a task")
                    .font(.title3.weight(.semibold))
                Text("Choose a thread or compose something new.")
                    .font(.subheadline)
                    .foregroundStyle(T3Colors.textSecondary)
                Button("New task", action: openNewTaskOrProjectCreation)
                    .buttonStyle(.borderedProminent)
                    .tint(T3Colors.primaryAction)
                    .foregroundStyle(T3Colors.primaryActionForeground)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(T3Colors.background)
        }
    }

    private var homeBar: some View {
        HStack(spacing: 2) {
            connectionBrand
                .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                withAnimation(.easeOut(duration: 0.16)) {
                    isSearching.toggle()
                }
                if isSearching {
                    Task { @MainActor in
                        await Task.yield()
                        isSearchFocused = true
                    }
                } else {
                    searchText = ""
                    isSearchFocused = false
                }
            } label: {
                Image(systemName: isSearching ? "xmark" : "magnifyingglass")
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: 40, height: T3Metrics.minimumTapTarget)
            }
            .buttonStyle(.plain)
            .foregroundStyle(T3Colors.textSecondary)
            .accessibilityLabel(isSearching ? "Close search" : "Search tasks")
            .accessibilityIdentifier("sidebar-search-button")

            Button { settingsDestination = nil; showingSettings = true } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: 40, height: T3Metrics.minimumTapTarget)
            }
            .buttonStyle(.plain)
            .foregroundStyle(T3Colors.textSecondary)
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("sidebar-settings-button")
        }
        .padding(.leading, 15)
        .padding(.trailing, 8)
        .frame(height: 49)
        .background(T3Colors.background)
    }

    @ViewBuilder
    private var connectionBrand: some View {
        if !unreachableEnvironments.isEmpty {
            Button { showingEnvironments = true } label: {
                HStack(spacing: 7) {
                    Image(systemName: "network.slash")
                        .font(.system(size: 13, weight: .semibold))
                    Text(unreachableBrandLabel)
                        .lineLimit(1)
                        .font(.system(size: 13, weight: .semibold))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                }
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(T3Colors.danger)
            .accessibilityLabel("\(unreachableBrandLabel). Manage environments")
            .accessibilityIdentifier("sidebar-environments-button")
        } else if let reconnecting = reconnectingEnvironments.first {
            Button { showingEnvironments = true } label: {
                HStack(spacing: 7) {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 13, weight: .semibold))
                    Text(reconnecting.name)
                        .lineLimit(1)
                    Text("reconnecting")
                        .fontWeight(.medium)
                        .opacity(0.76)
                }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(T3Colors.warning)
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(reconnecting.name) reconnecting. Manage environments")
            .accessibilityIdentifier("sidebar-environments-button")
        } else {
            Button { showingEnvironments = true } label: {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text("T3")
                        .fontWeight(.bold)
                        .foregroundStyle(T3Colors.textPrimary)
                    Text("Code")
                        .fontWeight(.medium)
                        .foregroundStyle(T3Colors.textSecondary)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(T3Colors.textTertiary)
                        .padding(.leading, 2)
                }
                .font(.system(size: 16))
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("T3 Code. Manage environments")
            .accessibilityIdentifier("sidebar-environments-button")
        }
    }

    private var searchBar: some View {
        HStack(spacing: 9) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(T3Colors.textTertiary)
            TextField("Search tasks and projects", text: $searchText)
                .font(.subheadline)
                .foregroundStyle(T3Colors.textPrimary)
                .focused($isSearchFocused)
                .submitLabel(.search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("sidebar-search-field")
            if !searchText.isEmpty {
                Button { searchText = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(T3Colors.textTertiary)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12)
        .frame(height: T3Metrics.minimumTapTarget)
        .background(T3Colors.input, in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(T3Colors.border, lineWidth: 1)
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 4)
    }

    private var composeButton: some View {
        Button {
            isSearchFocused = false
            openNewTaskOrProjectCreation()
        } label: {
            Image(systemName: "square.and.pencil")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(T3Colors.primaryActionForeground)
                .frame(width: 52, height: 52)
                .background(T3Colors.primaryAction, in: Circle())
                .shadow(color: T3Colors.shadow, radius: 16, y: 8)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("New task")
        .accessibilityHint(newTaskAccessibilityHint)
        .accessibilityIdentifier("sidebar-new-task-button")
    }

    private var newTaskAccessibilityHint: String {
        if !creationProjects.isEmpty {
            return "Compose a message and start a thread"
        }
        if !DailyUXCreationContext.unreachableEnvironments(in: model.snapshot).isEmpty {
            return "Review unreachable environments and try again"
        }
        return "Create a project to start a task"
    }

    private var projectFilter: some View {
        HStack(spacing: 0) {
            Menu {
                Button {
                    selectedProjectID = nil
                } label: {
                    if selectedProjectID == nil {
                        Label("All projects", systemImage: "checkmark")
                    } else {
                        Text("All projects")
                    }
                }
                ForEach(model.snapshot.projects) { project in
                    Button {
                        selectedProjectID = project.id
                    } label: {
                        let title = projectMenuTitle(project)
                        if selectedProjectID == project.id {
                            Label(title, systemImage: "checkmark")
                        } else {
                            Text(title)
                        }
                    }
                }
                if let selectedProject {
                    Divider()
                    Button("Project settings", systemImage: "gearshape") {
                        settingsProject = selectedProject
                    }
                }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "folder")
                        .font(.system(size: 13, weight: .medium))
                    Text(selectedProject?.name ?? "All projects")
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .bold))
            }
            .font(T3Typography.homeMetadata.weight(.semibold))
                .foregroundStyle(T3Colors.textSecondary)
            .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Project filter")
            .accessibilityValue(selectedProject?.name ?? "All projects")
            .accessibilityIdentifier("sidebar-project-filter")

            Button { showingAddProject = true } label: {
                Image(systemName: "folder.badge.plus")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(T3Colors.textTertiary)
                    .frame(width: T3Metrics.minimumTapTarget, height: 34)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add project")
            .accessibilityIdentifier("sidebar-add-project-button")
        }
        .padding(.leading, 10)
        .padding(.trailing, 2)
        .accessibilityElement(children: .contain)
    }

    private var renderedThreads: [FeatureThread] {
        let presentation = homePresentation
        if !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return presentation.searchResults
        }
        return presentation.pinned + presentation.active
            + presentation.working.filter { isWorkingExpanded || $0.id == threadSelection.highlightedID }
            + (isSnoozedExpanded ? presentation.snoozed : [])
            + (isSettledExpanded ? Array(presentation.settled.prefix(settledLimit)) : [])
            + (isArchiveExpanded ? presentation.archived : [])
    }

    private var keyboardContext: FeatureKeyboardContext {
        var enabled: Set<FeatureKeyboardCommand> = [.commandPalette, .newTask, .focusSearch, .toggleSidebar]
        if selectedThreadID != nil || isSearching { enabled.insert(.back) }
        for number in stride(from: 1, through: min(9, renderedThreads.count), by: 1) {
            enabled.insert(.threadJump(number))
        }
        // Thread and tool scopes provide their actions through this same dispatcher.
        return FeatureKeyboardContext(enabledCommands: enabled,
            isTerminalActive: activeToolDestination.map { if case .terminal = $0 { true } else { false } } ?? false)
    }

    private var paletteSearchRequest: FeatureThreadSearchRequest {
        FeatureThreadSearchRequest(query: paletteQuery, snapshot: model.snapshot, projectID: selectedProjectID)
    }

    private var commandPaletteContent: FeatureCommandPaletteContent {
        var items: [FeatureCommandPaletteItem] = [
            .init(id: "settings", title: "Settings", run: { settingsDestination = nil; showingSettings = true }),
            .init(id: "appearance", title: "Appearance", run: {
                settingsDestination = .appearance; showingSettings = true
            }),
            .init(id: "scheduledTasks", title: "Scheduled Tasks", run: {
                settingsDestination = .scheduledTasks; showingSettings = true
            }),
            .init(id: "projects", title: "Project Settings", run: {
                settingsDestination = .projects; showingSettings = true
            }),
            .init(id: "connections", title: "Computers", searchTerms: ["environments", "connections"],
                  run: { showingEnvironments = true }),
            .init(id: "addProject", title: "Add Project", run: openProjectCreation),
            .init(id: "usage", title: "Usage Limits", run: { showingUsageLimits = true }),
            .init(id: "archive", title: "Archived Threads", run: {
                searchText = ""
                isArchiveExpanded = true
                closeSelectedThread()
            }),
        ]
        items += creationProjects.map { project in
            FeatureCommandPaletteItem(id: "project:" + project.id, kind: .project,
                title: project.name, detail: projectMenuTitle(project), searchTerms: [project.path]) {
                openNewTaskOrProjectCreation(initialProjectID: project.id)
            }
        }
        let request = paletteSearchRequest
        let environments = Set(request.environmentIDs)
        let matches = paletteSearch.matches(for: request)
        let snippets = Dictionary(matches.map { ($0.threadID, $0.snippet) }, uniquingKeysWith: { first, _ in first })
        items += model.snapshot.threads.filter { thread in
            !thread.isArchived && (selectedProjectID == nil || thread.projectID == selectedProjectID)
                && (thread.environmentID.map(environments.contains) ?? true)
        }.sorted { $0.updatedAt > $1.updatedAt }.map { thread in
            FeatureCommandPaletteItem(id: thread.id, kind: .thread, title: thread.title,
                detail: snippets[thread.id] ?? thread.environmentName,
                searchTerms: [thread.branch ?? "", thread.preview ?? "", thread.projectID]) { openThread(thread.id) }
        }
        return FeatureCommandPaletteContent(items: items, matchedThreadIDs: Set(matches.map(\.threadID)),
            isSearching: paletteSearch.isSearching)
    }

    private func handleKeyboardCommand(_ command: FeatureKeyboardCommand) {
        switch command {
        case .newTask:
            openNewTaskOrProjectCreation()
        case .focusSearch:
            isSearching = true
            columnVisibility = .all
            preferredCompactColumn = .sidebar
            isSearchFocused = true
        case .back:
            if isSearching {
                isSearching = false
                isSearchFocused = false
                searchText = ""
            } else { closeSelectedThread() }
        case .toggleSidebar:
            columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly
            preferredCompactColumn = preferredCompactColumn == .sidebar ? .detail : .sidebar
        case let .threadJump(number):
            guard renderedThreads.indices.contains(number - 1) else { return }
            openThread(renderedThreads[number - 1].id)
        case .commandPalette, .cycleHost, .files, .terminal, .review, .copyThreadReference:
            break // Active screen scopes own these commands.
        }
    }

    private var selectedProject: FeatureProject? {
        model.snapshot.projects.first { $0.id == selectedProjectID }
    }

    private var contentSearchRequest: FeatureThreadSearchRequest {
        FeatureThreadSearchRequest(
            query: searchText, snapshot: model.snapshot, projectID: selectedProjectID
        )
    }

    private var creationProjects: [FeatureProject] {
        DailyUXCreationContext.projects(in: model.snapshot)
    }

    private var unreachableEnvironments: [FeatureEnvironment] {
        model.snapshot.environments.filter {
            $0.isEnabled && $0.connectionState == .disconnected
        }
    }

    private var reconnectingEnvironments: [FeatureEnvironment] {
        model.snapshot.environments.filter {
            $0.isEnabled
                && ($0.connectionState == .connecting || $0.connectionState == .reconnecting)
        }
    }

    private var unreachableBrandLabel: String {
        if unreachableEnvironments.count == 1 {
            return "\(unreachableEnvironments[0].name) offline"
        }
        return "\(unreachableEnvironments.count) environments offline"
    }

    private var nextSidebarBoundary: Date? {
        DailyUXSidebarRefresh.nextBoundary(
            for: model.snapshot.threads,
            after: max(sidebarBoundaryNow, .now)
        )
    }

    private var selectedThreadIsAvailable: Bool {
        guard let selectedThreadID else { return true }
        return model.snapshot.threads.contains { $0.id == selectedThreadID }
    }

    private var selectedThreadID: String? { threadSelection.selectedID }

    private var availableThreadIDs: Set<String> { Set(model.snapshot.threads.map(\.id)) }

    private var selectedProjectIsAvailable: Bool {
        guard let selectedProjectID else { return true }
        return model.snapshot.projects.contains { $0.id == selectedProjectID }
    }

    private func openThread(_ id: String) {
        requestedThreadDestination = nil
        requestedThreadDestinationID = nil
        activeToolDestination = nil
        threadSelection.open(id)
        preferredCompactColumn = .detail
    }

    private func closeSelectedThread() {
        requestedThreadDestination = nil
        requestedThreadDestinationID = nil
        activeToolDestination = nil
        threadSelection.back(availableIDs: availableThreadIDs)
        preferredCompactColumn = selectedThreadID == nil ? .sidebar : .detail
    }

    private func openRelatedThread(_ id: String) {
        guard availableThreadIDs.contains(id) else { return }
        requestedThreadDestination = nil
        requestedThreadDestinationID = nil
        activeToolDestination = nil
        threadSelection.push(id)
        preferredCompactColumn = .detail
    }

    @MainActor
    private func openProjectCreation() {
        dismissNewTaskBeforeRootAction { showingAddProject = true }
    }

    private func openNewTaskOrProjectCreation() {
        openNewTaskOrProjectCreation(initialProjectID: selectedProjectID)
    }

    private func openNewTaskOnBranch(_ thread: FeatureThread) {
        guard thread.branch?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else { return }
        isSearchFocused = false
        newTaskPresentation = NewTaskPresentation(projectID: thread.projectID, sourceThread: thread)
    }

    private func openNewTaskOrProjectCreation(initialProjectID: String?, managedClone: FeatureProjectCloneIdentity? = nil) {
        switch DailyUXCreationContext.newTaskDestination(in: model.snapshot) {
        case .newTask:
            newTaskPresentation = NewTaskPresentation(projectID: initialProjectID, managedClone: managedClone)
        case .addProject:
            showingAddProject = true
        }
    }

    private func consumeNavigationRequest() {
        guard let navigationRequest,
              navigationRequest.id != pendingNavigationRequest?.id,
              navigationRequest.id != consumedNavigationRequestID else { return }
        pendingNavigationRequest = nil
        rootNavigationDismissalID = nil
        // Cold-start routes stay with the caller until their target exists.
        switch navigationRequest.destination {
        case let .thread(id), let .threadDestination(id, _):
            guard model.snapshot.threads.contains(where: { $0.id == id }) else { return }
        case let .project(id):
            guard model.snapshot.projects.contains(where: { $0.id == id }) else { return }
        case .usageLimits, .newTask:
            break
        }
        pendingNavigationRequest = navigationRequest
        keyboardDispatcher.afterDismissingPalette {
            guard pendingNavigationRequest?.id == navigationRequest.id else { return }
            dismissTransientPresentations {
                guard pendingNavigationRequest?.id == navigationRequest.id else { return }
                if selectedThreadID != nil && selectedThreadIsAvailable {
                    rootNavigationDismissalID = navigationRequest.id
                } else {
                    applyNavigationRequest(navigationRequest)
                }
            }
        }
    }

    private func finishThreadNavigationDismissal(_ id: UUID) {
        guard rootNavigationDismissalID == id,
              let request = pendingNavigationRequest, request.id == id else { return }
        rootNavigationDismissalID = nil
        applyNavigationRequest(request)
    }

    private func applyNavigationRequest(_ navigationRequest: FeatureWorkspaceNavigationRequest) {
        threadSelection.resetHistory()
        switch navigationRequest.destination {
        case .usageLimits:
            showingUsageLimits = true
        case let .thread(id):
            openThread(id)
        case let .threadDestination(id, destination):
            openThread(id)
            requestedThreadDestination = destination
            requestedThreadDestinationID = navigationRequest.id
        case let .project(id):
            selectedProjectID = id
            closeSelectedThread()
        case let .newTask(projectID):
            if let projectID,
               model.snapshot.projects.contains(where: { $0.id == projectID }) {
                selectedProjectID = projectID
            }
            openNewTaskOrProjectCreation(initialProjectID: projectID)
        }
        pendingNavigationRequest = nil
        consumedNavigationRequestID = navigationRequest.id
        onNavigationRequestConsumed(navigationRequest.id)
    }

    private func dismissNewTaskBeforeRootAction(_ action: @escaping @MainActor () -> Void) {
        guard newTaskPresentation != nil || workspacePresentationIsVisible || pendingWorkspaceAction != nil else {
            action()
            return
        }
        pendingWorkspaceAction = action
        newTaskPresentation = nil
    }

    private func finishWorkspaceDismissal() {
        workspacePresentationIsVisible = false
        let action = pendingWorkspaceAction
        pendingWorkspaceAction = nil
        action?()
    }

    private func dismissTransientPresentations(before action: @escaping @MainActor () -> Void) {
        let needsDismissal = workspacePresentationIsVisible || pendingWorkspaceAction != nil || settingsProject != nil
            || newTaskPresentation != nil || customSnoozeSelection != nil || showingAddProject
            || showingEnvironments || showingSettings || showingUsageLimits || showingThreadArrangement
        if needsDismissal { pendingWorkspaceAction = action }
        settingsProject = nil
        newTaskPresentation = nil
        customSnoozeSelection = nil
        showingAddProject = false
        showingEnvironments = false
        showingSettings = false
        showingUsageLimits = false
        showingThreadArrangement = false
        renamingThread = nil
        deletingThread = nil
        pendingDiscardRecoveryID = nil
        if !needsDismissal { action() }
    }

    private func projectMenuTitle(_ project: FeatureProject) -> String {
        guard model.snapshot.environments.count > 1,
              let environment = model.snapshot.environments.first(where: {
                  $0.id == project.environmentID
              }) else {
            return project.name
        }
        return "\(project.name) · \(environment.name)"
    }
}

struct HomePresentation {
    let pinned: [FeatureThread]
    let active: [FeatureThread]
    let working: [FeatureThread]
    let snoozed: [FeatureThread]
    let settled: [FeatureThread]
    let archived: [FeatureThread]
    let searchResults: [FeatureThread]
    let rowContexts: [String: HomeThreadRowContext]

    private init(
        pinned: [FeatureThread],
        active: [FeatureThread],
        working: [FeatureThread],
        snoozed: [FeatureThread],
        settled: [FeatureThread],
        archived: [FeatureThread],
        searchResults: [FeatureThread],
        rowContexts: [String: HomeThreadRowContext]
    ) {
        self.pinned = pinned
        self.active = active
        self.working = working
        self.snoozed = snoozed
        self.settled = settled
        self.archived = archived
        self.searchResults = searchResults
        self.rowContexts = rowContexts
    }

    /// Same shelves and order, latest thread values. O(n) dictionary lookup
    /// instead of the grouping and sorting passes in `init(snapshot:)`.
    func refreshingRows(from snapshot: FeatureSnapshot) -> HomePresentation {
        let byID = snapshot.threads.reduce(into: [String: FeatureThread]()) { $0[$1.id] = $1 }
        let contextChanged = [pinned, active, working, snoozed, settled, archived].joined().contains { previous in
            guard let next = byID[previous.id] else { return false }
            return previous.providerID != next.providerID
                || previous.sessionProviderID != next.sessionProviderID
                || previous.providerName != next.providerName
                || previous.environmentID != next.environmentID
                || previous.environmentName != next.environmentName
        }
        func refresh(_ threads: [FeatureThread]) -> [FeatureThread] {
            threads.map { byID[$0.id] ?? $0 }
        }
        return HomePresentation(
            pinned: refresh(pinned),
            active: refresh(active),
            working: refresh(working),
            snoozed: refresh(snoozed),
            settled: refresh(settled),
            archived: refresh(archived),
            searchResults: refresh(searchResults),
            rowContexts: contextChanged ? HomeThreadRowContext.index(snapshot: snapshot) : rowContexts
        )
    }

    init(
        snapshot: FeatureSnapshot,
        query: String,
        projectID: String?,
        now: Date,
        inboxReturns: FeatureInboxReturnTracker = .init(),
        contentMatches: [FeatureThreadContentMatch] = [],
        searchEnvironmentIDs: [String]? = nil
    ) {
        let index = DailyUXSidebarIndex(
            snapshot: snapshot,
            projectID: projectID,
            now: now,
            inboxReturns: inboxReturns
        )
        let archived = snapshot.threads
            .filter { thread in
                thread.isArchived && (projectID == nil || thread.projectID == projectID)
            }
            .sorted {
                if $0.updatedAt != $1.updatedAt { return $0.updatedAt > $1.updatedAt }
                return $0.id < $1.id
            }

        pinned = index.pinned
        active = index.active
        working = index.working
        snoozed = index.snoozed
        settled = index.settled
        self.archived = archived
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        var contexts = HomeThreadRowContext.index(snapshot: snapshot)
        if normalizedQuery.isEmpty {
            searchResults = []
        } else {
            let selected = searchEnvironmentIDs.map(Set.init)
            let candidates = (index.pinned + index.active + index.working + index.snoozed + index.settled + archived)
                .filter { thread in
                    guard let selected else { return true }
                    let environmentID = thread.environmentID ?? contexts[thread.id]?.projectEnvironmentID
                    return environmentID.map(selected.contains) ?? false
                }
            let localIDs = Set(DailyUXSidebarIndex.matchingThreads(
                candidates, snapshot: snapshot, query: normalizedQuery
            ).map(\.id))
            let byThreadID = contentMatches.reduce(into: [String: FeatureThreadContentMatch]()) {
                if $0[$1.threadID] == nil { $0[$1.threadID] = $1 }
            }
            searchResults = candidates.filter { thread in
                if let match = byThreadID[thread.id], match.projectID == thread.projectID {
                    contexts[thread.id]?.searchSnippet = match.snippet
                    return true
                }
                return localIDs.contains(thread.id)
            }
        }
        rowContexts = contexts
    }
}

/// Grouping and sorting run only when a shelf or order input changes
/// (`homePresentationRevision`). A streaming turn advances `threadRowRevision`
/// many times a second; that path swaps in the latest thread values by id and
/// keeps the computed order.
@MainActor
final class HomePresentationCache {
    private struct Key: Equatable {
        let revision: UInt64
        let query: String
        let projectID: String?
        let now: Date
        let workingShelfEnabled: Bool
        let inboxReturnRevision: UInt64
        let contentMatches: [FeatureThreadContentMatch]
        let searchEnvironmentIDs: [String]?
    }

    private var cachedKey: Key?
    private var cachedRowRevision: UInt64?
    private var cachedPresentation: HomePresentation?

    func presentation(
        snapshot: FeatureSnapshot,
        revision: UInt64,
        rowRevision: UInt64,
        query: String,
        projectID: String?,
        now: Date,
        inboxReturns: FeatureInboxReturnTracker = .init(),
        contentMatches: [FeatureThreadContentMatch] = [],
        searchEnvironmentIDs: [String]? = nil
    ) -> HomePresentation {
        let key = Key(
            revision: revision,
            query: query,
            projectID: projectID,
            now: now,
            workingShelfEnabled: snapshot.settings.workingShelfEnabled,
            inboxReturnRevision: inboxReturns.revision,
            contentMatches: contentMatches,
            searchEnvironmentIDs: searchEnvironmentIDs
        )
        if cachedKey == key, let cachedPresentation {
            if cachedRowRevision == rowRevision {
                return cachedPresentation
            }
            // Search also matches previews, which can change without moving a row.
            if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let refreshed = cachedPresentation.refreshingRows(from: snapshot)
                self.cachedPresentation = refreshed
                cachedRowRevision = rowRevision
                return refreshed
            }
        }

        let presentation = HomePresentation(
            snapshot: snapshot,
            query: query,
            projectID: projectID,
            now: max(now, .now),
            inboxReturns: inboxReturns,
            contentMatches: contentMatches,
            searchEnvironmentIDs: searchEnvironmentIDs
        )
        cachedKey = key
        cachedRowRevision = rowRevision
        cachedPresentation = presentation
        return presentation
    }
}

struct HomeShelfHeader: View {
    let title: String
    let count: Int
    let isExpanded: Bool
    let accent: Color?

    var body: some View {
        HStack(spacing: 8) {
            Text(count > 0 ? "\(title) (\(count))" : title)
                .lineLimit(1)
            Rectangle()
                .fill((accent ?? T3Colors.textTertiary).opacity(accent == nil ? 0.16 : 0.24))
                .frame(height: 1)
            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                .font(.system(size: 8, weight: .bold))
        }
        .font(T3Typography.homeMetadata.weight(.bold))
        .foregroundStyle(accent ?? T3Colors.textTertiary)
        .padding(.horizontal, 10)
        .padding(.top, 4)
        .frame(minHeight: 40)
        .contentShape(Rectangle())
    }
}

struct HomeThreadRowContext: Equatable {
    var searchSnippet: String? = nil
    var projectRevision: String? = nil
    var projectIcon: ProjectIconOverride? = nil
    let projectName: String
    let projectEnvironmentID: String?
    let projectWorkspaceRoot: String?
    let environmentLabel: String?
    let providerID: String
    let providerDriver: String
    let providerName: String
    let connectionState: FeatureConnection.State?
    var providerBadge: ProviderAccountBadge? = nil

    static let fallback = HomeThreadRowContext(
        projectName: "Project",
        projectEnvironmentID: nil,
        projectWorkspaceRoot: nil,
        environmentLabel: nil,
        providerID: "agent",
        providerDriver: "",
        providerName: "Agent",
        connectionState: nil
    )

    var copyContext: ThreadCopyContext {
        ThreadCopyContext(
            projectName: projectWorkspaceRoot == nil ? nil : projectName,
            projectWorkspaceRoot: projectWorkspaceRoot,
            environmentName: environmentLabel,
            environmentID: projectEnvironmentID
        )
    }

    var providerLooksTerminal: Bool {
        let normalized = [providerDriver, providerID, providerName]
            .joined(separator: " ")
            .lowercased()
        return normalized.contains("codex")
            || normalized.contains("cursor")
            || normalized.contains("open")
    }

    static func index(snapshot: FeatureSnapshot) -> [String: HomeThreadRowContext] {
        let projectByID = snapshot.projects.reduce(into: [String: FeatureProject]()) {
            $0[$1.id] = $1
        }
        let projectGroupNameByID = DailyUXCreationContext.projectGroups(in: snapshot).reduce(
            into: [String: String]()
        ) { result, group in
            for projectID in group.memberProjectIDs {
                result[projectID] = group.name
            }
        }
        let environmentByID = snapshot.environments.reduce(into: [String: FeatureEnvironment]()) {
            $0[$1.id] = $1
        }
        let providersByEnvironment = (snapshot.providersByEnvironment ?? [:]).mapValues { providers in
            providers.reduce(into: [String: FeatureProvider]()) { result, provider in
                if result[provider.id] == nil { result[provider.id] = provider }
            }
        }
        let badgesByEnvironment = providersByEnvironment.mapValues { providers in
            let counts = providers.values.reduce(into: [String: Int]()) { $0[$1.driver, default: 0] += 1 }
            return providers.reduce(into: [String: ProviderAccountBadge]()) { result, entry in
                let provider = entry.value
                let accent = ProviderInstanceDisplay.accentColor(provider.accentColor)
                guard accent != nil || counts[provider.driver, default: 0] > 1 else { return }
                result[provider.id] = ProviderAccountBadge(
                    initials: ProviderInstanceDisplay.initials(provider.name), accentColor: accent
                )
            }
        }
        return snapshot.threads.reduce(into: [String: HomeThreadRowContext]()) { result, thread in
            let project = projectByID[thread.projectID]
            let normalizedThreadEnvironmentID = thread.environmentID?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let environmentID = normalizedThreadEnvironmentID?.isEmpty == false
                ? normalizedThreadEnvironmentID
                : project?.environmentID
            let environment = environmentID.flatMap { environmentByID[$0] }
            let environmentLabel = (environment?.name ?? thread.environmentName)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let explicitProvider = thread.providerName?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let instanceID = thread.sessionProviderID ?? thread.providerID
            let configuredProvider = instanceID.flatMap { providerID in
                environmentID.flatMap {
                    providersByEnvironment[$0]?[providerID]
                }
            }
            let providerName = configuredProvider?.name
                ?? (explicitProvider?.isEmpty == false ? explicitProvider : nil)
                ?? instanceID
                ?? "Agent"
            let providerID = instanceID ?? providerName
            let providerDriver = configuredProvider?.driver ?? instanceID ?? ""

            let connectionState = environment?.isEnabled == false
                ? FeatureConnection.State.disconnected
                : environment?.connectionState

            result[thread.id] = HomeThreadRowContext(
                projectRevision: project?.updatedAt,
                projectIcon: project?.projectIcon,
                projectName: projectGroupNameByID[thread.projectID] ?? project?.name ?? "Project",
                projectEnvironmentID: project?.environmentID,
                projectWorkspaceRoot: project?.path,
                environmentLabel: environmentLabel?.isEmpty == false ? environmentLabel : nil,
                providerID: providerID,
                providerDriver: providerDriver,
                providerName: providerName,
                connectionState: connectionState,
                providerBadge: environmentID.flatMap { badgesByEnvironment[$0]?[providerID] }
            )
        }
    }
}

struct HomeThreadPullRequestPresentation: Equatable {
    enum State: String {
        case open
        case merged
        case closed
        case draft
    }

    let number: Int
    let state: State
    var count = 1
    var isStack = false

    var label: String {
        count > 1 ? (isStack ? "\(count) PRs" : "#\(number) +\(count - 1)") : "#\(number)"
    }

    var accessibilityLabel: String {
        "\(count > 1 ? "\(count) pull requests" : "Pull request #\(number)"), \(state.rawValue)"
    }

    static func resolve(links: [ThreadPullRequestLink]) -> Self? {
        let visible = ThreadPullRequests.visible(links)
        guard let current = ThreadPullRequests.current(visible) else { return nil }
        let state: State = visible.allSatisfy { $0.snapshot?.state == .open && $0.snapshot?.isDraft == true }
            ? .draft : visible.contains(where: \.isOpen) ? .open
            : visible.allSatisfy { $0.snapshot?.state == .merged } ? .merged : .closed
        return Self(number: current.number, state: state, count: visible.count,
                    isStack: visible.count > 1 && ThreadPullRequests.chains(visible).count == 1)
    }

    static func resolve(
        thread: FeatureThread,
        status: FeatureSourceControlStatus
    ) -> Self? {
        guard let branch = thread.branch?.trimmingCharacters(in: .whitespacesAndNewlines),
              !branch.isEmpty,
              status.branch == branch,
              let pullRequest = status.pullRequest,
              PullRequestState(rawValue: pullRequest.state.lowercased()) != nil,
              let state = State(rawValue: pullRequest.state.lowercased()) else {
            return nil
        }
        return Self(number: pullRequest.number, state: state)
    }

    static func resolve(
        linkedPullRequest: ThreadLinkedPullRequest,
        detail: PullRequestDetail
    ) -> Self? {
        guard detail.number == linkedPullRequest.number,
              detail.repository.caseInsensitiveCompare(linkedPullRequest.repository) == .orderedSame,
              URL(string: detail.url)?.host?.lowercased() == URL(string: linkedPullRequest.url)?.host?.lowercased(),
              URL(string: detail.url)?.port == URL(string: linkedPullRequest.url)?.port,
              let state = State(rawValue: detail.state.rawValue) else {
            return nil
        }
        return Self(number: detail.number, state: state)
    }
}

extension FeatureThread {
    var pullRequestObservationIdentity: String? {
        let environment = environmentID ?? ""
        if let pullRequests, !pullRequests.isEmpty {
            return [id, environment, projectID, String(pullRequests.hashValue)].joined(separator: "\u{0}")
        }
        if let linkedPullRequest = effectivePullRequest {
            return [
                id,
                environment,
                projectID,
                linkedPullRequest.projectId,
                linkedPullRequest.repository.lowercased(),
                linkedPullRequest.url,
                String(linkedPullRequest.number),
            ].joined(separator: "\u{0}")
        }
        guard let branch = branch?.trimmingCharacters(in: .whitespacesAndNewlines),
              !branch.isEmpty else {
            return nil
        }
        return [id, environment, projectID, worktreePath ?? "", branch]
            .joined(separator: "\u{0}")
    }
}

struct FeatureThreadRow: View {
    enum Style: Equatable {
        case rich
        case slim
    }

    let thread: FeatureThread
    private let context: HomeThreadRowContext
    private let projectFaviconClient: (any FeatureClient)?
    private let onPullRequestChange: (HomeThreadPullRequestPresentation?) -> Void
    let isSelected: Bool
    let style: Style
    let now: Date
    let allowsMultilineTitle: Bool
    @State private var pullRequest: HomeThreadPullRequestPresentation?

    init(
        thread: FeatureThread,
        context: HomeThreadRowContext,
        projectFaviconClient: (any FeatureClient)? = nil,
        onPullRequestChange: @escaping (HomeThreadPullRequestPresentation?) -> Void = { _ in },
        isSelected: Bool = false,
        style: Style = .rich,
        now: Date = .now,
        allowsMultilineTitle: Bool = false
    ) {
        self.thread = thread
        self.context = context
        self.projectFaviconClient = projectFaviconClient
        self.onPullRequestChange = onPullRequestChange
        self.isSelected = isSelected
        self.style = style
        self.now = now
        self.allowsMultilineTitle = allowsMultilineTitle
    }

    var body: some View {
        // HomeCollectionCell hides this row from accessibility and provides its own element.
        row(at: now)
            .task(id: pullRequestObservationID) {
                await observePullRequest()
            }
    }

    @ViewBuilder
    private func row(at now: Date) -> some View {
        Group {
            switch style {
            case .rich: richRow(at: now)
            case .slim: slimRow(at: now)
            }
        }
        .contentShape(Rectangle())
    }

    private func richRow(at now: Date) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                projectBadge
                Text(context.projectName)
                    .lineLimit(1)
                    .foregroundStyle(T3Colors.textSecondary)
                Spacer(minLength: 8)
                status(at: now)
            }
            .font(T3Typography.homeMetadata.weight(.medium))
            .frame(minHeight: 20)

            Text(thread.title)
                .font(T3Typography.homeTitle)
                .tracking(-0.14)
                .foregroundStyle(T3Colors.textPrimary)
                .opacity(titleOpacity)
                .lineLimit(allowsMultilineTitle ? 2 : 1)
                .padding(.top, 4)

            if let snippet = context.searchSnippet, !snippet.isEmpty {
                Text(snippet)
                    .font(T3Typography.homeMetadata)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(2)
                    .padding(.top, 4)
            }

            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 10, weight: .medium))
                Text(branchLabel)
                    .lineLimit(1)
                if context.providerLooksTerminal {
                    Text(">_")
                        .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                        .foregroundStyle(T3Colors.syntaxProperty)
                }
                Spacer(minLength: 8)
                if let environmentLabel {
                    HStack(spacing: 4) {
                        Image(systemName: environmentIcon)
                            .font(.system(size: 9))
                        Text(environmentLabel)
                            .lineLimit(1)
                    }
                    .foregroundStyle(environmentColor)
                }
                if let pullRequest {
                    pullRequestIndicator(pullRequest)
                }
                if thread.pinnedAt != nil {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(T3Colors.textSecondary)
                }
                providerIcon(size: 16)
            }
            .font(T3Typography.homeMetadata)
            .foregroundStyle(T3Colors.textTertiary)
            .frame(minHeight: 20)
            .padding(.top, 3)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(minHeight: 88)
        .background(
            isSelected ? T3Colors.subtleStrong : Color.clear,
            in: RoundedRectangle(cornerRadius: 8)
        )
        .padding(.horizontal, 8)
    }

    private func slimRow(at now: Date) -> some View {
        HStack(spacing: 9) {
            projectBadge
                .saturation(0)
                .opacity(0.48)
            Text(thread.title)
                .font(T3Typography.homeTitle)
                .foregroundStyle(T3Colors.textSecondary)
                .opacity(titleOpacity)
                .lineLimit(allowsMultilineTitle ? 2 : 1)
            Spacer(minLength: 8)
            if let pullRequest {
                pullRequestIndicator(pullRequest)
            }
            if thread.pinnedAt != nil {
                Image(systemName: "pin.fill")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(T3Colors.textSecondary)
            }
            providerIcon(size: 15)
            Text(SidebarRelativeAge.compact(since: thread.updatedAt, now: now))
                .font(T3Typography.homeMetadata.monospacedDigit())
                .foregroundStyle(T3Colors.textTertiary)
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 44)
        .padding(.horizontal, 8)
        .background(
            isSelected ? T3Colors.subtleStrong : Color.clear,
            in: RoundedRectangle(cornerRadius: 7)
        )
    }

    @ViewBuilder
    private func status(at now: Date) -> some View {
        HStack(spacing: 5) {
            if let icon = statusIcon {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
            }
            Text(thread.homeRowStatusLabel(at: now))
            if let duration = thread.homeWorkingDuration(at: now) {
                Text(duration)
                    .font(.system(.footnote, design: .monospaced, weight: .semibold))
                    .monospacedDigit()
            }
        }
        .font(T3Typography.status)
        .foregroundStyle(statusColor)
    }

    /// Same dimming the web sidebar uses while a title is being regenerated.
    private var titleOpacity: Double {
        thread.isRegeneratingTitle ? 0.55 : 1
    }

    private var statusIcon: String? {
        switch thread.homeStatus {
        case .working: "circle.dotted"
        case .failed: "exclamationmark.circle"
        case .approval, .input, .monitoring, .done, .ready: nil
        }
    }

    private var statusColor: Color {
        switch thread.homeStatus {
        case .working: T3Colors.statusRunning
        case .monitoring: T3Colors.statusRunning
        case .approval: T3Colors.warning
        case .input: T3Colors.statusInput
        case .failed: T3Colors.danger
        case .done, .ready: T3Colors.textTertiary
        }
    }

    private var environmentIcon: String {
        switch context.connectionState {
        case .connecting, .reconnecting:
            "wifi"
        case .disconnected:
            "wifi.slash"
        case .needsPairing:
            "key.slash"
        case .connected, nil:
            "server.rack"
        }
    }

    private var environmentColor: Color {
        switch context.connectionState {
        case .connecting, .reconnecting:
            T3Colors.warning.opacity(0.78)
        case .disconnected, .needsPairing:
            T3Colors.danger.opacity(0.78)
        case .connected, nil:
            T3Colors.textTertiary
        }
    }

    private var branchLabel: String {
        if let branch = thread.branch?.trimmingCharacters(in: .whitespacesAndNewlines),
           !branch.isEmpty {
            return branch
        }
        if let worktreePath = thread.worktreePath,
           !worktreePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return (worktreePath as NSString).lastPathComponent
        }
        return "workspace"
    }

    private var environmentLabel: String? {
        context.environmentLabel
    }

    private var pullRequestObservationID: String? {
        guard projectFaviconClient != nil else { return nil }
        return thread.pullRequestObservationIdentity
    }

    @MainActor
    private func observePullRequest() async {
        if let links = thread.pullRequests, !links.isEmpty {
            let next = HomeThreadPullRequestPresentation.resolve(links: links)
            pullRequest = next
            onPullRequestChange(next)
            return
        }
        guard pullRequestObservationID != nil,
              let projectFaviconClient else {
            pullRequest = nil
            onPullRequestChange(nil)
            return
        }

        if let linked = thread.effectivePullRequest,
           let environmentID = thread.environmentID {
            let target = FeaturePullRequestTarget(
                environmentID: environmentID,
                environmentName: thread.environmentName ?? environmentID,
                reference: PullRequestRef(
                    projectId: linked.projectId,
                    repository: linked.repository,
                    number: linked.number,
                    host: ThreadPullRequests.authority(of: linked.url)
                )
            )
            while !Task.isCancelled {
                if let detail = try? await projectFaviconClient.pullRequestDetail(target),
                   let next = HomeThreadPullRequestPresentation.resolve(
                       linkedPullRequest: linked,
                       detail: detail
                   ),
                   next != pullRequest {
                    pullRequest = next
                    onPullRequestChange(next)
                }
                do {
                    try await Task.sleep(for: .seconds(30))
                } catch {
                    return
                }
            }
            return
        }

        for await status in projectFaviconClient.sourceControlStatusEvents(threadID: thread.id, intent: .passive) {
            guard !Task.isCancelled else { return }
            let next = HomeThreadPullRequestPresentation.resolve(
                thread: thread,
                status: status
            )
            guard next != pullRequest else { continue }
            pullRequest = next
            onPullRequestChange(next)
        }
    }

    private func pullRequestIndicator(_ pullRequest: HomeThreadPullRequestPresentation) -> some View {
        HStack(spacing: 3) {
            Image(systemName: pullRequest.isStack ? "square.stack.3d.up" : "arrow.triangle.pull")
                .font(.system(size: 10, weight: .semibold))
            Text(pullRequest.label)
                .font(T3Typography.homeMetadata.monospacedDigit().weight(.medium))
                .lineLimit(1)
        }
        .foregroundStyle(pullRequestColor(pullRequest.state))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(pullRequest.accessibilityLabel)
    }

    private func pullRequestColor(_ state: HomeThreadPullRequestPresentation.State) -> Color {
        switch state {
        case .open: T3Colors.success
        case .merged: T3Colors.syntaxKeyword
        case .closed: T3Colors.danger
        case .draft: T3Colors.textSecondary
        }
    }

    private var projectBadge: some View {
        ProjectBadge(
            name: context.projectName,
            revision: context.projectRevision,
            icon: context.projectIcon,
            environmentID: context.projectEnvironmentID,
            workspaceRoot: context.projectWorkspaceRoot,
            client: projectFaviconClient
        )
    }

    private func providerIcon(size: CGFloat) -> some View {
        ProviderIcon(
            driver: context.providerDriver,
            providerID: context.providerID,
            fallbackName: context.providerName,
            size: size,
            accountBadge: context.providerBadge
        )
    }

}

private struct ProjectBadge: View {
    let name: String
    let revision: String?
    let icon: ProjectIconOverride?
    let environmentID: String?
    let workspaceRoot: String?
    let client: (any FeatureClient)?
    /// In-memory image cache and `.task` key. The disk store normalizes paths on its own.
    private let faviconKey: String?
    @State private var favicon: UIImage?

    init(
        name: String,
        revision: String? = nil,
        icon: ProjectIconOverride? = nil,
        environmentID: String?,
        workspaceRoot: String?,
        client: (any FeatureClient)?
    ) {
        self.name = name
        self.revision = revision
        self.icon = icon
        self.environmentID = environmentID
        self.workspaceRoot = workspaceRoot
        self.client = client
        let faviconKey = environmentID.flatMap { environmentID in
            workspaceRoot.map { "\(environmentID)\u{0}\($0)" }
        }
        self.faviconKey = faviconKey
        _favicon = State(initialValue: faviconKey.flatMap {
            FeatureProjectFaviconImageCache.shared.image(for: $0)
        })
    }

    var body: some View {
        Group {
            if let icon, icon.kind == "emoji", let emoji = icon.emoji {
                Text(emoji).font(.system(size: 14))
            } else if let text = icon?.monogramDisplayText {
                Text(text)
                    .font(.system(size: 8, weight: .heavy))
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                    .foregroundStyle(ProjectIconPresentation.color(icon?.color))
            } else if let icon, icon.kind == "lucide" {
                Image(systemName: ProjectIconPresentation.symbol(icon.name))
                    .font(.system(size: 13))
                    .foregroundStyle(ProjectIconPresentation.color(icon.color))
            } else if let favicon {
                Image(uiImage: favicon)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 3))
            } else {
                Text(label)
                    .font(.system(size: 8, weight: .heavy))
                    .foregroundStyle(foreground)
                    .frame(width: 16, height: 16)
                    .background(background, in: RoundedRectangle(cornerRadius: 4))
            }
        }
            .frame(width: 16, height: 16)
            .accessibilityHidden(true)
            .task(id: [faviconKey, revision]) {
                await loadFavicon()
            }
    }

    private func loadFavicon() async {
        guard icon == nil else { return }
        guard let environmentID, let workspaceRoot, let client, let faviconKey else {
            return
        }
        favicon = FeatureProjectFaviconImageCache.shared.image(for: faviconKey)
        if let cached = await client.cachedProjectFavicon(
            environmentID: environmentID,
            workspaceRoot: workspaceRoot
        ) {
            apply(cached, key: faviconKey)
        }
        guard !Task.isCancelled else { return }
        if let refreshed = await client.refreshProjectFavicon(
            environmentID: environmentID,
            workspaceRoot: workspaceRoot
        ) {
            apply(refreshed, key: faviconKey)
        }
    }

    private func apply(_ data: Data, key: String) {
        guard let image = UIImage(data: data) else { return }
        FeatureProjectFaviconImageCache.shared.set(image, for: key)
        favicon = image
    }

    private var label: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "?" }
        if trimmed.lowercased().hasPrefix("t3") { return "T3" }
        return String(trimmed.prefix(1)).uppercased()
    }

    private var paletteIndex: Int {
        if label == "T3" { return 0 }
        return name.unicodeScalars.reduce(0) { ($0 + Int($1.value)) % 4 }
    }

    private var background: Color {
        switch paletteIndex {
        case 0: Color(red: 0.03, green: 0.24, blue: 0.21)
        case 1: Color(red: 0.19, green: 0.13, blue: 0.37)
        case 2: Color(red: 0.29, green: 0.18, blue: 0.02)
        default: Color(red: 0.10, green: 0.18, blue: 0.34)
        }
    }

    private var foreground: Color {
        switch paletteIndex {
        case 0: Color(red: 0.78, green: 0.98, blue: 0.95)
        case 1: Color(red: 0.93, green: 0.91, blue: 1)
        case 2: Color(red: 1, green: 0.95, blue: 0.78)
        default: Color(red: 0.82, green: 0.9, blue: 1)
        }
    }
}

@MainActor
private final class FeatureProjectFaviconImageCache {
    static let shared = FeatureProjectFaviconImageCache()

    private let images = NSCache<NSString, UIImage>()

    private init() {
        images.countLimit = FeatureProjectFaviconStore.maximumEntryCount
    }

    func image(for key: String) -> UIImage? {
        images.object(forKey: key as NSString)
    }

    func set(_ image: UIImage, for key: String) {
        images.setObject(image, forKey: key as NSString)
    }
}
