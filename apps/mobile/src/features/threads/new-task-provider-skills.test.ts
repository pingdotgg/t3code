import { describe, expect, it } from "vite-plus/test";

import {
  promptHasNewTaskProviderSkillReference,
  resolveNewTaskProviderSkillsCwd,
} from "./new-task-provider-skills";

describe("promptHasNewTaskProviderSkillReference", () => {
  it("loads workspace metadata only after a skill reference is complete", () => {
    expect(promptHasNewTaskProviderSkillReference("Use $review-follow-up")).toBe(false);
    expect(promptHasNewTaskProviderSkillReference("Use $review-follow-up next")).toBe(true);
  });

  it("ignores non-skill composer tokens", () => {
    expect(promptHasNewTaskProviderSkillReference("Read @AGENTS.md next")).toBe(false);
  });
});

describe("resolveNewTaskProviderSkillsCwd", () => {
  it("uses the selected checkout only for local tasks", () => {
    expect(
      resolveNewTaskProviderSkillsCwd({
        workspaceMode: "local",
        selectedWorktreePath: "/repo/worktrees/feature",
        projectWorkspaceRoot: "/repo",
      }),
    ).toBe("/repo/worktrees/feature");
  });

  it("uses the project root when a local task has no alternate checkout", () => {
    expect(
      resolveNewTaskProviderSkillsCwd({
        workspaceMode: "local",
        selectedWorktreePath: null,
        projectWorkspaceRoot: "/repo",
      }),
    ).toBe("/repo");
  });

  it("uses provider fallback while a future worktree has no cwd", () => {
    expect(
      resolveNewTaskProviderSkillsCwd({
        workspaceMode: "worktree",
        selectedWorktreePath: "/repo/worktrees/existing-feature",
        projectWorkspaceRoot: "/repo",
      }),
    ).toBeNull();
  });
});
