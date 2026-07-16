import Foundation

// UI-level domain model. T3Kit maps wire types into these; MockBackend fakes
// them. Keep UI code independent of wire-shape churn.

public enum ProviderKind: String, Codable, CaseIterable, Sendable, Identifiable {
    case claude, claudeWork, claudex, claudeSynthero, codex, grok, fugu
    /// Decodes persisted threads created by the removed Cursor provider. This
    /// case is intentionally excluded from `allCases` so it is never offered
    /// for new sessions.
    case legacyCursor = "cursor"

    public static let allCases: [ProviderKind] = [
        .claude, .claudeWork, .claudex, .claudeSynthero, .codex, .grok, .fugu,
    ]

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .claude: "Claude Code"
        case .claudeWork: "Claude Work"
        case .claudex: "Claudex"
        case .claudeSynthero: "Claude Synthero"
        case .codex: "Codex"
        case .grok: "Grok"
        case .fugu: "Fugu"
        case .legacyCursor: "Cursor (Unsupported)"
        }
    }
}

public struct Project: Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var path: String
    /// Stable repository identity supplied by the server when available.
    /// The macOS sidebar uses this to present one project across local and
    /// remote backends without coupling UI entities to T3Kit wire models.
    public var repositoryKey: String?

    public init(id: String, name: String, path: String, repositoryKey: String? = nil) {
        self.id = id
        self.name = name
        self.path = path
        self.repositoryKey = repositoryKey
    }
}

public enum ThreadStatus: String, Sendable {
    case idle, running, waiting, waitingApproval, backgroundWork, error, archived

    public var isSettled: Bool {
        switch self {
        case .idle, .archived, .error: true
        case .running, .waiting, .waitingApproval, .backgroundWork: false
        }
    }
}

/// UI mirror of the wire `RuntimeMode` (how much the agent may do unprompted).
public enum ThreadRuntimeMode: String, CaseIterable, Sendable, Identifiable {
    case approvalRequired, autoAcceptEdits, fullAccess
    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .approvalRequired: "Approvals required"
        case .autoAcceptEdits: "Auto-accept edits"
        case .fullAccess: "Full access"
        }
    }

    public var symbolName: String {
        switch self {
        case .approvalRequired: "hand.raised"
        case .autoAcceptEdits: "pencil.circle"
        case .fullAccess: "bolt.circle"
        }
    }
}

/// UI mirror of the wire `ProviderInteractionMode` (how the agent engages with
/// the request: do it, plan it, or advise on it).
public enum ThreadInteractionMode: String, CaseIterable, Sendable, Identifiable {
    case normal, plan, advisor
    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .normal: "Default"
        case .plan: "Plan"
        case .advisor: "Advisor/Planner"
        }
    }

    public var symbolName: String {
        switch self {
        case .normal: "text.bubble"
        case .plan: "list.clipboard"
        case .advisor: "lightbulb.max"
        }
    }

    public var helpText: String {
        switch self {
        case .normal: "The agent does the work."
        case .plan: "The agent proposes a plan instead of editing."
        case .advisor:
            "The agent plans and advises rather than editing itself. With an executor model configured it may delegate implementation to sub-agents; otherwise it advises only. Workspace permissions follow the access setting."
        }
    }
}

/// One selectable reasoning-effort level of a model (from the wire's
/// select-type provider option descriptor, e.g. `effort`/`reasoningEffort`).
public struct EffortChoice: Identifiable, Hashable, Sendable {
    /// Wire choice id, e.g. "high", "max", "ultrathink".
    public var id: String
    public var label: String
    public var isDefault: Bool

    public init(id: String, label: String, isDefault: Bool) {
        self.id = id
        self.label = label
        self.isDefault = isDefault
    }
}

/// One selectable model of one provider instance (model picker rows).
public struct ModelOption: Identifiable, Hashable, Sendable {
    public var instanceID: String
    public var modelID: String
    public var displayName: String
    public var provider: ProviderKind
    public var isDefault: Bool
    /// Wire id of the model's reasoning-effort option descriptor
    /// ("effort", "reasoningEffort", …); nil when the model has none.
    public var effortOptionID: String?
    public var effortChoices: [EffortChoice]
    /// Wire id of the model's service-tier option descriptor ("serviceTier");
    /// nil when the model has none.
    public var serviceTierOptionID: String?
    public var serviceTierChoices: [EffortChoice]

    public var id: String { "\(instanceID)/\(modelID)" }

    public init(
        instanceID: String, modelID: String, displayName: String, provider: ProviderKind,
        isDefault: Bool, effortOptionID: String? = nil, effortChoices: [EffortChoice] = [],
        serviceTierOptionID: String? = nil, serviceTierChoices: [EffortChoice] = []
    ) {
        self.instanceID = instanceID
        self.modelID = modelID
        self.displayName = displayName
        self.provider = provider
        self.isDefault = isDefault
        self.effortOptionID = effortOptionID
        self.effortChoices = effortChoices
        self.serviceTierOptionID = serviceTierOptionID
        self.serviceTierChoices = serviceTierChoices
    }
}

