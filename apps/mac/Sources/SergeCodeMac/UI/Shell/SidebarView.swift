import SwiftUI

/// Thread list sidebar. Not owned by any of the original six feature agents
/// (a gap in the disjoint-file split — `ContentView.swift`'s `RootView`
/// referenced it but nothing defined it) so it was added during integration
/// to close out the `NavigationSplitView` contract. Lists threads grouped by
/// project, newest-updated first (matches `AppModel.threads`' existing sort),
/// with each thread's alpine scene thumbnail carrying the status dot.
struct SidebarView: View {
    let model: AppModel
    let scenery: SceneryStore

    var body: some View {
        List(selection: Binding(
            get: { model.selectedThreadID },
            set: { model.selectedThreadID = $0 }
        )) {
            ForEach(model.projects) { project in
                // Archived threads live in Settings > Archive, not the sidebar.
                let threadsForProject = model.threads.filter {
                    $0.projectID == project.id && $0.status != .archived
                }
                if !threadsForProject.isEmpty {
                    Section(project.name) {
                        ForEach(threadsForProject) { thread in
                            SidebarThreadRow(thread: thread, scenery: scenery)
                                .tag(thread.id)
                                .contextMenu {
                                    Button("Archive") {
                                        Task { await model.archiveThread(thread) }
                                    }
                                    Button("Delete", role: .destructive) {
                                        Task { await model.deleteThread(thread) }
                                    }
                                }
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("SergeCode")
    }
}

private struct SidebarThreadRow: View {
    let thread: ChatThread
    let scenery: SceneryStore

    var body: some View {
        HStack(spacing: 9) {
            SceneryImageView(
                scenery: scenery, photo: scenery.photo(for: thread.id), variant: .thumb,
                fallbackSeed: thread.id
            )
            .frame(width: 28, height: 28)
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay(alignment: .bottomTrailing) {
                Circle()
                    .fill(statusTint)
                    .frame(width: 7, height: 7)
                    .overlay(Circle().strokeBorder(.background, lineWidth: 1.5))
                    .offset(x: 2, y: 2)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(thread.title)
                    .lineLimit(1)
                Text(thread.provider.displayName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private var statusTint: Color {
        switch thread.status {
        case .idle: .secondary
        case .running: .green
        case .waitingApproval: .yellow
        case .error: .red
        case .archived: .gray
        }
    }
}
