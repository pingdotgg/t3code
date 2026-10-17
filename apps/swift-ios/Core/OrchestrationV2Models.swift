import Foundation

/// V2 wire records retain unknown fields for command context and forward compatibility.
/// Required fields decode strictly: a malformed committed event must trigger a refresh.
public protocol OrchestrationV2Record: Codable, Equatable, Sendable {
    var raw: JSONValue { get }
}

extension OrchestrationV2Record {
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
    public init(json: JSONValue) throws { self = try json.decode(Self.self) }
}

struct V2Key: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(_ value: String) { stringValue = value }
    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { return nil }
}

public enum OrchestrationV2StateError: Error, Equatable, Sendable {
    case invalidPayload(String)
    case wrongThread
    case invalidHistoryPage
}

extension JSONValue {
    var v2Object: [String: JSONValue] {
        guard case let .object(value) = self else { return [:] }
        return value
    }
    var v2Array: [JSONValue]? {
        guard case let .array(value) = self else { return nil }
        return value
    }
    var v2Int: Int? {
        switch self {
        case let .integer(value): Int(exactly: value)
        case let .unsignedInteger(value): Int(exactly: value)
        case let .number(value): Int(exactly: value)
        default: nil
        }
    }
    func v2Required(_ key: String) throws -> JSONValue {
        guard let value = self[key] else { throw OrchestrationV2StateError.invalidPayload(key) }
        return value
    }
}

public struct OrchestrationV2ThreadLineage: OrchestrationV2Record {
    public let raw: JSONValue
    public let parentThreadId: String?
    public let relationshipToParent: String?
    public let rootThreadId: String

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        parentThreadId = try c.decode(String?.self, forKey: V2Key("parentThreadId"))
        relationshipToParent = try c.decode(String?.self, forKey: V2Key("relationshipToParent"))
        rootThreadId = try c.decode(String.self, forKey: V2Key("rootThreadId"))
    }
}

public struct OrchestrationV2ProviderRef: OrchestrationV2Record {
    public let raw: JSONValue
    public let driver: String
    public let nativeId: String?
    public let strength: String
    public let fingerprint: String?
    public let ordinal: Int?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        driver = try c.decode(String.self, forKey: V2Key("driver"))
        nativeId = try c.decode(String?.self, forKey: V2Key("nativeId"))
        strength = try c.decode(String.self, forKey: V2Key("strength"))
        fingerprint = try c.decodeIfPresent(String.self, forKey: V2Key("fingerprint"))
        ordinal = try c.decodeIfPresent(Int.self, forKey: V2Key("ordinal"))
    }
}

public struct OrchestrationV2AppThread: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let projectId: String
    public let title: String
    public let providerInstanceId: String
    public let modelSelection: ModelSelection
    public let runtimeMode: RuntimeMode
    public let interactionMode: InteractionMode
    public let branch: String?
    public let worktreePath: String?
    public let activeProviderThreadId: String?
    public let lineage: OrchestrationV2ThreadLineage
    public let forkedFrom: JSONValue?
    public let createdBy: String
    public let creationSource: String
    public let createdAt: String
    public let updatedAt: String
    public let archivedAt: String?
    public let settledOverride: String?
    public let settledAt: String?
    public let unsettledAt: String?
    public let snoozedUntil: String?
    public let snoozedAt: String?
    public let pinnedAt: String?
    public let autoSettleDisabledAt: String?
    public let pinOrderKey: String?
    public let activeOrderKey: String?
    public let lastVisitedAt: String?
    public let deletedAt: String?
    public let linkedPullRequest: ThreadLinkedPullRequest?
    public let pullRequests: [ThreadPullRequestLink]?
    public let branchPullRequest: ThreadLinkedPullRequest?
    public let titleRegeneration: ThreadTitleRegeneration?
    public let historyOrigin: String?
    public let limitRecovery: JSONValue?
    public let rollbackRequestId: String?
    public let rollbackFailure: JSONValue?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        projectId = try c.decode(String.self, forKey: V2Key("projectId"))
        title = try c.decode(String.self, forKey: V2Key("title"))
        providerInstanceId = try c.decode(String.self, forKey: V2Key("providerInstanceId"))
        modelSelection = try c.decode(ModelSelection.self, forKey: V2Key("modelSelection"))
        runtimeMode = try c.decode(RuntimeMode.self, forKey: V2Key("runtimeMode"))
        interactionMode = try c.decode(InteractionMode.self, forKey: V2Key("interactionMode"))
        branch = try c.decode(String?.self, forKey: V2Key("branch"))
        worktreePath = try c.decode(String?.self, forKey: V2Key("worktreePath"))
        activeProviderThreadId = try c.decode(String?.self, forKey: V2Key("activeProviderThreadId"))
        lineage = try c.decode(OrchestrationV2ThreadLineage.self, forKey: V2Key("lineage"))
        forkedFrom = try c.decode(JSONValue?.self, forKey: V2Key("forkedFrom"))
        createdBy = try c.decode(String.self, forKey: V2Key("createdBy"))
        creationSource = try c.decode(String.self, forKey: V2Key("creationSource"))
        createdAt = try c.decode(String.self, forKey: V2Key("createdAt"))
        updatedAt = try c.decode(String.self, forKey: V2Key("updatedAt"))
        archivedAt = try c.decode(String?.self, forKey: V2Key("archivedAt"))
        settledOverride = try c.decodeIfPresent(String.self, forKey: V2Key("settledOverride"))
        settledAt = try c.decodeIfPresent(String.self, forKey: V2Key("settledAt"))
        unsettledAt = try c.decodeIfPresent(String.self, forKey: V2Key("unsettledAt"))
        snoozedUntil = try c.decodeIfPresent(String.self, forKey: V2Key("snoozedUntil"))
        snoozedAt = try c.decodeIfPresent(String.self, forKey: V2Key("snoozedAt"))
        pinnedAt = try c.decodeIfPresent(String.self, forKey: V2Key("pinnedAt"))
        autoSettleDisabledAt = try c.decodeIfPresent(String.self, forKey: V2Key("autoSettleDisabledAt"))
        pinOrderKey = try c.decodeIfPresent(String.self, forKey: V2Key("pinOrderKey"))
        activeOrderKey = try c.decodeIfPresent(String.self, forKey: V2Key("activeOrderKey"))
        lastVisitedAt = try c.decodeIfPresent(String.self, forKey: V2Key("lastVisitedAt"))
        deletedAt = try c.decode(String?.self, forKey: V2Key("deletedAt"))
        linkedPullRequest = try c.decodeIfPresent(ThreadLinkedPullRequest.self, forKey: V2Key("linkedPullRequest"))
        pullRequests = try c.decodeIfPresent([ThreadPullRequestLink].self, forKey: V2Key("pullRequests"))
        branchPullRequest = try c.decodeIfPresent(ThreadLinkedPullRequest.self, forKey: V2Key("branchPullRequest"))
        titleRegeneration = try c.decodeIfPresent(ThreadTitleRegeneration.self, forKey: V2Key("titleRegeneration"))
        historyOrigin = try c.decodeIfPresent(String.self, forKey: V2Key("historyOrigin"))
        limitRecovery = try c.decodeIfPresent(JSONValue.self, forKey: V2Key("limitRecovery"))
        rollbackRequestId = try c.decodeIfPresent(String.self, forKey: V2Key("rollbackRequestId"))
        rollbackFailure = try c.decodeIfPresent(JSONValue.self, forKey: V2Key("rollbackFailure"))
    }
}

