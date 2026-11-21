import { describe, expect, it } from "vite-plus/test";

import { createSwipeRowActivation, visibleSwipeRowKeys } from "./swipe-row-activation";

describe("createSwipeRowActivation", () => {
  it("defers changes while a finger is on the list so a press is never remounted", () => {
    const activation = createSwipeRowActivation();
    activation.activate(["a"]);

    activation.trackTouches(["1"], ["1"]);
    activation.activate(["b"]);
    activation.activate(["c"]);
    expect(activation.isActive("a")).toBe(true);
    expect(activation.isActive("c")).toBe(false);

    activation.trackTouches([], []);
    expect(activation.isActive("a")).toBe(false);
    expect(activation.isActive("b")).toBe(false);
    expect(activation.isActive("c")).toBe(true);
  });

  it("ignores fingers that did not start on the list", () => {
    const activation = createSwipeRowActivation();
    activation.trackTouches(["1"], ["1", "2"]);
    activation.activate(["a"]);

    activation.trackTouches([], ["2"]);
    expect(activation.isActive("a")).toBe(true);
  });

  it("drops a list finger whose end event never arrived", () => {
    const activation = createSwipeRowActivation();
    activation.trackTouches(["1"], ["1"]);
    activation.activate(["a"]);

    activation.trackTouches(["2"], ["2"]);
    activation.trackTouches([], []);
    expect(activation.isActive("a")).toBe(true);
  });
});

describe("visibleSwipeRowKeys", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ key: `row-${index}` }));

  it("ignores missing, null, negative, and out-of-bounds visible ranges", () => {
    expect(visibleSwipeRowKeys(rows, undefined)).toBeNull();
    expect(visibleSwipeRowKeys(rows, { start: null, end: null })).toBeNull();
    expect(visibleSwipeRowKeys(rows, { start: -1, end: -1 })).toBeNull();
    expect(visibleSwipeRowKeys(rows.slice(0, 3), { start: 8, end: 9 })).toBeNull();
  });

  it("returns the buffered visible row keys clamped to the list", () => {
    expect(visibleSwipeRowKeys(rows, { start: 0, end: 2 })).toEqual([
      "row-0",
      "row-1",
      "row-2",
      "row-3",
      "row-4",
    ]);
    expect(visibleSwipeRowKeys(rows, { start: 4, end: 5 })).toEqual([
      "row-2",
      "row-3",
      "row-4",
      "row-5",
      "row-6",
      "row-7",
    ]);
  });
});
