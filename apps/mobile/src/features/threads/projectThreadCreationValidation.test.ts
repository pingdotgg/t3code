import { describe, expect, it } from "vite-plus/test";

import {
  isProjectThreadGitStatusSettled,
  resolveProjectThreadCreationBranch,
} from "./projectThreadCreationValidation";

describe("isProjectThreadGitStatusSettled", () => {
  it("settles when a queued-task stand-in has no workspace root", () => {
    expect(
      isProjectThreadGitStatusSettled({
        hasWorkspaceRoot: false,
        hasData: false,
        hasError: false,
      }),
    ).toBe(true);
  });

  it("waits while a real workspace status query is loading", () => {
    expect(
      isProjectThreadGitStatusSettled({
        hasWorkspaceRoot: true,
        hasData: false,
        hasError: false,
      }),
    ).toBe(false);
  });

  it.each([
    { hasData: true, hasError: false },
    { hasData: false, hasError: true },
  ])("settles when the workspace query completes: %o", ({ hasData, hasError }) => {
    expect(
      isProjectThreadGitStatusSettled({
        hasWorkspaceRoot: true,
        hasData,
        hasError,
      }),
    ).toBe(true);
  });
});

describe("resolveProjectThreadCreationBranch", () => {
  it("uses the live checkout for an untouched local draft label and recorded branch", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: null,
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("feature/x");
  });

  it("prefers an explicit picker choice over the current checkout", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: "main",
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("main");
  });

  it("stays null when no ref is checked out (detached HEAD, non-repository, status not loaded)", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "local",
        selectedBranch: null,
        currentCheckoutBranch: null,
      }),
    ).toBeNull();
  });

  it("never borrows the current checkout for a worktree draft", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "worktree",
        selectedBranch: null,
        currentCheckoutBranch: "feature/x",
      }),
    ).toBeNull();
  });

  it("keeps the explicit base branch for a worktree draft", () => {
    expect(
      resolveProjectThreadCreationBranch({
        workspaceMode: "worktree",
        selectedBranch: "main",
        currentCheckoutBranch: "feature/x",
      }),
    ).toBe("main");
  });
});
