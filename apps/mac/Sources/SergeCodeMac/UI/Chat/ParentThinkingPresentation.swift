import Foundation
import T3Kit

/// Derives parent-thinking signals from the mac timeline + projected thread
/// status. Keeps the pure `ParentThinking` gate free of UI types.
///
/// The transcript walk itself lives in `TimelineActivityScan`, shared with
/// `AgentActivityPresentation`: both gates need the same signals, and the
/// walk runs inside a body that re-executes on every streaming delta.
enum ParentThinkingPresentation {
    static func signals(
        threadStatus: ThreadStatus?,
        isStalled: Bool,
        items: [TimelineItem]
    ) -> ParentThinkingSignals {
        signals(
            threadStatus: threadStatus, isStalled: isStalled,
            scan: TimelineActivityScan.scan(items: items))
    }

    static func signals(
        threadStatus: ThreadStatus?,
        isStalled: Bool,
        scan: TimelineActivityScan
    ) -> ParentThinkingSignals {
        var hasPendingApproval = scan.hasPendingApproval || threadStatus == .waitingApproval
        var hasPendingUserInput = scan.hasPendingUserInput

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
            sessionStatus = "running"
            latestTurnState = "running"
            hasPendingApproval = true
        case .waitingInput:
            sessionStatus = "running"
            latestTurnState = "running"
            hasPendingUserInput = true
        case .error:
            sessionStatus = "error"
            latestTurnState = "error"
        case .backgroundWork, .reviewing, .fixing:
            // Only subagents/auto-review are active; parent is not reasoning.
            sessionStatus = "idle"
            latestTurnState = nil
        case .idle, .archived, .settled, .done, .readyToMerge, nil:
            sessionStatus = "idle"
            latestTurnState = nil
        }

        return ParentThinkingSignals(
            sessionStatus: sessionStatus,
            latestTurnState: latestTurnState,
            hasPendingApproval: hasPendingApproval,
            hasPendingUserInput: hasPendingUserInput,
            isStalled: isStalled,
            hasActiveToolActivity: scan.hasActiveToolActivity,
            hasActiveStreamingAssistant: scan.hasActiveStreamingAssistant,
            hasStreamingAssistantText: scan.hasStreamingAssistantText,
            hasVisibleReasoningText: scan.hasVisibleReasoningText)
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
