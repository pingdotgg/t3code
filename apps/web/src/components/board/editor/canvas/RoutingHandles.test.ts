import { describe, expect, it } from "vite-plus/test";

import { canvasRouteCollisionDetection } from "./CanvasView";
import {
  laneDropId,
  laneRouteDragId,
  resolveLaneRoutingDrop,
  type LaneDropData,
  type RouteDragData,
} from "./RoutingHandles";

const laneKeys = ["queue", "run", "done"];
const dragData = (laneKey: string, kind: RouteDragData["kind"]): RouteDragData => ({
  laneKey,
  kind,
});
const dropData = (laneKey: string): LaneDropData => ({ laneKey });
const clearDropData = { clear: true } satisfies LaneDropData;

describe("RoutingHandles", () => {
  it("builds opaque lane drag and drop ids for keys with separators and spaces", () => {
    expect(laneRouteDragId("source:lane with spaces", "success")).toBe(
      JSON.stringify(["lane-route", "source:lane with spaces", "success"]),
    );
    expect(laneDropId("source:lane with spaces")).toBe(
      JSON.stringify(["lane-drop", "source:lane with spaces"]),
    );
  });

  it("resolves lane route drops, self-routes, empty drops, invalid targets, and clear drops", () => {
    expect(resolveLaneRoutingDrop(laneKeys, dragData("run", "success"), dropData("done"))).toEqual({
      laneKey: "run",
      kind: "success",
      targetLaneKey: "done",
    });
    expect(resolveLaneRoutingDrop(laneKeys, dragData("run", "failure"), dropData("run"))).toEqual({
      laneKey: "run",
      kind: "failure",
      targetLaneKey: "run",
    });
    expect(resolveLaneRoutingDrop(laneKeys, dragData("run", "success"), null)).toBeNull();
    expect(
      resolveLaneRoutingDrop(laneKeys, dragData("run", "success"), dropData("missing")),
    ).toBeNull();
    expect(resolveLaneRoutingDrop(laneKeys, dragData("run", "success"), clearDropData)).toEqual({
      laneKey: "run",
      kind: "success",
      targetLaneKey: undefined,
    });
    expect(resolveLaneRoutingDrop(laneKeys, "lane-route:run:success", dropData("done"))).toBeNull();
  });

  it("preserves colon-containing lane keys when resolving route drops", () => {
    expect(
      resolveLaneRoutingDrop(
        ["source:lane", "done"],
        dragData("source:lane", "success"),
        dropData("done"),
      ),
    ).toEqual({
      laneKey: "source:lane",
      kind: "success",
      targetLaneKey: "done",
    });
  });

  it("does not resolve a lane collision when the route pointer is over blank canvas", () => {
    const laneRect = { top: 0, left: 0, right: 240, bottom: 120, width: 240, height: 120 };
    const collisions = canvasRouteCollisionDetection({
      active: {
        id: "lane-route:run:success",
        data: { current: undefined },
        rect: { current: { initial: null, translated: null } },
      },
      collisionRect: { top: 200, left: 320, right: 340, bottom: 220, width: 20, height: 20 },
      droppableContainers: [
        {
          id: "lane-drop:done",
          key: "lane-drop:done",
          data: { current: undefined },
          disabled: false,
          node: { current: null },
          rect: { current: laneRect },
        },
      ],
      droppableRects: new Map([["lane-drop:done", laneRect]]),
      pointerCoordinates: { x: 330, y: 210 },
    });

    expect(collisions).toEqual([]);
  });
});
