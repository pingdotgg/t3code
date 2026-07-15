// Typed wire models for the "orchestration" RPC family (§3.1 of
// docs/wire-protocol.md), hand-ported 1:1 from
// packages/contracts/src/orchestration.ts. This is the v1 method subset:
// dispatchCommand (write path), getTurnDiff/getFullThreadDiff (diff panel),
// replayEvents (reconnect catch-up), getArchivedShellSnapshot/subscribeShell
// (project+thread sidebar), subscribeThread (chat timeline/approvals/
// checkpoints). Diagnostics/keybindings/source-control RPCs are out of v1
// scope (see apps/mac/ARCHITECTURE.md) and are not modeled here.
//
// Conventions (see WireCoding.swift / T3Error.swift for shared helpers):
//   - IsoDateTime is a plain wire `String` (not Foundation `Date`); see
//     OrchestrationMapping.swift for the ISO parsing helper the app layer
//     should use when it needs a `Date`.
//   - Branded ids (ThreadId, ProjectId, CommandId, ...) are plain `String`.
//   - `Schema.NullOr(x)` (required key, value-or-null) -> Swift `Optional`.
//     Swift's synthesized *decode* already handles both "absent key" and
//     "present but null" via `decodeIfPresent`, so no special decode-side
//     handling is needed. Synthesized *encode*, however, uses
//     `encodeIfPresent` (which OMITS the key for `nil`) — that is wrong for
//     a bare (non-optional) `NullOr` field, where the key must stay present
//     with an explicit `null`. The two command structs that carry a
//     required `NullOr` field (`ThreadCreateCommand`,
//     `ThreadTurnStartBootstrapCreateThread`) therefore implement a manual
//     `encode(to:)`. Everywhere else optional-with-omission is correct.
//   - `Schema.withDecodingDefault(...)` fields get a manual `init(from:)`
//     using `WireCoding`'s `decode(_:forKey:default:)` helper.

import Foundation

// MARK: - Shared enums / value types

public enum RuntimeMode: String, Codable, Sendable {
    case approvalRequired = "approval-required"
    case autoAcceptEdits = "auto-accept-edits"
    case fullAccess = "full-access"

    public static let wireDefault: RuntimeMode = .fullAccess
}

public enum ProviderInteractionMode: String, Codable, Sendable {
    case `default`
    case plan
    case advisor

    public static let wireDefault: ProviderInteractionMode = .default
}

public enum ProviderApprovalDecision: String, Codable, Sendable {
    case accept
    case acceptForSession
    case decline
    case cancel
}

/// `Schema.Record(Schema.String, Schema.Unknown)` — free-form answers keyed
/// by prompt id.
public typealias ProviderUserInputAnswers = [String: JSONValue]

public enum ProviderApprovalPolicy: String, Codable, Sendable {
    case untrusted
    case onFailure = "on-failure"
    case onRequest = "on-request"
    case never
}

public enum ProviderSandboxMode: String, Codable, Sendable {
    case readOnly = "read-only"
    case workspaceWrite = "workspace-write"
    case dangerFullAccess = "danger-full-access"
}

/// `ProviderOptionSelectionValue = Union([TrimmedNonEmptyString, Boolean])`.
public enum ProviderOptionSelectionValue: Codable, Sendable, Hashable {
    case string(String)
    case bool(Bool)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else {
            self = .string(try container.decode(String.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        }
    }
}

public struct ProviderOptionSelection: Codable, Sendable, Hashable {
    public var id: String
    public var value: ProviderOptionSelectionValue

    public init(id: String, value: ProviderOptionSelectionValue) {
        self.id = id
        self.value = value
    }
}

/// `ModelSelection` (orchestration.ts). `options` is
/// `Schema.optionalKey(ProviderOptionSelections)`, and
/// `ProviderOptionSelections` itself accepts either the canonical
/// `[ProviderOptionSelection]` array or a legacy free-form record — kept as
/// opaque `JSONValue` here so both shapes round-trip losslessly; use
/// `canonicalOptions`/`init(instanceId:model:canonicalOptions:)` to work
/// with the typed array form.
///
/// §6 risk 7: always emit `{ instanceId, model }` — never the legacy
/// `{ provider, model }` shape (the legacy-promotion transform is decode-only
/// server-side).
public struct ModelSelection: Codable, Sendable, Hashable {
    public var instanceId: String
    public var model: String
    public var options: JSONValue?

    public init(instanceId: String, model: String, options: JSONValue? = nil) {
        self.instanceId = instanceId
        self.model = model
        self.options = options
    }

    public init(instanceId: String, model: String, canonicalOptions: [ProviderOptionSelection]) {
        self.instanceId = instanceId
        self.model = model
        self.options = try? Self.encodeCanonicalOptions(canonicalOptions)
    }

    private static func encodeCanonicalOptions(_ options: [ProviderOptionSelection]) throws -> JSONValue {
        let data = try WireCoding.encoder.encode(options)
        return try WireCoding.decoder.decode(JSONValue.self, from: data)
    }

    /// Best-effort decode of `options` as the canonical selection array;
    /// `nil` if absent or in the legacy record shape.
    public var canonicalOptions: [ProviderOptionSelection]? {
        guard let options else { return nil }
        return try? options.decode(as: [ProviderOptionSelection].self, using: WireCoding.decoder)
    }
}

// MARK: - Repository identity (environment.ts; referenced by projects)

public struct RepositoryIdentityLocator: Codable, Sendable, Hashable {
    public let source: String = "git-remote"
    public var remoteName: String
    public var remoteUrl: String

    public init(remoteName: String, remoteUrl: String) {
        self.remoteName = remoteName
        self.remoteUrl = remoteUrl
    }
}

public struct RepositoryIdentity: Codable, Sendable, Hashable {
    public var canonicalKey: String
    public var locator: RepositoryIdentityLocator
    public var rootPath: String?

    public init(canonicalKey: String, locator: RepositoryIdentityLocator, rootPath: String? = nil) {
        self.canonicalKey = canonicalKey
        self.locator = locator
        self.rootPath = rootPath
    }
}

// MARK: - Project script

public enum ProjectScriptIcon: String, Codable, Sendable {
    case play, test, lint, configure, build, debug
}

public struct ProjectScript: Codable, Sendable, Hashable {
    public var id: String
    public var name: String
    public var command: String
    public var icon: ProjectScriptIcon
    public var runOnWorktreeCreate: Bool
    public var previewUrl: String?
    public var autoOpenPreview: Bool?

    public init(
        id: String, name: String, command: String, icon: ProjectScriptIcon,
        runOnWorktreeCreate: Bool, previewUrl: String? = nil, autoOpenPreview: Bool? = nil
    ) {
        self.id = id
        self.name = name
        self.command = command
        self.icon = icon
        self.runOnWorktreeCreate = runOnWorktreeCreate
        self.previewUrl = previewUrl
        self.autoOpenPreview = autoOpenPreview
    }
}

// MARK: - Chat attachments (image-only union for v1; ChatAttachment is a
// Schema.Union([ChatImageAttachment]) today, so the Swift type is a struct
// with a fixed `type` discriminator rather than a speculative enum).

public struct ChatImageAttachment: Codable, Sendable, Hashable {
    public let type: String = "image"
    public var id: String
    public var name: String
    public var mimeType: String
    public var sizeBytes: Int

    public init(id: String, name: String, mimeType: String, sizeBytes: Int) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
    }
}

public typealias ChatAttachment = ChatImageAttachment

public struct UploadChatImageAttachment: Codable, Sendable, Hashable {
    public let type: String = "image"
    public var name: String
    public var mimeType: String
    public var sizeBytes: Int
    public var dataUrl: String

