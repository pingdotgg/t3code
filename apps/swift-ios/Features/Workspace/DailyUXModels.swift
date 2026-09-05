import Foundation

public struct FeatureDraftAttachment: Identifiable, Sendable, Equatable {
    public let id: UUID
    private var inlineData: Data?
    public var ownedFile: FeatureOwnedAttachmentFile?
    public var thumbnailData: Data?
    public var filename: String
    public var mimeType: String
    public var uploadedReference: FeatureUploadedAttachmentReference?

    public init(
        id: UUID = UUID(),
        data: Data,
        thumbnailData: Data? = nil,
        filename: String,
        mimeType: String,
        uploadedReference: FeatureUploadedAttachmentReference? = nil
    ) {
        self.id = id
        inlineData = data
        ownedFile = nil
        self.thumbnailData = thumbnailData
        self.filename = filename
        self.mimeType = mimeType
        self.uploadedReference = uploadedReference
    }

    public init(
        id: UUID = UUID(),
        ownedFile: FeatureOwnedAttachmentFile,
        thumbnailData: Data? = nil,
        filename: String,
        mimeType: String,
        uploadedReference: FeatureUploadedAttachmentReference? = nil
    ) {
        self.id = id
        inlineData = nil
        self.ownedFile = ownedFile
        self.thumbnailData = thumbnailData
        self.filename = filename
        self.mimeType = mimeType
        self.uploadedReference = uploadedReference
    }

    /// Kept for image-only callers. File-backed attachments return empty data
    /// instead of loading up to 50 MB into a UI property.
    public var data: Data {
        get { inlineData ?? Data() }
        set {
            inlineData = newValue
            ownedFile = nil
        }
    }

    public var byteCount: Int {
        inlineData?.count ?? ownedFile?.byteCount ?? 0
    }
}

public struct NewTaskRequest: Sendable, Equatable {
    public var projectID: String
    public var prompt: String
    public var selection: FeatureSelection?
    public var runtimeMode: FeatureRuntimeMode
    public var interactionMode: FeatureInteractionMode
    public var workspaceMode: FeatureWorkspaceMode
    public var branch: String?
    public var worktreePath: String?
    public var startFromOrigin: Bool
    public var attachments: [FeatureDraftAttachment]

    public init(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode = .fullAccess,
        interactionMode: FeatureInteractionMode = .standard,
        workspaceMode: FeatureWorkspaceMode = .local,
        branch: String? = nil,
        worktreePath: String? = nil,
        startFromOrigin: Bool = true,
        attachments: [FeatureDraftAttachment] = []
    ) {
        self.projectID = projectID
        self.prompt = prompt
        self.selection = selection
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode.mobileNormalized
        self.workspaceMode = workspaceMode
        self.branch = Self.nonEmpty(branch)
        self.worktreePath = workspaceMode == .local ? Self.nonEmpty(worktreePath) : nil
        self.startFromOrigin = workspaceMode == .worktree && startFromOrigin
        self.attachments = attachments
    }

    public var trimmedPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}

public struct FeatureMessageSubmission: Sendable, Equatable {
    public var threadID: String
    public var text: String
    public var selection: FeatureSelection?
    public var attachments: [FeatureDraftAttachment]

    public init(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureDraftAttachment] = []
    ) {
        self.threadID = threadID
        self.text = text
        self.selection = selection
        self.attachments = attachments
    }
}

struct DailyUXSnoozePreset: Identifiable, Equatable {
    enum ID: String {
        case hour
        case threeHours
        case evening
        case tomorrow
        case nextWeek
    }

    let id: ID
    let label: String
    let until: Date
}

enum DailyUXSnoozePresets {
    static func resolve(now: Date, calendar: Calendar = .current) -> [DailyUXSnoozePreset] {
        var result = [
            DailyUXSnoozePreset(
                id: .hour,
                label: "In 1 hour",
                until: now.addingTimeInterval(60 * 60)
            ),
            DailyUXSnoozePreset(
                id: .threeHours,
                label: "In 3 hours",
                until: now.addingTimeInterval(3 * 60 * 60)
            ),
        ]

        if let evening = calendar.date(bySettingHour: 18, minute: 0, second: 0, of: now),
           evening.timeIntervalSince(now) > 60 * 60 {
            result.append(.init(id: .evening, label: "This evening", until: evening))
        }

        let tomorrow = calendar.date(
            bySettingHour: 9,
            minute: 0,
            second: 0,
            of: calendar.date(byAdding: .day, value: 1, to: now) ?? now
        )
        if let tomorrow {
            result.append(.init(id: .tomorrow, label: "Tomorrow", until: tomorrow))
        }

        let weekday = calendar.component(.weekday, from: now)
        let daysUntilMonday = (2 - weekday + 7) % 7
        let nextMondayOffset = daysUntilMonday == 0 ? 7 : daysUntilMonday
        if let monday = calendar.date(byAdding: .day, value: nextMondayOffset, to: now),
           let nextWeek = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: monday),
           nextWeek != tomorrow {
            result.append(.init(id: .nextWeek, label: "Next week", until: nextWeek))
        }

        return result
    }
}

