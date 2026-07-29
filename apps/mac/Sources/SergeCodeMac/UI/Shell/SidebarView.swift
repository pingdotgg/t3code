import SwiftUI

/// Where a session row is being drawn, and what the outline around it looks
/// like there. Search results are a flat list — no project owns them — so they
/// carry no rail and always name their project on the metadata line.
private enum SidebarRowContext {
    case project(showMachine: Bool, accent: Color, index: Int, isLast: Bool)
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
    /// Automation subtrees start open so background work becomes visible.
    /// This set only records the user's explicit collapses for this scene.
    @UIState private var collapsedAutoReviewParents: Set<String> = []
    /// Project whose settled disclosure row is hovered (reveals archive-all).
    @UIState private var hoveredSettledGroup: String?
    /// Projects whose snoozed-thread disclosure is open.
    @UIState private var revealedSnoozed: Set<String> = []
    /// Project whose snoozed disclosure row is hovered (reveals wake-all).
    @UIState private var hoveredSnoozedGroup: String?
    /// Remembers what the list last rendered so a structural update can be
    /// animated or snapped. Reference type on purpose: it is read during an
    /// update, not rendered from, and must not invalidate the view when it
    /// records the new census.
    @UIState private var structureGate = SidebarStructureGate()

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
        let census = rowCensus(searching: searching, sections: sections, results: results)

