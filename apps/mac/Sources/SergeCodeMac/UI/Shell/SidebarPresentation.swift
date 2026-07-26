import Foundation

enum SidebarMachineScope: Equatable {
    case all
    case device(DeviceID)

    static let allStorageValue = "all"

    init(storageValue: String) {
        self = storageValue == Self.allStorageValue
            ? .all
            : .device(DeviceID(rawValue: storageValue))
    }

    var storageValue: String {
        switch self {
        case .all: Self.allStorageValue
        case .device(let id): id.rawValue
        }
    }
}

@MainActor
struct SidebarLocation: Identifiable {
    let id: DeviceID
    let name: String
    let model: AppModel
    let isLocal: Bool

    var connection: ConnectionPhase { model.connection }
    var isReady: Bool { isLocal || connection == .ready }
}

@MainActor
struct SidebarProjectMember {
    let location: SidebarLocation
    let project: Project

    var id: String { "\(location.id.rawValue)/\(project.id)" }
}

@MainActor
struct SidebarThreadItem {
    let member: SidebarProjectMember
    let thread: ChatThread
    let vcs: VcsStatus?
    let isPinned: Bool

    var id: ThreadSelection {
        ThreadSelection(deviceID: member.location.id, threadID: thread.id)
    }

    var isSelectable: Bool { member.location.isReady }

    var hasConnectionIssue: Bool {
        !member.location.isLocal
            && member.location.connection.needsAttention
            && isInProgress
    }

    var needsAttention: Bool {
        thread.status == .waitingApproval
            || thread.status == .error
            || thread.isStalled
            || hasConnectionIssue
    }

    var isInProgress: Bool {
        return switch thread.status {
        case .running, .waiting, .waitingApproval, .waitingInput, .backgroundWork,
            .reviewing, .fixing:
            true
        case .idle, .error, .archived, .settled, .done, .readyToMerge: false
        }
    }

    var belongsInRunning: Bool {
        !needsAttention && isInProgress
    }

    var attentionRank: Int {
        if thread.status == .waitingApproval { return 0 }
        if thread.status == .waitingInput { return 1 }
        if thread.status == .error { return 2 }
        if hasConnectionIssue { return 2 }
        if thread.isStalled { return 3 }
        // Ready-to-merge threads are settled but actionable; surface them above
        // idle/done threads in the attention ordering.
        if thread.status == .readyToMerge { return 3 }
        return 4
    }

    var statusLabel: String {
        if hasConnectionIssue { return member.location.connection.accessibilityLabel }
        if thread.isStalled { return "Stalled" }
        return switch thread.status {
        case .backgroundWork: "Background work"
        case .idle: "Idle"
        case .running: "Running"
        case .waiting: "Waiting"
        case .waitingApproval: "Needs approval"
        case .waitingInput: "Needs input"
        case .error: "Error"
        case .archived: "Archived"
        case .settled: "Settled"
        case .done: "Done"
        case .reviewing: "Reviewing"
        case .fixing: "Fixing"
        case .readyToMerge: "Ready to merge"
        }
    }
}

@MainActor
struct SidebarProjectGroup: Identifiable {
    let id: String
    let name: String
    let members: [SidebarProjectMember]
    let threads: [SidebarThreadItem]

    var preferredMember: SidebarProjectMember {
        members.first(where: { $0.location.isLocal }) ?? members[0]
    }

    /// Most recent thread activity across the group; groups sort by this.
    var lastActivityAt: Date? {
        threads.map(\.thread.updatedAt).max()
    }

    var activeThreadCount: Int {
        threads.filter(\.isInProgress).count
    }

    var attentionThreadCount: Int {
        threads.filter(\.needsAttention).count
    }
}

@MainActor
struct SidebarGroupThreads {
    let active: [SidebarThreadItem]
    let settled: [SidebarThreadItem]
}

@MainActor
enum SidebarProjection {
    static func locations(in multi: MultiDeviceModel) -> [SidebarLocation] {
        let local = SidebarLocation(
            id: .local,
            name: "This Mac",
            model: multi.local,
            isLocal: true)
        let remotes = multi.remoteSessions
            .sorted {
                $0.descriptor.name.localizedStandardCompare($1.descriptor.name)
                    == .orderedAscending
            }
            .map {
                SidebarLocation(
                    id: $0.id,
                    name: $0.descriptor.name,
                    model: $0.model,
                    isLocal: false)
            }
        return [local] + remotes
    }

