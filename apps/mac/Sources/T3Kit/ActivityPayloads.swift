// Typed views over well-known `OrchestrationThreadActivity.payload` shapes.
// The orchestration contract leaves activity payloads as `Schema.Unknown`;
// the real shapes live in packages/contracts/src/providerRuntime.ts and the
// server's ProviderRuntimeIngestion.ts projection. These kinds all arrive
// with tone `.info`, so consumers must dispatch on `activity.kind` (not tone)
// before falling back to generic notice rendering.

import Foundation

/// Well-known `OrchestrationThreadActivity.kind` values that carry a typed
/// payload (ProviderRuntimeIngestion.ts).
public enum ActivityKind {
    /// Tone `.approval` (unlike the rest): only `approval.requested` is an
    /// actionable request; `approval.resolved` records the outcome.
    public static let approvalRequested = "approval.requested"
    public static let approvalResolved = "approval.resolved"
    public static let userInputRequested = "user-input.requested"
    public static let userInputResolved = "user-input.resolved"
    public static let usageLimitReached = "usage-limit.reached"
    public static let turnPlanUpdated = "turn.plan.updated"
    public static let contextWindowUpdated = "context-window.updated"
    /// Tool lifecycle (tone `.tool`): started is pure noise (always followed
    /// by updated/completed for the same call); updated/completed carry the
    /// human title in `summary` and `{ itemType, status?, detail?, data? }`
    /// in the payload.
    public static let toolStarted = "tool.started"
    public static let toolUpdated = "tool.updated"
    public static let toolCompleted = "tool.completed"
    /// Task lifecycle (tone `.info`): Claude Agent SDK subagent lifecycle.
    /// These rows are aggregated by `taskId` before they reach the UI.
    public static let taskStarted = "task.started"
    public static let taskProgress = "task.progress"
    public static let taskUpdated = "task.updated"
    public static let taskCompleted = "task.completed"
    /// Tone `.error`: stop-task RPC failed; payload may carry `taskId` + `detail`.
    public static let providerTaskStopFailed = "provider.task.stop.failed"
    /// Tone `.info`: adapter-side warning about a provider message the
    /// server couldn't project (ProviderRuntimeIngestion.ts).
    public static let runtimeWarning = "runtime.warning"
    /// Tone `.error`: adapter-side provider runtime failure.
    public static let runtimeError = "runtime.error"
    /// Server-driven turn liveness for ALL providers (codex/grok/cursor/
    /// claude): tone `.error` when `state == "stalled"`, `.info` on recovery.
    /// Payload is `SessionHealthActivityPayload`. Emitted once on stall and
    /// once on recovery by the server's TurnActivityWatchdog.
    public static let sessionHealth = "session.health"
    /// Tone `.error`: a provider CLI process died leaving captured stderr.
    /// Payload is `SessionExitedActivityPayload`; only emitted when a
    /// `stderrTail` was captured (quiet exits produce no activity).
    public static let sessionExited = "session.exited"
}

// MARK: - session.health

/// Activity payload for kind `session.health`:
/// `{ state: "stalled" | "active", lastActivityAt, stalledForMs? }`
/// (providerRuntime.ts `SessionHealthPayload`). Drives server-authoritative
/// stall status for a thread's active provider turn.
public struct SessionHealthActivityPayload: Decodable, Sendable {
    public var state: String
    public var lastActivityAt: String
    public var stalledForMs: Int?

    public var isStalled: Bool { state == "stalled" }
}

// MARK: - session.exited

/// Activity payload for kind `session.exited`:
/// `{ stderrTail, reason?, exitKind?, recoverable? }`. `stderrTail` is a
/// bounded tail of the provider process stderr for the failure disclosure.
public struct SessionExitedActivityPayload: Decodable, Sendable {
    public var stderrTail: String
    public var reason: String?
    public var exitKind: String?
    public var recoverable: Bool?
}