public struct OrchestrationV2Run: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let threadId: String
    public let ordinal: Int
    public let providerInstanceId: String
    public let modelSelection: ModelSelection
    public let providerThreadId: String?
    public let userMessageId: String
    public let rootNodeId: String?
    public let activeAttemptId: String?
    public let status: String
    public let queuePosition: Int?
    public let queueHeld: Bool?
    public let requestedAt: String
    public let startedAt: String?
    public let completedAt: String?
    public let checkpointId: String?
    public let contextHandoffId: String?
    public let restartContinuationOfRunId: String?
    public let workStartedAt: String?
    public let restartCancelledBackgroundWork: [JSONValue]?
    public let sourcePlanRef: JSONValue?
    public let delegatedCompletion: JSONValue?
    public let workspacePreparation: JSONValue?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        threadId = try c.decode(String.self, forKey: V2Key("threadId"))
        ordinal = try c.decode(Int.self, forKey: V2Key("ordinal"))
        providerInstanceId = try c.decode(String.self, forKey: V2Key("providerInstanceId"))
        modelSelection = try c.decode(ModelSelection.self, forKey: V2Key("modelSelection"))
        providerThreadId = try c.decode(String?.self, forKey: V2Key("providerThreadId"))
        userMessageId = try c.decode(String.self, forKey: V2Key("userMessageId"))
        rootNodeId = try c.decode(String?.self, forKey: V2Key("rootNodeId"))
        activeAttemptId = try c.decode(String?.self, forKey: V2Key("activeAttemptId"))
        status = try c.decode(String.self, forKey: V2Key("status"))
        queuePosition = try c.decodeIfPresent(Int.self, forKey: V2Key("queuePosition"))
        queueHeld = try c.decodeIfPresent(Bool.self, forKey: V2Key("queueHeld"))
        requestedAt = try c.decode(String.self, forKey: V2Key("requestedAt"))
        startedAt = try c.decode(String?.self, forKey: V2Key("startedAt"))
        completedAt = try c.decode(String?.self, forKey: V2Key("completedAt"))
        checkpointId = try c.decode(String?.self, forKey: V2Key("checkpointId"))
        contextHandoffId = try c.decode(String?.self, forKey: V2Key("contextHandoffId"))
        restartContinuationOfRunId = try c.decodeIfPresent(String.self, forKey: V2Key("restartContinuationOfRunId"))
        workStartedAt = try c.decodeIfPresent(String.self, forKey: V2Key("workStartedAt"))
        restartCancelledBackgroundWork = try c.decodeIfPresent([JSONValue].self, forKey: V2Key("restartCancelledBackgroundWork"))
        sourcePlanRef = try c.decodeIfPresent(JSONValue.self, forKey: V2Key("sourcePlanRef"))
        delegatedCompletion = try c.decodeIfPresent(JSONValue.self, forKey: V2Key("delegatedCompletion"))
        workspacePreparation = try c.decodeIfPresent(JSONValue.self, forKey: V2Key("workspacePreparation"))
    }
}

public struct OrchestrationV2RunAttempt: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let nativeThreadId: String?
    public let runId: String
    public let attemptOrdinal: Int
    public let rootNodeId: String
    public let providerInstanceId: String
    public let providerThreadId: String
    public let providerTurnId: String?
    public let reason: String
    public let status: String
    public let startedAt: String?
    public let completedAt: String?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        nativeThreadId = try c.decodeIfPresent(String.self, forKey: V2Key("nativeThreadId"))
        runId = try c.decode(String.self, forKey: V2Key("runId"))
        attemptOrdinal = try c.decode(Int.self, forKey: V2Key("attemptOrdinal"))
        rootNodeId = try c.decode(String.self, forKey: V2Key("rootNodeId"))
        providerInstanceId = try c.decode(String.self, forKey: V2Key("providerInstanceId"))
        providerThreadId = try c.decode(String.self, forKey: V2Key("providerThreadId"))
        providerTurnId = try c.decode(String?.self, forKey: V2Key("providerTurnId"))
        reason = try c.decode(String.self, forKey: V2Key("reason"))
        status = try c.decode(String.self, forKey: V2Key("status"))
        startedAt = try c.decode(String?.self, forKey: V2Key("startedAt"))
        completedAt = try c.decode(String?.self, forKey: V2Key("completedAt"))
    }
}

public struct OrchestrationV2ExecutionNode: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let threadId: String
    public let runId: String?
    public let parentNodeId: String?
    public let rootNodeId: String
    public let kind: String
    public let status: String
    public let countsForRun: Bool
    public let providerThreadId: String?
    public let providerTurnId: String?
    public let nativeItemRef: OrchestrationV2ProviderRef?
    public let runtimeRequestId: String?
    public let checkpointScopeId: String?
    public let startedAt: String?
    public let completedAt: String?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        threadId = try c.decode(String.self, forKey: V2Key("threadId"))
        runId = try c.decode(String?.self, forKey: V2Key("runId"))
        parentNodeId = try c.decode(String?.self, forKey: V2Key("parentNodeId"))
        rootNodeId = try c.decode(String.self, forKey: V2Key("rootNodeId"))
        kind = try c.decode(String.self, forKey: V2Key("kind"))
        status = try c.decode(String.self, forKey: V2Key("status"))
        countsForRun = try c.decode(Bool.self, forKey: V2Key("countsForRun"))
        providerThreadId = try c.decode(String?.self, forKey: V2Key("providerThreadId"))
        providerTurnId = try c.decode(String?.self, forKey: V2Key("providerTurnId"))
        nativeItemRef = try c.decode(OrchestrationV2ProviderRef?.self, forKey: V2Key("nativeItemRef"))
        runtimeRequestId = try c.decode(String?.self, forKey: V2Key("runtimeRequestId"))
        checkpointScopeId = try c.decode(String?.self, forKey: V2Key("checkpointScopeId"))
        startedAt = try c.decode(String?.self, forKey: V2Key("startedAt"))
        completedAt = try c.decode(String?.self, forKey: V2Key("completedAt"))
    }
}

