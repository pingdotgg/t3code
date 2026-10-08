import { it, expect } from "vite-plus/test";
import {
  isTimelineMinimapRowVisible,
  resolveTimelineMinimapVisibleRange,
  resolveTimelineMinimapCurrentIndex,
} from "./MessagesTimeline.logic";

it("highlights only the visible cluster while preserving adjacent markers", () => {
  const rowIndices = [0, 10, 20, 30, 40, 50];
  expect(rowIndices.filter((index) => isTimelineMinimapRowVisible(index, 19, 31))).toEqual([
    20, 30,
  ]);
  expect(isTimelineMinimapRowVisible(20, null, null)).toBe(false);
  expect(isTimelineMinimapRowVisible(20, 20, 20)).toBe(true);
});

it("resolves minimap navigation from the visible rows", () => {
  const rowIndices = [0, 10, 20, 30, 40];
  const resolve = (visibleStart: number | null, visibleEnd: number | null) =>
    resolveTimelineMinimapCurrentIndex({ visibleStart, visibleEnd, rowIndices });

  // Only the actual visible cluster participates, regardless of cached positions.
  expect(resolve(19, 31)).toBe(2);
  expect(resolve(21, 29)).toBe(2);
  expect(resolve(41, 45)).toBe(4);
  expect(resolve(0, 0)).toBe(0);
  expect(resolve(null, null)).toBeNull();
  expect(
    resolveTimelineMinimapCurrentIndex({ visibleStart: 0, visibleEnd: 5, rowIndices: [] }),
  ).toBeNull();
});

it("refreshes visibility while scrolling within the same rendered buffer", () => {
  const state = {
    startBuffered: 0,
    endBuffered: 4,
    scroll: 200,
    scrollLength: 150,
    positionAtIndex: (index: number) => index * 100,
    sizeAtIndex: () => 100,
  };
  expect(resolveTimelineMinimapVisibleRange(state)).toEqual({ start: 2, end: 3 });
  expect(resolveTimelineMinimapVisibleRange({ ...state, scroll: 0 })).toEqual({ start: 0, end: 1 });
});

it("ignores stale offscreen positions outside the rendered buffer", () => {
  const range = resolveTimelineMinimapVisibleRange({
    startBuffered: 10,
    endBuffered: 14,
    scroll: 1000,
    scrollLength: 200,
    // Earlier rows have stale coordinates that overlap the viewport.
    positionAtIndex: (index) => (index < 10 ? 1000 : index * 100),
    sizeAtIndex: () => 100,
  });
  expect(range).toEqual({ start: 10, end: 11 });
  expect(isTimelineMinimapRowVisible(0, range.start, range.end)).toBe(false);
});

it("keeps unmeasured markers visible and includes measured rows crossing the viewport", () => {
  const state = {
    startBuffered: 0,
    endBuffered: 2,
    scroll: 100,
    scrollLength: 200,
    positionAtIndex: (index: number) => [50, 150, 300][index],
    sizeAtIndex: (_index: number): number | undefined => undefined,
  };
  expect(resolveTimelineMinimapVisibleRange(state)).toEqual({ start: 1, end: 1 });
  expect(resolveTimelineMinimapVisibleRange({ ...state, sizeAtIndex: () => 100 })).toEqual({
    start: 0,
    end: 1,
  });
  expect(resolveTimelineMinimapVisibleRange({ ...state, sizeAtIndex: () => Number.NaN })).toEqual({
    start: 1,
    end: 1,
  });
});
