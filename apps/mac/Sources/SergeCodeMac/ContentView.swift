import SwiftUI

// App shell. File kept as ContentView.swift for historical reasons but now
// hosts RootView, the top-level NavigationSplitView wired to AppModel.
struct RootView: View {
    let model: AppModel
    let scenery: SceneryStore
    let passport: PassportStore

    @UIState private var showInspector = true
    @UIState private var showAgentsPanel = false
    @UIState private var showNewSessionSheet = false
    @UIState private var showPassportSheet = false
    @UIState private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        // Drag-collapse writes visibility through this binding; wrapping
        // the set animates the snap-closed instead of an instant jump.
        NavigationSplitView(columnVisibility: Binding(
            get: { columnVisibility },
            set: { newValue in
                withAnimation(Motion.snap) {
                    columnVisibility = newValue
                }
            }
        )) {
            SidebarView(model: model, scenery: scenery, passport: passport)
                .navigationSplitViewColumnWidth(min: 220, ideal: 280)
        } detail: {
            Group {
                if let thread = model.selectedThread {
                    ThreadDetailView(model: model, scenery: scenery, thread: thread)
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
            .animation(Motion.settle, value: model.selectedThread == nil)
            // The inspector hangs off this stable node, not off the
            // per-thread detail view: re-presenting it on every thread
            // switch (and inside the cross-fade above) reset its column
            // width and flashed/clipped the panel.
            .inspector(isPresented: $showInspector) {
                Group {
                    if let thread = model.selectedThread {
                        InspectorPanel(model: model, threadID: thread.id)
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
                model: model,
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
            if model.projects.isEmpty {
                Text("No projects yet")
            }
            ForEach(model.projects) { project in
                Menu(project.name) {
                    if model.configuredProviderKinds.isEmpty {
                        Text("No providers found")
                    }
                    ForEach(model.configuredProviderKinds) { provider in
                        Button {
                            Task {
                                await model.createSceneThread(
                                    projectID: project.id,
                                    provider: provider,
                                    scenery: scenery,
                                    passport: passport)
                            }
                        } label: {
                            Label(provider.displayName, systemImage: "bolt")
                        }
                        .disabled(!model.canCreateThread(with: provider))
                    }
                }
            }
            Divider()
            Button {
                showNewSessionSheet = true
            } label: {
                Label("Add Project…", systemImage: "folder.badge.plus")
            }
        } label: {
            Label("New Session", systemImage: "plus")
        }
    }
}