public struct OrchestrationV2Subagent: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let threadId: String
    public let runId: String?
    public let parentNodeId: String
    public let origin: String
    public let createdBy: String
    public let driver: String
    public let providerInstanceId: String
    public let providerThreadId: String?
    public let childThreadId: String?
    public let nativeTaskRef: OrchestrationV2ProviderRef?
    public let prompt: String
    public let title: String?
    public let model: String?
    public let status: String
    public let progress: String?
    public let result: String?
    public let startedAt: String?
    public let completedAt: String?
    public let updatedAt: String
    public let completionWake: String?
    public let completionDelivery: JSONValue?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        threadId = try c.decode(String.self, forKey: V2Key("threadId"))
        runId = try c.decode(String?.self, forKey: V2Key("runId"))
        parentNodeId = try c.decode(String.self, forKey: V2Key("parentNodeId"))
        origin = try c.decode(String.self, forKey: V2Key("origin"))
        createdBy = try c.decode(String.self, forKey: V2Key("createdBy"))
        driver = try c.decode(String.self, forKey: V2Key("driver"))
        providerInstanceId = try c.decode(String.self, forKey: V2Key("providerInstanceId"))
        providerThreadId = try c.decode(String?.self, forKey: V2Key("providerThreadId"))
        childThreadId = try c.decode(String?.self, forKey: V2Key("childThreadId"))
        nativeTaskRef = try c.decode(OrchestrationV2ProviderRef?.self, forKey: V2Key("nativeTaskRef"))
        prompt = try c.decode(String.self, forKey: V2Key("prompt"))
        title = try c.decode(String?.self, forKey: V2Key("title"))
        model = try c.decode(String?.self, forKey: V2Key("model"))
        status = try c.decode(String.self, forKey: V2Key("status"))
        progress = try c.decodeIfPresent(String.self, forKey: V2Key("progress"))
        result = try c.decode(String?.self, forKey: V2Key("result"))
        startedAt = try c.decode(String?.self, forKey: V2Key("startedAt"))
        completedAt = try c.decode(String?.self, forKey: V2Key("completedAt"))
        updatedAt = try c.decode(String.self, forKey: V2Key("updatedAt"))
        completionWake = try c.decodeIfPresent(String.self, forKey: V2Key("completionWake"))
        completionDelivery = try c.decodeIfPresent(JSONValue.self, forKey: V2Key("completionDelivery"))
    }
}

public struct OrchestrationV2CheckpointScope: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let threadId: String
    public let runId: String?
    public let nodeId: String
    public let parentScopeId: String?
    public let providerThreadId: String?
    public let kind: String
    public let ordinalWithinParent: Int
    public let advancesAppRunCount: Bool
    public let cwd: String
    public let createdAt: String

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        threadId = try c.decode(String.self, forKey: V2Key("threadId"))
        runId = try c.decode(String?.self, forKey: V2Key("runId"))
        nodeId = try c.decode(String.self, forKey: V2Key("nodeId"))
        parentScopeId = try c.decode(String?.self, forKey: V2Key("parentScopeId"))
        providerThreadId = try c.decode(String?.self, forKey: V2Key("providerThreadId"))
        kind = try c.decode(String.self, forKey: V2Key("kind"))
        ordinalWithinParent = try c.decode(Int.self, forKey: V2Key("ordinalWithinParent"))
        advancesAppRunCount = try c.decode(Bool.self, forKey: V2Key("advancesAppRunCount"))
        cwd = try c.decode(String.self, forKey: V2Key("cwd"))
        createdAt = try c.decode(String.self, forKey: V2Key("createdAt"))
    }
}

public struct OrchestrationV2ProviderSession: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let driver: String
    public let providerInstanceId: String
    public let status: String
    public let cwd: String
    public let model: String?
    public let capabilities: JSONValue
    public let createdAt: String
    public let updatedAt: String
    public let lastError: String?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        driver = try c.decode(String.self, forKey: V2Key("driver"))
        providerInstanceId = try c.decode(String.self, forKey: V2Key("providerInstanceId"))
        status = try c.decode(String.self, forKey: V2Key("status"))
        cwd = try c.decode(String.self, forKey: V2Key("cwd"))
        model = try c.decode(String?.self, forKey: V2Key("model"))
        capabilities = try c.decode(JSONValue.self, forKey: V2Key("capabilities"))
        createdAt = try c.decode(String.self, forKey: V2Key("createdAt"))
        updatedAt = try c.decode(String.self, forKey: V2Key("updatedAt"))
        lastError = try c.decode(String?.self, forKey: V2Key("lastError"))
    }
}

/// Provider-owned goal state. Sending /goal uses the normal message path.
public struct OrchestrationV2ProviderGoal: Codable, Equatable, Hashable, Sendable {
    public enum Status: String, Codable, Hashable, Sendable {
        case active, paused, blocked, complete
        case usageLimited = "usage_limited"
        case budgetLimited = "budget_limited"
    }
    public let objective: String
    public let status: Status
    public let tokensUsed: Int?
    public let tokenBudget: Int?
    public let timeUsedSeconds: Int?
    public let checks: Int?
    public let lastCheck: String?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        objective = try c.decode(String.self, forKey: V2Key("objective"))
        status = try c.decode(Status.self, forKey: V2Key("status"))
        tokensUsed = try c.decodeIfPresent(Int.self, forKey: V2Key("tokensUsed"))
        tokenBudget = try c.decodeIfPresent(Int.self, forKey: V2Key("tokenBudget"))
        timeUsedSeconds = try c.decodeIfPresent(Int.self, forKey: V2Key("timeUsedSeconds"))
        checks = try c.decodeIfPresent(Int.self, forKey: V2Key("checks"))
        lastCheck = try c.decodeIfPresent(String.self, forKey: V2Key("lastCheck"))
        guard !objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              [tokensUsed, tokenBudget, timeUsedSeconds, checks].compactMap({ $0 }).allSatisfy({ $0 >= 0 }) else {
            throw OrchestrationV2StateError.invalidPayload("goal")
        }
    }
}

/// Request metadata only. A secret value never belongs in a projected item.
public struct OrchestrationV2SecretRequest: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable {
        case pending, saved, declined, cancelled
    }
    public let label: String
    public let reason: String
    public let placeholder: String?
    public let status: Status

    private enum CodingKeys: String, CodingKey {
        case label, reason, placeholder
        case status = "secretStatus"
    }
}

public struct OrchestrationV2ProviderThread: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let driver: String
    public let providerInstanceId: String
    public let providerSessionId: String?
    public let appThreadId: String?
    public let ownerNodeId: String?
    public let nativeThreadRef: OrchestrationV2ProviderRef?
    public let nativeConversationHeadRef: OrchestrationV2ProviderRef?
    public let status: String
    public let firstRunOrdinal: Int?
    public let lastRunOrdinal: Int?
    public let handoffIds: [String]
    public let forkedFrom: JSONValue?
    public let pendingBackgroundTasks: [JSONValue]
    public let goal: OrchestrationV2ProviderGoal?
    public let contextUsage: JSONValue?
    public let nativeMetadata: JSONValue?
    public let createdAt: String
    public let updatedAt: String

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        driver = try c.decode(String.self, forKey: V2Key("driver"))
        providerInstanceId = try c.decode(String.self, forKey: V2Key("providerInstanceId"))
        providerSessionId = try c.decode(String?.self, forKey: V2Key("providerSessionId"))
        appThreadId = try c.decode(String?.self, forKey: V2Key("appThreadId"))
        ownerNodeId = try c.decode(String?.self, forKey: V2Key("ownerNodeId"))
        nativeThreadRef = try c.decode(OrchestrationV2ProviderRef?.self, forKey: V2Key("nativeThreadRef"))
        nativeConversationHeadRef = try c.decode(OrchestrationV2ProviderRef?.self, forKey: V2Key("nativeConversationHeadRef"))
        status = try c.decode(String.self, forKey: V2Key("status"))
        firstRunOrdinal = try c.decode(Int?.self, forKey: V2Key("firstRunOrdinal"))
        lastRunOrdinal = try c.decode(Int?.self, forKey: V2Key("lastRunOrdinal"))
        handoffIds = try c.decode([String].self, forKey: V2Key("handoffIds"))
        forkedFrom = try c.decode(JSONValue?.self, forKey: V2Key("forkedFrom"))
        pendingBackgroundTasks = try c.decodeIfPresent([JSONValue].self, forKey: V2Key("pendingBackgroundTasks")) ?? []
        goal = try c.decodeIfPresent(OrchestrationV2ProviderGoal.self, forKey: V2Key("goal"))
        contextUsage = try c.decodeIfPresent(JSONValue.self, forKey: V2Key("contextUsage"))
        nativeMetadata = try c.decodeIfPresent(JSONValue.self, forKey: V2Key("nativeMetadata"))
        createdAt = try c.decode(String.self, forKey: V2Key("createdAt"))
        updatedAt = try c.decode(String.self, forKey: V2Key("updatedAt"))
    }
}

