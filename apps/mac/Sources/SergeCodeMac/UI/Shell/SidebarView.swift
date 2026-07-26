import SwiftUI

private enum SidebarRowContext {
    case project(showMachine: Bool)
    case search
}

/// A project-first sidebar that presents local and remote sessions in one
/// hierarchy: one collapsible section per project, ordered by most recent
/// activity, with inline thread creation and per-project management.
struct SidebarView: View {
    let multi: MultiDeviceModel
    let scenery: SceneryStore

    /// One project section as it will be rendered: the group plus its
    /// active/settled split. Built once per body pass so the rows and the
    /// signature that animates them can never disagree, and so the split is
    /// not recomputed for each of them.
    @MainActor
    private struct RenderedSection: Identifiable {
        let id: String
        let group: SidebarProjectGroup
        let isCollapsed: Bool
        /// Nil exactly when `isCollapsed`. A collapsed section renders no
        /// rows and contributes only its own id to the signature, so its
        /// ranking is never computed — otherwise every project on every
        /// paired machine would re-rank on each multi-device tick for
        /// sections nobody can see.
        let split: SidebarGroupThreads?
    }

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
    /// Projects whose thread list is expanded past the per-section cap.
    @UIState private var expandedProjects: Set<String> = []
    /// Projects whose settled-thread disclosure is open.
    @UIState private var revealedSettled: Set<String> = []
    /// Project whose settled disclosure row is hovered (reveals archive-all).
    @UIState private var hoveredSettledGroup: String?

    @AppStorage("sidebarMachineScope") private var machineScopeStorage =
        SidebarMachineScope.allStorageValue
    @AppStorage("sidebarCollapsedProjects") private var collapsedProjectsData = Data()
    @AppStorage("sidebarProjectScope") private var projectScopeID = "all"
    @UIState private var collapsedProjects: Set<String> = []

    private var machineScope: SidebarMachineScope {
        SidebarMachineScope(storageValue: machineScopeStorage)
    }

    private var locations: [SidebarLocation] {
        SidebarProjection.locations(in: multi)
    }

    private var allProjectGroups: [SidebarProjectGroup] {
        SidebarProjection.projectGroups(in: multi, scope: machineScope)
    }

    private var projectGroups: [SidebarProjectGroup] {
        projectScopeID == "all" ? allProjectGroups : allProjectGroups.filter { $0.id == projectScopeID }
    }

    private var activeThreads: [SidebarThreadItem] {
        SidebarProjection.activeThreads(in: projectGroups)
    }

