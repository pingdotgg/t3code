import SwiftUI

// App shell. File kept as ContentView.swift for historical reasons but now
// hosts RootView, the top-level NavigationSplitView wired to AppModel.
struct RootView: View {
    let multi: MultiDeviceModel
    let scenery: SceneryStore

    @UIState private var showInspector = true
    @UIState private var showAgentsPanel = false
    @UIState private var showNewSessionSheet = false
    @UIState private var columnVisibility: NavigationSplitViewVisibility = .all

    private var model: AppModel { multi.activeModel }

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
            SidebarView(multi: multi, scenery: scenery)
                .navigationSplitViewColumnWidth(min: 230, ideal: 280, max: 360)
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
            .sharedBackgroundVisibility(.hidden)
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
                        AgentsPanel(
                            model: model,
                            onSelectThread: { threadID in
                                model.selectedThreadID = threadID
                                showAgentsPanel = false
                            },
                            onOpenTask: { threadID, taskId in
                                model.openSubagent(taskId: taskId, threadID: threadID)
                                showAgentsPanel = false
                            })
                    }
                }
                .sharedBackgroundVisibility(.hidden)
            }
            ToolbarItem(placement: .primaryAction) {
                newSessionMenu
            }
            .sharedBackgroundVisibility(.hidden)
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
                .buttonStyle(AlpineToolbarIconButtonStyle())
                .disabled(model.selectedThread == nil)
            }
            .sharedBackgroundVisibility(.hidden)
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
                isPresented: $showNewSessionSheet)
        }
    }

    /// Primary click opens the scalable chooser. The disclosure menu stays a
    /// genuinely quick path: repeat the current session's target or choose a
    /// different provider for that same project. It deliberately does not
    /// reproduce the full device × project × provider tree.
    @ViewBuilder
    private var newSessionMenu: some View {
        NewSessionSplitControl(onNewSession: { showNewSessionSheet = true }) {
            Button {
                showNewSessionSheet = true
            } label: {
                Label("Choose Target…", systemImage: "slider.horizontal.3")
            }

            if let thread = multi.selectedThread, let project = selectedProject {
                Divider()
                Section(project.name) {
                    Button {
                        createSession(
                            owner: model,
                            projectID: project.id,
                            provider: thread.provider,
                            deviceID: model.deviceID)
                    } label: {
                        ProviderLabel(
                            provider: thread.provider,
                            modelID: thread.modelID,
                            title: "New \(thread.provider.displayName) Session")
                    }

                    Menu("Other Provider") {
                        ForEach(model.configuredProviderKinds) { provider in
                            Button {
                                createSession(
                                    owner: model,
                                    projectID: project.id,
                                    provider: provider,
                                    deviceID: model.deviceID)
                            } label: {
                                ProviderLabel(provider: provider)
                            }
                            .disabled(!model.canCreateThread(with: provider))
                        }
                    }
                }
            }
        }
    }

    private var selectedProject: Project? {
        guard let thread = multi.selectedThread else { return nil }
        return model.projects.first { $0.id == thread.projectID }
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
                scenery: scenery)
            {
                multi.select(threadID: thread.id, on: deviceID)
            }
        }
    }
}
