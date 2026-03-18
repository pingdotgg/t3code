import type { GitWorktreeBranchNaming } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKTREE_BRANCH_PREFIX,
  buildFinalWorktreeBranchName,
  buildInitialWorktreeBranchName,
  isTemporaryWorktreeBranchName,
} from "./git";

describe("buildInitialWorktreeBranchName", () => {
  it("uses the default prefix in auto mode", () => {
    expect(buildInitialWorktreeBranchName({ mode: "auto" }, "deadbeef")).toBe("t3code/deadbeef");
  });

  it("uses the configured prefix in prefix mode", () => {
    const naming: GitWorktreeBranchNaming = {
      mode: "prefix",
      prefix: "Team Branches",
    };

    expect(buildInitialWorktreeBranchName(naming, "deadbeef")).toBe("team-branches/deadbeef");
  });

  it("uses the full branch name without suffixes in full mode", () => {
    const naming: GitWorktreeBranchNaming = {
      mode: "full",
      branchName: "feature/my-custom-branch",
    };

    expect(buildInitialWorktreeBranchName(naming, "deadbeef")).toBe("feature/my-custom-branch");
  });
});

describe("buildFinalWorktreeBranchName", () => {
  it("keeps the default prefix in auto mode", () => {
    expect(buildFinalWorktreeBranchName("feat/session")).toBe("t3code/feat/session");
  });

  it("replaces the default prefix with a custom prefix", () => {
    expect(
      buildFinalWorktreeBranchName("t3code/feat/session", {
        mode: "prefix",
        prefix: "team-branches",
      }),
    ).toBe("team-branches/feat/session");
  });

  it("returns the explicit branch name in full mode", () => {
    expect(
      buildFinalWorktreeBranchName("ignored", {
        mode: "full",
        branchName: "feature/my-custom-branch",
      }),
    ).toBe("feature/my-custom-branch");
  });
});

describe("isTemporaryWorktreeBranchName", () => {
  it("detects temporary auto branches", () => {
    expect(isTemporaryWorktreeBranchName("t3code/deadbeef")).toBe(true);
  });

  it("detects temporary custom-prefix branches", () => {
    expect(
      isTemporaryWorktreeBranchName("team-branches/deadbeef", {
        mode: "prefix",
        prefix: "Team Branches",
      }),
    ).toBe(true);
  });

  it("never treats explicit full branch names as temporary", () => {
    expect(
      isTemporaryWorktreeBranchName("feature/my-custom-branch", {
        mode: "full",
        branchName: "feature/my-custom-branch",
      }),
    ).toBe(false);
  });

  it("exports the default prefix constant", () => {
    expect(DEFAULT_WORKTREE_BRANCH_PREFIX).toBe("t3code");
  });
});
