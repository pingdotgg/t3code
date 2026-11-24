import DesignKit
import SwiftUI

struct InboxView: View {
    @Bindable var store: CoreStore
    let searchQuery: String
    @Binding var selectedProjectFilter: String?
    let onSelectThread: (String, String) -> Void

    @Environment(\.connTheme) private var theme
    @State private var settledExpanded = false
    @State private var renameOwner: CoreStore?
    @State private var renamingThread: FfiThreadSummary?
    @State private var renameDraft = ""

    var body: some View {
        Group {
            if let shell = store.shell {
                inboxList(shell: shell)
            } else if store.linked.values.contains(where: { $0.shell != nil }) {
                inboxList(shell: FfiShellSnapshot(projects: [], threads: [], synchronized: false))
            } else {
                loadingState
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.background.ignoresSafeArea())
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
                        await (renameOwner ?? store).renameThread(threadId: target.id, title: newTitle)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func inboxList(shell: FfiShellSnapshot) -> some View {
        let projectsById = Dictionary(uniqueKeysWithValues: shell.projects.map { ($0.id, $0) })
        let filtered = filteredThreads(in: shell, projectsById: projectsById)
        let active = filtered
            .filter { !$0.settled }
            .sorted { lhs, rhs in
                if lhs.pinned != rhs.pinned { return lhs.pinned }
                return (lhs.updatedAt ?? "") > (rhs.updatedAt ?? "")
            }
        let settled = filtered
            .filter { $0.settled }
            .sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }

        List {
            // Top filter pills matching ThreadListFilters.tsx ("All environments ⌄" / "All projects ⌄")
            ThreadListFiltersBar(
                environmentLabel: store.serverURL.flatMap { URL(string: $0)?.host } ?? "Local",
                projects: shell.projects.filter { !isScratchProjectTitle($0.title) },
                selectedProjectFilter: $selectedProjectFilter
            )
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(theme.background)

            if let error = store.lastError, !error.isEmpty {
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

            if active.isEmpty && settled.isEmpty && store.linked.isEmpty {
                emptyState
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(theme.background)
            } else {
                ForEach(active, id: \.id) { thread in
                    threadRow(thread, owner: store, project: projectsById[thread.projectId], settled: false)
                }

                if !settled.isEmpty {
                    Button {
                        withAnimation(Kit.Motion.base) {
                            settledExpanded.toggle()
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text("Settled (\(settled.count))")
                                .font(.system(size: 13, weight: .medium).monospacedDigit())
                                .foregroundStyle(theme.mutedForeground)
                            Spacer()
                            ConnIcon(settledExpanded ? "chevron.down" : "chevron.right")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(theme.mutedForeground)
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 16)
                        .padding(.bottom, 8)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(theme.background)
                    .accessibilityIdentifier("inbox.settledHeader")

                    if settledExpanded {
                        ForEach(settled, id: \.id) { thread in
                            threadRow(thread, owner: store, project: projectsById[thread.projectId], settled: true)
                        }
                    }
                }
            }
            ForEach(store.linked.keys.sorted(), id: \.self) { id in
                if let owner = store.linked[id], let remote = owner.shell {
                    let projects = Dictionary(uniqueKeysWithValues: remote.projects.map { ($0.id, $0) })
                    Section(owner.serverURL.flatMap { URL(string: $0)?.host } ?? id) {
                        ForEach(filteredThreads(in: remote, projectsById: projects), id: \.id) { thread in
                            threadRow(thread, owner: owner, project: projects[thread.projectId], settled: thread.settled)
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(theme.background)
        // `HomeScreen` scroll edges: a soft top blur under the status bar, none at the bottom.
        .scrollEdgeEffectStyle(.soft, for: .top)
        .scrollEdgeEffectHidden(true, for: .bottom)
    }

    private func threadRow(_ thread: FfiThreadSummary, owner: CoreStore, project: FfiProject?, settled: Bool) -> some View {
        Button {
            onSelectThread(thread.id, owner.scope)
        } label: {
            ThreadListV2RowView(
                thread: thread,
                projectTitle: project?.title,
                settled: settled
            )
        }
        .buttonStyle(.plain)
        // 4pt between rows.
        .listRowInsets(EdgeInsets(top: 2, leading: 0, bottom: 2, trailing: 0))
        .listRowSeparator(.hidden)
        .listRowBackground(theme.background)
        .accessibilityIdentifier(settled ? "inbox.settledThread.\(thread.id)" : "inbox.thread.\(thread.id)")
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button {
                Task {
                    await owner.settleThread(threadId: thread.id, settled: !settled)
                }
            } label: {
                Label(settled ? "Un-settle" : "Settle", systemImage: settled ? "arrow.uturn.backward" : "checkmark")
            }
            .tint(settled ? .blue : .green)

            Button(role: .destructive) {
                Task {
                    await owner.deleteThread(threadId: thread.id)
                }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            Button {
                Task {
                    await owner.pinThread(threadId: thread.id, pinned: !thread.pinned)
                }
            } label: {
                Label(thread.pinned ? "Unpin" : "Pin", systemImage: thread.pinned ? "pin.slash" : "pin")
            }
            .tint(.orange)

            if !thread.unread {
                Button {
                    Task {
                        await owner.markThreadUnread(threadId: thread.id)
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
                    await owner.pinThread(threadId: thread.id, pinned: !thread.pinned)
                }
            } label: {
                Label(thread.pinned ? "Unpin" : "Pin", systemImage: thread.pinned ? "pin.slash" : "pin")
            }

            Button {
                Task {
                    await owner.settleThread(threadId: thread.id, settled: !settled)
                }
            } label: {
                Label(settled ? "Un-settle" : "Settle", systemImage: settled ? "arrow.uturn.backward" : "checkmark")
            }

            if !thread.unread {
                Button {
                    Task {
                        await owner.markThreadUnread(threadId: thread.id)
                    }
                } label: {
                    Label("Mark Unread", systemImage: "envelope.badge")
                }
            }

            Button {
                renameOwner = owner
                renameDraft = thread.title
                renamingThread = thread
            } label: {
                Label("Rename", systemImage: "pencil")
            }

            Divider()

            Button(role: .destructive) {
                Task {
                    await owner.deleteThread(threadId: thread.id)
                }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private var loadingState: some View {
        VStack(spacing: Kit.Space.m) {
            KitStatusIcon(.working, size: 22, label: "Syncing")
            Text("Syncing threads…")
                .font(.kitDetail)
                .foregroundStyle(theme.mutedForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyState: some View {
        VStack(spacing: Kit.Space.m) {
            ConnIcon("text.bubble")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(theme.mutedForeground)
            Text(searchQuery.isEmpty ? "No threads yet" : "No matching threads")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(theme.foreground)
            if searchQuery.isEmpty {
                Text("Tap + to start a new thread.")
                    .font(.system(size: 15))
                    .foregroundStyle(theme.mutedForeground)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 80)
    }

    private func filteredThreads(
        in shell: FfiShellSnapshot,
        projectsById: [String: FfiProject]
    ) -> [FfiThreadSummary] {
        var result = shell.threads
        if let projectFilter = selectedProjectFilter {
            result = result.filter { $0.projectId == projectFilter }
        }
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return result.filter { !$0.isSubagent } }
        return result.filter { thread in
            if thread.title.lowercased().contains(q) { return true }
            if let branch = thread.branch?.lowercased(), branch.contains(q) { return true }
            if let proj = projectsById[thread.projectId]?.title.lowercased(), proj.contains(q) { return true }
            return false
        }
    }
}

// MARK: - ThreadListFiltersBar (1:1 port of ThreadListFilters.tsx)

private struct ThreadListFiltersBar: View {
    let environmentLabel: String
    let projects: [FfiProject]
    @Binding var selectedProjectFilter: String?
    @Environment(\.connTheme) private var theme

    private var selectedProjectTitle: String? {
        guard let id = selectedProjectFilter else { return nil }
        return projects.first(where: { $0.id == id })?.title
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Menu {
                    Button {
                    } label: {
                        Label("All environments", systemImage: "checkmark")
                    }
                    Button {
                    } label: {
                        Text(environmentLabel)
                    }
                } label: {
                    filterPill(label: "All environments", active: false)
                }
                .accessibilityLabel("Filter threads by environment")

                Menu {
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
                } label: {
                    filterPill(label: selectedProjectTitle ?? "All projects", active: selectedProjectFilter != nil)
                }
                .accessibilityLabel("Filter threads by project")

                if selectedProjectFilter != nil {
                    Button {
                        selectedProjectFilter = nil
                    } label: {
                        ConnIcon("xmark.circle.fill")
                            .font(.system(size: 18))
                            .foregroundStyle(theme.mutedForeground)
                            .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Reset thread filters")
                }
            }
            // `ThreadListFilters`: px-12, pt-2, pb-10, gap 8.
            .padding(.horizontal, 12)
            .padding(.top, 2)
            .padding(.bottom, 10)
        }
    }

    /// `Chip.tsx`: interactive glass, radius 14, min height 28, padding 10.5×5.25, a 14pt medium
    /// muted label (max 180 wide) and an 11pt `chevron.down`; a selected chip is tinted primary.
    private func filterPill(label: String, active: Bool) -> some View {
        HStack(spacing: 5.25) {
            Text(label)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(active ? theme.primaryForeground : theme.mutedForeground)
                .lineLimit(1)
                .frame(maxWidth: 180, alignment: .leading)
                .fixedSize(horizontal: true, vertical: false)
            ConnIcon("chevron.down")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(active ? theme.primaryForeground : theme.mutedForeground)
        }
        .padding(.horizontal, 10.5)
        .padding(.vertical, 5.25)
        .frame(minHeight: 28)
        .glassEffect(
            active ? .regular.tint(theme.primary).interactive() : .regular.interactive(),
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
    }
}

// MARK: - ThreadListV2RowView (1:1 port of ThreadListV2Row)

private struct ThreadListV2RowView: View {
    let thread: FfiThreadSummary
    let projectTitle: String?
    let settled: Bool

    @Environment(\.connTheme) private var theme

    /// `thread-list-v2-row-appearance.ts`: a 20pt favicon, 12 to the title, line 2 indented 32.
    private let iconSize: CGFloat = 20
    private let titleGap: CGFloat = 12

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Line 1: project favicon with 6pt status dot on top-right + one-line title
            HStack(alignment: .center, spacing: titleGap) {
                ProjectFaviconView(title: projectTitle, size: iconSize)
                    .opacity(settled ? 0.6 : 1)
                    .overlay(alignment: .topTrailing) {
                        // `StatusBadgeDot`: a 6pt dot in a 2pt screen-colored ring, 4pt past the corner.
                        if let dotColor = statusDotColor {
                            Circle()
                                .fill(dotColor)
                                .frame(width: 6, height: 6)
                                .padding(2)
                                .background(Circle().fill(theme.background))
                                .offset(x: 4, y: -4)
                        }
                    }

                Text(thread.title.isEmpty ? "Untitled thread" : thread.title)
                    .font(.system(size: 16, weight: settled ? .regular : .medium))
                    .foregroundStyle(settled ? theme.mutedForeground : theme.foreground)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if thread.pinned {
                    ConnIcon("pin")
                        .font(.system(size: 11))
                        .foregroundStyle(theme.mutedForeground)
                }
            }

            // Line 2: indented provider/agent icon · project · branch · time
            HStack(spacing: 4) {
                Image(systemName: "sparkle")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color(red: 0.85, green: 0.47, blue: 0.34))
                Text("·")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.mutedForeground)
                Text(subtitleText)
                    .font(.system(size: 13).monospacedDigit())
                    .foregroundStyle(theme.mutedForeground)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .padding(.leading, iconSize + titleGap)

            // Line 3 (failed threads only): the provider's error, as in Expo's ThreadListV2Row
            // (`text-xs` = 13pt, same gap as line 2; a usage limit shows as a warning).
            if let failureMessage = thread.failureMessage {
                Text(failureMessage)
                    .font(.system(size: 13))
                    .foregroundStyle(thread.usageLimited ? theme.warning : theme.destructive)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, iconSize + titleGap)
                    .accessibilityIdentifier("inbox.threadFailureMessage")
            }
        }
        // Row: padding 12 top / 8 right / 12 bottom / 4 left, inset 8 from the screen edges.
        .padding(EdgeInsets(top: 12, leading: 4, bottom: 12, trailing: 8))
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
    }

    private var statusDotColor: Color? {
        if settled { return nil }
        switch thread.activity {
        case .working:
            return Color.blue
        case .needsAttention:
            return theme.warning
        case .failed:
            return theme.destructive
        case .idle:
            return theme.success
        }
    }

    private var subtitleText: String {
        var parts: [String] = []
        if let projectTitle, !projectTitle.isEmpty {
            parts.append(projectTitle)
        } else {
            parts.append("No project")
        }
        if let branch = thread.branch, !branch.isEmpty {
            parts.append(branch)
        }
        if let date = parseISODate(from: thread.updatedAt) {
            parts.append(wholeMinuteRelativeTime(from: date))
        }
        return parts.joined(separator: " · ")
    }
}

// MARK: - ProjectFaviconView (1:1 port of ProjectFavicon.tsx + projectIdentity.ts)

func isScratchProjectTitle(_ title: String?) -> Bool {
    guard let t = title?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else { return true }
    return t.isEmpty || t == "no project" || t == "general" || t == "scratch"
}

struct ProjectFaviconView: View {
    let title: String?
    let size: CGFloat
    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if isScratchProjectTitle(title) {
            ConnIcon("text.bubble")
                .font(.system(size: size * 0.85))
                .foregroundStyle(theme.mutedForeground)
                .frame(width: size, height: size)
        } else {
            let name = title ?? ""
            let monogram = deriveProjectMonogram(name)
            let accent = deriveProjectColor(name, isDark: colorScheme == .dark)
            ZStack {
                RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
                    .fill(accent.opacity(0.16))
                Text(monogram)
                    .font(.system(size: size * (monogram.count == 1 ? 0.6 : 0.51), weight: .bold, design: .monospaced))
                    .foregroundStyle(accent)
                    .lineLimit(1)
            }
            .frame(width: size, height: size)
        }
    }
}

private func deriveProjectMonogram(_ projectName: String) -> String {
    let words = projectName
        .precomposedStringWithCompatibilityMapping
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .components(separatedBy: CharacterSet.alphanumerics.inverted)
        .filter { !$0.isEmpty }
    guard let firstWord = words.first else { return "PR" }
    let chars = Array(firstWord)
    let first = chars.first ?? "P"
    let second: Character =
        chars.dropFirst().first(where: { $0.isNumber })
        ?? (words.count > 1 ? words.last?.first : chars.last)
        ?? first
    return String([first, second]).uppercased()
}

private func deriveProjectColor(_ projectName: String, isDark: Bool) -> Color {
    let darkHex: [UInt32] = [
        0x9ca3af, 0xf87171, 0xfb923c, 0xfbbf24, 0xfacc15, 0xa3e635,
        0x4ade80, 0x34d399, 0x2dd4bf, 0x22d3ee, 0x38bdf8, 0x60a5fa,
        0x818cf8, 0xa78bfa, 0xc084fc, 0xe879f9, 0xf472b6, 0xfb7185,
    ]
    let lightHex: [UInt32] = [
        0x4b5563, 0xdc2626, 0xea580c, 0xd97706, 0xca8a04, 0x65a30d,
        0x16a34a, 0x059669, 0x0d9488, 0x0891b2, 0x0284c7, 0x2563eb,
        0x4f46e5, 0x7c3aed, 0x9333ea, 0xc026d3, 0xdb2777, 0xe11d48,
    ]
    let seed = projectName.precomposedStringWithCompatibilityMapping.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    var index = 0
    for scalar in (seed.isEmpty ? "project" : seed).unicodeScalars {
        index = (index * 31 + Int(scalar.value)) % darkHex.count
    }
    let hex = isDark ? darkHex[index] : lightHex[index]
    return Color(
        .sRGB,
        red: Double((hex >> 16) & 0xFF) / 255.0,
        green: Double((hex >> 8) & 0xFF) / 255.0,
        blue: Double(hex & 0xFF) / 255.0,
        opacity: 1.0
    )
}

private func parseISODate(from raw: String?) -> Date? {
    guard let raw, !raw.isEmpty else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = fractional.date(from: raw) { return d }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: raw)
}

/// Whole-minute relative time matching Expo's thread row rule ("0m", "23m", "2h", "3d").
private func wholeMinuteRelativeTime(from date: Date) -> String {
    let seconds = max(0, Int(Date().timeIntervalSince(date)))
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h" }
    let days = hours / 24
    return "\(days)d"
}