enum DailyUXCreationContext {
    static func projects(in snapshot: FeatureSnapshot) -> [FeatureProject] {
        guard !snapshot.environments.isEmpty else { return snapshot.projects }
        let availableEnvironmentIDs = Set(
            snapshot.environments.filter(\.isEnabled).map(\.id)
        )
        return snapshot.projects.filter {
            availableEnvironmentIDs.contains($0.environmentID)
        }
    }

    static func projectGroups(in snapshot: FeatureSnapshot) -> [DailyUXProjectGroup] {
        return DailyUXProjectGrouping.groups(
            projects: projects(in: snapshot),
            preferencesByEnvironment: snapshot.preferencesByEnvironment ?? [:]
        )
    }

    static func recentProjects(in snapshot: FeatureSnapshot) -> [DailyUXRecentProject] {
        let groups = projectGroups(in: snapshot)
        let availableProjectByID = projects(in: snapshot).reduce(
            into: [String: FeatureProject]()
        ) { $0[$1.id] = $1 }
        let groupByProjectID = groups.reduce(into: [String: DailyUXProjectGroup]()) {
            result, group in
            for projectID in group.memberProjectIDs {
                result[projectID] = group
            }
        }
        var seenGroupIDs = Set<String>()

        return snapshot.threads
            .sorted(by: recentUseOrder)
            .compactMap { thread in
                guard let group = groupByProjectID[thread.projectID],
                      let sourceProject = availableProjectByID[thread.projectID],
                      let project = DailyUXProjectGrouping.physicalRepresentative(
                          for: sourceProject,
                          in: group
                      ),
                      seenGroupIDs.insert(group.id).inserted else {
                    return nil
                }
                return DailyUXRecentProject(group: group, project: project)
            }
    }

    static func initialProject(
        in snapshot: FeatureSnapshot,
        requestedProjectID: String?
    ) -> FeatureProject? {
        let availableProjects = projects(in: snapshot)
        if let requestedProjectID,
           let requestedProject = availableProjects.first(where: { $0.id == requestedProjectID }),
           let group = DailyUXProjectGrouping.group(
               containing: requestedProjectID,
               in: projectGroups(in: snapshot)
           ),
           let representative = DailyUXProjectGrouping.physicalRepresentative(
               for: requestedProject,
               in: group
           ) {
            return representative
        }

        return recentProjects(in: snapshot).first?.project
            ?? projectGroups(in: snapshot).first?.projects.first
    }

    static func logicalProjectID(
        for project: FeatureProject,
        in snapshot: FeatureSnapshot
    ) -> String {
        let groups = DailyUXProjectGrouping.groups(
            projects: snapshot.projects,
            preferencesByEnvironment: snapshot.preferencesByEnvironment ?? [:]
        )
        return DailyUXProjectGrouping.group(containing: project.id, in: groups)?.id
            ?? DailyUXProjectGrouping.logicalProjectID(
                for: project,
                mode: snapshot.preferencesByEnvironment?[project.environmentID]?
                    .projectGroupingMode ?? .repository,
                overrides: snapshot.preferencesByEnvironment?[project.environmentID]?
                    .projectGroupingOverrides ?? [:]
            )
    }

    private static func recentUseOrder(_ lhs: FeatureThread, _ rhs: FeatureThread) -> Bool {
        let lhsDate = lhs.lastActivityAt ?? lhs.updatedAt
        let rhsDate = rhs.lastActivityAt ?? rhs.updatedAt
        if lhsDate != rhsDate { return lhsDate > rhsDate }
        return lhs.id < rhs.id
    }

    static func shouldAdoptAutomaticProject(
        currentProjectID: String,
        nextRecentProjectID: String?,
        isAwaitingRecentActivity: Bool,
        projectSelectionIsExplicit: Bool,
        modelSelectionIsExplicit: Bool,
        workspaceSelectionIsExplicit: Bool,
        hasDraftContent: Bool,
        draftRestoreIsComplete: Bool
    ) -> Bool {
        guard isAwaitingRecentActivity,
              let nextRecentProjectID,
              nextRecentProjectID != currentProjectID else {
            return false
        }
        return !projectSelectionIsExplicit
            && !modelSelectionIsExplicit
            && !workspaceSelectionIsExplicit
            && !hasDraftContent
            && draftRestoreIsComplete
    }

    static func providers(
        for project: FeatureProject?,
        in snapshot: FeatureSnapshot
    ) -> [FeatureProvider] {
        if let project,
           let providers = snapshot.providersByEnvironment?[project.environmentID] {
            return providers
        }
        guard let project else { return [] }
        guard let selection = project.defaultSelection else { return [] }
        return [
            FeatureProvider(
                id: selection.providerID,
                name: selection.providerID,
                driver: selection.providerID,
                models: [
                    FeatureModel(
                        id: selection.modelID,
                        name: selection.modelID,
                        isDefault: true
                    ),
                ]
            ),
        ]
    }

    static func initialSelection(
        for project: FeatureProject?,
        in snapshot: FeatureSnapshot
    ) -> FeatureSelection? {
        let providers = providers(for: project, in: snapshot)
        return DailyUXModelOptions.validated(project?.defaultSelection, in: providers)
            ?? DailyUXModelOptions.preferredSelection(in: providers)
    }

