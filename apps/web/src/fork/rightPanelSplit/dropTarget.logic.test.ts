import type { ClientRect, DroppableContainer } from "@dnd-kit/core";
import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

import { type DropInput, panelCollision, resolveDrop } from "./dropTarget.logic";
import type { PanelArrangement } from "./splitLayout.logic";

const file = (id: string): RightPanelSurface => ({
  id: `file:${id}`,
  kind: "file",
  relativePath: id,
  revealLine: null,
  revealRequestId: 1,
});
const id = (name: string) => file(name).id;

function rect(left: number, top: number, width: number, height: number): ClientRect {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

const flat: PanelArrangement = {
  surfaces: ["a", "b", "c"].map(file),
  activeSurfaceId: id("b"),
};
const twoPanes: PanelArrangement = {
  surfaces: ["a", "b", "c", "d"].map(file),
  activeSurfaceId: id("a"),
  split: { rightIds: [id("c"), id("d")], otherShownId: id("c"), ratio: 0.5 },
};
const content = rect(0, 40, 600, 400);
const tabRect = rect(300, 8, 80, 24);

function drop(input: Partial<DropInput> & Pick<DropInput, "draggedId" | "over" | "pointer">) {
  return resolveDrop({
    arrangement: flat,
    splitRendered: false,
    splitAllowed: true,
    restoreShown: null,
    splitGrowth: 0,
    ...input,
  });
}

describe("resolveDrop", () => {
  it("splits to the side of an outer third and previews the new half", () => {
    expect(
      drop({
        draggedId: id("b"),
        over: { kind: "content", pane: "left", rect: content },
        pointer: { x: 500, y: 200 },
        restoreShown: id("a"),
      }),
    ).toEqual({
      change: { type: "split", surfaceId: id("b"), side: "right", restoreShown: id("a") },
      ghost: { kind: "box", left: 300, top: 40, width: 300, height: 400 },
    });
    expect(
      drop({
        draggedId: id("b"),
        over: { kind: "content", pane: "left", rect: content },
        pointer: { x: 100, y: 200 },
      })?.change,
    ).toEqual({ type: "split", surfaceId: id("b"), side: "left" });
  });

  it("previews the half of the panel a split will widen it to", () => {
    const over = { kind: "content", pane: "left", rect: content } as const;
    expect(
      drop({ draggedId: id("b"), over, pointer: { x: 500, y: 200 }, splitGrowth: 200 })?.ghost,
    ).toEqual({ kind: "box", left: 200, top: 40, width: 400, height: 400 });
    expect(
      drop({ draggedId: id("b"), over, pointer: { x: 100, y: 200 }, splitGrowth: 200 })?.ghost,
    ).toEqual({ kind: "box", left: -200, top: 40, width: 400, height: 400 });
  });

  it.each([
    ["the centre third", { pointer: { x: 300, y: 200 } }],
    ["a panel too narrow to split", { pointer: { x: 500, y: 200 }, splitAllowed: false }],
    [
      "a lone tab",
      {
        pointer: { x: 500, y: 200 },
        arrangement: { surfaces: [file("b")], activeSurfaceId: id("b") },
      },
    ],
    ["no target", { pointer: { x: 500, y: 200 }, over: null }],
  ] as const)("does nothing over %s", (_name, overrides) => {
    expect(
      drop({
        draggedId: id("b"),
        over: { kind: "content", pane: "left", rect: content },
        ...overrides,
      }),
    ).toBeNull();
  });

  it("gives the other pane the tab at its end, and ignores the tab's own pane", () => {
    const right = rect(301, 40, 299, 400);
    expect(
      drop({
        arrangement: twoPanes,
        splitRendered: true,
        draggedId: id("b"),
        over: { kind: "content", pane: "right", rect: right },
        pointer: { x: 400, y: 200 },
      }),
    ).toEqual({
      change: { type: "move", surfaceId: id("b"), pane: "right", beforeId: null },
      ghost: { kind: "box", left: 301, top: 40, width: 299, height: 400 },
    });
    expect(
      drop({
        arrangement: twoPanes,
        splitRendered: true,
        draggedId: id("b"),
        over: { kind: "content", pane: "left", rect: rect(0, 40, 300, 400) },
        pointer: { x: 100, y: 200 },
      }),
    ).toBeNull();
  });

  it("reorders inside the tab's own strip without a ghost, and a drop on itself is nothing", () => {
    expect(
      drop({
        draggedId: id("a"),
        over: { kind: "tab", id: id("c"), rect: tabRect },
        pointer: { x: 340, y: 20 },
      }),
    ).toEqual({ change: { type: "reorder", surfaceId: id("a"), beforeId: null }, ghost: null });
    expect(
      drop({
        draggedId: id("a"),
        over: { kind: "tab", id: id("a"), rect: tabRect },
        pointer: { x: 340, y: 20 },
      }),
    ).toBeNull();
  });

  it("places a tab before or after a tab of the other strip by the half under the pointer", () => {
    const over = { kind: "tab", id: id("c"), rect: tabRect } as const;
    expect(
      drop({
        arrangement: twoPanes,
        splitRendered: true,
        draggedId: id("b"),
        over,
        pointer: { x: 310, y: 20 },
        restoreShown: id("a"),
      }),
    ).toEqual({
      change: {
        type: "move",
        surfaceId: id("b"),
        pane: "right",
        beforeId: id("c"),
        restoreShown: id("a"),
      },
      ghost: { kind: "marker", left: 299, top: 8, height: 24 },
    });
    expect(
      drop({
        arrangement: twoPanes,
        splitRendered: true,
        draggedId: id("b"),
        over,
        pointer: { x: 370, y: 20 },
      })?.change,
    ).toEqual({ type: "move", surfaceId: id("b"), pane: "right", beforeId: id("d") });
  });

  it("on a narrow panel a reorder onto the other pane's tab adopts that pane", () => {
    expect(
      drop({
        arrangement: twoPanes,
        splitAllowed: false,
        draggedId: id("a"),
        over: { kind: "tab", id: id("c"), rect: tabRect },
        pointer: { x: 340, y: 20 },
      })?.change,
    ).toEqual({ type: "move", surfaceId: id("a"), pane: "right", beforeId: id("d") });
  });
});

describe("panelCollision", () => {
  function container(name: string, data: unknown): DroppableContainer {
    return {
      id: name,
      key: name,
      data: { current: data },
      disabled: false,
      node: { current: null },
      rect: { current: null },
    } as DroppableContainer;
  }
  const entries: Array<[DroppableContainer, ClientRect]> = [
    [container("t1", { kind: "tab", pane: "left" }), rect(4, 8, 60, 24)],
    [container("t2", { kind: "tab", pane: "left" }), rect(68, 8, 60, 24)],
    // Scrolled out of the left strip, so its rect lies over the right pane.
    [container("t9", { kind: "tab", pane: "left" }), rect(320, 8, 60, 24)],
    [container("t3", { kind: "tab", pane: "right" }), rect(305, 8, 60, 24)],
    [container("content:left", { kind: "content", pane: "left" }), rect(0, 40, 300, 400)],
    [container("content:right", { kind: "content", pane: "right" }), rect(301, 40, 299, 400)],
  ];
  const at = (x: number, y: number) =>
    panelCollision({
      active: {} as never,
      collisionRect: rect(x, y, 1, 1),
      droppableContainers: entries.map(([entry]) => entry),
      droppableRects: new Map(entries.map(([entry, box]) => [entry.id, box])),
      pointerCoordinates: { x, y },
    }).map((collision) => collision.id);

  it.each([
    ["a tab under the pointer", 80, 20, ["t2"]],
    ["the gap between two tabs, to the nearest", 67, 20, ["t2"]],
    ["just below the strip's tabs", 30, 36, ["t1"]],
    ["a scrolled-out tab of the other strip, to this pane's tab", 330, 20, ["t3"]],
    ["the pane content", 150, 200, ["content:left"]],
    ["the right pane content", 450, 200, ["content:right"]],
    ["outside the panel", 650, 200, []],
  ] as const)("aims %s", (_name, x, y, expected) => {
    expect(at(x, y)).toEqual(expected);
  });
});