    private var isSearching: Bool {
        !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        // Projected once per pass: `allProjectGroups` re-runs the whole
        // cross-machine grouping, and the rows, the section splits and the
        // order signature that animates them all read from the same snapshot.
        let allGroups = allProjectGroups
        let groups = projectScopeID == "all"
            ? allGroups
            : allGroups.filter { $0.id == projectScopeID }
        let searching = isSearching
        let results = searching
            ? SidebarProjection.searchResults(in: groups, query: searchText)
            : []
        let sections = searching
            ? []
            : groups.map { group -> RenderedSection in
                let isCollapsed = collapsedProjects.contains(group.id)
                return RenderedSection(
                    id: group.id,
                    group: group,
                    isCollapsed: isCollapsed,
                    split: isCollapsed ? nil : SidebarProjection.groupThreads(group))
            }

        VStack(spacing: 0) {
            SidebarCommandBar(
                searchText: $searchText,
                locations: locations,
                scope: machineScope,
                projectGroups: allGroups,
                projectScopeID: projectScopeID,
                onSelectScope: setMachineScope,
                onSelectProject: { projectScopeID = $0 })

            List(selection: Binding(
                get: { multi.selection },
                set: { multi.selection = $0 }
            )) {
                if searching {
                    searchSection(results)
                } else {
                    projectSections(sections)
                }
            }
            .listStyle(.sidebar)
            // Thread updates stream in from the backend outside any
            // transaction, so a re-sort (a thread starts running, needs
            // approval, settles) snapped rows to their new slots. The
            // signature gives the list a transaction to move, insert and
            // remove rows with, while tints, titles and badges keep their own
            // finer-grained curves.
            .animation(
                Motion.structure,
                value: rowSignature(sections: sections, results: results))

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
            validateProjectScope()
        }
        .onChange(of: multi.remoteSessions.map(\.id)) {
            validateMachineScope()
        }
        .onChange(of: allProjectGroups.map(\.id)) {
            validateProjectScope()
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

    /// What the list animates on: which rows are on screen, in which section
    /// and which bucket, at which sort tier — deliberately *not* their exact
    /// order, and never their status, title or badge state.
    ///
    /// A full render-order fingerprint was too eager a key. Active rows also
    /// re-sort within a tier by `updatedAt`, and a handful of chatty
    /// streaming threads churn that permutation constantly; keying on it ran
    /// `Motion.structure` across the whole list on every recency bump, which
    /// reads as fidgeting rather than motion. A set changes for the moves
    /// worth watching — a thread promoted or demoted between tiers, moved
    /// into or out of the settled disclosure, arriving, or leaving — and
    /// stays put for a pure recency swap, which then applies untransacted
    /// exactly as it did before any of this animated.
    ///
    /// Project sections re-sort by recency for the same reason and are keyed
    /// the same way: a section arriving or leaving animates, a section
    /// overtaking another does not.
    private func rowSignature(
        sections: [RenderedSection],
        results: [SidebarThreadItem]
    ) -> Set<String> {
        var signature: Set<String> = []
        for item in results {
            signature.insert("search/\(tieredRowKey(item))")
        }
        for section in sections {
            signature.insert("section:\(section.id)")
            guard let split = section.split else { continue }
            for item in visibleActive(split, sectionID: section.id) {
                signature.insert("\(section.id)/active/\(tieredRowKey(item))")
            }
            guard revealedSettled.contains(section.id) else { continue }
            // The disclosure orders purely by how recently each thread
            // settled, so membership alone decides whether it animates.
            for item in split.settled {
                signature.insert("\(section.id)/settled/\(rowKey(item))")
            }
        }
        return signature
    }

    /// Stable across machines: the same thread id can appear twice when one
    /// backend is paired as both the local server and a remote device.
    private func rowKey(_ item: SidebarThreadItem) -> String {
        "\(item.member.location.id.rawValue)/\(item.thread.id)"
    }

    private func tieredRowKey(_ item: SidebarThreadItem) -> String {
        "\(rowKey(item))#\(SidebarProjection.displayTier(item))"
    }

    private func visibleActive(
        _ split: SidebarGroupThreads,
        sectionID: String
    ) -> [SidebarThreadItem] {
        expandedProjects.contains(sectionID)
            ? split.active
            : Array(split.active.prefix(Self.visibleThreadCap))
    }

    @ViewBuilder
    private func searchSection(_ results: [SidebarThreadItem]) -> some View {
        Section {
            if results.isEmpty {
                SidebarEmptyRow(
                    title: "No matching tasks",
                    systemImage: "magnifyingglass",
                    detail: "Try a task, project, branch, or machine name.")
            } else {
                ForEach(results, id: \.id) { item in
                    threadRow(item, context: .search)
                }
            }
        } header: {
            SidebarSectionLabel(title: "Results", count: results.count)
        }
    }

    /// Rows shown per project before the "Show more" affordance kicks in.
    private static let visibleThreadCap = 5

    @ViewBuilder
    private func projectSections(_ sections: [RenderedSection]) -> some View {
        if sections.isEmpty {
            Section {
                SidebarEmptyRow(
                    title: "No projects yet",
                    systemImage: "folder",
                    detail: emptyProjectMessage)
            } header: {
                SidebarSectionLabel(title: "Projects")
            }
        } else {
            ForEach(sections) { section in
                let group = section.group
                Section {
                    if let split = section.split {
                        projectSectionContent(section, split: split)
                    }
                } header: {
                    ProjectSectionHeader(
                        group: group,
                        scenery: scenery,
                        isCollapsed: section.isCollapsed,
                        machineBadge: machineBadge(for: group),
                        onToggleCollapse: { toggleProjectCollapse(group.id) },
                        onNewSession: createThread,
                        onChooseTarget: openAdvancedNewSession,
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
    private func projectSectionContent(
        _ section: RenderedSection,
        split: SidebarGroupThreads
    ) -> some View {
        let group = section.group
        let showMachine = group.members.count > 1
        if split.active.isEmpty && split.settled.isEmpty {
            SidebarEmptyRow(
                title: "No sessions",
                systemImage: "bubble.left",
                detail: "Use + above to start a session in this project.")
        } else {
            let visible = visibleActive(split, sectionID: section.id)
            ForEach(visible, id: \.id) { item in
                threadRow(item, context: .project(showMachine: showMachine))
            }
            let hiddenCount = split.active.count - visible.count
            if hiddenCount > 0 {
                Button {
                    Haptics.play(.toggle)
                    withAnimation(Motion.structure) {
                        // `_ =`: as a single-expression closure this would
                        // implicitly return Set.insert's (inserted,
                        // memberAfterInsert) tuple, which the shipping
                        // Xcode 26.5 toolchain rejects as conflicting with
                        // a Void Result (failed the alpha.14/15 release
                        // checks; newer toolchains accept it).
                        _ = expandedProjects.insert(group.id)
                    }
                } label: {
                    HStack {
                        Spacer()
                        Text("Show \(hiddenCount) more")
                            .font(.caption)
                        Spacer()
                    }
                }
                .buttonStyle(.plain)
                .padding(.vertical, 4)
            }
            if !split.settled.isEmpty {
                settledDisclosure(group: group, settled: split.settled, showMachine: showMachine)
            }
        }
    }

    @ViewBuilder
    private func settledDisclosure(
        group: SidebarProjectGroup,
        settled: [SidebarThreadItem],
        showMachine: Bool
    ) -> some View {
        let isRevealed = revealedSettled.contains(group.id)
        HStack(spacing: 6) {
            Button {
                Haptics.play(.toggle)
                withAnimation(Motion.structure) {
                    // `_ =`: keep the Set.insert/remove results out of
                    // `withAnimation`'s generic Result inference (see the
                    // expandedProjects toggle above).
                    if isRevealed {
                        _ = revealedSettled.remove(group.id)
                    } else {
                        _ = revealedSettled.insert(group.id)
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isRevealed ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .frame(width: 12, height: 12)
                        .contentTransition(Motion.reduceMotion ? .identity : .symbolEffect(.replace))
                    Text("Settled")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("\(settled.count)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                isRevealed
                    ? "Hide \(settled.count) settled sessions in \(group.name)"
                    : "Show \(settled.count) settled sessions in \(group.name)")
            Spacer()
            // Hover-revealed like the project header actions so calm sections
            // stay quiet; kept in the layout at 0 opacity so the row never
            // resizes on hover. The context menu below carries the same action
            // for keyboard/VO users, who never set `hoveredSettledGroup`.
            Button {
                Haptics.play(.commit)
                Task { await archiveAllSettled(settled) }
            } label: {
                Image(systemName: "archivebox")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Archive \(settled.count) settled \(settled.count == 1 ? "session" : "sessions") in \(group.name)")
            .accessibilityLabel("Archive all settled sessions in \(group.name)")
            .opacity(hoveredSettledGroup == group.id ? 1 : 0)
            .allowsHitTesting(hoveredSettledGroup == group.id)
            .accessibilityHidden(hoveredSettledGroup != group.id)
        }
        .padding(.vertical, 4)
        .onHover { hovering in
            hoveredSettledGroup = hovering ? group.id : nil
        }
        .animation(Motion.feedback, value: hoveredSettledGroup)
        .alpineContextMenu(width: 280) { dismiss in
            VStack(spacing: 0) {
                ComposerPickerHeader(
                    icon: "checkmark.circle",
                    title: "Settled sessions",
                    subtitle: group.name,
                    titleLineLimit: 1)
                Divider().opacity(0.55)
                AlpineMenuList {
                    AlpineMenuRow(
                        icon: "archivebox",
                        title: "Archive All Settled",
                        detail: "\(settled.count) session\(settled.count == 1 ? "" : "s")"
                    ) {
                        dismiss()
                        Task { await archiveAllSettled(settled) }
                    }
                }
            }
        }
        if isRevealed {
            ForEach(settled, id: \.id) { item in
                threadRow(item, context: .project(showMachine: showMachine))
            }
        }
    }

    /// Machine context shown on headers when the sidebar spans machines: a
    /// count for repository-merged groups, the machine name for remote-only
    /// projects, nothing for local-only ones.
    private func machineBadge(for group: SidebarProjectGroup) -> String? {
        guard machineScope == .all else { return nil }
        if group.members.count > 1 {
            return "\(group.members.count) machines"
        }
        let member = group.preferredMember
        return member.location.isLocal ? nil : member.location.name
    }

    @ViewBuilder
    private func threadRow(_ item: SidebarThreadItem, context: SidebarRowContext) -> some View {
        SidebarThreadRow(item: item, context: context)
            .tag(item.id)
            .disabled(!item.isSelectable)
            .opacity(item.isSelectable ? 1 : 0.5)
            // Applied here rather than at each `ForEach` so the search and
            // project sections share one rule. Unstaggered: sections are
            // short and re-sort as thread status changes, and a cascade on
            // every re-sort would read as fidgeting.
            .entrance(.row)
            .alpineContextMenu(width: 300) { dismiss in
                SidebarThreadMenu(
                    item: item,
                    dismiss: dismiss,
                    onNewSession: createThread,
                    onSettle: settle,
                    onDelete: { target in
                        deleteThreadTarget = ThreadActionTarget(
                            model: target.member.location.model, thread: target.thread)
                    },
                    newThreadHelp: newThreadHelp)
            }
    }

    /// Archives every settled session of a project. A group can span
    /// machines, so threads are bucketed by their owning model and archived
    /// with one bulk call per model.
    private func archiveAllSettled(_ items: [SidebarThreadItem]) async {
        var order: [String] = []
        var byLocation: [String: (model: AppModel, threads: [ChatThread])] = [:]
        for item in items {
            let key = item.member.location.id.rawValue
            if byLocation[key] == nil {
                byLocation[key] = (item.member.location.model, [])
                order.append(key)
            }
            byLocation[key]?.threads.append(item.thread)
        }
        for key in order {
            guard let entry = byLocation[key] else { continue }
            await entry.model.archiveThreads(entry.threads)
        }
    }

    private func settle(_ item: SidebarThreadItem) {
        Haptics.play(.commit)
        let wasSelected = multi.selection == item.id
        let next = activeThreads.first { $0.id != item.id && $0.isSelectable }
        Task {
            await item.member.location.model.settleThread(item.thread)
            guard wasSelected else { return }
            if let next {
                multi.select(threadID: next.thread.id, on: next.member.location.id)
            } else {
                createThread(item.member, provider: item.thread.provider)
            }
        }
    }

    private var emptyProjectMessage: String {
        switch machineScope {
        case .all: "Start a new task or choose another connection."
        case .device: "Start a new task or switch to All machines."
        }
    }

    /// Explains why a new-thread row is disabled. The rows mirror
    /// `createThread`'s own guards, so one that would silently bail reads as
    /// disabled instead of dead: a Mac that isn't connected can't create
    /// anything, and neither can a provider that isn't runnable.
    private func newThreadHelp(
        _ member: SidebarProjectMember, provider: ProviderKind
    ) -> String {
        if !member.location.isReady {
            return "That Mac isn't connected right now."
        }
        if !member.location.model.canCreateThread(with: provider) {
            return "\(provider.displayName) isn't ready. Open Settings ▸ Providers and refresh."
        }
        return "Start another \(provider.displayName) session in this project"
    }

    private func createThread(_ member: SidebarProjectMember, provider: ProviderKind) {
        Task {
            guard member.location.isReady else { return }
            let model = member.location.model
            if let thread = await model.createSceneThread(
                projectID: member.project.id,
                provider: provider,
                scenery: scenery)
            {
                multi.select(threadID: thread.id, on: member.location.id)
            }
        }
    }

    /// The advanced path: full device → project → provider → scenery chooser,
    /// presented in its own window (same as ⌘N).
    private func openAdvancedNewSession() {
        NewSessionWindowController.shared.show(multi: multi, scenery: scenery)
    }

    private func beginRename(_ member: SidebarProjectMember) {
        renameText = member.project.name
        renameTarget = ProjectActionTarget(
            model: member.location.model, project: member.project)
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

    /// Drops a persisted project scope whose group is gone (project deleted,
    /// machine disconnected). Skips empty group lists so the scope survives
    /// the pre-connect window on cold start, before projects have loaded.
    private func validateProjectScope() {
        guard projectScopeID != "all",
            !allProjectGroups.isEmpty,
            !allProjectGroups.contains(where: { $0.id == projectScopeID })
        else { return }
        projectScopeID = "all"
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
        Haptics.play(.toggle)
        withAnimation(Motion.structure) {
            // `_ =`: see the expandedProjects toggle above.
            if collapsedProjects.contains(projectID) {
                _ = collapsedProjects.remove(projectID)
            } else {
                _ = collapsedProjects.insert(projectID)
            }
        }
        saveCollapsedProjects()
    }
}

private struct SidebarCommandBar: View {
    @Binding var searchText: String
    let locations: [SidebarLocation]
    let scope: SidebarMachineScope
    let projectGroups: [SidebarProjectGroup]
    let projectScopeID: String
    let onSelectScope: (SidebarMachineScope) -> Void
    let onSelectProject: (String) -> Void

    @UIState private var isScopePresented = false
    @UIState private var isProjectScopePresented = false

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
            // Search wins space over the project/machine filter labels (they
            // truncate first) so the field stays usable at min/ideal sidebar
            // widths.
            .layoutPriority(1)

            Button {
                isProjectScopePresented.toggle()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "folder")
                    Text(projectScopeTitle)
                        .lineLimit(1)
                }
                .font(.caption.weight(.medium))
                .frame(height: 28)
                .padding(.horizontal, 7)
                .background(
                    Color.primary.opacity(isProjectScopePresented ? 0.11 : 0.055),
                    in: RoundedRectangle(cornerRadius: 7))
            }
            .buttonStyle(.plain)
            .help("Filter tasks by project")
            .popover(isPresented: $isProjectScopePresented, arrowEdge: .top) {
                projectScopePopover
            }

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

    private var projectScopePopover: some View {
        ComposerPickerSurface(width: 320) {
            VStack(spacing: 0) {
                ComposerPickerHeader(
                    icon: "folder",
                    title: "Project scope",
                    subtitle: "Show tasks from one logical project")
                Divider().opacity(0.55)
                VStack(spacing: 3) {
                    ComposerPickerChoiceRow(
                        icon: "folder",
                        title: "All projects",
                        detail: "Every project on the selected machines",
                        isSelected: projectScopeID == "all"
                    ) {
                        onSelectProject("all")
                        isProjectScopePresented = false
                    }
                    ForEach(projectGroups) { group in
                        ComposerPickerChoiceRow(
                            icon: "folder.fill",
                            title: group.name,
                            detail: "\(group.members.count) location\(group.members.count == 1 ? "" : "s")",
                            isSelected: projectScopeID == group.id
                        ) {
                            onSelectProject(group.id)
                            isProjectScopePresented = false
                        }
                    }
                }
                .padding(8)
            }
        }
    }

    private var projectScopeTitle: String {
        projectScopeID == "all"
            ? "All projects"
            : projectGroups.first(where: { $0.id == projectScopeID })?.name ?? "All projects"
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

    init(title: String, count: Int? = nil) {
        self.title = title
        self.count = count
    }

    var body: some View {
        HStack(spacing: 5) {
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
        Button {
            // Picking a provider here starts a session — a commit, not a
            // browse.
            Haptics.play(.commit)
            action()
        } label: {
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

/// The secondary-click menu for a session row. Two pages inside one popover:
/// the actions, and the provider list behind "New Thread in This Project" —
/// the same back-chevron pattern the composer's executor picker uses, since a
/// nested popover would put a second floating surface on screen.
///
/// The provider page is why this is a view with state rather than a `@ViewBuilder`
/// on `SidebarView`: the page has to survive the menu staying open.
@MainActor
private struct SidebarThreadMenu: View {
    let item: SidebarThreadItem
    let dismiss: () -> Void
    let onNewSession: (SidebarProjectMember, ProviderKind) -> Void
    let onSettle: (SidebarThreadItem) -> Void
    let onDelete: (SidebarThreadItem) -> Void
    let newThreadHelp: (SidebarProjectMember, ProviderKind) -> String

    @UIState private var showingProviders = false

    private var model: AppModel { item.member.location.model }
    private var providers: [ProviderKind] { model.configuredProviderKinds }

    var body: some View {
        VStack(spacing: 0) {
            if showingProviders {
                providerPage
            } else {
                actionPage
            }
        }
        .animation(Motion.structure, value: showingProviders)
    }

    private var actionPage: some View {
        VStack(spacing: 0) {
            ComposerPickerHeader(
                icon: "bubble.left",
                title: item.thread.title,
                subtitle: item.member.project.name,
                titleLineLimit: 2)
            Divider().opacity(0.55)
            AlpineMenuList {
                // No detail lines on the action rows: a context menu is
                // scanned, not read, and one two-line row among single-line
                // ones breaks the rhythm.
                AlpineMenuRow(
                    icon: item.isPinned ? "pin.slash" : "pin",
                    title: item.isPinned ? "Unpin" : "Pin"
                ) {
                    Haptics.play(.toggle)
                    model.togglePinned(item.thread)
                    dismiss()
                }
                .disabled(!item.isSelectable)

                AlpineMenuRow(
                    icon: "plus.bubble",
                    title: "New Session in This Project",
                    detail: providers.isEmpty ? "No providers configured" : nil,
                    opensSubmenu: true
                ) {
                    showingProviders = true
                }
                .disabled(!item.isSelectable || providers.isEmpty)

                AlpineMenuSeparator()

                lifecycleRow

                AlpineMenuRow(icon: "archivebox", title: "Archive") {
                    Haptics.play(.commit)
                    dismiss()
                    Task { await model.archiveThread(item.thread) }
                }
                .disabled(!item.isSelectable)

                AlpineMenuSeparator()

                AlpineMenuRow(icon: "trash", title: "Delete…", isDestructive: true) {
                    dismiss()
                    onDelete(item)
                }
                .disabled(!item.isSelectable)
            }
        }
        .onAppear {
            #if DEBUG
                UIProbeMenus.record("thread:\(item.thread.id)")
            #endif
        }
    }

    /// Settle and un-settle are the same slot: a live session can be settled,
    /// a settled one reopened, and an archived one is neither.
    @ViewBuilder
    private var lifecycleRow: some View {
        if item.thread.status != .settled, item.thread.status != .archived {
            AlpineMenuRow(icon: "checkmark.circle", title: "Settle Session") {
                dismiss()
                onSettle(item)
            }
            .disabled(!item.isSelectable || !ThreadInboxSemantics.canSettle(item.thread))
        } else if item.thread.status == .settled {
            AlpineMenuRow(icon: "arrow.counterclockwise", title: "Mark as Active") {
                dismiss()
                Task { await model.unsettleThread(item.thread) }
            }
            .disabled(!item.isSelectable)
        }
    }

    private var providerPage: some View {
        VStack(spacing: 0) {
            ComposerPickerHeader(
                icon: "plus.bubble",
                title: "New session",
                subtitle: item.member.project.name,
                onBack: { showingProviders = false },
                titleLineLimit: 1)
            Divider().opacity(0.55)
            AlpineMenuList {
                ForEach(providers) { provider in
                    SidebarProviderChoiceRow(
                        provider: provider,
                        detail: item.member.location.isReady
                            ? nil : item.member.location.connection.statusText,
                        isEnabled: item.member.location.isReady
                            && model.canCreateThread(with: provider)
                    ) {
                        dismiss()
                        onNewSession(item.member, provider)
                    }
                    .help(newThreadHelp(item.member, provider))
                }
            }
        }
    }
}

private struct ProjectSectionHeader: View {
    let group: SidebarProjectGroup
    let scenery: SceneryStore
    let isCollapsed: Bool
    /// Machine context to show next to the name when the sidebar spans
    /// machines ("2 machines", or the remote machine's name). Nil hides it.
    let machineBadge: String?
    let onToggleCollapse: () -> Void
    let onNewSession: (SidebarProjectMember, ProviderKind) -> Void
    let onChooseTarget: () -> Void
    let onRename: (SidebarProjectMember) -> Void
    let onDelete: (SidebarProjectMember) -> Void

    @UIState private var isNewTaskPresented = false
    @UIState private var isManagePresented = false
    @UIState private var isHovering = false

    var body: some View {
        HStack(spacing: 6) {
            Button(action: onToggleCollapse) {
                Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 12, height: 12)
                    .contentShape(Rectangle())
                    .contentTransition(Motion.reduceMotion ? .identity : .symbolEffect(.replace))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isCollapsed ? "Expand \(group.name)" : "Collapse \(group.name)")

            projectBadge
            Text(group.name)
                .fontWeight(.semibold)
                .lineLimit(1)
            if let machineBadge {
                Text(machineBadge)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.quaternary, in: Capsule())
            }
            Spacer(minLength: 4)
            // The counts tick as threads move between tiers below; the digit
            // rolls and the badge swaps in place rather than popping.
            if group.attentionThreadCount > 0 {
                Label("\(group.attentionThreadCount)", systemImage: "exclamationmark.circle.fill")
                    .foregroundStyle(AlpineTheme.clay)
                    .contentTransition(.numericText())
                    .transition(Motion.pop(from: .trailing))
                    .help("\(group.attentionThreadCount) need attention")
            } else if group.activeThreadCount > 0 {
                Label("\(group.activeThreadCount)", systemImage: "bolt.fill")
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
                    .transition(Motion.pop(from: .trailing))
                    .help("\(group.activeThreadCount) in progress")
            }
            HStack(spacing: 2) {
                // A plain button plus the app's own popover, not `Menu`: the
                // native menu drops a system-styled NSMenu on top of an
                // otherwise custom sidebar, and the "+" beside it already
                // opens an Alpine popover.
                Button {
                    isManagePresented.toggle()
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                        .background {
                            if isManagePresented {
                                RoundedRectangle(cornerRadius: 5)
                                    .fill(Color.primary.opacity(0.1))
                            }
                        }
                }
                .buttonStyle(.plain)
                .help("Manage \(group.name)")
                .popover(isPresented: $isManagePresented, arrowEdge: .top) {
                    projectMenu { isManagePresented = false }
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
                .help("New session in \(group.name)")
                .popover(isPresented: $isNewTaskPresented, arrowEdge: .top) {
                    newTaskPopover
                }
            }
            // Hover-revealed so calm sections stay quiet; kept visible while
            // either popover is up so the anchor doesn't vanish mid-interaction.
            .opacity(isHovering || isNewTaskPresented || isManagePresented ? 1 : 0)
            .accessibilityHidden(!isHovering && !isNewTaskPresented && !isManagePresented)
        }
        .font(.caption)
        .contentShape(Rectangle())
        .onTapGesture(perform: onToggleCollapse)
        .onHover { isHovering = $0 }
        .animation(Motion.structure, value: isCollapsed)
        .animation(Motion.feedback, value: isHovering)
        .animation(Motion.ambient, value: group.attentionThreadCount)
        .animation(Motion.ambient, value: group.activeThreadCount)
        .alpineContextMenu(width: 300) { dismiss in
            projectMenu(dismiss: dismiss)
        }
    }

    /// One menu body behind both entry points — the "…" button and a
    /// right-click anywhere on the header row.
    private func projectMenu(dismiss: @escaping () -> Void) -> some View {
        VStack(spacing: 0) {
            ComposerPickerHeader(
                icon: "folder",
                title: group.name,
                subtitle: group.members.count == 1
                    ? "Manage this project"
                    : "Manage on \(group.members.count) machines",
                titleLineLimit: 1)
            Divider().opacity(0.55)
            AlpineMenuList {
                memberActionRows(icon: "pencil", title: "Rename", dismiss: dismiss, action: onRename)
                AlpineMenuSeparator()
                memberActionRows(
                    icon: "trash",
                    title: "Delete Project",
                    isDestructive: true,
                    dismiss: dismiss,
                    action: onDelete)
            }
        }
        .onAppear {
            #if DEBUG
                UIProbeMenus.record("project:\(group.id)")
            #endif
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
                    title: "New session",
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
                .frame(maxHeight: 380)
                Divider().opacity(0.55)
                VStack(spacing: 3) {
                    ComposerPickerChoiceRow(
                        icon: "slider.horizontal.3",
                        title: "Choose Target…",
                        detail: "Pick device, project, and provider",
                        isSelected: false
                    ) {
                        isNewTaskPresented = false
                        onChooseTarget()
                    }
                }
                .padding(8)
            }
        }
    }

    /// A group can span machines, and rename/delete act on one machine's copy
    /// of the project. One row per member then, with the machine name on the
    /// detail line rather than folded into the title.
    @ViewBuilder
    private func memberActionRows(
        icon: String,
        title: String,
        isDestructive: Bool = false,
        dismiss: @escaping () -> Void,
        action: @escaping (SidebarProjectMember) -> Void
    ) -> some View {
        if group.members.count == 1, let member = group.members.first {
            AlpineMenuRow(icon: icon, title: "\(title)…", isDestructive: isDestructive) {
                dismiss()
                action(member)
            }
            .disabled(!member.location.isReady)
        } else {
            ForEach(group.members, id: \.id) { member in
                AlpineMenuRow(
                    icon: icon,
                    title: "\(title)…",
                    detail: member.location.name,
                    isDestructive: isDestructive
                ) {
                    dismiss()
                    action(member)
                }
                .disabled(!member.location.isReady)
            }
        }
    }

    private var projectPrefs: ProjectSceneryPrefs? {
        scenery.projectPrefs(for: group.preferredMember.project.path)
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
                        .font(SurgeTypography.sidebarTaskTitle)
                        .lineLimit(1)
                    if item.isPinned {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(.tint)
                            .accessibilityLabel("Pinned")
                            .transition(Motion.pop(from: .leading))
                    }
                }
                Text(secondaryText)
                    .font(SurgeTypography.technicalMetadata)
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
                    .contentTransition(.numericText())
                    .transition(Motion.pop(from: .trailing))
                    .help("Background agents and commands")
            }
        }
        .padding(.vertical, 2)
        .animation(Motion.reveal, value: item.isPinned)
        .animation(Motion.ambient, value: item.thread.backgroundAgentCount)
        .modifier(
            SidebarRowMoveTrail(
                tier: SidebarProjection.displayTier(item),
                tint: item.statusTint))
        .accessibilityElement(children: .combine)
    }

    private var secondaryText: String {
        let parts: [String]
        switch context {
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

/// A brief status-tinted wash behind a row that just changed sort tier. The
/// list animates the geometry of a re-sort; this is what makes it legible —
/// several rows slide at once and nothing otherwise says which one earned its
/// new slot.
///
/// Keyed to the tier rather than the row's index, which is not the same thing
/// (see `SidebarProjection.displayTier`): bystanders displaced by someone
/// else's promotion stay quiet, a within-tier recency swap passes without a
/// wash, and a lone row can wash without visibly moving. Purely decorative,
/// so Reduce Motion skips it and the row simply moves.
private struct SidebarRowMoveTrail: ViewModifier {
    let tier: Int
    let tint: Color

    @UIState private var beat = 0
    @UIState private var intensity: Double = 0

    func body(content: Content) -> some View {
        content
            .background {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(tint.opacity(0.2 * intensity))
                    .padding(.horizontal, -7)
                    .padding(.vertical, -1)
                    .allowsHitTesting(false)
            }
            .onChange(of: tier) { _, _ in
                guard Motion.profile.allowsDecorativeEffects else { return }
                beat += 1
            }
            // `.task(id:)` rather than a detached Task: a second promotion
            // arriving mid-wash cancels the pending fade-out and restarts,
            // so rapid changes read as one sustained glow instead of a
            // stutter of overlapping fades.
            .task(id: beat) {
                guard beat > 0 else { return }
                withAnimation(Motion.feedback) { intensity = 1 }
                try? await Task.sleep(for: .milliseconds(200))
                guard !Task.isCancelled else { return }
                withAnimation(Motion.scenery) { intensity = 0 }
            }
    }
}

extension SidebarThreadItem {
    /// Colour of the row's status glyph. Also tints the move trail, so the
    /// wash a promoted row leaves behind says *why* it moved.
    @MainActor var statusTint: Color {
        if hasConnectionIssue { return member.location.connection.statusColor }
        if thread.isStalled { return AlpineTheme.clay }
        switch thread.status {
        case .idle: return .secondary
        case .running: return AlpineTheme.accent
        case .waiting: return AlpineTheme.sky
        case .waitingApproval: return AlpineTheme.lichen
        case .waitingInput: return AlpineTheme.sky
        case .backgroundWork: return AlpineTheme.meadow
        case .error: return .red
        case .archived: return .gray
        case .settled: return .secondary
        case .done: return .secondary
        case .reviewing: return AlpineTheme.sky
        case .fixing: return AlpineTheme.accent
        case .readyToMerge: return AlpineTheme.lichen
        }
    }

    var statusSymbol: String {
        if hasConnectionIssue { return member.location.connection.symbolName }
        if thread.isStalled { return "exclamationmark.circle.fill" }
        switch thread.status {
        case .backgroundWork: return "person.2.fill"
        case .idle: return "circle.fill"
        case .running: return "bolt.fill"
        case .waiting: return "clock.fill"
        case .waitingApproval: return "exclamationmark.circle.fill"
        case .waitingInput: return "questionmark.bubble.fill"
        case .error: return "xmark.octagon.fill"
        case .archived: return "archivebox.fill"
        case .settled: return "checkmark.circle"
        case .done: return "checkmark"
        case .reviewing: return "magnifyingglass"
        case .fixing: return "wrench.and.screwdriver"
        case .readyToMerge: return "checkmark.seal"
        }
    }
}

private struct SidebarThreadStatus: View {
    let item: SidebarThreadItem

    var body: some View {
        Image(systemName: item.statusSymbol)
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(item.statusTint)
            .frame(width: 14, height: 14)
            .accessibilityLabel(item.statusLabel)
            .help(item.statusLabel)
            .contentTransition(Motion.reduceMotion ? .identity : .symbolEffect(.replace))
            .animation(Motion.ambient, value: item.thread.status)
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
    @UIState private var isHovering = false

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
                            .animation(Motion.ambient, value: location.connection)
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
                if isPresented || isHovering {
                    Rectangle().fill(Color.primary.opacity(isPresented ? 0.055 : 0.04))
                }
            }
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
        .animation(Motion.feedback, value: isPresented)
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
