import DesignKit
import SwiftUI

enum WorkspaceTab: String, Hashable, CaseIterable {
    case threads
    case tasks
    case pullRequests

    var searchPlaceholder: String {
        switch self {
        case .threads: "Search threads"
        case .tasks: "Search tasks"
        case .pullRequests: "Search pull requests"
        }
    }
}

enum WorkspaceRoute: Hashable {
    case thread(String, scope: String)
    case newThreadDraft(projectId: String?, title: String)
}

struct WorkspaceRootView: View {
    @Bindable var store: CoreStore
    @Environment(\.connTheme) private var theme

    @State private var selectedTab: WorkspaceTab = .threads
    @State private var navigationPath: [WorkspaceRoute] = []
    @State private var showingSettings = false
    @State private var isSearching = false
    @State private var searchQuery = ""
    @State private var selectedProjectFilter: String? = nil
    @State private var tasks = TasksModel()
    @State private var windowWidth: CGFloat = 393

    var body: some View {
        NavigationStack(path: $navigationPath) {
            ZStack(alignment: .bottom) {
                Group {
                    switch selectedTab {
                    case .threads:
                        InboxView(
                            store: store,
                            searchQuery: isSearching ? searchQuery : "",
                            selectedProjectFilter: $selectedProjectFilter,
                            onSelectThread: { threadId, scope in
                                if isSearching {
                                    isSearching = false
                                    searchQuery = ""
                                }
                                navigationPath.append(.thread(threadId, scope: scope))
                            }
                        )
                    case .tasks:
                        TasksTabView(
                            model: tasks,
                            searchQuery: isSearching ? searchQuery : ""
                        )
                    case .pullRequests:
                        PullRequestsTabView(
                            searchQuery: isSearching ? searchQuery : ""
                        )
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(theme.background.ignoresSafeArea())

                if let status = store.status, status != .connected {
                    HomeConnectionStatusOverlay(status: status) {
                        showingSettings = true
                    }
                    .padding(.bottom, 12)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            // `WorkspacePhoneBar.tsx`: the navigation controller's bottom UIToolbar, not a tab bar.
            .toolbar {
                WorkspacePhoneBar(
                    selectedTab: $selectedTab,
                    isSearching: $isSearching,
                    windowWidth: windowWidth,
                    filterActive: selectedTab == .threads
                        ? selectedProjectFilter != nil
                        : (selectedTab == .tasks && tasks.lane != .inProgress),
                    projects: store.shell?.projects ?? [],
                    selectedProjectFilter: $selectedProjectFilter,
                    taskLanes: selectedTab == .tasks
                        ? tasks.view(query: isSearching ? searchQuery : "").lanes
                        : [],
                    onSelectTaskLane: { tasks.lane = $0 },
                    onOpenSettings: { showingSettings = true },
                    onNewChat: {
                        let defaultProject = store.shell?.projects.first(where: { !isScratchProjectTitle($0.title) })
                        navigationPath.append(
                            .newThreadDraft(
                                projectId: defaultProject?.id,
                                title: defaultProject?.title ?? "General"
                            )
                        )
                    }
                )
            }
            .toolbar(.visible, for: .bottomBar)
            // The magnifier swaps the switcher for UIKit's integrated toolbar search field.
            .searchable(
                text: $searchQuery,
                isPresented: $isSearching,
                prompt: Text(selectedTab.searchPlaceholder)
            )
            .onChange(of: isSearching) { _, searching in
                if !searching { searchQuery = "" }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { windowWidth = $0 }
            .navigationDestination(for: WorkspaceRoute.self) { route in
                switch route {
                case let .thread(threadId, scope):
                    if let owner = scope.isEmpty ? store : store.linked[scope] {
                        let summary = owner.shell?.threads.first(where: { $0.id == threadId })
                        let projectTitle = summary.flatMap { s in
                            owner.shell?.projects.first(where: { $0.id == s.projectId })?.title
                        }
                        ThreadView(
                            store: owner,
                            threadId: threadId,
                            initialTitle: summary?.title ?? "Thread",
                            initialProjectTitle: projectTitle,
                            initialBranch: summary?.branch,
                            initialSettled: summary?.settled ?? false,
                            onOpenThread: { childId in
                                navigationPath.append(.thread(childId, scope: scope))
                            }
                        )
                    }
                case let .newThreadDraft(projectId, title):
                    NewThreadDraftView(
                        store: store,
                        initialProjectId: projectId,
                        initialProjectTitle: title,
                        onCreated: { newThreadId in
                            navigationPath = [.thread(newThreadId, scope: "")]
                        }
                    )
                }
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsRootSheet(store: store)
                .presentationDetents([.large])
        }
        .onAppear {
            showPendingLink()
            store.isInboxVisible = inboxOnScreen
        }
        .onDisappear { store.isInboxVisible = false }
        .onChange(of: inboxOnScreen) { _, visible in store.isInboxVisible = visible }
        .onChange(of: store.pendingLink) { _, _ in showPendingLink() }
    }

    /// The thread list is what the user sees: no thread pushed, no sheet, not searching.
    private var inboxOnScreen: Bool {
        navigationPath.isEmpty && selectedTab == .threads && !showingSettings && !isSearching
    }

    /// Shows a thread from a `conn://thread/...` URL or a push tap.
    private func showPendingLink() {
        guard let link = store.consumePendingLink() else { return }
        showingSettings = false
        isSearching = false
        searchQuery = ""
        selectedTab = .threads
        let scope = store.linked.first { $0.value.environmentId == link.environmentId }?.key ?? ""
        navigationPath = [.thread(link.threadId, scope: scope)]
    }
}

// MARK: - WorkspacePhoneBar (1:1 port of WorkspacePhoneBar.tsx)

/// Resting: `[ellipsis] ⟷ [switcher group] ⟷ [plus]`. Searching: `[ellipsis] [filter] [search
/// field] 8 [plus]`. The items share the toolbar's glass (`sharesBackground: true`); none draws
/// its own.
private struct WorkspacePhoneBar: ToolbarContent {
    @Binding var selectedTab: WorkspaceTab
    @Binding var isSearching: Bool
    let windowWidth: CGFloat
    let filterActive: Bool
    let projects: [FfiProject]
    @Binding var selectedProjectFilter: String?
    let taskLanes: [FfiPhoneTaskLane]
    let onSelectTaskLane: (FfiTaskLane) -> Void
    let onOpenSettings: () -> Void
    let onNewChat: () -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: .bottomBar) {
            Button(action: onOpenSettings) {
                connImage("ellipsis")
            }
            .accessibilityLabel("Open settings")
            .accessibilityIdentifier("workspace.settingsButton")
        }
        if isSearching {
            // Mobile passes no filter menu on the PR tab (`PullRequestsScreen.tsx`).
            if selectedTab != .pullRequests {
                ToolbarItem(placement: .bottomBar) {
                    WorkspaceFilterMenu(
                        selectedTab: selectedTab,
                        filterActive: filterActive,
                        projects: projects,
                        selectedProjectFilter: $selectedProjectFilter,
                        taskLanes: taskLanes,
                        onSelectTaskLane: onSelectTaskLane
                    )
                }
            }
            DefaultToolbarItem(kind: .search, placement: .bottomBar)
            ToolbarSpacer(.fixed, placement: .bottomBar)
        } else {
            ToolbarSpacer(.flexible, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) {
                WorkspacePhoneSwitcher(
                    selectedTab: $selectedTab,
                    // Mobile's `min(64 × items, W − 160)` assumes UIKit's own item padding; a SwiftUI
                    // item adds 8pt a side, which would push the group into the overflow menu.
                    width: min(64 * 4, windowWidth - 176),
                    onSearch: { isSearching = true }
                )
            }
            ToolbarSpacer(.flexible, placement: .bottomBar)
        }
        ToolbarItem(placement: .bottomBar) {
            Button(action: onNewChat) {
                connImage("plus")
            }
            .accessibilityLabel("New chat")
            .accessibilityIdentifier("inbox.newThreadButton")
        }
    }
}

/// `WorkspacePhoneSwitcher`: 48 tall with 4pt vertical padding; 22pt icons; the selected one sits
/// on a 40-tall pill (radius 20, `bg-foreground/12`, `accent-foreground`), the rest are muted.
private struct WorkspacePhoneSwitcher: View {
    @Binding var selectedTab: WorkspaceTab
    let width: CGFloat
    let onSearch: () -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        HStack(spacing: 0) {
            item(.threads, icon: "text.bubble", label: "Threads")
            item(.tasks, icon: "checklist", label: "Tasks")
            item(.pullRequests, icon: "arrow.triangle.pull", label: "Pull requests")
            Button(action: onSearch) {
                toolbarIcon("magnifyingglass")
                    .foregroundStyle(theme.mutedForeground)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Search")
            .accessibilityIdentifier("workspace.searchButton")
        }
        .padding(.vertical, 4)
        .frame(width: width, height: 48)
        .fixedSize()
    }

    /// 22pt icons. A bar item lays out from UIImage sizes, so the asset is framed explicitly.
    private func toolbarIcon(_ name: String) -> some View {
        connImage(name)
            .resizable()
            .scaledToFit()
            .frame(width: 22, height: 22)
    }

    private func item(_ tab: WorkspaceTab, icon: String, label: String) -> some View {
        let selected = selectedTab == tab
        return Button {
            selectedTab = tab
        } label: {
            toolbarIcon(icon)
                .foregroundStyle(selected ? theme.accentForeground : theme.mutedForeground)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background {
                    if selected {
                        Capsule().fill(theme.foreground.opacity(0.12))
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("workspace.tab.\(tab.rawValue)")
    }
}

/// The filter beside the search field: projects on Threads, lanes on Tasks.
private struct WorkspaceFilterMenu: View {
    let selectedTab: WorkspaceTab
    let filterActive: Bool
    let projects: [FfiProject]
    @Binding var selectedProjectFilter: String?
    let taskLanes: [FfiPhoneTaskLane]
    let onSelectTaskLane: (FfiTaskLane) -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        Menu {
            if selectedTab == .threads {
                Button {
                    selectedProjectFilter = nil
                } label: {
                    if selectedProjectFilter == nil {
                        Label("All projects", systemImage: "checkmark")
                    } else {
                        Text("All projects")
                    }
                }
                ForEach(projects, id: \.id) { project in
                    Button {
                        selectedProjectFilter = project.id
                    } label: {
                        if selectedProjectFilter == project.id {
                            Label(project.title, systemImage: "checkmark")
                        } else {
                            Text(project.title)
                        }
                    }
                }
            } else {
                Section("Lanes") {
                    TaskLaneMenuItems(lanes: taskLanes, onSelect: onSelectTaskLane)
                }
            }
        } label: {
            connImage(filterActive ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease")
                .foregroundStyle(filterActive ? theme.primary : theme.foreground)
        }
        .accessibilityLabel("Filter")
    }
}

// MARK: - HomeConnectionStatusOverlay

private struct HomeConnectionStatusOverlay: View {
    let status: FfiConnectionStatus
    let onTap: () -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 6) {
                Circle()
                    .fill(dotColor)
                    .frame(width: 7, height: 7)
                Text(label)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(theme.foreground)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .glassEffect(.regular, in: .capsule)
        }
        .buttonStyle(.plain)
    }

    private var dotColor: Color {
        switch status {
        case .connected: theme.success
        case .connecting, .reconnecting: theme.warning
        case .failed: theme.destructive
        }
    }

    private var label: String {
        switch status {
        case .connected: "Connected"
        case .connecting: "Connecting…"
        case let .reconnecting(attempt): "Reconnecting (\(attempt))…"
        case .failed: "Connection failed"
        }
    }
}

// MARK: - PullRequestsTabView (1:1 port of PullRequestsScreen.tsx)

struct PullRequestsTabView: View {
    let searchQuery: String
    @Environment(\.connTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                Text(searchQuery.isEmpty ? "No pull requests" : "No matching pull requests")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Text("Pull requests from connected environments will appear here.")
                    .font(.system(size: 15))
                    .foregroundStyle(theme.mutedForeground)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 32)
            .padding(.top, 96)
        }
        .background(theme.background)
        .scrollEdgeEffectStyle(.soft, for: .top)
        .scrollEdgeEffectHidden(true, for: .bottom)
    }
}

struct ConnectionStatusPill: View {
    let status: FfiConnectionStatus?

    var body: some View {
        switch status {
        case .connected:
            KitStatusPill("Connected", tone: .ok)
        case .connecting, .none:
            KitStatusPill("Connecting", tone: .working)
        case let .reconnecting(attempt):
            KitStatusPill("Reconnecting (\(attempt))", tone: .working)
        case .failed:
            KitStatusPill("Failed", tone: .error)
        }
    }
}
