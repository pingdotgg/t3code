import { describe, expect, test } from "vite-plus/test";

import {
  buildWorkspaceTabContextMenuItems,
  resolveWorkspaceTabLayoutAction,
  resolveWorkspaceTabSplitAction,
} from "./RightPanelTabs.logic";

const NO_ADJACENT_PANES = { up: null, down: null, left: null, right: null } as const;

describe("workspace tab context menus", () => {
  test("offers copy and move split actions for a surface tab", () => {
    const items = buildWorkspaceTabContextMenuItems({
      target: {
        _tag: "Surface",
        surface: {
          id: "file:src/app.ts",
          kind: "file",
          relativePath: "src/app.ts",
          revealLine: null,
          revealRequestId: 0,
        },
      },
      surfaceCount: 3,
      surfaceIndex: 1,
      adjacentGroups: NO_ADJACENT_PANES,
      moveToGroupAvailable: true,
      copyToSplitAvailable: true,
      moveToSplitAvailable: true,
    });

    expect(items).toContainEqual({ id: "split-right", label: "Split Right", disabled: false });
    expect(items).toContainEqual({ id: "split-down", label: "Split Down", disabled: false });
    expect(items.at(-1)).toMatchObject({
      id: "split-and-move",
      children: [
        { id: "move-up", disabled: false },
        { id: "move-down", disabled: false },
        { id: "move-left", disabled: false },
        { id: "move-right", disabled: false },
      ],
    });
  });

  test("includes adjacent panes as move destinations", () => {
    const items = buildWorkspaceTabContextMenuItems({
      target: { _tag: "Thread" },
      surfaceCount: 0,
      surfaceIndex: -1,
      adjacentGroups: { up: null, down: null, left: null, right: "pane:right" },
      moveToGroupAvailable: true,
      copyToSplitAvailable: false,
      moveToSplitAvailable: true,
    });

    expect(items.at(-1)).toMatchObject({
      id: "split-and-move",
      children: expect.arrayContaining([{ id: "move-group-right", label: "Move Right" }]),
    });
  });

  test("maps menu choices to typed layout operations", () => {
    expect(resolveWorkspaceTabSplitAction("split-right")).toEqual({
      mode: "copy",
      direction: "right",
    });
    expect(resolveWorkspaceTabSplitAction("move-up")).toEqual({
      mode: "move",
      direction: "up",
    });
    expect(resolveWorkspaceTabLayoutAction("move-group-down")).toEqual({
      _tag: "MoveToGroup",
      direction: "down",
    });
  });
});