/// Server-authoritative liveness for a thread's active provider turn (from
/// `session.health` activities, all providers). `nil` means the server has not
/// reported health for this thread, so any client-side stall heuristic applies.
/// A stalled signal is authoritative; an active signal suppresses the heuristic
/// only while its activity timestamp is fresh.
public struct ThreadHealth: Hashable, Sendable {
    public var stalled: Bool
    public var lastActivityAt: Date
    /// When the current stall began; `nil` unless `stalled`.
    public var stalledSince: Date?

    public init(stalled: Bool, lastActivityAt: Date, stalledSince: Date? = nil) {
        self.stalled = stalled
        self.lastActivityAt = lastActivityAt
        self.stalledSince = stalledSince
    }
}

public struct ChatThread: Identifiable, Hashable, Sendable {
    public var id: String
    public var projectID: String
    public var title: String
    public var provider: ProviderKind
    public var status: ThreadStatus
    public var updatedAt: Date
    public var runtimeMode: ThreadRuntimeMode
    public var interactionMode: ThreadInteractionMode
    /// Provider-instance + model slug backing this thread (from its
    /// modelSelection); used to mark the active row in the model picker.
    public var modelInstanceID: String?
    public var modelID: String?
    /// Advisor/Planner executor model (instance + slug); nil means advise only.
    public var executorModelInstanceID: String?
    public var executorModelID: String?
    /// Explicit reasoning-effort choice id from the thread's modelSelection
    /// options; nil means the provider default applies.
    public var reasoningEffort: String?
    /// Explicit service-tier choice id from the thread's modelSelection
    /// options; nil means the provider default applies.
    public var serviceTier: String?
    /// Active delegated/background task count. Used for sidebar accessibility
    /// when `status == .backgroundWork`; zero for ordinary thread states.
    public var backgroundAgentCount: Int
    /// Server turn liveness (`session.health`); `nil` until the server reports
    /// it. Stalled and fresh-active signals override the client-side heuristic.
    public var health: ThreadHealth?

    /// True when the server has reported this thread's active turn as stalled.
    public var isStalled: Bool { health?.stalled ?? false }

    public init(
        id: String, projectID: String, title: String, provider: ProviderKind,
        status: ThreadStatus, updatedAt: Date,
        runtimeMode: ThreadRuntimeMode = .fullAccess,
        interactionMode: ThreadInteractionMode = .normal,
        modelInstanceID: String? = nil, modelID: String? = nil,
        executorModelInstanceID: String? = nil, executorModelID: String? = nil,
        reasoningEffort: String? = nil, serviceTier: String? = nil,
        backgroundAgentCount: Int = 0, health: ThreadHealth? = nil
    ) {
        self.id = id
        self.projectID = projectID
        self.title = title
        self.provider = provider
        self.status = status
        self.updatedAt = updatedAt
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
        self.modelInstanceID = modelInstanceID
        self.modelID = modelID
        self.executorModelInstanceID = executorModelInstanceID
        self.executorModelID = executorModelID
        self.reasoningEffort = reasoningEffort
        self.serviceTier = serviceTier
        self.backgroundAgentCount = backgroundAgentCount
        self.health = health
    }

    /// True when every stored property except `updatedAt` matches. Used by
    /// AppModel to suppress sidebar array rewrites on activity-only bumps.
    public func displayEquivalent(to other: ChatThread) -> Bool {
        id == other.id
            && projectID == other.projectID
            && title == other.title
            && provider == other.provider
            && status == other.status
            && runtimeMode == other.runtimeMode
            && interactionMode == other.interactionMode
            && modelInstanceID == other.modelInstanceID
            && modelID == other.modelID
            && executorModelInstanceID == other.executorModelInstanceID
            && executorModelID == other.executorModelID
            && reasoningEffort == other.reasoningEffort
            && serviceTier == other.serviceTier
            && health == other.health
    }
}

public enum ToolEventStatus: String, Sendable {
    case running, succeeded, failed
}

/// Broad category of a tool invocation, folded from the wire `itemType`
/// (ProviderRuntimeIngestion.ts); drives the row icon and how the detail
/// body renders (command line vs file diff vs plain text).
public enum ToolEventKind: String, Sendable {
    case command, fileChange, fileRead, webSearch, mcpCall, skill, computerUse, subagent,
        imageView, other

    /// `family` is the tool's identity family (`payload.data.tool.family`,
    /// stamped by the server for every provider). It wins over `itemType`:
    /// skills and computer-use calls arrive as generic tool item types, so
    /// item type alone cannot tell them apart from any other dynamic call.
    public init(itemType: String?, family: String? = nil) {
        switch family {
        case "skill":
            self = .skill
            return
        case "computer_use":
            self = .computerUse
            return
        case "mcp":
            self = .mcpCall
            return
        default:
            break
        }
        switch itemType {
        case "command_execution": self = .command
        case "file_change": self = .fileChange
        case "file_read": self = .fileRead
        case "web_search": self = .webSearch
        case "mcp_tool_call": self = .mcpCall
        case "collab_agent_tool_call": self = .subagent
        case "image_view": self = .imageView
        default: self = .other
        }
    }
}

