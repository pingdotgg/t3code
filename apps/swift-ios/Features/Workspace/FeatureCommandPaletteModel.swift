import CoreGraphics
import Foundation

enum FeatureCommandPaletteAction: Hashable {
    case newTask(projectID: String?)
    case chooseNewTaskProject
    case addProject
    case settings
    case openThread(id: String)
    case openProject(id: String)
}

struct FeatureCommandPaletteItem: Identifiable, Equatable {
    let id: String
    let title: String
    let detail: String?
    let searchTerms: [String]
    let systemImage: String
    let action: FeatureCommandPaletteAction
    let showsDisclosure: Bool

    init(
        id: String,
        title: String,
        detail: String? = nil,
        searchTerms: [String] = [],
        systemImage: String,
        action: FeatureCommandPaletteAction,
        showsDisclosure: Bool = false
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.searchTerms = searchTerms
        self.systemImage = systemImage
        self.action = action
        self.showsDisclosure = showsDisclosure
    }
}

struct FeatureCommandPaletteGroup: Identifiable, Equatable {
    let id: String
    let title: String
    let items: [FeatureCommandPaletteItem]
}

enum FeatureCommandPaletteMode: Equatable {
    case root
    case newTaskProjectPicker
}

enum FeatureCommandPaletteGesture {
    static let maximumStartY: CGFloat = 88
    static let minimumDownwardTranslation: CGFloat = 72

    static func shouldPresent(startY: CGFloat, translation: CGSize) -> Bool {
        guard startY <= maximumStartY,
              translation.height >= minimumDownwardTranslation else {
            return false
        }

        return translation.height > abs(translation.width) * 1.15
    }
}

enum FeatureCommandPaletteCatalog {
    static let recentThreadLimit = 12

    static func groups(
        snapshot: FeatureSnapshot,
        projects: [FeatureProject],
        activeProjectID: String?,
        query: String
    ) -> [FeatureCommandPaletteGroup] {
        let actions = actionItems(projects: projects, activeProjectID: activeProjectID)
        let rawQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let actionsOnly = rawQuery.first == ">"
        let searchQuery = actionsOnly
            ? String(rawQuery.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines)
            : rawQuery

        if searchQuery.isEmpty {
            if actionsOnly {
                return group(id: "actions", title: "Actions", items: actions)
            }

            return rootGroups(
                actions: actions,
                recentThreads: recentThreadItems(snapshot: snapshot)
            )
        }

        let filteredActions = matchingItems(actions, query: searchQuery)
        var groups: [FeatureCommandPaletteGroup] = []
        if !filteredActions.isEmpty {
            groups.append(FeatureCommandPaletteGroup(
                id: "actions",
                title: "Actions",
                items: filteredActions
            ))
        }

        guard !actionsOnly else { return groups }

        let filteredProjects = matchingItems(
            projectItems(snapshot: snapshot, projects: projects),
            query: searchQuery
        )
        if !filteredProjects.isEmpty {
            groups.append(FeatureCommandPaletteGroup(
                id: "projects-search",
                title: "Projects",
                items: filteredProjects
            ))
        }

        let filteredThreads = matchingItems(
            threadItems(snapshot: snapshot),
            query: searchQuery
        )
        if !filteredThreads.isEmpty {
            groups.append(FeatureCommandPaletteGroup(
                id: "threads-search",
                title: "Threads",
                items: filteredThreads
            ))
        }

        return groups
    }

    static func newTaskProjectGroups(
        snapshot: FeatureSnapshot,
        projects: [FeatureProject],
        query: String
    ) -> [FeatureCommandPaletteGroup] {
        let items = matchingItems(
            projectItems(
                snapshot: snapshot,
                projects: projects,
                action: { .newTask(projectID: $0.id) },
                idPrefix: "new-task-in"
            ),
            query: query
        )
        guard !items.isEmpty else { return [] }
        return [FeatureCommandPaletteGroup(id: "projects", title: "Projects", items: items)]
    }

    private static func rootGroups(
        actions: [FeatureCommandPaletteItem],
        recentThreads: [FeatureCommandPaletteItem]
    ) -> [FeatureCommandPaletteGroup] {
        var groups: [FeatureCommandPaletteGroup] = []
        if !actions.isEmpty {
            groups.append(FeatureCommandPaletteGroup(
                id: "actions",
                title: "Actions",
                items: actions
            ))
        }
        if !recentThreads.isEmpty {
            groups.append(FeatureCommandPaletteGroup(
                id: "recent-threads",
                title: "Recent Threads",
                items: recentThreads
            ))
        }
        return groups
    }

    private static func actionItems(
        projects: [FeatureProject],
        activeProjectID: String?
    ) -> [FeatureCommandPaletteItem] {
        var items: [FeatureCommandPaletteItem] = []
        if !projects.isEmpty {
            let activeProject = projects.first { $0.id == activeProjectID } ?? projects.first
            if let activeProject {
                items.append(FeatureCommandPaletteItem(
                    id: "action:new-task",
                    title: "New task in \(activeProject.name)",
                    detail: activeProject.path,
                    searchTerms: [
                        "new task", "new thread", "chat", "create", "draft",
                        activeProject.name, activeProject.path,
                    ],
                    systemImage: "square.and.pencil",
                    action: .newTask(projectID: activeProject.id)
                ))
            }

            items.append(FeatureCommandPaletteItem(
                id: "action:new-task-in",
                title: "New task in…",
                detail: "Choose a project",
                searchTerms: ["new task", "new thread", "project", "choose", "select"],
                systemImage: "square.and.pencil",
                action: .chooseNewTaskProject,
                showsDisclosure: true
            ))
        }

        items.append(FeatureCommandPaletteItem(
            id: "action:add-project",
            title: "Add project",
            detail: "Local folder or remote repository",
            searchTerms: [
                "add project", "folder", "directory", "browse", "clone", "remote",
                "repository", "repo", "git", "github", "gitlab", "bitbucket", "azure",
                "devops", "url", "environment",
            ],
            systemImage: "folder.badge.plus",
            action: .addProject
        ))
        items.append(FeatureCommandPaletteItem(
            id: "action:settings",
            title: "Open settings",
            detail: "Preferences and connections",
            searchTerms: ["settings", "preferences", "configuration", "connections"],
            systemImage: "slider.horizontal.3",
            action: .settings
        ))
        return items
    }

