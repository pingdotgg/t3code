import Foundation

/// Read models accept legacy intervals below one minute so those tasks can still be managed.
public enum ScheduledTaskSchedule: Equatable, Sendable, Codable {
    case interval(everyMs: Int)
    case fixedTime(timeOfDay: String, weekdays: [Int]?)
    case webhook(signature: ScheduledTaskWebhookSignature?, maxDeliveryAgeMinutes: Int?)

    public var isWebhook: Bool {
        if case .webhook = self { return true }
        return false
    }

    private enum CodingKeys: String, CodingKey { case type, everyMs, timeOfDay, weekdays, signature, maxDeliveryAgeMinutes }
    private enum Kind: String, Codable { case interval, fixedTime = "fixed_time", webhook }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(Kind.self, forKey: .type) {
        case .interval:
            self = .interval(everyMs: try c.decode(Int.self, forKey: .everyMs))
        case .webhook:
            self = .webhook(signature: try c.decodeIfPresent(ScheduledTaskWebhookSignature.self, forKey: .signature),
                            maxDeliveryAgeMinutes: try c.decodeIfPresent(Int.self, forKey: .maxDeliveryAgeMinutes))
        case .fixedTime:
            self = .fixedTime(timeOfDay: try c.decode(String.self, forKey: .timeOfDay),
                              weekdays: try c.decodeIfPresent([Int].self, forKey: .weekdays))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .interval(everyMs):
            try c.encode(Kind.interval, forKey: .type)
            try c.encode(everyMs, forKey: .everyMs)
        case let .webhook(signature, maxDeliveryAgeMinutes):
            try c.encode(Kind.webhook, forKey: .type)
            try c.encode(signature, forKey: .signature)
            try c.encode(maxDeliveryAgeMinutes, forKey: .maxDeliveryAgeMinutes)
        case let .fixedTime(timeOfDay, weekdays):
            try c.encode(Kind.fixedTime, forKey: .type)
            try c.encode(timeOfDay, forKey: .timeOfDay)
            try c.encodeIfPresent(weekdays, forKey: .weekdays)
        }
    }
}

/// Only public verification settings belong on the phone; omit the secret to preserve it on save.
public struct ScheduledTaskWebhookSignature: Codable, Equatable, Sendable {
    public let header: String
    public let encoding: String
    public let prefix: String
}

public struct ScheduledTaskWebhookEndpoint: Codable, Equatable, Sendable {
    public let path: String
    public let url: String?
    public let hasSecret: Bool
}

public enum ScheduledTaskWorkspaceStrategy: Equatable, Sendable, Codable {
    case root(branch: String? = nil)
    case existingWorktree(worktreePath: String, branch: String? = nil)
    case worktree(baseRef: String, branch: String? = nil, startFromOrigin: Bool? = nil)

    private enum CodingKeys: String, CodingKey { case type, branch, worktreePath, baseRef, startFromOrigin }
    private enum Kind: String, Codable { case root, existingWorktree = "existing_worktree", worktree }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let branch = try c.decodeIfPresent(String.self, forKey: .branch)
        switch try c.decode(Kind.self, forKey: .type) {
        case .root:
            self = .root(branch: branch)
        case .existingWorktree:
            self = .existingWorktree(worktreePath: try c.decode(String.self, forKey: .worktreePath), branch: branch)
        case .worktree:
            self = .worktree(baseRef: try c.decode(String.self, forKey: .baseRef), branch: branch,
                             startFromOrigin: try c.decodeIfPresent(Bool.self, forKey: .startFromOrigin))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .root(branch):
            try c.encode(Kind.root, forKey: .type)
            try c.encodeIfPresent(branch, forKey: .branch)
        case let .existingWorktree(worktreePath, branch):
            try c.encode(Kind.existingWorktree, forKey: .type)
            try c.encode(worktreePath, forKey: .worktreePath)
            try c.encodeIfPresent(branch, forKey: .branch)
        case let .worktree(baseRef, branch, startFromOrigin):
            try c.encode(Kind.worktree, forKey: .type)
            try c.encode(baseRef, forKey: .baseRef)
            try c.encodeIfPresent(branch, forKey: .branch)
            try c.encodeIfPresent(startFromOrigin, forKey: .startFromOrigin)
        }
    }
}

public enum ScheduledTaskRunStatus: String, Codable, Sendable {
    case never, running, succeeded, failed
}

public enum ScheduledTaskCreator: String, Codable, Sendable { case user, agent, system }
public enum ScheduledTaskCreationSource: String, Codable, Sendable { case web, mobile, mcp, provider, server }

public struct ScheduledTask: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let prompt: String
    public let enabled: Bool
    public let schedule: ScheduledTaskSchedule
    public let projectId: String
    public let threadId: String?
    public let workspaceStrategy: ScheduledTaskWorkspaceStrategy
    public let modelSelection: ModelSelection
    public let runtimeMode: RuntimeMode
    public let interactionMode: InteractionMode
    public let createdBy: ScheduledTaskCreator
    public let creationSource: ScheduledTaskCreationSource
    public let createdAt: String
    public let updatedAt: String
    public let nextRunAt: String?
    public let lastRunAt: String?
    public let lastRunStatus: ScheduledTaskRunStatus
    public let lastRunError: String?
    public let runCount: Int
    public var webhook: ScheduledTaskWebhookEndpoint? = nil
}

public struct ScheduledTaskListResult: Codable, Equatable, Sendable {
    @ForwardCompatibleArray public var tasks: [ScheduledTask]
}

public struct ScheduledTaskMutationResult: Codable, Equatable, Sendable {
    public let task: ScheduledTask
}

public struct ScheduledTaskDeleteResult: Codable, Equatable, Sendable {
    public let id: String
}

public struct ScheduledTaskUpsertInput: Codable, Equatable, Sendable {
    public var id: String?
    public var requireExisting: Bool?
    public var commandId: String?
    public var title: String
    public var prompt: String
    public var enabled: Bool
    public var schedule: ScheduledTaskSchedule
    public var projectId: String
    public var threadId: String?
    public var workspaceStrategy: ScheduledTaskWorkspaceStrategy
    public var modelSelection: ModelSelection
    public var runtimeMode: RuntimeMode
    public var interactionMode: InteractionMode
    public var createdBy: ScheduledTaskCreator?
    public var creationSource: ScheduledTaskCreationSource?
}
