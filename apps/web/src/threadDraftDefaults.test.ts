import { describe, expect, it, vi } from "vitest";

import { buildNewThreadDraftDefaults } from "./threadDraftDefaults";

function makeApi(status: (input: { cwd: string }) => Promise<{ branch: string | null }>) {
  return {
    git: {
      status,
    },
  };
}

describe("buildNewThreadDraftDefaults", () => {
  it("returns a blank local draft when new-worktree preference is off", async () => {
    const status = vi.fn(async (_input: { cwd: string }) => ({ branch: null }));

    await expect(
      buildNewThreadDraftDefaults({
        api: makeApi(status),
        projectCwd: "/repo/project",
        preferNewWorktree: false,
      }),
    ).resolves.toEqual({
      branch: null,
      worktreePath: null,
      envMode: "local",
    });

    expect(status).not.toHaveBeenCalled();
  });

  it("returns a blank local draft when forceLocal is enabled", async () => {
    const status = vi.fn(async (_input: { cwd: string }) => ({ branch: null }));

    await expect(
      buildNewThreadDraftDefaults({
        api: makeApi(status),
        projectCwd: "/repo/project",
        preferNewWorktree: true,
        forceLocal: true,
      }),
    ).resolves.toEqual({
      branch: null,
      worktreePath: null,
      envMode: "local",
    });

    expect(status).not.toHaveBeenCalled();
  });

  it("returns a pending worktree draft seeded from the current branch", async () => {
    const status = vi.fn(async (_input: { cwd: string }) => ({ branch: "main" }));

    await expect(
      buildNewThreadDraftDefaults({
        api: makeApi(status),
        projectCwd: "/repo/project",
        preferNewWorktree: true,
      }),
    ).resolves.toEqual({
      branch: "main",
      worktreePath: null,
      envMode: "worktree",
    });

    expect(status).toHaveBeenCalledWith({ cwd: "/repo/project" });
  });

  it("keeps worktree mode even when git status has no current branch", async () => {
    const status = vi.fn(async (_input: { cwd: string }) => ({ branch: null }));

    await expect(
      buildNewThreadDraftDefaults({
        api: makeApi(status),
        projectCwd: "/repo/project",
        preferNewWorktree: true,
      }),
    ).resolves.toEqual({
      branch: null,
      worktreePath: null,
      envMode: "worktree",
    });
  });
});
