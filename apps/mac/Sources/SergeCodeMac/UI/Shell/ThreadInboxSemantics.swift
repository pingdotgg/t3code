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

    /// Snooze is an overlay on the active lifecycle: a snoozed thread stays
    /// "active" on the wire and is only suppressed until `snoozedUntil`
    /// passes. Timer wakes emit no event — a passed wake time simply stops
    /// classifying as snoozed on the next evaluation.
    static func isSnoozed(_ thread: ChatThread, now: Date = Date()) -> Bool {
        guard let until = thread.snoozedUntil else { return false }
        return until > now
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

/// Preset wake times for the sidebar's Snooze submenu. Pure computation from
/// `now` so tests can pin the clock.
struct SnoozePreset: Identifiable {
    let id: String
    let title: String
    let icon: String
    let until: Date

    static func presets(now: Date, calendar: Calendar = .current) -> [SnoozePreset] {
        var result: [SnoozePreset] = [
            SnoozePreset(id: "hour", title: "In 1 Hour", icon: "clock", until: now.addingTimeInterval(3600)),
            SnoozePreset(
                id: "evening", title: "In 3 Hours", icon: "clock.badge",
                until: now.addingTimeInterval(3 * 3600)),
        ]
        if let tomorrowStart = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)),
            let tomorrowMorning = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrowStart)
        {
            result.append(
                SnoozePreset(
                    id: "tomorrow", title: "Tomorrow 9 AM", icon: "sunrise", until: tomorrowMorning))
            if let nextWeek = calendar.date(byAdding: .day, value: 7, to: tomorrowMorning) {
                result.append(
                    SnoozePreset(id: "week", title: "In a Week", icon: "calendar", until: nextWeek))
            }
        }
        return result
    }
}
