import type { ContextMenuItem } from "@t3tools/contracts";

export type SidebarGroupContextMenuAction =
  | "open-workspace"
  | "copy-workspace-path"
  | "copy-project-path"
  | "copy-branch-name"
  | "open-pr"
  | "new-chat"
  | "delete-group-worktree-and-chats";

export function buildSidebarGroupContextMenuItems(input: {
  isMainGroup: boolean;
  hasBranch: boolean;
  hasWorktreePath: boolean;
  hasPr: boolean;
}): ContextMenuItem<SidebarGroupContextMenuAction>[] {
  if (input.isMainGroup) {
    return [
      { id: "open-workspace", label: "Open workspace" },
      { id: "copy-workspace-path", label: "Copy workspace path" },
      { id: "new-chat", label: "New chat" },
    ];
  }

  const items: ContextMenuItem<SidebarGroupContextMenuAction>[] = [
    { id: "open-workspace", label: "Open workspace" },
  ];

  if (input.hasBranch) {
    items.push({ id: "copy-branch-name", label: "Copy branch name" });
  }

  items.push(
    input.hasWorktreePath
      ? { id: "copy-workspace-path", label: "Copy worktree path" }
      : { id: "copy-project-path", label: "Copy project path" },
  );

  if (input.hasPr) {
    items.push({ id: "open-pr", label: "Open PR" });
  }

  items.push({ id: "new-chat", label: "New chat" });

  if (input.hasWorktreePath) {
    items.push({
      id: "delete-group-worktree-and-chats",
      label: "Delete chats and worktree",
      destructive: true,
    });
  }

  return items;
}
