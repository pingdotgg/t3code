import SwiftUI

private enum SidebarRowContext {
    case shortcut
    case project(showMachine: Bool)
    case search
}

/// A project-first sidebar that presents local and remote sessions in one
/// hierarchy. Attention shortcuts stay compact at the top, while Projects is
/// the canonical home for ordering and managing each session.
struct SidebarView: View {
    let multi: MultiDeviceModel
    let scenery: SceneryStore
    let passport: PassportStore

    private struct ProjectActionTarget {
        let model: AppModel
        let project: Project
    }

    private struct ThreadActionTarget {
        let model: AppModel
        let thread: ChatThread
    }

    @UIState private var renameTarget: ProjectActionTarget?
    @UIState private var renameText = ""
    @UIState private var deleteTarget: ProjectActionTarget?
    @UIState private var deleteThreadTarget: ThreadActionTarget?
    @UIState private var forgetTarget: RemoteDeviceSession?
    @UIState private var searchText = ""

    @AppStorage("sidebarMachineScope") private var machineScopeStorage =
        SidebarMachineScope.allStorageValue
    @AppStorage("sidebarCollapsedProjects") private var collapsedProjectsData = Data()
    @UIState private var collapsedProjects: Set<String> = []

    private var machineScope: SidebarMachineScope {
        SidebarMachineScope(storageValue: machineScopeStorage)
    }

    private var locations: [SidebarLocation] {
        SidebarProjection.locations(in: multi)
    }

    private var projectGroups: [SidebarProjectGroup] {
        SidebarProjection.projectGroups(in: multi, scope: machineScope)
            .filter { !$0.threads.isEmpty }
    }

    private var attentionThreads: [SidebarThreadItem] {
        SidebarProjection.attentionThreads(in: projectGroups)
    }

    private var runningThreads: [SidebarThreadItem] {
        SidebarProjection.runningThreads(in: projectGroups)
    }

    private var pinnedThreads: [SidebarThreadItem] {
        SidebarProjection.pinnedThreads(in: projectGroups)
    }

    private var searchResults: [SidebarThreadItem] {
        SidebarProjection.searchResults(in: projectGroups, query: searchText)
    }