    public init(name: String, mimeType: String, sizeBytes: Int, dataUrl: String) {
        self.name = name
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.dataUrl = dataUrl
    }
}

public typealias UploadChatAttachment = UploadChatImageAttachment

// MARK: - Projects / threads (read models)

public struct OrchestrationProject: Codable, Sendable {
    public var id: String
    public var title: String
    public var workspaceRoot: String
    public var repositoryIdentity: RepositoryIdentity?
    public var defaultModelSelection: ModelSelection?
    public var scripts: [ProjectScript]
    public var createdAt: String
    public var updatedAt: String
    public var deletedAt: String?

    public init(
        id: String, title: String, workspaceRoot: String,
        repositoryIdentity: RepositoryIdentity? = nil, defaultModelSelection: ModelSelection? = nil,
        scripts: [ProjectScript], createdAt: String, updatedAt: String, deletedAt: String? = nil
    ) {
        self.id = id
        self.title = title
        self.workspaceRoot = workspaceRoot
        self.repositoryIdentity = repositoryIdentity
        self.defaultModelSelection = defaultModelSelection
        self.scripts = scripts
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.deletedAt = deletedAt
    }
}

public enum OrchestrationMessageRole: String, Codable, Sendable {
    case user, assistant, system
}

public struct OrchestrationMessage: Codable, Sendable {
    public var id: String
    public var role: OrchestrationMessageRole
    public var text: String
    public var attachments: [ChatAttachment]?
    public var turnId: String?
    public var streaming: Bool
    public var createdAt: String
    public var updatedAt: String

