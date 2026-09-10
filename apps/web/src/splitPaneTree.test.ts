import { describe, expect, test } from "vite-plus/test";

import {
  activatePaneTab,
  closeAllPaneTabs,
  closeEmptyPane,
  closePaneTab,
  closePaneTabsToRight,
  closeOtherPaneTabs,
  createPaneTree,
  findAdjacentPanes,
  findPane,
  findTopRightPane,
  getTopPanes,
  getVisiblePaneTreeRoot,
  focusPane,
  getPanes,
  moveTabToPane,
  moveTabToPaneSplit,
  openPaneTab,
  reorderPaneTab,
  resizePaneSplit,
  splitPane,
  splitPaneTab,
  swapPanes,
  toggleMaximizedPane,
  type PaneId,
  type PaneSplitId,
  type PaneTabId,
} from "./splitPaneTree";

const group = (value: string) => `pane:${value}` as PaneId;
const split = (value: string) => `pane-split:${value}` as PaneSplitId;
const tab = (value: string) => `pane-tab:${value}` as PaneTabId;

describe("split pane tree", () => {
  test("opens tabs in the focused group and activates existing tabs", () => {
    const initial = createPaneTree({ paneId: group("one"), tabIds: [tab("thread")] });
    const opened = openPaneTab(initial, tab("file"));
    const activated = activatePaneTab(opened, group("one"), tab("thread"));

    expect(findPane(activated.root, group("one"))).toEqual({
      _tag: "Group",
      id: group("one"),
      tabIds: [tab("thread"), tab("file")],
      activeTabId: tab("thread"),
    });
    expect(activated.focusedPaneId).toBe(group("one"));
  });

  test("ignores attempts to focus a group that is not in the tree", () => {
    const initial = createPaneTree({ paneId: group("one") });
    expect(focusPane(initial, group("missing"))).toBe(initial);
  });

  test("focuses one pane without changing the split layout and restores it", () => {
    const splitWorkspace = splitPaneTab(
      createPaneTree({ paneId: group("left"), tabIds: [tab("thread")] }),
      {
        sourcePaneId: group("left"),
        sourceTabId: tab("thread"),
        targetTabId: tab("file"),
        targetPaneId: group("right"),
        splitId: split("columns"),
        direction: "right",
        mode: "copy",
      },
    );
    const root = splitWorkspace.root;
    const focused = toggleMaximizedPane(splitWorkspace, group("left"));

    expect(focused.root).toBe(root);
    expect(focused.maximizedPaneId).toBe(group("left"));
    expect(getVisiblePaneTreeRoot(focused)).toBe(findPane(focused.root, group("left")));

    const followed = focusPane(focused, group("right"));
    expect(followed.maximizedPaneId).toBe(group("right"));
    expect(toggleMaximizedPane(followed, group("right"))).toEqual({
      ...followed,
      maximizedPaneId: null,
    });
  });

  test.each([
    ["left", "horizontal", group("target")],
    ["right", "horizontal", group("source")],
    ["up", "vertical", group("target")],
    ["down", "vertical", group("source")],
  ] as const)("copies a tab into a %s split", (direction, orientation, firstGroupId) => {
    const initial = createPaneTree({
      paneId: group("source"),
      tabIds: [tab("thread"), tab("file")],
      activeTabId: tab("file"),
    });
    const next = splitPaneTab(initial, {
      sourcePaneId: group("source"),
      sourceTabId: tab("file"),
      targetTabId: tab("file-copy"),
      targetPaneId: group("target"),
      splitId: split("one"),
      direction,
      mode: "copy",
    });

    expect(next.root._tag).toBe("Split");
    if (next.root._tag !== "Split") return;
    expect(next.root.orientation).toBe(orientation);
    expect(next.root.first._tag === "Group" ? next.root.first.id : null).toBe(firstGroupId);
    expect(findPane(next.root, group("source"))?.tabIds).toEqual([tab("thread"), tab("file")]);
    expect(findPane(next.root, group("target"))?.tabIds).toEqual([tab("file-copy")]);
    expect(next.focusedPaneId).toBe(group("target"));
  });

  test("moves a tab into a split while keeping the source group's nearest tab active", () => {
    const initial = createPaneTree({
      paneId: group("source"),
      tabIds: [tab("thread"), tab("file"), tab("diff")],
      activeTabId: tab("file"),
    });
    const next = splitPaneTab(initial, {
      sourcePaneId: group("source"),
      sourceTabId: tab("file"),
      targetTabId: tab("file"),
      targetPaneId: group("target"),
      splitId: split("one"),
      direction: "right",
      mode: "move",
    });

    expect(findPane(next.root, group("source"))).toMatchObject({
      tabIds: [tab("thread"), tab("diff")],
      activeTabId: tab("diff"),
    });
    expect(findPane(next.root, group("target"))).toMatchObject({
      tabIds: [tab("file")],
      activeTabId: tab("file"),
    });
  });

  test("reorders tabs within a group without changing its active tab", () => {
    const initial = createPaneTree({
      paneId: group("one"),
      tabIds: [tab("thread"), tab("file"), tab("diff")],
      activeTabId: tab("thread"),
    });
    const reordered = reorderPaneTab(initial, {
      paneId: group("one"),
      tabId: tab("diff"),
      targetIndex: 1,
    });

    expect(findPane(reordered.root, group("one"))).toMatchObject({
      tabIds: [tab("thread"), tab("diff"), tab("file")],
      activeTabId: tab("thread"),
    });
    expect(
      reorderPaneTab(reordered, {
        paneId: group("one"),
        tabId: tab("diff"),
        targetIndex: 10,
      }),
    ).toBe(reordered);
  });

  test("moves a tab into an existing group and collapses an empty source", () => {
    const initial = splitPaneTab(
      createPaneTree({ paneId: group("left"), tabIds: [tab("thread")] }),
      {
        sourcePaneId: group("left"),
        sourceTabId: tab("thread"),
        targetTabId: tab("file"),
        targetPaneId: group("right"),
        splitId: split("columns"),
        direction: "right",
        mode: "copy",
      },
    );
    const moved = moveTabToPane(initial, {
      sourcePaneId: group("left"),
      targetPaneId: group("right"),
      tabId: tab("thread"),
      targetIndex: 0,
    });

    expect(moved.root).toEqual({
      _tag: "Group",
      id: group("right"),
      tabIds: [tab("thread"), tab("file")],
      activeTabId: tab("thread"),
    });
    expect(moved.focusedPaneId).toBe(group("right"));
  });

  test("moves a tab into a split around another pane", () => {
    const columns = splitPaneTab(
      createPaneTree({
        paneId: group("left"),
        tabIds: [tab("thread"), tab("diff")],
      }),
      {
        sourcePaneId: group("left"),
        sourceTabId: tab("diff"),
        targetTabId: tab("file"),
        targetPaneId: group("right"),
        splitId: split("columns"),
        direction: "right",
        mode: "copy",
      },
    );
    const moved = moveTabToPaneSplit(columns, {
      sourcePaneId: group("left"),
      sourceTabId: tab("diff"),
      targetPaneId: group("right"),
      newPaneId: group("bottom-right"),
      splitId: split("right-rows"),
      direction: "down",
    });

    expect(findPane(moved.root, group("left"))?.tabIds).toEqual([tab("thread")]);
    expect(findPane(moved.root, group("right"))?.tabIds).toEqual([tab("file")]);
    expect(findPane(moved.root, group("bottom-right"))?.tabIds).toEqual([tab("diff")]);
    expect(moved.focusedPaneId).toBe(group("bottom-right"));
  });

  test("swaps complete panes without changing their contents", () => {
    const columns = splitPaneTab(
      createPaneTree({ paneId: group("left"), tabIds: [tab("thread")] }),
      {
        sourcePaneId: group("left"),
        sourceTabId: tab("thread"),
        targetTabId: tab("file"),
        targetPaneId: group("right"),
        splitId: split("columns"),
        direction: "right",
        mode: "copy",
      },
    );
    const swapped = swapPanes(columns, group("left"), group("right"));

    expect(swapped.root._tag).toBe("Split");
    if (swapped.root._tag !== "Split") return;
    expect(swapped.root.first).toEqual(findPane(columns.root, group("right")));
    expect(swapped.root.second).toEqual(findPane(columns.root, group("left")));
    expect(swapped.focusedPaneId).toBe(columns.focusedPaneId);
  });

  test("creates and focuses an empty group beside the current editor", () => {
    const initial = createPaneTree({
      paneId: group("left"),
      tabIds: [tab("thread")],
    });
    const next = splitPane(initial, {
      sourcePaneId: group("left"),
      targetPaneId: group("right"),
      splitId: split("columns"),
      direction: "right",
    });

    expect(next.root._tag).toBe("Split");
    expect(findPane(next.root, group("left"))?.tabIds).toEqual([tab("thread")]);
    expect(findPane(next.root, group("right"))).toMatchObject({
      tabIds: [],
      activeTabId: null,
    });
    expect(next.focusedPaneId).toBe(group("right"));
  });

  test("closes an empty split group but preserves populated and root groups", () => {
    const initial = createPaneTree({
      paneId: group("left"),
      tabIds: [tab("thread")],
    });
    const splitWorkspace = splitPane(initial, {
      sourcePaneId: group("left"),
      targetPaneId: group("right"),
      splitId: split("columns"),
      direction: "right",
    });
    const closed = closeEmptyPane(splitWorkspace, group("right"));

    expect(closed.root).toEqual(initial.root);
    expect(closed.focusedPaneId).toBe(group("left"));
    expect(closeEmptyPane(splitWorkspace, group("left"))).toBe(splitWorkspace);
    expect(closeEmptyPane(createPaneTree({ paneId: group("only") }), group("only"))).toEqual(
      createPaneTree({ paneId: group("only") }),
    );
  });

  test("does not move the only tab out of a group", () => {
    const initial = createPaneTree({ paneId: group("source"), tabIds: [tab("thread")] });
    expect(
      splitPaneTab(initial, {
        sourcePaneId: group("source"),
        sourceTabId: tab("thread"),
        targetTabId: tab("thread"),
        targetPaneId: group("target"),
        splitId: split("one"),
        direction: "right",
        mode: "move",
      }),
    ).toBe(initial);
  });

  test("collapses an empty group after its last tab closes", () => {
    const initial = splitPaneTab(
      createPaneTree({ paneId: group("source"), tabIds: [tab("thread")] }),
      {
        sourcePaneId: group("source"),
        sourceTabId: tab("thread"),
        targetTabId: tab("thread-copy"),
        targetPaneId: group("target"),
        splitId: split("one"),
        direction: "right",
        mode: "copy",
      },
    );
    const next = closePaneTab(initial, group("target"), tab("thread-copy"));

    expect(next.root).toEqual(findPane(next.root, group("source")));
    expect(next.focusedPaneId).toBe(group("source"));
  });

  test("keeps one empty root group after its final tab closes", () => {
    const initial = createPaneTree({ paneId: group("one"), tabIds: [tab("thread")] });
    expect(closePaneTab(initial, group("one"), tab("thread"))).toEqual(
      createPaneTree({ paneId: group("one") }),
    );
  });

  test("supports group-scoped close others and close to right", () => {
    const initial = createPaneTree({
      paneId: group("one"),
      tabIds: [tab("thread"), tab("file"), tab("diff")],
      activeTabId: tab("diff"),
    });
    const closedRight = closePaneTabsToRight(initial, group("one"), tab("file"));
    expect(findPane(closedRight.root, group("one"))).toMatchObject({
      tabIds: [tab("thread"), tab("file")],
      activeTabId: tab("thread"),
    });
    const closedOthers = closeOtherPaneTabs(initial, group("one"), tab("file"));
    expect(findPane(closedOthers.root, group("one"))).toMatchObject({
      tabIds: [tab("file")],
      activeTabId: tab("file"),
    });
  });

  test("close all collapses a split group and clears the only root group", () => {
    const splitWorkspace = splitPaneTab(
      createPaneTree({ paneId: group("source"), tabIds: [tab("thread")] }),
      {
        sourcePaneId: group("source"),
        sourceTabId: tab("thread"),
        targetTabId: tab("copy"),
        targetPaneId: group("target"),
        splitId: split("one"),
        direction: "right",
        mode: "copy",
      },
    );
    expect(getPanes(closeAllPaneTabs(splitWorkspace, group("target")).root)).toHaveLength(1);
    expect(
      findPane(
        closeAllPaneTabs(
          createPaneTree({ paneId: group("only"), tabIds: [tab("thread")] }),
          group("only"),
        ).root,
        group("only"),
      ),
    ).toMatchObject({ tabIds: [], activeTabId: null });
  });

  test("resizes nested splits and clamps unsafe ratios", () => {
    const splitWorkspace = splitPaneTab(
      createPaneTree({ paneId: group("source"), tabIds: [tab("thread")] }),
      {
        sourcePaneId: group("source"),
        sourceTabId: tab("thread"),
        targetTabId: tab("copy"),
        targetPaneId: group("target"),
        splitId: split("one"),
        direction: "down",
        mode: "copy",
      },
    );
    const next = resizePaneSplit(splitWorkspace, split("one"), 2);

    expect(next.root._tag === "Split" ? next.root.ratio : null).toBe(0.9);
    expect(resizePaneSplit(next, split("one"), Number.NaN)).toBe(next);
  });

  test("finds the group occupying the tree's top-right corner", () => {
    const columns = splitPaneTab(
      createPaneTree({ paneId: group("left"), tabIds: [tab("thread")] }),
      {
        sourcePaneId: group("left"),
        sourceTabId: tab("thread"),
        targetTabId: tab("right"),
        targetPaneId: group("right"),
        splitId: split("columns"),
        direction: "right",
        mode: "copy",
      },
    );
    const nested = splitPaneTab(columns, {
      sourcePaneId: group("right"),
      sourceTabId: tab("right"),
      targetTabId: tab("bottom-right"),
      targetPaneId: group("bottom-right"),
      splitId: split("right-rows"),
      direction: "down",
      mode: "copy",
    });

    expect(findTopRightPane(nested.root).id).toBe(group("right"));
    expect(getTopPanes(nested.root).map((editorGroup) => editorGroup.id)).toEqual([
      group("left"),
      group("right"),
    ]);
  });

  test("finds directional neighbors in nested editor splits", () => {
    const columns = splitPaneTab(
      createPaneTree({ paneId: group("top-left"), tabIds: [tab("thread")] }),
      {
        sourcePaneId: group("top-left"),
        sourceTabId: tab("thread"),
        targetTabId: tab("right"),
        targetPaneId: group("right"),
        splitId: split("columns"),
        direction: "right",
        mode: "copy",
      },
    );
    const nested = splitPaneTab(columns, {
      sourcePaneId: group("top-left"),
      sourceTabId: tab("thread"),
      targetTabId: tab("bottom-left"),
      targetPaneId: group("bottom-left"),
      splitId: split("left-rows"),
      direction: "down",
      mode: "copy",
    });

    expect(findAdjacentPanes(nested, group("top-left"))).toEqual({
      up: null,
      down: group("bottom-left"),
      left: null,
      right: group("right"),
    });
    expect(findAdjacentPanes(nested, group("right"))).toEqual({
      up: null,
      down: null,
      left: group("top-left"),
      right: null,
    });
  });
});
