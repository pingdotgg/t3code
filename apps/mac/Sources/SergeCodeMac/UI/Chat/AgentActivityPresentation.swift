import Foundation
import T3Kit

/// One pass over a thread's transcript collecting every signal the live-turn
/// chrome needs.
///
/// Both consumers — the parent-thinking gate and the activity dock — read
/// from this, so the timeline is walked once per render instead of once per
/// consumer. That matters: the walk happens inside `ChatTimelineScrollView`'s
/// body, which re-runs on every streaming delta.
struct TimelineActivityScan: Equatable, Sendable {
    /// The tool call the dock names while it runs.
    struct RunningTool: Equatable, Sendable {
        var id: String
        var name: String
        var detail: String
        var kind: ToolEventKind
        var startedAt: Date
    }

    /// Signals describing the turn currently in flight.
    ///
    /// These are nested, and reset wholesale on each user message, because
    /// every one of them answers "what is happening *right now*" while the
    /// transcript keeps plenty of evidence from turns that are long over:
    ///
    /// - a tool the provider never closed stays `.running` forever (the same
    ///   condition `ToolEventRow.displayState` defends against);
    /// - an assistant message interrupted mid-stream stays `isStreaming`;
    /// - reasoning rows are permanent transcript entries, so the worst case
    ///   is not even transient — one reasoning row would suppress the
    ///   thinking phase on that thread for good.
    ///
    /// Adding a field here gets the reset for free. Adding one to the outer
    /// scan does not, which is exactly how the leak above was introduced.
    struct Turn: Equatable, Sendable {
        var hasActiveToolActivity = false
        var hasActiveStreamingAssistant = false
        var hasStreamingAssistantText = false
        var hasVisibleReasoningText = false
        /// Latest-started running tool. Providers can have several in flight;
        /// the newest is the one a person reading the tail is waiting on.
        var runningTool: RunningTool?
        /// Ids of every tool still running this turn, in timeline order. The
        /// handoff tracker diffs consecutive scans of this to catch the exact
        /// render where a tool left the live dock for transcript history.
        var runningToolIDs: [String] = []
        /// Kinds of the last few tool calls, oldest first. Drives the dock's
        /// tape of what just happened.
        var recentToolKinds: [ToolEventKind] = []
        var toolCount = 0
        var completedToolCount = 0
    }

    /// The turn in flight.
    var turn = Turn()

    /// Whole-transcript, and correctly so: `AppModel.resolveInteraction`
    /// removes a decision card from the timeline the moment it is answered,
    /// so one that survives the scan is by definition still pending.
    var hasPendingApproval = false
    var hasPendingUserInput = false
    /// Timestamp of the newest transcript entry: when the transcript last
    /// said anything, which is when the current silence began.
    var lastItemAt: Date?

    /// Tape length. Five reads as "recent history" at a glance without
    /// turning into a second, worse transcript.
    static let recentToolTapeLength = 5

    /// Turn segmentation matches `TurnActivityProjection`: a user message
    /// opens a new turn and everything after it belongs to that turn.
    static func scan(items: [TimelineItem]) -> TimelineActivityScan {
        var scan = TimelineActivityScan()
        for item in items {
            switch item {
            case .userMessage(_, _, _, let at):
                // A new turn starts clean. Everything the previous turn left
                // behind — a tool still marked running, a half-streamed
                // message, its reasoning — describes work that is over.
                scan.turn = Turn()
                scan.note(at)
            case .toolEvent(let id, let name, let detail, let kind, let status, let at, _, _):
                scan.turn.toolCount += 1
                if status != .running {
                    scan.turn.completedToolCount += 1
                    scan.turn.recentToolKinds.append(kind)
                    if scan.turn.recentToolKinds.count > recentToolTapeLength {
                        scan.turn.recentToolKinds.removeFirst(
                            scan.turn.recentToolKinds.count - recentToolTapeLength)
                    }
                }
                if status == .running {
                    scan.turn.hasActiveToolActivity = true
                    scan.turn.runningToolIDs.append(id)
                    if scan.turn.runningTool.map({ at >= $0.startedAt }) ?? true {
                        scan.turn.runningTool = RunningTool(
                            id: id, name: name, detail: detail, kind: kind, startedAt: at)
                    }
                }
                scan.note(at)
            // `hasVisibleContent` rather than `trimmingCharacters(…).isEmpty`
            // throughout: this walk runs inside `ChatTimelineScrollView`'s
            // body, so it repeats on every streaming delta, and trimming
            // allocated a full copy of every assistant message and every
            // reasoning row in the transcript each time. The check stops at
            // the first non-whitespace character instead.
            case .assistantMessage(_, let markdown, let isStreaming, let at):
                if isStreaming {
                    scan.turn.hasActiveStreamingAssistant = true
                    if markdown.hasVisibleContent {
                        scan.turn.hasStreamingAssistantText = true
                    }
                }
                scan.note(at)
            case .reasoning(_, let text, let at):
                if text.hasVisibleContent {
                    scan.turn.hasVisibleReasoningText = true
                }
                scan.note(at)
            case .approval(let request):
                scan.hasPendingApproval = true
                scan.note(request.createdAt)
            case .userInput(let request):
                scan.hasPendingUserInput = true
                scan.note(request.createdAt)
            default:
                scan.note(item.at)
            }
        }
        return scan
    }

