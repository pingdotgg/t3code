import { describe, expect, it, vi } from "vitest";

import {
  buildGeneratedWorktreeBranchName,
  buildTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  resolveAutoFeatureBranchName,
  sanitizeBranchFragment,
  sanitizeFeatureBranchName,
  WORKTREE_BRANCH_PREFIX,
} from "./git";

describe("sanitizeBranchFragment", () => {
  it("normalizes arbitrary strings into valid git branch fragments", () => {
    expect(sanitizeBranchFragment(" Fix session timeout! ")).toBe("fix-session-timeout");
    expect(sanitizeBranchFragment("refs/heads/feature/keep-this")).toBe(
      "refs/heads/feature/keep-this",
    );
  });
});

describe("sanitizeFeatureBranchName", () => {
  it("adds the feature prefix when needed", () => {
    expect(sanitizeFeatureBranchName("fix/session-timeout")).toBe("feature/fix/session-timeout");
  });

  it("preserves an existing feature prefix", () => {
    expect(sanitizeFeatureBranchName("feature/fix/session-timeout")).toBe(
      "feature/fix/session-timeout",
    );
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("returns the preferred feature branch when it is available", () => {
    expect(resolveAutoFeatureBranchName(["main"], "fix/session-timeout")).toBe(
      "feature/fix/session-timeout",
    );
  });

  it("appends a suffix when the preferred feature branch already exists", () => {
    expect(
      resolveAutoFeatureBranchName(
        ["feature/fix/session-timeout", "feature/fix/session-timeout-2"],
        "fix/session-timeout",
      ),
    ).toBe("feature/fix/session-timeout-3");
  });
});

describe("worktree branch helpers", () => {
  it("builds temporary worktree branches with the OSSCode prefix", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("ABCDEF12-3456-7890-abcd-ef1234567890");

    expect(buildTemporaryWorktreeBranchName()).toBe(`${WORKTREE_BRANCH_PREFIX}/abcdef12`);
  });

  it("detects temporary worktree branches case-insensitively", () => {
    expect(isTemporaryWorktreeBranch("OSSCode/abcdef12")).toBe(true);
    expect(isTemporaryWorktreeBranch("osscode/abcdef12")).toBe(true);
    expect(isTemporaryWorktreeBranch("OSSCode/feature-session")).toBe(false);
  });

  it("normalizes generated worktree branch names onto the OSSCode prefix", () => {
    expect(buildGeneratedWorktreeBranchName("refs/heads/OSSCode/feat/session")).toBe(
      "OSSCode/feat/session",
    );
    expect(buildGeneratedWorktreeBranchName("Fix session timeout")).toBe(
      "OSSCode/fix-session-timeout",
    );
  });
});