// MARK: - tool.updated / tool.completed

/// Native surface a tool invocation should render as (contracts
/// `ToolSurface`). Unknown/future surfaces decode to `.generic`, which is
/// always a valid rendering.
public enum ToolSurface: String, Decodable, Sendable {
    case command
    case fileRead = "file_read"
    case fileChange = "file_change"
    case fileSearch = "file_search"
    case webSearch = "web_search"
    case webFetch = "web_fetch"
    case image
    case todo
    case skill
    case plugin
    case mcp
    case subagent
    case generic
}

/// Where the invoked capability came from (contracts `ToolOrigin`).
public enum ToolOrigin: String, Decodable, Sendable {
    case builtin, mcp, skill, plugin, subagent, unknown
}

/// Execution state of a tool invocation (contracts `ToolExecutionState`).
public enum ToolExecutionState: String, Decodable, Sendable {
    case pending, running, succeeded, failed, declined
}

/// Identity + provenance of the invoked capability (contracts `ToolProvenance`).
public struct ToolProvenance: Decodable, Sendable, Equatable {
    public var origin: ToolOrigin
    public var toolName: String?
    public var displayName: String?
    public var serverName: String?
    public var pluginName: String?
    public var skillName: String?
    public var subagentType: String?
    public var provider: String?

    private enum CodingKeys: String, CodingKey {
        case origin, toolName, displayName, serverName, pluginName, skillName, subagentType,
            provider
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // An origin the app has not learned yet degrades to `.unknown` rather
        // than failing the whole presentation decode.
        origin = (try? c.decodeIfPresent(ToolOrigin.self, forKey: .origin)) ?? .unknown
        toolName = try c.decodeIfPresent(String.self, forKey: .toolName)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
        serverName = try c.decodeIfPresent(String.self, forKey: .serverName)
        pluginName = try c.decodeIfPresent(String.self, forKey: .pluginName)
        skillName = try c.decodeIfPresent(String.self, forKey: .skillName)
        subagentType = try c.decodeIfPresent(String.self, forKey: .subagentType)
        provider = try c.decodeIfPresent(String.self, forKey: .provider)
    }
}

/// One normalized tool input argument (contracts `ToolInputField`).
public struct ToolInputField: Decodable, Sendable, Equatable {
    public var label: String
    public var value: String
    /// `text` | `path` | `command` | `query` | `url` | `json`.
    public var kind: String
    public var truncated: Bool?
}

/// Bounded preview of a tool's output (contracts `ToolResultPreview`).
public struct ToolResultPreview: Decodable, Sendable, Equatable {
    public var text: String?
    public var truncated: Bool?
    public var exitCode: Int?
    public var error: String?
    public var paths: [String]

    private enum CodingKeys: String, CodingKey { case text, truncated, exitCode, error, paths }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decodeIfPresent(String.self, forKey: .text)
        truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated)
        exitCode = try c.decodeIfPresent(Int.self, forKey: .exitCode)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        paths = try c.decodeIfPresent([String].self, forKey: .paths) ?? []
    }
}

/// Permission outcome for a gated tool call (contracts `ToolPermission`).
public struct ToolPermission: Decodable, Sendable, Equatable {
    /// `pending` | `approved` | `denied`.
    public var decision: String
    public var reason: String?
}

/// Server-derived native presentation of one tool/skill/plugin invocation
/// (contracts `ToolPresentation`, derived in `@t3tools/shared/toolPresentation`).
/// This is authoritative: it replaces per-client re-scraping of the opaque
/// `payload.data` bag, which each app used to do on its own.
public struct ToolPresentation: Decodable, Sendable, Equatable {
    public var surface: ToolSurface
    public var title: String
    public var subtitle: String?
    public var state: ToolExecutionState
    public var provenance: ToolProvenance
    public var inputs: [ToolInputField]
    public var result: ToolResultPreview?
    public var permission: ToolPermission?
    public var itemType: String?