    /// Timeline arrays are chronological, but deltas can land slightly out of
    /// order, so take the max rather than trusting the last entry.
    private mutating func note(_ date: Date?) {
        guard let date else { return }
        if let current = lastItemAt {
            lastItemAt = Swift.max(current, date)
        } else {
            lastItemAt = date
        }
    }
}

/// What the live-turn dock says the agent is doing right now.
enum AgentActivityPhase: Equatable, Sendable {
    /// The model is reasoning and has produced nothing visible yet.
    case thinking
    /// A parent-thread tool call is in flight.
    case tool(TimelineActivityScan.RunningTool)
    /// `session.health` reports the turn as stalled.
    case stalled
}

/// The live-turn dock's whole input.
struct AgentActivity: Equatable, Sendable {
    var phase: AgentActivityPhase
    /// When this phase began; drives the elapsed clock.
    var since: Date?
    /// Recent tool kinds this turn, oldest first.
    var recentToolKinds: [ToolEventKind]
    /// Tool calls this turn.
    var toolCount: Int
    /// Terminal tool calls already promoted into transcript history.
    var completedToolCount: Int
}

/// Pure policy behind `AgentActivityDock`: when it shows, what it says, and
/// which glyph it wears. Free of SwiftUI so the rules are directly testable.
enum AgentActivityPresentation {
    static func activity(
        threadStatus: ThreadStatus?,
        isStalled: Bool,
        items: [TimelineItem]
    ) -> AgentActivity? {
        activity(
            threadStatus: threadStatus, isStalled: isStalled,
            scan: TimelineActivityScan.scan(items: items))
    }

    /// The dock exists to fill the gaps where the transcript says nothing. It
    /// therefore stays out of the way whenever something else on screen is
    /// already the answer:
    ///
    /// - a pending approval or input request is the content, and it is
    ///   waiting on a person rather than the model;
    /// - streaming assistant prose and visible reasoning text are content
    ///   arriving, and a second animated status beside them is noise
    ///   (`ParentThinking` already encodes this rule, shared with the web
    ///   client — the thinking branch defers to it rather than restating it);
    /// - a settled thread has nothing in flight to narrate.
    static func activity(
        threadStatus: ThreadStatus?,
        isStalled: Bool,
        scan: TimelineActivityScan
    ) -> AgentActivity? {
        if scan.hasPendingApproval || scan.hasPendingUserInput { return nil }
        switch threadStatus {
        case .waitingApproval, .waitingInput: return nil
        case .none: return nil
        case .some(let status) where status.isSettled: return nil
        default: break
        }

        let phase: AgentActivityPhase
        let since: Date?
        if isStalled {
            phase = .stalled
            since = scan.lastItemAt
        } else if let tool = scan.turn.runningTool {
            // A running tool outranks the thinking gate: `ParentThinking`
            // suppresses itself while a tool runs precisely because that case
            // used to have no home. It has one now.
            phase = .tool(tool)
            since = tool.startedAt
        } else if ParentThinking.shouldShow(
            ParentThinkingPresentation.signals(
                threadStatus: threadStatus, isStalled: isStalled, scan: scan))
        {
            phase = .thinking
            since = scan.lastItemAt
        } else {
            return nil
        }

        return AgentActivity(
            phase: phase,
            since: since,
            recentToolKinds: scan.turn.recentToolKinds,
            toolCount: scan.turn.toolCount,
            completedToolCount: scan.turn.completedToolCount)
    }

    // MARK: - Copy

