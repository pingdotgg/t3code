import { describe, expect, it } from "vite-plus/test";

import { resolveTimelineMinimapMarkers } from "./timelineMinimapRail";

describe("minimap visible markers", () => {
  it.each([
    { start: null, end: null, markers: [0, 0], current: null },
    { start: null, end: 9, markers: [0, 0], current: null },
    { start: 9, end: null, markers: [0, 0], current: null },
    { start: undefined, end: 10, markers: [0, 0], current: null },
    { start: 2, end: undefined, markers: [0, 0], current: null },
    { start: 0, end: 1, markers: [0, 0], current: null },
    { start: 0, end: 2, markers: [0, 1], current: 0 },
    { start: 2, end: 2, markers: [0, 1], current: 0 },
    { start: 3, end: 5, markers: [1, 1], current: 0 },
    { start: 3, end: 10, markers: [1, 3], current: 1 },
    { start: 6, end: 10, markers: [1, 3], current: 1 },
    { start: 7, end: 9, markers: [2, 2], current: 1 },
    { start: 10, end: 11, markers: [2, 3], current: 2 },
    { start: 11, end: 20, markers: [3, 3], current: 2 },
  ])("resolves rows $start through $end", ({ start, end, markers, current }) => {
    expect(resolveTimelineMinimapMarkers([2, 6, 10], start, end)).toEqual({
      start: markers[0],
      end: markers[1],
      currentIndex: current,
    });
  });

  it("has no visible markers or current turn in an empty timeline", () => {
    expect(resolveTimelineMinimapMarkers([], 0, 20)).toEqual({
      start: 0,
      end: 0,
      currentIndex: null,
    });
  });

  it("finds visible markers near the end of a large timeline", () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => index * 2);
    const visible = resolveTimelineMinimapMarkers(rows, 1_991, 1_997);
    expect(visible).toEqual({ start: 996, end: 999, currentIndex: 996 });
  });
});