    static func selection(
        carrying preferredSelection: FeatureSelection?,
        to project: FeatureProject?,
        in snapshot: FeatureSnapshot
    ) -> FeatureSelection? {
        let providers = providers(for: project, in: snapshot)
        return DailyUXModelOptions.validated(preferredSelection, in: providers)
            ?? initialSelection(for: project, in: snapshot)
    }

    static func environmentPreferences(
        for project: FeatureProject?,
        in snapshot: FeatureSnapshot
    ) -> FeatureEnvironmentPreferences {
        guard let environmentID = project?.environmentID else {
            return FeatureEnvironmentPreferences()
        }
        return snapshot.preferencesByEnvironment?[environmentID]
            ?? FeatureEnvironmentPreferences()
    }
}

struct DailyUXRecentProject: Equatable {
    let group: DailyUXProjectGroup
    let project: FeatureProject
}

/// The project picker leads with the projects the account actually worked in
/// most recently and keeps every remaining project below in the usual
/// alphabetical order. A group appears in exactly one section so the list never
/// repeats itself on the small project counts this picker normally shows.
struct DailyUXProjectPickerSections: Equatable {
    static let recentLimit = 3

    let recents: [DailyUXProjectGroup]
    let others: [DailyUXProjectGroup]

    init(
        groups: [DailyUXProjectGroup],
        recentGroupIDs: [String],
        limit: Int = DailyUXProjectPickerSections.recentLimit
    ) {
        let groupsByID = groups.reduce(into: [String: DailyUXProjectGroup]()) {
            $0[$1.id] = $0[$1.id] ?? $1
        }
        var seenGroupIDs = Set<String>()
        var ranked: [DailyUXProjectGroup] = []
        for groupID in recentGroupIDs where ranked.count < max(0, limit) {
            guard let group = groupsByID[groupID],
                  seenGroupIDs.insert(group.id).inserted else {
                continue
            }
            ranked.append(group)
        }

        recents = ranked
        others = groups.filter { !seenGroupIDs.contains($0.id) }
    }
}

struct DailyUXProjectGroup: Identifiable, Equatable {
    let id: String
    let name: String
    let projects: [FeatureProject]
    let memberProjectIDs: Set<String>

    func project(in environmentID: String) -> FeatureProject? {
        projects.first { $0.environmentID == environmentID }
    }

    func preferredProject(environmentID: String?) -> FeatureProject? {
        environmentID.flatMap(project(in:)) ?? projects.first
    }
}

enum DailyUXProjectGrouping {
    static func logicalProjectID(
        for project: FeatureProject,
        mode: FeatureEnvironmentPreferences.ProjectGroupingMode = .repository,
        overrides: [String: FeatureEnvironmentPreferences.ProjectGroupingMode] = [:]
    ) -> String {
        logicalKey(project, mode: resolvedMode(project, mode: mode, overrides: overrides))
    }

    static func groups(
        projects: [FeatureProject],
        mode: FeatureEnvironmentPreferences.ProjectGroupingMode = .repository,
        overrides: [String: FeatureEnvironmentPreferences.ProjectGroupingMode] = [:],
        preferencesByEnvironment: [String: FeatureEnvironmentPreferences] = [:]
    ) -> [DailyUXProjectGroup] {
        var projectsByLogicalKey: [String: [FeatureProject]] = [:]
        var memberIDsByLogicalKey: [String: Set<String>] = [:]
        for physicalProjects in Dictionary(grouping: projects, by: physicalKey).values {
            guard let winner = physicalWinner(physicalProjects) else { continue }
            let identitySource = identitySource(projects: physicalProjects, winner: winner)
            let preferences = preferencesByEnvironment[winner.environmentID]
            let groupingMode = resolvedMode(
                winner,
                mode: preferences?.projectGroupingMode ?? mode,
                overrides: preferences?.projectGroupingOverrides ?? overrides
            )
            let key = logicalKey(identitySource, mode: groupingMode)
            projectsByLogicalKey[key, default: []].append(winner)
            memberIDsByLogicalKey[key, default: []].formUnion(physicalProjects.map(\.id))
        }

        return projectsByLogicalKey
            .map { key, members in
                let sorted = members.sorted(by: projectOrder)
                return DailyUXProjectGroup(
                    id: key,
                    name: groupName(projects: sorted),
                    projects: sorted,
                    memberProjectIDs: memberIDsByLogicalKey[key] ?? []
                )
            }
            .sorted { lhs, rhs in
                let comparison = lhs.name.localizedCaseInsensitiveCompare(rhs.name)
                return comparison == .orderedSame ? lhs.id < rhs.id : comparison == .orderedAscending
            }
    }

    static func group(containing projectID: String, in groups: [DailyUXProjectGroup])
        -> DailyUXProjectGroup?
    {
        groups.first { $0.memberProjectIDs.contains(projectID) }
    }

