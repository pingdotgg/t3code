import Foundation

/// Display data only. Account emails, server addresses, and credentials never
/// leave the app through this snapshot.
struct T3SubscriptionUsageSnapshot: Codable, Equatable, Sendable {
    struct Window: Codable, Equatable, Identifiable, Sendable {
        let id: String
        let kind: String
        let label: String
        let remaining: Int
        let resetAt: Date?
    }

    struct Provider: Codable, Equatable, Identifiable, Sendable {
        let id: String
        let name: String
        let accountCount: Int
        let checkedAt: Date?
        let expiresAt: Date?
        let windows: [Window]
        let totalWindows: Int
        let hasPartialData: Bool

        func isFresh(at now: Date) -> Bool { expiresAt.map { $0 > now } ?? false }

        func detail(at now: Date) -> String {
            if !windows.isEmpty && !isFresh(at: now) { return "Open T3 to refresh" }
            if hasPartialData { return "Some limits unavailable" }
            if windows.isEmpty { return "No limits available" }
            return accountCount > 1 ? "\(accountCount) accounts · pooled" : "Subscription remaining"
        }

        func visibleWindows(period: String, limit: Int, at now: Date, tightestOnly: Bool = false) -> [Window] {
            guard isFresh(at: now) else { return [] }
            let matching = windows.filter { period == "both" || $0.kind == period }
            if tightestOnly { return matching.min { $0.remaining < $1.remaining }.map { [$0] } ?? [] }
            let primary = [matching.first { $0.kind == "session" }, matching.first { $0.kind == "weekly" }].compactMap { $0 }
            return Array((primary + matching.filter { window in !primary.contains(where: { $0.id == window.id }) }).prefix(limit))
        }
    }

    let providers: [Provider]
    static let empty = T3SubscriptionUsageSnapshot(providers: [
        .init(id: "codex", name: "Codex", accountCount: 0, checkedAt: nil, expiresAt: nil, windows: [], totalWindows: 0, hasPartialData: false),
        .init(id: "claudeAgent", name: "Claude", accountCount: 0, checkedAt: nil, expiresAt: nil, windows: [], totalWindows: 0, hasPartialData: false),
    ])

    var checkedAt: Date? { providers.compactMap(\.checkedAt).min() }

    /// Precompute each expiration. WidgetKit need not wake the app or poll a server.
    func timelineDates(from now: Date) -> [Date] {
        [now] + Set(providers.compactMap(\.expiresAt).filter { $0 > now }).sorted()
    }
}

enum T3SubscriptionUsageSnapshotStore {
    static let kind = "T3SubscriptionUsageWidget"

    static func load() -> T3SubscriptionUsageSnapshot {
        guard let url = fileURL(),
              let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= 64 * 1_024,
              let data = try? Data(contentsOf: url),
              let snapshot = try? JSONDecoder().decode(T3SubscriptionUsageSnapshot.self, from: data) else { return .empty }
        return snapshot
    }

    static func save(_ snapshot: T3SubscriptionUsageSnapshot) throws {
        guard let url = fileURL() else { throw CocoaError(.fileNoSuchFile) }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(snapshot).write(to: url, options: .atomic)
    }

    private static func fileURL() -> URL? {
        T3SharedContainer.rootURL?
            .appending(path: "Library/Application Support/T3Code", directoryHint: .isDirectory)
            .appending(path: "subscription-usage-widget.json", directoryHint: .notDirectory)
    }
}
