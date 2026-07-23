import Foundation

/// Signals used to decide whether the parent agent should show an ephemeral
/// "Thinking…" indicator. Mirrors `packages/shared/src/parentThinking.ts`.
public struct ParentThinkingSignals: Sendable, Equatable {
    /// Orchestration session status (`running`, `waiting`, `idle`, …).
    public var sessionStatus: String?
    /// Latest turn state (`running`, `completed`, `error`, `interrupted`, …).
    public var latestTurnState: String?
    public var hasPendingApproval: Bool
    public var hasPendingUserInput: Bool
    /// Server-authoritative stall from `session.health`.
    public var isStalled: Bool
    /// Parent-thread tool call currently in progress.
    public var hasActiveToolActivity: Bool
    /// An assistant message is streaming (empty or not).
    public var hasActiveStreamingAssistant: Bool
    /// Non-empty streamed assistant body for the active turn.
    public var hasStreamingAssistantText: Bool
    /// Visible reasoning/progress text for the parent agent.
    public var hasVisibleReasoningText: Bool

    public init(
        sessionStatus: String? = nil,
        latestTurnState: String? = nil,
        hasPendingApproval: Bool = false,
        hasPendingUserInput: Bool = false,
        isStalled: Bool = false,
        hasActiveToolActivity: Bool = false,
        hasActiveStreamingAssistant: Bool = false,
        hasStreamingAssistantText: Bool = false,
        hasVisibleReasoningText: Bool = false
    ) {
        self.sessionStatus = sessionStatus
        self.latestTurnState = latestTurnState
        self.hasPendingApproval = hasPendingApproval
        self.hasPendingUserInput = hasPendingUserInput
        self.isStalled = isStalled
        self.hasActiveToolActivity = hasActiveToolActivity
        self.hasActiveStreamingAssistant = hasActiveStreamingAssistant
        self.hasStreamingAssistantText = hasStreamingAssistantText
        self.hasVisibleReasoningText = hasVisibleReasoningText
    }
}

/// Pure gate for the parent "Thinking…" indicator.
public enum ParentThinking {
    /// True when the parent model is actively reasoning without other visible
    /// activity the UI already surfaces.
    public static func shouldShow(_ signals: ParentThinkingSignals) -> Bool {
        if signals.hasPendingApproval || signals.hasPendingUserInput {
            return false
        }
        if signals.isStalled {
            return false
        }

        let sessionStatus = signals.sessionStatus
        let latestTurnState = signals.latestTurnState

        // Waiting covers sleep/wake and provider compaction (Claude reports
        // compacting as session waiting). Error/interrupted/stopped are terminal.
        switch sessionStatus {
        case "waiting", "error", "interrupted", "stopped", "idle", "ready":
            return false
        default:
            break
        }

        switch latestTurnState {
        case "error", "interrupted", "completed":
            if sessionStatus != "running", sessionStatus != "starting" {
                return false
            }
        default:
            break
        }

        let turnActive =
            sessionStatus == "running"
            || sessionStatus == "starting"
            || latestTurnState == "running"
        guard turnActive else { return false }

        if signals.hasActiveToolActivity { return false }
        if signals.hasActiveStreamingAssistant || signals.hasStreamingAssistantText {
            return false
        }
        if signals.hasVisibleReasoningText { return false }

        return true
    }
}
