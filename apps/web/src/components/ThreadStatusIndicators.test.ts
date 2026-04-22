import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { resolveThreadPr } from "./ThreadStatusIndicators";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/current",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: {
      number: 42,
      title: "PR branch",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      baseBranch: "main",
      headBranch: "feature/current",
      state: "open",
    },
    ...overrides,
  };
}

describe("resolveThreadPr", () => {
  it("keeps local-checkout PR indicators scoped to the stored thread branch", () => {
    expect(
      resolveThreadPr({
        threadBranch: "feature/other",
        gitStatus: status(),
        hasDedicatedWorktree: false,
      }),
    ).toBeNull();
  });

  it("shows PR indicators for dedicated worktree threads even when branch metadata is stale", () => {
    const gitStatus = status();

    expect(
      resolveThreadPr({
        threadBranch: "feature/old-name",
        gitStatus,
        hasDedicatedWorktree: true,
      }),
    ).toBe(gitStatus.pr);
  });

  it("shows PR indicators for dedicated worktree threads even when branch metadata is missing", () => {
    const gitStatus = status();

    expect(
      resolveThreadPr({
        threadBranch: null,
        gitStatus,
        hasDedicatedWorktree: true,
      }),
    ).toBe(gitStatus.pr);
  });
});
