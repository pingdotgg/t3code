import type { ContextMenuItem } from "@t3tools/contracts";

export type ArchivedThreadContextMenuAction = "unarchive" | "delete";

export const archivedThreadContextMenuItems = [
  { id: "unarchive", label: "Unarchive", icon: "archive" },
  {
    id: "delete",
    label: "Delete",
    destructive: true,
    icon: "trash",
    separatorBefore: true,
  },
] as const satisfies readonly ContextMenuItem<ArchivedThreadContextMenuAction>[];
