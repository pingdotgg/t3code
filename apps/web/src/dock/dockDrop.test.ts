import { describe, expect, it } from "vite-plus/test";

import { resolveDockDrop, type DockGroupGeometry, type DockStackGeometry } from "./dockDrop";

const root = { left: 0, top: 0, width: 1000, height: 800 };
const left: DockGroupGeometry = {
  id: "left",
  rect: { left: 0, top: 0, width: 500, height: 800 },
  tabbar: { left: 0, top: 0, width: 500, height: 40 },
  tabs: [
    { id: "a", rect: { left: 10, top: 8, width: 80, height: 24 } },
    { id: "b", rect: { left: 100, top: 8, width: 80, height: 24 } },
  ],
};
const right: DockGroupGeometry = {
  id: "right",
  rect: { left: 500, top: 0, width: 500, height: 800 },
  tabbar: null,
  tabs: [],
};
const resolve = (
  x: number,
  y: number,
  sourceGroupId = "right",
  sourceTabCount = 2,
  stacks: readonly DockStackGeometry[] = [],
) => resolveDockDrop({ x, y, root, groups: [left, right], stacks, sourceGroupId, sourceTabCount });

describe("resolveDockDrop", () => {
  it("inserts between tabs on a tab strip", () => {
    expect(resolve(120, 20)?.target).toEqual({ type: "tabs", groupId: "left", index: 1 });
    expect(resolve(400, 20)?.target).toEqual({ type: "tabs", groupId: "left", index: 2 });
  });

  it("joins a group when dropped on its middle", () => {
    expect(resolve(250, 400, "right")?.target).toEqual({
      type: "tabs",
      groupId: "left",
      index: null,
    });
  });

  it("splits half of a group on its edge, and previews that half", () => {
    const drop = resolve(40 + 500, 400);
    expect(drop?.target).toEqual({ type: "split", nodeId: "right", edge: "left", size: 250 });
    expect(drop?.preview).toEqual({ left: 500, top: 0, width: 250, height: 800 });
  });

  it("sits beside a whole stack at its side edge, and one panel just inside it", () => {
    const stack: DockStackGeometry = {
      id: "stack",
      direction: "column",
      rect: { left: 500, top: 0, width: 400, height: 800 },
    };
    const drop = resolve(885, 200, "left", 2, [stack]);
    expect(drop?.target).toEqual({ type: "split", nodeId: "stack", edge: "right", size: 200 });
    expect(drop?.preview).toEqual({ left: 700, top: 0, width: 200, height: 800 });
    expect(resolve(860, 200, "left", 2, [stack])?.target).toMatchObject({ nodeId: "right" });
  });

  it("prefers the innermost stack where two share an edge", () => {
    const outer: DockStackGeometry = {
      id: "outer",
      direction: "column",
      rect: { left: 500, top: 0, width: 400, height: 800 },
    };
    const inner: DockStackGeometry = {
      id: "inner",
      direction: "column",
      rect: { left: 700, top: 0, width: 200, height: 400 },
    };
    expect(resolve(885, 200, "left", 2, [outer, inner])?.target).toMatchObject({
      nodeId: "inner",
    });
  });

  it("splits along the workspace at its outer edge", () => {
    expect(resolve(4, 400)?.target).toEqual({ type: "root", edge: "left", size: 250 });
    expect(resolve(700, 796)?.target).toEqual({ type: "root", edge: "bottom", size: 200 });
  });

  it("splits around a sealed group but never tabs into it", () => {
    const sealed = { ...right, sealed: true };
    const drop = (x: number) =>
      resolveDockDrop({
        x,
        y: 400,
        root,
        groups: [left, sealed],
        stacks: [],
        sourceGroupId: "left",
        sourceTabCount: 2,
      });
    expect(drop(750)).toBeNull();
    expect(drop(540)?.target).toMatchObject({ type: "split", nodeId: "right", edge: "left" });
  });

  it("ignores drops that would not change anything", () => {
    expect(resolve(750, 400, "right")).toBeNull();
    expect(resolve(540, 400, "right", 1)).toBeNull();
    expect(resolve(1200, 400)).toBeNull();
  });
});