    private enum CodingKeys: String, CodingKey {
        case surface, title, subtitle, state, provenance, inputs, result, permission, itemType
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A surface this build does not know yet renders generically — the
        // contract guarantees generic rendering is always valid.
        surface = (try? c.decodeIfPresent(ToolSurface.self, forKey: .surface)) ?? .generic
        title = try c.decode(String.self, forKey: .title)
        subtitle = try c.decodeIfPresent(String.self, forKey: .subtitle)
        state = (try? c.decodeIfPresent(ToolExecutionState.self, forKey: .state)) ?? .running
        provenance = try c.decode(ToolProvenance.self, forKey: .provenance)
        inputs = try c.decodeIfPresent([ToolInputField].self, forKey: .inputs) ?? []
        result = try c.decodeIfPresent(ToolResultPreview.self, forKey: .result)
        permission = try c.decodeIfPresent(ToolPermission.self, forKey: .permission)
        itemType = try c.decodeIfPresent(String.self, forKey: .itemType)
    }
}

/// Activity payload for kinds `tool.updated`/`tool.completed`:
/// `{ itemType, status?, detail?, data?, presentation? }`. `data` stays opaque
/// (its `toolCallId` is read via JSONValue for lifecycle correlation);
/// `presentation` is the typed surface to render. It is absent on activities
/// persisted before the server derived one — always keep the legacy fallback.
public struct ToolLifecycleActivityPayload: Decodable, Sendable {
    public var itemType: String?
    public var status: String?
    public var detail: String?
    public var presentation: ToolPresentation?

    private enum CodingKeys: String, CodingKey { case itemType, status, detail, presentation }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemType = try c.decodeIfPresent(String.self, forKey: .itemType)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
        // Presentation drift must degrade to the legacy derivation, not drop
        // the row.
        presentation = try? c.decodeIfPresent(ToolPresentation.self, forKey: .presentation)
    }
}

// MARK: - task.started / task.progress / task.updated / task.completed

/// Activity payload for kind `task.started`:
/// `{ taskId, description?, taskType?, subagentType?, model?, effort?, workflowName?, toolUseId? }`.
/// All identity fields are optional so older persisted activities still decode.
public struct TaskStartedActivityPayload: Decodable, Sendable {
    public var taskId: String?
    public var taskType: String?
    public var description: String?
    public var detail: String?
    public var subagentType: String?
    public var model: String?
    /// Reasoning effort the subagent's turns run at, when the provider has one.
    public var effort: String?
    public var workflowName: String?
    public var toolUseId: String?
}

/// Activity payload for kind `task.progress`:
/// `{ taskId, description, summary?, lastToolName?, usage?, subagentType?, toolUseId? }`.
public struct TaskProgressActivityPayload: Decodable, Sendable {
    public var taskId: String?
    public var taskType: String?
    public var description: String?
    public var detail: String?
    public var summary: String?
    public var lastToolName: String?
    public var usage: JSONValue?
    public var subagentType: String?
    public var toolUseId: String?
}

/// Activity payload for kind `task.updated`:
/// `{ taskId, status?, description?, error?, isBackgrounded?, endTime?, totalPausedMs?, model? }`.
public struct TaskUpdatedActivityPayload: Decodable, Sendable {
    public var taskId: String?
    public var status: String?
    public var description: String?
    public var detail: String?
    public var error: String?
    public var isBackgrounded: Bool?
    public var endTime: Double?
    public var totalPausedMs: Double?
    public var model: String?
}

/// Activity payload for kind `task.completed`:
/// `{ taskId, status, summary?, usage?, outputFile? }`.
public struct TaskCompletedActivityPayload: Decodable, Sendable {
    public var taskId: String?
    public var taskType: String?
    public var description: String?
    public var status: String?
    public var detail: String?
    public var summary: String?
    public var lastToolName: String?
    public var usage: JSONValue?
    public var outputFile: String?
}