public enum SubagentTaskState: String, Sendable {
    case running, paused, completed, failed, stopped
}

public struct SubagentTaskProgressEntry: Hashable, Sendable {
    public var at: Date
    public var toolName: String?
    public var text: String

    public init(at: Date, toolName: String?, text: String) {
        self.at = at
        self.toolName = toolName
        self.text = text
    }
}

public struct SubagentTaskItem: Hashable, Sendable {
    public var taskId: String
    public var taskType: String?
    public var description: String?
    public var subagentType: String?
    public var model: String?
    /// Reasoning effort the subagent's turns run at (e.g. "high"), when known.
    public var effort: String?
    public var workflowName: String?
    public var toolUseId: String?
    public var state: SubagentTaskState
    public var latestProgress: String?
    public var lastToolName: String?
    public var usageSummary: String?
    public var isBackgrounded: Bool
    public var error: String?
    public var startedAt: Date
    public var lastActivityAt: Date
    public var duration: TimeInterval?
    /// Ordered progress updates (oldest first). Empty when no progress has
    /// been streamed yet.
    public var progressLog: [SubagentTaskProgressEntry]

    public var id: String { "subagent-task:\(taskId)" }

    public init(
        taskId: String,
        taskType: String?,
        description: String?,
        subagentType: String? = nil,
        model: String? = nil,
        effort: String? = nil,
        workflowName: String? = nil,
        toolUseId: String? = nil,
        state: SubagentTaskState,
        latestProgress: String?,
        lastToolName: String? = nil,
        usageSummary: String? = nil,
        isBackgrounded: Bool = false,
        error: String? = nil,
        startedAt: Date,
        lastActivityAt: Date? = nil,
        duration: TimeInterval?,
        progressLog: [SubagentTaskProgressEntry] = []
    ) {
        self.taskId = taskId
        self.taskType = taskType
        self.description = description
        self.subagentType = subagentType
        self.model = model
        self.effort = effort
        self.workflowName = workflowName
        self.toolUseId = toolUseId
        self.state = state
        self.latestProgress = latestProgress
        self.lastToolName = lastToolName
        self.usageSummary = usageSummary
        self.isBackgrounded = isBackgrounded
        self.error = error
        self.startedAt = startedAt
        self.lastActivityAt = lastActivityAt ?? startedAt
        self.duration = duration
        self.progressLog = progressLog
    }
}

public struct UsageLimitNotice: Identifiable, Hashable, Sendable {
    public var id: String
    public var threadID: String
    public var provider: ProviderKind?
    public var providerName: String
    public var message: String
    public var resetsAt: Date?
    public var createdAt: Date

    public init(
        id: String, threadID: String, provider: ProviderKind?, providerName: String,
        message: String, resetsAt: Date?, createdAt: Date
    ) {
        self.id = id
        self.threadID = threadID
        self.provider = provider
        self.providerName = providerName
        self.message = message
        self.resetsAt = resetsAt
        self.createdAt = createdAt
    }
}

public enum UsageLimitActionState: Equatable, Sendable {
    case idle
    case waiting(resumeAt: Date)
    case resuming
    case switching(modelName: String)
    case continued
    case failed(String)
}

/// `Equatable` is load-bearing for render cost, not just convenience: the
/// display cache uses it to reuse untouched rows across a streaming refresh,
/// and `ChatTimelineRowView` uses it to skip re-rendering rows whose content
/// did not change. Every payload is `Hashable`, so the conformance is
/// synthesized.
public enum TimelineItem: Identifiable, Equatable, Sendable {
    case userMessage(id: String, text: String, at: Date)
    case assistantMessage(id: String, markdown: String, isStreaming: Bool, at: Date)
    /// `output` is the tool's result text when available (command stdout,
    /// etc.); `outputIsError` is true for Claude tool_result errors.
    case toolEvent(
        id: String, name: String, detail: String, kind: ToolEventKind,
        status: ToolEventStatus, at: Date, output: String?, outputIsError: Bool)
    case approval(ApprovalRequest)
    case userInput(UserInputRequest)
    case usageLimit(UsageLimitNotice)
    case checkpoint(Checkpoint)
    case plan(ProposedPlan)
    case notice(id: String, text: String, at: Date)
    /// Streaming task/reasoning progress; the id is stable across updates of
    /// the same task, so new text replaces the row instead of stacking.
    case reasoning(id: String, text: String, at: Date)
    case subagentTask(SubagentTaskItem)
    /// A provider CLI process died leaving captured stderr. Error-styled row
    /// with an expandable "process output" disclosure (`session.exited`).
    case sessionExit(id: String, summary: String, stderrTail: String, at: Date)

    public var id: String {
        switch self {
        case .userMessage(let id, _, _): id
        case .assistantMessage(let id, _, _, _): id
        case .toolEvent(let id, _, _, _, _, _, _, _): id
        case .approval(let request): request.id
        case .userInput(let request): request.id
        case .usageLimit(let notice): notice.id
        case .checkpoint(let checkpoint): checkpoint.id
        case .plan(let plan): plan.id
        case .notice(let id, _, _): id
        case .reasoning(let id, _, _): id
        case .subagentTask(let item): item.id
        case .sessionExit(let id, _, _, _): id
        }
    }

