import { describe, expect, it } from "vitest";

import {
  DEFAULT_DRAFT_WORKTREE_BRANCH_NAMING_STATE,
  normalizeDraftWorktreeBranchNaming,
  resolveDraftWorktreeBranchNamingValidationError,
  resolveWorktreeBranchNamingForThreadCreate,
  updateDraftWorktreeBranchNamingMode,
} from "./worktreeBranchNaming";

describe("normalizeDraftWorktreeBranchNaming", () => {
  it("falls back to auto mode when the value is missing", () => {
    expect(normalizeDraftWorktreeBranchNaming(undefined)).toEqual(
      DEFAULT_DRAFT_WORKTREE_BRANCH_NAMING_STATE,
    );
  });
});

describe("resolveDraftWorktreeBranchNamingValidationError", () => {
  it("requires a prefix when prefix mode is selected", () => {
    expect(
      resolveDraftWorktreeBranchNamingValidationError({
        mode: "prefix",
        prefix: "   ",
        branchName: "",
      }),
    ).toBe("Enter a prefix before sending in New worktree mode.");
  });

  it("requires a branch name when full mode is selected", () => {
    expect(
      resolveDraftWorktreeBranchNamingValidationError({
        mode: "full",
        prefix: "",
        branchName: "   ",
      }),
    ).toBe("Enter a full branch name before sending in New worktree mode.");
  });
});

describe("resolveWorktreeBranchNamingForThreadCreate", () => {
  it("returns auto mode when no draft state exists", () => {
    expect(resolveWorktreeBranchNamingForThreadCreate(undefined)).toEqual({ mode: "auto" });
  });

  it("returns a trimmed prefix configuration", () => {
    expect(
      resolveWorktreeBranchNamingForThreadCreate({
        mode: "prefix",
        prefix: " team-branches ",
        branchName: "",
      }),
    ).toEqual({
      mode: "prefix",
      prefix: "team-branches",
    });
  });

  it("returns a trimmed full branch name configuration", () => {
    expect(
      resolveWorktreeBranchNamingForThreadCreate({
        mode: "full",
        prefix: "",
        branchName: " feature/custom-branch ",
      }),
    ).toEqual({
      mode: "full",
      branchName: "feature/custom-branch",
    });
  });
});

describe("updateDraftWorktreeBranchNamingMode", () => {
  it("seeds prefix mode with the default prefix", () => {
    expect(updateDraftWorktreeBranchNamingMode(undefined, "prefix")).toEqual({
      mode: "prefix",
      prefix: "t3code",
      branchName: "",
    });
  });
});
