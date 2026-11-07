import { describe, expect, it } from "@effect/vitest";
import type { ThreadRepoWorktree } from "@t3tools/contracts";

import { repoWorktreeNote } from "./RepoWorktreeNote.ts";

const enabled = { repoWorktrees: true, repoWorktreeInstructions: "" };

const worktree = (index: number): ThreadRepoWorktree => ({
  repository: `repo-${index}`,
  repositoryPath: `/folder/repo-${index}`,
  worktreePath: `/worktrees/repo-${index}/feature`,
  branch: "feature",
  baseRef: "main",
  origin: "created",
  attachedAt: "2026-11-04T00:00:00.000Z",
});

const note = (overrides: Partial<Parameters<typeof repoWorktreeNote>[0]> = {}) =>
  repoWorktreeNote({
    userText: "Fix the login bug",
    hasT3Mcp: true,
    settings: enabled,
    repoWorktrees: [],
    ...overrides,
  });

describe("repoWorktreeNote", () => {
  it("adds nothing unless the project opted in and the session can call T3 tools", () => {
    expect(note({ settings: { repoWorktrees: false, repoWorktreeInstructions: "x" } })).toBe("");
    expect(note({ settings: null })).toBe("");
    expect(note({ hasT3Mcp: false })).toBe("");
  });

  it("keeps slash commands first in the prompt", () => {
    expect(note({ userText: "  /compact" })).toBe("");
  });

  // The setting can turn on partway through a conversation, so no turn may
  // count on an earlier one having carried the rules.
  it("carries every rule the agent needs on any turn it is sent", () => {
    const rules = note();
    expect(rules).toContain("never edit, commit, or switch branches there");
    expect(rules).toContain("t3_repo_worktree_ensure");
    expect(rules).toContain("never stash, reset, or clean");
    expect(rules).toContain("Use a new branch name for new, independent work");
    expect(rules).toContain("`useExistingBranch:true` only to continue an existing branch");
    expect(rules).toContain("t3_repo_worktree_set_submodule");
    expect(rules).toContain("checkpoints these worktrees with every turn");
  });

  it("repeats project guidance and where the work is on every turn", () => {
    const later = note({
      settings: {
        repoWorktrees: true,
        repoWorktreeInstructions: "Base framework branches on team-develop.",
      },
      repoWorktrees: [worktree(1)],
    });
    expect(later).toContain("Project guidance:\nBase framework branches on team-develop.");
    expect(later).toContain("- repo-1 on feature: /worktrees/repo-1/feature");
  });

  it("caps the listed worktrees and points at the full list", () => {
    const many = note({ repoWorktrees: Array.from({ length: 25 }, (_, index) => worktree(index)) });
    expect(many).toContain("- repo-19 on feature");
    expect(many).not.toContain("- repo-20 on feature");
    expect(many).toContain("- and 5 more (see t3_worktree_status)");
  });
});
