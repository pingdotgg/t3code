import { describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("../motion/stripCamera"), () => ({ settleStripCamera: () => {} }));

import { overviewRowShift, selectOverviewStage, selectOverviewStartPaneIds } from "./Overview";
import { countedLayoutWorkspaces } from "./layoutCommands";
import {
  focusLayoutWorkspaceStep,
  type LayoutState,
  type LayoutTabContent,
  type LayoutWorkspace,
  isBlankLayoutWorkspace,
} from "./layoutModel";

const viewport = { width: 1000, whenNoRoom: "shrink-then-scroll" } as const;
const settings: LayoutTabContent = { kind: "settings" };

function workspace(id: string, withPane: boolean): LayoutWorkspace {
  return {
    id,
    name: null,
    focusedPaneId: withPane ? `pane-${id}` : null,
    cameraWidth: null,
    columns: withPane
      ? [
          {
            id: `column-${id}`,
            width: 1,
            panes: [
              {
                id: `pane-${id}`,
                size: 1,
                activeTabId: `tab-${id}`,
                tabs: [{ id: `tab-${id}`, content: settings }],
              },
            ],
          },
        ]
      : [],
  };
}

function stack(focusedWorkspaceId: string): LayoutState {
  return {
    workspaces: [workspace("a", true), workspace("b", true), workspace("trailing", false)],
    focusedWorkspaceId,
  };
}

const stageOf = (layout: LayoutState) => selectOverviewStage(layout, viewport, viewport.width);
const hintedIds = (layout: LayoutState) =>
  countedLayoutWorkspaces(layout).map((workspace) => workspace.id);

describe("overviewRowShift", () => {
  it("counts the rows the stack moved when a new workspace opens above it, and back", () => {
    const onFirst = stack("a");
    const onNewAbove = focusLayoutWorkspaceStep(onFirst, -1);
    const backOnFirst = focusLayoutWorkspaceStep(onNewAbove, 1);
    expect(isBlankLayoutWorkspace(stageOf(onNewAbove).focusedRow.workspace)).toBe(true);
    expect(overviewRowShift(stageOf(onFirst).rows, stageOf(onNewAbove).rows)).toBe(1);
    expect(overviewRowShift(stageOf(onNewAbove).rows, stageOf(backOnFirst).rows)).toBe(-1);
    const newAbove = onNewAbove.focusedWorkspaceId;
    expect(hintedIds(onNewAbove)).toEqual([newAbove, "a", "b"]);
    expect(hintedIds(backOnFirst)).toEqual(["a", "b"]);
  });

  it("leaves the stack in place when the empty workspace below it shows or hides", () => {
    const onLast = stack("b");
    const onNewBelow = focusLayoutWorkspaceStep(onLast, 1);
    expect(stageOf(onNewBelow).focusedRow.workspace.id).toBe("trailing");
    expect(overviewRowShift(stageOf(onLast).rows, stageOf(onNewBelow).rows)).toBe(0);
    expect(overviewRowShift(stageOf(onNewBelow).rows, stageOf(onLast).rows)).toBe(0);
    expect(hintedIds(onNewBelow)).toEqual(["a", "b", "trailing"]);
    expect(hintedIds(onLast)).toEqual(["a", "b"]);
  });
});

describe("selectOverviewStartPaneIds", () => {
  function columns(id: string, paneIds: string[][], focusedPaneId: string): LayoutWorkspace {
    return {
      id,
      name: null,
      focusedPaneId,
      cameraWidth: null,
      columns: paneIds.map((panes, index) => ({
        id: `column-${id}-${index}`,
        width: 1,
        panes: panes.map((paneId) => ({
          id: paneId,
          size: 1 / panes.length,
          activeTabId: `tab-${paneId}`,
          tabs: [{ id: `tab-${paneId}`, content: settings }],
        })),
      })),
    };
  }

  it("marks the pane each workspace lands with at the window's top-left corner", () => {
    const layout: LayoutState = {
      workspaces: [
        columns("a", [["a-top", "a-below"], ["a-right"]], "a-below"),
        columns("b", [["b-left"], ["b-right"]], "b-right"),
      ],
      focusedWorkspaceId: "a",
    };
    expect([...selectOverviewStartPaneIds(stageOf(layout), viewport.width)].toSorted()).toEqual([
      "a-top",
      "b-right",
    ]);
  });
});
