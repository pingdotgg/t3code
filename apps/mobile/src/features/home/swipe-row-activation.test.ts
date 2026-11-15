import { describe, expect, it, vi } from "vite-plus/test";

import { createScrollActivationScheduler, createSwipeRowActivation } from "./swipe-row-activation";

describe("createScrollActivationScheduler", () => {
  it("wakes rows scrolled into view before a fling settles, then the final range", () => {
    vi.useFakeTimers();
    try {
      const activation = createSwipeRowActivation();
      const scheduler = createScrollActivationScheduler();
      let visible = ["a"];
      const onScroll = () => scheduler.onScroll(() => activation.activate(visible));

      for (let frame = 0; frame < 20; frame += 1) {
        visible = [`row-${frame}`];
        onScroll();
        vi.advanceTimersByTime(16);
      }
      expect(activation.isActive("row-19")).toBe(false);
      expect(activation.isActive("row-10")).toBe(true);

      vi.advanceTimersByTime(200);
      expect(activation.isActive("row-19")).toBe(true);
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

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