    static func locations(
        in multi: MultiDeviceModel,
        scope: SidebarMachineScope
    ) -> [SidebarLocation] {
        let all = locations(in: multi)
        switch scope {
        case .all:
            return all
        case .device(let id):
            return all.filter { $0.id == id }
        }
    }

    static func projectGroups(
        in multi: MultiDeviceModel,
        scope: SidebarMachineScope
    ) -> [SidebarProjectGroup] {
        let locations = locations(in: multi, scope: scope)
        let members = locations.flatMap { location in
            location.model.projects.map {
                SidebarProjectMember(location: location, project: $0)
            }
        }

        let fallbackCounts = Dictionary(grouping: members) {
            "\($0.location.id.rawValue)|\(normalizedProjectName($0.project.name))"
        }.mapValues(\.count)

        let grouped = Dictionary(grouping: members) { member in
            if let repositoryKey = normalizedRepositoryKey(member.project.repositoryKey) {
                return "repository:\(repositoryKey)"
            }
            let normalizedName = normalizedProjectName(member.project.name)
            let locationNameKey = "\(member.location.id.rawValue)|\(normalizedName)"
            if fallbackCounts[locationNameKey, default: 0] > 1 {
                return "project:\(member.location.id.rawValue):\(member.project.id)"
            }
            return "name:\(normalizedName)"
        }

        return grouped.map { id, unsortedMembers in
            let sortedMembers = unsortedMembers.sorted(by: memberSort)
            let preferred = sortedMembers.first(where: { $0.location.isLocal })
                ?? sortedMembers[0]
            let perMemberThreads = sortedMembers.flatMap { member in
                let model = member.location.model
                let ordered = AppModel.pinnedFirst(
                    model.orderedThreads(for: member.project.id),
                    pinnedIDs: model.pinnedThreadIDs)
                // Delegated sub-agent threads render as inline cards in their
                // parent's timeline, never as sidebar rows.
                return ordered.filter { !isDelegatedAgentThread($0) }.map { thread in
                    SidebarThreadItem(
                        member: member,
                        thread: thread,
                        vcs: model.threadState(thread.id)?.vcsStatus,
                        isPinned: model.isThreadPinned(thread))
                }
            }
            let pinnedFirst =
                perMemberThreads.filter(\.isPinned) + perMemberThreads.filter { !$0.isPinned }
            return SidebarProjectGroup(
                id: id,
                name: preferred.project.name,
                members: sortedMembers,
                threads: pinnedFirst)
        }
        .sorted { lhs, rhs in
            let left = lhs.lastActivityAt ?? .distantPast
            let right = rhs.lastActivityAt ?? .distantPast
            if left != right { return left > right }
            return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
    }

    static func activeThreads(in groups: [SidebarProjectGroup], now: Date = Date()) -> [SidebarThreadItem] {
        let items = groups.flatMap(\.threads).filter {
            !ThreadInboxSemantics.effectiveSettled(
                $0.thread,
                now: now,
                changeRequestState: $0.vcs?.prState)
        }
        // Duplicate thread IDs can appear when the same backend is paired as
        // both the local server and a remote device; keep the first offset.
        let order = Dictionary(
            ThreadInboxSemantics.sortActive(items.map(\.thread))
                .enumerated().map { ($0.element.id, $0.offset) },
            uniquingKeysWith: { first, _ in first })
        return items.sorted { (order[$0.thread.id] ?? .max) < (order[$1.thread.id] ?? .max) }
    }

    /// Display split for one project section. `active` is ranked pinned →
    /// attention → in progress → recent; `settled` feeds the per-project
    /// "Settled" disclosure, most recently settled first.
    static func groupThreads(
        _ group: SidebarProjectGroup,
        now: Date = Date()
    ) -> SidebarGroupThreads {
        var active: [SidebarThreadItem] = []
        var settled: [SidebarThreadItem] = []
        for item in group.threads {
            if ThreadInboxSemantics.effectiveSettled(
                item.thread,
                now: now,
                changeRequestState: item.vcs?.prState)
            {
                settled.append(item)
            } else {
                active.append(item)
            }
        }

        // Same duplicate-ID hazard as `activeThreads` above.
        let settledOrder = Dictionary(
            ThreadInboxSemantics.sortSettled(settled.map(\.thread))
                .enumerated().map { ($0.element.id, $0.offset) },
            uniquingKeysWith: { first, _ in first })
        settled.sort {
            (settledOrder[$0.thread.id] ?? .max) < (settledOrder[$1.thread.id] ?? .max)
        }

        let ranked = active.enumerated().sorted { lhs, rhs in
            let leftTier = groupDisplayTier(lhs.element)
            let rightTier = groupDisplayTier(rhs.element)
            if leftTier != rightTier { return leftTier < rightTier }
            switch leftTier {
            case 0:
                // Pinned threads keep their manual (pin) order.
                return lhs.offset < rhs.offset
            case 1:
                if lhs.element.attentionRank != rhs.element.attentionRank {
                    return lhs.element.attentionRank < rhs.element.attentionRank
                }
                return lhs.element.thread.updatedAt > rhs.element.thread.updatedAt
            default:
                return lhs.element.thread.updatedAt > rhs.element.thread.updatedAt
            }
        }
        return SidebarGroupThreads(active: ranked.map(\.element), settled: settled)
    }

    /// 0 = pinned, 1 = needs attention, 2 = in progress, 3 = everything else.
    private static func groupDisplayTier(_ item: SidebarThreadItem) -> Int {
        if item.isPinned { return 0 }
        if item.needsAttention { return 1 }
        if item.belongsInRunning { return 2 }
        return 3
    }

    static func attentionThreads(in groups: [SidebarProjectGroup]) -> [SidebarThreadItem] {
        groups.flatMap(\.threads)
            .filter(\.needsAttention)
            .sorted {
                if $0.attentionRank != $1.attentionRank {
                    return $0.attentionRank < $1.attentionRank
                }
                return $0.thread.updatedAt > $1.thread.updatedAt
            }
    }

    static func runningThreads(in groups: [SidebarProjectGroup]) -> [SidebarThreadItem] {
        groups.flatMap(\.threads)
            .filter(\.belongsInRunning)
            .sorted { $0.thread.updatedAt > $1.thread.updatedAt }
    }

    static func pinnedThreads(in groups: [SidebarProjectGroup]) -> [SidebarThreadItem] {
        groups.flatMap(\.threads)
            .filter { $0.isPinned && !$0.needsAttention && !$0.belongsInRunning }
    }

    /// Delegated sub-agent threads (spawned via `delegate_task`): identified by
    /// the persisted parent link, falling back to the `Agent: ` title prefix
    /// for rows that predate the field. They render inline in the parent's
    /// timeline and are hidden from the sidebar.
    static func isDelegatedAgentThread(_ thread: ChatThread) -> Bool {
        if let parent = thread.parentThreadId, !parent.isEmpty {
            return true
        }
        return thread.title.trimmingCharacters(in: .whitespaces).hasPrefix("Agent: ")
    }

    static func searchResults(
        in groups: [SidebarProjectGroup],
        query: String
    ) -> [SidebarThreadItem] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return [] }