    static func selectionTarget(
        groupID: String,
        preferredEnvironmentID: String?,
        in groups: [DailyUXProjectGroup]
    ) -> FeatureProject? {
        groups.first { $0.id == groupID }?
            .preferredProject(environmentID: preferredEnvironmentID)
    }

    static func physicalRepresentative(
        for project: FeatureProject,
        in group: DailyUXProjectGroup
    ) -> FeatureProject? {
        let path = normalizedPath(project.path)
        return group.projects.first {
            $0.environmentID == project.environmentID
                && normalizedPath($0.path) == path
        }
    }

    private static func physicalKey(_ project: FeatureProject) -> String {
        "\(project.environmentID):\(normalizedPath(project.path))"
    }

    private static func logicalKey(
        _ project: FeatureProject,
        mode: FeatureEnvironmentPreferences.ProjectGroupingMode
    ) -> String {
        if mode == .separate { return physicalKey(project) }
        guard let key = project.repositoryIdentity?.canonicalKey.trimmingCharacters(
            in: .whitespacesAndNewlines
        ), !key.isEmpty else {
            return physicalKey(project)
        }
        if mode == .repositoryPath,
           let relativePath = repositoryRelativePath(project),
           !relativePath.isEmpty {
            return "\(key)::\(relativePath)"
        }
        return key
    }

    private static func resolvedMode(
        _ project: FeatureProject,
        mode: FeatureEnvironmentPreferences.ProjectGroupingMode,
        overrides: [String: FeatureEnvironmentPreferences.ProjectGroupingMode]
    ) -> FeatureEnvironmentPreferences.ProjectGroupingMode {
        overrides[physicalKey(project)] ?? mode
    }

    private static func repositoryRelativePath(_ project: FeatureProject) -> String? {
        guard let rootPath = project.repositoryIdentity?.rootPath else { return nil }
        let projectPath = normalizedPath(project.path)
        let repositoryPath = normalizedPath(rootPath)
        guard !projectPath.isEmpty, !repositoryPath.isEmpty else { return nil }
        if projectPath == repositoryPath { return "" }
        let separator = repositoryPath.contains("\\") ? "\\" : "/"
        let prefix = repositoryPath + separator
        guard projectPath.hasPrefix(prefix) else { return nil }
        return String(projectPath.dropFirst(prefix.count)).replacingOccurrences(of: "\\", with: "/")
    }

    private static func physicalWinner(_ projects: [FeatureProject]) -> FeatureProject? {
        projects.max { lhs, rhs in
            let lhsFreshness = freshness(lhs)
            let rhsFreshness = freshness(rhs)
            if lhsFreshness != rhsFreshness { return lhsFreshness < rhsFreshness }
            return lhs.id < rhs.id
        }
    }

    private static func identitySource(
        projects: [FeatureProject],
        winner: FeatureProject
    ) -> FeatureProject {
        guard winner.repositoryIdentity == nil else { return winner }
        return physicalWinner(projects.filter { $0.repositoryIdentity != nil }) ?? winner
    }

    private static func freshness(_ project: FeatureProject) -> String {
        project.updatedAt ?? project.createdAt ?? ""
    }

    private static func groupName(projects: [FeatureProject]) -> String {
        let displayNames = uniqueNonEmpty(projects.compactMap(\.repositoryIdentity?.displayName))
        if displayNames.count == 1, let name = displayNames.first { return name }
        let repositoryNames = uniqueNonEmpty(projects.compactMap(\.repositoryIdentity?.name))
        if repositoryNames.count == 1, let name = repositoryNames.first { return name }
        return projects.first?.name ?? "Project"
    }

    private static func uniqueNonEmpty(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.compactMap { value in
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, seen.insert(trimmed).inserted else { return nil }
            return trimmed
        }
    }

    private static func normalizedPath(_ path: String) -> String {
        var normalized = path.trimmingCharacters(in: .whitespacesAndNewlines)
        let isWindowsPath = normalized.range(
            of: #"^[a-zA-Z]:([/\\]|$)"#,
            options: .regularExpression
        ) != nil || normalized.hasPrefix("\\\\")
        let separators = isWindowsPath
            ? CharacterSet(charactersIn: "/\\")
            : CharacterSet(charactersIn: "/")
        while normalized.count > 1,
              let scalar = normalized.unicodeScalars.last,
              separators.contains(scalar) {
            normalized.removeLast()
        }
        if isWindowsPath {
            return normalized.replacingOccurrences(of: "/", with: "\\").lowercased()
        }
        return normalized
    }

    private static func projectOrder(_ lhs: FeatureProject, _ rhs: FeatureProject) -> Bool {
        if lhs.environmentID != rhs.environmentID { return lhs.environmentID < rhs.environmentID }
        return lhs.id < rhs.id
    }
}

struct DailyUXSidebarIndex {
    let pinned: [FeatureThread]
    let active: [FeatureThread]
    let snoozed: [FeatureThread]
    let settled: [FeatureThread]
    let searchResults: [FeatureThread]

    var needsInput: [FeatureThread] {
        active.filter {
            $0.state == .waitingForApproval || $0.state == .waitingForInput
        }
    }

    var failed: [FeatureThread] {
        active.filter { $0.state == .failed }
    }

