import Foundation

struct T3TaskWidgetSnapshot: Codable, Hashable, Sendable {
    static let empty = T3TaskWidgetSnapshot(updatedAt: "", tasks: [])

    var updatedAt: String
    var tasks: [T3RelayAgentActivityAggregateRow]
}

/// The host writes one small snapshot after task-state changes; the widget only
/// performs a bounded file read when WidgetKit requests a timeline.
enum T3TaskWidgetSnapshotStore {
    static let fileName = "task-widget-snapshot.json"

    static func load() -> T3TaskWidgetSnapshot {
        guard let url = fileURL(),
              let data = try? Data(contentsOf: url),
              let snapshot = try? JSONDecoder().decode(T3TaskWidgetSnapshot.self, from: data)
        else {
            return .empty
        }
        return snapshot
    }

    static func save(_ snapshot: T3TaskWidgetSnapshot) throws {
        guard let url = fileURL() else {
            throw CocoaError(.fileNoSuchFile)
        }
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try encoder.encode(snapshot).write(to: url, options: .atomic)
    }

    private static func fileURL() -> URL? {
        T3SharedContainer.rootURL?
            .appending(path: "Library/Application Support/T3Code", directoryHint: .isDirectory)
            .appending(path: fileName, directoryHint: .notDirectory)
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()
}
