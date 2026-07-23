import Foundation

/// Notifiable agent lifecycle moments — mirrors mobile agent-awareness
/// phases that interrupt the user (finish / stall / approval / question).
public enum AgentNotificationKind: String, Sendable, CaseIterable, Identifiable {
    case finished
    case stalled
    case needsApproval
    case needsInput
    case failed

    public var id: String { rawValue }

    public var settingsLabel: String {
        switch self {
        case .finished: "When an agent finishes"
        case .stalled: "When an agent appears stalled"
        case .needsApproval: "When an agent needs approval"
        case .needsInput: "When an agent asks a question"
        case .failed: "When an agent fails"
        }
    }

    public var settingsHelp: String {
        switch self {
        case .finished:
            "Notify when a turn settles so you can review the result."
        case .stalled:
            "Notify when the server reports no provider activity for a running turn."
        case .needsApproval:
            "Notify when the agent needs permission to continue (tools, plans)."
        case .needsInput:
            "Notify when the agent asks a question that needs your answer."
        case .failed:
            "Notify when a turn or session ends in an error."
        }
    }
}

/// Pure decision helpers for macOS local agent notifications.
///
/// Delivery policy (like Cursor / Claude Code desktop apps):
/// - Never fire on first observation of a thread (no spam after reconnect).
/// - Suppress when the user is already looking at that thread and the app is
///   frontmost (sidebar/in-thread UI already surfaces the state).
/// - Fire once per transition into a notifiable state.
public enum AgentNotificationPolicy {
    public struct ThreadSnapshot: Equatable, Sendable {
        public var status: ThreadStatus
        public var isStalled: Bool

        public init(status: ThreadStatus, isStalled: Bool) {
            self.status = status
            self.isStalled = isStalled
        }

        public init(_ thread: ChatThread) {
            self.status = thread.status
            self.isStalled = thread.isStalled
        }
    }

    public struct DeliveryContext: Equatable, Sendable {
        public var isAppActive: Bool
        public var isThreadSelected: Bool

        public init(isAppActive: Bool, isThreadSelected: Bool) {
            self.isAppActive = isAppActive
            self.isThreadSelected = isThreadSelected
        }
    }

    /// Status/health transitions that should produce a notification.
    /// Approval and user-input requests also arrive as dedicated events and
    /// are evaluated separately so titles can stay specific.
    public static func statusTransitionKind(
        previous: ThreadSnapshot?,
        next: ThreadSnapshot
    ) -> AgentNotificationKind? {
        guard let previous else { return nil }

        // Stall is orthogonal to status: a running turn can flip stalled
        // without leaving `.running`. Prefer stall over completion when both
        // somehow change in one snapshot (should not happen in practice).
        if !previous.isStalled && next.isStalled {
            return .stalled
        }

        if previous.status != next.status {
            switch next.status {
            case .error:
                return .failed
            case .idle, .settled:
                if isActivelyWorking(previous.status) {
                    return .finished
                }
            case .waitingApproval:
                // Covers both permission prompts and user-input questions at
                // the shell level. Dedicated events refine the copy when
                // available; this is the reconnect/snapshot fallback.
                if previous.status != .waitingApproval {
                    return .needsApproval
                }
            case .running, .waiting, .backgroundWork, .archived:
                break
            }
        }
        return nil
    }

    /// Whether a computed kind should actually be presented given preferences
    /// and focus. Pure so tests do not need AppKit.
    public static func shouldDeliver(
        kind: AgentNotificationKind,
        masterEnabled: Bool,
        enabledKinds: Set<AgentNotificationKind>,
        context: DeliveryContext
    ) -> Bool {
        guard masterEnabled, enabledKinds.contains(kind) else { return false }
        // Looking at the thread in a frontmost window is enough signal;
        // bounce/banner would only distract.
        if context.isAppActive && context.isThreadSelected {
            return false
        }
        return true
    }

    public static func notificationTitle(
        kind: AgentNotificationKind,
        threadTitle: String
    ) -> String {
        let label = threadTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = label.isEmpty ? "Agent" : label
        switch kind {
        case .finished: return "\(name) finished"
        case .stalled: return "\(name) may be stalled"
        case .needsApproval: return "\(name) needs approval"
        case .needsInput: return "\(name) has a question"
        case .failed: return "\(name) failed"
        }
    }

    public static func notificationBody(
        kind: AgentNotificationKind,
        projectName: String?,
        detail: String? = nil
    ) -> String {
        if let detail = detail?.trimmingCharacters(in: .whitespacesAndNewlines), !detail.isEmpty {
            return detail
        }
        let project = projectName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let projectSuffix: String
        if let project, !project.isEmpty {
            projectSuffix = " · \(project)"
        } else {
            projectSuffix = ""
        }
        switch kind {
        case .finished:
            return "Review the completed turn\(projectSuffix)."
        case .stalled:
            return "No recent provider activity\(projectSuffix)."
        case .needsApproval:
            return "Permission needed to continue\(projectSuffix)."
        case .needsInput:
            return "Your answer is needed to continue\(projectSuffix)."
        case .failed:
            return "The agent hit an error\(projectSuffix)."
        }
    }

    public static func isActivelyWorking(_ status: ThreadStatus) -> Bool {
        switch status {
        case .running, .waiting, .waitingApproval, .backgroundWork:
            return true
        case .idle, .error, .archived, .settled:
            return false
        }
    }
}