    init(
        snapshot: FeatureSnapshot,
        query: String,
        projectID: String? = nil,
        now: Date = .now,
        pullRequestsByThreadID: [String: HomeThreadPullRequestPresentation] = [:]
    ) {
        let visible = snapshot.threads.filter { thread in
            guard !thread.isArchived else { return false }
            return projectID == nil || thread.projectID == projectID
        }
        let available = visible.filter { !$0.isEffectivelySnoozed(at: now) }

        pinned = available
            .filter {
                $0.pinnedAt != nil
                    && !($0.supportsSettlement == true && $0.isEffectivelySettled())
            }
            .sorted(by: Self.creationOrder)

        active = available
            .filter {
                $0.pinnedAt == nil
                    && !($0.supportsSettlement == true && $0.isEffectivelySettled())
            }
            .sorted { lhs, rhs in
                let leftAnchor = max(lhs.createdAt, lhs.unsettledAt ?? lhs.createdAt)
                let rightAnchor = max(rhs.createdAt, rhs.unsettledAt ?? rhs.createdAt)
                return leftAnchor == rightAnchor ? lhs.id < rhs.id : leftAnchor > rightAnchor
            }

        snoozed = visible
            .filter { $0.isEffectivelySnoozed(at: now) }
            .sorted { lhs, rhs in
                let lhsUntil = lhs.snoozedUntil ?? .distantFuture
                let rhsUntil = rhs.snoozedUntil ?? .distantFuture
                if lhsUntil != rhsUntil {
                    return lhsUntil < rhsUntil
                }
                return lhs.id < rhs.id
            }

        settled = available
            .filter {
                $0.supportsSettlement == true
                    && $0.isEffectivelySettled()
            }
            .sorted { lhs, rhs in
                if lhs.settledSortDate != rhs.settledSortDate {
                    return lhs.settledSortDate > rhs.settledSortDate
                }
                return lhs.id < rhs.id
            }

        searchResults = Self.matchingThreads(
            pinned + active + snoozed + settled,
            snapshot: snapshot,
            query: query
        )
    }

    private static func creationOrder(_ lhs: FeatureThread, _ rhs: FeatureThread) -> Bool {
        if lhs.createdAt != rhs.createdAt {
            return lhs.createdAt > rhs.createdAt
        }
        return lhs.id < rhs.id
    }

    static func matchingThreads(
        _ candidates: [FeatureThread],
        snapshot: FeatureSnapshot,
        query: String
    ) -> [FeatureThread] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedQuery.isEmpty else { return [] }
        // Aggregate snapshots can include legacy fixtures with duplicate raw IDs.
        // Native projects are environment-scoped, while this defensive reduce
        // keeps search non-crashing for older callers during migration.
        let projectByID = snapshot.projects.reduce(into: [String: FeatureProject]()) {
            $0[$1.id] = $1
        }
        return candidates.filter { thread in
            let project = projectByID[thread.projectID]
            return [
                thread.title,
                thread.preview ?? "",
                project?.name ?? "",
                project?.path ?? "",
            ].contains { $0.localizedCaseInsensitiveContains(normalizedQuery) }
        }
    }
}

/// The Home list only needs a parent-level refresh when a thread crosses a shelf boundary.
/// Working timers and relative ages are rendered by each visible row instead.
enum DailyUXSidebarRefresh {
    static func nextBoundary(
        for threads: [FeatureThread],
        after now: Date,
        settings _: FeatureSettings = .init(),
        pullRequestsByThreadID _: [String: HomeThreadPullRequestPresentation] = [:]
    ) -> Date? {
        threads.reduce(nil as Date?) { earliest, thread in
            let snoozeBoundary = thread.isEffectivelySnoozed(at: now)
                ? thread.snoozedUntil
                : nil
            let queuedBoundary = thread.isArchived
                ? nil
                : thread.queuedSettlementBoundary(after: now)
            let threadBoundary = [snoozeBoundary, queuedBoundary]
                .compactMap { $0 }
                .min()

            guard let threadBoundary else { return earliest }
            return min(earliest ?? threadBoundary, threadBoundary)
        }
    }
}

enum SidebarRelativeAge {
    static func compact(since date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        switch seconds {
        case ..<60:
            return "now"
        case ..<3_600:
            return "\(seconds / 60)m"
        case ..<86_400:
            return "\(seconds / 3_600)h"
        case ..<604_800:
            return "\(seconds / 86_400)d"
        case ..<31_536_000:
            return "\(seconds / 604_800)w"
        default:
            return "\(seconds / 31_536_000)y"
        }
    }

    static func accessibility(since date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        switch seconds {
        case ..<60:
            return "Updated just now"
        case ..<3_600:
            return "Updated \(unit(seconds / 60, singular: "minute")) ago"
        case ..<86_400:
            return "Updated \(unit(seconds / 3_600, singular: "hour")) ago"
        case ..<604_800:
            return "Updated \(unit(seconds / 86_400, singular: "day")) ago"
        case ..<31_536_000:
            return "Updated \(unit(seconds / 604_800, singular: "week")) ago"
        default:
            return "Updated \(unit(seconds / 31_536_000, singular: "year")) ago"
        }
    }

