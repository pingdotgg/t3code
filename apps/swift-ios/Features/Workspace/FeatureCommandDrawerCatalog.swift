import Foundation

enum FeatureCommandDrawerAction: String, CaseIterable, Equatable, Sendable {
    case newTask
    case addProject
    case settings
    case allProjects

    var title: String {
        switch self {
        case .newTask: "New task"
        case .addProject: "Add project"
        case .settings: "Settings"
        case .allProjects: "Show all projects"
        }
    }

    var systemImage: String {
        switch self {
        case .newTask: "square.and.pencil"
        case .addProject: "folder.badge.plus"
        case .settings: "slider.horizontal.3"
        case .allProjects: "line.3.horizontal.decrease"
        }
    }
}

enum FeatureCommandDrawerItem: Identifiable, Equatable, Sendable {
    case action(FeatureCommandDrawerAction)
    case project(id: String, name: String)
    case thread(id: String, title: String, projectName: String?)

    var id: String {
        switch self {
        case let .action(action): "action:\(action.rawValue)"
        case let .project(id, _): "project:\(id)"
        case let .thread(id, _, _): "thread:\(id)"
        }
    }

    var title: String {
        switch self {
        case let .action(action): action.title
        case let .project(_, name): name
        case let .thread(_, title, _): title
        }
    }

    var subtitle: String? {
        switch self {
        case .action: nil
        case .project: "Filter Home to this project"
        case let .thread(_, _, projectName): projectName
        }
    }

    var systemImage: String {
        switch self {
        case let .action(action): action.systemImage
        case .project: "folder"
        case .thread: "bubble.left.and.text.bubble.right"
        }
    }

    var destination: FeatureCommandDrawerDestination {
        switch self {
        case let .action(action): .action(action)
        case let .project(id, _): .project(id: id)
        case let .thread(id, _, _): .thread(id: id)
        }
    }
}

/// A selection leaves the drawer through one typed workspace-routing seam.
/// The presentation owns this mapping; the workspace continues to own the
/// actual navigation and sheets behind each destination.
enum FeatureCommandDrawerDestination: Equatable, Sendable {
    case action(FeatureCommandDrawerAction)
    case project(id: String)
    case thread(id: String)
}

/// Resolves the state machine's reveal into the current presentation geometry.
///
/// A settled drawer stays attached to its live edge when the keyboard changes
/// the available height. Dragging still uses the state machine's finger-bound
/// reveal, and beginning the next drag synchronizes that new rest position
/// back into the state machine.
enum FeatureCommandDrawerPresentationGeometry {
    static func reveal(
        state: FeatureCommandDrawerState,
        measuredOpenHeight: CGFloat
    ) -> CGFloat {
        state.isOpen && !state.isDragging ? measuredOpenHeight : state.reveal
    }
}

enum FeatureCommandDrawerAccessibility {
    static let drawerIdentifier = "command-drawer"
    static let searchIdentifier = "command-drawer-search-field"
    static let searchLabel = "Search commands"
    static let emptyIdentifier = "command-drawer-empty"
    static let scrimIdentifier = "command-drawer-scrim"
    static let scrimLabel = "Close commands"
    static let clearSearchLabel = "Clear command search"

    static func itemIdentifier(_ item: FeatureCommandDrawerItem) -> String {
        "command-drawer-item-\(item.id)"
    }

    static func drawerIsHidden(_ state: FeatureCommandDrawerState) -> Bool {
        !state.isOpen
    }

    static func workspaceIsHidden(_ state: FeatureCommandDrawerState) -> Bool {
        state.isOpen
    }

    static func scrimIsHidden(_ state: FeatureCommandDrawerState) -> Bool {
        !state.isOpen
    }
}

/// Builds the drawer's rows from workspace data that is already loaded.
///
/// This is a plain substring filter on purpose: the drawer's contribution is
/// the physical presentation, and ranked fuzzy search would be a separate
/// behavior with its own acceptance.
enum FeatureCommandDrawerCatalog {
    static let threadLimit = 8
    static let projectLimit = 6

    static func items(
        projects: [FeatureProject],
        threads: [FeatureThread],
        selectedProjectID: String?,
        query: String
    ) -> [FeatureCommandDrawerItem] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return actionItems(selectedProjectID: selectedProjectID, query: trimmed)
            + threadItems(threads: threads, projects: projects, query: trimmed)
            + projectItems(projects: projects, query: trimmed)
    }

    private static func actionItems(
        selectedProjectID: String?,
        query: String
    ) -> [FeatureCommandDrawerItem] {
        var actions: [FeatureCommandDrawerAction] = [.newTask, .addProject, .settings]
        if selectedProjectID != nil {
            actions.insert(.allProjects, at: 0)
        }
        return actions
            .filter { matches($0.title, query: query) }
            .map(FeatureCommandDrawerItem.action)
    }

    private static func threadItems(
        threads: [FeatureThread],
        projects: [FeatureProject],
        query: String
    ) -> [FeatureCommandDrawerItem] {
        let names = Dictionary(
            projects.map { ($0.id, $0.name) },
            uniquingKeysWith: { first, _ in first }
        )
        return threads
            .filter { !$0.isArchived && matches($0.title, query: query) }
            .sorted {
                let left = activity(of: $0)
                let right = activity(of: $1)
                return left == right ? $0.id < $1.id : left > right
            }
            .prefix(threadLimit)
            .map { .thread(id: $0.id, title: $0.title, projectName: names[$0.projectID]) }
    }

    private static func projectItems(
        projects: [FeatureProject],
        query: String
    ) -> [FeatureCommandDrawerItem] {
        projects
            .filter { matches($0.name, query: query) }
            .prefix(projectLimit)
            .map { .project(id: $0.id, name: $0.name) }
    }

    private static func activity(of thread: FeatureThread) -> Date {
        thread.lastActivityAt ?? thread.updatedAt
    }

    private static func matches(_ candidate: String, query: String) -> Bool {
        guard !query.isEmpty else { return true }
        return candidate.localizedCaseInsensitiveContains(query)
    }
}
