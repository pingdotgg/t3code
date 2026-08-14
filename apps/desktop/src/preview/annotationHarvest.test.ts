import { describe, expect, it } from "vite-plus/test";

import {
  harvestBoxes,
  isCenterInRect,
  summarizeHarvestLabels,
  type HarvestBox,
} from "./annotationHarvest.ts";

const rect = { x: 10, y: 10, width: 200, height: 100 };

const box = (
  left: number,
  top: number,
  width: number,
  height: number,
  extra: Partial<HarvestBox> = {},
): HarvestBox => ({
  left,
  top,
  width,
  height,
  childCount: 0,
  isControl: false,
  ...extra,
});

describe("annotationHarvest", () => {
  it("keeps a leaf whose center sits inside the box", () => {
    expect(isCenterInRect(box(20, 20, 40, 20), rect)).toBe(true);
  });

  it("drops a leaf whose center sits outside the box", () => {
    expect(isCenterInRect(box(180, 20, 80, 20), rect)).toBe(false);
  });

  it("keeps buttons even when they have children", () => {
    const found = harvestBoxes(
      [box(20, 20, 80, 24, { childCount: 2, isControl: true }), box(30, 40, 20, 12)],
      rect,
    );
    expect(found).toHaveLength(2);
  });

  it("skips large wrappers that are not controls", () => {
    const found = harvestBoxes([box(12, 12, 180, 80, { childCount: 6 })], rect);
    expect(found).toHaveLength(0);
  });

  it("prefers smaller leaves and caps the list", () => {
    const items = Array.from({ length: 6 }, (_, index) =>
      box(20 + index, 20 + index, 80 - index * 8, 24),
    );
    const found = harvestBoxes(items, rect, 3);
    expect(found).toHaveLength(3);
    expect(found[0]?.width).toBeLessThan(found[2]?.width ?? 0);
  });

  it("names a few harvested controls, then counts the rest", () => {
    expect(summarizeHarvestLabels(["Settings", "Invoices", "Clients", "Search"])).toBe(
      "Settings · Invoices · Clients +1",
    );
    expect(summarizeHarvestLabels([])).toBe("This area");
  });
});