    private var isSearching: Bool {
        !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            SidebarCommandBar(
                searchText: $searchText,
                locations: locations,
                scope: machineScope,
                onSelectScope: setMachineScope)

            List(selection: Binding(
                get: { multi.selection },
                set: { multi.selection = $0 }
            )) {
                if isSearching {
                    searchSection
                } else {
                    smartSections
                    projectSections
                }
            }
            .listStyle(.sidebar)

            Divider()
            SidebarConnectionsFooter(
                locations: locations,
                remoteSessions: multi.remoteSessions,
                scope: machineScope,
                onSelectScope: setMachineScope,
                onReconnect: { session in
                    Task { await multi.reconnect(id: session.id) }
                },
                onForget: { forgetTarget = $0 })
        }
        .navigationTitle("SurgeCode")
        .onAppear {
            loadCollapsedProjects()
            validateMachineScope()
        }
        .onChange(of: multi.remoteSessions.map(\.id)) {
            validateMachineScope()
        }
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
            "Delete Session?",
            isPresented: Binding(
                get: { deleteThreadTarget != nil },
                set: { if !$0 { deleteThreadTarget = nil } }
            )
        ) {
            Button("Delete", role: .destructive) {
                if let target = deleteThreadTarget {
                    deleteThreadTarget = nil
                    Task { await target.model.deleteThread(target.thread) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let target = deleteThreadTarget {
                Text("“\(target.thread.title)” will be permanently deleted. This can't be undone.")
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
                    Task { await multi.removeRemoteDevice(id: session.id) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let session = forgetTarget {
                Text("Remove “\(session.descriptor.name)” from this sidebar?")
            }
        }
    }

    @ViewBuilder
    private var searchSection: some View {
        Section {
            if searchResults.isEmpty {
                SidebarEmptyRow(
                    title: "No matching tasks",
                    systemImage: "magnifyingglass",
                    detail: "Try a task, project, branch, or machine name.")
            } else {
                ForEach(searchResults, id: \.id) { item in
                    threadRow(item, context: .search)
                }
            }
        } header: {
            SidebarSectionLabel(title: "Results", count: searchResults.count)
        }
    }

    @ViewBuilder
    private var smartSections: some View {
        if !attentionThreads.isEmpty {
            Section {
                ForEach(attentionThreads, id: \.id) { item in
                    threadRow(item, context: .shortcut)
                }
            } header: {
                SidebarSectionLabel(
                    title: "Needs you", count: attentionThreads.count, tint: AlpineTheme.clay)
            }
        }

        if !runningThreads.isEmpty {
            Section {
                ForEach(runningThreads, id: \.id) { item in
                    threadRow(item, context: .shortcut)
                }
            } header: {
                SidebarSectionLabel(
                    title: "Running", count: runningThreads.count, tint: AlpineTheme.meadow)
            }
        }

        if !pinnedThreads.isEmpty {
            Section {
                ForEach(pinnedThreads, id: \.id) { item in
                    threadRow(item, context: .shortcut)
                }
            } header: {
                SidebarSectionLabel(title: "Pinned", count: pinnedThreads.count)
            }
        }
    }

    @ViewBuilder
    private var projectSections: some View {
        if projectGroups.isEmpty {
            Section {
                SidebarEmptyRow(
                    title: "No active tasks",
                    systemImage: "tray",
                    detail: emptyProjectMessage)
            } header: {
                SidebarSectionLabel(title: "Projects")
            }
        } else {
            ForEach(projectGroups) { group in
                let isCollapsed = collapsedProjects.contains(group.id)
                Section {
                    if !isCollapsed {
                        ForEach(group.threads, id: \.id) { item in
                            threadRow(
                                item,
                                context: .project(showMachine: group.members.count > 1))
                        }
                        .onMove { offsets, destination in
                            moveThreads(in: group, fromOffsets: offsets, toOffset: destination)
                        }
                    }
                } header: {
                    ProjectSectionHeader(
                        group: group,
                        scenery: scenery,
                        isCollapsed: isCollapsed,
                        onToggleCollapse: { toggleProjectCollapse(group.id) },
                        onNewSession: createThread,
                        onRename: beginRename,
                        onDelete: { member in
                            deleteTarget = ProjectActionTarget(
                                model: member.location.model, project: member.project)
                        })
                }
            }
        }
    }

    @ViewBuilder
    private func threadRow(_ item: SidebarThreadItem, context: SidebarRowContext) -> some View {
        SidebarThreadRow(item: item, context: context)
            .tag(item.id)
            .disabled(!item.isSelectable)
            .opacity(item.isSelectable ? 1 : 0.5)
            .contextMenu {
                let model = item.member.location.model
                Button(
                    item.isPinned ? "Unpin" : "Pin",
                    systemImage: item.isPinned ? "pin.slash" : "pin")
                {
                    model.togglePinned(item.thread)
                }
                .disabled(!item.isSelectable)
                Divider()
                Button("Archive", systemImage: "archivebox") {
                    Task { await model.archiveThread(item.thread) }
                }
                .disabled(!item.isSelectable)
                Button("Delete", systemImage: "trash", role: .destructive) {
                    deleteThreadTarget = ThreadActionTarget(model: model, thread: item.thread)
                }
                .disabled(!item.isSelectable)
                Divider()
                Button("Move Up", systemImage: "arrow.up") {
                    model.moveThread(item.thread, direction: .up)
                }
                .disabled(
                    !item.isSelectable || !model.canMoveThread(item.thread, direction: .up))
                Button("Move Down", systemImage: "arrow.down") {
                    model.moveThread(item.thread, direction: .down)
                }
                .disabled(
                    !item.isSelectable || !model.canMoveThread(item.thread, direction: .down))
            }
    }

    private var emptyProjectMessage: String {
        switch machineScope {
        case .all: "Start a new task or choose another connection."
        case .device: "Start a new task or switch to All machines."
        }
    }

    private func createThread(_ member: SidebarProjectMember, provider: ProviderKind) {
        Task {
            guard member.location.isReady else { return }
            let model = member.location.model
            if let thread = await model.createSceneThread(
                projectID: member.project.id,
                provider: provider,
                scenery: scenery,
                passport: passport)
            {
                multi.select(threadID: thread.id, on: member.location.id)
            }
        }
    }

    private func beginRename(_ member: SidebarProjectMember) {
        renameText = member.project.name
        renameTarget = ProjectActionTarget(
            model: member.location.model, project: member.project)
    }

    private func moveThreads(
        in group: SidebarProjectGroup,
        fromOffsets: IndexSet,
        toOffset: Int
    ) {
        let sourceMembers = Set(fromOffsets.compactMap { offset in
            group.threads.indices.contains(offset) ? group.threads[offset].member.id : nil
        })
        guard sourceMembers.count == 1, let memberID = sourceMembers.first,
            let member = group.members.first(where: { $0.id == memberID })
        else { return }

        var reordered = group.threads
        reordered.move(fromOffsets: fromOffsets, toOffset: toOffset)
        member.location.model.applySidebarOrder(
            reordered.filter { $0.member.id == memberID }.map(\.thread),
            projectID: member.project.id)
    }

    private func setMachineScope(_ scope: SidebarMachineScope) {
        machineScopeStorage = scope.storageValue
    }

    private func validateMachineScope() {
        guard case .device(let id) = machineScope,
            !locations.contains(where: { $0.id == id })
        else { return }
        setMachineScope(.all)
    }

    private func loadCollapsedProjects() {
        if let decoded = try? JSONDecoder().decode(Set<String>.self, from: collapsedProjectsData) {
            collapsedProjects = decoded
        }
    }

    private func saveCollapsedProjects() {
        if let encoded = try? JSONEncoder().encode(collapsedProjects) {
            collapsedProjectsData = encoded
        }
    }

    private func toggleProjectCollapse(_ projectID: String) {
        withAnimation(Motion.feedback) {
            if collapsedProjects.contains(projectID) {
                collapsedProjects.remove(projectID)
            } else {
                collapsedProjects.insert(projectID)
            }
        }
        saveCollapsedProjects()
    }
}

private struct SidebarCommandBar: View {
    @Binding var searchText: String
    let locations: [SidebarLocation]
    let scope: SidebarMachineScope
    let onSelectScope: (SidebarMachineScope) -> Void

    @UIState private var isScopePresented = false

    var body: some View {
        HStack(spacing: 7) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField("Search tasks", text: $searchText)
                    .textFieldStyle(.plain)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 28)
            .background(.quaternary.opacity(0.7), in: RoundedRectangle(cornerRadius: 7))

            Button {
                isScopePresented.toggle()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: scopeSymbol)
                    Text(scopeTitle)
                        .lineLimit(1)
                }
                .font(.caption.weight(.medium))
                .frame(height: 28)
                .padding(.horizontal, 7)
                .background(
                    Color.primary.opacity(isScopePresented ? 0.11 : 0.055),
                    in: RoundedRectangle(cornerRadius: 7))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Filter tasks by machine")
            .popover(isPresented: $isScopePresented, arrowEdge: .top) {
                scopePopover
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    private var scopePopover: some View {
        ComposerPickerSurface(width: 320) {
            VStack(spacing: 0) {
                ComposerPickerHeader(
                    icon: "rectangle.3.group",
                    title: "Task scope",
                    subtitle: "Choose which machines appear in the sidebar"
                )
                Divider().opacity(0.55)
                VStack(spacing: 3) {
                    ComposerPickerChoiceRow(
                        icon: "rectangle.3.group",
                        title: "All machines",
                        detail: "Local and remote tasks together",
                        isSelected: scope == .all
                    ) {
                        onSelectScope(.all)
                        isScopePresented = false
                    }
                    ForEach(locations) { location in
                        ComposerPickerChoiceRow(
                            icon: location.isLocal ? "desktopcomputer" : "laptopcomputer",
                            title: location.name,
                            detail: location.connection.statusText,
                            isSelected: scope == .device(location.id)
                        ) {
                            onSelectScope(.device(location.id))
                            isScopePresented = false
                        }
                    }
                }
                .padding(8)
            }
        }
    }

    private var scopeTitle: String {
        switch scope {
        case .all: "All"
        case .device(let id): locations.first(where: { $0.id == id })?.name ?? "All"
        }
    }

    private var scopeSymbol: String {
        switch scope {
        case .all: "rectangle.3.group"
        case .device(let id): id == .local ? "desktopcomputer" : "laptopcomputer"
        }
    }
}

private struct SidebarSectionLabel: View {
    let title: String
    var count: Int?
    var tint: Color?

    init(title: String, count: Int? = nil, tint: Color? = nil) {
        self.title = title
        self.count = count
        self.tint = tint
    }

    var body: some View {
        HStack(spacing: 5) {
            if let tint {
                Circle()
                    .fill(tint)
                    .frame(width: 5, height: 5)
            }
            Text(title)
            if let count {
                Text("\(count)")
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

private struct SidebarEmptyRow: View {
    let title: String
    let systemImage: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: systemImage)
                .foregroundStyle(.tertiary)
                .frame(width: 15)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .foregroundStyle(.secondary)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct SidebarProviderChoiceRow: View {
    let provider: ProviderKind
    var detail: String?
    let isEnabled: Bool
    let action: () -> Void

    @UIState private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                ProviderIcon(provider: provider, size: 15)
                    .foregroundStyle(isEnabled ? AlpineTheme.forest : Color.secondary)
                    .frame(width: 28, height: 28)
                    .background(
                        isEnabled ? AlpineTheme.accent.opacity(0.85) : Color.secondary.opacity(0.09),
                        in: RoundedRectangle(cornerRadius: 7, style: .continuous))

                VStack(alignment: .leading, spacing: 1) {
                    Text(provider.displayName)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.primary)
                    if let detail {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 8)
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .opacity(isHovering && isEnabled ? 1 : 0)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
            .background {
                RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
                    .fill(isHovering && isEnabled ? Color.primary.opacity(0.075) : .clear)
            }
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.55)
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
    }
}

private struct ProjectSectionHeader: View {
    let group: SidebarProjectGroup
    let scenery: SceneryStore
    let isCollapsed: Bool
    let onToggleCollapse: () -> Void
    let onNewSession: (SidebarProjectMember, ProviderKind) -> Void
    let onRename: (SidebarProjectMember) -> Void
    let onDelete: (SidebarProjectMember) -> Void

    @UIState private var isNewTaskPresented = false

    var body: some View {
        HStack(spacing: 6) {
            Button(action: onToggleCollapse) {
                Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 12, height: 12)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isCollapsed ? "Expand \(group.name)" : "Collapse \(group.name)")

            projectBadge
            Text(group.name)
                .fontWeight(.semibold)
                .lineLimit(1)
            Spacer(minLength: 4)
            if group.attentionThreadCount > 0 {
                Text("\(group.attentionThreadCount) need you")
                    .foregroundStyle(AlpineTheme.clay)
            } else if group.activeThreadCount > 0 {
                Text("\(group.activeThreadCount) active")
                    .foregroundStyle(.secondary)
            }
            Button {
                isNewTaskPresented.toggle()
            } label: {
                Image(systemName: "plus")
                    .fontWeight(.semibold)
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
                    .background {
                        if isNewTaskPresented {
                            RoundedRectangle(cornerRadius: 5)
                                .fill(Color.primary.opacity(0.1))
                        }
                    }
            }
            .buttonStyle(.plain)
            .help("New task in \(group.name)")
            .popover(isPresented: $isNewTaskPresented, arrowEdge: .top) {
                newTaskPopover
            }
        }
        .font(.caption)
        .contentShape(Rectangle())
        .onTapGesture(perform: onToggleCollapse)
        .animation(Motion.feedback, value: isCollapsed)
        .contextMenu {
            memberActionButtons(title: "Rename…", action: onRename)
            Menu("Scenery Set") {
                sceneryMenuContent
            }
            Divider()
            memberActionButtons(title: "Delete Project…", destructive: true, action: onDelete)
        }
    }

    @ViewBuilder
    private var projectBadge: some View {
        if let prefs = projectPrefs, prefs.showsProjectBadge {
            ProjectSceneryBadge(prefs: prefs, symbolSize: 10, dotSize: 6)
                .frame(width: 12, height: 12)
        } else {
            Image(systemName: "folder.fill")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.tertiary)
                .frame(width: 12, height: 12)
        }
    }

    private var newTaskPopover: some View {
        ComposerPickerSurface(width: 340) {
            VStack(spacing: 0) {
                ComposerPickerHeader(
                    icon: "plus",
                    title: "New task",
                    subtitle: group.name
                )
                Divider().opacity(0.55)
                ScrollView {
                    VStack(spacing: 3) {
                        ForEach(group.members, id: \.id) { member in
                            ComposerPickerSectionLabel(title: member.location.name)
                            let providers = member.location.model.configuredProviderKinds
                            if providers.isEmpty {
                                Text("No providers configured")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 8)
                            } else {
                                ForEach(providers) { provider in
                                    SidebarProviderChoiceRow(
                                        provider: provider,
                                        detail: member.location.isReady
                                            ? nil : member.location.connection.statusText,
                                        isEnabled: member.location.isReady
                                            && member.location.model.canCreateThread(with: provider)
                                    ) {
                                        onNewSession(member, provider)
                                        isNewTaskPresented = false
                                    }
                                }
                            }
                        }
                    }
                    .padding(8)
                }
                .frame(maxHeight: 420)
            }
        }
    }

    @ViewBuilder
    private func memberActionButtons(
        title: String,
        destructive: Bool = false,
        action: @escaping (SidebarProjectMember) -> Void
    ) -> some View {
        if group.members.count == 1, let member = group.members.first {
            if destructive {
                Button(title, role: .destructive) { action(member) }
                    .disabled(!member.location.isReady)
            } else {
                Button(title) { action(member) }
                    .disabled(!member.location.isReady)
            }
        } else {
            ForEach(group.members, id: \.id) { member in
                if destructive {
                    Button("\(title.dropLast()) on \(member.location.name)…", role: .destructive) {
                        action(member)
                    }
                    .disabled(!member.location.isReady)
                } else {
                    Button("\(title.dropLast()) on \(member.location.name)…") {
                        action(member)
                    }
                        .disabled(!member.location.isReady)
                }
            }
        }
    }

    @ViewBuilder
    private var sceneryMenuContent: some View {
        Button("Default") { setScenerySet(nil) }
        Divider()
        if scenery.availableSets.isEmpty {
            Text("No scenery sets available")
        }
        ForEach(scenery.availableSets) { set in
            Button {
                setScenerySet(set.id)
            } label: {
                if set.id == resolvedSetID {
                    Label(set.title, systemImage: "checkmark")
                } else {
                    Text(set.title)
                }
            }
        }
    }

    private var projectPrefs: ProjectSceneryPrefs? {
        scenery.projectPrefs(for: group.preferredMember.project.path)
    }

    private var resolvedSetID: String {
        scenery.resolvedSetId(projectPath: group.preferredMember.project.path)
    }

    private func setScenerySet(_ setID: String?) {
        let project = group.preferredMember.project
        var next = projectPrefs ?? ProjectSceneryPrefs()
        next.setId = setID
        scenery.setProjectPrefs(next, forProjectPath: project.path)
    }
}

private struct SidebarThreadRow: View {
    let item: SidebarThreadItem
    let context: SidebarRowContext

    var body: some View {
        HStack(spacing: 8) {
            SidebarThreadStatus(item: item)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(item.thread.title)
                        .lineLimit(1)
                    if item.isPinned {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(.tint)
                            .accessibilityLabel("Pinned")
                    }
                }
                Text(secondaryText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if item.thread.backgroundAgentCount > 0 {
                Text("\(item.thread.backgroundAgentCount)")
                    .font(.caption2.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
                    .help("Background agents")
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var secondaryText: String {
        let parts: [String]
        switch context {
        case .shortcut:
            parts = [item.statusLabel, item.member.project.name, item.member.location.name]
        case .search:
            parts = [item.member.project.name, item.member.location.name, workMetadata]
        case .project(let showMachine):
            parts = [showMachine ? item.member.location.name : nil, workMetadata]
                .compactMap { $0 }
        }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var workMetadata: String {
        var parts: [String] = []
        if let branch = item.vcs?.branch, !branch.isEmpty {
            parts.append(branch)
        }
        if let prNumber = item.vcs?.prNumber {
            parts.append("PR #\(prNumber)")
        }
        if parts.isEmpty {
            parts.append(item.thread.provider.displayName)
        }
        return parts.joined(separator: " · ")
    }
}

private struct SidebarThreadStatus: View {
    let item: SidebarThreadItem

    var body: some View {
        Image(systemName: symbolName)
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 14, height: 14)
            .accessibilityLabel(item.statusLabel)
            .help(item.statusLabel)
            .contentTransition(Motion.reduceMotion ? .identity : .symbolEffect(.replace))
            .animation(Motion.ambient, value: item.thread.status)
    }

    private var tint: Color {
        if item.hasConnectionIssue { return item.member.location.connection.statusColor }
        if item.thread.isStalled { return AlpineTheme.clay }
        switch item.thread.status {
        case .idle: return .secondary
        case .running: return AlpineTheme.accent
        case .waiting: return AlpineTheme.sky
        case .waitingApproval: return AlpineTheme.lichen
        case .backgroundWork: return AlpineTheme.meadow
        case .error: return .red
        case .archived: return .gray
        }
    }

    private var symbolName: String {
        if item.hasConnectionIssue { return item.member.location.connection.symbolName }
        if item.thread.isStalled { return "exclamationmark.circle.fill" }
        switch item.thread.status {
        case .backgroundWork: return "person.2.fill"
        case .idle: return "circle.fill"
        case .running: return "bolt.fill"
        case .waiting: return "clock.fill"
        case .waitingApproval: return "exclamationmark.circle.fill"
        case .error: return "xmark.octagon.fill"
        case .archived: return "archivebox.fill"
        }
    }
}

private struct SidebarConnectionsFooter: View {
    let locations: [SidebarLocation]
    let remoteSessions: [RemoteDeviceSession]
    let scope: SidebarMachineScope
    let onSelectScope: (SidebarMachineScope) -> Void
    let onReconnect: (RemoteDeviceSession) -> Void
    let onForget: (RemoteDeviceSession) -> Void

    @UIState private var isPresented = false

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "network")
                    .foregroundStyle(.secondary)
                Text("Connections")
                Spacer(minLength: 4)
                HStack(spacing: 3) {
                    ForEach(locations.prefix(4)) { location in
                        Circle()
                            .fill(location.connection.statusColor)
                            .frame(width: 5, height: 5)
                            .accessibilityHidden(true)
                    }
                }
                Text("\(readyCount)/\(locations.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .font(.caption.weight(.medium))
            .padding(.horizontal, 11)
            .frame(height: 34)
            .contentShape(Rectangle())
            .background {
                if isPresented {
                    Rectangle().fill(Color.primary.opacity(0.055))
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Connections, \(readyCount) of \(locations.count) ready")
        .popover(isPresented: $isPresented, arrowEdge: .top) {
            connectionPopover
        }
    }

    private var connectionPopover: some View {
        ComposerPickerSurface(width: 360) {
            VStack(spacing: 0) {
                ComposerPickerHeader(
                    icon: "network",
                    title: "Connections",
                    subtitle: "\(readyCount) of \(locations.count) machines ready"
                )
                Divider().opacity(0.55)
                ScrollView {
                    VStack(spacing: 3) {
                        ComposerPickerSectionLabel(title: "Task scope")
                        ComposerPickerChoiceRow(
                            icon: "rectangle.3.group",
                            title: "All machines",
                            detail: "Local and remote tasks together",
                            isSelected: scope == .all
                        ) {
                            onSelectScope(.all)
                            isPresented = false
                        }
                        ForEach(locations) { location in
                            ComposerPickerChoiceRow(
                                icon: location.isLocal ? "desktopcomputer" : "laptopcomputer",
                                title: location.name,
                                detail: location.connection.statusText,
                                isSelected: scope == .device(location.id)
                            ) {
                                onSelectScope(.device(location.id))
                                isPresented = false
                            }
                        }

                        if !remoteSessions.isEmpty {
                            Divider()
                                .opacity(0.45)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 5)
                            ComposerPickerSectionLabel(title: "Remote connections")
                            ForEach(remoteSessions) { session in
                                SidebarConnectionManagementRow(
                                    session: session,
                                    isSelected: scope == .device(session.id),
                                    onShowTasks: {
                                        onSelectScope(.device(session.id))
                                        isPresented = false
                                    },
                                    onReconnect: { onReconnect(session) },
                                    onForget: {
                                        isPresented = false
                                        onForget(session)
                                    })
                            }
                        }
                    }
                    .padding(8)
                }
                .frame(maxHeight: 480)
            }
        }
    }

    private var readyCount: Int {
        locations.filter { $0.connection == .ready }.count
    }
}

private struct SidebarConnectionManagementRow: View {
    let session: RemoteDeviceSession
    let isSelected: Bool
    let onShowTasks: () -> Void
    let onReconnect: () -> Void
    let onForget: () -> Void

    @UIState private var isHovering = false

    var body: some View {
        HStack(spacing: 5) {
            Button(action: onShowTasks) {
                HStack(spacing: 10) {
                    Image(systemName: session.connection.symbolName)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(session.connection.statusColor)
                        .frame(width: 28, height: 28)
                        .background(
                            session.connection.statusColor.opacity(0.11),
                            in: RoundedRectangle(cornerRadius: 7, style: .continuous))

                    VStack(alignment: .leading, spacing: 1) {
                        Text(session.descriptor.name)
                            .font(.callout.weight(.medium))
                            .foregroundStyle(.primary)
                        Text(session.connection.statusText)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 6)
                    if isSelected {
                        Image(systemName: "checkmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(AlpineTheme.forest)
                            .frame(width: 20, height: 20)
                            .background(AlpineTheme.accent, in: Circle())
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button(action: onReconnect) {
                Image(systemName: "arrow.clockwise")
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Reconnect \(session.descriptor.name)")

            Button(role: .destructive, action: onForget) {
                Image(systemName: "trash")
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Forget \(session.descriptor.name)")
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .background {
            RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
                .fill(rowBackground)
        }
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
    }

    private var rowBackground: Color {
        if isHovering { return Color.primary.opacity(0.075) }
        if isSelected { return AlpineTheme.accent.opacity(0.14) }
        return .clear
    }
}