    /// The backend event time used to place this item in the transcript.
    /// Interactive items carry their creation time on the nested request or
    /// entity; a subagent row starts at the task's start time.
    public var at: Date? {
        switch self {
        case .userMessage(_, _, let at): at
        case .assistantMessage(_, _, _, let at): at
        case .toolEvent(_, _, _, _, _, let at, _, _): at
        case .approval(let request): request.createdAt
        case .userInput(let request): request.createdAt
        case .usageLimit(let notice): notice.createdAt
        case .checkpoint(let checkpoint): checkpoint.createdAt
        case .plan(let plan): plan.createdAt
        case .notice(_, _, let at): at
        case .reasoning(_, _, let at): at
        case .subagentTask(let item): item.startedAt
        case .sessionExit(_, _, _, let at): at
        }
    }
}

extension Array where Element == TimelineItem {
    /// True once the agent has finished at least one answer here. A chat that
    /// has never answered is not a chat with work to follow up on, so the
    /// follow-up suggestions stay quiet until it has.
    public var hasCompletedAssistantMessage: Bool {
        contains {
            if case .assistantMessage(_, _, let isStreaming, _) = $0 { return !isStreaming }
            return false
        }
    }

    /// Coalescing append: an item whose id already exists replaces that row
    /// in place (tool lifecycle updates, streaming reasoning text) instead of
    /// stacking a duplicate. A tool row without a correlation id still folds
    /// into the trailing running row when it is plainly the same invocation
    /// (mirrors the web client's consecutive-merge in session-logic.ts):
    /// same name plus same detail, or a correlated row followed by an
    /// uncorrelated event of the same name. Two uncorrelated tools that
    /// merely share a name stay separate rows.
    public mutating func upsertTimelineItem(_ item: TimelineItem) {
        if let index = lastIndex(where: { $0.id == item.id }) {
            let existing = self[index]
            self[index] = item
                .preservingToolMetadata(of: existing)
                .preservingFirstLifecycleTimestamp(of: existing)
            return
        }
        // Searches backwards past interleaved rows (reasoning updates land
        // between a tool's start and its completion), not just `last` —
        // otherwise the completion appends a duplicate and the original row
        // is stuck "running" forever. Bounded at the current turn: crossing
        // a user message (or checkpoint, which marks a turn end) could fold
        // a fresh same-name invocation into a stale row from an old turn.
        if case .toolEvent(let id, let name, let detail, _, _, _, _, _) = item {
            search: for index in indices.reversed() {
                switch self[index] {
                case .userMessage, .checkpoint:
                    break search
                case .toolEvent(
                    let existingID, let existingName, let existingDetail, _, .running, _, _, _)
                where existingName == name
                    && (existingDetail == detail
                        || (existingID.hasPrefix("tool:") && !id.hasPrefix("tool:"))):
                    let existing = self[index]
                    self[index] = item
                        .preservingToolMetadata(of: existing)
                        .preservingFirstLifecycleTimestamp(of: existing)
                    return
                default:
                    continue
                }
            }
        }
        append(item)
    }

    /// Indexed variant of `upsertTimelineItem` for hot paths that repeatedly
    /// update one timeline. The index is validated before use so callers can
    /// safely reuse it across staged mutations.
    public mutating func upsertTimelineItem(
        _ item: TimelineItem, indexByID: inout [String: Int]
    ) {
        if let cachedIndex = indexByID[item.id], indices.contains(cachedIndex),
            self[cachedIndex].id == item.id
        {
            let existing = self[cachedIndex]
            self[cachedIndex] = item
                .preservingToolMetadata(of: existing)
                .preservingFirstLifecycleTimestamp(of: existing)
            return
        }
        if let index = lastIndex(where: { $0.id == item.id }) {
            indexByID[item.id] = index
            let existing = self[index]
            self[index] = item
                .preservingToolMetadata(of: existing)
                .preservingFirstLifecycleTimestamp(of: existing)
            return
        }
        // Searches backwards past interleaved rows (reasoning updates land
        // between a tool's start and its completion), not just `last` —
        // otherwise the completion appends a duplicate and the original row
        // is stuck "running" forever. Bounded at the current turn: crossing
        // a user message (or checkpoint, which marks a turn end) could fold
        // a fresh same-name invocation into a stale row from an old turn.
        if case .toolEvent(let id, let name, let detail, _, _, _, _, _) = item {
            search: for index in indices.reversed() {
                switch self[index] {
                case .userMessage, .checkpoint:
                    break search
                case .toolEvent(
                    let existingID, let existingName, let existingDetail, _, .running, _, _, _)
                where existingName == name
                    && (existingDetail == detail
                        || (existingID.hasPrefix("tool:") && !id.hasPrefix("tool:"))):
                    let existing = self[index]
                    let replacedID = existing.id
                    self[index] = item
                        .preservingToolMetadata(of: existing)
                        .preservingFirstLifecycleTimestamp(of: existing)
                    indexByID.removeValue(forKey: replacedID)
                    indexByID[item.id] = index
                    return
                default:
                    continue
                }
            }
        }
        append(item)
        indexByID[item.id] = count - 1
    }
}