    public init(
        id: String, role: OrchestrationMessageRole, text: String,
        attachments: [ChatAttachment]? = nil, turnId: String? = nil, streaming: Bool,
        createdAt: String, updatedAt: String
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.attachments = attachments
        self.turnId = turnId
        self.streaming = streaming
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct SourceProposedPlanReference: Codable, Sendable {
    public var threadId: String
    public var planId: String

    public init(threadId: String, planId: String) {
        self.threadId = threadId
        self.planId = planId
    }
}

public struct OrchestrationProposedPlan: Codable, Sendable {
    public var id: String
    public var turnId: String?
    public var planMarkdown: String
    public var implementedAt: String?
    public var implementationThreadId: String?
    public var createdAt: String
    public var updatedAt: String

    public init(
        id: String, turnId: String? = nil, planMarkdown: String, implementedAt: String? = nil,
        implementationThreadId: String? = nil, createdAt: String, updatedAt: String
    ) {
        self.id = id
        self.turnId = turnId
        self.planMarkdown = planMarkdown
        self.implementedAt = implementedAt
        self.implementationThreadId = implementationThreadId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, turnId, planMarkdown, implementedAt, implementationThreadId, createdAt, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        turnId = try container.decodeIfPresent(String.self, forKey: .turnId)
        planMarkdown = try container.decode(String.self, forKey: .planMarkdown)
        implementedAt = try container.decode(String?.self, forKey: .implementedAt, default: nil)
        implementationThreadId = try container.decode(
            String?.self, forKey: .implementationThreadId, default: nil)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
    }
}

public enum OrchestrationSessionStatus: String, Codable, Sendable {
    case idle, starting, running, ready, interrupted, stopped, error
}

public struct OrchestrationSession: Codable, Sendable {
    public var threadId: String
    public var status: OrchestrationSessionStatus
    public var providerName: String?
    public var providerInstanceId: String?
    public var runtimeMode: RuntimeMode
    public var activeTurnId: String?
    public var lastError: String?
    public var updatedAt: String

    public init(
        threadId: String, status: OrchestrationSessionStatus, providerName: String? = nil,
        providerInstanceId: String? = nil, runtimeMode: RuntimeMode = .wireDefault,
        activeTurnId: String? = nil, lastError: String? = nil, updatedAt: String
    ) {
        self.threadId = threadId
        self.status = status
        self.providerName = providerName
        self.providerInstanceId = providerInstanceId
        self.runtimeMode = runtimeMode
        self.activeTurnId = activeTurnId
        self.lastError = lastError
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case threadId, status, providerName, providerInstanceId, runtimeMode, activeTurnId,
            lastError, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        threadId = try container.decode(String.self, forKey: .threadId)
        status = try container.decode(OrchestrationSessionStatus.self, forKey: .status)
        providerName = try container.decode(String?.self, forKey: .providerName, default: nil)
        providerInstanceId = try container.decodeIfPresent(String.self, forKey: .providerInstanceId)
        runtimeMode = try container.decode(
            RuntimeMode.self, forKey: .runtimeMode, default: .wireDefault)
        activeTurnId = try container.decode(String?.self, forKey: .activeTurnId, default: nil)
        lastError = try container.decode(String?.self, forKey: .lastError, default: nil)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
    }
}

public struct OrchestrationCheckpointFile: Codable, Sendable, Hashable {
    public var path: String
    public var kind: String
    public var additions: Int
    public var deletions: Int

    public init(path: String, kind: String, additions: Int, deletions: Int) {
        self.path = path
        self.kind = kind
        self.additions = additions
        self.deletions = deletions
    }
}

public enum OrchestrationCheckpointStatus: String, Codable, Sendable {
    case ready, missing, error
}

public struct OrchestrationCheckpointSummary: Codable, Sendable {
    public var turnId: String
    public var checkpointTurnCount: Int
    public var checkpointRef: String
    public var status: OrchestrationCheckpointStatus
    public var files: [OrchestrationCheckpointFile]
    public var assistantMessageId: String?
    public var completedAt: String

    public init(
        turnId: String, checkpointTurnCount: Int, checkpointRef: String,
        status: OrchestrationCheckpointStatus, files: [OrchestrationCheckpointFile],
        assistantMessageId: String? = nil, completedAt: String
    ) {
        self.turnId = turnId
        self.checkpointTurnCount = checkpointTurnCount
        self.checkpointRef = checkpointRef
        self.status = status
        self.files = files
        self.assistantMessageId = assistantMessageId
        self.completedAt = completedAt
    }
}

public enum OrchestrationThreadActivityTone: String, Codable, Sendable {
    case info, tool, approval, error
}

public struct OrchestrationThreadActivity: Codable, Sendable {
    public var id: String
    public var tone: OrchestrationThreadActivityTone
    public var kind: String
    public var summary: String
    /// `Schema.Unknown` on the wire — provider/kind-specific, opaque by design.
    public var payload: JSONValue
    public var turnId: String?
    public var sequence: Int?
    public var createdAt: String

    public init(
        id: String, tone: OrchestrationThreadActivityTone, kind: String, summary: String,
        payload: JSONValue, turnId: String? = nil, sequence: Int? = nil, createdAt: String
    ) {
        self.id = id
        self.tone = tone
        self.kind = kind
        self.summary = summary
        self.payload = payload
        self.turnId = turnId
        self.sequence = sequence
        self.createdAt = createdAt
    }
}

public enum OrchestrationLatestTurnState: String, Codable, Sendable {
    case running, interrupted, completed, error
}

public struct OrchestrationLatestTurn: Codable, Sendable {
    public var turnId: String
    public var state: OrchestrationLatestTurnState
    public var requestedAt: String
    public var startedAt: String?
    public var completedAt: String?
    public var assistantMessageId: String?
    var sourceProposedPlan: SourceProposedPlanReference?

    public init(
        turnId: String, state: OrchestrationLatestTurnState, requestedAt: String,
        startedAt: String? = nil, completedAt: String? = nil, assistantMessageId: String? = nil
    ) {
        self.turnId = turnId
        self.state = state
        self.requestedAt = requestedAt
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.assistantMessageId = assistantMessageId
        self.sourceProposedPlan = nil
    }
}

public struct OrchestrationThread: Codable, Sendable {
    public var id: String
    public var projectId: String
    public var title: String
    public var modelSelection: ModelSelection
    public var runtimeMode: RuntimeMode
    public var interactionMode: ProviderInteractionMode
    public var branch: String?
    public var worktreePath: String?
    public var latestTurn: OrchestrationLatestTurn?
    public var createdAt: String
    public var updatedAt: String
    public var archivedAt: String?
    public var deletedAt: String?
    public var messages: [OrchestrationMessage]
    public var proposedPlans: [OrchestrationProposedPlan]
    public var activities: [OrchestrationThreadActivity]
    public var checkpoints: [OrchestrationCheckpointSummary]
    public var session: OrchestrationSession?

    private enum CodingKeys: String, CodingKey {
        case id, projectId, title, modelSelection, runtimeMode, interactionMode, branch,
            worktreePath, latestTurn, createdAt, updatedAt, archivedAt, deletedAt, messages,
            proposedPlans, activities, checkpoints, session
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        projectId = try c.decode(String.self, forKey: .projectId)
        title = try c.decode(String.self, forKey: .title)
        modelSelection = try c.decode(ModelSelection.self, forKey: .modelSelection)
        runtimeMode = try c.decode(RuntimeMode.self, forKey: .runtimeMode, default: .wireDefault)
        interactionMode = try c.decode(
            ProviderInteractionMode.self, forKey: .interactionMode, default: .wireDefault)
        branch = try c.decode(String?.self, forKey: .branch, default: nil)
        worktreePath = try c.decode(String?.self, forKey: .worktreePath, default: nil)
        latestTurn = try c.decode(OrchestrationLatestTurn?.self, forKey: .latestTurn, default: nil)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
        archivedAt = try c.decode(String?.self, forKey: .archivedAt, default: nil)
        deletedAt = try c.decode(String?.self, forKey: .deletedAt, default: nil)
        messages = try c.decode([OrchestrationMessage].self, forKey: .messages)
        proposedPlans = try c.decode(
            [OrchestrationProposedPlan].self, forKey: .proposedPlans, default: [])
        activities = try c.decode([OrchestrationThreadActivity].self, forKey: .activities)
        checkpoints = try c.decode([OrchestrationCheckpointSummary].self, forKey: .checkpoints)
        session = try c.decode(OrchestrationSession?.self, forKey: .session, default: nil)
    }
}

public struct OrchestrationReadModel: Codable, Sendable {
    public var snapshotSequence: Int
    public var projects: [OrchestrationProject]
    public var threads: [OrchestrationThread]
    public var updatedAt: String
}

public struct OrchestrationProjectShell: Codable, Sendable {
    public var id: String
    public var title: String
    public var workspaceRoot: String
    public var repositoryIdentity: RepositoryIdentity?
    public var defaultModelSelection: ModelSelection?
    public var scripts: [ProjectScript]
    public var createdAt: String
    public var updatedAt: String

    public init(
        id: String, title: String, workspaceRoot: String,
        repositoryIdentity: RepositoryIdentity? = nil, defaultModelSelection: ModelSelection? = nil,
        scripts: [ProjectScript], createdAt: String, updatedAt: String
    ) {
        self.id = id
        self.title = title
        self.workspaceRoot = workspaceRoot
        self.repositoryIdentity = repositoryIdentity
        self.defaultModelSelection = defaultModelSelection
        self.scripts = scripts
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct OrchestrationThreadShell: Codable, Sendable {
    public var id: String
    public var projectId: String
    public var title: String
    public var modelSelection: ModelSelection
    public var runtimeMode: RuntimeMode
    public var interactionMode: ProviderInteractionMode
    public var branch: String?
    public var worktreePath: String?
    public var latestTurn: OrchestrationLatestTurn?
    public var createdAt: String
    public var updatedAt: String
    public var archivedAt: String?
    public var session: OrchestrationSession?
    public var latestUserMessageAt: String?
    public var hasPendingApprovals: Bool
    public var hasPendingUserInput: Bool
    public var hasActionableProposedPlan: Bool

    private enum CodingKeys: String, CodingKey {
        case id, projectId, title, modelSelection, runtimeMode, interactionMode, branch,
            worktreePath, latestTurn, createdAt, updatedAt, archivedAt, session,
            latestUserMessageAt, hasPendingApprovals, hasPendingUserInput,
            hasActionableProposedPlan
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        projectId = try c.decode(String.self, forKey: .projectId)
        title = try c.decode(String.self, forKey: .title)
        modelSelection = try c.decode(ModelSelection.self, forKey: .modelSelection)
        runtimeMode = try c.decode(RuntimeMode.self, forKey: .runtimeMode, default: .wireDefault)
        interactionMode = try c.decode(
            ProviderInteractionMode.self, forKey: .interactionMode, default: .wireDefault)
        branch = try c.decode(String?.self, forKey: .branch, default: nil)
        worktreePath = try c.decode(String?.self, forKey: .worktreePath, default: nil)
        latestTurn = try c.decode(OrchestrationLatestTurn?.self, forKey: .latestTurn, default: nil)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
        archivedAt = try c.decode(String?.self, forKey: .archivedAt, default: nil)
        session = try c.decode(OrchestrationSession?.self, forKey: .session, default: nil)
        latestUserMessageAt = try c.decode(String?.self, forKey: .latestUserMessageAt, default: nil)
        hasPendingApprovals = try c.decode(Bool.self, forKey: .hasPendingApprovals)
        hasPendingUserInput = try c.decode(Bool.self, forKey: .hasPendingUserInput)
        hasActionableProposedPlan = try c.decode(Bool.self, forKey: .hasActionableProposedPlan)
    }
}

public struct OrchestrationShellSnapshot: Codable, Sendable {
    public var snapshotSequence: Int
    public var projects: [OrchestrationProjectShell]
    public var threads: [OrchestrationThreadShell]
    public var updatedAt: String
}

/// `OrchestrationShellStreamEvent` union, discriminated by `kind`.
public enum OrchestrationShellStreamEvent: Sendable {
    case projectUpserted(sequence: Int, project: OrchestrationProjectShell)
    case projectRemoved(sequence: Int, projectId: String)
    case threadUpserted(sequence: Int, thread: OrchestrationThreadShell)
    case threadRemoved(sequence: Int, threadId: String)
}

extension OrchestrationShellStreamEvent: Codable {
    private enum CodingKeys: String, CodingKey {
        case kind, sequence, project, projectId, thread, threadId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        let sequence = try c.decode(Int.self, forKey: .sequence)
        switch kind {
        case "project-upserted":
            self = .projectUpserted(
                sequence: sequence, project: try c.decode(OrchestrationProjectShell.self, forKey: .project))
        case "project-removed":
            self = .projectRemoved(sequence: sequence, projectId: try c.decode(String.self, forKey: .projectId))
        case "thread-upserted":
            self = .threadUpserted(
                sequence: sequence, thread: try c.decode(OrchestrationThreadShell.self, forKey: .thread))
        case "thread-removed":
            self = .threadRemoved(sequence: sequence, threadId: try c.decode(String.self, forKey: .threadId))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: c, debugDescription: "Unknown OrchestrationShellStreamEvent kind: \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .projectUpserted(let sequence, let project):
            try c.encode("project-upserted", forKey: .kind)
            try c.encode(sequence, forKey: .sequence)
            try c.encode(project, forKey: .project)
        case .projectRemoved(let sequence, let projectId):
            try c.encode("project-removed", forKey: .kind)
            try c.encode(sequence, forKey: .sequence)
            try c.encode(projectId, forKey: .projectId)
        case .threadUpserted(let sequence, let thread):
            try c.encode("thread-upserted", forKey: .kind)
            try c.encode(sequence, forKey: .sequence)
            try c.encode(thread, forKey: .thread)
        case .threadRemoved(let sequence, let threadId):
            try c.encode("thread-removed", forKey: .kind)
            try c.encode(sequence, forKey: .sequence)
            try c.encode(threadId, forKey: .threadId)
        }
    }
}

/// `orchestration.subscribeShell` stream item: `{kind:"snapshot",snapshot}` |
/// `OrchestrationShellStreamEvent`.
public enum OrchestrationShellStreamItem: Sendable {
    case snapshot(OrchestrationShellSnapshot)
    case event(OrchestrationShellStreamEvent)
}

extension OrchestrationShellStreamItem: Codable {
    private enum CodingKeys: String, CodingKey { case kind, snapshot }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if try c.decode(String.self, forKey: .kind) == "snapshot" {
            self = .snapshot(try c.decode(OrchestrationShellSnapshot.self, forKey: .snapshot))
        } else {
            self = .event(try OrchestrationShellStreamEvent(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .snapshot(let snapshot):
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode("snapshot", forKey: .kind)
            try c.encode(snapshot, forKey: .snapshot)
        case .event(let event):
            try event.encode(to: encoder)
        }
    }
}

public struct OrchestrationThreadDetailSnapshot: Codable, Sendable {
    public var snapshotSequence: Int
    public var thread: OrchestrationThread
}

// MARK: - Client-dispatchable commands (orchestration.dispatchCommand payload)
//
// `ClientOrchestrationCommand` (encode-only from the client's POV: these are
// only ever sent, never received back verbatim). Mirrors
// `packages/contracts/src/orchestration.ts` `ClientOrchestrationCommand`
// exactly, using the client-facing `ClientThreadTurnStartCommand` variant
// (upload attachments) for `thread.turn.start`.

public struct ProjectCreateCommand: Encodable, Sendable {
    public let type: String = "project.create"
    public var commandId: String
    public var projectId: String
    public var title: String
    public var workspaceRoot: String
    public var createWorkspaceRootIfMissing: Bool?
    public var defaultModelSelection: ModelSelection?
    public var createdAt: String

    public init(
        commandId: String, projectId: String, title: String, workspaceRoot: String,
        createWorkspaceRootIfMissing: Bool? = nil, defaultModelSelection: ModelSelection? = nil,
        createdAt: String
    ) {
        self.commandId = commandId
        self.projectId = projectId
        self.title = title
        self.workspaceRoot = workspaceRoot
        self.createWorkspaceRootIfMissing = createWorkspaceRootIfMissing
        self.defaultModelSelection = defaultModelSelection
        self.createdAt = createdAt
    }
}

public struct ProjectMetaUpdateCommand: Encodable, Sendable {
    public let type: String = "project.meta.update"
    public var commandId: String
    public var projectId: String
    public var title: String?
    public var workspaceRoot: String?
    public var defaultModelSelection: ModelSelection??  // optional(NullOr) — outer nil omits the key, inner nil sends null
    public var scripts: [ProjectScript]?

    /// `defaultModelSelection` is `Schema.optional(Schema.NullOr(x))`:
    /// leave at the default `nil` to omit the key entirely (don't touch),
    /// pass `.some(nil)` to explicitly clear it to `null`, or `.some(value)`
    /// to set it.
    public init(
        commandId: String, projectId: String, title: String? = nil, workspaceRoot: String? = nil,
        defaultModelSelection: ModelSelection?? = nil, scripts: [ProjectScript]? = nil
    ) {
        self.commandId = commandId
        self.projectId = projectId
        self.title = title
        self.workspaceRoot = workspaceRoot
        self.defaultModelSelection = defaultModelSelection
        self.scripts = scripts
    }

    private enum CodingKeys: String, CodingKey {
        case type, commandId, projectId, title, workspaceRoot, defaultModelSelection, scripts
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        try c.encode(commandId, forKey: .commandId)
        try c.encode(projectId, forKey: .projectId)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(workspaceRoot, forKey: .workspaceRoot)
        if let defaultModelSelection { try c.encode(defaultModelSelection, forKey: .defaultModelSelection) }
        try c.encodeIfPresent(scripts, forKey: .scripts)
    }
}

public struct ProjectDeleteCommand: Encodable, Sendable {
    public let type: String = "project.delete"
    public var commandId: String
    public var projectId: String
    public var force: Bool?

    public init(commandId: String, projectId: String, force: Bool? = nil) {
        self.commandId = commandId
        self.projectId = projectId
        self.force = force
    }
}

/// `branch`/`worktreePath` are bare `Schema.NullOr` (required key, may be
/// `null`) — manual `encode(to:)` so `nil` still writes an explicit `null`
/// rather than omitting the key (see file header).
public struct ThreadCreateCommand: Codable, Sendable {
    public let type: String = "thread.create"
    public var commandId: String
    public var threadId: String
    public var projectId: String
    public var title: String
    public var modelSelection: ModelSelection
    public var runtimeMode: RuntimeMode
    public var interactionMode: ProviderInteractionMode
    public var branch: String?
    public var worktreePath: String?
    public var createdAt: String

    public init(
        commandId: String, threadId: String, projectId: String, title: String,
        modelSelection: ModelSelection, runtimeMode: RuntimeMode,
        interactionMode: ProviderInteractionMode = .wireDefault, branch: String? = nil,
        worktreePath: String? = nil, createdAt: String
    ) {
        self.commandId = commandId
        self.threadId = threadId
        self.projectId = projectId
        self.title = title
        self.modelSelection = modelSelection
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
        self.branch = branch
        self.worktreePath = worktreePath
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case type, commandId, threadId, projectId, title, modelSelection, runtimeMode,
            interactionMode, branch, worktreePath, createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        commandId = try c.decode(String.self, forKey: .commandId)
        threadId = try c.decode(String.self, forKey: .threadId)
        projectId = try c.decode(String.self, forKey: .projectId)
        title = try c.decode(String.self, forKey: .title)
        modelSelection = try c.decode(ModelSelection.self, forKey: .modelSelection)
        runtimeMode = try c.decode(RuntimeMode.self, forKey: .runtimeMode, default: .wireDefault)
        interactionMode = try c.decode(
            ProviderInteractionMode.self, forKey: .interactionMode, default: .wireDefault)
        branch = try c.decodeIfPresent(String.self, forKey: .branch)
        worktreePath = try c.decodeIfPresent(String.self, forKey: .worktreePath)
        createdAt = try c.decode(String.self, forKey: .createdAt)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        try c.encode(commandId, forKey: .commandId)
        try c.encode(threadId, forKey: .threadId)
        try c.encode(projectId, forKey: .projectId)
        try c.encode(title, forKey: .title)
        try c.encode(modelSelection, forKey: .modelSelection)
        try c.encode(runtimeMode, forKey: .runtimeMode)
        try c.encode(interactionMode, forKey: .interactionMode)
        try c.encode(branch, forKey: .branch)  // explicit null when nil, not omitted
        try c.encode(worktreePath, forKey: .worktreePath)
        try c.encode(createdAt, forKey: .createdAt)
    }
}

public struct ThreadDeleteCommand: Encodable, Sendable {
    public let type: String = "thread.delete"
    public var commandId: String
    public var threadId: String

    public init(commandId: String, threadId: String) {
        self.commandId = commandId
        self.threadId = threadId
    }
}

public struct ThreadArchiveCommand: Encodable, Sendable {
    public let type: String = "thread.archive"
    public var commandId: String
    public var threadId: String

    public init(commandId: String, threadId: String) {
        self.commandId = commandId
        self.threadId = threadId
    }
}

public struct ThreadUnarchiveCommand: Encodable, Sendable {
    public let type: String = "thread.unarchive"
    public var commandId: String
    public var threadId: String

    public init(commandId: String, threadId: String) {
        self.commandId = commandId
        self.threadId = threadId
    }
}

public struct ThreadMetaUpdateCommand: Encodable, Sendable {
    public let type: String = "thread.meta.update"
    public var commandId: String
    public var threadId: String
    public var title: String?
    public var modelSelection: ModelSelection?
    public var branch: String??  // optional(NullOr) — outer nil omits the key, inner nil sends null
    public var worktreePath: String??

    /// `branch`/`worktreePath` are `Schema.optional(Schema.NullOr(x))`:
    /// leave at the default `nil` to omit the key entirely (don't touch),
    /// pass `.some(nil)` to explicitly clear it to `null`, or `.some(value)`
    /// to set it.
    public init(
        commandId: String, threadId: String, title: String? = nil,
        modelSelection: ModelSelection? = nil, branch: String?? = nil,
        worktreePath: String?? = nil
    ) {
        self.commandId = commandId
        self.threadId = threadId
        self.title = title
        self.modelSelection = modelSelection
        self.branch = branch
        self.worktreePath = worktreePath
    }

    private enum CodingKeys: String, CodingKey {
        case type, commandId, threadId, title, modelSelection, branch, worktreePath
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        try c.encode(commandId, forKey: .commandId)
        try c.encode(threadId, forKey: .threadId)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(modelSelection, forKey: .modelSelection)
        if let branch { try c.encode(branch, forKey: .branch) }
        if let worktreePath { try c.encode(worktreePath, forKey: .worktreePath) }
    }
}

public struct ThreadRuntimeModeSetCommand: Encodable, Sendable {
    public let type: String = "thread.runtime-mode.set"
    public var commandId: String
    public var threadId: String
    public var runtimeMode: RuntimeMode
    public var createdAt: String

    public init(commandId: String, threadId: String, runtimeMode: RuntimeMode, createdAt: String) {
        self.commandId = commandId
        self.threadId = threadId
        self.runtimeMode = runtimeMode
        self.createdAt = createdAt
    }
}

public struct ThreadInteractionModeSetCommand: Encodable, Sendable {
    public let type: String = "thread.interaction-mode.set"
    public var commandId: String
    public var threadId: String
    public var interactionMode: ProviderInteractionMode
    public var createdAt: String

    public init(
        commandId: String, threadId: String, interactionMode: ProviderInteractionMode,
        createdAt: String
    ) {
        self.commandId = commandId
        self.threadId = threadId
        self.interactionMode = interactionMode
        self.createdAt = createdAt
    }
}

/// Nested in `ThreadTurnStartCommand.bootstrap`; `branch`/`worktreePath` are
/// bare `NullOr` here too, so this also needs a manual `encode(to:)`.
public struct ThreadTurnStartBootstrapCreateThread: Codable, Sendable {
    public var projectId: String
    public var title: String
    public var modelSelection: ModelSelection
    public var runtimeMode: RuntimeMode
    public var interactionMode: ProviderInteractionMode
    public var branch: String?
    public var worktreePath: String?
    public var createdAt: String

    public init(
        projectId: String, title: String, modelSelection: ModelSelection, runtimeMode: RuntimeMode,
        interactionMode: ProviderInteractionMode, branch: String? = nil,
        worktreePath: String? = nil, createdAt: String
    ) {
        self.projectId = projectId
        self.title = title
        self.modelSelection = modelSelection
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
        self.branch = branch
        self.worktreePath = worktreePath
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case projectId, title, modelSelection, runtimeMode, interactionMode, branch,
            worktreePath, createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projectId = try c.decode(String.self, forKey: .projectId)
        title = try c.decode(String.self, forKey: .title)
        modelSelection = try c.decode(ModelSelection.self, forKey: .modelSelection)
        runtimeMode = try c.decode(RuntimeMode.self, forKey: .runtimeMode)
        interactionMode = try c.decode(ProviderInteractionMode.self, forKey: .interactionMode)
        branch = try c.decodeIfPresent(String.self, forKey: .branch)
        worktreePath = try c.decodeIfPresent(String.self, forKey: .worktreePath)
        createdAt = try c.decode(String.self, forKey: .createdAt)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(projectId, forKey: .projectId)
        try c.encode(title, forKey: .title)
        try c.encode(modelSelection, forKey: .modelSelection)
        try c.encode(runtimeMode, forKey: .runtimeMode)
        try c.encode(interactionMode, forKey: .interactionMode)
        try c.encode(branch, forKey: .branch)
        try c.encode(worktreePath, forKey: .worktreePath)
        try c.encode(createdAt, forKey: .createdAt)
    }
}

public struct ThreadTurnStartBootstrapPrepareWorktree: Codable, Sendable {
    public var projectCwd: String
    public var baseBranch: String
    public var branch: String?
    public var startFromOrigin: Bool?

    public init(projectCwd: String, baseBranch: String, branch: String? = nil, startFromOrigin: Bool? = nil) {
        self.projectCwd = projectCwd
        self.baseBranch = baseBranch
        self.branch = branch
        self.startFromOrigin = startFromOrigin
    }
}

public struct ThreadTurnStartBootstrap: Codable, Sendable {
    public var createThread: ThreadTurnStartBootstrapCreateThread?
    public var prepareWorktree: ThreadTurnStartBootstrapPrepareWorktree?
    public var runSetupScript: Bool?

    public init(
        createThread: ThreadTurnStartBootstrapCreateThread? = nil,
        prepareWorktree: ThreadTurnStartBootstrapPrepareWorktree? = nil,
        runSetupScript: Bool? = nil
    ) {
        self.createThread = createThread
        self.prepareWorktree = prepareWorktree
        self.runSetupScript = runSetupScript
    }
}

public struct ChatMessageInput: Encodable, Sendable {
    public var messageId: String
    public let role: String = "user"
    public var text: String
    public var attachments: [UploadChatAttachment]

    public init(messageId: String, text: String, attachments: [UploadChatAttachment] = []) {
        self.messageId = messageId
        self.text = text
        self.attachments = attachments
    }
}

/// Client-facing `thread.turn.start` (uses `UploadChatAttachment`, matching
/// `ClientThreadTurnStartCommand` in orchestration.ts — not the server's
/// internal `ThreadTurnStartCommand` variant).
public struct ThreadTurnStartCommand: Encodable, Sendable {
    public let type: String = "thread.turn.start"
    public var commandId: String
    public var threadId: String
    public var message: ChatMessageInput
    public var modelSelection: ModelSelection?
    public var titleSeed: String?
    public var runtimeMode: RuntimeMode
    public var interactionMode: ProviderInteractionMode
    public var bootstrap: ThreadTurnStartBootstrap?
    public var sourceProposedPlan: SourceProposedPlanReference?
    public var createdAt: String

    public init(
        commandId: String, threadId: String, message: ChatMessageInput,
        modelSelection: ModelSelection? = nil, titleSeed: String? = nil,
        runtimeMode: RuntimeMode = .wireDefault, interactionMode: ProviderInteractionMode = .wireDefault,
        bootstrap: ThreadTurnStartBootstrap? = nil,
        sourceProposedPlan: SourceProposedPlanReference? = nil, createdAt: String
    ) {
        self.commandId = commandId
        self.threadId = threadId
        self.message = message
        self.modelSelection = modelSelection
        self.titleSeed = titleSeed
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
        self.bootstrap = bootstrap
        self.sourceProposedPlan = sourceProposedPlan
        self.createdAt = createdAt
    }
}

public struct ThreadTurnInterruptCommand: Encodable, Sendable {
    public let type: String = "thread.turn.interrupt"
    public var commandId: String
    public var threadId: String
    public var turnId: String?
    public var createdAt: String

    public init(commandId: String, threadId: String, turnId: String? = nil, createdAt: String) {
        self.commandId = commandId
        self.threadId = threadId
        self.turnId = turnId
        self.createdAt = createdAt
    }
}

public struct ThreadTaskStopCommand: Encodable, Sendable {
    public let type: String = "thread.task.stop"
    public var commandId: String
    public var threadId: String
    public var taskId: String
    public var turnId: String?
    public var createdAt: String

    public init(
        commandId: String, threadId: String, taskId: String, turnId: String? = nil,
        createdAt: String
    ) {
        self.commandId = commandId
        self.threadId = threadId
        self.taskId = taskId
        self.turnId = turnId
        self.createdAt = createdAt
    }
}

public struct ThreadApprovalRespondCommand: Encodable, Sendable {
    public let type: String = "thread.approval.respond"
    public var commandId: String
    public var threadId: String
    public var requestId: String
    public var decision: ProviderApprovalDecision
    public var createdAt: String

    public init(
        commandId: String, threadId: String, requestId: String, decision: ProviderApprovalDecision,
        createdAt: String
    ) {
        self.commandId = commandId
        self.threadId = threadId
        self.requestId = requestId
        self.decision = decision
        self.createdAt = createdAt
    }
}

public struct ThreadUserInputRespondCommand: Encodable, Sendable {
    public let type: String = "thread.user-input.respond"
    public var commandId: String
    public var threadId: String
    public var requestId: String
    public var answers: ProviderUserInputAnswers
    public var createdAt: String

    public init(
        commandId: String, threadId: String, requestId: String, answers: ProviderUserInputAnswers,
        createdAt: String
    ) {
        self.commandId = commandId
        self.threadId = threadId
        self.requestId = requestId
        self.answers = answers
        self.createdAt = createdAt
    }
}

public struct ThreadCheckpointRevertCommand: Encodable, Sendable {
    public let type: String = "thread.checkpoint.revert"
    public var commandId: String
    public var threadId: String
    public var turnCount: Int
    public var createdAt: String

    public init(commandId: String, threadId: String, turnCount: Int, createdAt: String) {
        self.commandId = commandId
        self.threadId = threadId
        self.turnCount = turnCount
        self.createdAt = createdAt
    }
}

public struct ThreadSessionStopCommand: Encodable, Sendable {
    public let type: String = "thread.session.stop"
    public var commandId: String
    public var threadId: String
    public var createdAt: String

    public init(commandId: String, threadId: String, createdAt: String) {
        self.commandId = commandId
        self.threadId = threadId
        self.createdAt = createdAt
    }
}

/// `orchestration.dispatchCommand` payload — the single write path for
/// projects/threads/turns (§3.1.1). Encode-only.
public enum ClientOrchestrationCommand: Encodable, Sendable {
    case projectCreate(ProjectCreateCommand)
    case projectMetaUpdate(ProjectMetaUpdateCommand)
    case projectDelete(ProjectDeleteCommand)
    case threadCreate(ThreadCreateCommand)
    case threadDelete(ThreadDeleteCommand)
    case threadArchive(ThreadArchiveCommand)
    case threadUnarchive(ThreadUnarchiveCommand)
    case threadMetaUpdate(ThreadMetaUpdateCommand)
    case threadRuntimeModeSet(ThreadRuntimeModeSetCommand)
    case threadInteractionModeSet(ThreadInteractionModeSetCommand)
    case threadTurnStart(ThreadTurnStartCommand)
    case threadTurnInterrupt(ThreadTurnInterruptCommand)
    case threadTaskStop(ThreadTaskStopCommand)
    case threadApprovalRespond(ThreadApprovalRespondCommand)
    case threadUserInputRespond(ThreadUserInputRespondCommand)
    case threadCheckpointRevert(ThreadCheckpointRevertCommand)
    case threadSessionStop(ThreadSessionStopCommand)

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .projectCreate(let c): try container.encode(c)
        case .projectMetaUpdate(let c): try container.encode(c)
        case .projectDelete(let c): try container.encode(c)
        case .threadCreate(let c): try container.encode(c)
        case .threadDelete(let c): try container.encode(c)
        case .threadArchive(let c): try container.encode(c)
        case .threadUnarchive(let c): try container.encode(c)
        case .threadMetaUpdate(let c): try container.encode(c)
        case .threadRuntimeModeSet(let c): try container.encode(c)
        case .threadInteractionModeSet(let c): try container.encode(c)
        case .threadTurnStart(let c): try container.encode(c)
        case .threadTurnInterrupt(let c): try container.encode(c)
        case .threadTaskStop(let c): try container.encode(c)
        case .threadApprovalRespond(let c): try container.encode(c)
        case .threadUserInputRespond(let c): try container.encode(c)
        case .threadCheckpointRevert(let c): try container.encode(c)
        case .threadSessionStop(let c): try container.encode(c)
        }
    }
}

public struct DispatchResult: Decodable, Sendable {
    public var sequence: Int
}

// MARK: - Turn diff

public struct OrchestrationGetTurnDiffInput: Encodable, Sendable {
    public var fromTurnCount: Int
    public var toTurnCount: Int
    public var threadId: String
    public var ignoreWhitespace: Bool?

    public init(fromTurnCount: Int, toTurnCount: Int, threadId: String, ignoreWhitespace: Bool? = nil) {
        self.fromTurnCount = fromTurnCount
        self.toTurnCount = toTurnCount
        self.threadId = threadId
        self.ignoreWhitespace = ignoreWhitespace
    }
}

public struct OrchestrationGetFullThreadDiffInput: Encodable, Sendable {
    public var threadId: String
    public var toTurnCount: Int
    public var ignoreWhitespace: Bool?

    public init(threadId: String, toTurnCount: Int, ignoreWhitespace: Bool? = nil) {
        self.threadId = threadId
        self.toTurnCount = toTurnCount
        self.ignoreWhitespace = ignoreWhitespace
    }
}

public struct ThreadTurnDiff: Decodable, Sendable {
    public var fromTurnCount: Int
    public var toTurnCount: Int
    public var threadId: String
    public var diff: String
}

public struct OrchestrationGetThreadLivenessInput: Encodable, Sendable {
    public var threadId: String

    public init(threadId: String) {
        self.threadId = threadId
    }
}

public struct OrchestrationThreadLiveness: Decodable, Sendable {
    public var threadId: String
    public var hasLiveSession: Bool
    public var hasActiveTurn: Bool
    public var activeTurnId: String?
    public var checkedAt: String
}

public struct OrchestrationReplayEventsInput: Encodable, Sendable {
    public var fromSequenceExclusive: Int

    public init(fromSequenceExclusive: Int) {
        self.fromSequenceExclusive = fromSequenceExclusive
    }
}

// MARK: - Events (read-only; §3.1.3)

public enum OrchestrationAggregateKind: String, Codable, Sendable {
    case project, thread
}

public struct OrchestrationEventMetadata: Codable, Sendable {
    public var providerTurnId: String?
    public var providerItemId: String?
    public var adapterKey: String?
    public var requestId: String?
    public var ingestedAt: String?
}

public struct ProjectCreatedPayload: Decodable, Sendable {
    public var projectId: String
    public var title: String
    public var workspaceRoot: String
    public var repositoryIdentity: RepositoryIdentity?
    public var defaultModelSelection: ModelSelection?
    public var scripts: [ProjectScript]
    public var createdAt: String
    public var updatedAt: String
}

public struct ProjectMetaUpdatedPayload: Decodable, Sendable {
    public var projectId: String
    public var title: String?
    public var workspaceRoot: String?
    public var repositoryIdentity: RepositoryIdentity?
    public var defaultModelSelection: ModelSelection?
    public var scripts: [ProjectScript]?
    public var updatedAt: String
}

public struct ProjectDeletedPayload: Decodable, Sendable {
    public var projectId: String
    public var deletedAt: String
}

public struct ThreadCreatedPayload: Decodable, Sendable {
    public var threadId: String
    public var projectId: String
    public var title: String
    public var modelSelection: ModelSelection
    public var runtimeMode: RuntimeMode
    public var interactionMode: ProviderInteractionMode
    public var branch: String?
    public var worktreePath: String?
    public var createdAt: String
    public var updatedAt: String

    private enum CodingKeys: String, CodingKey {
        case threadId, projectId, title, modelSelection, runtimeMode, interactionMode, branch,
            worktreePath, createdAt, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threadId = try c.decode(String.self, forKey: .threadId)
        projectId = try c.decode(String.self, forKey: .projectId)
        title = try c.decode(String.self, forKey: .title)
        modelSelection = try c.decode(ModelSelection.self, forKey: .modelSelection)
        runtimeMode = try c.decode(RuntimeMode.self, forKey: .runtimeMode, default: .wireDefault)
        interactionMode = try c.decode(
            ProviderInteractionMode.self, forKey: .interactionMode, default: .wireDefault)
        branch = try c.decode(String?.self, forKey: .branch, default: nil)
        worktreePath = try c.decode(String?.self, forKey: .worktreePath, default: nil)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
    }
}

public struct ThreadDeletedPayload: Decodable, Sendable {
    public var threadId: String
    public var deletedAt: String
}

public struct ThreadArchivedPayload: Decodable, Sendable {
    public var threadId: String
    public var archivedAt: String
    public var updatedAt: String
}

public struct ThreadUnarchivedPayload: Decodable, Sendable {
    public var threadId: String
    public var updatedAt: String
}

public struct ThreadMetaUpdatedPayload: Decodable, Sendable {
    public var threadId: String
    public var title: String?
    public var modelSelection: ModelSelection?
    public var branch: String?
    public var worktreePath: String?
    public var updatedAt: String
}

public struct ThreadRuntimeModeSetPayload: Decodable, Sendable {
    public var threadId: String
    public var runtimeMode: RuntimeMode
    public var updatedAt: String
}

public struct ThreadInteractionModeSetPayload: Decodable, Sendable {
    public var threadId: String
    public var interactionMode: ProviderInteractionMode
    public var updatedAt: String

    private enum CodingKeys: String, CodingKey { case threadId, interactionMode, updatedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threadId = try c.decode(String.self, forKey: .threadId)
        interactionMode = try c.decode(
            ProviderInteractionMode.self, forKey: .interactionMode, default: .wireDefault)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
    }
}

public struct ThreadMessageSentPayload: Decodable, Sendable {
    public var threadId: String
    public var messageId: String
    public var role: OrchestrationMessageRole
    public var text: String
    public var attachments: [ChatAttachment]?
    public var turnId: String?
    public var streaming: Bool
    public var createdAt: String
    public var updatedAt: String
}

public struct ThreadTurnStartRequestedPayload: Decodable, Sendable {
    public var threadId: String
    public var messageId: String
    public var modelSelection: ModelSelection?
    public var titleSeed: String?
    public var runtimeMode: RuntimeMode
    public var interactionMode: ProviderInteractionMode
    public var createdAt: String

    private enum CodingKeys: String, CodingKey {
        case threadId, messageId, modelSelection, titleSeed, runtimeMode, interactionMode, createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threadId = try c.decode(String.self, forKey: .threadId)
        messageId = try c.decode(String.self, forKey: .messageId)
        modelSelection = try c.decodeIfPresent(ModelSelection.self, forKey: .modelSelection)
        titleSeed = try c.decodeIfPresent(String.self, forKey: .titleSeed)
        runtimeMode = try c.decode(RuntimeMode.self, forKey: .runtimeMode, default: .wireDefault)
        interactionMode = try c.decode(
            ProviderInteractionMode.self, forKey: .interactionMode, default: .wireDefault)
        createdAt = try c.decode(String.self, forKey: .createdAt)
    }
}

public struct ThreadTurnInterruptRequestedPayload: Decodable, Sendable {
    public var threadId: String
    public var turnId: String?
    public var createdAt: String
}

public struct ThreadApprovalResponseRequestedPayload: Decodable, Sendable {
    public var threadId: String
    public var requestId: String
    public var decision: ProviderApprovalDecision
    public var createdAt: String
}

public struct ThreadUserInputResponseRequestedPayload: Decodable, Sendable {
    public var threadId: String
    public var requestId: String
    public var answers: ProviderUserInputAnswers
    public var createdAt: String
}

public struct ThreadCheckpointRevertRequestedPayload: Decodable, Sendable {
    public var threadId: String
    public var turnCount: Int
    public var createdAt: String
}

public struct ThreadRevertedPayload: Decodable, Sendable {
    public var threadId: String
    public var turnCount: Int
}

public struct ThreadSessionStopRequestedPayload: Decodable, Sendable {
    public var threadId: String
    public var createdAt: String
}

public struct ThreadSessionSetPayload: Decodable, Sendable {
    public var threadId: String
    public var session: OrchestrationSession
}

public struct ThreadProposedPlanUpsertedPayload: Decodable, Sendable {
    public var threadId: String
    public var proposedPlan: OrchestrationProposedPlan
}

public struct ThreadTurnDiffCompletedPayload: Decodable, Sendable {
    public var threadId: String
    public var turnId: String
    public var checkpointTurnCount: Int
    public var checkpointRef: String
    public var status: OrchestrationCheckpointStatus
    public var files: [OrchestrationCheckpointFile]
    public var assistantMessageId: String?
    public var completedAt: String
}

public struct ThreadActivityAppendedPayload: Decodable, Sendable {
    public var threadId: String
    public var activity: OrchestrationThreadActivity
}

/// `OrchestrationEventType` (21 client-visible variants). Kept as string
/// constants rather than a closed Swift enum so an unrecognized future
/// value still decodes as `.other` on `OrchestrationEvent.type` instead of
/// failing the whole decode.
public enum OrchestrationEventType {
    public static let projectCreated = "project.created"
    public static let projectMetaUpdated = "project.meta-updated"
    public static let projectDeleted = "project.deleted"
    public static let threadCreated = "thread.created"
    public static let threadDeleted = "thread.deleted"
    public static let threadArchived = "thread.archived"
    public static let threadUnarchived = "thread.unarchived"
    public static let threadMetaUpdated = "thread.meta-updated"
    public static let threadRuntimeModeSet = "thread.runtime-mode-set"
    public static let threadInteractionModeSet = "thread.interaction-mode-set"
    public static let threadMessageSent = "thread.message-sent"
    public static let threadTurnStartRequested = "thread.turn-start-requested"
    public static let threadTurnInterruptRequested = "thread.turn-interrupt-requested"
    public static let threadApprovalResponseRequested = "thread.approval-response-requested"
    public static let threadUserInputResponseRequested = "thread.user-input-response-requested"
    public static let threadCheckpointRevertRequested = "thread.checkpoint-revert-requested"
    public static let threadReverted = "thread.reverted"
    public static let threadSessionStopRequested = "thread.session-stop-requested"
    public static let threadSessionSet = "thread.session-set"
    public static let threadProposedPlanUpserted = "thread.proposed-plan-upserted"
    public static let threadTurnDiffCompleted = "thread.turn-diff-completed"
    public static let threadActivityAppended = "thread.activity-appended"
}

/// `OrchestrationEvent` — union discriminated by `type` (§5.5), 21 members
/// sharing `EventBaseFields`. Modeled as one struct with a typed `payload`
/// enum rather than 21 nested Swift types, matching how consumers actually
/// switch on it (`switch event.payload { case .threadMessageSent(let p): }`).
public struct OrchestrationEvent: Decodable, Sendable {
    public var sequence: Int
    public var eventId: String
    public var aggregateKind: OrchestrationAggregateKind
    public var aggregateId: String
    public var occurredAt: String
    public var commandId: String?
    public var causationEventId: String?
    public var correlationId: String?
    public var metadata: OrchestrationEventMetadata
    public var type: String
    public var payload: EventPayload

    public enum EventPayload: Sendable {
        case projectCreated(ProjectCreatedPayload)
        case projectMetaUpdated(ProjectMetaUpdatedPayload)
        case projectDeleted(ProjectDeletedPayload)
        case threadCreated(ThreadCreatedPayload)
        case threadDeleted(ThreadDeletedPayload)
        case threadArchived(ThreadArchivedPayload)
        case threadUnarchived(ThreadUnarchivedPayload)
        case threadMetaUpdated(ThreadMetaUpdatedPayload)
        case threadRuntimeModeSet(ThreadRuntimeModeSetPayload)
        case threadInteractionModeSet(ThreadInteractionModeSetPayload)
        case threadMessageSent(ThreadMessageSentPayload)
        case threadTurnStartRequested(ThreadTurnStartRequestedPayload)
        case threadTurnInterruptRequested(ThreadTurnInterruptRequestedPayload)
        case threadApprovalResponseRequested(ThreadApprovalResponseRequestedPayload)
        case threadUserInputResponseRequested(ThreadUserInputResponseRequestedPayload)
        case threadCheckpointRevertRequested(ThreadCheckpointRevertRequestedPayload)
        case threadReverted(ThreadRevertedPayload)
        case threadSessionStopRequested(ThreadSessionStopRequestedPayload)
        case threadSessionSet(ThreadSessionSetPayload)
        case threadProposedPlanUpserted(ThreadProposedPlanUpsertedPayload)
        case threadTurnDiffCompleted(ThreadTurnDiffCompletedPayload)
        case threadActivityAppended(ThreadActivityAppendedPayload)
        /// Unrecognized `type` (forward compatibility): raw payload JSON preserved.
        case other(type: String, payload: JSONValue)
    }

    private enum CodingKeys: String, CodingKey {
        case sequence, eventId, aggregateKind, aggregateId, occurredAt, commandId,
            causationEventId, correlationId, metadata, type, payload
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sequence = try c.decode(Int.self, forKey: .sequence)
        eventId = try c.decode(String.self, forKey: .eventId)
        aggregateKind = try c.decode(OrchestrationAggregateKind.self, forKey: .aggregateKind)
        aggregateId = try c.decode(String.self, forKey: .aggregateId)
        occurredAt = try c.decode(String.self, forKey: .occurredAt)
        commandId = try c.decode(String?.self, forKey: .commandId, default: nil)
        causationEventId = try c.decode(String?.self, forKey: .causationEventId, default: nil)
        correlationId = try c.decode(String?.self, forKey: .correlationId, default: nil)
        metadata = try c.decode(OrchestrationEventMetadata.self, forKey: .metadata)
        let eventType = try c.decode(String.self, forKey: .type)
        type = eventType
        switch eventType {
        case OrchestrationEventType.projectCreated:
            payload = .projectCreated(try c.decode(ProjectCreatedPayload.self, forKey: .payload))
        case OrchestrationEventType.projectMetaUpdated:
            payload = .projectMetaUpdated(try c.decode(ProjectMetaUpdatedPayload.self, forKey: .payload))
        case OrchestrationEventType.projectDeleted:
            payload = .projectDeleted(try c.decode(ProjectDeletedPayload.self, forKey: .payload))
        case OrchestrationEventType.threadCreated:
            payload = .threadCreated(try c.decode(ThreadCreatedPayload.self, forKey: .payload))
        case OrchestrationEventType.threadDeleted:
            payload = .threadDeleted(try c.decode(ThreadDeletedPayload.self, forKey: .payload))
        case OrchestrationEventType.threadArchived:
            payload = .threadArchived(try c.decode(ThreadArchivedPayload.self, forKey: .payload))
        case OrchestrationEventType.threadUnarchived:
            payload = .threadUnarchived(try c.decode(ThreadUnarchivedPayload.self, forKey: .payload))
        case OrchestrationEventType.threadMetaUpdated:
            payload = .threadMetaUpdated(try c.decode(ThreadMetaUpdatedPayload.self, forKey: .payload))
        case OrchestrationEventType.threadRuntimeModeSet:
            payload = .threadRuntimeModeSet(
                try c.decode(ThreadRuntimeModeSetPayload.self, forKey: .payload))
        case OrchestrationEventType.threadInteractionModeSet:
            payload = .threadInteractionModeSet(
                try c.decode(ThreadInteractionModeSetPayload.self, forKey: .payload))
        case OrchestrationEventType.threadMessageSent:
            payload = .threadMessageSent(try c.decode(ThreadMessageSentPayload.self, forKey: .payload))
        case OrchestrationEventType.threadTurnStartRequested:
            payload = .threadTurnStartRequested(
                try c.decode(ThreadTurnStartRequestedPayload.self, forKey: .payload))
        case OrchestrationEventType.threadTurnInterruptRequested:
            payload = .threadTurnInterruptRequested(
                try c.decode(ThreadTurnInterruptRequestedPayload.self, forKey: .payload))
        case OrchestrationEventType.threadApprovalResponseRequested:
            payload = .threadApprovalResponseRequested(
                try c.decode(ThreadApprovalResponseRequestedPayload.self, forKey: .payload))
        case OrchestrationEventType.threadUserInputResponseRequested:
            payload = .threadUserInputResponseRequested(
                try c.decode(ThreadUserInputResponseRequestedPayload.self, forKey: .payload))
        case OrchestrationEventType.threadCheckpointRevertRequested:
            payload = .threadCheckpointRevertRequested(
                try c.decode(ThreadCheckpointRevertRequestedPayload.self, forKey: .payload))
        case OrchestrationEventType.threadReverted:
            payload = .threadReverted(try c.decode(ThreadRevertedPayload.self, forKey: .payload))
        case OrchestrationEventType.threadSessionStopRequested:
            payload = .threadSessionStopRequested(
                try c.decode(ThreadSessionStopRequestedPayload.self, forKey: .payload))
        case OrchestrationEventType.threadSessionSet:
            payload = .threadSessionSet(try c.decode(ThreadSessionSetPayload.self, forKey: .payload))
        case OrchestrationEventType.threadProposedPlanUpserted:
            payload = .threadProposedPlanUpserted(
                try c.decode(ThreadProposedPlanUpsertedPayload.self, forKey: .payload))
        case OrchestrationEventType.threadTurnDiffCompleted:
            payload = .threadTurnDiffCompleted(
                try c.decode(ThreadTurnDiffCompletedPayload.self, forKey: .payload))
        case OrchestrationEventType.threadActivityAppended:
            payload = .threadActivityAppended(
                try c.decode(ThreadActivityAppendedPayload.self, forKey: .payload))
        default:
            payload = .other(type: eventType, payload: try c.decode(JSONValue.self, forKey: .payload))
        }
    }
}

/// `orchestration.subscribeThread` stream item.
public enum OrchestrationThreadStreamItem: Decodable, Sendable {
    case snapshot(OrchestrationThreadDetailSnapshot)
    case event(OrchestrationEvent)

    private enum CodingKeys: String, CodingKey { case kind, snapshot, event }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "snapshot":
            self = .snapshot(try c.decode(OrchestrationThreadDetailSnapshot.self, forKey: .snapshot))
        case "event":
            self = .event(try c.decode(OrchestrationEvent.self, forKey: .event))
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: c, debugDescription: "Unknown OrchestrationThreadStreamItem kind: \(other)")
        }
    }
}
