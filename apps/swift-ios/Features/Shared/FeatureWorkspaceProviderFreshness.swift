import Foundation

/// Gates workspace discovery on composer use. All times after the first cache
/// observation are local, so a server clock offset cannot keep starting scans.
struct FeatureWorkspaceProviderFreshness {
    struct Key: Hashable {
        let environmentID: String
        let cwd: String
        let instanceID: String
    }

    static let cacheTTL: TimeInterval = 5 * 60
    static let retryCooldown: TimeInterval = 10

    private struct Entry {
        var requestedAt: Date?
        var completedAt: Date?
        var isRefreshing = false
    }

    private var entries: [Key: Entry] = [:]

    /// Returns true once per eligible key. The caller must finish every request,
    /// including failed or cancelled requests. Pending discovery retries on use.
    mutating func beginRefresh(
        key: Key,
        checkedAt: Date?,
        commandsPending: Bool,
        now: Date
    ) -> Bool {
        var entry = entries[key] ?? Entry(
            completedAt: commandsPending ? nil : checkedAt.map { min($0, now) }
        )
        guard !entry.isRefreshing else { return false }
        if checkedAt != nil, !commandsPending,
           let completedAt = entry.completedAt,
           Self.isRecent(completedAt, now: now, interval: Self.cacheTTL) {
            entries[key] = entry
            return false
        }
        if let requestedAt = entry.requestedAt,
           Self.isRecent(requestedAt, now: now, interval: Self.retryCooldown) {
            return false
        }
        entry.requestedAt = now
        entry.completedAt = nil
        entry.isRefreshing = true
        entries[key] = entry
        return true
    }

    mutating func finishRefresh(key: Key, complete: Bool, now: Date) {
        guard var entry = entries[key], entry.isRefreshing else { return }
        entry.isRefreshing = false
        entry.completedAt = complete ? now : nil
        entries[key] = entry
    }

    private static func isRecent(_ date: Date, now: Date, interval: TimeInterval) -> Bool {
        let age = now.timeIntervalSince(date)
        return age >= 0 && age < interval
    }
}
