import { describe, expect, it, vi } from "vite-plus/test";

import {
  isDiscreteWheel,
  scrollLeftByWheel,
  sidewaysWheelScrollsStrip,
  wheelChaseStep,
  wheelScrollTarget,
} from "./gesture";

function mountStrip(stripOverflow: string) {
  const strip = document.createElement("div");
  strip.style.cssText = `width: 400px; height: 300px; overflow-x: ${stripOverflow}; overflow-y: hidden; overscroll-behavior-x: none`;
  strip.innerHTML = `
    <div style="width: 1200px; height: 300px; overflow: hidden; overscroll-behavior-y: none">
      <div data-list style="width: 400px; height: 300px; overflow-y: auto; overscroll-behavior: contain">
        <div data-row style="height: 2000px"></div>
        <pre data-wide style="width: 300px; overflow-x: auto; overscroll-behavior-x: contain"><span style="display: inline-block; width: 900px">code</span></pre>
        <pre data-narrow style="width: 300px; overflow-x: auto; overscroll-behavior-x: contain">code</pre>
      </div>
    </div>`;
  document.body.append(strip);
  const pathFrom = (selector: string) => {
    const path: Element[] = [];
    for (let node = strip.querySelector(selector); node; node = node.parentElement) path.push(node);
    return path;
  };
  return Object.assign(strip, { pathFrom, [Symbol.dispose]: () => strip.remove() });
}

describe("sidewaysWheelScrollsStrip", () => {
  it("gives a sideways swipe to the nearest scroller that moves sideways", () => {
    using strip = mountStrip("auto");
    const scrolls = (selector: string, deltaX: number, deltaY: number) =>
      sidewaysWheelScrollsStrip(strip.pathFrom(selector), strip, deltaX, deltaY);

    expect(scrolls("[data-row]", 40, 3)).toBe(true);
    expect(scrolls("[data-row]", -40, -3)).toBe(true);
    expect(scrolls("[data-narrow]", 40, 0)).toBe(true);
    expect(scrolls("[data-row]", 3, 40)).toBe(false);
    expect(scrolls("[data-wide]", 40, 0)).toBe(false);
    strip.querySelector("[data-wide]")!.scrollLeft = 9999;
    expect(scrolls("[data-wide]", 40, 0)).toBe(false);
  });

  it("leaves the swipe alone while the strip itself cannot scroll", () => {
    using strip = mountStrip("hidden");
    expect(sidewaysWheelScrollsStrip(strip.pathFrom("[data-row]"), strip, 40, 3)).toBe(false);
  });
});

describe("isDiscreteWheel", () => {
  const wheel = (init: {
    deltaX?: number;
    deltaY?: number;
    wheelDeltaX?: number;
    wheelDeltaY?: number;
    deltaMode?: number;
  }) =>
    ({
      deltaX: 0,
      deltaY: 0,
      wheelDeltaX: 0,
      wheelDeltaY: 0,
      deltaMode: 0,
      ...init,
    }) as unknown as WheelEvent;

  it("tells a notched wheel from a trackpad on either axis", () => {
    expect(isDiscreteWheel(wheel({ deltaY: 100, wheelDeltaY: -120 }))).toBe(true);
    expect(isDiscreteWheel(wheel({ deltaY: 53, wheelDeltaY: -120 }))).toBe(true);
    expect(isDiscreteWheel(wheel({ deltaX: 85, wheelDeltaX: -120 }))).toBe(true);
    expect(isDiscreteWheel(wheel({ deltaX: -200, wheelDeltaX: 240 }))).toBe(true);
    expect(isDiscreteWheel(wheel({ deltaX: 3, deltaMode: 1 }))).toBe(true);
    expect(isDiscreteWheel(wheel({ deltaX: 4, wheelDeltaX: -12 }))).toBe(false);
    expect(isDiscreteWheel(wheel({ deltaX: 40, wheelDeltaX: -120 }))).toBe(false);
    expect(isDiscreteWheel(wheel({ deltaY: 2.5, wheelDeltaY: -7 }))).toBe(false);
    expect(
      isDiscreteWheel(wheel({ deltaX: 120, deltaY: 1, wheelDeltaX: -360, wheelDeltaY: -3 })),
    ).toBe(false);
  });
});