        VStack(spacing: 0) {
            SidebarCommandBar(
                searchText: searchText,
                locations: locations,
                scope: machineScope,
                projectGroups: allGroups,
                projectScopeID: projectScopeID,
                onSearchTextChange: { searchText = $0 },
                onSelectScope: setMachineScope,
                onSelectProject: { projectScopeID = $0 })
            // Closes the sidebar's header band. Aligned with the dividers under
            // the chat identity header and the inspector Activity header, so
            // one line crosses all three columns.
            Divider()

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
            // approval, settles) snapped rows to their new slots. The census
            // gives the list a transaction to move and insert rows with, while
            // tints, titles and badges keep their own finer-grained curves.
            //
            // Not `.animation(_:value:)`: that animated row *removals* too, and
            // an animated removal strands its row view — see
            // `SidebarStructureGate`.
            .transaction { transaction in
                switch structureGate.decide(census) {
                case .inherit: break
                case .animate: transaction.animation = Motion.structure
                case .snap: transaction.animation = nil
                }
            }

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
        // Probe hook (see UIProbeHooks): publishes which sections have their
        // settled disclosure open. A probe drives the disclosure through the
        // notification below, but it also has to know what the disclosure was
        // doing before it asked — the reveal unions rather than toggles.
        .uiProbeRevealedSettled(revealedSettled)
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
        // Probe hook (see UIProbeHooks): reveals every project's settled
        // disclosure, so the rows it hides — and their menus — can be driven.
        // Nothing posts this outside a probe run.
        //
        // A union rather than a toggle: the probe needs the disclosure *open*,
        // and a toggle would close it again on a redelivered notification or on
        // a group the user had already expanded, leaving the rows it was asked
        // to reveal missing.
        .onReceive(NotificationCenter.default.publisher(for: .uiProbeToggleSection)) { note in
            guard let key = note.object as? String else { return }
            // "settled" opens every project's disclosure; "settled:<groupID>"
            // opens one, so a probe verifying a single section can drive that
            // section alone. Unknown ids are dropped rather than unioned in —
            // see `UIProbeSettledKey.targets`. "snoozed"/"snoozed:<groupID>"
            // drive the snoozed disclosure the same way.
            let known = Set(allProjectGroups.map(\.id))
            let settledTargets = UIProbeSettledKey.targets(for: key, among: known)
            let snoozedTargets = UIProbeSnoozedKey.targets(for: key, among: known)
            guard !settledTargets.isEmpty || !snoozedTargets.isEmpty else { return }
            DispatchQueue.main.async {
                withAnimation(Motion.structure) {
                    revealedSettled.formUnion(settledTargets)
                    revealedSnoozed.formUnion(snoozedTargets)
                }
            }
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
                Text(
                    "“\(target.project.name)” and all of its sessions, including archived sessions, will be removed. Files on disk are not touched."
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

    /// The census the list animates on — see `SidebarRowCensus` for what the
    /// two halves mean and `SidebarStructureGate` for what is done with them.
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
    ///
    /// The untiered half counts the affordance rows too — the "n more" pill and
    /// the settled toggle come and go with the rows around them.
    private func rowCensus(
        searching: Bool,
        sections: [RenderedSection],
        results: [SidebarThreadItem]
    ) -> SidebarRowCensus {
        var census = SidebarRowCensus()
        // `rows` has to name every row the list can hold, including the empty
        // states: they are rows like any other, and a row missing from the
        // census is a row the gate below cannot see leaving.
        if searching {
            census.rows.insert("search:section")
            if results.isEmpty {
                census.rows.insert("search/empty")
            }
        } else if sections.isEmpty {
            census.rows.insert("projects:section")
            census.rows.insert("projects/empty")
        }
        for item in results {
            census.standing.insert("search/\(tieredRowKey(item))")
            census.rows.insert("search/\(rowKey(item))")
        }
        for section in sections {
            census.standing.insert("section:\(section.id)")
            census.rows.insert("section:\(section.id)")
            guard let split = section.split else { continue }
            let visible = visibleActive(split, sectionID: section.id)
            for item in visible {
                census.standing.insert("\(section.id)/active/\(tieredRowKey(item))")
                census.rows.insert("\(section.id)/active/\(rowKey(item))")
                addAutoReviewRows(to: &census, parent: item, group: section.group)
            }
            if split.active.count > visible.count {
                census.rows.insert("\(section.id)/more")
            }
            if !split.snoozed.isEmpty {
                census.rows.insert("\(section.id)/snoozed-toggle")
            }
            if revealedSnoozed.contains(section.id) {
                // Ordered purely by wake time, so membership alone decides
                // whether the disclosure animates.
                for item in split.snoozed {
                    census.standing.insert("\(section.id)/snoozed/\(rowKey(item))")
                    census.rows.insert("\(section.id)/snoozed/\(rowKey(item))")
                }
            }
            if !split.settled.isEmpty {
                census.rows.insert("\(section.id)/settled-toggle")
            }
            guard revealedSettled.contains(section.id) else { continue }
            // The disclosure orders purely by how recently each thread
            // settled, so membership alone decides whether it animates.
            for item in split.settled {
                census.standing.insert("\(section.id)/settled/\(rowKey(item))")
                census.rows.insert("\(section.id)/settled/\(rowKey(item))")
                addAutoReviewRows(to: &census, parent: item, group: section.group)
            }
        }
        return census
    }

    /// Stable across machines: the same thread id can appear twice when one
    /// backend is paired as both the local server and a remote device.
    private func rowKey(_ item: SidebarThreadItem) -> String {
        "\(item.member.location.id.rawValue)/\(item.thread.id)"
    }

    private func tieredRowKey(_ item: SidebarThreadItem) -> String {
        "\(rowKey(item))#\(SidebarProjection.displayTier(item))"
    }

    private func autoReviewTreeKey(_ item: SidebarThreadItem) -> String {
        rowKey(item)
    }

    private func autoReviewChildren(
        for parent: SidebarThreadItem,
        in group: SidebarProjectGroup
    ) -> [SidebarThreadItem] {
        group.autoReviewChildrenByParent[parent.id] ?? []
    }

    private func hasAutoReviewSubtree(
        _ parent: SidebarThreadItem,
        in group: SidebarProjectGroup
    ) -> Bool {
        parent.thread.status == .reviewing
            || parent.thread.status == .fixing
            || !autoReviewChildren(for: parent, in: group).isEmpty
    }

    private func addAutoReviewRows(
        to census: inout SidebarRowCensus,
        parent: SidebarThreadItem,
        group: SidebarProjectGroup
    ) {
        let key = autoReviewTreeKey(parent)
        guard hasAutoReviewSubtree(parent, in: group),
            !collapsedAutoReviewParents.contains(key)
        else { return }
        if parent.thread.status == .reviewing {
            census.rows.insert("\(key)/auto-review-agent")
        }
        let children = autoReviewChildren(for: parent, in: group)
        if parent.thread.status == .fixing, children.isEmpty {
            census.rows.insert("\(key)/auto-fixer-inline")
        }
        for child in children {
            census.rows.insert("\(key)/auto-fixer/\(rowKey(child))")
        }
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
                ForEach(Array(results.enumerated()), id: \.element.id) { index, item in
                    threadRow(item, context: .search, index: index)
                }
            }
        } header: {
            SidebarSectionLabel(title: "Results", count: results.count)
        }
    }

    /// Rows shown per project before the "Show more" affordance kicks in.
    /// Not private: the `sidebar-empty-state` probe censuses the list against
    /// the model, and the cap is part of how many rows a section should hold.
    static let visibleThreadCap = 5

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
                        summary: SidebarProjectSummary(group: group),
                        accent: projectAccent(group),
                        symbol: projectSymbol(group),
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
        let accent = projectAccent(group)
        let visible = visibleActive(split, sectionID: section.id)
        let hiddenCount = split.active.count - visible.count
        // The outline's guide has to know where it stops, and that is not
        // "the last visible row": a "Show more" pill or a snoozed/settled
        // disclosure keeps the section going below it.
        let activeRunsOn = hiddenCount > 0 || !split.settled.isEmpty || !split.snoozed.isEmpty
        // A project with no sessions renders no rows at all. Its header already
        // says "No sessions" on the census line and carries the "+" that starts
        // one, so a placeholder row underneath repeated the same two words one
        // line lower — and, being the only row of its section, it was the row
        // the list stranded when the first session arrived.
        ForEach(Array(visible.enumerated()), id: \.element.id) { index, item in
            threadTree(
                item,
                group: group,
                context: .project(
                    showMachine: showMachine,
                    accent: accent,
                    index: index,
                    isLast: !activeRunsOn && index == visible.count - 1),
                index: index)
        }
        if hiddenCount > 0 {
            showMoreRow(group: group, hiddenCount: hiddenCount, accent: accent)
        }
        if !split.snoozed.isEmpty {
            snoozedDisclosure(
                group: group,
                snoozed: split.snoozed,
                showMachine: showMachine,
                accent: accent)
        }
        if !split.settled.isEmpty {
            settledDisclosure(
                group: group,
                settled: split.settled,
                showMachine: showMachine,
                accent: accent)
        }
    }