public struct OrchestrationV2TokenUsage: OrchestrationV2Record {
    public let raw: JSONValue
    public let usedTokens: Int
    public let maxTokens: Int?
    public let inputTokens: Int?
    public let cachedInputTokens: Int?
    public let outputTokens: Int?
    public let reasoningOutputTokens: Int?
    public let updatedAt: String

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        usedTokens = try c.decode(Int.self, forKey: V2Key("usedTokens"))
        maxTokens = try c.decodeIfPresent(Int.self, forKey: V2Key("maxTokens"))
        inputTokens = try c.decodeIfPresent(Int.self, forKey: V2Key("inputTokens"))
        cachedInputTokens = try c.decodeIfPresent(Int.self, forKey: V2Key("cachedInputTokens"))
        outputTokens = try c.decodeIfPresent(Int.self, forKey: V2Key("outputTokens"))
        reasoningOutputTokens = try c.decodeIfPresent(Int.self, forKey: V2Key("reasoningOutputTokens"))
        updatedAt = try c.decode(String.self, forKey: V2Key("updatedAt"))
    }
}

public struct OrchestrationV2ProviderTurn: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let providerThreadId: String
    public let nodeId: String
    public let runAttemptId: String?
    public let nativeTurnRef: OrchestrationV2ProviderRef?
    public let ordinal: Int
    public let status: String
    public let startedAt: String?
    public let completedAt: String?
    public let tokenUsage: OrchestrationV2TokenUsage?
    public let turnTokenUsage: JSONValue?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        providerThreadId = try c.decode(String.self, forKey: V2Key("providerThreadId"))
        nodeId = try c.decode(String.self, forKey: V2Key("nodeId"))
        runAttemptId = try c.decode(String?.self, forKey: V2Key("runAttemptId"))
        nativeTurnRef = try c.decode(OrchestrationV2ProviderRef?.self, forKey: V2Key("nativeTurnRef"))
        ordinal = try c.decode(Int.self, forKey: V2Key("ordinal"))
        status = try c.decode(String.self, forKey: V2Key("status"))
        startedAt = try c.decode(String?.self, forKey: V2Key("startedAt"))
        completedAt = try c.decode(String?.self, forKey: V2Key("completedAt"))
        tokenUsage = try c.decodeIfPresent(OrchestrationV2TokenUsage.self, forKey: V2Key("tokenUsage"))
        turnTokenUsage = try c.decodeIfPresent(JSONValue.self, forKey: V2Key("turnTokenUsage"))
    }
}

public struct OrchestrationV2ResponseCapability: OrchestrationV2Record {
    public let raw: JSONValue
    public let type: String
    public let providerSessionId: String?
    public let reason: String?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        type = try c.decode(String.self, forKey: V2Key("type"))
        providerSessionId = try c.decodeIfPresent(String.self, forKey: V2Key("providerSessionId"))
        reason = try c.decodeIfPresent(String.self, forKey: V2Key("reason"))
        switch type {
        case "live":
            guard providerSessionId != nil else { throw OrchestrationV2StateError.invalidPayload("providerSessionId") }
        case "not_resumable":
            guard reason != nil else { throw OrchestrationV2StateError.invalidPayload("reason") }
        case "message": break
        default: throw OrchestrationV2StateError.invalidPayload("responseCapability.type")
        }
    }
}

public struct OrchestrationV2RuntimeRequest: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let nodeId: String
    public let providerTurnId: String?
    public let nativeRequestRef: OrchestrationV2ProviderRef?
    public let kind: String
    public let status: String
    public let responseCapability: OrchestrationV2ResponseCapability
    public let createdAt: String
    public let resolvedAt: String?
    public let decision: String?
    public let answers: JSONValue?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        nodeId = try c.decode(String.self, forKey: V2Key("nodeId"))
        providerTurnId = try c.decode(String?.self, forKey: V2Key("providerTurnId"))
        nativeRequestRef = try c.decode(OrchestrationV2ProviderRef?.self, forKey: V2Key("nativeRequestRef"))
        kind = try c.decode(String.self, forKey: V2Key("kind"))
        status = try c.decode(String.self, forKey: V2Key("status"))
        responseCapability = try c.decode(OrchestrationV2ResponseCapability.self, forKey: V2Key("responseCapability"))
        createdAt = try c.decode(String.self, forKey: V2Key("createdAt"))
        resolvedAt = try c.decode(String?.self, forKey: V2Key("resolvedAt"))
        decision = try c.decodeIfPresent(String.self, forKey: V2Key("decision"))
        answers = try c.decodeIfPresent(JSONValue.self, forKey: V2Key("answers"))
    }
}

public struct OrchestrationV2ConversationMessage: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let threadId: String
    public let runId: String?
    public let nodeId: String?
    public let role: String
    public let text: String
    public let context: OrchestrationMessageContext?
    public let attachments: [ChatAttachment]
    public let streaming: Bool
    public let createdAt: String
    public let updatedAt: String
    public let createdBy: String
    public let creationSource: String
    public let scheduledTaskId: String?
    public let senderThreadId: String?
    public let notification: JSONValue?
    public let delegatedCompletion: JSONValue?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        threadId = try c.decode(String.self, forKey: V2Key("threadId"))
        runId = try c.decode(String?.self, forKey: V2Key("runId"))
        nodeId = try c.decode(String?.self, forKey: V2Key("nodeId"))
        role = try c.decode(String.self, forKey: V2Key("role"))
        text = try c.decode(String.self, forKey: V2Key("text"))
        context = try c.decodeIfPresent(OrchestrationMessageContext.self, forKey: V2Key("context"))
        attachments = try c.decode([ChatAttachment].self, forKey: V2Key("attachments"))
        streaming = try c.decode(Bool.self, forKey: V2Key("streaming"))
        createdAt = try c.decode(String.self, forKey: V2Key("createdAt"))
        updatedAt = try c.decode(String.self, forKey: V2Key("updatedAt"))
        createdBy = try c.decode(String.self, forKey: V2Key("createdBy"))
        creationSource = try c.decode(String.self, forKey: V2Key("creationSource"))
        scheduledTaskId = try c.decodeIfPresent(String.self, forKey: V2Key("scheduledTaskId"))
        senderThreadId = try c.decodeIfPresent(String.self, forKey: V2Key("senderThreadId"))
        notification = try c.decodeIfPresent(JSONValue.self, forKey: V2Key("notification"))
        delegatedCompletion = try c.decodeIfPresent(JSONValue.self, forKey: V2Key("delegatedCompletion"))
    }
}

