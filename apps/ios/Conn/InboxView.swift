import DesignKit
import SwiftUI

struct InboxView: View {
    @Bindable var store: CoreStore
    @Environment(\.connTheme) private var theme

    @State private var navigationPath: [String] = []
    @State private var searchText = ""
    @State private var settledExpanded = false
    @State private var showingNewThread = false
    @State private var renamingThread: FfiThreadSummary?
    @State private var renameDraft = ""

    private struct ProjectGroup: Identifiable {
        let id: String
        let title: String
        let threads: [FfiThreadSummary]
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            Group {
                if let shell = store.shell, shell.synchronized {
                    inboxList(shell: shell)
                } else {
                    loadingState
                }
            }
            .background(theme.background.ignoresSafeArea())
            .navigationTitle("Chats")
            .searchable(text: $searchText, prompt: "Search threads")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ConnectionStatusPill(status: store.status)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingNewThread = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .accessibilityLabel("New Thread")
                    .accessibilityIdentifier("inbox.newThreadButton")
                }
            }
            .navigationDestination(for: String.self) { threadId in
                let summary = store.shell?.threads.first(where: { $0.id == threadId })
                ThreadView(
                    store: store,
                    threadId: threadId,
                    initialTitle: summary?.title ?? "Thread",
                    initialBranch: summary?.branch,
                    onOpenThread: { childId in
                        navigationPath.append(childId)
                    }
                )
            }
            .sheet(isPresented: $showingNewThread) {
                NewThreadView(store: store) { newThreadId in
                    navigationPath.append(newThreadId)
                }
            }
            .alert(
                "Rename Thread",
                isPresented: Binding(
                    get: { renamingThread != nil },
                    set: { if !$0 { renamingThread = nil } }
                )
            ) {
                TextField("Title", text: $renameDraft)
                Button("Cancel", role: .cancel) {
                    renamingThread = nil
                }
                Button("Save") {
                    if let target = renamingThread {
                        let newTitle = renameDraft
                        renamingThread = nil
                        Task {
                            await store.renameThread(threadId: target.id, title: newTitle)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func inboxList(shell: FfiShellSnapshot) -> some View {
        let projectTitles = Dictionary(uniqueKeysWithValues: shell.projects.map { ($0.id, $0.title) })
        let filtered = filteredThreads(in: shell, projectTitles: projectTitles)
        let pinned = filtered.filter { !$0.settled && $0.pinned }
            .sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
        let activeGroups = groupedActiveThreads(
            filtered.filter { !$0.settled && !$0.pinned },
            projectTitles: projectTitles
        )
        let settled = filtered.filter { $0.settled }
            .sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }

        if pinned.isEmpty && activeGroups.isEmpty && settled.isEmpty {
            emptyState
        } else {
            List {
                if let error = store.lastError, !error.isEmpty {
                    Section {
                        KitNotice(error, icon: .warning, tone: .error) {
                            Button("Retry") {
                                store.reconnect()
                            }
                            .buttonStyle(.kit)
                        }
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                    }
                }

                if !pinned.isEmpty {
                    Section("Pinned") {
                        ForEach(pinned, id: \.id) { thread in
                            threadRow(thread, settled: false)
                        }
                    }
                }

                ForEach(activeGroups) { group in
                    Section(group.title) {
                        ForEach(group.threads, id: \.id) { thread in
                            threadRow(thread, settled: false)
                        }
                    }
                }

                if !settled.isEmpty {
                    Section {
                        Button {
                            withAnimation(Kit.Motion.base) {
                                settledExpanded.toggle()
                            }
                        } label: {
                            HStack {
                                Text("Settled")
                                    .font(.kitLabel.weight(.medium))
                                    .foregroundStyle(theme.mutedForeground)
                                KitBadge(count: settled.count)
                                Spacer()
                                KitIconImage(.chevronRight, size: 11, weight: .semibold)
                                    .foregroundStyle(theme.mutedForeground)
                                    .rotationEffect(.degrees(settledExpanded ? 90 : 0))
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("inbox.settledHeader")

                        if settledExpanded {
                            ForEach(settled, id: \.id) { thread in
                                threadRow(thread, settled: true)
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(theme.background)
        }
    }

    private func threadRow(_ thread: FfiThreadSummary, settled: Bool) -> some View {
        Button {
            navigationPath.append(thread.id)
        } label: {
            KitListRow(
                thread.title.isEmpty ? "Untitled thread" : thread.title,
                indicator: indicator(for: thread.activity),
                chip: thread.branch,
                chipIcon: thread.branch != nil ? .branch : nil,
                timestamp: parseISODate(from: thread.updatedAt),
                showsChevron: true
            ) {
                HStack(spacing: Kit.Space.xs) {
                    if thread.pinned {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(theme.mutedForeground)
                            .accessibilityLabel("Pinned")
                    }
                    if thread.unread {
                        Circle()
                            .fill(theme.primary)
                            .frame(width: 8, height: 8)
                            .accessibilityLabel("Unread")
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets())
        .listRowBackground(theme.background)
        .accessibilityIdentifier(settled ? "inbox.settledThread.\(thread.id)" : "inbox.thread.\(thread.id)")
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button {
                Task {
                    await store.settleThread(threadId: thread.id, settled: !settled)
                }
            } label: {
                Label(settled ? "Unsettle" : "Settle", systemImage: settled ? "arrow.uturn.backward" : "checkmark.circle")
            }
            .tint(settled ? .blue : .green)

            Button(role: .destructive) {
                Task {
                    await store.deleteThread(threadId: thread.id)
                }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            Button {
                Task {
                    await store.pinThread(threadId: thread.id, pinned: !thread.pinned)
                }
            } label: {
                Label(thread.pinned ? "Unpin" : "Pin", systemImage: thread.pinned ? "pin.slash" : "pin")
            }
            .tint(.orange)

            if !thread.unread {
                Button {
                    Task {
                        await store.markThreadUnread(threadId: thread.id)
                    }
                } label: {
                    Label("Unread", systemImage: "envelope.badge")
                }
                .tint(.indigo)
            }
        }
        .contextMenu {
            Button {
                Task {
                    await store.pinThread(threadId: thread.id, pinned: !thread.pinned)
                }
            } label: {
                Label(thread.pinned ? "Unpin" : "Pin", systemImage: thread.pinned ? "pin.slash" : "pin")
            }

            Button {
                Task {
                    await store.settleThread(threadId: thread.id, settled: !settled)
                }
            } label: {
                Label(settled ? "Unsettle" : "Settle", systemImage: settled ? "arrow.uturn.backward" : "checkmark.circle")
            }

            if !thread.unread {
                Button {
                    Task {
                        await store.markThreadUnread(threadId: thread.id)
                    }
                } label: {
                    Label("Mark Unread", systemImage: "envelope.badge")
                }
            }

            Button {
                renameDraft = thread.title
                renamingThread = thread
            } label: {
                Label("Rename", systemImage: "pencil")
            }

            Divider()

            Button(role: .destructive) {
                Task {
                    await store.deleteThread(threadId: thread.id)
                }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private func indicator(for activity: FfiThreadActivity) -> KitListRowIndicator {
        switch activity {
        case .idle: .idle
        case .working: .status(.working)
        case .needsAttention: .status(.warning)
        case .failed: .status(.error)
        }
    }

    private var loadingState: some View {
        VStack(spacing: Kit.Space.m) {
            KitStatusIcon(.working, size: 22, label: "Syncing")
            Text("Syncing threads…")
                .font(.kitLabel)
                .foregroundStyle(theme.mutedForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyState: some View {
        VStack(spacing: Kit.Space.s) {
            Text(searchText.isEmpty ? "No threads yet" : "No matching threads")
                .font(.kitLabel)
                .foregroundStyle(theme.mutedForeground)
            Text(
                searchText.isEmpty
                    ? "Tap the compose button to start a new thread."
                    : "Try a different search query."
            )
            .font(.kitDetail)
            .foregroundStyle(theme.mutedForeground.opacity(0.8))
            .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 32)
    }

    private func filteredThreads(
        in shell: FfiShellSnapshot,
        projectTitles: [String: String]
    ) -> [FfiThreadSummary] {
        let nonSubagents = shell.threads.filter { !$0.isSubagent }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return nonSubagents }
        return nonSubagents.filter { thread in
            if thread.title.lowercased().contains(query) { return true }
            if let branch = thread.branch, branch.lowercased().contains(query) { return true }
            if let project = projectTitles[thread.projectId], project.lowercased().contains(query) {
                return true
            }
            return false
        }
    }

    private func groupedActiveThreads(
        _ active: [FfiThreadSummary],
        projectTitles: [String: String]
    ) -> [ProjectGroup] {
        var buckets: [String: [FfiThreadSummary]] = [:]
        var projectOrder: [String] = []
        for thread in active {
            if buckets[thread.projectId] == nil {
                projectOrder.append(thread.projectId)
            }
            buckets[thread.projectId, default: []].append(thread)
        }

        return projectOrder.compactMap { projectId in
            guard let rows = buckets[projectId], !rows.isEmpty else { return nil }
            let sorted = rows.sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
            return ProjectGroup(
                id: projectId,
                title: projectTitles[projectId] ?? "General",
                threads: sorted
            )
        }
    }
}

private func parseISODate(from iso: String?) -> Date? {
    guard let iso, !iso.isEmpty else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: iso) {
        return date
    }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: iso)
}
