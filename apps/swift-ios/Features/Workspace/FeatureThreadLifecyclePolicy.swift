import Foundation

/// Shared by list classification and lifecycle actions. V1 retains its conservative guards.
enum FeatureThreadLifecyclePolicy {
    static func canArchive(_ thread: FeatureThread) -> Bool {
        if let facts = thread.inboxFacts, facts.orchestrationVersion == 2 {
            if facts.runtimeStatus == "queued" { return facts.activeRunID == nil }
            return !["preparing", "starting", "running"].contains(facts.runtimeStatus ?? "")
        }
        return ![.queued, .working, .monitoring, .waitingForApproval, .waitingForInput].contains(thread.state)
    }

    static func canSettle(_ thread: FeatureThread, at now: Date) -> Bool {
        thread.canToggleSettlement && !hasSettlementActivityBlock(thread, at: now)
    }

    static func hasSettlementActivityBlock(_ thread: FeatureThread, at now: Date) -> Bool {
        // V2 validates all runs and request response capabilities at dispatch.
        // Its shell cannot distinguish a dismissible async question or an automatic queued run.
        if thread.inboxFacts?.orchestrationVersion == 2 { return false }
        return hasHardSettlementActivityBlock(thread) || hasQueuedTurnStart(thread, at: now)
    }

    static func hasHardSettlementActivityBlock(_ thread: FeatureThread) -> Bool {
        if thread.inboxFacts?.orchestrationVersion == 2 { return false }
        guard let facts = thread.settlementFacts else {
            return [.queued, .working, .monitoring, .waitingForApproval, .waitingForInput].contains(thread.state)
        }
        return facts.hasPendingApprovals || facts.hasPendingUserInput
            || facts.sessionStatus == "starting" || facts.sessionStatus == "running"
    }

    static func isSettled(_ thread: FeatureThread) -> Bool {
        thread.hasPendingLocalMessages != true && thread.effectiveSettlementOverride == .settled
    }

    static func hasPendingRequest(_ thread: FeatureThread) -> Bool {
        thread.settlementFacts?.hasPendingApprovals == true
            || thread.settlementFacts?.hasPendingUserInput == true
            || thread.state == .waitingForApproval || thread.state == .waitingForInput
    }

    static func canSnooze(_ thread: FeatureThread, at now: Date) -> Bool {
        thread.canToggleSnooze && !hasPendingRequest(thread) && !hasQueuedTurnStart(thread, at: now)
    }

    static func hasQueuedTurnStart(_ thread: FeatureThread, at now: Date) -> Bool {
        let inbox = thread.inboxFacts
        if inbox?.orchestrationVersion == 2,
           ["preparing", "queued", "starting"].contains(inbox?.runtimeStatus ?? "") { return true }
        guard let facts = thread.settlementFacts,
              inbox?.orchestrationVersion == 2 || facts.sessionStatus != "error",
              let messageAt = facts.latestUserMessageAt,
              abs(now.timeIntervalSince(messageAt)) <= 120 else { return false }
        if let inbox, inbox.orchestrationVersion == 2 {
            guard inbox.latestRunID != nil else { return true }
            if inbox.latestRunHasInvalidTimestamp == true { return false }
            return [inbox.latestRunRequestedAt, inbox.latestRunStartedAt, inbox.latestRunCompletedAt]
                .allSatisfy { $0.map { $0 < messageAt } ?? true }
        }
        guard let turn = facts.latestTurn else { return true }
        if turn.requestedAtIsInvalid || turn.startedAtIsInvalid || turn.completedAtIsInvalid { return false }
        return [turn.requestedAt, turn.startedAt, turn.completedAt]
            .allSatisfy { $0.map { $0 < messageAt } ?? true }
    }

    static func queuedSettlementBoundary(_ thread: FeatureThread, after now: Date) -> Date? {
        // These states clear on the next shell update, not after a timestamp grace period.
        if thread.inboxFacts?.orchestrationVersion == 2,
           ["preparing", "queued", "starting"].contains(thread.inboxFacts?.runtimeStatus ?? "") { return nil }
        guard hasQueuedTurnStart(thread, at: now), let messageAt = thread.settlementFacts?.latestUserMessageAt else {
            return nil
        }
        let boundary = messageAt.addingTimeInterval(120.001)
        return boundary > now ? boundary : nil
    }

    static func isSnoozed(_ thread: FeatureThread, at now: Date) -> Bool {
        guard let until = thread.snoozedUntil, until > now else { return false }
        if hasPendingRequest(thread) { return false }
        let facts = thread.inboxFacts
        let failed = facts?.orchestrationVersion == 2
            ? facts?.runtimeStatus == "failed" : thread.state == .failed
        if failed {
            guard let snoozedAt = thread.snoozedAt else { return false }
            let failureAt = facts?.runtimeUpdatedAt ?? thread.attentionAt
            if let failureAt, failureAt > snoozedAt { return false }
        }
        let completed = facts.map { $0.latestRunStatus == "completed" } ?? (thread.state == .completed)
        let completedAt = facts == nil ? thread.latestTurnCompletedAt : facts?.latestRunCompletedAt
        if completed, let snoozedAt = thread.snoozedAt, let completedAt, completedAt > snoozedAt { return false }
        return true
    }

    static func hasUnseenCompletion(_ thread: FeatureThread) -> Bool {
        guard let facts = thread.inboxFacts, facts.orchestrationVersion == 2,
              let completedAt = facts.latestRunCompletedAt,
              let visitedAt = facts.lastVisitedAt, !visitedAt.isEmpty else { return false }
        guard let visitedAt = date(visitedAt) else { return true }
        return completedAt > visitedAt
    }

    // Row renders call `date` through `homeStatus` many times, so build the styles once.
    private static let fractionalStyle = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let wholeSecondStyle = Date.ISO8601FormatStyle()

    static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        guard let parsed = (try? fractionalStyle.parse(value))
            ?? (try? wholeSecondStyle.parse(value)) else { return nil }
        // Match NativeTimestampParser's millisecond values for shell/run timestamps.
        return Date(timeIntervalSince1970: (parsed.timeIntervalSince1970 * 1_000).rounded() / 1_000)
    }
}
