import SwiftUI

struct PlatformRootView: View {
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @Bindable private var model: FeatureRootModel

    @State private var navigationRequest: FeatureWorkspaceNavigationRequest?
    @State private var pendingRoute: PlatformRoute?
    @State private var previousThreadStates: [String: FeatureThreadState]?
    @State private var lastNotificationPreference: Bool?
    @State private var incomingShareCoordinator = PlatformIncomingShareCoordinator()
    @State private var incomingShareNeedsProject = false
    @State private var importedShareProjectID: String?
    @State private var recentThreadsPersistenceTask: Task<Void, Never>?

    init(model: FeatureRootModel) {
        self.model = model
    }

    var body: some View {
        FeatureRootView(
            model: model,
            navigationRequest: navigationRequest,
            onNavigationRequestConsumed: { requestID in
                guard navigationRequest?.id == requestID else { return }
                navigationRequest = nil
            }
        )
        .onOpenURL { url in
            handle(url: url, letOnboardingConfirmConnection: true)
        }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            guard let url = activity.webpageURL else { return }
            handle(url: url, letOnboardingConfirmConnection: false)
        }
        .onReceive(NotificationCenter.default.publisher(for: .platformRouteReceived)) { note in
            guard let route = note.userInfo?["route"] as? PlatformRoute else { return }
            _ = PlatformRouteMailbox.shared.take()
            handle(route)
        }
        .onChange(of: model.isLoading, initial: true) { _, isLoading in
            guard !isLoading else { return }
            processThreadChanges()
            synchronizeNotificationPreference()
            synchronizeCloudDelivery()
            consumePendingRouteIfPossible()
            consumeMailboxRouteIfAvailable()
            refreshIncomingShares()
        }
        .onChange(of: model.homePresentationRevision) { _, _ in
            processThreadChanges()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                consumeMailboxRouteIfAvailable()
                synchronizeNotificationPreference()
                synchronizeCloudDelivery()
                refreshIncomingShares()
            } else if phase == .background {
                PlatformBackgroundRefreshCoordinator.shared.schedule()
            }
        }
        .onChange(of: model.snapshot.settings.notificationsEnabled) { _, _ in
            synchronizeNotificationPreference()
            synchronizeCloudDelivery()
        }
        .onChange(of: model.snapshot.settings.liveActivitiesEnabled) { _, _ in
            synchronizeAgentAwareness()
            synchronizeCloudDelivery()
        }
        .onChange(of: model.snapshot.projects.map(\.id)) { _, _ in
            refreshIncomingShares()
        }
        .sheet(item: presentedIncomingShare, onDismiss: openImportedShareDraft) { envelope in
            PlatformIncomingShareDestinationSheet(
                envelope: envelope,
                projects: incomingShareProjects,
                environments: model.snapshot.environments,
                isImporting: incomingShareCoordinator.isImporting,
                onCancel: incomingShareCoordinator.dismissDestination,
                onSelect: importIncomingShare(into:)
            )
        }
        .alert("Create a project to continue", isPresented: $incomingShareNeedsProject) {
            Button("Not now", role: .cancel) {}
            Button("Create project") {
                navigationRequest = FeatureWorkspaceNavigationRequest(
                    destination: .newTask(projectID: nil)
                )
            }
        } message: {
            Text("Your share is saved. Connect an environment and create a project to finish importing it.")
        }
    }

    private var incomingShareProjects: [FeatureProject] {
        DailyUXCreationContext.projects(in: model.snapshot).sorted {
            if $0.name.localizedStandardCompare($1.name) == .orderedSame {
                return $0.environmentID < $1.environmentID
            }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }

    private var presentedIncomingShare: Binding<T3IncomingShareEnvelope?> {
        Binding(
            get: {
                guard !incomingShareProjects.isEmpty else { return nil }
                return incomingShareCoordinator.pendingEnvelope
            },
            set: { value in
                guard value == nil, importedShareProjectID == nil else { return }
                incomingShareCoordinator.dismissDestination()
            }
        )
    }

    private var shouldShowWorkspace: Bool {
        FeatureRootPresentation.showsWorkspace(
            snapshot: model.snapshot,
            isManagingConnections: model.isManagingConnections
        )
    }

    private func handle(url: URL, letOnboardingConfirmConnection: Bool) {
        do {
            let route = try PlatformDeepLinkParser.parse(url)
            if case .connection = route,
               letOnboardingConfirmConnection,
               !shouldShowWorkspace {
                // ConnectionOnboardingView owns the confirmation UI for cold pairing links.
                return
            }
            handle(route)
        } catch {
            model.errorMessage = error.localizedDescription
        }
    }

    private func handle(_ route: PlatformRoute) {
        guard !model.isLoading else {
            pendingRoute = route
            return
        }
        Task { @MainActor in
            await consume(route)
        }
    }

    private func consumePendingRouteIfPossible() {
        guard let route = pendingRoute else { return }
        pendingRoute = nil
        handle(route)
    }

    private func consumeMailboxRouteIfAvailable() {
        guard !model.isLoading, let route = PlatformRouteMailbox.shared.take() else { return }
        handle(route)
    }

    private func synchronizeNotificationPreference() {
        guard !model.isLoading else { return }
        let preference = model.snapshot.settings.notificationsEnabled
        let previous = lastNotificationPreference
        lastNotificationPreference = preference

        Task {
            let authorized: Bool
            if preference, previous == false {
                // The model changes only after Settings is explicitly saved.
                authorized = await PlatformNotificationService.shared.requestAuthorization()
            } else {
                authorized = await PlatformNotificationService.shared.synchronize(enabled: preference)
            }
            guard preference, !authorized, model.snapshot.settings.notificationsEnabled else {
                return
            }

            // Keep the app toggle honest when authorization is absent or revoked.
            var settings = model.snapshot.settings
            settings.notificationsEnabled = false
            await model.saveSettings(settings)
        }
    }

    private func synchronizeCloudDelivery() {
        guard !model.isLoading else { return }
        PlatformCloudDeliveryCoordinator.shared.synchronize(
            settings: model.snapshot.settings
        )
    }

    private func refreshIncomingShares() {
        guard !model.isLoading else { return }
        let hasProjects = !incomingShareProjects.isEmpty
        Task { @MainActor in
            if await incomingShareCoordinator.refresh(hasProjects: hasProjects) {
                incomingShareNeedsProject = true
            }
        }
    }

    private func importIncomingShare(into project: FeatureProject) {
        guard !incomingShareCoordinator.isImporting else { return }
        importedShareProjectID = project.id
        Task { @MainActor in
            do {
                try await incomingShareCoordinator.importPending(into: project)
            } catch {
                importedShareProjectID = nil
                model.errorMessage = error.localizedDescription
            }
        }
    }

    private func openImportedShareDraft() {
        guard let projectID = importedShareProjectID else { return }
        importedShareProjectID = nil
        navigationRequest = FeatureWorkspaceNavigationRequest(
            destination: .newTask(projectID: projectID)
        )
        PlatformHapticEngine.shared.emit(
            .success,
            enabled: model.snapshot.settings.hapticsEnabled
        )
    }

    @MainActor
    private func consume(_ route: PlatformRoute) async {
        switch route {
        case let .connection(endpoint, token):
            if await model.pair(endpoint: endpoint, token: token) {
                PlatformHapticEngine.shared.emit(
                    .success,
                    enabled: model.snapshot.settings.hapticsEnabled
                )
            }
        case let .environment(id):
            guard await activateEnvironmentIfNeeded(id) else { return }
            PlatformHapticEngine.shared.selection(
                enabled: model.snapshot.settings.hapticsEnabled
            )
        case let .thread(environmentID, threadID):
            guard await activateEnvironmentIfNeeded(environmentID),
                  let thread = PlatformRouteResolver.thread(
                      in: model.snapshot,
                      environmentID: environmentID,
                      id: threadID
                  )
            else {
                if model.errorMessage == nil { model.errorMessage = "That thread is not available on this device." }
                return
            }
            navigationRequest = FeatureWorkspaceNavigationRequest(
                destination: .thread(id: thread.id)
            )
            PlatformHapticEngine.shared.selection(
                enabled: model.snapshot.settings.hapticsEnabled
            )
        case let .project(environmentID, projectID):
            guard await activateEnvironmentIfNeeded(environmentID),
                  let project = PlatformRouteResolver.project(
                      in: model.snapshot,
                      environmentID: environmentID,
                      id: projectID
                  )
            else {
                if model.errorMessage == nil { model.errorMessage = "That project is not available on this device." }
                return
            }
            navigationRequest = FeatureWorkspaceNavigationRequest(
                destination: .project(id: project.id)
            )
            PlatformHapticEngine.shared.selection(
                enabled: model.snapshot.settings.hapticsEnabled
            )
        case let .newTask(environmentID, projectID):
            guard await activateEnvironmentIfNeeded(environmentID) else { return }
            let resolvedProject = projectID.flatMap {
                PlatformRouteResolver.project(
                    in: model.snapshot,
                    environmentID: environmentID,
                    id: $0
                )
            }
            if projectID != nil, resolvedProject == nil {
                model.errorMessage = "That project is not available on this device."
                return
            }
            navigationRequest = FeatureWorkspaceNavigationRequest(
                destination: .newTask(projectID: resolvedProject?.id)
            )
            PlatformHapticEngine.shared.selection(
                enabled: model.snapshot.settings.hapticsEnabled
            )
        }
    }

    @MainActor
    private func activateEnvironmentIfNeeded(_ id: String?) async -> Bool {
        guard let id else { return true }
        guard let environment = model.snapshot.environments.first(where: { $0.id == id }) else {
            model.errorMessage = "That environment is not saved on this device."
            return false
        }
        guard !environment.isActive else { return true }
        await model.activateEnvironment(id)
        return model.snapshot.environments.contains { $0.id == id && $0.isActive }
    }

    /// Home revisions are coalesced by FeatureRootModel, so this performs one
    /// bounded scan per meaningful snapshot change rather than on every render.
    private func processThreadChanges() {
        let current = model.snapshot.threads.reduce(into: [String: FeatureThreadState]()) {
            $0[$1.id] = $1.state
        }
        let signals = PlatformThreadTransitionClassifier.signals(
            previous: previousThreadStates,
            current: model.snapshot.threads
        )
        previousThreadStates = current
        recentThreadsPersistenceTask?.cancel()
        let threads = model.snapshot.threads
        recentThreadsPersistenceTask = Task.detached(priority: .utility) {
            guard !Task.isCancelled else { return }
            PlatformRecentThreadStore.shared.update(from: threads)
        }
        synchronizeAgentAwareness()

        for signal in signals {
            if scenePhase == .active {
                PlatformHapticEngine.shared.emit(
                    signal.kind,
                    enabled: model.snapshot.settings.hapticsEnabled
                )
            } else if model.snapshot.settings.notificationsEnabled {
                Task { await PlatformNotificationService.shared.schedule(signal) }
            }
        }
    }

    private func synchronizeAgentAwareness() {
        PlatformAgentAwarenessCoordinator.shared.synchronize(
            snapshot: model.snapshot,
            liveActivitiesEnabled: model.snapshot.settings.liveActivitiesEnabled
        )
    }
}
