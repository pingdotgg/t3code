import { describe, expect, it } from "vite-plus/test";

import { sidewaysWheelScrollsStrip } from "./gesture";

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
    const scrolls = (selector: string) =>
      sidewaysWheelScrollsStrip(strip.pathFrom(selector), strip);

    expect(scrolls("[data-row]")).toBe(true);
    expect(scrolls("[data-narrow]")).toBe(true);
    expect(scrolls("[data-wide]")).toBe(false);
    strip.querySelector("[data-wide]")!.scrollLeft = 9999;
    expect(scrolls("[data-wide]")).toBe(false);
  });

  it("leaves the swipe alone while the strip itself cannot scroll", () => {
    using strip = mountStrip("hidden");
    expect(sidewaysWheelScrollsStrip(strip.pathFrom("[data-row]"), strip)).toBe(false);
  });
});
