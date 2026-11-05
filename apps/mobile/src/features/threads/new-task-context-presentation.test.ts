import { describe, expect, it } from "vite-plus/test";

import {
  resolveNewTaskBranchLabel,
  resolveNewTaskDraftWorkspace,
} from "./new-task-context-presentation";

describe("resolveNewTaskDraftWorkspace", () => {
  // regression: #21404 use current checkout for non-git projects
  it("clears stale selections for non-git projects", () => {
    expect(
      resolveNewTaskDraftWorkspace({
        selection: {
          branch: "main",
          pullRequestReference: "https://github.com/acme/repo/pull/123",
        },
        canChooseWorkspace: true,
        isGitRepo: false,
      }),
    ).toEqual({ branch: null });
  });

  it("preserves the selection for git projects", () => {
    const selection = { branch: "feature" } as const;
    expect(
      resolveNewTaskDraftWorkspace({ selection, canChooseWorkspace: true, isGitRepo: true }),
    ).toBe(selection);
    expect(
      resolveNewTaskDraftWorkspace({
        selection: undefined,
        canChooseWorkspace: true,
        isGitRepo: true,
      }),
    ).toEqual({ branch: null });
  });

  it("ignores a stored selection when the workspace cannot be chosen", () => {
    expect(
      resolveNewTaskDraftWorkspace({
        selection: { branch: "feature" },
        canChooseWorkspace: false,
        isGitRepo: true,
      }),
    ).toEqual({ branch: null });
  });
});

describe("resolveNewTaskBranchLabel", () => {
  it("asks for a branch until one is chosen", () => {
    expect(resolveNewTaskBranchLabel(null)).toBe("Choose branch");
    expect(resolveNewTaskBranchLabel("feature")).toBe("feature");
  });
});
