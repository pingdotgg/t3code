import { describe, expect, it } from "vite-plus/test";

import { workspaceSelectionFromThread } from "./new-thread-from-thread";

describe("workspaceSelectionFromThread", () => {
  it("reuses an existing worktree instead of requesting a new one", () => {
    expect(
      workspaceSelectionFromThread({
        branch: "feature/mobile-menu",
        worktreePath: "/repo/.worktrees/mobile-menu",
      }),
    ).toEqual({
      mode: "local",
      branch: "feature/mobile-menu",
      worktreePath: "/repo/.worktrees/mobile-menu",
      startFromOrigin: false,
    });
  });
});
