import { describe, expect, it } from "vitest";

import {
  buildPrimaryWorkspaceResolutionPrompt,
  buildResolveConflictPrompt,
  buildCommitToBranchLabel,
  deriveWorkspaceStatusInfo,
  resolveDefaultMergeSourceBranch,
  resolveCommitToBranchDisabledReason,
  resolveDedicatedWorkspaceActionState,
} from "./GitHubPanel.logic";

describe("GitHubPanel.logic", () => {
  describe("deriveWorkspaceStatusInfo", () => {
    it("prioritizes conflicts over merge and dirty states", () => {
      expect(
        deriveWorkspaceStatusInfo({
          hasConflicts: true,
          mergeInProgress: true,
          hasChanges: true,
        }),
      ).toEqual({ level: "error", label: "Conflicts" });
    });

    it("returns merging before dirty", () => {
      expect(
        deriveWorkspaceStatusInfo({
          hasConflicts: false,
          mergeInProgress: true,
          hasChanges: true,
        }),
      ).toEqual({ level: "warning", label: "Merging" });
    });

    it("returns clean when nothing is pending", () => {
      expect(
        deriveWorkspaceStatusInfo({
          hasConflicts: false,
          mergeInProgress: false,
          hasChanges: false,
        }),
      ).toEqual({ level: "success", label: "Clean" });
    });
  });

  describe("buildCommitToBranchLabel", () => {
    it("uses the branch name when available", () => {
      expect(buildCommitToBranchLabel("feature/dedicated")).toBe("Commit to feature/dedicated");
    });

    it("falls back when the branch name is missing", () => {
      expect(buildCommitToBranchLabel(null)).toBe("Commit to branch");
    });
  });

  describe("resolveCommitToBranchDisabledReason", () => {
    it("blocks commit while conflicts remain", () => {
      expect(
        resolveCommitToBranchDisabledReason({
          gitStatus: {
            branch: "feature/dedicated",
            hasWorkingTreeChanges: true,
          } as never,
          hasConflicts: true,
          isBusy: false,
        }),
      ).toBe("Resolve conflicts before committing");
    });

    it("allows commit when the workspace is dirty and stable", () => {
      expect(
        resolveCommitToBranchDisabledReason({
          gitStatus: {
            branch: "feature/dedicated",
            hasWorkingTreeChanges: true,
          } as never,
          hasConflicts: false,
          isBusy: false,
        }),
      ).toBeNull();
    });
  });

  describe("resolveDedicatedWorkspaceActionState", () => {
    it("allows close for a clean workspace", () => {
      expect(
        resolveDedicatedWorkspaceActionState({
          gitStatus: {
            hasWorkingTreeChanges: false,
          } as never,
          hasConflicts: false,
          mergeInProgress: false,
          isClosing: false,
          hasRepoContext: true,
          hasThreadContext: true,
        }),
      ).toEqual({
        closeDisabledReason: null,
        showDiscardAction: false,
        discardDisabledReason: "No uncommitted changes to discard",
      });
    });

    it("requires commit or discard for a dirty workspace", () => {
      expect(
        resolveDedicatedWorkspaceActionState({
          gitStatus: {
            hasWorkingTreeChanges: true,
          } as never,
          hasConflicts: false,
          mergeInProgress: false,
          isClosing: false,
          hasRepoContext: true,
          hasThreadContext: true,
        }),
      ).toEqual({
        closeDisabledReason: "Commit or discard changes first",
        showDiscardAction: true,
        discardDisabledReason: null,
      });
    });

    it("keeps discard available during merge cleanup", () => {
      expect(
        resolveDedicatedWorkspaceActionState({
          gitStatus: {
            hasWorkingTreeChanges: false,
          } as never,
          hasConflicts: false,
          mergeInProgress: true,
          isClosing: false,
          hasRepoContext: true,
          hasThreadContext: true,
        }),
      ).toEqual({
        closeDisabledReason: "Commit or discard changes first",
        showDiscardAction: true,
        discardDisabledReason: null,
      });
    });

    it("keeps close available when the primary checkout is dirty", () => {
      expect(
        resolveDedicatedWorkspaceActionState({
          gitStatus: {
            hasWorkingTreeChanges: false,
          } as never,
          hasConflicts: false,
          mergeInProgress: false,
          isClosing: false,
          hasRepoContext: true,
          hasThreadContext: true,
        }),
      ).toEqual({
        closeDisabledReason: null,
        showDiscardAction: false,
        discardDisabledReason: "No uncommitted changes to discard",
      });
    });
  });

  describe("resolveDefaultMergeSourceBranch", () => {
    it("prefers the target branch when available", () => {
      expect(
        resolveDefaultMergeSourceBranch({
          branchNames: ["feature/work", "main", "release"],
          activeWorkspaceBranch: "feature/work",
          activeTargetBranch: "main",
          currentMergeSourceBranch: "",
        }),
      ).toBe("main");
    });

    it("preserves a valid current merge source", () => {
      expect(
        resolveDefaultMergeSourceBranch({
          branchNames: ["feature/work", "main", "release"],
          activeWorkspaceBranch: "feature/work",
          activeTargetBranch: "main",
          currentMergeSourceBranch: "release",
        }),
      ).toBe("release");
    });
  });

  describe("buildResolveConflictPrompt", () => {
    it("includes the merge facts and conflicted files", () => {
      expect(
        buildResolveConflictPrompt({
          workspacePath: "/tmp/repo/.worktrees/feature-work",
          sourceBranch: "feature/work",
          mergeSourceBranch: "main",
          conflictedFiles: ["src/app.ts", "package.json"],
        }),
      ).toContain("Merge source branch: main");
      expect(
        buildResolveConflictPrompt({
          workspacePath: "/tmp/repo/.worktrees/feature-work",
          sourceBranch: "feature/work",
          mergeSourceBranch: "main",
          conflictedFiles: ["src/app.ts", "package.json"],
        }),
      ).toContain("- src/app.ts");
    });
  });

  describe("buildPrimaryWorkspaceResolutionPrompt", () => {
    it("includes the blocking primary checkout details", () => {
      const prompt = buildPrimaryWorkspaceResolutionPrompt({
        workspacePath: "/tmp/repo",
        takeoverBranch: "feature/work",
        conflictedFiles: [],
        changedFiles: ["src/app.ts", "package.json"],
      });
      expect(prompt).toContain("Primary checkout path: /tmp/repo");
      expect(prompt).toContain("Branch to activate after close: feature/work");
      expect(prompt).toContain("Changed files:");
      expect(prompt).toContain("- src/app.ts");
    });
  });
});