extension TimelineItem {
    /// Lifecycle updates keep the timestamp from the first event so an
    /// in-place replacement cannot move a row across a day or gap boundary.
    fileprivate func preservingFirstLifecycleTimestamp(of existing: TimelineItem) -> TimelineItem {
        guard let firstAt = existing.at else { return self }
        switch self {
        case .toolEvent(
            let id, let name, let detail, let kind, let status, _, let output, let outputIsError):
            return .toolEvent(
                id: id, name: name, detail: detail, kind: kind, status: status, at: firstAt,
                output: output, outputIsError: outputIsError)
        case .reasoning(let id, let text, _):
            return .reasoning(id: id, text: text, at: firstAt)
        case .subagentTask(var task):
            task.startedAt = firstAt
            return .subagentTask(task)
        default:
            return self
        }
    }

    /// Lifecycle replacement keeps what the newer event omits: `tool.completed`
    /// often carries no `payload.detail` (blanking the row would drop the
    /// command/path shown while running), tone-fallback events carry no
    /// `itemType` (which would reset the row's icon to the generic one), and
    /// intermediate updates may lack output that only arrives on completion.
    fileprivate func preservingToolMetadata(of existing: TimelineItem) -> TimelineItem {
        guard case .toolEvent(
            let id, let name, let detail, let kind, let status, let at, let output, let outputIsError)
            = self,
            case .toolEvent(
                _, _, let existingDetail, let existingKind, _, _, let existingOutput,
                let existingOutputIsError) = existing
        else { return self }
        let mergedDetail = detail.isEmpty ? existingDetail : detail
        let mergedKind = kind == .other ? existingKind : kind
        let hasNewOutput = !(output?.isEmpty ?? true)
        let mergedOutput = hasNewOutput ? output : existingOutput
        let mergedOutputIsError = hasNewOutput ? outputIsError : existingOutputIsError
        guard mergedDetail != detail || mergedKind != kind || mergedOutput != output
            || mergedOutputIsError != outputIsError
        else { return self }
        return .toolEvent(
            id: id, name: name, detail: mergedDetail, kind: mergedKind, status: status, at: at,
            output: mergedOutput, outputIsError: mergedOutputIsError)
    }
}

public enum ApprovalKind: String, Sendable {
    case command, fileEdit, other
}

public struct ApprovalRequest: Identifiable, Hashable, Sendable {
    public var id: String
    public var threadID: String
    public var kind: ApprovalKind
    public var title: String
    public var detail: String
    public var createdAt: Date

    public init(id: String, threadID: String, kind: ApprovalKind, title: String, detail: String, createdAt: Date) {
        self.id = id
        self.threadID = threadID
        self.kind = kind
        self.title = title
        self.detail = detail
        self.createdAt = createdAt
    }
}

/// One option of a `UserInputQuestion`.
public struct UserInputOption: Hashable, Sendable {
    public var label: String
    public var detail: String?

    public init(label: String, detail: String? = nil) {
        self.label = label
        self.detail = detail
    }
}

/// One question in a user-input request. Empty `options` means free-form.
public struct UserInputQuestionItem: Identifiable, Hashable, Sendable {
    public var id: String
    public var header: String
    public var question: String
    public var options: [UserInputOption]
    public var multiSelect: Bool

    public init(
        id: String, header: String, question: String, options: [UserInputOption],
        multiSelect: Bool
    ) {
        self.id = id
        self.header = header
        self.question = question
        self.options = options
        self.multiSelect = multiSelect
    }
}

/// A provider prompt the user must answer before the turn continues
/// (distinct from approvals — option-based and/or free-form questions).
public struct UserInputRequest: Identifiable, Hashable, Sendable {
    public var id: String
    public var threadID: String
    public var questions: [UserInputQuestionItem]
    public var createdAt: Date

    public init(id: String, threadID: String, questions: [UserInputQuestionItem], createdAt: Date) {
        self.id = id
        self.threadID = threadID
        self.questions = questions
        self.createdAt = createdAt
    }
}

/// Live token-usage snapshot for a thread's context window.
public struct ContextWindowStatus: Hashable, Sendable {
    public var usedTokens: Int
    public var maxTokens: Int?

    public init(usedTokens: Int, maxTokens: Int?) {
        self.usedTokens = usedTokens
        self.maxTokens = maxTokens
    }

    /// 0...1 fraction of the window consumed; nil when the max is unknown.
    public var usedFraction: Double? {
        guard let maxTokens, maxTokens > 0 else { return nil }
        return min(1, Double(usedTokens) / Double(maxTokens))
    }
}

public enum PlanStepStatus: String, Sendable {
    case pending, inProgress, completed
}

/// One step of the agent's live in-turn todo/plan list.
public struct PlanStep: Identifiable, Hashable, Sendable {
    public var id: Int
    public var title: String
    public var status: PlanStepStatus

    public init(id: Int, title: String, status: PlanStepStatus) {
        self.id = id
        self.title = title
        self.status = status
    }
}

