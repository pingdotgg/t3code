import { describe, expect, it } from "vite-plus/test";

import { listenLayoutWheel, sidewaysWheelStripScroll } from "./gesture";

function mountStrip(stripOverflow: string) {
  const strip = document.createElement("div");
  strip.style.cssText = `width: 400px; height: 300px; overflow-x: ${stripOverflow}; overflow-y: hidden; overscroll-behavior-x: none`;
  strip.innerHTML = `
    <div style="width: 1200px; height: 300px; overflow: hidden; overscroll-behavior-y: none">
      <div data-list style="width: 400px; height: 300px; overflow-y: auto; overscroll-behavior-y: contain">
        <div data-row style="height: 2000px"></div>
        <pre data-wide style="width: 300px; overflow-x: auto; overscroll-behavior-x: contain"><span style="display: inline-block; width: 900px">code</span></pre>
        <pre data-narrow style="width: 300px; overflow-x: auto; overscroll-behavior-x: contain">code</pre>
        <pre data-plain style="width: 300px; overflow-x: auto">code</pre>
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

describe("sidewaysWheelStripScroll", () => {
  it("leaves the strip to the browser unless a scroller with nothing to scroll ends the chain", () => {
    using strip = mountStrip("auto");
    const scroll = (selector: string, deltaX: number, deltaY: number) =>
      sidewaysWheelStripScroll(strip.pathFrom(selector), strip, deltaX, deltaY);

    expect(scroll("[data-row]", 40, 3)).toBe("native");
    expect(scroll("[data-row]", -40, -3)).toBe("native");
    expect(scroll("[data-plain]", 40, 0)).toBe("native");
    expect(scroll("[data-narrow]", 40, 0)).toBe("script");
    expect(scroll("[data-row]", 3, 40)).toBe(null);
    expect(scroll("[data-wide]", 40, 0)).toBe(null);
    strip.querySelector("[data-wide]")!.scrollLeft = 9999;
    expect(scroll("[data-wide]", 40, 0)).toBe(null);
  });

  it("leaves the swipe alone while the strip itself cannot scroll", () => {
    using strip = mountStrip("hidden");
    expect(sidewaysWheelStripScroll(strip.pathFrom("[data-row]"), strip, 40, 3)).toBe(null);
  });
});

// Both platforms' chords at once: alt+cmd on a Mac, ctrl+alt elsewhere.
const CHORD = { ctrlKey: true, metaKey: true, altKey: true };

function mountWheelTarget(listen: (target: HTMLElement) => { stop: () => void }) {
  const target = document.createElement("div");
  document.body.append(target);
  const listening = listen(target);
  const cancelled = (init: WheelEventInit) =>
    !target.dispatchEvent(new WheelEvent("wheel", { cancelable: true, ...init }));
  return {
    cancelled,
    [Symbol.dispose]: () => {
      listening.stop();
      target.remove();
    },
  };
}

describe("listenLayoutWheel", () => {
  it("cancels the wheel only while the layout chord is held", () => {
    let calls = 0;
    using wheel = mountWheelTarget((target) =>
      listenLayoutWheel(target, (event) => {
        calls += 1;
        event.preventDefault();
      }),
    );

    expect(wheel.cancelled({ deltaX: 40 })).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", ...CHORD }));
    expect(wheel.cancelled({ deltaX: 40 })).toBe(true);
    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Alt", ctrlKey: true, metaKey: true, altKey: false }),
    );
    expect(wheel.cancelled({ deltaX: 40 })).toBe(false);
    expect(calls).toBe(3);
  });

  it("stays cancelable past the release while a gesture it owns goes on", () => {
    let owned = true;
    let refresh = () => {};
    using wheel = mountWheelTarget((target) => {
      const listening = listenLayoutWheel(target, (event) => event.preventDefault(), {
        keep: () => owned,
      });
      refresh = listening.refresh;
      return listening;
    });

    expect(wheel.cancelled({ deltaY: 40 })).toBe(true);
    owned = false;
    refresh();
    expect(wheel.cancelled({ deltaY: 40 })).toBe(false);
  });

  it("takes the chord from the wheel itself when its keydown was missed", () => {
    using wheel = mountWheelTarget((target) =>
      listenLayoutWheel(target, (event) => event.preventDefault()),
    );

    // The window was away when the keys went down: this one scrolls, the next is the layout's.
    expect(wheel.cancelled({ deltaY: 40, ...CHORD })).toBe(false);
    expect(wheel.cancelled({ deltaY: 40, ...CHORD })).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(wheel.cancelled({ deltaY: 40 })).toBe(false);
  });
});
