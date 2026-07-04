import Foundation

// UI-level domain model. T3Kit maps wire types into these; MockBackend fakes
// them. Keep UI code independent of wire-shape churn.

public enum ProviderKind: String, Codable, CaseIterable, Sendable, Identifiable {
    case claude, codex, cursor, opencode
    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .claude: "Claude Code"
        case .codex: "Codex"
        case .cursor: "Cursor"
        case .opencode: "OpenCode"
        }
    }
}

public struct Project: Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var path: String

    public init(id: String, name: String, path: String) {
        self.id = id
        self.name = name
        self.path = path
    }
}

public enum ThreadStatus: String, Sendable {
    case idle, running, waitingApproval, error, archived
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

/// UI mirror of the wire `ProviderInteractionMode` (plan-first vs direct).
public enum ThreadInteractionMode: String, CaseIterable, Sendable, Identifiable {
    case normal, plan
    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .normal: "Default"
        case .plan: "Plan"
        }
    }
}

/// One selectable model of one provider instance (model picker rows).
public struct ModelOption: Identifiable, Hashable, Sendable {
    public var instanceID: String
    public var modelID: String
    public var displayName: String
    public var provider: ProviderKind
    public var isDefault: Bool

    public var id: String { "\(instanceID)/\(modelID)" }

    public init(
        instanceID: String, modelID: String, displayName: String, provider: ProviderKind,
        isDefault: Bool
    ) {
        self.instanceID = instanceID
        self.modelID = modelID
        self.displayName = displayName
        self.provider = provider
        self.isDefault = isDefault
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

    public init(
        id: String, projectID: String, title: String, provider: ProviderKind,
        status: ThreadStatus, updatedAt: Date,
        runtimeMode: ThreadRuntimeMode = .fullAccess,
        interactionMode: ThreadInteractionMode = .normal,
        modelInstanceID: String? = nil, modelID: String? = nil
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
    }
}

public enum ToolEventStatus: String, Sendable {
    case running, succeeded, failed
}

public enum TimelineItem: Identifiable, Sendable {
    case userMessage(id: String, text: String, at: Date)
    case assistantMessage(id: String, markdown: String, isStreaming: Bool, at: Date)
    case toolEvent(id: String, name: String, detail: String, status: ToolEventStatus, at: Date)
    case approval(ApprovalRequest)
    case userInput(UserInputRequest)
    case checkpoint(Checkpoint)
    case plan(ProposedPlan)
    case notice(id: String, text: String, at: Date)

    public var id: String {
        switch self {
        case .userMessage(let id, _, _): id
        case .assistantMessage(let id, _, _, _): id
        case .toolEvent(let id, _, _, _, _): id
        case .approval(let request): request.id
        case .userInput(let request): request.id
        case .checkpoint(let checkpoint): checkpoint.id
        case .plan(let plan): plan.id
        case .notice(let id, _, _): id
        }
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

public struct Checkpoint: Identifiable, Hashable, Sendable {
    public var id: String
    public var threadID: String
    public var label: String
    public var createdAt: Date

    public init(id: String, threadID: String, label: String, createdAt: Date) {
        self.id = id
        self.threadID = threadID
        self.label = label
        self.createdAt = createdAt
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
    public var status: DiffFileStatus
    public var hunks: [DiffHunk]

    public init(path: String, status: DiffFileStatus, hunks: [DiffHunk]) {
        self.path = path
        self.status = status
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

// MARK: - Git / VCS

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
    public var prNumber: Int?
    public var prTitle: String?
    public var prURL: String?

    public init(
        isRepo: Bool, branch: String?, isDefaultBranch: Bool, changedFileCount: Int,
        insertions: Int, deletions: Int, aheadCount: Int, behindCount: Int, hasUpstream: Bool,
        prNumber: Int? = nil, prTitle: String? = nil, prURL: String? = nil
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
        self.prNumber = prNumber
        self.prTitle = prTitle
        self.prURL = prURL
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
    case commit, push, commitPush, commitPushPR
    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .commit: "Commit"
        case .push: "Push"
        case .commitPush: "Commit & Push"
        case .commitPushPR: "Commit, Push & Open PR"
        }
    }

    public var needsCommitMessage: Bool {
        self != .push
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
    case failed(String)
}
