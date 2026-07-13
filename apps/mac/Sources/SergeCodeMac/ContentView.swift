import SwiftUI

// App shell. File kept as ContentView.swift for historical reasons but now
// hosts RootView, the top-level NavigationSplitView wired to AppModel.
struct RootView: View {
    let multi: MultiDeviceModel
    let scenery: SceneryStore
    let passport: PassportStore

    @UIState private var showInspector = true
    @UIState private var showAgentsPanel = false
    @UIState private var showNewSessionSheet = false
    @UIState private var showPassportSheet = false
    @UIState private var columnVisibility: NavigationSplitViewVisibility = .all

    private var model: AppModel { multi.activeModel }
    private var localModel: AppModel { multi.local }

    var body: some View {
        // Drag-collapse writes visibility through this binding; wrapping
        // the set animates the snap-closed instead of an instant jump.
        NavigationSplitView(columnVisibility: Binding(
            get: { columnVisibility },
            set: { newValue in
                withAnimation(Motion.structure) {
                    columnVisibility = newValue
                }
            }
        )) {
            SidebarView(multi: multi, scenery: scenery, passport: passport)
                .navigationSplitViewColumnWidth(min: 220, ideal: 280)
        } detail: {
            Group {
                if let thread = multi.selectedThread {
                    ThreadDetailView(model: multi.activeModel, scenery: scenery, thread: thread)
                        .transition(.opacity)
                } else {
                    EmptyStateView(scenery: scenery) {
                        showNewSessionSheet = true
                    }
                    .transition(.opacity)
                }
            }
            // Keyed to presence, not thread id — thread → thread switches
            // cross-fade inside ChatScreen; this only covers hero ↔ chat.
            .animation(Motion.structure, value: multi.selectedThread == nil)
            // The inspector hangs off this stable node, not off the
            // per-thread detail view: re-presenting it on every thread
            // switch (and inside the cross-fade above) reset its column
            // width and flashed/clipped the panel.
            .inspector(isPresented: $showInspector) {
                Group {
                    if let thread = multi.selectedThread {
                        InspectorPanel(model: multi.activeModel, threadID: thread.id)
                    } else {
                        ContentUnavailableView(
                            "No Session",
                            systemImage: "sidebar.right",
                            description: Text("Select a session to inspect its changes."))
                    }
                }
                .inspectorColumnWidth(min: 300, ideal: 360, max: 480)
            }
        }
        // Let `WindowGlassBackground` show through chrome gaps / faded scenery
        // instead of an opaque split-view plate over the desktop glass.
        .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                ConnectionStatusPill(phase: model.connection)
            }
            if model.subagentTaskAggregator.runningCount > 0 {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        // Keep toolbar re-vending out of the current AppKit
                        // layout pass, matching the inspector toggle above.
                        DispatchQueue.main.async { showAgentsPanel.toggle() }
                    } label: {
                        AgentsToolbarPill(
                            count: model.subagentTaskAggregator.runningCount)
                    }
                    .buttonStyle(.plain)
                    .help("Show running agents")
                    .popover(isPresented: $showAgentsPanel, arrowEdge: .top) {
                        AgentsPanel(model: model) { threadID in
                            model.selectedThreadID = threadID
                            showAgentsPanel = false
                        }
                    }
                }
            }
            ToolbarItem(placement: .primaryAction) {
                newSessionMenu
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    // Deferred one runloop turn: flipping this synchronously
                    // from a toolbar button can land while the window is mid
                    // layout pass, and on macOS 26/27 a SwiftUI toolbar
                    // re-vend during an in-layout render trips AppKit's
                    // layout-feedback-loop guard (NSInternalInconsistency in
                    // _postWindowNeedsUpdateConstraints → hard crash).
                    DispatchQueue.main.async { showInspector.toggle() }
                } label: {
                    Label("Inspector", systemImage: "sidebar.right")
                }
                .disabled(model.selectedThread == nil)
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showPassportSheet = true
                } label: {
                    Label("Passport", systemImage: "book.closed")
                }
                .help("Passport")
            }
        }
        #if DEBUG
            .onReceive(NotificationCenter.default.publisher(for: .uiProbeToggleSection)) { note in
                guard note.object as? String == "agents" else { return }
                DispatchQueue.main.async { showAgentsPanel.toggle() }
            }
        #endif
        .sheet(isPresented: $showNewSessionSheet) {
            NewSessionSheet(
                multi: multi,
                scenery: scenery,
                passport: passport,
                isPresented: $showNewSessionSheet)
        }
        .sheet(isPresented: $showPassportSheet) {
            PassportView(
                scenery: scenery,
                passport: passport,
                isPresented: $showPassportSheet)
        }
    }

    /// Toolbar "New Session" menu: pick an existing project + provider
    /// directly (calls model.createSceneThread immediately), or fall through
    /// to the glass sheet to add a new project first.
    @ViewBuilder
    private var newSessionMenu: some View {
        Menu {
            if multi.remoteSessions.isEmpty {
                // Preserve the original flat menu while there are no remote
                // targets. This is also the fast path for the common case.
                localProjectMenus
                Divider()
                addProjectButton
            } else {
                Section("This Mac") {
                    localProjectMenus
                    addProjectButton
                }
                Divider()
                ForEach(multi.remoteSessions) { session in
                    remoteProjectSection(session)
                }
            }
        } label: {
            Label("New Session", systemImage: "plus")
        }
    }

    @ViewBuilder
    private var localProjectMenus: some View {
        projectMenus(
            for: localModel,
            deviceID: localModel.deviceID)
    }

    private var addProjectButton: some View {
        Button {
            showNewSessionSheet = true
        } label: {
            Label("Add Project…", systemImage: "folder.badge.plus")
        }
    }

    @ViewBuilder
    private func remoteProjectSection(_ session: RemoteDeviceSession) -> some View {
        Section {
            if session.model.projects.isEmpty {
                Text("No projects yet")
            } else {
                projectMenus(for: session.model, deviceID: session.id)
            }
        } header: {
            Label(session.descriptor.name, systemImage: "laptopcomputer")
        }
    }

    @ViewBuilder
    private func projectMenus(for owner: AppModel, deviceID: DeviceID) -> some View {
        if owner.projects.isEmpty {
            Text("No projects yet")
        }
        ForEach(owner.projects) { project in
            Menu(project.name) {
                if owner.configuredProviderKinds.isEmpty {
                    Text("No providers found")
                }
                ForEach(owner.configuredProviderKinds) { provider in
                    Button {
                        createSession(
                            owner: owner,
                            projectID: project.id,
                            provider: provider,
                            deviceID: deviceID)
                    } label: {
                        Label(provider.displayName, systemImage: "bolt")
                    }
                    .disabled(
                        owner.deviceID != .local
                            && owner.connection != .ready
                            || !owner.canCreateThread(with: provider))
                }
            }
            .disabled(owner.deviceID != .local && owner.connection != .ready)
        }
    }

    private func createSession(
        owner: AppModel,
        projectID: String,
        provider: ProviderKind,
        deviceID: DeviceID
    ) {
        Task {
            guard owner.deviceID == .local || owner.connection == .ready else { return }
            if let thread = await owner.createSceneThread(
                projectID: projectID,
                provider: provider,
                scenery: scenery,
                passport: passport)
            {
                multi.select(threadID: thread.id, on: deviceID)
            }
        }
    }
}
