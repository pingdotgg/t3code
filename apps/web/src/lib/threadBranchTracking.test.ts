import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { resolveThreadBranchAutoLink, resolveThreadBranchMismatch } from "./threadBranchTracking";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "main",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("resolveThreadBranchAutoLink", () => {
  it("auto-links a chat without a branch to the current ref", () => {
    expect(
      resolveThreadBranchAutoLink({
        threadBranch: null,
        gitStatus: status({ refName: "feature/x" }),
      }),
    ).toEqual({ branch: "feature/x" });
  });

  it("never overwrites an existing chat-branch link", () => {
    expect(
      resolveThreadBranchAutoLink({
        threadBranch: "feature/y",
        gitStatus: status({ refName: "feature/x" }),
      }),
    ).toBeNull();
  });

  it("ignores temporary worktree-bootstrap branches", () => {
    expect(
      resolveThreadBranchAutoLink({
        threadBranch: null,
        gitStatus: status({ refName: "t3code/abcd1234" }),
      }),
    ).toBeNull();
  });

  it("does nothing in detached HEAD or without git status", () => {
    expect(
      resolveThreadBranchAutoLink({
        threadBranch: null,
        gitStatus: status({ refName: null }),
      }),
    ).toBeNull();
    expect(resolveThreadBranchAutoLink({ threadBranch: null, gitStatus: null })).toBeNull();
  });
});

describe("resolveThreadBranchMismatch", () => {
  it("returns null when branches match", () => {
    expect(resolveThreadBranchMismatch({ threadBranch: "main", currentBranch: "main" })).toBeNull();
  });

  it("returns mismatch info when chat and checkout differ", () => {
    expect(
      resolveThreadBranchMismatch({
        threadBranch: "feature/a",
        currentBranch: "feature/b",
      }),
    ).toEqual({
      threadBranch: "feature/a",
      currentBranch: "feature/b",
    });
  });

  it("ignores transient temporary worktree branches", () => {
    expect(
      resolveThreadBranchMismatch({
        threadBranch: "feature/a",
        currentBranch: "t3code/abcd1234",
      }),
    ).toBeNull();
  });

  it("returns null when either side is missing", () => {
    expect(resolveThreadBranchMismatch({ threadBranch: null, currentBranch: "main" })).toBeNull();
    expect(resolveThreadBranchMismatch({ threadBranch: "main", currentBranch: null })).toBeNull();
  });
});
