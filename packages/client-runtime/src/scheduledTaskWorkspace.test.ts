import { expect, it } from "vite-plus/test";

import { scheduledTaskWorkspaceInput } from "./scheduledTaskWorkspace.ts";

it("asks the server for the default branch only when the base was left blank", () => {
  const worktree = { mode: "worktree", startFromOrigin: true, worktreePath: "" } as const;
  expect(scheduledTaskWorkspaceInput({ ...worktree, baseRef: " " })).toEqual({
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    defaultBaseRef: true,
  });
  expect(scheduledTaskWorkspaceInput({ ...worktree, baseRef: "main" })).toEqual({
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
  });
  expect(scheduledTaskWorkspaceInput({ ...worktree, mode: "root", baseRef: "" })).toEqual({
    workspaceStrategy: { type: "root" },
  });
});
