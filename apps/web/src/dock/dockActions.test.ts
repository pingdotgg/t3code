import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { applyDockDrop, openFileFromExplorer, resetDockLayout } from "./dockActions";
import { collectDockGroupIds } from "./dockLayout";
import { resolveSurfaceGroupId, useDockLayoutStore } from "./dockLayoutStore";

const ref = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread"));
const dock = () => useDockLayoutStore.getState();
const surfaces = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces;
const groupOf = (id: string) =>
  resolveSurfaceGroupId(
    surfaces().find((s) => s.id === id)!,
    dock(),
  );

beforeEach(() => {
  resetDockLayout();
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("threadsSide", () => {
  it("is saved with the layout, where a desktop app on older contracts cannot drop it", () => {
    useDockLayoutStore.setState({ threadsSide: "right" });
    const { partialize, merge } = useDockLayoutStore.persist.getOptions();
    const saved = partialize!(dock());
    useDockLayoutStore.setState({ threadsSide: "left" });
    expect(saved).toMatchObject({ threadsSide: "right" });
    expect(merge!(saved, dock())).toMatchObject({ threadsSide: "right" });
  });

  it("stays put when the panel layout resets", () => {
    useDockLayoutStore.setState({ threadsSide: "right" });
    resetDockLayout();
    expect(dock().threadsSide).toBe("right");
    useDockLayoutStore.setState({ threadsSide: "left" });
  });
});

describe("applyDockDrop", () => {
  it("splits a tab into a new group and sends that kind's next tab after it", () => {
    useRightPanelStore.getState().openTerminal(ref, "a");
    applyDockDrop(ref, "terminal:a", { type: "split", nodeId: "chat", edge: "bottom", size: 200 });
    const group = groupOf("terminal:a");
    expect(group).not.toBe("panel");

    useRightPanelStore.getState().openTerminal(ref, "b");

    expect(groupOf("terminal:b")).toBe(group);
  });

  it("moves the top of a stack to sit beside the two panels left in it", () => {
    const panels = useRightPanelStore.getState();
    panels.openTerminal(ref, "a");
    panels.open(ref, "files");
    panels.open(ref, "diff");
    const dropBelow = (surfaceId: string, nodeId: string) =>
      applyDockDrop(ref, surfaceId, { type: "split", nodeId, edge: "bottom", size: 200 });
    dropBelow("files", "panel");
    dropBelow("diff", groupOf("files"));
    const stackId = "split-" + groupOf("files");
    expect(collectDockGroupIds(dock().root).slice(-3)).toEqual([
      "panel",
      groupOf("files"),
      groupOf("diff"),
    ]);

    applyDockDrop(ref, "terminal:a", { type: "split", nodeId: stackId, edge: "right", size: 200 });

    const root = dock().root;
    expect(root.kind === "split" && root.children.map((child) => child.kind)).toEqual([
      "group",
      "split",
      "group",
    ]);
    expect(root.kind === "split" && root.children.at(-1)?.id).toBe(groupOf("terminal:a"));
    expect(collectDockGroupIds(dock().root)).toContain("panel");
  });

  it("keeps a group another thread's tab was left in", () => {
    const other = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("other"));
    useRightPanelStore.getState().openTerminal(other, "a");
    applyDockDrop(other, "terminal:a", {
      type: "split",
      nodeId: "chat",
      edge: "bottom",
      size: 200,
    });
    const group = dock().kindGroups.terminal!;
    useDockLayoutStore.setState({ kindGroups: {} });

    useRightPanelStore.getState().openTerminal(ref, "b");
    applyDockDrop(ref, "terminal:b", { type: "root", edge: "left", size: 300 });

    expect(collectDockGroupIds(dock().root)).toContain(group);
  });
});

describe("openFileFromExplorer", () => {
  it("splits the first file beside the tree, then reuses that group", () => {
    useRightPanelStore.getState().open(ref, "files");

    openFileFromExplorer(ref, "a.ts");
    const group = groupOf("file:a.ts");
    expect(group).not.toBe(groupOf("files"));

    openFileFromExplorer(ref, "b.ts");
    expect(groupOf("file:b.ts")).toBe(group);
    expect(collectDockGroupIds(dock().root).filter((id) => id === group)).toHaveLength(1);
  });

  it("does not split once file tabs have somewhere to go", () => {
    useRightPanelStore.getState().open(ref, "files");
    const elsewhere = dock().createGroup({
      type: "split",
      nodeId: "chat",
      edge: "bottom",
      size: 200,
    });
    dock().setKindGroup("files", elsewhere);

    openFileFromExplorer(ref, "a.ts");

    expect(groupOf("file:a.ts")).toBe("panel");
    expect(collectDockGroupIds(dock().root)).toHaveLength(3);
  });

  it("keeps the tree wide enough to read after the first split", () => {
    useRightPanelStore.getState().open(ref, "files");

    openFileFromExplorer(ref, "a.ts");

    const root = dock().root;
    expect(root.kind === "split" && root.children.at(-1)).toMatchObject({ id: "panel", size: 280 });
  });
});

describe("resetDockLayout", () => {
  it("sends every tab back to the default panel", () => {
    useRightPanelStore.getState().openTerminal(ref, "a");
    applyDockDrop(ref, "terminal:a", { type: "split", nodeId: "chat", edge: "bottom", size: 200 });

    resetDockLayout();

    expect(groupOf("terminal:a")).toBe("panel");
    expect(collectDockGroupIds(dock().root)).toEqual(["chat", "panel"]);
  });
});
