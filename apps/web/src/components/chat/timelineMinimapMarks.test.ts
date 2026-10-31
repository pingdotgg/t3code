import { describe, expect, it } from "vite-plus/test";
import {
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapMarkIndices,
  resolveTimelineMinimapTopPercent,
} from "./MessagesTimeline.logic";

const REPRO_RAIL_HEIGHT = 512;
const DENSE_COUNT = 600;
const MARK_MIN_SPACING_PX = 6;

function pixelGap(left: number, right: number, itemCount: number, railHeightPx: number): number {
  return (Math.abs(right - left) / (itemCount - 1)) * railHeightPx;
}

function expectSeparated(
  indices: ReadonlyArray<number>,
  itemCount: number,
  railHeightPx: number,
  pins: ReadonlySet<number> = new Set(),
) {
  for (let slot = 1; slot < indices.length; slot += 1) {
    const previous = indices[slot - 1] ?? 0;
    const index = indices[slot] ?? 0;
    expect(index).toBeGreaterThan(previous);
    if (pins.has(previous) && pins.has(index)) continue;
    expect(pixelGap(previous, index, itemCount, railHeightPx)).toBeGreaterThanOrEqual(
      MARK_MIN_SPACING_PX - 1e-6,
    );
  }
}

describe("timeline minimap mark spacing", () => {
  it("keeps the rail on the 8px track until the viewport cap binds", () => {
    expect(resolveTimelineMinimapHeightStyle(5)).toBe("min(32px, max(1px, calc(100vh - 18rem)))");
  });

  it("draws every mark while centers stay at least 6px apart", () => {
    expect(resolveTimelineMinimapMarkIndices({ itemCount: 1, railHeightPx: 0 })).toEqual([0]);
    expect(
      resolveTimelineMinimapMarkIndices({ itemCount: 75, railHeightPx: REPRO_RAIL_HEIGHT }),
    ).toHaveLength(75);
    const comfortable = 39 * 8;
    expect(
      resolveTimelineMinimapMarkIndices({ itemCount: 40, railHeightPx: comfortable }),
    ).toHaveLength(40);
  });

  it("thins a capped rail so idle marks stay separate, including both ends", () => {
    const indices = resolveTimelineMinimapMarkIndices({
      itemCount: DENSE_COUNT,
      railHeightPx: REPRO_RAIL_HEIGHT,
    });
    expect(indices.length).toBeLessThan(DENSE_COUNT);
    expect(indices.length).toBeGreaterThan(2);
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(DENSE_COUNT - 1);
    expectSeparated(indices, DENSE_COUNT, REPRO_RAIL_HEIGHT);
  });

  it("keeps a pinned message and still separates the surrounding marks", () => {
    const pins = [3, 42, 43, 596];
    const indices = resolveTimelineMinimapMarkIndices({
      itemCount: DENSE_COUNT,
      railHeightPx: REPRO_RAIL_HEIGHT,
      pinnedIndices: [null, -1, 1.5, DENSE_COUNT, ...pins],
    });
    for (const pin of pins) {
      expect(indices).toContain(pin);
    }
    expect(indices).toContain(0);
    expect(indices[indices.length - 1]).toBe(DENSE_COUNT - 1);
    expectSeparated(
      indices,
      DENSE_COUNT,
      REPRO_RAIL_HEIGHT,
      new Set([0, DENSE_COUNT - 1, ...pins]),
    );
    expect(indices.filter((index) => index === 42)).toHaveLength(1);
  });

  it("maps the pointer to the exact message after marks are thinned", () => {
    const rail = {
      itemCount: DENSE_COUNT,
      railTop: 100,
      railHeight: REPRO_RAIL_HEIGHT,
    };
    const indices = resolveTimelineMinimapMarkIndices({
      itemCount: DENSE_COUNT,
      railHeightPx: REPRO_RAIL_HEIGHT,
    });
    expect(indices).not.toContain(3);

    for (const index of [0, 1, 3, 50, 299, 599]) {
      const pointerY = rail.railTop + (index / (DENSE_COUNT - 1)) * rail.railHeight;
      expect(resolveTimelineMinimapIndexFromPointer({ ...rail, pointerY })).toBe(index);
      expect(resolveTimelineMinimapTopPercent(index, DENSE_COUNT)).toBe(
        (index / (DENSE_COUNT - 1)) * 100,
      );
    }

    for (const index of indices) {
      const pointerY =
        rail.railTop +
        (resolveTimelineMinimapTopPercent(index, DENSE_COUNT) / 100) * rail.railHeight;
      expect(resolveTimelineMinimapIndexFromPointer({ ...rail, pointerY })).toBe(index);
    }

    expect(resolveTimelineMinimapIndexFromPointer({ ...rail, pointerY: 0 })).toBe(0);
    expect(resolveTimelineMinimapIndexFromPointer({ ...rail, pointerY: 10_000 })).toBe(
      DENSE_COUNT - 1,
    );
  });
});