    private static func recentThreadItems(
        snapshot: FeatureSnapshot
    ) -> [FeatureCommandPaletteItem] {
        Array(threadItems(snapshot: snapshot).prefix(recentThreadLimit))
    }

    private static func projectItems(
        snapshot: FeatureSnapshot,
        projects: [FeatureProject],
        action: (FeatureProject) -> FeatureCommandPaletteAction = { .openProject(id: $0.id) },
        idPrefix: String = "project"
    ) -> [FeatureCommandPaletteItem] {
        let environmentNames = Dictionary(
            uniqueKeysWithValues: snapshot.environments.map { ($0.id, $0.name) }
        )

        return projects
            .sorted { left, right in
                let nameOrder = left.name.localizedStandardCompare(right.name)
                if nameOrder != .orderedSame { return nameOrder == .orderedAscending }
                return left.id < right.id
            }
            .map { project in
                let environment = environmentNames[project.environmentID]
                let detail = [project.path, environment]
                    .compactMap { $0?.isEmpty == false ? $0 : nil }
                    .joined(separator: " · ")
                return FeatureCommandPaletteItem(
                    id: "\(idPrefix):\(project.id)",
                    title: project.name,
                    detail: detail.isEmpty ? nil : detail,
                    searchTerms: [project.name, project.path, environment ?? ""],
                    systemImage: "folder",
                    action: action(project)
                )
            }
    }

    private static func threadItems(snapshot: FeatureSnapshot) -> [FeatureCommandPaletteItem] {
        let projectsByID = Dictionary(uniqueKeysWithValues: snapshot.projects.map { ($0.id, $0) })
        let environmentNames = Dictionary(
            uniqueKeysWithValues: snapshot.environments.map { ($0.id, $0.name) }
        )

        return snapshot.threads
            .filter { !$0.isArchived }
            .sorted { left, right in
                let leftDate = left.lastActivityAt ?? left.updatedAt
                let rightDate = right.lastActivityAt ?? right.updatedAt
                if leftDate != rightDate { return leftDate > rightDate }
                return left.id < right.id
            }
            .map { thread in
                let project = projectsByID[thread.projectID]
                let environment = thread.environmentID.flatMap { environmentNames[$0] }
                    ?? thread.environmentName
                let detail = [
                    project?.name,
                    thread.branch.map { "#\($0)" },
                    environment,
                ]
                    .compactMap { $0?.isEmpty == false ? $0 : nil }
                    .joined(separator: " · ")
                return FeatureCommandPaletteItem(
                    id: "thread:\(thread.id)",
                    title: thread.title,
                    detail: detail.isEmpty ? nil : detail,
                    searchTerms: [
                        thread.title,
                        thread.preview ?? "",
                        thread.branch ?? "",
                        project?.name ?? "",
                        project?.path ?? "",
                        environment ?? "",
                    ],
                    systemImage: "message",
                    action: .openThread(id: thread.id)
                )
            }
    }

    private static func matchingItems(
        _ items: [FeatureCommandPaletteItem],
        query: String
    ) -> [FeatureCommandPaletteItem] {
        let tokens = normalizedTokens(query)
        guard !tokens.isEmpty else { return items }

        return items.enumerated()
            .compactMap { index, item -> (item: FeatureCommandPaletteItem, score: Int, index: Int)? in
                guard let score = matchScore(item: item, tokens: tokens) else { return nil }
                return (item, score, index)
            }
            .sorted { left, right in
                if left.score != right.score { return left.score > right.score }
                return left.index < right.index
            }
            .map(\.item)
    }

    private static func matchScore(
        item: FeatureCommandPaletteItem,
        tokens: [String]
    ) -> Int? {
        let fields = [item.title, item.detail ?? ""] + item.searchTerms
        var score = 0

        for token in tokens {
            var tokenScore: Int?
            for (index, field) in fields.enumerated() {
                guard field.localizedCaseInsensitiveContains(token) else { continue }
                let normalizedField = field.folding(
                    options: [.diacriticInsensitive, .caseInsensitive],
                    locale: .current
                )
                let normalizedToken = token.folding(
                    options: [.diacriticInsensitive, .caseInsensitive],
                    locale: .current
                )
                let fieldScore: Int
                if normalizedField == normalizedToken {
                    fieldScore = 300
                } else if normalizedField.hasPrefix(normalizedToken) {
                    fieldScore = 200
                } else {
                    fieldScore = 100
                }
                tokenScore = max(tokenScore ?? 0, fieldScore - min(index, 20))
            }
            guard let tokenScore else { return nil }
            score += tokenScore
        }

        return score
    }

    private static func normalizedTokens(_ query: String) -> [String] {
        query
            .split(whereSeparator: \.isWhitespace)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private static func group(
        id: String,
        title: String,
        items: [FeatureCommandPaletteItem]
    ) -> [FeatureCommandPaletteGroup] {
        guard !items.isEmpty else { return [] }
        return [FeatureCommandPaletteGroup(id: id, title: title, items: items)]
    }
}
