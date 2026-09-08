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
    /// Existing worktrees already identify a checkout. A new worktree only needs its base.
    @MainActor
    static func selectBranch(
        _ branch: FeatureWorkspaceBranch,
        mode: FeatureWorkspaceMode,
        checkout: (String) async throws -> String?
    ) async throws -> FeatureWorkspaceBranch {
        guard mode == .local, !branch.isCurrent,
              branch.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false else {
            return branch
        }
        let checkedOutName = try await checkout(branch.name)
        var checkedOut = branch
        checkedOut.name = checkedOutName ?? branch.name
        checkedOut.isRemote = false
        checkedOut.isCurrent = true
        return checkedOut
    }

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

    private static func checkoutComparisonPath(_ value: String, windowsCheckout: Bool) -> String {
        let path = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if windowsCheckout, ProjectCreationPath.isWindowsAbsolutePath(path) {
            return ProjectCreationPath.normalizedForComparison(path)
        }
        return URL(fileURLWithPath: value).standardizedFileURL.path
    }

    static func normalizedWorktreePath(
        for branch: FeatureWorkspaceBranch?,
        projectPath: String
    ) -> String? {
        guard let path = branch?.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines),
              !path.isEmpty else { return nil }
        // Forward-slash UNC paths are ambiguous without a Windows root in either input.
        // Preserve POSIX case sensitivity unless a drive or backslash UNC path establishes it.
        let windowsCheckout = [path, projectPath].contains { value in
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return !trimmed.hasPrefix("//") && ProjectCreationPath.isWindowsAbsolutePath(trimmed)
        }
        guard checkoutComparisonPath(path, windowsCheckout: windowsCheckout)
            != checkoutComparisonPath(projectPath, windowsCheckout: windowsCheckout) else {
            return nil
        }
        return path
    }
}
