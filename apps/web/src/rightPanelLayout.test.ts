import { describe, expect, it } from "vite-plus/test";
import {
  defaultWorkspaceLayout,
  moveWorkspaceSurface,
  paneGroups,
  restoreWorkspaceLayout,
  workspacePaneRects,
  workspaceMaximizeState,
} from "./rightPanelLayout";
import { migratePersistedRightPanelState, useRightPanelStore } from "./rightPanelStore";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

describe("mixed workspace layouts", () => {
  it("places conversation left, diff upper right, and browser lower right", () => {
    const layout = moveWorkspaceSurface(
      defaultWorkspaceLayout(["diff", "preview:one"], "diff"),
      "preview:one",
      "tools-pane",
      "bottom",
      "browser-pane",
    );
    const panes = workspacePaneRects(layout).filter((p) => p.node.type === "group");
    expect(panes.map((p) => [p.node.type === "group" && p.node.active, p.rect])).toEqual([
      ["conversation", { x: 0, y: 0, width: 55.00000000000001, height: 100 }],
      ["diff", { x: 55.00000000000001, y: 0, width: 44.99999999999999, height: 50 }],
      ["preview:one", { x: 55.00000000000001, y: 50, width: 44.99999999999999, height: 50 }],
    ]);
    expect(
      restoreWorkspaceLayout(JSON.parse(JSON.stringify(layout)), ["diff", "preview:one"]),
    ).toEqual(layout);
  });
  it("moves a resource exactly once and collapses empty groups", () => {
    const layout = moveWorkspaceSurface(
      defaultWorkspaceLayout(["terminal:1"]),
      "terminal:1",
      "conversation-pane",
    );
    expect(paneGroups(layout)).toHaveLength(1);
    expect(paneGroups(layout)[0]?.tabs).toEqual(["conversation", "terminal:1"]);
    expect(moveWorkspaceSurface(layout, "terminal:missing", "conversation-pane")).toEqual(layout);
  });
  it("recovers malformed persisted layouts without losing valid tabs", () => {
    const restored = restoreWorkspaceLayout(
      {
        type: "split",
        id: "root",
        axis: "horizontal",
        ratio: Infinity,
        first: {
          type: "group",
          id: "a",
          tabs: ["conversation", "file:one", "file:one", "foreign"],
          active: "foreign",
        },
        second: null,
      },
      ["file:one", "terminal:1"],
    );
    const ids = paneGroups(restored).flatMap((g) => g.tabs);
    expect(ids.sort()).toEqual(["conversation", "file:one", "terminal:1"].sort());
    expect(restoreWorkspaceLayout(null, ["diff"], "diff")).toEqual(
      defaultWorkspaceLayout(["diff"], "diff"),
    );
  });
  it("migrates old panel tabs and isolates environments without changing terminal identities", () => {
    const ref = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread"));
    const other = scopeThreadRef(EnvironmentId.make("remote"), ref.threadId);
    useRightPanelStore.setState({ byThreadKey: {} });
    useRightPanelStore.getState().openTerminal(ref, "pty-1");
    const state = useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]!;
    const migrated = migratePersistedRightPanelState({
      byThreadKey: { [scopedThreadKey(ref)]: state },
    });
    expect(migrated.byThreadKey[scopedThreadKey(ref)]?.surfaces).toEqual(state.surfaces);
    const before = structuredClone(state.surfaces);
    const terminalId = state.surfaces.find((surface) => surface.kind === "terminal")!.id;
    useRightPanelStore
      .getState()
      .setWorkspaceLayout(
        ref,
        moveWorkspaceSurface(
          defaultWorkspaceLayout(state.surfaces.map((s) => s.id)),
          terminalId,
          "conversation-pane",
        ),
      );
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]?.surfaces).toEqual(
      before,
    );
    expect(
      paneGroups(
        useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]!.workspaceLayout!,
      )[0]?.tabs,
    ).toContain(terminalId);
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(other)]).toBeUndefined();
  });
});

describe("workspace maximize targets", () => {
  it("ignores deleted or split-node IDs and maximizes the active tool on the first toggle", () => {
    const layout = defaultWorkspaceLayout(["diff"]);
    for (const stale of ["deleted-pane", "workspace-root"]) {
      const state = workspaceMaximizeState(layout, stale, "diff");
      expect(state).toEqual({ maximizedPaneId: null, targetPaneId: "tools-pane" });
      expect(workspaceMaximizeState(layout, state.targetPaneId, "diff").maximizedPaneId).toBe(
        "tools-pane",
      );
    }
  });
  it("falls back to a pane containing tools when no tool surface is active", () => {
    const layout = defaultWorkspaceLayout(["diff"]);
    expect(workspaceMaximizeState(layout, null, null).targetPaneId).toBe("tools-pane");
    const moved = moveWorkspaceSurface(layout, "diff", "conversation-pane");
    expect(workspaceMaximizeState(moved, null, null).targetPaneId).toBe("conversation-pane");
    expect(workspaceMaximizeState(moved, "conversation-pane", "diff").maximizedPaneId).toBe(
      "conversation-pane",
    );
  });
  it("finds active surfaces after nested moves and accepts the conversation itself", () => {
    const layout = moveWorkspaceSurface(
      defaultWorkspaceLayout(["diff", "terminal:1"]),
      "terminal:1",
      "tools-pane",
      "bottom",
      "terminal-pane",
    );
    expect(workspaceMaximizeState(layout, null, "terminal:1").targetPaneId).toBe("terminal-pane");
    expect(workspaceMaximizeState(layout, null, "conversation").targetPaneId).toBe(
      "conversation-pane",
    );
  });
});
