import { describe, expect, test } from "vite-plus/test";

import { findPane, type PaneTabId } from "./splitPaneTree";
import {
  createThreadWorkspaceTabFields,
  findThreadWorkspaceTabGroup,
  findSurfaceTabs,
  parsePersistedThreadWorkspaceTabs,
  transitionThreadWorkspaceTabs,
} from "./threadWorkspaceTabs";

function activeTabId(state: ReturnType<typeof createThreadWorkspaceTabFields>): PaneTabId | null {
  const group =
    state.paneTree.root._tag === "Group"
      ? state.paneTree.root
      : state.paneTree.root.second._tag === "Group"
        ? state.paneTree.root.second
        : null;
  return group?.activeTabId ?? null;
}

describe("thread workspace tabs", () => {
  test("starts with the always-on thread tab and opens surfaces in the focused group", () => {
    const state = createThreadWorkspaceTabFields(["files", "diff"]);
    const group = state.paneTree.root;

    expect(group._tag).toBe("Group");
    if (group._tag !== "Group") return;
    expect(group.tabIds.map((tabId) => state.tabsById[tabId]?._tag)).toEqual([
      "Thread",
      "Surface",
      "Surface",
    ]);
    expect(state.tabsById[group.activeTabId ?? ""]).toMatchObject({
      _tag: "Thread",
    });
  });

  test("activates an existing surface and returns to the thread tab", () => {
    const initial = createThreadWorkspaceTabFields(["files", "diff"]);
    const surfaceActive = transitionThreadWorkspaceTabs(initial, {
      _tag: "ActivateSurfaceTab",
      surfaceId: "files",
    });
    expect(surfaceActive.tabsById[activeTabId(surfaceActive) ?? ""]).toMatchObject({
      _tag: "Surface",
      surfaceId: "files",
    });
    const threadActive = transitionThreadWorkspaceTabs(surfaceActive, { _tag: "ActivateThread" });
    expect(threadActive.tabsById[activeTabId(threadActive) ?? ""]).toMatchObject({
      _tag: "Thread",
    });
  });

  test("opens the same surface once in each focused group", () => {
    const initial = createThreadWorkspaceTabFields(["files"]);
    const filesTab = findSurfaceTabs(initial, "files")[0]!;
    const rootGroupId = findThreadWorkspaceTabGroup(initial, filesTab.id)!;
    const split = transitionThreadWorkspaceTabs(initial, {
      _tag: "SplitTab",
      paneId: rootGroupId,
      tabId: filesTab.id,
      direction: "right",
      mode: "move",
    });
    const threadFocused = transitionThreadWorkspaceTabs(split, { _tag: "ActivateThread" });
    const opened = transitionThreadWorkspaceTabs(threadFocused, {
      _tag: "OpenSurfaceTab",
      surfaceId: "files",
    });
    const reopened = transitionThreadWorkspaceTabs(opened, {
      _tag: "OpenSurfaceTab",
      surfaceId: "files",
    });
    const filesTabs = findSurfaceTabs(opened, "files");

    expect(filesTabs).toHaveLength(2);
    expect(new Set(filesTabs.map((tab) => findThreadWorkspaceTabGroup(opened, tab.id))).size).toBe(
      2,
    );
    expect(findSurfaceTabs(reopened, "files")).toHaveLength(2);
    expect(reopened.nextId).toBe(opened.nextId);
  });

  test("copies a surface into a new group but keeps the thread singleton", () => {
    const initial = createThreadWorkspaceTabFields(["file:one.ts"]);
    const surfaceTab = findSurfaceTabs(initial, "file:one.ts")[0]!;
    const paneId = findThreadWorkspaceTabGroup(initial, surfaceTab.id)!;
    const copied = transitionThreadWorkspaceTabs(initial, {
      _tag: "SplitTab",
      paneId,
      tabId: surfaceTab.id,
      direction: "right",
      mode: "copy",
    });

    expect(findSurfaceTabs(copied, "file:one.ts")).toHaveLength(2);
    const threadTab = Object.values(initial.tabsById).find((tab) => tab._tag === "Thread")!;
    expect(
      transitionThreadWorkspaceTabs(initial, {
        _tag: "SplitTab",
        paneId,
        tabId: threadTab.id,
        direction: "right",
        mode: "copy",
      }),
    ).toBe(initial);
  });

  test("opens an empty split for choosing a new surface", () => {
    const initial = createThreadWorkspaceTabFields();
    const next = transitionThreadWorkspaceTabs(initial, {
      _tag: "SplitPane",
      paneId: initial.paneTree.focusedPaneId,
      direction: "right",
    });
    const focused = findPane(next.paneTree.root, next.paneTree.focusedPaneId);

    expect(next.paneTree.root._tag).toBe("Split");
    expect(focused).toMatchObject({ tabIds: [], activeTabId: null });
    expect(next.tabsById).toEqual(initial.tabsById);
    expect(next.nextId).toBe(initial.nextId + 2);
  });

  test("closes an empty pane without requiring a temporary surface", () => {
    const initial = createThreadWorkspaceTabFields();
    const split = transitionThreadWorkspaceTabs(initial, {
      _tag: "SplitPane",
      paneId: initial.paneTree.focusedPaneId,
      direction: "right",
    });
    const closed = transitionThreadWorkspaceTabs(split, {
      _tag: "CloseEmptyPane",
      paneId: split.paneTree.focusedPaneId,
    });

    expect(closed.paneTree.root).toEqual(initial.paneTree.root);
    expect(closed.paneTree.focusedPaneId).toBe(initial.paneTree.focusedPaneId);
    expect(closed.tabsById).toEqual(initial.tabsById);
  });

  test("moves a surface and prevents moving the only tab from a group", () => {
    const initial = createThreadWorkspaceTabFields(["files", "diff"]);
    const fileTab = findSurfaceTabs(initial, "files")[0]!;
    const rootGroupId = findThreadWorkspaceTabGroup(initial, fileTab.id)!;
    const moved = transitionThreadWorkspaceTabs(initial, {
      _tag: "SplitTab",
      paneId: rootGroupId,
      tabId: fileTab.id,
      direction: "down",
      mode: "move",
    });
    const movedGroupId = findThreadWorkspaceTabGroup(moved, fileTab.id)!;
    const diffTab = findSurfaceTabs(moved, "diff")[0]!;
    const diffMoved = transitionThreadWorkspaceTabs(moved, {
      _tag: "SplitTab",
      paneId: movedGroupId,
      tabId: fileTab.id,
      direction: "right",
      mode: "move",
    });

    expect(diffMoved).toBe(moved);
    expect(findThreadWorkspaceTabGroup(moved, diffTab.id)).toBe(rootGroupId);
  });

  test("reorders tabs within one group", () => {
    const initial = createThreadWorkspaceTabFields(["files", "diff"]);
    const diffTab = findSurfaceTabs(initial, "diff")[0]!;
    const reordered = transitionThreadWorkspaceTabs(initial, {
      _tag: "ReorderTab",
      paneId: initial.paneTree.focusedPaneId,
      tabId: diffTab.id,
      targetIndex: 1,
    });
    const root = reordered.paneTree.root;

    expect(root._tag).toBe("Group");
    if (root._tag !== "Group") return;
    expect(
      root.tabIds.map((tabId) => {
        const tab = reordered.tabsById[tabId];
        return tab?._tag === "Thread" ? "thread" : tab?.surfaceId;
      }),
    ).toEqual(["thread", "diff", "files"]);
  });

  test("keeps the thread tab pinned before reordered surface tabs", () => {
    const initial = createThreadWorkspaceTabFields(["files", "diff"]);
    const filesTab = findSurfaceTabs(initial, "files")[0]!;
    const threadTab = Object.values(initial.tabsById).find((tab) => tab._tag === "Thread")!;
    const surfaceReordered = transitionThreadWorkspaceTabs(initial, {
      _tag: "ReorderTab",
      paneId: initial.paneTree.focusedPaneId,
      tabId: filesTab.id,
      targetIndex: 0,
    });
    const threadReordered = transitionThreadWorkspaceTabs(surfaceReordered, {
      _tag: "ReorderTab",
      paneId: surfaceReordered.paneTree.focusedPaneId,
      tabId: threadTab.id,
      targetIndex: 2,
    });

    expect(
      surfaceReordered.paneTree.root._tag === "Group" ? surfaceReordered.paneTree.root.tabIds : [],
    ).toEqual([threadTab.id, filesTab.id, findSurfaceTabs(initial, "diff")[0]!.id]);
    expect(threadReordered).toBe(surfaceReordered);
  });

  test("moves tabs into existing groups without creating another split", () => {
    const initial = createThreadWorkspaceTabFields(["files", "diff"]);
    const filesTab = findSurfaceTabs(initial, "files")[0]!;
    const sourcePaneId = findThreadWorkspaceTabGroup(initial, filesTab.id)!;
    const split = transitionThreadWorkspaceTabs(initial, {
      _tag: "SplitTab",
      paneId: sourcePaneId,
      tabId: filesTab.id,
      direction: "right",
      mode: "move",
    });
    const targetPaneId = findThreadWorkspaceTabGroup(split, filesTab.id)!;
    const diffTab = findSurfaceTabs(split, "diff")[0]!;
    const moved = transitionThreadWorkspaceTabs(split, {
      _tag: "MoveTabToPane",
      sourcePaneId,
      targetPaneId,
      tabId: diffTab.id,
    });
    const targetGroup =
      moved.paneTree.root._tag === "Split" && moved.paneTree.root.second._tag === "Group"
        ? moved.paneTree.root.second
        : null;

    expect(targetGroup?.tabIds.map((tabId) => moved.tabsById[tabId])).toEqual([
      expect.objectContaining({ _tag: "Surface", surfaceId: "files" }),
      expect.objectContaining({ _tag: "Surface", surfaceId: "diff" }),
    ]);
    expect(targetGroup?.activeTabId).toBe(diffTab.id);
  });

  test("moves a tab to a target edge and swaps complete groups", () => {
    const initial = createThreadWorkspaceTabFields(["files", "diff"]);
    const filesTab = findSurfaceTabs(initial, "files")[0]!;
    const sourcePaneId = findThreadWorkspaceTabGroup(initial, filesTab.id)!;
    const columns = transitionThreadWorkspaceTabs(initial, {
      _tag: "SplitTab",
      paneId: sourcePaneId,
      tabId: filesTab.id,
      direction: "right",
      mode: "move",
    });
    const rightGroupId = findThreadWorkspaceTabGroup(columns, filesTab.id)!;
    const diffTab = findSurfaceTabs(columns, "diff")[0]!;
    const splitAtTarget = transitionThreadWorkspaceTabs(columns, {
      _tag: "MoveTabToSplit",
      sourcePaneId,
      targetPaneId: rightGroupId,
      tabId: diffTab.id,
      direction: "down",
    });

    expect(findThreadWorkspaceTabGroup(splitAtTarget, diffTab.id)).not.toBe(sourcePaneId);
    expect(splitAtTarget.paneTree.focusedPaneId).toBe(
      findThreadWorkspaceTabGroup(splitAtTarget, diffTab.id),
    );

    const swapped = transitionThreadWorkspaceTabs(columns, {
      _tag: "SwapPanes",
      sourcePaneId,
      targetPaneId: rightGroupId,
    });
    expect(swapped.paneTree.root._tag).toBe("Split");
    if (swapped.paneTree.root._tag !== "Split") return;
    expect(
      swapped.paneTree.root.first._tag === "Group" ? swapped.paneTree.root.first.id : null,
    ).toBe(rightGroupId);
  });

  test("pins the thread first when moving it into an existing group", () => {
    const initial = createThreadWorkspaceTabFields(["files", "diff"]);
    const filesTab = findSurfaceTabs(initial, "files")[0]!;
    const sourcePaneId = findThreadWorkspaceTabGroup(initial, filesTab.id)!;
    const split = transitionThreadWorkspaceTabs(initial, {
      _tag: "SplitTab",
      paneId: sourcePaneId,
      tabId: filesTab.id,
      direction: "right",
      mode: "move",
    });
    const targetPaneId = findThreadWorkspaceTabGroup(split, filesTab.id)!;
    const threadTab = Object.values(split.tabsById).find((tab) => tab._tag === "Thread")!;
    const moved = transitionThreadWorkspaceTabs(split, {
      _tag: "MoveTabToPane",
      sourcePaneId,
      targetPaneId,
      tabId: threadTab.id,
    });
    const targetGroup = findPane(moved.paneTree.root, targetPaneId);

    expect(targetGroup?.tabIds).toEqual([threadTab.id, filesTab.id]);
  });

  test("deduplicates copied surfaces when moving into an existing group", () => {
    const initial = createThreadWorkspaceTabFields(["files", "diff"]);
    const filesTab = findSurfaceTabs(initial, "files")[0]!;
    const rootGroupId = findThreadWorkspaceTabGroup(initial, filesTab.id)!;
    const split = transitionThreadWorkspaceTabs(initial, {
      _tag: "SplitTab",
      paneId: rootGroupId,
      tabId: filesTab.id,
      direction: "right",
      mode: "copy",
    });
    const copiedFilesTab = findSurfaceTabs(split, "files").find((tab) => tab.id !== filesTab.id)!;
    const copiedGroupId = findThreadWorkspaceTabGroup(split, copiedFilesTab.id)!;
    const moved = transitionThreadWorkspaceTabs(split, {
      _tag: "MoveTabToPane",
      sourcePaneId: copiedGroupId,
      targetPaneId: rootGroupId,
      tabId: copiedFilesTab.id,
    });

    expect(findSurfaceTabs(moved, "files")).toHaveLength(1);
    expect(moved.paneTree.root._tag).toBe("Group");
  });

  test("closes only one copied view until the last resource tab closes", () => {
    const initial = createThreadWorkspaceTabFields(["files"]);
    const fileTab = findSurfaceTabs(initial, "files")[0]!;
    const paneId = findThreadWorkspaceTabGroup(initial, fileTab.id)!;
    const copied = transitionThreadWorkspaceTabs(initial, {
      _tag: "SplitTab",
      paneId,
      tabId: fileTab.id,
      direction: "right",
      mode: "copy",
    });
    const copiedTab = findSurfaceTabs(copied, "files").find((tab) => tab.id !== fileTab.id)!;
    const copiedGroupId = findThreadWorkspaceTabGroup(copied, copiedTab.id)!;
    const oneClosed = transitionThreadWorkspaceTabs(copied, {
      _tag: "CloseSurfaceTab",
      paneId: copiedGroupId,
      tabId: copiedTab.id,
    });
    const allClosed = transitionThreadWorkspaceTabs(oneClosed, {
      _tag: "CloseSurfaceTab",
      paneId,
      tabId: fileTab.id,
    });

    expect(findSurfaceTabs(oneClosed, "files")).toHaveLength(1);
    expect(findSurfaceTabs(allClosed, "files")).toHaveLength(0);
    expect(Object.values(allClosed.tabsById)).toEqual([
      expect.objectContaining({ _tag: "Thread" }),
    ]);
  });

  test("keeps the thread tab when closing other, right-side, or all surface tabs", () => {
    const initial = createThreadWorkspaceTabFields(["files", "diff", "agents"]);
    const paneId = initial.paneTree.focusedPaneId;
    const diffTab = findSurfaceTabs(initial, "diff")[0]!;

    expect(
      Object.values(
        transitionThreadWorkspaceTabs(initial, {
          _tag: "CloseOtherSurfaceTabs",
          paneId,
          tabId: diffTab.id,
        }).tabsById,
      ).map((tab) => (tab._tag === "Thread" ? "thread" : tab.surfaceId)),
    ).toEqual(["thread", "diff"]);
    expect(
      Object.values(
        transitionThreadWorkspaceTabs(initial, {
          _tag: "CloseSurfaceTabsToRight",
          paneId,
          tabId: diffTab.id,
        }).tabsById,
      ).map((tab) => (tab._tag === "Thread" ? "thread" : tab.surfaceId)),
    ).toEqual(["thread", "files", "diff"]);
    expect(
      Object.values(
        transitionThreadWorkspaceTabs(initial, {
          _tag: "CloseAllSurfaceTabs",
          paneId,
        }).tabsById,
      ),
    ).toEqual([expect.objectContaining({ _tag: "Thread" })]);
  });

  test("reconciles resources without disturbing existing split placement", () => {
    const initial = createThreadWorkspaceTabFields(["files"]);
    const fileTab = findSurfaceTabs(initial, "files")[0]!;
    const paneId = findThreadWorkspaceTabGroup(initial, fileTab.id)!;
    const split = transitionThreadWorkspaceTabs(initial, {
      _tag: "SplitTab",
      paneId,
      tabId: fileTab.id,
      direction: "right",
      mode: "copy",
    });
    const reconciled = transitionThreadWorkspaceTabs(split, {
      _tag: "ReconcileSurfaceTabs",
      surfaceIds: ["files", "diff"],
    });
    const removed = transitionThreadWorkspaceTabs(reconciled, {
      _tag: "ReconcileSurfaceTabs",
      surfaceIds: ["diff"],
    });

    expect(findSurfaceTabs(reconciled, "files")).toHaveLength(2);
    expect(findSurfaceTabs(reconciled, "diff")).toHaveLength(1);
    expect(findSurfaceTabs(removed, "files")).toHaveLength(0);
    expect(findSurfaceTabs(removed, "diff")).toHaveLength(1);
  });

  test("applies explicit surface replacements without moving their groups", () => {
    const initial = createThreadWorkspaceTabFields(["files"]);
    const filesTab = findSurfaceTabs(initial, "files")[0]!;
    const paneId = findThreadWorkspaceTabGroup(initial, filesTab.id)!;
    const split = transitionThreadWorkspaceTabs(initial, {
      _tag: "SplitTab",
      paneId,
      tabId: filesTab.id,
      direction: "right",
      mode: "copy",
    });
    const groupsBefore = findSurfaceTabs(split, "files").map((tab) =>
      findThreadWorkspaceTabGroup(split, tab.id),
    );
    const replaced = transitionThreadWorkspaceTabs(split, {
      _tag: "ReplaceSurfaceTabs",
      previousSurfaceId: "files",
      nextSurfaceId: "file:src/app.ts",
    });
    const reconciled = transitionThreadWorkspaceTabs(replaced, {
      _tag: "ReconcileSurfaceTabs",
      surfaceIds: ["file:src/app.ts"],
    });

    expect(findSurfaceTabs(reconciled, "files")).toHaveLength(0);
    expect(findSurfaceTabs(reconciled, "file:src/app.ts").map((tab) => tab.id)).toEqual(
      findSurfaceTabs(split, "files").map((tab) => tab.id),
    );
    expect(
      findSurfaceTabs(reconciled, "file:src/app.ts").map((tab) =>
        findThreadWorkspaceTabGroup(reconciled, tab.id),
      ),
    ).toEqual(groupsBefore);
  });

  test("does not infer replacement identity from surface id prefixes", () => {
    const initial = createThreadWorkspaceTabFields(["files"]);
    const filesTab = findSurfaceTabs(initial, "files")[0]!;
    const reconciled = transitionThreadWorkspaceTabs(initial, {
      _tag: "ReconcileSurfaceTabs",
      surfaceIds: ["file:src/app.ts"],
    });

    expect(findSurfaceTabs(reconciled, "file:src/app.ts")[0]?.id).not.toBe(filesTab.id);
  });

  test("parses valid persisted trees and clamps their split ratios", () => {
    const initial = createThreadWorkspaceTabFields(["files"]);
    const filesTab = findSurfaceTabs(initial, "files")[0]!;
    const paneId = findThreadWorkspaceTabGroup(initial, filesTab.id)!;
    const split = transitionThreadWorkspaceTabs(initial, {
      _tag: "SplitTab",
      paneId,
      tabId: filesTab.id,
      direction: "right",
      mode: "copy",
    });
    if (split.paneTree.root._tag !== "Split") throw new Error("Expected split workspace");
    const parsed = parsePersistedThreadWorkspaceTabs({
      byThreadKey: {
        thread: {
          ...split,
          nextId: 1,
          paneTree: {
            ...split.paneTree,
            maximizedPaneId: paneId,
            root: { ...split.paneTree.root, ratio: 5 },
          },
        },
      },
    }).byThreadKey.thread;

    expect(parsed?.paneTree.root._tag).toBe("Split");
    expect(parsed?.paneTree.root._tag === "Split" ? parsed.paneTree.root.ratio : null).toBe(0.9);
    expect(parsed?.tabsById).toEqual(split.tabsById);
    expect(parsed?.nextId).toBeGreaterThan(1);
    expect(parsed?.paneTree.maximizedPaneId).toBe(paneId);
  });

  test("drops malformed persisted threads without discarding valid siblings", () => {
    const valid = createThreadWorkspaceTabFields(["files"]);
    const malformed = {
      ...valid,
      paneTree: {
        ...valid.paneTree,
        root: {
          ...valid.paneTree.root,
          activeTabId: "pane-tab:missing",
        },
      },
    };

    expect(
      Object.keys(
        parsePersistedThreadWorkspaceTabs({
          byThreadKey: { valid, malformed },
        }).byThreadKey,
      ),
    ).toEqual(["valid"]);
    expect(parsePersistedThreadWorkspaceTabs(null)).toEqual({ byThreadKey: {} });
  });

  test("loads layouts saved before Focus View existed", () => {
    const valid = createThreadWorkspaceTabFields(["files"]);
    const parsed = parsePersistedThreadWorkspaceTabs({
      byThreadKey: {
        legacy: {
          ...valid,
          paneTree: {
            root: valid.paneTree.root,
            focusedPaneId: valid.paneTree.focusedPaneId,
          },
        },
      },
    }).byThreadKey.legacy;

    expect(parsed?.paneTree.maximizedPaneId).toBeNull();
  });
});
