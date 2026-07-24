import Foundation

/// Pure sidebar classification shared by presentation and tests. The server is
/// authoritative for explicit lifecycle transitions; these helpers mirror the
/// client-runtime rules for automatic settlement and stable ordering.
enum ThreadInboxSemantics {
    static let queuedTurnStartGrace: TimeInterval = 2 * 60

    static func lastActivityAt(_ thread: ChatThread) -> Date? {
        [
            thread.latestUserMessageAt,
            thread.latestTurnRequestedAt,
            thread.latestTurnStartedAt,
            thread.latestTurnCompletedAt,
        ].compactMap { $0 }.max()
    }

    static func hasQueuedTurnStart(_ thread: ChatThread, now: Date = Date()) -> Bool {
        guard let messageAt = thread.latestUserMessageAt else { return false }
        guard thread.sessionStatus != "error" else { return false }
        guard abs(now.timeIntervalSince(messageAt)) <= queuedTurnStartGrace else { return false }
        let latestTurnAt = [
            thread.latestTurnRequestedAt,
            thread.latestTurnStartedAt,
            thread.latestTurnCompletedAt,
        ].compactMap { $0 }.max()
        return latestTurnAt == nil || messageAt > latestTurnAt!
    }

    static func canSettle(_ thread: ChatThread, now: Date = Date()) -> Bool {
        if thread.hasPendingApproval || thread.hasPendingUserInput { return false }
        if thread.sessionStatus == "starting" || thread.sessionStatus == "running" { return false }
        return !hasQueuedTurnStart(thread, now: now)
    }

    static func effectiveSettled(
        _ thread: ChatThread,
        now: Date = Date(),
        autoSettleAfterDays: Int? = 3,
        changeRequestState: PullRequestState? = nil
    ) -> Bool {
        if thread.hasPendingApproval || thread.hasPendingUserInput { return false }
        if thread.sessionStatus == "starting" || thread.sessionStatus == "running" { return false }
        if hasQueuedTurnStart(thread, now: now) {
            let serverAdjudicated = thread.settledOverride == "settled"
                && thread.settledAt != nil
                && thread.latestUserMessageAt != nil
                && thread.settledAt! >= thread.latestUserMessageAt!
            if !serverAdjudicated { return false }
        }
        if thread.settledOverride == "settled" { return true }
        if thread.settledOverride == "active" { return false }
        if changeRequestState == .merged || changeRequestState == .closed { return true }
        guard let days = autoSettleAfterDays, let activity = lastActivityAt(thread) else { return false }
        return activity < now.addingTimeInterval(-TimeInterval(days) * 86_400)
    }

    static func settledTimestamp(_ thread: ChatThread) -> Date {
        thread.settledAt ?? lastActivityAt(thread) ?? thread.updatedAt
    }

    static func sortActive(_ threads: [ChatThread]) -> [ChatThread] {
        threads.sorted {
            if $0.createdAt != $1.createdAt { return $0.createdAt > $1.createdAt }
            return $0.id < $1.id
        }
    }

    static func sortSettled(_ threads: [ChatThread]) -> [ChatThread] {
        threads.sorted {
            let left = settledTimestamp($0)
            let right = settledTimestamp($1)
            if left != right { return left > right }
            return $0.id < $1.id
        }
    }
}
