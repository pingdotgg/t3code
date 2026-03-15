import { describe, expect, it, vi } from "vitest";

import {
  resolveInitialWorktreeCreation,
  resolveOpenWorktreeReuseCandidate,
  resolvePendingWorktreeBranchForSend,
} from "./ChatView.logic";

describe("resolvePendingWorktreeBranchForSend", () => {
  it("uses the explicit branch when one is already stored", () => {
    expect(
      resolvePendingWorktreeBranchForSend({
        envMode: "open-worktree",
        isFirstMessage: true,
        branch: "feature/demo",
        currentGitBranch: "master",
        worktreePath: null,
      }),
    ).toBe("feature/demo");
  });

  it("defaults pending worktree modes to the current git branch on first send", () => {
    expect(
      resolvePendingWorktreeBranchForSend({
        envMode: "open-worktree",
        isFirstMessage: true,
        branch: null,
        currentGitBranch: "master",
        worktreePath: null,
      }),
    ).toBe("master");

    expect(
      resolvePendingWorktreeBranchForSend({
        envMode: "worktree",
        isFirstMessage: true,
        branch: null,
        currentGitBranch: "main",
        worktreePath: null,
      }),
    ).toBe("main");
  });

  it("does not infer a branch outside pending first-send worktree setup", () => {
    expect(
      resolvePendingWorktreeBranchForSend({
        envMode: "local",
        isFirstMessage: true,
        branch: null,
        currentGitBranch: "main",
        worktreePath: null,
      }),
    ).toBeNull();

    expect(
      resolvePendingWorktreeBranchForSend({
        envMode: "open-worktree",
        isFirstMessage: false,
        branch: null,
        currentGitBranch: "main",
        worktreePath: null,
      }),
    ).toBeNull();
  });
});

describe("resolveInitialWorktreeCreation", () => {
  it("returns none for local mode", () => {
    const buildNewBranchName = vi.fn(() => "t3code/unused");

    expect(
      resolveInitialWorktreeCreation({
        envMode: "local",
        isFirstMessage: true,
        branch: "main",
        worktreePath: null,
        buildNewBranchName,
      }),
    ).toEqual({ type: "none" });
    expect(buildNewBranchName).not.toHaveBeenCalled();
  });

  it("creates a temp branch request for new worktree mode", () => {
    const buildNewBranchName = vi.fn(() => "t3code/temp-branch");

    expect(
      resolveInitialWorktreeCreation({
        envMode: "worktree",
        isFirstMessage: true,
        branch: "main",
        worktreePath: null,
        buildNewBranchName,
      }),
    ).toEqual({
      type: "new-worktree",
      branch: "main",
      newBranch: "t3code/temp-branch",
    });
    expect(buildNewBranchName).toHaveBeenCalledOnce();
  });

  it("omits temp branch creation for open-worktree mode", () => {
    const buildNewBranchName = vi.fn(() => "t3code/temp-branch");

    expect(
      resolveInitialWorktreeCreation({
        envMode: "open-worktree",
        isFirstMessage: true,
        branch: "feature/existing",
        worktreePath: null,
        buildNewBranchName,
      }),
    ).toEqual({
      type: "open-worktree",
      branch: "feature/existing",
    });
    expect(buildNewBranchName).not.toHaveBeenCalled();
  });

  it("returns none when the thread already has a worktree", () => {
    const buildNewBranchName = vi.fn(() => "t3code/temp-branch");

    expect(
      resolveInitialWorktreeCreation({
        envMode: "open-worktree",
        isFirstMessage: true,
        branch: "feature/existing",
        worktreePath: "/repo/.t3/worktrees/feature-existing",
        buildNewBranchName,
      }),
    ).toEqual({ type: "none" });
    expect(buildNewBranchName).not.toHaveBeenCalled();
  });
});

describe("resolveOpenWorktreeReuseCandidate", () => {
  it("reuses the main repo checkout as local mode", () => {
    expect(
      resolveOpenWorktreeReuseCandidate({
        activeProjectCwd: "/repo",
        branchName: "master",
        branches: [
          {
            name: "master",
            current: true,
            isDefault: true,
            worktreePath: "/repo",
          },
        ],
      }),
    ).toEqual({
      branch: "master",
      worktreePath: null,
    });
  });

  it("reuses an existing secondary worktree", () => {
    expect(
      resolveOpenWorktreeReuseCandidate({
        activeProjectCwd: "/repo",
        branchName: "feature/demo",
        branches: [
          {
            name: "feature/demo",
            current: false,
            isDefault: false,
            worktreePath: "/repo/.t3/worktrees/feature-demo",
          },
        ],
      }),
    ).toEqual({
      branch: "feature/demo",
      worktreePath: "/repo/.t3/worktrees/feature-demo",
    });
  });

  it("returns null when the branch is not already checked out", () => {
    expect(
      resolveOpenWorktreeReuseCandidate({
        activeProjectCwd: "/repo",
        branchName: "feature/demo",
        branches: [
          {
            name: "feature/demo",
            current: false,
            isDefault: false,
            worktreePath: null,
          },
        ],
      }),
    ).toBeNull();
  });
});