    /// The per-project overflow affordance. A pill rather than centered text:
    /// it sits on the rail like the rows it will reveal, and it springs on
    /// press so it reads as a control.
    private func showMoreRow(
        group: SidebarProjectGroup,
        hiddenCount: Int,
        accent: Color
    ) -> some View {
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
            HStack(spacing: 6) {
                SidebarRailStub(accent: accent)
                SidebarPill {
                    HStack(spacing: 3) {
                        Text("\(hiddenCount) more")
                            .contentTransition(.numericText())
                        Image(systemName: "chevron.down")
                            .font(.system(size: 7, weight: .bold))
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(SidebarPressStyle())
        .padding(.vertical, 3)
        .accessibilityLabel("Show \(hiddenCount) more sessions in \(group.name)")
    }

    @ViewBuilder
    private func settledDisclosure(
        group: SidebarProjectGroup,
        settled: [SidebarThreadItem],
        showMachine: Bool,
        accent: Color
    ) -> some View {
        let isRevealed = revealedSettled.contains(group.id)
        let isHovered = hoveredSettledGroup == group.id
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
                    SidebarRailStub(accent: accent)
                    SidebarDisclosureChevron(isExpanded: isRevealed, size: 8)
                        .foregroundStyle(.tertiary)
                        .frame(width: 10)
                    SidebarPill {
                        HStack(spacing: 4) {
                            Text("Settled")
                            Text("\(settled.count)")
                                .monospacedDigit()
                                .contentTransition(.numericText())
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(SidebarPressStyle())
            .accessibilityLabel(
                isRevealed
                    ? "Hide \(settled.count) settled sessions in \(group.name)"
                    : "Show \(settled.count) settled sessions in \(group.name)")
            // Hover-revealed like the project header actions so calm sections
            // stay quiet; kept in the layout at 0 opacity so the row never
            // resizes on hover, and sliding in from the trailing edge rather
            // than blinking on. The context menu below carries the same action
            // for keyboard/VO users, who never set `hoveredSettledGroup`.
            Button {
                Haptics.play(.commit)
                Task { await archiveAllSettled(settled) }
            } label: {
                Image(systemName: "archivebox")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 18, height: 18)
                    .background { SidebarHoverSurface(isActive: isHovered, cornerRadius: 5) }
                    .contentShape(Rectangle())
            }
            .buttonStyle(SidebarPressStyle())
            .help("Archive \(settled.count) settled \(settled.count == 1 ? "session" : "sessions") in \(group.name)")
            .accessibilityLabel("Archive all settled sessions in \(group.name)")
            .opacity(isHovered ? 1 : 0)
            .offset(x: isHovered || !Motion.profile.usesMovement ? 0 : 8)
            .allowsHitTesting(isHovered)
            .accessibilityHidden(!isHovered)
        }
        .padding(.vertical, 3)
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
            .onAppear {
                #if DEBUG
                    UIProbeMenus.record("settled:\(group.id)")
                #endif
            }
        }
        if isRevealed {
            ForEach(Array(settled.enumerated()), id: \.element.id) { index, item in
                threadTree(
                    item,
                    group: group,
                    context: .project(
                        showMachine: showMachine,
                        accent: accent,
                        index: index,
                        isLast: index == settled.count - 1),
                    index: index)
            }
        }
    }

    /// The snoozed counterpart of `settledDisclosure`: snoozed threads are
    /// still active on the wire, so they get their own quiet shelf — soonest
    /// wake first — instead of masquerading as settled work. The hover action
    /// wakes everything at once, mirroring the settled row's archive-all.
    @ViewBuilder
    private func snoozedDisclosure(
        group: SidebarProjectGroup,
        snoozed: [SidebarThreadItem],
        showMachine: Bool,
        accent: Color
    ) -> some View {
        let isRevealed = revealedSnoozed.contains(group.id)
        let isHovered = hoveredSnoozedGroup == group.id
        HStack(spacing: 6) {
            Button {
                Haptics.play(.toggle)
                withAnimation(Motion.structure) {
                    // `_ =`: keep the Set.insert/remove results out of
                    // `withAnimation`'s generic Result inference (see the
                    // expandedProjects toggle above).
                    if isRevealed {
                        _ = revealedSnoozed.remove(group.id)
                    } else {
                        _ = revealedSnoozed.insert(group.id)
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    SidebarRailStub(accent: accent)
                    SidebarDisclosureChevron(isExpanded: isRevealed, size: 8)
                        .foregroundStyle(.tertiary)
                        .frame(width: 10)
                    SidebarPill {
                        HStack(spacing: 4) {
                            Image(systemName: "moon.zzz")
                                .font(.system(size: 8, weight: .semibold))
                            Text("Snoozed")
                            Text("\(snoozed.count)")
                                .monospacedDigit()
                                .contentTransition(.numericText())
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(SidebarPressStyle())
            .accessibilityLabel(
                isRevealed
                    ? "Hide \(snoozed.count) snoozed sessions in \(group.name)"
                    : "Show \(snoozed.count) snoozed sessions in \(group.name)")
            Button {
                Haptics.play(.commit)
                Task { await wakeAllSnoozed(snoozed) }
            } label: {
                Image(systemName: "bell.and.waves.left.and.right")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 18, height: 18)
                    .background { SidebarHoverSurface(isActive: isHovered, cornerRadius: 5) }
                    .contentShape(Rectangle())
            }
            .buttonStyle(SidebarPressStyle())
            .help("Wake \(snoozed.count) snoozed \(snoozed.count == 1 ? "session" : "sessions") in \(group.name)")
            .accessibilityLabel("Wake all snoozed sessions in \(group.name)")
            .opacity(isHovered ? 1 : 0)
            .offset(x: isHovered || !Motion.profile.usesMovement ? 0 : 8)
            .allowsHitTesting(isHovered)
            .accessibilityHidden(!isHovered)
        }
        .padding(.vertical, 3)
        .onHover { hovering in
            hoveredSnoozedGroup = hovering ? group.id : nil
        }
        .animation(Motion.feedback, value: hoveredSnoozedGroup)
        .alpineContextMenu(width: 280) { dismiss in
            VStack(spacing: 0) {
                ComposerPickerHeader(
                    icon: "moon.zzz",
                    title: "Snoozed sessions",
                    subtitle: group.name,
                    titleLineLimit: 1)
                Divider().opacity(0.55)
                AlpineMenuList {
                    AlpineMenuRow(
                        icon: "bell.and.waves.left.and.right",
                        title: "Wake All Snoozed",
                        detail: "\(snoozed.count) session\(snoozed.count == 1 ? "" : "s")"
                    ) {
                        dismiss()
                        Task { await wakeAllSnoozed(snoozed) }
                    }
                }
            }
            .onAppear {
                #if DEBUG
                    UIProbeMenus.record("snoozed:\(group.id)")
                #endif
            }
        }
        if isRevealed {
            ForEach(Array(snoozed.enumerated()), id: \.element.id) { index, item in
                threadRow(
                    item,
                    context: .project(
                        showMachine: showMachine,
                        accent: accent,
                        index: index,
                        isLast: index == snoozed.count - 1),
                    index: index)
            }
        }
    }

    /// Wakes every snoozed session of a project. A group can span machines,
    /// so threads are bucketed by their owning model, like `archiveAllSettled`.
    private func wakeAllSnoozed(_ items: [SidebarThreadItem]) async {
        var byLocation: [ObjectIdentifier: (model: AppModel, threads: [ChatThread])] = [:]
        for item in items {
            let key = ObjectIdentifier(item.member.location.model)
            byLocation[key, default: (item.member.location.model, [])].threads.append(item.thread)
        }
        for (_, entry) in byLocation {
            for thread in entry.threads {
                await entry.model.unsnoozeThread(thread)
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

    /// A project's own color, used for its tile, its outline rail and the
    /// selected row on it. Falls back to the app tint for projects that have
    /// never been given scenery, so an unconfigured sidebar still reads as one
    /// palette rather than as a set of gray folders.
    private func projectAccent(_ group: SidebarProjectGroup) -> Color {
        scenery.projectPrefs(for: group.preferredMember.project.path)?
            .projectBadgeAccent ?? AlpineTheme.accent
    }

    private func projectSymbol(_ group: SidebarProjectGroup) -> String {
        scenery.projectPrefs(for: group.preferredMember.project.path)?
            .projectBadgeSymbol ?? "folder.fill"
    }

    @ViewBuilder
    private func threadRow(
        _ item: SidebarThreadItem,
        context: SidebarRowContext,
        index: Int
    ) -> some View {
        SidebarThreadRow(
            item: item,
            context: context,
            isSelected: multi.selection == item.id,
            subtreeDisclosure: nil)
            .tag(item.id)
            .disabled(!item.isSelectable)
            .opacity(item.isSelectable ? 1 : 0.5)
            // Applied here rather than at each `ForEach` so the search and
            // project sections share one rule. Staggered by position, which
            // `EntrancePolicy` clamps at eight steps: expanding a project
            // unrolls its sessions instead of flashing them in, and the clamp
            // is what keeps a re-sort of a long section from rippling — the
            // rows that stay put keep their identity and never re-enter.
            .entrance(.row, index: index)
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

    @ViewBuilder
    private func threadTree(
        _ item: SidebarThreadItem,
        group: SidebarProjectGroup,
        context: SidebarRowContext,
        index: Int
    ) -> some View {
        let children = autoReviewChildren(for: item, in: group)
        let hasSubtree = hasAutoReviewSubtree(item, in: group)
        let key = autoReviewTreeKey(item)
        let isExpanded = !collapsedAutoReviewParents.contains(key)
        SidebarThreadRow(
            item: item,
            context: context,
            isSelected: multi.selection == item.id,
            subtreeDisclosure: hasSubtree
                ? SidebarSubtreeDisclosure(
                    isExpanded: isExpanded,
                    toggle: {
                        Haptics.play(.toggle)
                        withAnimation(Motion.structure) {
                            if isExpanded {
                                _ = collapsedAutoReviewParents.insert(key)
                            } else {
                                _ = collapsedAutoReviewParents.remove(key)
                            }
                        }
                    })
                : nil)
            .tag(item.id)
            .disabled(!item.isSelectable)
            .opacity(item.isSelectable ? 1 : 0.5)
            .entrance(.row, index: index)
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
        if hasSubtree, isExpanded {
            if item.thread.status == .reviewing {
                AutoReviewAutomationRow(
                    title: "Auto-review agent",
                    detail: "Inspecting the latest pull request diff",
                    symbol: "text.magnifyingglass",
                    tint: AlpineTheme.sky,
                    isWorking: true)
            }
            if item.thread.status == .fixing, children.isEmpty {
                AutoReviewAutomationRow(
                    title: "Auto-fixer",
                    detail: "Working in the parent thread",
                    symbol: "wrench.and.screwdriver.fill",
                    tint: AlpineTheme.accent,
                    isWorking: true)
            }
            ForEach(children, id: \.id) { child in
                AutoReviewFixerThreadRow(
                    item: child,
                    isSelected: multi.selection == child.id)
                    .tag(child.id)
                    .disabled(!child.isSelectable)
                    .opacity(child.isSelectable ? 1 : 0.5)
            }
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
        let wasSelected = multi.selection == item.id
        let next = activeThreads.first { $0.id != item.id && $0.isSelectable }
        Task {
            guard await item.member.location.model.settleThread(item.thread) else { return }
            Haptics.play(.commit)
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
    let searchText: String
    let locations: [SidebarLocation]
    let scope: SidebarMachineScope
    let projectGroups: [SidebarProjectGroup]
    let projectScopeID: String
    let onSearchTextChange: (String) -> Void
    let onSelectScope: (SidebarMachineScope) -> Void
    let onSelectProject: (String) -> Void

    /// Keep keystrokes local to the command bar. Publishing every character
    /// to `SidebarView` synchronously rebuilds and sorts the full cross-device
    /// project projection before AppKit can draw the next glyph.
    @UIState private var draftSearchText = ""
    @UIState private var isScopePresented = false
    @UIState private var isProjectScopePresented = false
    @FocusState private var isSearchFocused: Bool

    var body: some View {
        HStack(spacing: 7) {
            searchField
            scopeChip(
                symbol: "folder",
                title: projectScopeTitle,
                isActive: isProjectScopePresented,
                isFiltered: projectScopeID != "all",
                help: "Filter tasks by project"
            ) {
                isProjectScopePresented.toggle()
            }
            .popover(isPresented: $isProjectScopePresented, arrowEdge: .top) {
                projectScopePopover
            }

            scopeChip(
                symbol: scopeSymbol,
                title: scopeTitle,
                isActive: isScopePresented,
                isFiltered: scope != .all,
                help: "Filter tasks by machine"
            ) {
                isScopePresented.toggle()
            }
            .popover(isPresented: $isScopePresented, arrowEdge: .top) {
                scopePopover
            }
        }
        .padding(.horizontal, 10)
        // Floor height shared with the chat identity header and the inspector
        // Activity header, so the divider under this bar lands on the same
        // baseline as the dividers under those two. A floor (not a fixed
        // height) so the bar can grow instead of clipping if its controls ever
        // exceed the band (see AlpineTheme.contentHeaderHeight).
        .frame(minHeight: AlpineTheme.contentHeaderHeight)
        .onAppear {
            draftSearchText = searchText
        }
        .onChange(of: searchText) {
            if draftSearchText != searchText {
                draftSearchText = searchText
            }
        }
        .task(id: draftSearchText) {
            guard draftSearchText != searchText else { return }
            do {
                try await Task.sleep(for: .milliseconds(120))
            } catch {
                return
            }
            onSearchTextChange(draftSearchText)
        }
    }

    /// The field grows an accent ring on focus rather than swapping its fill:
    /// a sidebar-width control that changes background reads as a different
    /// control, while a ring reads as the same one, now listening.
    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.caption)
                .foregroundStyle(isSearchFocused ? AlpineTheme.accent : Color.secondary)
                .scaleEffect(isSearchFocused ? 1.1 : 1)
            TextField("Search tasks", text: $draftSearchText)
                .textFieldStyle(.plain)
                .focused($isSearchFocused)
            if !draftSearchText.isEmpty {
                Button {
                    draftSearchText = ""
                    onSearchTextChange("")
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(SidebarPressStyle(pressedScale: 0.8))
                .accessibilityLabel("Clear search")
                .transition(Motion.pop(from: .trailing))
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 28)
        .background(.quaternary.opacity(0.7), in: RoundedRectangle(cornerRadius: 7))
        .overlay {
            RoundedRectangle(cornerRadius: 7)
                .strokeBorder(AlpineTheme.accent.opacity(isSearchFocused ? 0.65 : 0), lineWidth: 1.5)
        }
        .animation(Motion.feedback, value: isSearchFocused)
        .animation(Motion.reveal, value: draftSearchText.isEmpty)
        // Search wins space over the project/machine filter labels (they
        // truncate first) so the field stays usable at min/ideal sidebar
        // widths.
        .layoutPriority(1)
    }

    /// One shape for both filter chips. `isFiltered` tints the chip so a
    /// sidebar that is hiding projects or machines says so at rest, not only
    /// when its label is read.
    ///
    /// The name rides along only while a filter is on. Two chips each carrying
    /// "All projects" / "All machines" next to a search field does not fit a
    /// 260pt sidebar — both labels truncated to nothing and the chips ended up
    /// icon-only anyway, just wider. Now the width is spent on the one case
    /// where the label carries information.
    private func scopeChip(
        symbol: String,
        title: String,
        isActive: Bool,
        isFiltered: Bool,
        help: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: symbol)
                if isFiltered {
                    Text(title)
                        .lineLimit(1)
                        .transition(Motion.pop(from: .leading))
                }
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(isFiltered ? AlpineTheme.accent : Color.primary)
            .frame(height: 28)
            .padding(.horizontal, 7)
            .background(
                (isFiltered ? AlpineTheme.accent : Color.primary)
                    .opacity(isActive ? 0.16 : (isFiltered ? 0.1 : 0.055)),
                in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
        }
        .buttonStyle(SidebarPressStyle(pressedScale: 0.96))
        .help(help)
        .accessibilityLabel("\(help): \(title)")
        .animation(Motion.feedback, value: isActive)
        .animation(Motion.structure, value: isFiltered)
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
    @UIState private var showingSnooze = false

    private var model: AppModel { item.member.location.model }
    private var providers: [ProviderKind] { model.configuredProviderKinds }

    var body: some View {
        VStack(spacing: 0) {
            if showingProviders {
                providerPage
            } else if showingSnooze {
                snoozePage
            } else {
                actionPage
            }
        }
        .animation(Motion.structure, value: showingProviders)
        .animation(Motion.structure, value: showingSnooze)
        // Probe hook (see UIProbeHooks): drives this menu's page swap and the
        // snooze commit when the accessibility tree does not resolve for
        // same-process clicks. Nothing posts it outside a probe run. Keys are
        // scoped by thread id because a dismissed popover's content view can
        // outlive its dismissal, and every mounted menu hears the post.
        .onReceive(NotificationCenter.default.publisher(for: .uiProbeMenuAction)) { note in
            guard let key = note.object as? String else { return }
            switch key {
            case "snooze-page:\(item.thread.id)":
                showingSnooze = true
            case "snooze-first-preset:\(item.thread.id)":
                if let preset = SnoozePreset.presets(now: Date()).first {
                    performSnooze(preset)
                }
            default:
                break
            }
        }
    }

    /// One definition of what picking a wake time does, shared by the preset
    /// rows and the probe hook above so the probe exercises the same commit.
    private func performSnooze(_ preset: SnoozePreset) {
        Haptics.play(.commit)
        dismiss()
        let thread = item.thread
        Task { await model.snoozeThread(thread, until: preset.until) }
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

                AlpineMenuRow(
                    icon: "arrow.triangle.branch",
                    title: "Branch Session"
                ) {
                    Haptics.play(.commit)
                    dismiss()
                    Task { await model.branchThread(item.thread) }
                }
                .disabled(!item.isSelectable)

                AlpineMenuSeparator()

                lifecycleRow

                snoozeRow

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
                // The lifecycle branch is part of the identity: settle and
                // un-settle share one slot, so the probe cannot tell the two
                // menus apart from the thread id alone.
                UIProbeMenus.record("thread:\(item.thread.id):\(lifecycleProbeLabel)")
            #endif
        }
    }

    #if DEBUG
        private var lifecycleProbeLabel: String {
            if item.thread.status != .settled, item.thread.status != .archived { return "settle" }
            return item.thread.status == .settled ? "unsettle" : "none"
        }
    #endif

    /// Snooze and wake are the same slot. Snooze is an overlay on the active
    /// lifecycle: the thread stays active on the wire and the sidebar
    /// suppresses it until `snoozedUntil` passes (no wake event) or the
    /// server clears it on real activity.
    @ViewBuilder
    private var snoozeRow: some View {
        if ThreadInboxSemantics.isSnoozed(item.thread) {
            AlpineMenuRow(icon: "moon.zzz", title: "Wake") {
                dismiss()
                Task { await model.unsnoozeThread(item.thread) }
            }
            .disabled(!item.isSelectable)
        } else if item.thread.status != .archived {
            AlpineMenuRow(icon: "moon.zzz", title: "Snooze", opensSubmenu: true) {
                showingSnooze = true
            }
            .disabled(!item.isSelectable)
        }
    }

    private var snoozePage: some View {
        VStack(spacing: 0) {
            ComposerPickerHeader(
                icon: "moon.zzz",
                title: "Snooze until",
                subtitle: item.thread.title,
                onBack: { showingSnooze = false },
                titleLineLimit: 1)
            Divider().opacity(0.55)
            AlpineMenuList {
                ForEach(SnoozePreset.presets(now: Date())) { preset in
                    AlpineMenuRow(icon: preset.icon, title: preset.title) {
                        performSnooze(preset)
                    }
                    .disabled(!item.isSelectable)
                }
            }
        }
        .onAppear {
            #if DEBUG
                UIProbeMenus.record("thread:\(item.thread.id):snooze-page")
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

/// A project's header row: the thing the whole sidebar is organized around.
///
/// It carries four pieces of state at three densities — the project's identity
/// (tile + name), its shape across machines (the badge), its workload
/// (subtitle + meter), and its actions — so a collapsed section still says
/// everything an expanded one does. The actions replace the meter on hover
/// rather than appearing beside it: the header is ~200pt wide at the default
/// sidebar size, and both at once pushed the name into truncation.
private struct ProjectSectionHeader: View {
    let group: SidebarProjectGroup
    let summary: SidebarProjectSummary
    let accent: Color
    let symbol: String
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

    /// Whether the trailing slot shows actions instead of the meter. Popovers
    /// keep it open so their anchor cannot vanish mid-interaction.
    private var showsActions: Bool {
        isHovering || isNewTaskPresented || isManagePresented
    }

    var body: some View {
        HStack(spacing: 7) {
            Button(action: onToggleCollapse) {
                SidebarDisclosureChevron(isExpanded: !isCollapsed)
                    .foregroundStyle(.secondary)
                    .contentShape(Rectangle())
            }
            .buttonStyle(SidebarPressStyle(pressedScale: 0.85))
            .accessibilityLabel(isCollapsed ? "Expand \(group.name)" : "Collapse \(group.name)")

            SidebarProjectTile(
                symbol: symbol,
                accent: accent,
                summary: summary,
                isHovering: isHovering)

            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 5) {
                    Text(group.name)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if let machineBadge {
                        SidebarPill { Text(machineBadge) }
                            .transition(Motion.pop(from: .leading))
                    }
                }
                // The census line: what this project is carrying, in words,
                // so the meter beside it never has to be decoded.
                Text(summary.subtitle)
                    .font(.system(size: 10))
                    .foregroundStyle(summary.needsAttention ? AlpineTheme.clay : Color.secondary)
                    .lineLimit(1)
                    .contentTransition(.numericText())
            }

            Spacer(minLength: 4)

            // One trailing slot, two occupants. Sized by the wider of the two
            // so the swap never re-lays the title out.
            ZStack(alignment: .trailing) {
                SidebarActivityMeter(summary: summary)
                    .opacity(showsActions ? 0 : 1)
                    .scaleEffect(showsActions ? 0.85 : 1, anchor: .trailing)
                    .accessibilityHidden(showsActions)

                headerActions
                    .opacity(showsActions ? 1 : 0)
                    .offset(x: showsActions || !Motion.profile.usesMovement ? 0 : 6)
                    .allowsHitTesting(showsActions)
                    .accessibilityHidden(!showsActions)
            }
            .frame(width: 44, alignment: .trailing)
        }
        .padding(.vertical, 4)
        // `List` gives a section header less trailing inset than it gives its
        // rows, which left the meter flush against the sidebar's edge while the
        // rows below it kept a margin.
        .padding(.trailing, 4)
        .background {
            SidebarHoverSurface(isActive: showsActions, cornerRadius: 7)
                .padding(.horizontal, -6)
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: onToggleCollapse)
        .onHover { isHovering = $0 }
        .animation(Motion.structure, value: isCollapsed)
        .animation(Motion.feedback, value: showsActions)
        .animation(Motion.ambient, value: summary)
        .animation(Motion.reveal, value: machineBadge)
        .alpineContextMenu(width: 300) { dismiss in
            projectMenu(dismiss: dismiss)
        }
    }

    private var headerActions: some View {
        HStack(spacing: 2) {
            // A plain button plus the app's own popover, not `Menu`: the
            // native menu drops a system-styled NSMenu on top of an
            // otherwise custom sidebar, and the "+" beside it already
            // opens an Alpine popover.
            Button {
                isManagePresented.toggle()
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 19, height: 19)
                    .background { SidebarHoverSurface(isActive: isManagePresented, cornerRadius: 5) }
                    .contentShape(Rectangle())
            }
            .buttonStyle(SidebarPressStyle())
            .help("Manage \(group.name)")
            .popover(isPresented: $isManagePresented, arrowEdge: .top) {
                projectMenu { isManagePresented = false }
            }

            Button {
                isNewTaskPresented.toggle()
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .bold))
                    .frame(width: 19, height: 19)
                    .background { SidebarHoverSurface(isActive: isNewTaskPresented, cornerRadius: 5) }
                    .contentShape(Rectangle())
            }
            .buttonStyle(SidebarPressStyle())
            .help("New session in \(group.name)")
            .popover(isPresented: $isNewTaskPresented, arrowEdge: .top) {
                newTaskPopover
            }
        }
        .foregroundStyle(.secondary)
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
}

private struct SidebarSubtreeDisclosure {
    let isExpanded: Bool
    let toggle: () -> Void
}

private struct SidebarThreadRow: View {
    let item: SidebarThreadItem
    let context: SidebarRowContext
    let isSelected: Bool
    let subtreeDisclosure: SidebarSubtreeDisclosure?

    @UIState private var isHovering = false

    var body: some View {
        HStack(spacing: 7) {
            if case .project(_, let accent, let index, let isLast) = context {
                SidebarThreadRail(
                    accent: accent,
                    isSelected: isSelected,
                    isLast: isLast,
                    index: index)
            }
            if let subtreeDisclosure {
                Button(action: subtreeDisclosure.toggle) {
                    SidebarDisclosureChevron(
                        isExpanded: subtreeDisclosure.isExpanded,
                        size: 8)
                        .foregroundStyle(.secondary)
                        .frame(width: 12, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(SidebarPressStyle(pressedScale: 0.84))
                .help(
                    subtreeDisclosure.isExpanded
                        ? "Hide auto-review activity" : "Show auto-review activity")
                .accessibilityLabel(
                    subtreeDisclosure.isExpanded
                        ? "Collapse auto-review activity" : "Expand auto-review activity")
            }
            // A working thread breathes, so a sidebar full of sessions says
            // which ones are alive without the user reading a single label.
            // `pulseGlow` is a phase animator, not a timeline clock, so a long
            // list of running threads stays cheap.
            SidebarStatusChip(
                symbol: item.statusSymbol,
                tint: item.statusTint,
                isWorking: item.isWorking)
                .scaleEffect(isHovering ? 1.08 : 1)
                .animation(Motion.ambient, value: item.thread.status)
                .accessibilityLabel(item.statusLabel)
                .help(item.statusLabel)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(item.thread.title)
                        .font(SurgeTypography.sidebarTaskTitle)
                        .fontWeight(isSelected ? .semibold : .regular)
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
            SidebarRunTape(item: item)
            if item.thread.backgroundAgentCount > 0 {
                SidebarPill {
                    Text("\(item.thread.backgroundAgentCount)")
                        .monospacedDigit()
                        .contentTransition(.numericText())
                }
                .transition(Motion.pop(from: .trailing))
                .help(
                    "\(item.thread.backgroundAgentCount) "
                        + (item.thread.backgroundAgentCount == 1
                            ? "sub-agent running" : "sub-agents running"))
            }
        }
        .padding(.vertical, 2)
        .background {
            // A whisper behind the hovered row. The List still owns selection;
            // this only says "the pointer is here", which the old rows left to
            // the cursor alone.
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color.primary.opacity(isHovering && !isSelected ? 0.05 : 0))
                .padding(.horizontal, -5)
        }
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
        .animation(Motion.reveal, value: isPinnedOrSelected)
        .animation(Motion.ambient, value: item.thread.backgroundAgentCount)
        .modifier(
            SidebarRowMoveTrail(
                tier: SidebarProjection.displayTier(item),
                tint: item.statusTint))
        .accessibilityElement(children: .combine)
    }

    /// One key for the two things that restyle the row's text, so the title's
    /// weight change and the pin's arrival share a transaction instead of
    /// racing each other.
    private var isPinnedOrSelected: Int {
        (item.isPinned ? 1 : 0) | (isSelected ? 2 : 0)
    }

    private var secondaryText: String {
        let parts: [String]
        switch context {
        case .search:
            parts = [item.member.project.name, item.member.location.name, workMetadata]
        case .project(let showMachine, _, _, _):
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

/// A non-selectable automation process. The reviewer has no transcript-backed
/// thread, and an inline fixer deliberately works in the origin thread, so
/// both are shown honestly without inventing a destination.
private struct AutoReviewAutomationRow: View {
    let title: String
    let detail: String
    let symbol: String
    let tint: Color
    let isWorking: Bool

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "arrow.turn.down.right")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(.tertiary)
                .frame(width: 22)
            SidebarStatusChip(symbol: symbol, tint: tint, isWorking: isWorking)
                .help(detail)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(SurgeTypography.sidebarTaskTitle)
                    .lineLimit(1)
                Text(detail)
                    .font(SurgeTypography.technicalMetadata)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Text("AUTOMATION")
                .font(.system(size: 8, weight: .semibold))
                .tracking(0.45)
                .foregroundStyle(.tertiary)
        }
        .padding(.leading, 17)
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(detail)")
    }
}

/// A real dedicated fixer thread nested beneath the session whose PR it
/// repairs. It stays a normal List selection target, so opening it uses the
/// same detail navigation and transcript loading as every other session.
private struct AutoReviewFixerThreadRow: View {
    let item: SidebarThreadItem
    let isSelected: Bool

    @UIState private var isHovering = false

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "arrow.turn.down.right")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(.tertiary)
                .frame(width: 22)
            SidebarStatusChip(
                symbol: item.statusSymbol,
                tint: item.statusTint,
                isWorking: item.isWorking)
                .help(item.statusLabel)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.thread.title)
                    .font(SurgeTypography.sidebarTaskTitle)
                    .fontWeight(isSelected ? .semibold : .regular)
                    .lineLimit(1)
                Text("\(item.thread.provider.displayName) · \(item.statusLabel)")
                    .font(SurgeTypography.technicalMetadata)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right")
                .font(.system(size: 8, weight: .semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .padding(.leading, 17)
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .background {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color.primary.opacity(isHovering && !isSelected ? 0.05 : 0))
                .padding(.horizontal, -5)
        }
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.thread.title), \(item.statusLabel)")
        .help("Open the auto-fixer thread")
    }
}

/// Miniature run tape at a sidebar row's trailing edge: one bar per recent
/// turn, tinted by the turn's dominant signal, so "which of my running
/// agents is thrashing" reads from the sidebar without opening anything.
///
/// The tape only exists where the timeline does — the app retains a handful
/// of timeline subscriptions, so unvisited threads simply show no tape
/// rather than a fabricated one. Reading `model.timeline` here subscribes
/// the row to that one thread's timeline writes, which is the observation
/// granularity `ThreadState` exists to provide.
private struct SidebarRunTape: View {
    let item: SidebarThreadItem

    /// Cap so a 100-turn thread doesn't grow a mural; the recent tail is
    /// the actionable part.
    private static let maxCells = 12

    var body: some View {
        let model = item.member.location.model
        let threadID = item.thread.id
        let timeline = model.timeline(threadID: threadID)
        if !timeline.isEmpty {
            let cells = RunTapeCache.tape(
                timeline: timeline,
                threadID: model.scopedThreadKey(threadID),
                structureVersion: model.timelineStructureVersion(threadID: threadID)
            ).suffix(Self.maxCells)
            if cells.count >= 2 {
                HStack(spacing: 2) {
                    ForEach(cells) { cell in
                        Capsule()
                            .fill(tint(for: cell).opacity(0.6))
                            .frame(width: 3, height: 7)
                    }
                }
                .help(helpText(Array(cells)))
                .accessibilityHidden(true)
            }
        }
    }

    private func tint(for cell: RunTapeCell) -> Color {
        if cell.hasRunningTool && !item.thread.status.isSettled {
            return AlpineTheme.accent
        }
        switch cell.signal {
        case .fail: return AlpineTheme.destructive
        case .edit: return AlpineTheme.statusSuccess
        case .work: return AlpineTheme.sky
        case .talk: return Color.secondary
        }
    }

    private func helpText(_ cells: [RunTapeCell]) -> String {
        let failed = cells.reduce(0) { $0 + $1.failedCount }
        let tools = cells.reduce(0) { $0 + $1.toolCount }
        var line = "Last \(cells.count) turns · \(tools) tools"
        if failed > 0 { line += " · \(failed) failed" }
        return line
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

    /// Whether something is actually running for this thread — the parent
    /// agent, its subagents, or the auto-reviewer. Narrower than
    /// `!isSettled`, which also covers threads parked on a question: those
    /// want attention, not a "still going" cue.
    @MainActor var isWorking: Bool {
        if hasConnectionIssue { return false }
        switch thread.status {
        case .running, .backgroundWork, .reviewing, .fixing: return true
        case .idle, .waiting, .waitingApproval, .waitingInput, .error, .archived, .settled,
            .done, .readyToMerge:
            return false
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