// MARK: - user-input.requested / user-input.resolved

/// `UserInputQuestionOption` (providerRuntime.ts).
public struct UserInputQuestionOption: Decodable, Sendable, Hashable {
    public var label: String
    public var description: String?
}

/// `UserInputQuestion` (providerRuntime.ts): one question the provider needs
/// answered before the turn continues. `multiSelect` defaults to false.
public struct UserInputQuestion: Decodable, Sendable, Hashable {
    public var id: String
    public var header: String
    public var question: String
    public var options: [UserInputQuestionOption]
    public var multiSelect: Bool

    private enum CodingKeys: String, CodingKey { case id, header, question, options, multiSelect }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        header = try c.decode(String.self, forKey: .header)
        question = try c.decode(String.self, forKey: .question)
        options = try c.decodeIfPresent([UserInputQuestionOption].self, forKey: .options) ?? []
        multiSelect = try c.decodeIfPresent(Bool.self, forKey: .multiSelect) ?? false
    }
}

/// Activity payload for kind `user-input.requested`:
/// `{ requestId?, questions: UserInputQuestion[] }`.
public struct UserInputRequestedActivityPayload: Decodable, Sendable {
    public var requestId: String?
    public var questions: [UserInputQuestion]
}

/// Activity payload for kind `user-input.resolved`: `{ requestId?, answers }`.
public struct UserInputResolvedActivityPayload: Decodable, Sendable {
    public var requestId: String?
}

// MARK: - usage-limit.reached

/// Activity payload for kind `usage-limit.reached`:
/// `{ message, provider?, source?, resetsAt?, resetsAtEpochSeconds?, resetSource? }`.
public struct UsageLimitReachedActivityPayload: Decodable, Sendable {
    public var message: String
    public var provider: String?
    public var source: String?
    public var resetsAt: String?
    public var resetsAtEpochSeconds: Int?
    public var resetSource: String?
}

// MARK: - turn.plan.updated

public enum TurnPlanStepStatus: String, Decodable, Sendable {
    case pending, inProgress, completed
}

/// One `{ step, status? }` entry of a `turn.plan.updated` payload.
public struct TurnPlanStep: Decodable, Sendable, Hashable {
    public var step: String
    public var status: TurnPlanStepStatus?

    private enum CodingKeys: String, CodingKey { case step, status }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        step = try c.decode(String.self, forKey: .step)
        // Unknown future status strings degrade to nil rather than failing
        // the whole payload decode.
        status = try? c.decodeIfPresent(TurnPlanStepStatus.self, forKey: .status)
    }
}

/// Activity payload for kind `turn.plan.updated`:
/// `{ plan: TurnPlanStep[], explanation?: string | null }`.
public struct TurnPlanUpdatedActivityPayload: Decodable, Sendable {
    public var plan: [TurnPlanStep]
    public var explanation: String?
}

// MARK: - context-window.updated

/// Activity payload for kind `context-window.updated` — the flattened
/// `ThreadTokenUsageSnapshot` fields (providerRuntime.ts). Only the fields
/// the UI meter needs are modeled; the rest round-trip through the opaque
/// activity payload untouched.
public struct ContextWindowUpdatedActivityPayload: Decodable, Sendable {
    public var usedTokens: Int
    public var maxTokens: Int?
    public var inputTokens: Int?
    public var outputTokens: Int?
    public var compactsAutomatically: Bool?
}

// MARK: - Decode helper

extension OrchestrationThreadActivity {
    /// Decodes this activity's opaque payload as the given typed shape;
    /// `nil` when the payload doesn't match (defensive — a provider drift
    /// should degrade to generic rendering, not crash).
    public func decodePayload<T: Decodable>(_ type: T.Type) -> T? {
        try? payload.decode(as: T.self, using: WireCoding.decoder)
    }
}