        return groups.flatMap { group in
            let projectMatches = group.members.contains {
                searchMatches($0.project.name, term)
            }
            return group.threads.filter { item in
                projectMatches
                    || searchMatches(item.thread.title, term)
                    || searchMatches(item.thread.provider.displayName, term)
                    || searchMatches(item.member.location.name, term)
                    || (item.vcs?.branch.map { searchMatches($0, term) } ?? false)
                    || item.vcs?.prNumber.map { searchMatches("PR #\($0)", term) } == true
            }
        }
        .sorted { $0.thread.updatedAt > $1.thread.updatedAt }
    }

    /// Search folds diacritics as well as case: threads are auto-titled after
    /// scenery locations ("Skógafoss", "Türkiye"), so a query typed on an
    /// ASCII keyboard has to reach them. Matches how project names are
    /// normalized for grouping below.
    private static func searchMatches(_ haystack: String, _ term: String) -> Bool {
        haystack.range(
            of: term, options: [.caseInsensitive, .diacriticInsensitive], locale: .current) != nil
    }

    private static func normalizedProjectName(_ name: String) -> String {
        let normalized = name.trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        return normalized.isEmpty ? "untitled" : normalized
    }

    private static func normalizedRepositoryKey(_ key: String?) -> String? {
        guard let key else { return nil }
        let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized.isEmpty ? nil : normalized
    }

    private static func memberSort(
        _ lhs: SidebarProjectMember,
        _ rhs: SidebarProjectMember
    ) -> Bool {
        if lhs.location.isLocal != rhs.location.isLocal {
            return lhs.location.isLocal
        }
        return lhs.location.name.localizedStandardCompare(rhs.location.name)
            == .orderedAscending
    }
}
