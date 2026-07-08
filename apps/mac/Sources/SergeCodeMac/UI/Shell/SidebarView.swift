import SwiftUI

/// Thread list sidebar. Every project gets a section (even before its first
/// session) so projects are manageable from here directly: the section header
/// starts new sessions, and its context menu renames or deletes the project.
/// Threads are listed newest-updated first (matches `AppModel.threads`'
/// existing sort), each with its alpine scene thumbnail carrying the status
/// dot.
struct SidebarView: View {
    let model: AppModel
    let scenery: SceneryStore

    @UIState private var renameTarget: Project?
    @UIState private var renameText = ""
    @UIState private var deleteTarget: Project?

    var body: some View {
        List(selection: Binding(
            get: { model.selectedThreadID },
            set: { model.selectedThreadID = $0 }
        )) {
            ForEach(model.projects) { project in
                // Archived threads live in Settings > Archive, not the sidebar.
                let threadsForProject = visibleThreads(for: project)
                Section {
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
                    if threadsForProject.isEmpty {
                        Text("No sessions yet")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                } header: {
                    ProjectSectionHeader(
                        project: project,
                        onNewSession: { provider in
                            Task {
                                await model.createSceneThread(
                                    projectID: project.id, provider: provider, scenery: scenery)
                            }
                        },
                        onRename: {
                            renameText = project.name
                            renameTarget = project
                        },
                        onDelete: { deleteTarget = project }
                    )
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("SurgeCode")
        // New/archived/deleted threads and project changes slide the list
        // smoothly rather than snapping the rows into new positions.
        .animation(Motion.settle, value: model.threads.map(\.id))
        .animation(Motion.settle, value: model.projects)
        .alert(
            "Rename Project",
            isPresented: Binding(
                get: { renameTarget != nil },
                set: { if !$0 { renameTarget = nil } }
            )
        ) {
            TextField("Project name", text: $renameText)
            Button("Rename") {
                if let project = renameTarget {
                    Task { await model.renameProject(project, to: renameText) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Only the display name changes; the project folder stays where it is.")
        }
        .alert(
            "Delete Project?",
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            )
        ) {
            Button("Delete", role: .destructive) {
                if let project = deleteTarget {
                    Task { await model.deleteProject(project) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let project = deleteTarget {
                let count = model.sessionCount(for: project)
                Text(
                    "“\(project.name)” and ^[\(count) session](inflect: true) will be removed. Files on disk are not touched."
                )
            }
        }
    }

    private func visibleThreads(for project: Project) -> [ChatThread] {
        model.threads.filter { thread in
            thread.projectID == project.id && thread.status != .archived
        }
    }
}

/// Project section header: name, a plus menu that starts a new session with
/// the chosen provider, and a context menu for rename/delete.
private struct ProjectSectionHeader: View {
    let project: Project
    let onNewSession: (ProviderKind) -> Void
    let onRename: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(project.name)
            Spacer()
            Menu {
                ForEach(ProviderKind.allCases) { provider in
                    Button(provider.displayName) { onNewSession(provider) }
                }
            } label: {
                Image(systemName: "plus")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("New session in \(project.name)")
        }
        .contextMenu {
            Menu("New Session") {
                ForEach(ProviderKind.allCases) { provider in
                    Button(provider.displayName) { onNewSession(provider) }
                }
            }
            Button("Rename…") { onRename() }
            Divider()
            Button("Delete Project…", role: .destructive) { onDelete() }
        }
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
                SidebarStatusDot(thread: thread)
                    .offset(x: 2, y: 2)
            }
            let names = scenery.displayNames(for: thread)
            VStack(alignment: .leading, spacing: 2) {
                Text(names.primary)
                    .lineLimit(1)
                // The AI-generated thread description once the server has
                // retitled past the scene seed; provider name until then.
                Text(names.description ?? thread.provider.displayName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }

}

private struct SidebarStatusDot: View {
    let thread: ChatThread

    @UIState private var isBackgroundPulseExpanded = false

    var body: some View {
        Group {
            if thread.status == .backgroundWork {
                backgroundWorkDot
            } else {
                dot
            }
        }
        .frame(width: 11, height: 11)
        .accessibilityLabel(accessibilityLabel)
        .animation(Motion.ambient, value: thread.status)
        .onAppear { updatePulse(for: thread.status) }
        .onChange(of: thread.status) { _, status in
            updatePulse(for: status)
        }
    }

    private var dot: some View {
        Circle()
            .fill(statusTint)
            .frame(width: 7, height: 7)
            .overlay(Circle().strokeBorder(.background, lineWidth: 1.5))
    }

    private var backgroundWorkDot: some View {
        ZStack {
            Circle()
                .stroke(Color.green, lineWidth: 1.2)
                .opacity(backgroundPulseOpacity)
                .scaleEffect(backgroundPulseScale)
            dot
        }
    }

    private var backgroundPulseOpacity: Double {
        Motion.reduceMotion ? 0.35 : (isBackgroundPulseExpanded ? 0.1 : 0.45)
    }

    private var backgroundPulseScale: CGFloat {
        Motion.reduceMotion ? 1.45 : (isBackgroundPulseExpanded ? 1.85 : 1.0)
    }

    private func updatePulse(for status: ThreadStatus) {
        guard status == .backgroundWork, !Motion.reduceMotion else {
            withAnimation(Motion.ambient) {
                isBackgroundPulseExpanded = false
            }
            return
        }
        isBackgroundPulseExpanded = false
        withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
            isBackgroundPulseExpanded = true
        }
    }

    private var accessibilityLabel: String {
        switch thread.status {
        case .backgroundWork:
            let count = max(1, thread.backgroundAgentCount)
            return "\(count) background agent\(count == 1 ? "" : "s") running"
        case .idle:
            return "Idle"
        case .running:
            return "Running"
        case .waitingApproval:
            return "Needs approval"
        case .error:
            return "Error"
        case .archived:
            return "Archived"
        }
    }

    private var statusTint: Color {
        switch thread.status {
        case .idle: .secondary
        case .running: .green
        case .waitingApproval: .yellow
        case .backgroundWork: .green
        case .error: .red
        case .archived: .gray
        }
    }
}
