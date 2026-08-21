import Foundation

public enum FeatureWorkspaceMode: String, CaseIterable, Sendable, Codable {
    case local
    case worktree

    var title: String {
        switch self {
        case .local: "Current checkout"
        case .worktree: "New worktree"
        }
    }

    var systemImage: String {
        switch self {
        case .local: "folder"
        case .worktree: "arrow.triangle.branch"
        }
    }
}

public struct FeatureWorkspaceBranch: Identifiable, Sendable, Equatable, Hashable {
    public var name: String
    public var isRemote: Bool
    public var isCurrent: Bool
    public var isDefault: Bool
    public var worktreePath: String?

    public init(
        name: String,
        isRemote: Bool = false,
        isCurrent: Bool = false,
        isDefault: Bool = false,
        worktreePath: String? = nil
    ) {
        self.name = name
        self.isRemote = isRemote
        self.isCurrent = isCurrent
        self.isDefault = isDefault
        self.worktreePath = worktreePath
    }

    public var id: String {
        "\(isRemote ? "remote" : "local"):\(name)"
    }

    var badge: String? {
        if isCurrent { return "Current" }
        if worktreePath != nil { return "Worktree" }
        if isDefault { return "Default" }
        if isRemote { return "Remote" }
        return nil
    }
}

enum NewTaskWorkspaceDefaults {
    static func localBranch(in branches: [FeatureWorkspaceBranch]) -> FeatureWorkspaceBranch? {
        branches.first { $0.isCurrent }
            ?? branches.first { $0.isDefault && !$0.isRemote }
            ?? branches.first { !$0.isRemote }
            ?? branches.first
    }

    static func worktreeBase(in branches: [FeatureWorkspaceBranch]) -> FeatureWorkspaceBranch? {
        branches.first { $0.isDefault && !$0.isRemote }
            ?? branches.first { $0.isCurrent }
            ?? branches.first { $0.isDefault }
            ?? branches.first { !$0.isRemote }
            ?? branches.first
    }

    static func normalizedWorktreePath(
        for branch: FeatureWorkspaceBranch?,
        projectPath: String
    ) -> String? {
        guard let path = branch?.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines),
              !path.isEmpty,
              URL(fileURLWithPath: path).standardizedFileURL.path
                != URL(fileURLWithPath: projectPath).standardizedFileURL.path else {
            return nil
        }
        return path
    }
}
