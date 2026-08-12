import type { ContextMenuItem } from "@t3tools/contracts";

import { buildBoardPlacementContextMenuItems } from "../board/boardPlacementMenu.ts";
import type { BoardLane } from "../board/boardLaneStore.ts";

export const THREAD_CONTEXT_MENU_ITEM_IDS = {
  newThreadOnBranch: "new-thread-on-branch",
  rename: "rename",
  markUnread: "mark-unread",
  copyPath: "copy-path",
  copyThreadId: "copy-thread-id",
  delete: "delete",
} as const;

export type ThreadContextMenuItemId =
  (typeof THREAD_CONTEXT_MENU_ITEM_IDS)[keyof typeof THREAD_CONTEXT_MENU_ITEM_IDS];

export type ThreadContextMenuThreadSummary = {
  readonly branch: string | null;
  readonly id: string;
};

export type BuildThreadContextMenuItemsInput = {
  readonly thread: ThreadContextMenuThreadSummary;
  readonly lanes: ReadonlyArray<BoardLane>;
  readonly includeRename: boolean;
  readonly includeMarkUnread: boolean;
};

export function buildThreadContextMenuItems(
  input: BuildThreadContextMenuItemsInput,
): ReadonlyArray<ContextMenuItem> {
  const { thread, lanes, includeRename, includeMarkUnread } = input;

  return [
    ...(thread.branch
      ? [
          {
            id: THREAD_CONTEXT_MENU_ITEM_IDS.newThreadOnBranch,
            label: `New thread on ${thread.branch}`,
          },
        ]
      : []),
    ...buildBoardPlacementContextMenuItems(lanes),
    ...(includeRename ? [{ id: THREAD_CONTEXT_MENU_ITEM_IDS.rename, label: "Rename thread" }] : []),
    ...(includeMarkUnread
      ? [{ id: THREAD_CONTEXT_MENU_ITEM_IDS.markUnread, label: "Mark unread" }]
      : []),
    { id: THREAD_CONTEXT_MENU_ITEM_IDS.copyPath, label: "Copy Path" },
    { id: THREAD_CONTEXT_MENU_ITEM_IDS.copyThreadId, label: "Copy Thread ID" },
    {
      id: THREAD_CONTEXT_MENU_ITEM_IDS.delete,
      label: "Delete",
      destructive: true,
      icon: "trash",
    },
  ];
}
