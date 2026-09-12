import { describe, expect, test } from "vite-plus/test";

import {
  buildWorkspaceTabContextMenuItems,
  canCopyWorkspaceTabToSplit,
  resolveWorkspaceTabLayoutAction,
  resolveWorkspaceTabSplitAction,
} from "./RightPanelTabs.logic";
import { canDropPaneTab } from "./SplitPaneGrid.logic";
import { createPaneTree, splitPane } from "~/splitPaneTree";

const NO_ADJACENT_PANES = { up: null, down: null, left: null, right: null } as const;

describe("workspace tab context menus", () => {
  test("browser menus allow moving without offering a second presentation of the same resource", () => {
    const items = buildWorkspaceTabContextMenuItems({
      target: {
        _tag: "Surface",
        surface: { id: "browser:tab-1", kind: "preview", resourceId: "tab-1" },
      },
      surfaceCount: 2,
      surfaceIndex: 0,
      adjacentGroups: NO_ADJACENT_PANES,
      moveToGroupAvailable: true,
      copyToSplitAvailable: true,
      moveToSplitAvailable: true,
    });
    expect(items).toContainEqual({ id: "split-right", label: "Split Right", disabled: true });
    expect(items).toContainEqual({ id: "split-down", label: "Split Down", disabled: true });
    expect(items.at(-1)).toMatchObject({
      id: "split-and-move",
      children: expect.arrayContaining([
        { id: "move-right", label: "Split Right", disabled: false },
      ]),
    });
  });

  test("a sole browser tab can move to another pane but cannot copy itself through an edge drop", () => {
    const tree = splitPane(
      createPaneTree({ paneId: "pane:source", tabIds: ["pane-tab:browser"] }),
      {
        sourcePaneId: "pane:source",
        targetPaneId: "pane:target",
        splitId: "pane-split:1",
        direction: "right",
      },
    );
    const draggedTab = { sourcePaneId: "pane:source", sourceTabId: "pane-tab:browser" } as const;
    const canCopyFromSolePane = canCopyWorkspaceTabToSplit({
      _tag: "Surface",
      surface: { id: "browser:tab-1", kind: "preview", resourceId: "tab-1" },
    });
    expect(
      canDropPaneTab({
        tree,
        draggedTab,
        targetPaneId: "pane:source",
        zone: "right",
        canCopyFromSolePane,
      }),
    ).toBe(false);
    expect(
      canDropPaneTab({
        tree,
        draggedTab,
        targetPaneId: "pane:target",
        zone: "right",
        canCopyFromSolePane,
      }),
    ).toBe(true);
  });

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