/// The agent's live todo list for the running turn (TodoWrite equivalent).
public struct PlanProgress: Hashable, Sendable {
    public var steps: [PlanStep]
    public var explanation: String?

    public init(steps: [PlanStep], explanation: String?) {
        self.steps = steps
        self.explanation = explanation
    }
}

/// A plan the agent proposed in plan mode; the user can start an
/// implementation turn from it.
public struct ProposedPlan: Identifiable, Hashable, Sendable {
    public var id: String
    public var threadID: String
    public var markdown: String
    public var isImplemented: Bool
    public var createdAt: Date

    public init(id: String, threadID: String, markdown: String, isImplemented: Bool, createdAt: Date) {
        self.id = id
        self.threadID = threadID
        self.markdown = markdown
        self.isImplemented = isImplemented
        self.createdAt = createdAt
    }
}

/// UI mirror of wire `OrchestrationCheckpointStatus`.
public enum CheckpointStatus: String, Sendable, Hashable {
    case ready, missing, error
}

/// One file touched by a checkpoint (from `OrchestrationCheckpointFile`).
public struct CheckpointFile: Identifiable, Hashable, Sendable {
    public var path: String
    /// Wire kind string (`added` / `modified` / `deleted` / `renamed`, etc.).
    public var kind: String
    public var additions: Int
    public var deletions: Int

    public var id: String { path }

    public init(path: String, kind: String, additions: Int, deletions: Int) {
        self.path = path
        self.kind = kind
        self.additions = additions
        self.deletions = deletions
    }
}

public struct Checkpoint: Identifiable, Hashable, Sendable {
    public var id: String
    public var threadID: String
    public var label: String
    public var createdAt: Date
    /// Server turn count used for restore and scoped turn-diff queries.
    public var turnCount: Int
    public var status: CheckpointStatus
    public var files: [CheckpointFile]
    public var assistantMessageId: String?

    public init(
        id: String, threadID: String, label: String, createdAt: Date,
        turnCount: Int = 0, status: CheckpointStatus = .ready,
        files: [CheckpointFile] = [], assistantMessageId: String? = nil
    ) {
        self.id = id
        self.threadID = threadID
        self.label = label
        self.createdAt = createdAt
        self.turnCount = turnCount
        self.status = status
        self.files = files
        self.assistantMessageId = assistantMessageId
    }
}

/// Scope of the main-area diff review mode.
public enum ReviewScope: Equatable, Hashable, Sendable {
    case allChanges
    case checkpoint(fromTurn: Int, toTurn: Int, label: String)

    public var title: String {
        switch self {
        case .allChanges: "All Changes"
        case .checkpoint(_, _, let label): label
        }
    }
}

public enum DiffLineKind: Sendable {
    case context, addition, deletion
}

public struct DiffLine: Identifiable, Sendable {
    public var id = UUID()
    public var kind: DiffLineKind
    public var text: String
    public var oldNumber: Int?
    public var newNumber: Int?

    public init(kind: DiffLineKind, text: String, oldNumber: Int?, newNumber: Int?) {
        self.kind = kind
        self.text = text
        self.oldNumber = oldNumber
        self.newNumber = newNumber
    }
}

public struct DiffHunk: Identifiable, Sendable {
    public var id = UUID()
    public var header: String
    public var lines: [DiffLine]

    public init(header: String, lines: [DiffLine]) {
        self.header = header
        self.lines = lines
    }
}

public enum DiffFileStatus: String, Sendable {
    case added, modified, deleted, renamed
}

public struct DiffFile: Identifiable, Sendable {
    public var id: String { path }
    public var path: String
    /// The pre-rename path for a `renamed`/`copied` file, else nil.
    public var oldPath: String?
    public var status: DiffFileStatus
    /// Set when the file is a binary change (`Binary files … differ`), which
    /// carries no textual hunks — distinguishes it from an empty text diff.
    public var isBinary: Bool
    public var hunks: [DiffHunk]

    public init(
        path: String, oldPath: String? = nil, status: DiffFileStatus,
        isBinary: Bool = false, hunks: [DiffHunk]
    ) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.isBinary = isBinary
        self.hunks = hunks
    }
}

public enum ProviderAvailability: String, Sendable {
    case available, missing, authRequired
}

/// A provider-native slash command (typed into the composer as `/name`).
public struct SlashCommandInfo: Identifiable, Hashable, Sendable {
    public var name: String
    public var detail: String?
    public var argumentHint: String?

    public var id: String { name }

    public init(name: String, detail: String? = nil, argumentHint: String? = nil) {
        self.name = name
        self.detail = detail
        self.argumentHint = argumentHint
    }
}

public struct ProviderInstance: Identifiable, Sendable {
    public var id: String
    public var kind: ProviderKind
    public var availability: ProviderAvailability
    public var version: String?
    public var slashCommands: [SlashCommandInfo]

    public init(
        id: String, kind: ProviderKind, availability: ProviderAvailability, version: String?,
        slashCommands: [SlashCommandInfo] = []
    ) {
        self.id = id
        self.kind = kind
        self.availability = availability
        self.version = version
        self.slashCommands = slashCommands
    }
}