describe("wheelScrollTarget", () => {
  it("adds quick notches onto the target still being reached", () => {
    expect(wheelScrollTarget(100, undefined, 85, 1000)).toBe(185);
    expect(wheelScrollTarget(130, 185, 85, 1000)).toBe(270);
    expect(wheelScrollTarget(130, 185, -85, 1000)).toBe(45);
  });

  it("keeps the target inside the scroll range", () => {
    expect(wheelScrollTarget(950, undefined, 120, 1000)).toBe(1000);
    expect(wheelScrollTarget(20, undefined, -120, 1000)).toBe(0);
    expect(wheelScrollTarget(0, undefined, 120, -5)).toBe(0);
  });
});

describe("wheelChaseStep", () => {
  it("eases toward the target and lands on it", () => {
    const first = wheelChaseStep(0, 100, 16);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(100);
    expect(wheelChaseStep(first, 100, 16)).toBeGreaterThan(first);
    expect(wheelChaseStep(99.8, 100, 16)).toBe(100);
    expect(wheelChaseStep(100, 0, 1000)).toBe(0);
  });
});

describe("scrollLeftByWheel", () => {
  function mountRow() {
    const row = document.createElement("div");
    row.style.cssText = "width: 300px; height: 40px; overflow-x: auto";
    row.innerHTML = `<div style="width: 4000px; height: 40px"></div>`;
    document.body.append(row);
    return Object.assign(row, { [Symbol.dispose]: () => row.remove() });
  }
  const sideways = (timeStamp: number, deltaX: number, wheelDeltaX: number) =>
    ({
      deltaMode: 0,
      deltaX,
      deltaY: 0,
      wheelDeltaX,
      wheelDeltaY: 0,
      timeStamp,
    }) as unknown as WheelEvent;
  const feed = (row: HTMLElement, events: readonly (readonly [number, number, number])[]) =>
    events.map(([time, delta, legacy]) => {
      scrollLeftByWheel(row, sideways(time, delta, legacy), delta);
      return row.scrollLeft;
    });

  it("eases a notched mouse on macOS whose ticks match its line deltas", async () => {
    using row = mountRow();
    const positions = feed(row, [
      [10_000, 120, -360],
      [10_030, 160, -480],
      [10_050, 200, -600],
    ]);
    expect(positions).toEqual([0, 0, 0]);
    await vi.waitFor(() => expect(row.scrollLeft).toBe(480));
  });

  it("eases slow macOS notches with fractional deltas", async () => {
    using row = mountRow();
    row.scrollLeft = 100;
    const positions = feed(row, [
      [20_000, -4.0002, 120],
      [20_040, -4.0002, 120],
      [20_070, -8.0005, 120],
    ]);
    expect(positions).toEqual([100, 100, 100]);
    await vi.waitFor(() => expect(row.scrollLeft).toBeCloseTo(84, 0));
  });

  it("keeps a trackpad swipe direct when it passes whole ticks mid-swipe", () => {
    using row = mountRow();
    const deltas = [3, 7, 18, 40, 33, 120, 61, 25, 9, 2];
    const positions = feed(
      row,
      deltas.map((delta, index) => [30_000 + index * 16, delta, -3 * delta] as const),
    );
    let sum = 0;
    expect(positions).toEqual(deltas.map((delta) => (sum += delta)));
  });

  it("finishes an eased first tick without losing it when the swipe turns out direct", async () => {
    using row = mountRow();
    const positions = feed(row, [
      [40_000, 40, -120],
      [40_016, 7, -21],
      [40_032, 9, -27],
    ]);
    expect(positions).toEqual([0, 7, 16]);
    await vi.waitFor(() => expect(row.scrollLeft).toBe(56));
  });
});
