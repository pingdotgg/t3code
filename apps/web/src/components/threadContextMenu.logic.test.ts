import { describe, expect, it } from "vite-plus/test";

import { buildBoardPlacementContextMenuItems } from "../board/boardPlacementMenu.ts";
import {
  buildThreadContextMenuItems,
  THREAD_CONTEXT_MENU_ITEM_IDS,
} from "./threadContextMenu.logic.ts";
import type { BoardLane } from "../board/boardLaneStore.ts";

const LANES: ReadonlyArray<BoardLane> = [
  {
    id: "shaping",
    name: "Grilling / shaping",
    description: "Working out what this actually is",
    order: 0,
  },
  {
    id: "ready",
    name: "Ready",
    description: "Groomed and ready to pick up",
    order: 1,
  },
];

describe("buildThreadContextMenuItems", () => {
  it("produces the full sidebar-style menu in today's order", () => {
    const thread = { branch: "feat/menu", id: "thread-abc" };

    expect(
      buildThreadContextMenuItems({
        thread,
        lanes: LANES,
        includeRename: true,
        includeMarkUnread: true,
      }),
    ).toEqual([
      {
        id: THREAD_CONTEXT_MENU_ITEM_IDS.newThreadOnBranch,
        label: "New thread on feat/menu",
      },
      ...buildBoardPlacementContextMenuItems(LANES),
      { id: THREAD_CONTEXT_MENU_ITEM_IDS.rename, label: "Rename thread" },
      { id: THREAD_CONTEXT_MENU_ITEM_IDS.markUnread, label: "Mark unread" },
      { id: THREAD_CONTEXT_MENU_ITEM_IDS.copyPath, label: "Copy Path" },
      { id: THREAD_CONTEXT_MENU_ITEM_IDS.copyThreadId, label: "Copy Thread ID" },
      {
        id: THREAD_CONTEXT_MENU_ITEM_IDS.delete,
        label: "Delete",
        destructive: true,
        icon: "trash",
      },
    ]);
  });

  it("omits rename and mark-unread when those capabilities are off", () => {
    const items = buildThreadContextMenuItems({
      thread: { branch: null, id: "thread-abc" },
      lanes: LANES,
      includeRename: false,
      includeMarkUnread: false,
    });

    expect(items.map((item) => item.id)).toEqual([
      ...buildBoardPlacementContextMenuItems(LANES).map((item) => item.id),
      THREAD_CONTEXT_MENU_ITEM_IDS.copyPath,
      THREAD_CONTEXT_MENU_ITEM_IDS.copyThreadId,
      THREAD_CONTEXT_MENU_ITEM_IDS.delete,
    ]);
    expect(items.find((item) => item.id === THREAD_CONTEXT_MENU_ITEM_IDS.rename)).toBeUndefined();
    expect(
      items.find((item) => item.id === THREAD_CONTEXT_MENU_ITEM_IDS.markUnread),
    ).toBeUndefined();
  });

  it("reflects the passed lane registry in placement items", () => {
    const singleLane: ReadonlyArray<BoardLane> = [LANES[0]!];
    const items = buildThreadContextMenuItems({
      thread: { branch: null, id: "t1" },
      lanes: singleLane,
      includeRename: false,
      includeMarkUnread: false,
    });

    const placement = items.find((item) => item.id === "place-in-lane");
    expect(placement?.children).toEqual([
      { id: `place-in-lane:${singleLane[0]!.id}`, label: singleLane[0]!.name },
    ]);
  });

  it("includes delete marked destructive", () => {
    const items = buildThreadContextMenuItems({
      thread: { branch: null, id: "t1" },
      lanes: LANES,
      includeRename: false,
      includeMarkUnread: false,
    });

    expect(items.at(-1)).toEqual({
      id: THREAD_CONTEXT_MENU_ITEM_IDS.delete,
      label: "Delete",
      destructive: true,
      icon: "trash",
    });
  });
});