public struct OrchestrationV2PlanStep: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let text: String
    public let status: String
    public let durationAnchorAt: String?
    public let durationMs: Int?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        text = try c.decode(String.self, forKey: V2Key("text"))
        status = try c.decode(String.self, forKey: V2Key("status"))
        durationAnchorAt = try c.decodeIfPresent(String.self, forKey: V2Key("durationAnchorAt"))
        durationMs = try c.decodeIfPresent(Int.self, forKey: V2Key("durationMs"))
    }
}

public struct OrchestrationV2PlanArtifact: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let threadId: String
    public let runId: String?
    public let nodeId: String
    public let status: String
    public let kind: String
    public let markdown: String?
    public let steps: [OrchestrationV2PlanStep]?
    public let explanation: String?
    public let detailInTurnItem: Bool?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        threadId = try c.decode(String.self, forKey: V2Key("threadId"))
        runId = try c.decode(String?.self, forKey: V2Key("runId"))
        nodeId = try c.decode(String.self, forKey: V2Key("nodeId"))
        status = try c.decode(String.self, forKey: V2Key("status"))
        kind = try c.decode(String.self, forKey: V2Key("kind"))
        markdown = try c.decodeIfPresent(String.self, forKey: V2Key("markdown"))
        steps = try c.decodeIfPresent([OrchestrationV2PlanStep].self, forKey: V2Key("steps"))
        explanation = try c.decodeIfPresent(String.self, forKey: V2Key("explanation"))
        detailInTurnItem = try c.decodeIfPresent(Bool.self, forKey: V2Key("detailInTurnItem"))
        guard (kind == "proposed_plan" && markdown != nil) || (kind == "todo_list" && steps != nil) else {
            throw OrchestrationV2StateError.invalidPayload("plan")
        }
    }
}

public struct OrchestrationV2Checkpoint: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let threadId: String
    public let scopeId: String
    public let runId: String?
    public let nodeId: String
    public let parentCheckpointId: String?
    public let ordinalWithinScope: Int
    public let appRunOrdinal: Int?
    public let ref: String
    public let status: String
    public let files: [CheckpointFile]
    public let capturedAt: String

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        threadId = try c.decode(String.self, forKey: V2Key("threadId"))
        scopeId = try c.decode(String.self, forKey: V2Key("scopeId"))
        runId = try c.decode(String?.self, forKey: V2Key("runId"))
        nodeId = try c.decode(String.self, forKey: V2Key("nodeId"))
        parentCheckpointId = try c.decode(String?.self, forKey: V2Key("parentCheckpointId"))
        ordinalWithinScope = try c.decode(Int.self, forKey: V2Key("ordinalWithinScope"))
        appRunOrdinal = try c.decode(Int?.self, forKey: V2Key("appRunOrdinal"))
        ref = try c.decode(String.self, forKey: V2Key("ref"))
        status = try c.decode(String.self, forKey: V2Key("status"))
        files = try c.decode([CheckpointFile].self, forKey: V2Key("files"))
        capturedAt = try c.decode(String.self, forKey: V2Key("capturedAt"))
    }
}

public struct OrchestrationV2ContextHandoff: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let transferId: String?
    public let threadId: String
    public let targetRunId: String
    public let fromProviderThreadIds: [String]
    public let toProviderThreadId: String
    public let coveredRunOrdinals: JSONValue
    public let strategy: String
    public let status: String
    public let summaryMessageId: String?
    public let summaryText: String
    public let history: JSONValue?
    public let delivery: JSONValue?
    public let detailInTurnItem: Bool?
    public let createdByProviderInstanceId: String?
    public let createdAt: String
    public let updatedAt: String

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        transferId = try c.decodeIfPresent(String.self, forKey: V2Key("transferId"))
        threadId = try c.decode(String.self, forKey: V2Key("threadId"))
        targetRunId = try c.decode(String.self, forKey: V2Key("targetRunId"))
        fromProviderThreadIds = try c.decode([String].self, forKey: V2Key("fromProviderThreadIds"))
        toProviderThreadId = try c.decode(String.self, forKey: V2Key("toProviderThreadId"))
        coveredRunOrdinals = try c.decode(JSONValue.self, forKey: V2Key("coveredRunOrdinals"))
        strategy = try c.decode(String.self, forKey: V2Key("strategy"))
        status = try c.decode(String.self, forKey: V2Key("status"))
        summaryMessageId = try c.decode(String?.self, forKey: V2Key("summaryMessageId"))
        summaryText = try c.decode(String.self, forKey: V2Key("summaryText"))
        history = try c.decodeIfPresent(JSONValue.self, forKey: V2Key("history"))
        delivery = try c.decodeIfPresent(JSONValue.self, forKey: V2Key("delivery"))
        detailInTurnItem = try c.decodeIfPresent(Bool.self, forKey: V2Key("detailInTurnItem"))
        createdByProviderInstanceId = try c.decode(String?.self, forKey: V2Key("createdByProviderInstanceId"))
        createdAt = try c.decode(String.self, forKey: V2Key("createdAt"))
        updatedAt = try c.decode(String.self, forKey: V2Key("updatedAt"))
    }
}

public struct OrchestrationV2ContextTransfer: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let type: String
    public let sourceThreadId: String
    public let targetThreadId: String
    public let sourcePoint: JSONValue
    public let basePoint: JSONValue?
    public let sourceProviderInstanceId: String?
    public let targetProviderInstanceId: String?
    public let targetRunId: String?
    public let status: String
    public let resolution: JSONValue?
    public let createdBy: String
    public let error: String?
    public let createdAt: String
    public let updatedAt: String
    public let consumedAt: String?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        type = try c.decode(String.self, forKey: V2Key("type"))
        sourceThreadId = try c.decode(String.self, forKey: V2Key("sourceThreadId"))
        targetThreadId = try c.decode(String.self, forKey: V2Key("targetThreadId"))
        sourcePoint = try c.decode(JSONValue.self, forKey: V2Key("sourcePoint"))
        basePoint = try c.decode(JSONValue?.self, forKey: V2Key("basePoint"))
        sourceProviderInstanceId = try c.decode(String?.self, forKey: V2Key("sourceProviderInstanceId"))
        targetProviderInstanceId = try c.decode(String?.self, forKey: V2Key("targetProviderInstanceId"))
        targetRunId = try c.decode(String?.self, forKey: V2Key("targetRunId"))
        status = try c.decode(String.self, forKey: V2Key("status"))
        resolution = try c.decode(JSONValue?.self, forKey: V2Key("resolution"))
        createdBy = try c.decode(String.self, forKey: V2Key("createdBy"))
        error = try c.decode(String?.self, forKey: V2Key("error"))
        createdAt = try c.decode(String.self, forKey: V2Key("createdAt"))
        updatedAt = try c.decode(String.self, forKey: V2Key("updatedAt"))
        consumedAt = try c.decode(String?.self, forKey: V2Key("consumedAt"))
    }
}

