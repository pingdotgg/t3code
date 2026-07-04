import SwiftUI

/// Thread list sidebar. Not owned by any of the original six feature agents
/// (a gap in the disjoint-file split — `ContentView.swift`'s `RootView`
/// referenced it but nothing defined it) so it was added during integration
/// to close out the `NavigationSplitView` contract. Lists threads grouped by
/// project, newest-updated first (matches `AppModel.threads`' existing sort),
/// with a status dot and provider label per row.
struct SidebarView: View {
    let model: AppModel

    var body: some View {
        List(selection: Binding(
            get: { model.selectedThreadID },
            set: { model.selectedThreadID = $0 }
        )) {
            ForEach(model.projects) { project in
                let threadsForProject = model.threads.filter { $0.projectID == project.id }
                if !threadsForProject.isEmpty {
                    Section(project.name) {
                        ForEach(threadsForProject) { thread in
                            SidebarThreadRow(thread: thread)
                                .tag(thread.id)
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

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(statusTint)
                .frame(width: 6, height: 6)
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