/// One file/directory hit from a workspace search (composer @-mentions).
public struct WorkspaceEntry: Identifiable, Hashable, Sendable {
    public var path: String
    public var isDirectory: Bool

    public var id: String { path }

    public init(path: String, isDirectory: Bool) {
        self.path = path
        self.isDirectory = isDirectory
    }
}

/// Contents of one workspace file for the inspector preview.
public struct FilePreview: Hashable, Sendable {
    public var path: String
    public var contents: String
    public var truncated: Bool

    public init(path: String, contents: String, truncated: Bool) {
        self.path = path
        self.contents = contents
        self.truncated = truncated
    }
}

/// External editors the server's launcher can open a path in
/// (subset of contracts editor.ts `EDITORS`).
public enum ExternalEditor: String, CaseIterable, Sendable, Identifiable {
    case vscode, cursor, zed, fileManager = "file-manager"
    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .vscode: "VS Code"
        case .cursor: "Cursor"
        case .zed: "Zed"
        case .fileManager: "Finder"
        }
    }
}

/// An image staged in the composer, ready to upload with the next turn.
public struct OutgoingAttachment: Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var mimeType: String
    public var sizeBytes: Int
    /// base64 `data:` URL — the wire upload shape embeds bytes inline.
    public var dataURL: String

    public init(id: String, name: String, mimeType: String, sizeBytes: Int, dataURL: String) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.dataURL = dataURL
    }
}

/// A composer message waiting for the selected thread to become idle.
public struct QueuedOutgoingMessage: Identifiable, Hashable, Sendable {
    public var id: String
    public var text: String
    public var attachments: [OutgoingAttachment]
    public var createdAt: Date
    public var sendAttempts: Int

    public init(
        id: String = UUID().uuidString, text: String,
        attachments: [OutgoingAttachment] = [], createdAt: Date = Date(), sendAttempts: Int = 0
    ) {
        self.id = id
        self.text = text
        self.attachments = attachments
        self.createdAt = createdAt
        self.sendAttempts = sendAttempts
    }
}

// MARK: - Git / VCS

/// Lifecycle of the branch's pull request, from the wire's
/// `VcsStatusChangeRequest.state` literals.
public enum PullRequestState: String, Sendable {
    case open, closed, merged
}

/// GitHub reviewDecision values from `VcsStatusChangeRequest.reviewDecision`.
public enum PullRequestReviewDecision: String, Sendable {
    case approved = "APPROVED"
    case changesRequested = "CHANGES_REQUESTED"
    case reviewRequired = "REVIEW_REQUIRED"
}

/// Where the PR sits in its review lifecycle, from the wire's
/// `VcsStatusChangeRequest.reviewLifecycle`. Nil means unknown — a review bot
/// may simply not have touched this PR — and is never "complete".
public enum PullRequestReviewLifecycle: String, Sendable {
    /// A review bot says it is looking at the current changes right now.
    case reviewInProgress = "review-in-progress"
    /// A review landed and unresolved comments remain.
    case actionableComments = "actionable-comments"
    /// A review landed and nothing is left to fix.
    case reviewComplete = "review-complete"
}

public struct PullRequestReviewAuthor: Hashable, Sendable {
    public var login: String
    public var avatarURL: String?
    public var isBot: Bool
}

public struct PullRequestReviewComment: Identifiable, Hashable, Sendable {
    public var id: String
    public var author: PullRequestReviewAuthor
    public var authorAssociation: String?
    public var body: String
    public var url: String
    public var createdAt: Date
    public var updatedAt: Date
    /// Present for a review summary (for example COMMENTED or APPROVED), nil
    /// for a conversation comment or inline reply.
    public var reviewState: String?
}

public struct PullRequestReviewThread: Identifiable, Hashable, Sendable {
    public var id: String
    public var isResolved: Bool
    public var isOutdated: Bool
    public var path: String
    public var line: Int?
    public var originalLine: Int?
    public var diffSide: String?
    public var comments: [PullRequestReviewComment]
}

public struct PullRequestReviewSnapshot: Hashable, Sendable {
    public var provider: String
    public var number: Int
    public var url: String
    public var conversation: [PullRequestReviewComment]
    public var threads: [PullRequestReviewThread]
    public var unresolvedThreadCount: Int
    public var truncated: Bool
}

/// Working-tree + branch + PR status for one project repo.
public struct VcsStatus: Hashable, Sendable {
    public var isRepo: Bool
    public var branch: String?
    public var isDefaultBranch: Bool
    public var changedFileCount: Int
    public var insertions: Int
    public var deletions: Int
    public var aheadCount: Int
    public var behindCount: Int
    public var hasUpstream: Bool
    /// Whether the repo has a primary remote to push/PR against.
    public var hasPrimaryRemote: Bool
    /// Commits on this branch that are not on the default branch; nil when
    /// the remote status hasn't resolved it. Distinct from `aheadCount`
    /// (divergence from upstream), which is 0 for a fully pushed branch.
    public var aheadOfDefaultCount: Int?
    public var prNumber: Int?
    public var prTitle: String?
    public var prURL: String?
    public var prState: PullRequestState?
    /// True while the open pull request is a draft; nil when unavailable.
    public var isDraftPR: Bool?
    /// GitHub review decision; nil when unknown / non-GitHub / fetch failed.
    public var reviewDecision: PullRequestReviewDecision?
    /// Unresolved review thread count; nil when unknown / fetch failed.
    public var unresolvedReviewThreadCount: Int?
    /// Unresolved, non-outdated inline review threads with non-empty comments.
    public var actionableReviewItemCount: Int?
    /// Review lifecycle phase; nil when unknown / non-GitHub / fetch failed.
    public var reviewLifecycle: PullRequestReviewLifecycle?

