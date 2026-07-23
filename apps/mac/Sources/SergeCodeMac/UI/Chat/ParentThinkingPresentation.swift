import Foundation
import T3Kit

/// Derives parent-thinking signals from the mac timeline + projected thread
/// status. Keeps the pure `ParentThinking` gate free of UI types.
enum ParentThinkingPresentation {
    static func signals(
        threadStatus: ThreadStatus?,
        isStalled: Bool,
        items: [TimelineItem]
    ) -> ParentThinkingSignals {
        var hasActiveToolActivity = false
        var hasActiveStreamingAssistant = false
        var hasStreamingAssistantText = false
        var hasVisibleReasoningText = false
        var hasPendingApproval = threadStatus == .waitingApproval
        var hasPendingUserInput = false

        for item in items {
            switch item {
            case .toolEvent(_, _, _, _, let status, _, _, _):
                if status == .running {
                    hasActiveToolActivity = true
                }
            case .assistantMessage(_, let markdown, let isStreaming, _):
                if isStreaming {
                    hasActiveStreamingAssistant = true
                    if !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        hasStreamingAssistantText = true
                    }
                }
            case .reasoning(_, let text, _):
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    hasVisibleReasoningText = true
                }
            case .approval:
                hasPendingApproval = true
            case .userInput:
                hasPendingUserInput = true
            default:
                break
            }
        }

        // Projected ThreadStatus folds session + turn. Map back to the wire
        // session vocabulary `ParentThinking` understands.
        let sessionStatus: String?
        let latestTurnState: String?
        switch threadStatus {
        case .running:
            sessionStatus = "running"
            latestTurnState = "running"
        case .waiting:
            sessionStatus = "waiting"
            latestTurnState = nil
        case .waitingApproval:
            // Still an active turn, but approval wins via hasPendingApproval.
            sessionStatus = "running"
            latestTurnState = "running"
            hasPendingApproval = true
        case .error:
            sessionStatus = "error"
            latestTurnState = "error"
        case .backgroundWork:
            // Only subagents are active; parent is not reasoning.
            sessionStatus = "idle"
            latestTurnState = nil
        case .idle, .archived, .settled, nil:
            sessionStatus = "idle"
            latestTurnState = nil
        }

        return ParentThinkingSignals(
            sessionStatus: sessionStatus,
            latestTurnState: latestTurnState,
            hasPendingApproval: hasPendingApproval,
            hasPendingUserInput: hasPendingUserInput,
            isStalled: isStalled,
            hasActiveToolActivity: hasActiveToolActivity,
            hasActiveStreamingAssistant: hasActiveStreamingAssistant,
            hasStreamingAssistantText: hasStreamingAssistantText,
            hasVisibleReasoningText: hasVisibleReasoningText)
    }

    static func shouldShow(
        threadStatus: ThreadStatus?,
        isStalled: Bool,
        items: [TimelineItem]
    ) -> Bool {
        ParentThinking.shouldShow(
            signals(threadStatus: threadStatus, isStalled: isStalled, items: items))
    }
}