    private static func unit(_ value: Int, singular: String) -> String {
        "\(value) \(singular)\(value == 1 ? "" : "s")"
    }
}

enum HomeThreadStatus: String, Sendable, Equatable {
    case approval
    case input
    case working
    case monitoring
    case failed
    case done
    case ready
}

enum HomeWorkingDuration {
    static func compact(since date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        guard seconds >= 60 else { return "\(seconds)s" }
        let minutes = seconds / 60
        guard minutes >= 60 else { return "\(minutes)m" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }

    static func accessibility(since date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        guard seconds >= 60 else { return unit(seconds, singular: "second") }
        let minutes = seconds / 60
        guard minutes >= 60 else { return unit(minutes, singular: "minute") }

        let hours = minutes / 60
        let remainingMinutes = minutes % 60
        guard remainingMinutes > 0 else { return unit(hours, singular: "hour") }
        return "\(unit(hours, singular: "hour")), \(unit(remainingMinutes, singular: "minute"))"
    }

    private static func unit(_ value: Int, singular: String) -> String {
        "\(value) \(singular)\(value == 1 ? "" : "s")"
    }
}

extension FeatureThread {
    var homeStatus: HomeThreadStatus {
        switch state {
        case .queued, .working:
            .working
        case .monitoring:
            .monitoring
        case .waitingForApproval:
            .approval
        case .waitingForInput:
            .input
        case .failed:
            .failed
        case .completed:
            .done
        case .idle:
            .ready
        }
    }

    var homeStatusLabel: String? {
        switch homeStatus {
        case .approval: "Approval"
        case .input: "Input"
        case .working: "Working"
        case .monitoring: "Monitoring"
        case .failed: "Failed"
        case .done: "Done"
        case .ready: nil
        }
    }

    var detailHeaderStatusLabel: String? {
        switch homeStatus {
        case .done:
            nil
        case .ready:
            "Ready"
        case .approval, .input, .working, .monitoring, .failed:
            homeStatusLabel
        }
    }

    var detailHeaderStatusIcon: String? {
        switch homeStatus {
        case .working:
            "circle.dotted"
        case .failed:
            "exclamationmark.circle"
        case .done, .approval, .input, .monitoring, .ready:
            nil
        }
    }

    func homeRowStatusLabel(at now: Date) -> String {
        switch homeStatus {
        case .done, .ready:
            SidebarRelativeAge.compact(since: updatedAt, now: now)
        case .approval, .input, .working, .monitoring, .failed:
            homeStatusLabel ?? SidebarRelativeAge.compact(since: updatedAt, now: now)
        }
    }

    func homeWorkingDuration(at now: Date) -> String? {
        guard homeStatus == .working, let workingStartedAt else { return nil }
        return HomeWorkingDuration.compact(since: workingStartedAt, now: now)
    }

    var hasLiveWorkingDuration: Bool {
        homeStatus == .working && workingStartedAt != nil
    }

    func homeStatusAccessibilityLabel(at now: Date) -> String {
        guard homeStatus == .working else {
            return homeStatusLabel ?? "Ready"
        }
        guard let workingStartedAt else {
            return "Agent is working"
        }
        return "Agent is working for \(HomeWorkingDuration.accessibility(since: workingStartedAt, now: now))"
    }

    func homeEnvironmentLabel(in snapshot: FeatureSnapshot) -> String? {
        let projectEnvironmentID = snapshot.projects
            .first(where: { $0.id == projectID })?
            .environmentID
        if let resolvedID = environmentID ?? projectEnvironmentID,
           let currentName = snapshot.environments.first(where: { $0.id == resolvedID })?.name,
           !currentName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return currentName
        }
        guard let environmentName = environmentName?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !environmentName.isEmpty else {
            return nil
        }
        return environmentName
    }

    func homeProviderLabel(in snapshot: FeatureSnapshot) -> String? {
        if let providerName = providerName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !providerName.isEmpty {
            return providerName
        }
        guard let providerID else { return nil }
        let projectEnvironmentID = snapshot.projects
            .first(where: { $0.id == projectID })?
            .environmentID
        let resolvedEnvironmentID = environmentID ?? projectEnvironmentID
        let providers = resolvedEnvironmentID.flatMap {
            snapshot.providersByEnvironment?[$0]
        } ?? []
        return providers.first(where: { $0.id == providerID })?.name ?? providerID
    }

    var needsAttention: Bool {
        state == .waitingForApproval || state == .waitingForInput || state == .failed
    }

    func isEffectivelySettled() -> Bool {
        effectiveSettlementOverride == .settled
    }

    func canSettleNow(at now: Date = .now) -> Bool {
        guard canToggleSettlement else { return false }
        return !hasSettlementActivityBlock(at: now)
    }

    var effectiveSettlementOverride: FeatureThreadSettlementOverride? {
        if let settlementFacts { return settlementFacts.settlementOverride }
        if keepsActive { return .active }
        if isSettled { return .settled }
        return nil
    }