public struct OrchestrationV2InputOption: OrchestrationV2Record {
    public let raw: JSONValue
    public let label: String
    public let description: String
    public let value: String?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        label = try c.decode(String.self, forKey: V2Key("label"))
        description = try c.decode(String.self, forKey: V2Key("description"))
        value = try c.decodeIfPresent(String.self, forKey: V2Key("value"))
    }
}

public struct OrchestrationV2InputQuestion: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let header: String
    public let question: String
    public let options: [OrchestrationV2InputOption]
    public let multiSelect: Bool?
    public let allowCustomAnswer: Bool?
    public let initialAnswer: String?
    public let required: Bool?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        id = try c.decode(String.self, forKey: V2Key("id"))
        header = try c.decode(String.self, forKey: V2Key("header"))
        question = try c.decode(String.self, forKey: V2Key("question"))
        options = try c.decode([OrchestrationV2InputOption].self, forKey: V2Key("options"))
        multiSelect = try c.decodeIfPresent(Bool.self, forKey: V2Key("multiSelect"))
        allowCustomAnswer = try c.decodeIfPresent(Bool.self, forKey: V2Key("allowCustomAnswer"))
        initialAnswer = try c.decodeIfPresent(String.self, forKey: V2Key("initialAnswer"))
        required = try c.decodeIfPresent(Bool.self, forKey: V2Key("required"))
    }
}

public struct OrchestrationV2ProviderFailure: OrchestrationV2Record {
    public let raw: JSONValue
    public let `class`: String
    public let message: String
    public let code: String?
    public let retryable: Bool?
    public let resetAt: String?

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        `class` = try c.decode(String.self, forKey: V2Key("class"))
        message = try c.decode(String.self, forKey: V2Key("message"))
        code = try c.decode(String?.self, forKey: V2Key("code"))
        retryable = try c.decode(Bool?.self, forKey: V2Key("retryable"))
        resetAt = try c.decodeIfPresent(String.self, forKey: V2Key("resetAt"))
    }
}

/// Each case is an actual V2 turn-item variant. Provider-defined tool input/output
/// remain JSON; identity, lifecycle, requests and content have native types.
public enum OrchestrationV2TurnItemContent: Equatable, Sendable {
    case userMessage(messageID: String, inputIntent: String, text: String, attachments: [ChatAttachment], context: OrchestrationMessageContext?)
    case assistantMessage(messageID: String, text: String, streaming: Bool, attachments: [ChatAttachment]?)
    case reasoning(text: String, streaming: Bool)
    case proposedPlan(planID: String, markdown: String, streaming: Bool)
    case todoList(planID: String, steps: [OrchestrationV2PlanStep], explanation: String?)
    case userInput(requestID: String, questions: [OrchestrationV2InputQuestion], responseMode: String?)
    case approval(requestID: String, requestKind: String, prompt: String?)
    case secretRequest(OrchestrationV2SecretRequest)
    case fileChange(fileName: String)
    case command(input: String, output: String?, exitCode: Int?)
    case fileSearch(pattern: String?)
    case webSearch(patterns: [String]?)
    case checkpoint(checkpointID: String, scopeID: String, files: [CheckpointFile])
    case interruptRequest(message: String)
    case interruptResult(message: String)
    case systemNotice(message: String)
    case failure(OrchestrationV2ProviderFailure)
    case compaction(summary: String?)
    case handoff(contextHandoffID: String, summary: String?)
    case fork(targetThreadID: String)
    case threadCreated(targetThreadID: String, targetRunID: String?, model: String)
    case subagent(subagentID: String, childThreadID: String?, prompt: String, progress: String?, result: String?)
    case tool(name: String?, input: JSONValue, output: JSONValue?)
    case notification(summary: String, detail: String?, outcome: String)
}

public struct OrchestrationV2TurnItem: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let id: String
    public let threadId: String
    public let runId: String?
    public let nodeId: String?
    public let providerThreadId: String?
    public let providerTurnId: String?
    public let parentItemId: String?
    public let ordinal: Int
    public let status: String
    public let title: String?
    public let startedAt: String?
    public let completedAt: String?
    public let updatedAt: String
    public let type: String
    public let content: OrchestrationV2TurnItemContent

    /// Only unknown string tags are skippable. Missing or malformed tags are errors.
    static func isKnownType(_ type: String) -> Bool {
        knownTypes.contains(type)
    }
    private static let knownTypes: Set<String> = [
        "user_message", "assistant_message", "reasoning", "proposed_plan", "todo_list",
        "user_input_request", "approval_request", "secret_request", "file_change",
        "command_execution", "file_search", "web_search", "checkpoint", "run_interrupt_request",
        "run_interrupt_result", "system_notice", "error", "compaction", "handoff", "fork",
        "thread_created", "subagent", "dynamic_tool", "notification",
    ]

    public var isActive: Bool { ["pending", "running", "waiting"].contains(status) }
    public var requestID: String? {
        switch content {
        case let .userInput(id, _, _), let .approval(id, _, _): id
        default: nil
        }
    }
    public var inputIntent: String? {
        if case let .userMessage(_, intent, _, _, _) = content { return intent }
        return nil
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        func required<T: Decodable>(_ key: String, _ type: T.Type = T.self) throws -> T {
            try c.decode(type, forKey: V2Key(key))
        }
        func optional<T: Decodable>(_ key: String, _ type: T.Type = T.self) throws -> T? {
            try c.decodeIfPresent(type, forKey: V2Key(key))
        }
        id = try required("id")
        threadId = try required("threadId")
        runId = try required("runId")
        nodeId = try required("nodeId")
        providerThreadId = try optional("providerThreadId") // fork variants make this optional
        providerTurnId = try required("providerTurnId")
        let _: OrchestrationV2ProviderRef? = try required("nativeItemRef")
        parentItemId = try required("parentItemId")
        ordinal = try required("ordinal")
        status = try required("status")
        title = try required("title")
        startedAt = try required("startedAt")
        completedAt = try required("completedAt")
        updatedAt = try required("updatedAt")
        type = try required("type")
        guard ordinal >= 0 else { throw OrchestrationV2StateError.invalidPayload("ordinal") }
        switch type {
        case "user_message":
            let _: String = try required("createdBy")
            let _: String = try required("creationSource")
            content = try .userMessage(messageID: required("messageId"), inputIntent: required("inputIntent"), text: required("text"), attachments: required("attachments"), context: optional("context"))
        case "assistant_message":
            content = try .assistantMessage(messageID: required("messageId"), text: required("text"), streaming: required("streaming"), attachments: optional("attachments"))
        case "reasoning":
            content = try .reasoning(text: required("text"), streaming: required("streaming"))
        case "proposed_plan":
            content = try .proposedPlan(planID: required("planId"), markdown: required("markdown"), streaming: required("streaming"))
        case "todo_list":
            content = try .todoList(planID: required("planId"), steps: required("steps"), explanation: optional("explanation"))
        case "user_input_request":
            content = try .userInput(requestID: required("requestId"), questions: required("questions"), responseMode: optional("responseMode"))
        case "approval_request":
            content = try .approval(requestID: required("requestId"), requestKind: required("requestKind"), prompt: optional("prompt"))
        case "secret_request": content = .secretRequest(try OrchestrationV2SecretRequest(from: decoder))
        case "file_change": content = try .fileChange(fileName: required("fileName"))
        case "command_execution": content = try .command(input: required("input"), output: optional("output"), exitCode: optional("exitCode"))
        case "file_search": content = try .fileSearch(pattern: optional("pattern"))
        case "web_search": content = try .webSearch(patterns: optional("patterns"))
        case "checkpoint": content = try .checkpoint(checkpointID: required("checkpointId"), scopeID: required("scopeId"), files: required("files"))
        case "run_interrupt_request": content = try .interruptRequest(message: required("message"))
        case "run_interrupt_result": content = try .interruptResult(message: required("message"))
        case "system_notice": content = try .systemNotice(message: required("message"))
        case "error": content = try .failure(required("failure"))
        case "compaction":
            let _: String? = try required("driver")
            content = try .compaction(summary: optional("summary"))
        case "handoff":
            let _: [String] = try required("fromProviderThreadIds")
            let _: String = try required("toProviderThreadId")
            let _: [String] = try required("fromProviderInstanceIds")
            let _: String = try required("toProviderInstanceId")
            let _: String = try required("strategy")
            content = try .handoff(contextHandoffID: required("contextHandoffId"), summary: optional("summary"))
        case "fork":
            let _: JSONValue = try required("source")
            content = try .fork(targetThreadID: required("targetThreadId"))
        case "thread_created":
            let _: String = try required("targetProviderInstanceId")
            content = try .threadCreated(targetThreadID: required("targetThreadId"), targetRunID: required("targetRunId"), model: required("targetModel"))
        case "subagent":
            let _: String = try required("origin")
            let _: String = try required("driver")
            let _: String = try required("providerInstanceId")
            content = try .subagent(subagentID: required("subagentId"), childThreadID: required("childThreadId"), prompt: required("prompt"), progress: optional("progress"), result: required("result"))
        case "dynamic_tool": content = try .tool(name: required("toolName"), input: required("input"), output: optional("output"))
        case "notification":
            let _: JSONValue = try required("source")
            content = try .notification(summary: required("summary"), detail: optional("detail"), outcome: required("outcome"))
        default: throw OrchestrationV2StateError.invalidPayload("turn item type: \(type)")
        }
    }
}

