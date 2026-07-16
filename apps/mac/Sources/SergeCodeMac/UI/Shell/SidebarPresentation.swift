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
    /// Nesting depth under a visible parent (0 = top-level). Children of
    /// sub-agent parents render indented when `parentThreadId` is present.
    let nestDepth: Int

    init(
        member: SidebarProjectMember,
        thread: ChatThread,
        vcs: VcsStatus?,
        isPinned: Bool,
        nestDepth: Int = 0
    ) {
        self.member = member
        self.thread = thread
        self.vcs = vcs
        self.isPinned = isPinned
        self.nestDepth = nestDepth
    }

    var id: ThreadSelection {
        ThreadSelection(deviceID: member.location.id, threadID: thread.id)
    }

    func withNestDepth(_ depth: Int) -> SidebarThreadItem {
        SidebarThreadItem(
            member: member, thread: thread, vcs: vcs, isPinned: isPinned, nestDepth: depth)
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
        case .running, .waiting, .waitingApproval, .backgroundWork: true
        case .idle, .error, .archived: false
        }
    }

    var belongsInRunning: Bool {
        !needsAttention && isInProgress
    }

    var attentionRank: Int {
        if thread.status == .waitingApproval { return 0 }
        if thread.status == .error { return 1 }
        if hasConnectionIssue { return 2 }
        if thread.isStalled { return 3 }
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
        case .error: "Error"
        case .archived: "Archived"
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

    var activeThreadCount: Int {
        threads.filter(\.isInProgress).count
    }

    var attentionThreadCount: Int {
        threads.filter(\.needsAttention).count
    }
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
                return ordered.map { thread in
                    SidebarThreadItem(
                        member: member,
                        thread: thread,
                        vcs: model.threadState(thread.id)?.vcsStatus,
                        isPinned: model.isThreadPinned(thread))
                }
            }
            let pinned = nestSubagentThreads(perMemberThreads.filter(\.isPinned))
            let unpinned = nestSubagentThreads(perMemberThreads.filter { !$0.isPinned })
            return SidebarProjectGroup(
                id: id,
                name: preferred.project.name,
                members: sortedMembers,
                threads: pinned + unpinned)
        }
        .sorted {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
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

    /// Nest child threads under their parent when the parent is present in the
    /// same visible set (same device). Children whose parent is missing stay
    /// top-level. Sub-agents can spawn their own sub-agents, so nesting is
    /// recursive: each level renders depth-first under its parent, ordered by
    /// `updatedAt` descending. Indentation is capped so pathological depth
    /// stays readable; a visited set guards against parent-id cycles.
    static let maxNestDepth = 6

    static func nestSubagentThreads(_ items: [SidebarThreadItem]) -> [SidebarThreadItem] {
        guard !items.isEmpty else { return items }

        var byThreadID: [String: SidebarThreadItem] = [:]
        byThreadID.reserveCapacity(items.count)
        for item in items {
            byThreadID[item.thread.id] = item
        }

        var childrenByParent: [String: [SidebarThreadItem]] = [:]
        var roots: [SidebarThreadItem] = []
        roots.reserveCapacity(items.count)

        for item in items {
            guard
                let parentID = item.thread.parentThreadId,
                !parentID.isEmpty,
                let parent = byThreadID[parentID],
                parent.member.location.id == item.member.location.id
            else {
                roots.append(item)
                continue
            }
            childrenByParent[parentID, default: []].append(item)
        }

        for key in childrenByParent.keys {
            childrenByParent[key]?.sort { $0.thread.updatedAt > $1.thread.updatedAt }
        }

        var result: [SidebarThreadItem] = []
        result.reserveCapacity(items.count)
        var visited = Set<String>()

        func emit(_ item: SidebarThreadItem, depth: Int) {
            guard visited.insert(item.thread.id).inserted else { return }
            result.append(item.withNestDepth(depth))
            for child in childrenByParent[item.thread.id] ?? [] {
                emit(child, depth: min(depth + 1, maxNestDepth))
            }
        }

        for root in roots {
            emit(root, depth: 0)
        }

        // A cycle in parent ids (corrupt data) can strand items with no
        // reachable root; surface them flat rather than dropping them.
        if result.count < items.count {
            for item in items where !visited.contains(item.thread.id) {
                visited.insert(item.thread.id)
                result.append(item.withNestDepth(0))
            }
        }
        return result
    }

    static func searchResults(
        in groups: [SidebarProjectGroup],
        query: String
    ) -> [SidebarThreadItem] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return [] }

        return groups.flatMap { group in
            let projectMatches = group.members.contains {
                $0.project.name.localizedCaseInsensitiveContains(term)
            }
            return group.threads.filter { item in
                projectMatches
                    || item.thread.title.localizedCaseInsensitiveContains(term)
                    || item.thread.provider.displayName.localizedCaseInsensitiveContains(term)
                    || item.member.location.name.localizedCaseInsensitiveContains(term)
                    || (item.vcs?.branch?.localizedCaseInsensitiveContains(term) ?? false)
                    || item.vcs?.prNumber.map { "PR #\($0)".localizedCaseInsensitiveContains(term) }
                        == true
            }
        }
        .sorted { $0.thread.updatedAt > $1.thread.updatedAt }
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