    func hasSettlementActivityBlock(at now: Date) -> Bool {
        guard settlementFacts != nil else {
            return [.queued, .working, .monitoring, .waitingForApproval, .waitingForInput]
                .contains(state)
        }
        if hasHardSettlementActivityBlock { return true }
        return hasQueuedTurnStart(at: now)
    }

    var hasHardSettlementActivityBlock: Bool {
        guard let facts = settlementFacts else {
            return [
                .queued,
                .working,
                .monitoring,
                .waitingForApproval,
                .waitingForInput,
            ].contains(state)
        }
        return facts.hasPendingApprovals
            || facts.hasPendingUserInput
            || facts.sessionStatus == "starting"
            || facts.sessionStatus == "running"
    }

    func hasQueuedTurnStart(at now: Date) -> Bool {
        guard let facts = settlementFacts,
              facts.sessionStatus != "error",
              let messageAt = facts.latestUserMessageAt,
              abs(now.timeIntervalSince(messageAt)) <= 2 * 60 else {
            return false
        }
        guard let turn = facts.latestTurn else { return true }
        if turn.requestedAtIsInvalid || turn.startedAtIsInvalid || turn.completedAtIsInvalid {
            return false
        }
        return [turn.requestedAt, turn.startedAt, turn.completedAt].allSatisfy {
            $0 == nil || $0! < messageAt
        }
    }

    func queuedSettlementBoundary(after now: Date) -> Date? {
        guard hasQueuedTurnStart(at: now),
              let messageAt = settlementFacts?.latestUserMessageAt else {
            return nil
        }
        let boundary = messageAt.addingTimeInterval(2 * 60 + 0.001)
        return boundary > now ? boundary : nil
    }

    func isEffectivelySnoozed(at now: Date) -> Bool {
        guard let snoozedUntil, snoozedUntil > now else { return false }
        if state == .waitingForApproval || state == .waitingForInput {
            return false
        }
        if state == .failed,
           let snoozedAt,
           let attentionAt,
           attentionAt > snoozedAt {
            return false
        }
        if let snoozedAt,
           let latestTurnCompletedAt,
           latestTurnCompletedAt > snoozedAt {
            return false
        }
        return true
    }

    var settledSortDate: Date {
        settledAt ?? lastActivityAt ?? updatedAt
    }
}

struct DailyUXModelOption: Identifiable, Equatable, Hashable {
    let provider: FeatureProvider
    let model: FeatureModel

    var id: String { Self.key(providerID: provider.id, modelID: model.id) }

    static func key(providerID: String, modelID: String) -> String {
        "\(providerID)::\(modelID)"
    }
}

struct DailyUXModelCatalog {
    let all: [DailyUXModelOption]
    let favorites: [DailyUXModelOption]
    let recents: [DailyUXModelOption]
    let providerGroups: [(provider: FeatureProvider, models: [DailyUXModelOption])]

    init(
        providers: [FeatureProvider],
        query: String,
        favoriteIDs: Set<String>,
        recentIDs: [String]
    ) {
        let available = providers.filter(\.isAvailable)
        let rawOptions = available.flatMap { provider in
            provider.models.map { DailyUXModelOption(provider: provider, model: $0) }
        }
        var seenOptionIDs = Set<String>()
        let unfiltered = rawOptions.filter { seenOptionIDs.insert($0.id).inserted }
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let matches = normalizedQuery.isEmpty
            ? unfiltered
            : unfiltered.filter { option in
                [
                    option.provider.name,
                    option.model.name,
                    option.model.id,
                    option.model.detail ?? "",
                    option.model.supportsImages ? "images vision" : "",
                ].contains { $0.localizedCaseInsensitiveContains(normalizedQuery) }
            }

        all = matches
        favorites = matches.filter { favoriteIDs.contains($0.id) }

        // Provider catalogs can repeat an ID (see matchingThreads above); keep
        // the first occurrence instead of trapping on duplicate keys.
        let byID = matches.reduce(into: [String: DailyUXModelOption]()) {
            $0[$1.id] = $0[$1.id] ?? $1
        }
        recents = recentIDs.compactMap { byID[$0] }.filter { !favoriteIDs.contains($0.id) }

        var seenProviderIDs = Set<String>()
        let uniqueProviders = available.filter { seenProviderIDs.insert($0.id).inserted }
        providerGroups = uniqueProviders.compactMap { provider in
            let options = matches.filter { $0.provider.id == provider.id }
            return options.isEmpty ? nil : (provider, options)
        }
    }
}

enum DailyUXModelOptions {
    static func reasoningDescriptor(
        for model: FeatureModel
    ) -> FeatureModelOptionDescriptor? {
        model.options.first(where: isReasoningDescriptor)
    }

    static func advancedDescriptors(
        for model: FeatureModel
    ) -> [FeatureModelOptionDescriptor] {
        let primaryID = reasoningDescriptor(for: model)?.id
        return model.options.filter { $0.id != primaryID }
    }

    static func undescribedSelections(
        for model: FeatureModel,
        selections: [FeatureModelOptionSelection]
    ) -> [FeatureModelOptionSelection] {
        let describedIDs = Set(model.options.map(\.id))
        return selections.filter { !describedIDs.contains($0.id) }
    }

