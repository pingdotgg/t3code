import AppIntents
import Foundation

struct PlatformRecentThreadRecord: Codable, Equatable, Sendable {
    let id: String
    let environmentID: String?
    let wireID: String
    let title: String
    let environmentName: String?
    let updatedAt: Date
}

final class PlatformRecentThreadStore: @unchecked Sendable {
    static let shared = PlatformRecentThreadStore()

    private let defaults: UserDefaults
    private let key: String
    private let lock = NSLock()

    init(defaults: UserDefaults = .standard, key: String = "swift-ios.recent-threads.v1") {
        self.defaults = defaults
        self.key = key
    }

    func update(from threads: [FeatureThread]) {
        let records = threads
            .filter { !$0.isArchived }
            .sorted { lhs, rhs in
                if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
                return lhs.id < rhs.id
            }
            .prefix(12)
            .map {
                PlatformRecentThreadRecord(
                    id: $0.id,
                    environmentID: $0.environmentID,
                    wireID: $0.wireID ?? $0.id,
                    title: $0.title,
                    environmentName: $0.environmentName,
                    updatedAt: $0.updatedAt
                )
            }
        lock.withLock {
            defaults.set(try? JSONEncoder().encode(records), forKey: key)
        }
    }

    func records() -> [PlatformRecentThreadRecord] {
        lock.withLock {
            guard let data = defaults.data(forKey: key) else { return [] }
            return (try? JSONDecoder().decode([PlatformRecentThreadRecord].self, from: data)) ?? []
        }
    }
}

struct PlatformRecentThreadEntity: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "T3 Code Thread")
    static let defaultQuery = PlatformRecentThreadQuery()

    let id: String
    let environmentID: String?
    let wireID: String
    let title: String
    let environmentName: String?

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(title)",
            subtitle: environmentName.map { "\($0)" }
        )
    }

    init(record: PlatformRecentThreadRecord) {
        id = record.id
        environmentID = record.environmentID
        wireID = record.wireID
        title = record.title
        environmentName = record.environmentName
    }
}

struct PlatformRecentThreadQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [PlatformRecentThreadEntity] {
        let requested = Set(identifiers)
        return PlatformRecentThreadStore.shared.records()
            .filter { requested.contains($0.id) }
            .map(PlatformRecentThreadEntity.init)
    }

    func suggestedEntities() async throws -> [PlatformRecentThreadEntity] {
        PlatformRecentThreadStore.shared.records().map(PlatformRecentThreadEntity.init)
    }
}

struct NewT3TaskIntent: AppIntent {
    static let title: LocalizedStringResource = "New T3 Code Task"
    static let description = IntentDescription("Open the native composer and start a task.")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        PlatformRouteMailbox.shared.put(.newTask(environmentID: nil, projectID: nil))
        return .result()
    }
}

struct OpenRecentT3ThreadIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Recent T3 Code Thread"
    static let description = IntentDescription("Open a recent thread in T3 Code.")
    static let openAppWhenRun = true

    @Parameter(title: "Thread")
    var thread: PlatformRecentThreadEntity

    func perform() async throws -> some IntentResult {
        PlatformRouteMailbox.shared.put(
            .thread(environmentID: thread.environmentID, threadID: thread.wireID)
        )
        return .result()
    }
}

struct T3PlatformShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: NewT3TaskIntent(),
            phrases: [
                "Start a task in \(.applicationName)",
                "New task in \(.applicationName)",
            ],
            shortTitle: "New Task",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: OpenRecentT3ThreadIntent(),
            phrases: [
                "Open a recent thread in \(.applicationName)",
            ],
            shortTitle: "Open Thread",
            systemImageName: "bubble.left.and.bubble.right"
        )
    }
}
