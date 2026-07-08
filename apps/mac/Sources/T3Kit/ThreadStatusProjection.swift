import Foundation

public enum T3ProjectedThreadStatus: Sendable, Equatable {
    case idle, running, waitingApproval, error, archived, backgroundWork
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
