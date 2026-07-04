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
            if let thread = model.selectedThread {
                ThreadDetailView(
                    model: model, scenery: scenery, thread: thread,
                    showInspector: $showInspector)
            } else {
                EmptyStateView(scenery: scenery) {
                    showNewSessionSheet = true
                }
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
                    showInspector.toggle()
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
                    ForEach(ProviderKind.allCases) { provider in
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
