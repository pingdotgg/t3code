import type { VcsStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import { resolveLiveThreadBranchUpdate } from "./gitActions.js";

function status(refName: string): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: refName === "main",
    refName,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  };
}

describe("resolveLiveThreadBranchUpdate", () => {
  it("allows a temporary worktree ref to reconcile to a semantic branch", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "t3code/a9628676",
      gitStatus: status("feature/diff-panel-toggle"),
    });

    assert.deepEqual(update, { branch: "feature/diff-panel-toggle" });
  });

  it("still reconciles ordinary semantic branch changes", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old",
      gitStatus: status("feature/new"),
    });

    assert.deepEqual(update, { branch: "feature/new" });
  });
});
