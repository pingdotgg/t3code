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
    /// Tone `.info`: adapter-side warning about a provider message the
    /// server couldn't project (ProviderRuntimeIngestion.ts).
    public static let runtimeWarning = "runtime.warning"
}

// MARK: - tool.updated / tool.completed

/// Activity payload for kinds `tool.updated`/`tool.completed`:
/// `{ itemType, status?, detail?, data? }` (`data` stays opaque; its
/// `toolCallId` is read via JSONValue for lifecycle correlation).
public struct ToolLifecycleActivityPayload: Decodable, Sendable {
    public var itemType: String?
    public var status: String?
    public var detail: String?
}

// MARK: - task.started / task.progress / task.updated / task.completed

/// Activity payload for kind `task.started`:
/// `{ taskId, description?, taskType?, subagentType?, model?, workflowName?, toolUseId? }`.
/// All identity fields are optional so older persisted activities still decode.
public struct TaskStartedActivityPayload: Decodable, Sendable {
    public var taskId: String?
    public var taskType: String?
    public var description: String?
    public var detail: String?
    public var subagentType: String?
    public var model: String?
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
/// `{ taskId, status?, description?, error?, isBackgrounded?, endTime?, totalPausedMs? }`.
public struct TaskUpdatedActivityPayload: Decodable, Sendable {
    public var taskId: String?
    public var status: String?
    public var description: String?
    public var detail: String?
    public var error: String?
    public var isBackgrounded: Bool?
    public var endTime: Double?
    public var totalPausedMs: Double?
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
