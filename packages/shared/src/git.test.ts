import { describe, expect, it } from "vitest";

import {
  buildTemporaryWorktreeBranchName,
  buildWorktreeBranchName,
  DEFAULT_WORKTREE_BRANCH_PREFIX,
  isTemporaryWorktreeBranch,
  sanitizeBranchFragment,
  sanitizeWorktreeBranchPrefix,
} from "./git";

describe("sanitizeBranchFragment", () => {
  it("strips URLs before normalizing branch fragments", () => {
    expect(
      sanitizeBranchFragment(
        "Verify Poland weight fix merge https://github.com/pingdotgg/t3code/pull/123",
      ),
    ).toBe("verify-poland-weight-fix-merge");
  });
});

describe("sanitizeWorktreeBranchPrefix", () => {
  it("falls back to the default prefix when the input is empty", () => {
    expect(sanitizeWorktreeBranchPrefix("")).toBe(DEFAULT_WORKTREE_BRANCH_PREFIX);
  });

  it("normalizes slash-separated custom prefixes", () => {
    expect(sanitizeWorktreeBranchPrefix(" Team/Feature/ ")).toBe("team/feature");
  });
});

describe("buildWorktreeBranchName", () => {
  it("avoids duplicating the configured prefix", () => {
    expect(buildWorktreeBranchName("feature", " Feature/refine-toolbar-actions ")).toBe(
      "feature/refine-toolbar-actions",
    );
  });
});

describe("temporary worktree branches", () => {
  it("builds temporary branches under the configured prefix", () => {
    const branch = buildTemporaryWorktreeBranchName("Bugfix/");

    expect(branch).toMatch(/^bugfix\/[0-9a-f]{8}$/);
    expect(isTemporaryWorktreeBranch(branch, "bugfix")).toBe(true);
  });
});