public struct OrchestrationV2ProjectedTurnItem: Codable, Equatable, Sendable, Identifiable {
    public internal(set) var position: Int
    public let visibility: String
    public let sourceThreadId: String
    public let sourceItemId: String
    public internal(set) var item: OrchestrationV2TurnItem
    /// Length-prefixed source identity cannot collide when IDs contain punctuation.
    public var id: String { "\(sourceThreadId.utf8.count):\(sourceThreadId)\(sourceItemId)" }
    public var isLocal: Bool { visibility == "local" }
}

public struct OrchestrationV2ThreadSnapshot: Decodable, Sendable {
    public let snapshotSequence: Int
    public let projection: OrchestrationV2ThreadProjection
    public let historyCursor: String?
    public let hasMoreHistory: Bool?
    public let latestLocalTurnOrdinal: Int?
    public let payloadBudgetExceeded: Bool?
}

public struct OrchestrationV2ThreadHistoryPage: Decodable, Sendable {
    public let snapshotSequence: Int
    public let items: [OrchestrationV2ProjectedTurnItem]
    public let nextCursor: String?
    public let hasMoreHistory: Bool

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        snapshotSequence = try c.decode(Int.self, forKey: V2Key("snapshotSequence"))
        items = try decodeKnownV2Items(c, key: "items", projected: true)
        nextCursor = try c.decodeIfPresent(String.self, forKey: V2Key("nextCursor"))
        hasMoreHistory = try c.decode(Bool.self, forKey: V2Key("hasMoreHistory"))
    }
}

public struct OrchestrationV2ThreadProjection: Codable, Equatable, Sendable {
    private let extraFields: [String: JSONValue]
    public internal(set) var thread: OrchestrationV2AppThread
    public internal(set) var runs: [OrchestrationV2Run]
    public internal(set) var attempts: [OrchestrationV2RunAttempt]
    public internal(set) var nodes: [OrchestrationV2ExecutionNode]
    public internal(set) var subagents: [OrchestrationV2Subagent]
    public internal(set) var providerSessions: [OrchestrationV2ProviderSession]
    public internal(set) var providerThreads: [OrchestrationV2ProviderThread]
    public internal(set) var providerTurns: [OrchestrationV2ProviderTurn]
    public internal(set) var runtimeRequests: [OrchestrationV2RuntimeRequest]
    public internal(set) var messages: [OrchestrationV2ConversationMessage]
    public internal(set) var plans: [OrchestrationV2PlanArtifact]
    public internal(set) var turnItems: [OrchestrationV2TurnItem]
    public internal(set) var checkpointScopes: [OrchestrationV2CheckpointScope]
    public internal(set) var checkpoints: [OrchestrationV2Checkpoint]
    public internal(set) var contextHandoffs: [OrchestrationV2ContextHandoff]
    public internal(set) var contextTransfers: [OrchestrationV2ContextTransfer]
    public internal(set) var visibleTurnItems: [OrchestrationV2ProjectedTurnItem]
    public internal(set) var updatedAt: String

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        let modeledKeys: Set<String> = [
            "thread", "runs", "attempts", "nodes", "subagents", "providerSessions", "providerThreads",
            "providerTurns", "runtimeRequests", "messages", "plans", "turnItems", "checkpointScopes",
            "checkpoints", "contextHandoffs", "contextTransfers", "visibleTurnItems", "updatedAt",
        ]
        extraFields = try c.allKeys.filter { !modeledKeys.contains($0.stringValue) }.reduce(into: [:]) {
            $0[$1.stringValue] = try c.decode(JSONValue.self, forKey: $1)
        }
        thread = try c.decode(OrchestrationV2AppThread.self, forKey: V2Key("thread"))
        runs = try c.decode([OrchestrationV2Run].self, forKey: V2Key("runs"))
        attempts = try c.decode([OrchestrationV2RunAttempt].self, forKey: V2Key("attempts"))
        nodes = try c.decode([OrchestrationV2ExecutionNode].self, forKey: V2Key("nodes"))
        subagents = try c.decode([OrchestrationV2Subagent].self, forKey: V2Key("subagents"))
        providerSessions = try c.decode([OrchestrationV2ProviderSession].self, forKey: V2Key("providerSessions"))
        providerThreads = try c.decode([OrchestrationV2ProviderThread].self, forKey: V2Key("providerThreads"))
        providerTurns = try c.decode([OrchestrationV2ProviderTurn].self, forKey: V2Key("providerTurns"))
        runtimeRequests = try c.decode([OrchestrationV2RuntimeRequest].self, forKey: V2Key("runtimeRequests"))
        messages = try c.decode([OrchestrationV2ConversationMessage].self, forKey: V2Key("messages"))
        plans = try c.decode([OrchestrationV2PlanArtifact].self, forKey: V2Key("plans"))
        turnItems = try decodeKnownV2Items(c, key: "turnItems", projected: false)
        checkpointScopes = try c.decode([OrchestrationV2CheckpointScope].self, forKey: V2Key("checkpointScopes"))
        checkpoints = try c.decode([OrchestrationV2Checkpoint].self, forKey: V2Key("checkpoints"))
        contextHandoffs = try c.decode([OrchestrationV2ContextHandoff].self, forKey: V2Key("contextHandoffs"))
        contextTransfers = try c.decode([OrchestrationV2ContextTransfer].self, forKey: V2Key("contextTransfers"))
        visibleTurnItems = try decodeKnownV2Items(c, key: "visibleTurnItems", projected: true)
        updatedAt = try c.decode(String.self, forKey: V2Key("updatedAt"))
    }

    public var raw: JSONValue {
        var fields = extraFields
        fields["thread"] = thread.raw
        fields["runs"] = .array(runs.map(\.raw))
        fields["attempts"] = .array(attempts.map(\.raw))
        fields["nodes"] = .array(nodes.map(\.raw))
        fields["subagents"] = .array(subagents.map(\.raw))
        fields["providerSessions"] = .array(providerSessions.map(\.raw))
        fields["providerThreads"] = .array(providerThreads.map(\.raw))
        fields["providerTurns"] = .array(providerTurns.map(\.raw))
        fields["runtimeRequests"] = .array(runtimeRequests.map(\.raw))
        fields["messages"] = .array(messages.map(\.raw))
        fields["plans"] = .array(plans.map(\.raw))
        fields["turnItems"] = .array(turnItems.map(\.raw))
        fields["checkpointScopes"] = .array(checkpointScopes.map(\.raw))
        fields["checkpoints"] = .array(checkpoints.map(\.raw))
        fields["contextHandoffs"] = .array(contextHandoffs.map(\.raw))
        fields["contextTransfers"] = .array(contextTransfers.map(\.raw))
        fields["visibleTurnItems"] = .array(visibleTurnItems.map { row in
            .object([
                "position": .number(Double(row.position)), "visibility": .string(row.visibility),
                "sourceThreadId": .string(row.sourceThreadId), "sourceItemId": .string(row.sourceItemId),
                "item": row.item.raw,
            ])
        })
        fields["updatedAt"] = .string(updatedAt)
        return .object(fields)
    }

    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }

    public var queuedRuns: [OrchestrationV2Run] {
        runs.filter { $0.status == "queued" }.sorted {
            let left = $0.queuePosition ?? $0.ordinal
            let right = $1.queuePosition ?? $1.ordinal
            return left == right ? $0.ordinal < $1.ordinal : left < right
        }
    }
}

