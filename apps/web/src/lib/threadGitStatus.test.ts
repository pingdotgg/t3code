import type { GitStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vitest";
import { resolveThreadScopedGitStatus, resolveThreadScopedPr } from "./threadGitStatus";

const openPr = {
  number: 42,
  title: "Existing PR",
  url: "https://example.com/pr/42",
  baseBranch: "main",
  headBranch: "feature/test",
  state: "open" as const,
};

function status(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    branch: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: openPr,
    ...overrides,
  };
}

describe("resolveThreadScopedGitStatus", () => {
  it("strips PR metadata for branchless threads", () => {
    assert.deepEqual(
      resolveThreadScopedGitStatus({
        gitStatus: status({ aheadCount: 3 }),
        threadBranch: null,
      }),
      status({ aheadCount: 3, pr: null }),
    );
  });

  it("keeps matching branch status intact", () => {
    assert.deepEqual(
      resolveThreadScopedGitStatus({
        gitStatus: status(),
        threadBranch: "feature/test",
      }),
      status(),
    );
  });

  it("returns null when a branch-bound thread drifts onto another branch", () => {
    assert.equal(
      resolveThreadScopedGitStatus({
        gitStatus: status({ branch: "main" }),
        threadBranch: "feature/test",
      }),
      null,
    );
  });
});

describe("resolveThreadScopedPr", () => {
  it("only returns a PR for a matching thread branch", () => {
    assert.equal(
      resolveThreadScopedPr({
        gitStatus: status(),
        threadBranch: null,
      }),
      null,
    );
    assert.deepEqual(
      resolveThreadScopedPr({
        gitStatus: status(),
        threadBranch: "feature/test",
      }),
      openPr,
    );
  });
});
