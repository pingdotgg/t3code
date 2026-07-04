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
    public static let userInputRequested = "user-input.requested"
    public static let userInputResolved = "user-input.resolved"
    public static let turnPlanUpdated = "turn.plan.updated"
    public static let contextWindowUpdated = "context-window.updated"
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