public struct OrchestrationV2ThreadShell: OrchestrationV2Record, Identifiable {
    public let raw: JSONValue
    public let thread: OrchestrationV2AppThread
    public var id: String { thread.id }
    public let latestRunId: String?
    public let latestRunRequestedAt: String?
    public let latestRunStartedAt: String?
    public let latestRunCompletedAt: String?
    public let activeRunId: String?
    public let activityRunStartedAt: String?
    public let activityRunStatus: String?
    public let status: String
    public let lastError: String?
    public let pendingRuntimeRequest: OrchestrationV2PendingRequestSummary?
    public let latestVisibleMessage: JSONValue?
    public let latestUserMessageAt: String?
    public let hasActionableProposedPlan: Bool
    public let pendingBackgroundTasks: [JSONValue]
    public let goal: OrchestrationV2ProviderGoal?
    public let itemCount: Int
    public let visibleItemCount: Int

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: V2Key.self)
        raw = try JSONValue(from: decoder)
        thread = try OrchestrationV2AppThread(from: decoder)
        latestRunId = try c.decode(String?.self, forKey: V2Key("latestRunId"))
        latestRunRequestedAt = try c.decodeIfPresent(String.self, forKey: V2Key("latestRunRequestedAt"))
        latestRunStartedAt = try c.decodeIfPresent(String.self, forKey: V2Key("latestRunStartedAt"))
        latestRunCompletedAt = try c.decodeIfPresent(String.self, forKey: V2Key("latestRunCompletedAt"))
        activeRunId = try c.decode(String?.self, forKey: V2Key("activeRunId"))
        activityRunStartedAt = try c.decodeIfPresent(String.self, forKey: V2Key("activityRunStartedAt"))
        activityRunStatus = try c.decodeIfPresent(String.self, forKey: V2Key("activityRunStatus"))
        status = try c.decode(String.self, forKey: V2Key("status"))
        lastError = try c.decodeIfPresent(String.self, forKey: V2Key("lastError"))
        pendingRuntimeRequest = try c.decode(OrchestrationV2PendingRequestSummary?.self, forKey: V2Key("pendingRuntimeRequest"))
        latestVisibleMessage = try c.decode(JSONValue?.self, forKey: V2Key("latestVisibleMessage"))
        latestUserMessageAt = try c.decode(String?.self, forKey: V2Key("latestUserMessageAt"))
        hasActionableProposedPlan = try c.decode(Bool.self, forKey: V2Key("hasActionableProposedPlan"))
        pendingBackgroundTasks = try c.decodeIfPresent([JSONValue].self, forKey: V2Key("pendingBackgroundTasks")) ?? []
        goal = try c.decodeIfPresent(OrchestrationV2ProviderGoal.self, forKey: V2Key("goal"))
        itemCount = try c.decode(Int.self, forKey: V2Key("itemCount"))
        visibleItemCount = try c.decode(Int.self, forKey: V2Key("visibleItemCount"))
    }
}

public struct OrchestrationV2PendingRequestSummary: Codable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let createdAt: String
    public var isUserInput: Bool { kind == "user_input" }
    public var isApproval: Bool {
        !isUserInput && kind != "auth_refresh" && kind != "dynamic_tool_call"
    }
}

public struct OrchestrationV2ShellSnapshot: Decodable, Sendable {
    public let schemaVersion: Int
    public let snapshotSequence: Int
    public let projects: [OrchestrationProject]
    public let threads: [OrchestrationV2ThreadShell]
    public let archivedThreads: [OrchestrationV2ThreadShell]

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, snapshotSequence, projects, threads, archivedThreads
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        snapshotSequence = try container.decode(Int.self, forKey: .snapshotSequence)
        projects = try container.decode([OrchestrationProject].self, forKey: .projects)
        threads = try container.decode([OrchestrationV2ThreadShell].self, forKey: .threads)
        // The archive endpoint returns its rows in `threads` and has no
        // separate archivedThreads array.
        archivedThreads = container.contains(.archivedThreads)
            ? try container.decode([OrchestrationV2ThreadShell].self, forKey: .archivedThreads) : []
    }
}

/// Inspect only the discriminator before decoding the full known row. Do not use
/// lossy array decoding: a corrupt known row must still trigger a refresh.
private func decodeKnownV2Items<Item: Decodable>(
    _ container: KeyedDecodingContainer<V2Key>, key: String, projected: Bool
) throws -> [Item] {
    var rows = try container.nestedUnkeyedContainer(forKey: V2Key(key))
    var result: [Item] = []
    while !rows.isAtEnd {
        let decoder = try rows.superDecoder()
        let row = try decoder.container(keyedBy: V2Key.self)
        let item = projected ? try row.nestedContainer(keyedBy: V2Key.self, forKey: V2Key("item")) : row
        let type = try item.decode(String.self, forKey: V2Key("type"))
        if OrchestrationV2TurnItem.isKnownType(type) {
            result.append(try Item(from: decoder))
        }
    }
    return result
}
