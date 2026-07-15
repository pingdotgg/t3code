import Foundation

public enum T3ProjectedThreadStatus: Sendable, Equatable {
    case idle, running, waiting, waitingApproval, error, archived, backgroundWork
}

/// Server-authoritative liveness for a thread's active provider turn, folded
/// from `session.health` activities (all providers). `nil` from the projection
/// means the server has not reported health for this thread — callers should
/// fall back to any client-side heuristic. When present, the server signal is
/// authoritative and wins over client heuristics.
public struct T3ThreadHealth: Sendable, Equatable {
    /// True when the active turn has exceeded the server's activity threshold.
    public var stalled: Bool
    /// Last projected provider activity time for the turn (from the event).
    public var lastActivityAt: Date
    /// When the current stall began; `nil` unless `stalled`. Derived as
    /// `lastActivityAt` (the moment activity went quiet) so relative "stalled
    /// for Xm" labels count from a stable instant.
    public var stalledSince: Date?

    public init(stalled: Bool, lastActivityAt: Date, stalledSince: Date?) {
        self.stalled = stalled
        self.lastActivityAt = lastActivityAt
        self.stalledSince = stalledSince
    }
}

/// Folds the `session.health` activity stream for one thread into its current
/// health. The server emits exactly one `stalled` transition and one `active`
/// recovery per stall episode, so the newest event is authoritative.
public enum ThreadHealthProjection {
    /// Latest health from a thread's activities, or `nil` when none were seen.
    public static func project(
        from activities: [OrchestrationThreadActivity]
    ) -> T3ThreadHealth? {
        var newest: (sort: (Date, Int), health: T3ThreadHealth)?
        for activity in activities where activity.kind == ActivityKind.sessionHealth {
            guard
                let payload = activity.decodePayload(SessionHealthActivityPayload.self),
                let createdAt = WireDate.parse(activity.createdAt)
            else { continue }
            let lastActivityAt = WireDate.parse(payload.lastActivityAt) ?? createdAt
            let health = T3ThreadHealth(
                stalled: payload.isStalled,
                lastActivityAt: lastActivityAt,
                stalledSince: payload.isStalled ? lastActivityAt : nil)
            let sort = (createdAt, activity.sequence ?? 0)
            if newest == nil || sort > newest!.sort {
                newest = (sort, health)
            }
        }
        return newest?.health
    }

    /// Applies a single `session.health` activity on top of a prior health,
    /// keeping whichever is newer (live-tail folding). Returns the unchanged
    /// prior when the activity is not a newer `session.health`.
    public static func apply(
        _ activity: OrchestrationThreadActivity,
        onto prior: T3ThreadHealth?,
        priorSortKey: (Date, Int)?
    ) -> (health: T3ThreadHealth?, sortKey: (Date, Int)?) {
        guard activity.kind == ActivityKind.sessionHealth,
            let payload = activity.decodePayload(SessionHealthActivityPayload.self),
            let createdAt = WireDate.parse(activity.createdAt)
        else { return (prior, priorSortKey) }
        let sort = (createdAt, activity.sequence ?? 0)
        if let priorSortKey, sort <= priorSortKey {
            return (prior, priorSortKey)
        }
        let lastActivityAt = WireDate.parse(payload.lastActivityAt) ?? createdAt
        let health = T3ThreadHealth(
            stalled: payload.isStalled,
            lastActivityAt: lastActivityAt,
            stalledSince: payload.isStalled ? lastActivityAt : nil)
        return (health, sort)
    }
}

public enum ThreadStatusProjection {
    public static func project(
        session: OrchestrationSession?, latestTurn: OrchestrationLatestTurn?,
        archivedAt: String?, hasPendingApprovals: Bool, activeSubagentCount: Int
    ) -> T3ProjectedThreadStatus {
        if session?.status == .error || latestTurn?.state == .error {
            return .error
        }
        if hasPendingApprovals {
            return .waitingApproval
        }
        if let status = session?.status {
            switch status {
            case .running, .starting: return .running
            case .waiting: return .waiting
            case .error: return .error
            case .idle, .ready, .interrupted, .stopped: break
            }
        }
        if latestTurn?.state == .running {
            return .running
        }
        if archivedAt == nil, activeSubagentCount > 0 {
            return .backgroundWork
        }
        if archivedAt != nil {
            return .archived
        }
        return .idle
    }
}
