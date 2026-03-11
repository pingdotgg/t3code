import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKTREE_BRANCH_PREFIX,
  buildGeneratedWorktreeBranchName,
  extractTemporaryWorktreeBranchPrefix,
  isTemporaryWorktreeBranch,
  normalizeWorktreeBranchPrefix,
  resolvePullRequestWorktreeLocalBranchName,
} from "./git";

describe("normalizeWorktreeBranchPrefix", () => {
  it("falls back to the default prefix when the input is empty", () => {
    expect(normalizeWorktreeBranchPrefix("")).toBe(DEFAULT_WORKTREE_BRANCH_PREFIX);
    expect(normalizeWorktreeBranchPrefix("   ")).toBe(DEFAULT_WORKTREE_BRANCH_PREFIX);
    expect(normalizeWorktreeBranchPrefix(null)).toBe(DEFAULT_WORKTREE_BRANCH_PREFIX);
  });

  it("preserves slash-separated namespaces while sanitizing invalid characters", () => {
    expect(normalizeWorktreeBranchPrefix(" Team/Feature Branch ")).toBe("team/feature-branch");
  });
});

describe("extractTemporaryWorktreeBranchPrefix", () => {
  it("detects temporary worktree branches and returns their prefix", () => {
    expect(extractTemporaryWorktreeBranchPrefix("custom/team/1a2b3c4d")).toBe("custom/team");
    expect(isTemporaryWorktreeBranch("custom/team/1a2b3c4d")).toBe(true);
  });

  it("ignores non-temporary branches", () => {
    expect(extractTemporaryWorktreeBranchPrefix("custom/team/feature-branch")).toBeNull();
    expect(isTemporaryWorktreeBranch("custom/team/feature-branch")).toBe(false);
  });
});

describe("buildGeneratedWorktreeBranchName", () => {
  it("reuses the configured prefix for generated branch names", () => {
    expect(buildGeneratedWorktreeBranchName("feat/Branch Name", "custom/team")).toBe(
      "custom/team/feat/branch-name",
    );
  });

  it("strips a duplicate prefix before reapplying it", () => {
    expect(buildGeneratedWorktreeBranchName("custom/team/feat/example", "custom/team")).toBe(
      "custom/team/feat/example",
    );
  });
});

describe("resolvePullRequestWorktreeLocalBranchName", () => {
  it("keeps local PR branches unchanged for same-repo pull requests", () => {
    expect(
      resolvePullRequestWorktreeLocalBranchName({
        number: 42,
        headBranch: "feature/pr-thread",
        isCrossRepository: false,
      }),
    ).toBe("feature/pr-thread");
  });

  it("names cross-repo PR worktree branches with the configured prefix", () => {
    expect(
      resolvePullRequestWorktreeLocalBranchName({
        number: 42,
        headBranch: "main",
        isCrossRepository: true,
        branchPrefix: "custom/team",
      }),
    ).toBe("custom/team/pr-42/main");
  });
});
