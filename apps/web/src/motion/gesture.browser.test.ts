import { describe, expect, it } from "vite-plus/test";

import {
  isDiscreteWheel,
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
