import { describe, expect, it } from "vite-plus/test";

import { createSwipeRowActivation } from "./swipe-row-activation";

describe("createSwipeRowActivation", () => {
  it("keeps rows awake ahead of a glide, rendering only when the window moves", () => {
    const activation = createSwipeRowActivation();
    let renders = 0;
    activation.subscribe(() => (renders += 1));
    const rows = Array.from({ length: 100 }, (_, index) => ({ key: `row-${index}` }));

    for (let start = 0; start < 60; start += 1) {
      activation.followScroll(rows, start, start + 9);
      for (let index = start; index <= start + 9; index += 1) {
        expect(activation.isActive(`row-${index}`)).toBe(true);
      }
    }
    expect(renders).toBeLessThan(25);
  });

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