    static func isSupportedValue(
        _ value: FeatureModelOptionValue,
        for descriptor: FeatureModelOptionDescriptor
    ) -> Bool {
        switch (descriptor.kind, value) {
        case let (.select, .string(choiceID)):
            return descriptor.choices.contains { $0.id == choiceID }
        case (.boolean, .boolean):
            return true
        case (.select, .boolean), (.boolean, .string):
            return false
        }
    }

    static func initialSelection(
        projectDefault: FeatureSelection?,
        appDefault: FeatureSelection?,
        providers: [FeatureProvider]
    ) -> FeatureSelection? {
        validated(projectDefault, in: providers)
            ?? validated(appDefault, in: providers)
            ?? preferredSelection(in: providers)
    }

    static func validated(
        _ selection: FeatureSelection?,
        in providers: [FeatureProvider]
    ) -> FeatureSelection? {
        guard let selection,
              let provider = providers.first(where: {
                  $0.id == selection.providerID && $0.isAvailable
              }),
              provider.models.contains(where: { $0.id == selection.modelID }) else {
            return nil
        }
        return selection
    }

    static func preferredSelection(in providers: [FeatureProvider]) -> FeatureSelection? {
        let available = providers.filter(\.isAvailable)
        let preferred = available.lazy.compactMap { provider in
            provider.models.first(where: \.isDefault).map { (provider, $0) }
        }.first
            ?? available.first.flatMap { provider in
                provider.models.first.map { (provider, $0) }
            }
        guard let (provider, model) = preferred else { return nil }
        return FeatureSelection(
            providerID: provider.id,
            modelID: model.id,
            options: defaults(for: model)
        )
    }

    static func defaults(for model: FeatureModel) -> [FeatureModelOptionSelection] {
        model.options.compactMap { descriptor in
            defaultValue(for: descriptor).map { value in
                FeatureModelOptionSelection(id: descriptor.id, value: value)
            }
        }
    }

    /// An option without a declared default stays unset until the user selects it.
    static func defaultValue(
        for descriptor: FeatureModelOptionDescriptor
    ) -> FeatureModelOptionValue? {
        if let defaultValue = descriptor.defaultValue {
            return defaultValue
        }
        switch descriptor.kind {
        case .select:
            return descriptor.choices.first(where: \.isDefault).map { .string($0.id) }
        case .boolean:
            return nil
        }
    }

    static func value(
        for descriptor: FeatureModelOptionDescriptor,
        in selections: [FeatureModelOptionSelection]
    ) -> FeatureModelOptionValue? {
        if let selected = selections.first(where: { $0.id == descriptor.id })?.value {
            return selected
        }
        return defaultValue(for: descriptor)
    }

    static func updating(
        _ selections: [FeatureModelOptionSelection],
        id: String,
        value: FeatureModelOptionValue?
    ) -> [FeatureModelOptionSelection] {
        var next = selections.filter { $0.id != id }
        if let value {
            next.append(FeatureModelOptionSelection(id: id, value: value))
        }
        return next
    }

    static func summary(
        for model: FeatureModel,
        selections: [FeatureModelOptionSelection]
    ) -> String? {
        let labels = model.options.compactMap { descriptor -> String? in
            guard let value = value(for: descriptor, in: selections) else { return nil }
            switch value {
            case let .string(choiceID):
                return descriptor.choices.first(where: { $0.id == choiceID })?.label
                    ?? choiceID
            case let .boolean(isEnabled):
                return isEnabled ? descriptor.label : nil
            }
        }
        return labels.isEmpty ? nil : labels.joined(separator: " · ")
    }

    /// The compact composer gives reasoning its own non-compressible label so
    /// a long model name cannot hide the setting users change most often.
    static func reasoningSummary(
        for model: FeatureModel,
        selections: [FeatureModelOptionSelection]
    ) -> String? {
        guard let descriptor = reasoningDescriptor(for: model),
              let value = value(for: descriptor, in: selections) else {
            return nil
        }

        switch value {
        case let .string(choiceID):
            return descriptor.choices.first(where: { $0.id == choiceID })?.label
                ?? choiceID
        case let .boolean(isEnabled):
            return isEnabled ? descriptor.label : nil
        }
    }

    private static func isReasoningDescriptor(
        _ descriptor: FeatureModelOptionDescriptor
    ) -> Bool {
        let searchable = "\(descriptor.id) \(descriptor.label)".lowercased()
        return searchable.contains("reason")
            || searchable.contains("effort")
            || searchable.contains("thinking")
            || searchable.contains("thought")
    }

    static func supportsImages(
        selection: FeatureSelection?,
        providers: [FeatureProvider]
    ) -> Bool {
        // Older environments do not advertise image capability. In that case the
        // server remains the source of truth instead of hiding attachments entirely.
        guard providers.lazy.flatMap(\.models).contains(where: \.supportsImages) else {
            return true
        }
        guard let selection,
              let provider = providers.first(where: { $0.id == selection.providerID }),
              let model = provider.models.first(where: { $0.id == selection.modelID }) else {
            return true
        }
        return model.imageSupportIsUnknown == true || model.supportsImages
    }
}