    public init(
        isRepo: Bool, branch: String?, isDefaultBranch: Bool, changedFileCount: Int,
        insertions: Int, deletions: Int, aheadCount: Int, behindCount: Int, hasUpstream: Bool,
        hasPrimaryRemote: Bool = false, aheadOfDefaultCount: Int? = nil,
        prNumber: Int? = nil, prTitle: String? = nil, prURL: String? = nil,
        prState: PullRequestState? = nil,
        isDraftPR: Bool? = nil,
        reviewDecision: PullRequestReviewDecision? = nil,
        unresolvedReviewThreadCount: Int? = nil,
        actionableReviewItemCount: Int? = nil,
        reviewLifecycle: PullRequestReviewLifecycle? = nil
    ) {
        self.isRepo = isRepo
        self.branch = branch
        self.isDefaultBranch = isDefaultBranch
        self.changedFileCount = changedFileCount
        self.insertions = insertions
        self.deletions = deletions
        self.aheadCount = aheadCount
        self.behindCount = behindCount
        self.hasUpstream = hasUpstream
        self.hasPrimaryRemote = hasPrimaryRemote
        self.aheadOfDefaultCount = aheadOfDefaultCount
        self.prNumber = prNumber
        self.prTitle = prTitle
        self.prURL = prURL
        self.prState = prState
        self.isDraftPR = isDraftPR
        self.reviewDecision = reviewDecision
        self.unresolvedReviewThreadCount = unresolvedReviewThreadCount
        self.actionableReviewItemCount = actionableReviewItemCount
        self.reviewLifecycle = reviewLifecycle
    }
}

public struct BranchRef: Identifiable, Hashable, Sendable {
    public var name: String
    public var isCurrent: Bool
    public var isDefault: Bool
    public var isRemote: Bool

    public var id: String { (isRemote ? "remote/" : "local/") + name }

    public init(name: String, isCurrent: Bool, isDefault: Bool, isRemote: Bool) {
        self.name = name
        self.isCurrent = isCurrent
        self.isDefault = isDefault
        self.isRemote = isRemote
    }
}

/// The stacked git pipelines the toolbar offers.
public enum GitAction: String, CaseIterable, Sendable, Identifiable {
    case commit, push, commitPush, commitPushPR, readyPR, mergePR
    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .commit: "Commit"
        case .push: "Push"
        case .commitPush: "Commit & Push"
        case .commitPushPR: "Commit, Push & Open PR"
        case .readyPR: "Ready for Review"
        case .mergePR: "Merge PR"
        }
    }

    public var needsCommitMessage: Bool {
        switch self {
        case .push, .readyPR, .mergePR: false
        default: true
        }
    }

    /// Actions listed in the generic Git overflow menu (not dedicated buttons).
    public static var menuActions: [GitAction] {
        allCases.filter { $0 != .mergePR && $0 != .readyPR }
    }
}

/// Terminal outcome of a stacked git action.
public struct GitActionOutcome: Hashable, Sendable {
    public var success: Bool
    public var title: String
    public var detail: String?
    public var prURL: String?

    public init(success: Bool, title: String, detail: String? = nil, prURL: String? = nil) {
        self.success = success
        self.title = title
        self.detail = detail
        self.prURL = prURL
    }
}

/// Where new threads run: the project checkout itself or a fresh worktree.
public enum ProjectEnvMode: String, CaseIterable, Sendable, Identifiable {
    case local, worktree
    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .local: "Project directory"
        case .worktree: "Isolated worktree"
        }
    }
}

/// The editable server-settings subset surfaced in the Settings scene.
public struct AppSettings: Hashable, Sendable {
    public var assistantStreaming: Bool
    public var providerUpdateChecks: Bool
    public var defaultEnvMode: ProjectEnvMode
    public var newWorktreesStartFromOrigin: Bool
    public var addProjectBaseDirectory: String

    public init(
        assistantStreaming: Bool, providerUpdateChecks: Bool, defaultEnvMode: ProjectEnvMode,
        newWorktreesStartFromOrigin: Bool, addProjectBaseDirectory: String
    ) {
        self.assistantStreaming = assistantStreaming
        self.providerUpdateChecks = providerUpdateChecks
        self.defaultEnvMode = defaultEnvMode
        self.newWorktreesStartFromOrigin = newWorktreesStartFromOrigin
        self.addProjectBaseDirectory = addProjectBaseDirectory
    }
}

public enum ConnectionPhase: Sendable, Equatable {
    case launchingServer
    case connecting
    case ready
    case reconnecting(attempt: Int)
    case unauthorized
    case failed(String)
}
