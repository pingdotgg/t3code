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
    case thread(String)
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
    @State private var selectedTaskLane: TaskLane = .inProgress

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
                            onSelectThread: { threadId in
                                if isSearching {
                                    isSearching = false
                                    searchQuery = ""
                                }
                                navigationPath.append(.thread(threadId))
                            }
                        )
                    case .tasks:
                        TasksTabView(
                            searchQuery: isSearching ? searchQuery : "",
                            selectedLane: $selectedTaskLane
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
            .safeAreaInset(edge: .bottom, spacing: 0) {
                WorkspacePhoneBar(
                    selectedTab: $selectedTab,
                    isSearching: $isSearching,
                    searchQuery: $searchQuery,
                    filterActive: selectedTab == .threads
                        ? selectedProjectFilter != nil
                        : (selectedTab == .tasks && selectedTaskLane != .inProgress),
                    projects: store.shell?.projects ?? [],
                    selectedProjectFilter: $selectedProjectFilter,
                    selectedTaskLane: $selectedTaskLane,
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
            .navigationDestination(for: WorkspaceRoute.self) { route in
                switch route {
                case let .thread(threadId):
                    let summary = store.shell?.threads.first(where: { $0.id == threadId })
                    let projectTitle = summary.flatMap { s in
                        store.shell?.projects.first(where: { $0.id == s.projectId })?.title
                    }
                    ThreadView(
                        store: store,
                        threadId: threadId,
                        initialTitle: summary?.title ?? "Thread",
                        initialProjectTitle: projectTitle,
                        initialBranch: summary?.branch,
                        initialSettled: summary?.settled ?? false,
                        onOpenThread: { childId in
                            navigationPath.append(.thread(childId))
                        }
                    )
                case let .newThreadDraft(projectId, title):
                    NewThreadDraftView(
                        store: store,
                        initialProjectId: projectId,
                        initialProjectTitle: title,
                        onCreated: { newThreadId in
                            navigationPath = [.thread(newThreadId)]
                        }
                    )
                }
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsRootSheet(store: store)
                .presentationDetents([.large])
        }
    }
}

// MARK: - WorkspacePhoneBar (1:1 port of WorkspacePhoneBar.tsx)

private struct WorkspacePhoneBar: View {
    @Binding var selectedTab: WorkspaceTab
    @Binding var isSearching: Bool
    @Binding var searchQuery: String
    let filterActive: Bool
    let projects: [FfiProject]
    @Binding var selectedProjectFilter: String?
    @Binding var selectedTaskLane: TaskLane
    let onOpenSettings: () -> Void
    let onNewChat: () -> Void

    @Environment(\.connTheme) private var theme
    @FocusState private var searchFocused: Bool

    private let switcherHeight: CGFloat = 48
    private let switcherPadding: CGFloat = 4

    var body: some View {
        HStack(spacing: 10) {
            // Leading glass "…" button -> opens Settings
            Button(action: onOpenSettings) {
                ConnIcon("ellipsis")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(theme.foreground)
                    .frame(width: 48, height: 48)
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open settings")
            .accessibilityIdentifier("workspace.settingsButton")

            if isSearching {
                searchField
            } else {
                Spacer(minLength: 0)
                switcherGroup
                Spacer(minLength: 0)

                // Trailing glass "+" button -> opens New chat
                Button(action: onNewChat) {
                    ConnIcon("plus")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .frame(width: 48, height: 48)
                        .glassEffect(.regular.interactive(), in: .circle)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("New chat")
                .accessibilityIdentifier("inbox.newThreadButton")
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    private var switcherGroup: some View {
        HStack(spacing: 0) {
            switcherButton(tab: .threads, icon: "text.bubble", label: "Threads")
            switcherButton(tab: .tasks, icon: "checklist", label: "Tasks")
            switcherButton(tab: .pullRequests, icon: "arrow.triangle.pull", label: "Pull requests")
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isSearching = true
                }
                searchFocused = true
            } label: {
                ConnIcon("magnifyingglass")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(theme.mutedForeground)
                    .frame(maxWidth: 64, maxHeight: .infinity)
                    .frame(minWidth: 48)
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Search")
            .accessibilityIdentifier("workspace.searchButton")
        }
        .frame(height: switcherHeight)
        .padding(.vertical, switcherPadding)
        .padding(.horizontal, 4)
        .glassEffect(.regular, in: .capsule)
    }

    private func switcherButton(tab: WorkspaceTab, icon: String, label: String) -> some View {
        let selected = selectedTab == tab
        return Button {
            selectedTab = tab
        } label: {
            ConnIcon(icon)
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(selected ? theme.foreground : theme.mutedForeground)
                .frame(maxWidth: 64, maxHeight: .infinity)
                .frame(minWidth: 48)
                .background(
                    selected
                        ? Capsule().fill(theme.foreground.opacity(0.12))
                        : nil
                )
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("workspace.tab.\(tab.rawValue)")
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            ConnIcon("magnifyingglass")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(theme.mutedForeground)

            TextField(selectedTab.searchPlaceholder, text: $searchQuery)
                .font(.system(size: 16))
                .foregroundStyle(theme.foreground)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($searchFocused)
                .submitLabel(.search)
                .accessibilityIdentifier("workspace.searchField")

            if !searchQuery.isEmpty {
                Button {
                    searchQuery = ""
                } label: {
                    ConnIcon("xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(theme.mutedForeground)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }

            filterMenuButton

            Button {
                searchFocused = false
                searchQuery = ""
                withAnimation(.easeInOut(duration: 0.2)) {
                    isSearching = false
                }
            } label: {
                ConnIcon("xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(theme.foreground)
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel search")
            .accessibilityIdentifier("workspace.cancelSearchButton")
        }
        .padding(.horizontal, 14)
        .frame(height: 48)
        .glassEffect(.regular, in: .capsule)
    }

    @ViewBuilder
    private var filterMenuButton: some View {
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
            } else if selectedTab == .tasks {
                ForEach(TaskLane.allCases) { lane in
                    Button {
                        selectedTaskLane = lane
                    } label: {
                        if selectedTaskLane == lane {
                            Label(lane.label, systemImage: "checkmark")
                        } else {
                            Text(lane.label)
                        }
                    }
                }
            }
        } label: {
            ConnIcon(filterActive ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease")
                .font(.system(size: 17))
                .foregroundStyle(filterActive ? theme.primary : theme.mutedForeground)
                .frame(width: 28, height: 28)
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

// MARK: - TasksTabView (1:1 port of TasksScreen.tsx)

enum TaskLane: String, CaseIterable, Identifiable {
    case inProgress = "in-progress"
    case upNext = "up-next"
    case done = "done"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .inProgress: "In progress"
        case .upNext: "Up next"
        case .done: "Done"
        }
    }
}

struct TasksTabView: View {
    let searchQuery: String
    @Binding var selectedLane: TaskLane
    @Environment(\.connTheme) private var theme

    var body: some View {
        ZStack(alignment: .top) {
            ScrollView {
                VStack(spacing: 12) {
                    Text(searchQuery.isEmpty ? "Nothing here" : "No matching tasks")
                        .font(.system(size: 15))
                        .foregroundStyle(theme.mutedForeground)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .padding(.vertical, 48)
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 60)
            }
            .background(theme.background)

            // Centered top bar matching TasksTopBar in TasksScreen.tsx
            HStack {
                Spacer().frame(width: 44)
                VStack(spacing: 1) {
                    Text("Tasks")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1)
                    Text("\(selectedLane.label) · 0")
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(theme.mutedForeground)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)

                Menu {
                    ForEach(TaskLane.allCases) { lane in
                        Button {
                            selectedLane = lane
                        } label: {
                            if selectedLane == lane {
                                Label(lane.label, systemImage: "checkmark")
                            } else {
                                Text(lane.label)
                            }
                        }
                    }
                } label: {
                    ConnIcon("line.3.horizontal.decrease")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .frame(width: 44, height: 44)
                        .glassEffect(.regular.interactive(), in: .circle)
                }
                .accessibilityLabel("Filter tasks")
            }
            .padding(.horizontal, 16)
            .frame(height: 56)
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
