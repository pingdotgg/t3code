import { describe, expect, it } from "vite-plus/test";
import { spaceProjectDropTarget } from "./spaceProjectDropTarget";

const viewport = { x: 20, y: 100, width: 320, height: 500 };
const columns = [
  { spaceId: "work", x: 20, y: 100, width: 150, height: 500 },
  { spaceId: null, x: 182, y: 100, width: 150, height: 500 },
];

describe("spaceProjectDropTarget", () => {
  it("finds named and unassigned columns without treating the gap as a destination", () => {
    expect(spaceProjectDropTarget(columns, viewport, 100, 200)).toBe("work");
    expect(spaceProjectDropTarget(columns, viewport, 250, 200)).toBeNull();
    expect(spaceProjectDropTarget(columns, viewport, 176, 200)).toBeUndefined();
  });
  it("ignores offscreen columns and cancelled points outside the viewport", () => {
    const offscreen = [{ spaceId: "hidden", x: 350, y: 100, width: 150, height: 500 }];
    expect(spaceProjectDropTarget(offscreen, viewport, 400, 200)).toBeUndefined();
    expect(spaceProjectDropTarget(columns, viewport, 100, 99)).toBeUndefined();
    expect(spaceProjectDropTarget(columns, viewport, 100, 600)).toBeUndefined();
  });
  it("uses half-open edges so adjacent columns have one destination", () => {
    expect(spaceProjectDropTarget(columns, viewport, 20, 100)).toBe("work");
    expect(spaceProjectDropTarget(columns, viewport, 170, 200)).toBeUndefined();
    expect(spaceProjectDropTarget([], viewport, 100, 200)).toBeUndefined();
  });
  it("retargets premeasured columns after edge scrolling in either direction", () => {
    const distant = [
      { spaceId: "first", x: 20, y: 100, width: 150, height: 500 },
      { spaceId: "last", x: 560, y: 100, width: 150, height: 500 },
    ];
    expect(spaceProjectDropTarget(distant, viewport, 100, 200, 540)).toBe("last");
    expect(spaceProjectDropTarget(distant, viewport, 100, 200, 0)).toBe("first");
    expect(spaceProjectDropTarget([{ ...columns[0]!, x: -520 }], viewport, 100, 200, -540)).toBe(
      "work",
    );
    expect(spaceProjectDropTarget(distant, viewport, 400, 200, 540)).toBeUndefined();
  });
});
