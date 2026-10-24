import Foundation

/// Home rows observe cached remote data. Visible repository views retain remote refreshes.
public enum FeatureSourceControlMonitorIntent: Sendable, Hashable {
    case passive
    case active

    public var includeRemote: Bool { self == .active }
}

public struct FeatureSourceControlRequest: Sendable, Equatable {
    public var action: FeatureSourceControlAction
    public var message: String?
    public var filePaths: [String]?
    public var featureBranch: Bool
    public var allowDefaultBranch: Bool

    public init(
        action: FeatureSourceControlAction, message: String? = nil,
        filePaths: [String]? = nil, featureBranch: Bool = false, allowDefaultBranch: Bool = false
    ) {
        self.action = action
        let trimmed = message?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.message = trimmed?.isEmpty == false ? trimmed : nil
        self.filePaths = filePaths
        self.featureBranch = featureBranch
        self.allowDefaultBranch = allowDefaultBranch
    }

    public func requiresBranchChoice(_ status: FeatureSourceControlStatus) -> Bool {
        status.isDefaultBranch == true && action.usesRemote && action != .pull
            && !featureBranch && !allowDefaultBranch
    }
}

public struct FeatureSourceControlWorkspace: Sendable, Equatable {
    public var branch: String?
    public var worktreePath: String?

    public init(branch: String?, worktreePath: String?) {
        self.branch = branch
        self.worktreePath = worktreePath
    }
}

public struct FeatureSourceControlBranches: Sendable, Equatable {
    public var branches: [FeatureWorkspaceBranch]
    public var workspace: FeatureSourceControlWorkspace
    public var workingDirectory: String

    public func isAvailable(_ branch: FeatureWorkspaceBranch) -> Bool {
        guard let path = branch.worktreePath else { return true }
        return path == workingDirectory
    }
}

public enum FeatureSourceControlWorkspaceAction: Sendable, Equatable {
    case switchBranch(String)
    case createBranch(String)
    case useProjectDirectory
    case createWorktree(baseBranch: String, newBranch: String)
}

public struct FeatureSourceControlWorkspaceSyncError: LocalizedError, Sendable {
    public let workspace: FeatureSourceControlWorkspace
    public let pendingRequest: FeatureSourceControlRequest?
    public let message: String
    public var errorDescription: String? {
        "Git changed the workspace, but the thread could not be updated. \(message)"
    }
}

public struct FeatureSourceControlActionRetryError: LocalizedError, Sendable {
    public let request: FeatureSourceControlRequest
    public let message: String
    public var errorDescription: String? { message }
}

public struct FeatureSourceControlBranchChoiceRequired: LocalizedError, Sendable {
    public let branch: String
    public var errorDescription: String? { "Choose how to continue on the default branch \(branch)." }
}

extension FeatureSourceControlAction {
    var includesCommit: Bool {
        switch self {
        case .commit, .commitAndPush, .commitPushAndCreatePullRequest: true
        case .push, .pull, .createPullRequest: false
        }
    }

    var usesRemote: Bool { self != .commit }
}

/// Retains all mutation inputs and retries only metadata when Git already succeeded.
enum FeatureGitOperation: FeatureRecoverableOperation {
    case load
    case action(FeatureSourceControlRequest)
    case syncWorkspace(FeatureSourceControlWorkspace, then: FeatureSourceControlRequest?)

    var request: FeatureSourceControlRequest? {
        switch self {
        case .load: nil
        case .action(let request): request
        case .syncWorkspace(_, let pending): pending
        }
    }

    var isLoad: Bool { if case .load = self { true } else { false } }
    private var title: String {
        switch self {
        case .load: "Repository status"
        case .action(let request): request.action.title
        case .syncWorkspace: "Update thread workspace"
        }
    }
    var failureTitle: String { "\(title) failed" }
    var retryAccessibilityLabel: String { "Retry \(title.lowercased())" }
    var recoveryAnnouncement: String { "\(title) succeeded." }
}

struct FeatureCommitSelection: Sendable, Equatable {
    var paths: Set<String>

    init(files: [FeatureSourceControlFile]) { paths = Set(files.map(\.path)) }

    func filePaths(in files: [FeatureSourceControlFile]) -> [String]? {
        let included = files.map(\.path).filter { paths.contains($0) }
        return included.count == files.count ? nil : included
    }
}

/// Explicit branch names retain namespaces. Invalid Git refs fail before any mutation.
enum FeatureGitBranchName {
    static func validated(_ input: String) throws -> String {
        let name = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let components = name.split(separator: "/", omittingEmptySubsequences: false)
        guard !name.isEmpty, name != "@", !name.hasPrefix("-"), !name.hasSuffix("."),
              !name.contains(".."), !name.contains("@{"),
              !name.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 || "~^:?*[\\".unicodeScalars.contains($0) }),
              components.allSatisfy({ !$0.isEmpty && !$0.hasPrefix(".") && !$0.hasSuffix(".lock") }) else {
            throw RPCError.remote("Enter a valid Git branch name.")
        }
        return name
    }

    static func automatic(existing: [String]) -> String {
        let names = Set(existing.map { $0.lowercased() })
        let base = "feature/update"
        guard names.contains(base) else { return base }
        var suffix = 2
        while names.contains("\(base)-\(suffix)") { suffix += 1 }
        return "\(base)-\(suffix)"
    }
}
