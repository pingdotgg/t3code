import SwiftUI

/// Thread list sidebar. Every project gets a section (even before its first
/// session) so projects are manageable from here directly: the section header
/// starts new sessions, and its context menu renames or deletes the project.
/// Threads are listed newest-updated first (matches `AppModel.threads`'
/// existing sort), each with its alpine scene thumbnail carrying the status
/// dot.
struct SidebarView: View {
    let multi: MultiDeviceModel
    let scenery: SceneryStore
    let passport: PassportStore

    private var model: AppModel { multi.local }

    private struct ProjectActionTarget {
        let model: AppModel
        let project: Project
    }

    @UIState private var renameTarget: ProjectActionTarget?
    @UIState private var renameText = ""
    @UIState private var deleteTarget: ProjectActionTarget?
    @UIState private var forgetTarget: RemoteDeviceSession?

    var body: some View {
        let threadIDs = model.threads.map(\.id)
        List(selection: Binding(
            get: { multi.selection },
            set: { multi.selection = $0 }
        )) {
            ForEach(model.projects) { project in
                // Archived threads live in Settings > Archive, not the sidebar.
                let threadsForProject = visibleThreads(for: project)
                Section {
                    ForEach(threadsForProject) { thread in
                        SidebarThreadRow(
                            thread: thread,
                            vcs: model.threadState(thread.id)?.vcsStatus,
                            scenery: scenery,
                            threadKey: model.scopedThreadKey(thread.id))
                            .tag(ThreadSelection(deviceID: .local, threadID: thread.id))
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
                        scenery: scenery,
                        configuredProviderKinds: model.configuredProviderKinds,
                        canCreateThread: { model.canCreateThread(with: $0) },
                        onNewSession: { provider in
                            Task {
                                if let thread = await model.createSceneThread(
                                    projectID: project.id,
                                    provider: provider,
                                    scenery: scenery,
                                    passport: passport)
                                {
                                    multi.select(threadID: thread.id, on: model.deviceID)
                                }
                            }
                        },
                        onRename: {
                            renameText = project.name
                            renameTarget = ProjectActionTarget(model: model, project: project)
                        },
                        onDelete: {
                            deleteTarget = ProjectActionTarget(model: model, project: project)
                        }
                    )
                }
            }
            ForEach(multi.remoteSessions) { session in
                remoteDeviceSection(session)
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("SurgeCode")
        // New/archived/deleted threads and project changes slide the list
        // smoothly rather than snapping the rows into new positions.
        .animation(Motion.settle, value: threadIDs)
        .animation(Motion.settle, value: model.projects)
        .animation(Motion.settle, value: multi.remoteSessions.map(\.id))
        .alert(
            "Rename Project",
            isPresented: Binding(
                get: { renameTarget != nil },
                set: { if !$0 { renameTarget = nil } }
            )
        ) {
            TextField("Project name", text: $renameText)
            Button("Rename") {
                if let target = renameTarget {
                    Task { await target.model.renameProject(target.project, to: renameText) }
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
                if let target = deleteTarget {
                    Task { await target.model.deleteProject(target.project) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let target = deleteTarget {
                let count = target.model.sessionCount(for: target.project)
                Text(
                    "“\(target.project.name)” and ^[\(count) session](inflect: true) will be removed. Files on disk are not touched."
                )
            }
        }
        .alert(
            "Forget Device?",
            isPresented: Binding(
                get: { forgetTarget != nil },
                set: { if !$0 { forgetTarget = nil } }
            )
        ) {
            Button("Forget", role: .destructive) {
                if let session = forgetTarget {
                    forgetTarget = nil
                    Task { await multi.removeSession(id: session.id) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let session = forgetTarget {
                Text("Remove “\(session.descriptor.name)” from this sidebar?")
            }
        }
    }

    private func visibleThreads(for project: Project) -> [ChatThread] {
        visibleThreads(for: project, in: model)
    }

    private func visibleThreads(for project: Project, in model: AppModel) -> [ChatThread] {
        model.threads.filter { thread in
            thread.projectID == project.id && thread.status != .archived
        }
    }

    @ViewBuilder
    private func remoteDeviceSection(_ session: RemoteDeviceSession) -> some View {
        Section {
            if session.model.projects.isEmpty {
                Text("No projects")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else {
                ForEach(session.model.projects) { project in
                    RemoteProjectSubheaderRow(
                        project: project,
                        onRename: {
                            renameText = project.name
                            renameTarget = ProjectActionTarget(
                                model: session.model, project: project)
                        },
                        onDelete: {
                            deleteTarget = ProjectActionTarget(
                                model: session.model, project: project)
                        })

                    let threadsForProject = visibleThreads(for: project, in: session.model)
                    ForEach(threadsForProject) { thread in
                        SidebarThreadRow(
                            thread: thread,
                            vcs: session.model.threadState(thread.id)?.vcsStatus,
                            scenery: scenery,
                            threadKey: session.model.scopedThreadKey(thread.id))
                            .tag(ThreadSelection(deviceID: session.id, threadID: thread.id))
                            .disabled(session.model.connection != .ready)
                            .opacity(session.model.connection == .ready ? 1 : 0.5)
                            .contextMenu {
                                Button("Archive") {
                                    Task { await session.model.archiveThread(thread) }
                                }
                                Button("Delete", role: .destructive) {
                                    Task { await session.model.deleteThread(thread) }
                                }
                            }
                    }
                    if threadsForProject.isEmpty {
                        Text("No sessions yet")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        } header: {
            DeviceSectionHeader(
                session: session,
                onReconnect: {
                    Task { await multi.reconnect(id: session.id) }
                },
                onForget: { forgetTarget = session })
        }
    }
}

private struct RemoteProjectSubheaderRow: View {
    let project: Project
    let onRename: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack {
            Text(project.name)
                .font(.caption2.smallCaps().weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .padding(.leading, 8)
        .padding(.top, 6)
        .padding(.bottom, 1)
        .listRowSeparator(.hidden)
        .contextMenu {
            Button("Rename…") { onRename() }
            Divider()
            Button("Delete Project…", role: .destructive) { onDelete() }
        }
    }
}

private struct DeviceSectionHeader: View {
    let session: RemoteDeviceSession
    let onReconnect: () -> Void
    let onForget: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "laptopcomputer")
                .foregroundStyle(.secondary)
            Text(session.descriptor.name)
                .lineLimit(1)
            Spacer(minLength: 4)
            DeviceStatusDot(phase: session.connection)
        }
        .contextMenu {
            Button("Reconnect") { onReconnect() }
            Divider()
            Button("Forget…", role: .destructive) { onForget() }
        }
    }
}

private struct DeviceStatusDot: View {
    let phase: ConnectionPhase

    @UIState private var isPulseExpanded = false

    var body: some View {
        ZStack {
            if isConnecting {
                Circle()
                    .stroke(Color.secondary, lineWidth: 1.2)
                    .opacity(pulseOpacity)
                    .scaleEffect(pulseScale)
            }
            Circle()
                .fill(statusTint)
                .frame(width: 7, height: 7)
                .overlay(Circle().strokeBorder(.background, lineWidth: 1.5))
        }
        .frame(width: 11, height: 11)
        .accessibilityLabel(accessibilityLabel)
        .animation(Motion.ambient, value: phase)
        .onAppear { updatePulse(for: phase) }
        .onChange(of: phase) { _, newPhase in
            updatePulse(for: newPhase)
        }
    }

    private var isConnecting: Bool {
        switch phase {
        case .launchingServer, .connecting, .reconnecting:
            return true
        default:
            return false
        }
    }

    private var pulseOpacity: Double {
        Motion.reduceMotion ? 0.35 : (isPulseExpanded ? 0.1 : 0.45)
    }

    private var pulseScale: CGFloat {
        Motion.reduceMotion ? 1.45 : (isPulseExpanded ? 1.85 : 1.0)
    }

    private var statusTint: Color {
        switch phase {
        case .ready:
            return .green
        case .failed:
            return .red
        default:
            return .secondary
        }
    }

    private var accessibilityLabel: String {
        switch phase {
        case .ready:
            return "Ready"
        case .failed:
            return "Connection failed"
        case .launchingServer, .connecting, .reconnecting:
            return "Connecting"
        @unknown default:
            return "Not ready"
        }
    }

    private func updatePulse(for phase: ConnectionPhase) {
        let connecting: Bool
        switch phase {
        case .launchingServer, .connecting, .reconnecting:
            connecting = true
        default:
            connecting = false
        }
        guard connecting, !Motion.reduceMotion else {
            withAnimation(Motion.ambient) {
                isPulseExpanded = false
            }
            return
        }
        isPulseExpanded = false
        withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
            isPulseExpanded = true
        }
    }
}

/// Project section header: name, a plus menu that starts a new session with
/// the chosen provider, and a context menu for scenery, rename, and delete.
private struct ProjectSectionHeader: View {
    let project: Project
    let scenery: SceneryStore
    let configuredProviderKinds: [ProviderKind]
    let canCreateThread: (ProviderKind) -> Bool
    let onNewSession: (ProviderKind) -> Void
    let onRename: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            if let prefs = projectPrefs, prefs.showsProjectBadge {
                ProjectSceneryBadge(prefs: prefs, symbolSize: 10, dotSize: 5)
                Text(project.name)
            } else {
                Text(project.name)
            }
            Spacer()
            Menu {
                if configuredProviderKinds.isEmpty {
                    Text("No providers found")
                }
                ForEach(configuredProviderKinds) { provider in
                    Button(provider.displayName) { onNewSession(provider) }
                        .disabled(!canCreateThread(provider))
                }
            } label: {
                Image(systemName: "plus")
                    .fontWeight(.semibold)
                    .foregroundStyle(.primary)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("New session in \(project.name)")
        }
        .contextMenu {
            Menu("New Session") {
                if configuredProviderKinds.isEmpty {
                    Text("No providers found")
                }
                ForEach(configuredProviderKinds) { provider in
                    Button(provider.displayName) { onNewSession(provider) }
                        .disabled(!canCreateThread(provider))
                }
            }
            Menu("Scenery Set") {
                Button("Default") {
                    setScenerySet(nil)
                }
                Divider()
                if scenery.availableSets.isEmpty {
                    Text("No scenery sets available")
                }
                ForEach(scenery.availableSets) { set in
                    Button {
                        setScenerySet(set.id)
                    } label: {
                        if set.id == resolvedSetId {
                            Label(set.title, systemImage: "checkmark")
                        } else {
                            Text(set.title)
                        }
                    }
                }
            }
            Button("Rename…") { onRename() }
            Divider()
            Button("Delete Project…", role: .destructive) { onDelete() }
        }
    }

    private var projectPrefs: ProjectSceneryPrefs? {
        scenery.projectPrefs(for: project.path)
    }

    private var resolvedSetId: String {
        scenery.resolvedSetId(projectPath: project.path)
    }

    private func setScenerySet(_ setId: String?) {
        var next = projectPrefs ?? ProjectSceneryPrefs()
        next.setId = setId
        scenery.setProjectPrefs(next, forProjectPath: project.path)
    }
}

private struct SidebarThreadRow: View {
    let thread: ChatThread
    let vcs: VcsStatus?
    let scenery: SceneryStore
    let threadKey: String

    var body: some View {
        HStack(spacing: 9) {
            SceneryImageView(
                scenery: scenery, photo: scenery.photo(for: threadKey), variant: .thumb,
                setId: scenery.resolvedSetId(forThread: threadKey),
                fallbackSeed: threadKey
            )
            .frame(width: 28, height: 28)
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay(alignment: .bottomTrailing) {
                HStack(spacing: 2) {
                    if hasOpenPullRequest {
                        pullRequestIndicator
                    }
                    SidebarStatusDot(thread: thread)
                }
                .offset(x: 2, y: 2)
                .animation(Motion.ambient, value: thread.status)
                .animation(Motion.ambient, value: hasOpenPullRequest)
            }
            let names = scenery.displayNames(for: thread, threadKey: threadKey)
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

    private var hasOpenPullRequest: Bool {
        vcs?.prState == .open
    }

    private var pullRequestIndicator: some View {
        Image(systemName: "arrow.triangle.pull")
            .font(.system(size: 7, weight: .bold))
            .foregroundStyle(.tint)
            .frame(width: 12, height: 12)
            .background(Circle().fill(.background))
            .help(vcs?.prNumber.map { "PR #\($0)" } ?? "Open pull request")
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
