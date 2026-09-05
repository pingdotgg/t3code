import { describe, expect, it } from "vite-plus/test";

import { composerStashKeyframes } from "./composerStashMotion";

function points(x: number, y: number) {
  return composerStashKeyframes(x, y).map((frame) => {
    const coordinates = frame.transform.match(/translate\(([^,]+)px, ([^)]+)px\)/)!;
    return { x: Number(coordinates[1]), y: Number(coordinates[2]), offset: frame.offset };
  });
}

describe("composer stash motion", () => {
  it.each([-48, -280, -1200])("keeps a small rounded dip and arc over a %i px journey", (y) => {
    const path = points(0, y);
    expect(path[0]).toEqual({ x: 0, y: 0, offset: 0 });
    expect(path.at(-1)).toEqual({ x: 0, y, offset: 1 });
    expect(Math.max(...path.map((point) => point.x))).toBe(16);
    expect(Math.max(...path.map((point) => point.y))).toBe(6);
    expect(Math.min(...path.map((point) => point.y))).toBe(y);
    const lowest = path.findIndex((point) => point.y === 6);
    expect(path.slice(lowest + 1).every((point, i) => point.y <= path[lowest + i]!.y)).toBe(true);
    expect(path.slice(1).every((point, i) => point.offset > path[i]!.offset)).toBe(true);
  });

  it.each([
    [12, -280],
    [-12, -48],
    [0, 0],
  ])("lands exactly at (%i, %i) with finite frames", (x, y) => {
    const path = points(x, y);
    expect(path.at(-1)).toEqual({ x, y, offset: 1 });
    expect(path.every((point) => Object.values(point).every(Number.isFinite))).toBe(true);
  });
});
