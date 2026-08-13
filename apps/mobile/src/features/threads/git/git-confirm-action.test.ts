import type { VcsStatusAccumulatedResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  canRunConfirmedGitAction,
  parseDefaultBranchConfirmableAction,
  runAfterSuccessfulBranchCreation,
} from "./git-confirm-action";

const knownStatus: VcsStatusAccumulatedResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: true,
  refName: "main",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 1,
  behindCount: 0,
  pr: null,
  remoteStatusKnown: true,
};

describe("Git confirmation readiness", () => {
  it("accepts only actions that require default-branch confirmation", () => {
    expect(parseDefaultBranchConfirmableAction("push")).toBe("push");
    expect(parseDefaultBranchConfirmableAction("commit_push_pr")).toBe("commit_push_pr");
    expect(parseDefaultBranchConfirmableAction("commit")).toBeNull();
    expect(parseDefaultBranchConfirmableAction("unexpected")).toBeNull();
    expect(parseDefaultBranchConfirmableAction(undefined)).toBeNull();
  });

  it("requires current remote data bound to the branch that opened the confirmation", () => {
    const input = {
      confirmAction: "push" as const,
      expectedBranch: "main",
      expectedCwd: "/repo",
      currentCwd: "/repo",
    };

    expect(canRunConfirmedGitAction({ ...input, status: null })).toBe(false);
    expect(
      canRunConfirmedGitAction({
        ...input,
        status: { ...knownStatus, remoteStatusKnown: false },
      }),
    ).toBe(false);
    expect(
      canRunConfirmedGitAction({ ...input, status: { ...knownStatus, refName: "release" } }),
    ).toBe(false);
    expect(canRunConfirmedGitAction({ ...input, currentCwd: "/other", status: knownStatus })).toBe(
      false,
    );
    expect(canRunConfirmedGitAction({ ...input, status: knownStatus })).toBe(true);
  });
});

describe("feature branch confirmation", () => {
  it("runs the pending action after branch creation succeeds", async () => {
    const runAction = vi.fn(async () => undefined);

    await expect(
      runAfterSuccessfulBranchCreation({
        createBranch: async () => true,
        runAction,
      }),
    ).resolves.toBe(true);
    expect(runAction).toHaveBeenCalledOnce();
  });

  it("aborts the pending action when branch creation fails", async () => {
    const runAction = vi.fn(async () => undefined);

    await expect(
      runAfterSuccessfulBranchCreation({
        createBranch: async () => false,
        runAction,
      }),
    ).resolves.toBe(false);
    expect(runAction).not.toHaveBeenCalled();
  });
});
