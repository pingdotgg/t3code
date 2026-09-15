import { describe, expect, it } from "vite-plus/test";

import { sidebarPinPath } from "./sidebarPinPath";

describe("sidebar pin path", () => {
  it.each([48, 280, 1200])("keeps a small rounded dip and arc over a %i px journey", (fromY) => {
    const path = sidebarPinPath(0, fromY);
    expect(path[0]).toEqual({ x: 0, y: fromY, offset: 0 });
    expect(path.at(-1)).toEqual({ x: 0, y: 0, offset: 1 });
    expect(Math.max(...path.map((point) => point.x))).toBe(16);
    expect(Math.max(...path.map((point) => point.y))).toBe(fromY + 6);
    expect(Math.min(...path.map((point) => point.y))).toBe(0);
    const lowest = path.findIndex((point) => point.y === fromY + 6);
    expect(path.slice(lowest + 1).every((point, i) => point.y <= path[lowest + i]!.y)).toBe(true);
    expect(path.slice(1).every((point, i) => point.offset > path[i]!.offset)).toBe(true);
  });

  it.each([
    [12, 280],
    [-12, 48],
    [0, 0],
  ])("starts at (%i, %i) and lands exactly in the slot with finite frames", (fromX, fromY) => {
    const path = sidebarPinPath(fromX, fromY);
    expect(path[0]).toEqual({ x: fromX, y: fromY, offset: 0 });
    expect(path.at(-1)).toEqual({ x: 0, y: 0, offset: 1 });
    expect(path.every((point) => Object.values(point).every(Number.isFinite))).toBe(true);
  });
});
