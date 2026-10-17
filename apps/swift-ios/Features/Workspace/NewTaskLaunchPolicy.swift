import Foundation

/// A branch action targets the selected physical project, even when its repository is grouped.
struct NewTaskWorkspaceSeed {
    let thread: FeatureThread

    func workspace(for project: FeatureProject) -> FeatureComposerWorkspaceDraft? {
        guard project.id == thread.projectID,
              thread.environmentID == nil || thread.environmentID == project.environmentID,
              let branch = thread.branch?.trimmingCharacters(in: .whitespacesAndNewlines),
              !branch.isEmpty else { return nil }
        return FeatureComposerWorkspaceDraft(
            mode: .local, branch: branch, worktreePath: thread.worktreePath, startFromOrigin: false
        )
    }
}

enum NewTaskLaunchPolicy {
    /// Keep the live seed for restore merges, but save it only after checkout succeeds.
    static func draftForPersistence(
        _ draft: FeatureComposerDraft, needsInitialBranchCheckout: Bool
    ) -> FeatureComposerDraft {
        var draft = draft
        if needsInitialBranchCheckout { draft.workspace = nil }
        return draft
    }

    static func interactionMode(
        draft: FeatureInteractionMode?, legacyPlanModeEnabled: Bool, provider: FeatureProvider?
    ) -> FeatureInteractionMode {
        FeatureComposerModePolicy.interactionMode(
            legacyPlanModeEnabled ? draft ?? .standard : .standard, provider: provider
        )
    }

    /// Historical thread metadata and cached ref lists cannot confirm the root checkout.
    static func seededBranchForCheckout(
        _ branch: FeatureWorkspaceBranch, projectPath: String
    ) -> FeatureWorkspaceBranch {
        var branch = branch
        branch.isCurrent = false
        branch.worktreePath = NewTaskWorkspaceDefaults.normalizedWorktreePath(for: branch, projectPath: projectPath)
        return branch
    }

    static func initialProjectID(
        sourceThread: FeatureThread?, recoveryRequested: Bool, recoveryProjectID: String?,
        requestedProjectID: String?, fallbackProjectID: String?
    ) -> String {
        if let sourceThread { return sourceThread.projectID }
        if recoveryRequested { return recoveryProjectID ?? requestedProjectID ?? "" }
        return requestedProjectID ?? fallbackProjectID ?? ""
    }

    static func refreshedBranch(
        _ selected: FeatureWorkspaceBranch?, in branches: [FeatureWorkspaceBranch],
        mode: FeatureWorkspaceMode, isExplicit: Bool
    ) -> FeatureWorkspaceBranch? {
        if let selected {
            if var updated = branches.first(where: { $0.name == selected.name }) {
                if isExplicit, mode == .local { updated.worktreePath = selected.worktreePath }
                return updated
            }
            if isExplicit { return selected }
        }
        return mode == .local
            ? NewTaskWorkspaceDefaults.localBranch(in: branches)
            : NewTaskWorkspaceDefaults.worktreeBase(in: branches)
    }
}
