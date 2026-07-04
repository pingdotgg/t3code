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

public struct ChatThread: Identifiable, Hashable, Sendable {
    public var id: String
    public var projectID: String
    public var title: String
    public var provider: ProviderKind
    public var status: ThreadStatus
    public var updatedAt: Date

    public init(id: String, projectID: String, title: String, provider: ProviderKind, status: ThreadStatus, updatedAt: Date) {
        self.id = id
        self.projectID = projectID
        self.title = title
        self.provider = provider
        self.status = status
        self.updatedAt = updatedAt
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
    case checkpoint(Checkpoint)
    case notice(id: String, text: String, at: Date)

    public var id: String {
        switch self {
        case .userMessage(let id, _, _): id
        case .assistantMessage(let id, _, _, _): id
        case .toolEvent(let id, _, _, _, _): id
        case .approval(let request): request.id
        case .checkpoint(let checkpoint): checkpoint.id
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

public struct ProviderInstance: Identifiable, Sendable {
    public var id: String
    public var kind: ProviderKind
    public var availability: ProviderAvailability
    public var version: String?

    public init(id: String, kind: ProviderKind, availability: ProviderAvailability, version: String?) {
        self.id = id
        self.kind = kind
        self.availability = availability
        self.version = version
    }
}

public enum ConnectionPhase: Sendable, Equatable {
    case launchingServer
    case connecting
    case ready
    case reconnecting(attempt: Int)
    case failed(String)
}
