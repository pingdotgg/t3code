import SwiftUI

// App shell. File kept as ContentView.swift for historical reasons but now
// hosts RootView, the top-level NavigationSplitView wired to AppModel.
struct RootView: View {
    let model: AppModel
    let scenery: SceneryStore

    @UIState private var showInspector = true
    @UIState private var showNewSessionSheet = false

    var body: some View {
        NavigationSplitView {
            SidebarView(model: model, scenery: scenery)
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
        .toolbar {
            ToolbarItem(placement: .navigation) {
                ConnectionStatusPill(phase: model.connection)
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
        }
        .sheet(isPresented: $showNewSessionSheet) {
            NewSessionSheet(model: model, scenery: scenery, isPresented: $showNewSessionSheet)
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
                    if model.runnableProviderKinds.isEmpty {
                        Text("No available providers")
                    }
                    ForEach(model.runnableProviderKinds) { provider in
                        Button {
                            Task {
                                await model.createSceneThread(
                                    projectID: project.id, provider: provider, scenery: scenery)
                            }
                        } label: {
                            Label(provider.displayName, systemImage: "bolt")
                        }
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
