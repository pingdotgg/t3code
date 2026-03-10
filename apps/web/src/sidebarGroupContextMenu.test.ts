import { describe, expect, it } from "vitest";

import { buildSidebarGroupContextMenuItems } from "./sidebarGroupContextMenu";

describe("sidebarGroupContextMenu", () => {
  it("builds a light menu for Main", () => {
    expect(
      buildSidebarGroupContextMenuItems({
        isMainGroup: true,
        hasBranch: false,
        hasWorktreePath: false,
        hasPr: false,
      }),
    ).toEqual([
      { id: "open-workspace", label: "Open workspace" },
      { id: "copy-workspace-path", label: "Copy workspace path" },
      { id: "new-chat", label: "New chat" },
    ]);
  });

  it("builds a branch-only menu without destructive actions", () => {
    expect(
      buildSidebarGroupContextMenuItems({
        isMainGroup: false,
        hasBranch: true,
        hasWorktreePath: false,
        hasPr: true,
      }),
    ).toEqual([
      { id: "open-workspace", label: "Open workspace" },
      { id: "copy-branch-name", label: "Copy branch name" },
      { id: "copy-project-path", label: "Copy project path" },
      { id: "open-pr", label: "Open PR" },
      { id: "new-chat", label: "New chat" },
    ]);
  });

  it("builds a full worktree menu with destructive action", () => {
    expect(
      buildSidebarGroupContextMenuItems({
        isMainGroup: false,
        hasBranch: true,
        hasWorktreePath: true,
        hasPr: true,
      }),
    ).toEqual([
      { id: "open-workspace", label: "Open workspace" },
      { id: "copy-branch-name", label: "Copy branch name" },
      { id: "copy-workspace-path", label: "Copy worktree path" },
      { id: "open-pr", label: "Open PR" },
      { id: "new-chat", label: "New chat" },
      {
        id: "delete-group-worktree-and-chats",
        label: "Delete chats and worktree",
        destructive: true,
      },
    ]);
  });
});
