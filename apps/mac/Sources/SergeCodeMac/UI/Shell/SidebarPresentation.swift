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
            let pinned = perMemberThreads.filter(\.isPinned)
            let unpinned = perMemberThreads.filter { !$0.isPinned }
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
