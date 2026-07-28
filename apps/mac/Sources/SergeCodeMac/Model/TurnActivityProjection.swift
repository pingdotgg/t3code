import Foundation

/// One agent turn's live activity, projected from the chat timeline for the
/// inspector's "Current Turn" card. Turn segmentation mirrors the rule
/// documented on `upsertTimelineItem` (`Entities.swift`): a user message
/// opens a new turn, everything after it belongs to that turn until the next
/// user message.
struct TurnActivity: Equatable, Sendable {
    /// A tool call within the turn, summarized for the card rows.
    struct Event: Identifiable, Equatable, Sendable {
        let id: String
        let name: String
        let detail: String
        let kind: ToolEventKind
        let status: ToolEventStatus
    }

    /// 1-based turn number: the count of user messages up to and including
    /// the one that opened this turn.
    var turnNumber: Int
    /// First line of the user message that opened the turn (nil when the
    /// timeline has no user message yet).
    var prompt: String?
    /// When the opening user message was sent; drives the live timer.
    var startedAt: Date?
    /// The turn's tool events in chronological order (latest last).
    var events: [Event]
    /// Unique file paths touched by `.fileChange` events, in first-touch order.
    var filesTouched: [String]

    var toolCount: Int { events.count }
    var failedCount: Int { events.filter { $0.status == .failed }.count }
}

enum TurnActivityProjection {
    /// The turn currently in flight: the timeline segment after the last
    /// user message. `checkpoints` only supplies the fallback turn number
    /// when the timeline has no user message at all, keeping the card's
    /// numbering consistent with History's "Turn N" checkpoint labels.
    static func currentTurn(timeline: [TimelineItem], checkpoints: [Checkpoint]) -> TurnActivity {
        var turnNumber = 0
        var prompt: String?
        var startedAt: Date?
        var events: [TurnActivity.Event] = []
        var filesTouched: [String] = []

        for item in timeline {
            switch item {
            case .userMessage(_, let text, _, let at):
                turnNumber += 1
                prompt = text.split(separator: "\n", maxSplits: 1).first.map(String.init)
                startedAt = at
                events = []
                filesTouched = []
            case .toolEvent(let id, let name, let detail, let kind, let status, _, _, _)
            where status != .running:
                // The full-width live activity card is the sole owner of
                // non-terminal work. This inspector is completed turn
                // history, matching the chat transcript projection.
                events.append(
                    TurnActivity.Event(id: id, name: name, detail: detail, kind: kind, status: status))
                if kind == .fileChange, !detail.isEmpty, !filesTouched.contains(detail) {
                    filesTouched.append(detail)
                }
            default:
                break
            }
        }

        if turnNumber == 0 {
            turnNumber = (checkpoints.map(\.turnCount).max() ?? 0) + 1
        }

        return TurnActivity(
            turnNumber: turnNumber,
            prompt: prompt,
            startedAt: startedAt,
            events: events,
            filesTouched: filesTouched
        )
    }
}