    /// Label for a phase. `subject` is the caller's already-parsed detail
    /// (command text, short file path, tool name); the view resolves it
    /// through `ToolDetailParseCache` so this stays a pure string function.
    static func label(
        phase: AgentActivityPhase,
        subject: String?,
        elapsed: TimeInterval
    ) -> String {
        switch phase {
        case .stalled:
            return "Waiting on the model"
        case .thinking:
            return thinkingLabel(elapsed: elapsed)
        case .tool(let tool):
            return toolLabel(kind: tool.kind, name: tool.name, subject: clip(subject))
        }
    }

    /// A silent minute reads as a hang unless the label admits it is still
    /// going. Escalating the wording is the cheapest reassurance there is —
    /// and it keeps the dock from looking frozen next to a moving orb.
    static func thinkingLabel(elapsed: TimeInterval) -> String {
        switch elapsed {
        case ..<20: "Thinking"
        case ..<60: "Still thinking"
        case ..<180: "Thinking it through"
        default: "Deep in thought"
        }
    }

    static func toolLabel(kind: ToolEventKind, name: String, subject: String?) -> String {
        switch kind {
        case .command:
            return subject.map { "Running \($0)" } ?? "Running a command"
        case .fileChange:
            return subject.map { "Editing \($0)" } ?? "Editing files"
        case .fileRead:
            return subject.map { "Reading \($0)" } ?? "Reading files"
        case .webSearch:
            return subject.map { "Searching for \($0)" } ?? "Searching the web"
        case .mcpCall:
            return "Calling \(subject ?? fallbackName(name, default: "a tool"))"
        case .skill:
            return "Running the \(subject ?? fallbackName(name, default: "skill")) skill"
        case .computerUse:
            return "Driving the computer"
        case .subagent:
            return "Delegating to \(subject ?? fallbackName(name, default: "a subagent"))"
        case .imageView:
            return subject.map { "Looking at \($0)" } ?? "Looking at an image"
        case .other:
            return subject.map { "Working on \($0)" }
                ?? "Running \(fallbackName(name, default: "a tool"))"
        }
    }

    /// Glyph in the middle of the orb. Tool phases borrow the same symbol the
    /// transcript's activity chip uses, so the dock and the row that produced
    /// it read as one thing.
    static func symbolName(for phase: AgentActivityPhase) -> String {
        switch phase {
        case .thinking: "sparkles"
        case .stalled: "hourglass"
        case .tool(let tool): tool.kind.activitySymbolName
        }
    }

    /// Secondary context for the live surface. This changes with the phase,
    /// but stays quieter than the primary verb so the card remains scannable.
    static func contextLabel(phase: AgentActivityPhase, completedToolCount: Int) -> String {
        switch phase {
        case .thinking:
            if completedToolCount == 0 { return "Working through the next step" }
            return completedSummary(completedToolCount)
        case .tool:
            if completedToolCount == 0 { return "In progress · moves to the thread when complete" }
            return "\(completedSummary(completedToolCount)) · current action in progress"
        case .stalled:
            return "No activity received — still listening"
        }
    }

    /// Screen-reader text. Deliberately plainer than the visible label: the
    /// escalating thinking copy is visual reassurance, not information, and
    /// re-announcing "still thinking" every few seconds would be noise on a
    /// row already marked `updatesFrequently`.
    static func accessibilityLabel(phase: AgentActivityPhase, subject: String?) -> String {
        switch phase {
        case .thinking:
            return "Agent is thinking"
        case .stalled:
            return "Agent is stalled, waiting on the model"
        case .tool(let tool):
            let label = toolLabel(kind: tool.kind, name: tool.name, subject: clip(subject))
            return "Agent is " + label.prefix(1).lowercased() + label.dropFirst()
        }
    }

    // MARK: - Helpers

    /// One-line cap for the subject. A dock label is a glance, not a log line,
    /// and an unbounded command string would push the elapsed clock off the
    /// row on a narrow window.
    static let maxSubjectLength = 48

    static func clip(_ subject: String?) -> String? {
        guard let trimmed = subject?.trimmingCharacters(in: .whitespacesAndNewlines),
            !trimmed.isEmpty
        else { return nil }
        let firstLine = trimmed.split(
            separator: "\n", maxSplits: 1, omittingEmptySubsequences: true
        ).first.map(String.init) ?? trimmed
        guard firstLine.count > maxSubjectLength else { return firstLine }
        return firstLine.prefix(maxSubjectLength - 1).trimmingCharacters(in: .whitespaces) + "…"
    }

    private static func fallbackName(_ name: String, default fallback: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : trimmed
    }

    private static func completedSummary(_ count: Int) -> String {
        "\(count) completed \(count == 1 ? "action" : "actions") this turn"
    }
}
