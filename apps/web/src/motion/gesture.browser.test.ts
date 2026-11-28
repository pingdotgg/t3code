import { describe, expect, it, vi } from "vite-plus/test";

import { createLayoutState } from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";
import {
  listenLayoutWheel,
  scrollLeftByWheel,
  sidewaysWheelStripScroll,
  wheelChaseStep,
  wheelScrollTarget,
} from "./gesture";
import { attachWorkspaceSwitch } from "./workspaceSwitch";

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
  const zoomTo = (ratio: number) => {
    Object.defineProperty(window, "devicePixelRatio", { value: ratio, configurable: true });
    return {
      [Symbol.dispose]: () => Reflect.deleteProperty(window, "devicePixelRatio"),
    };
  };
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

  it("eases notches under browser zoom and keeps zoomed trackpad deltas direct", async () => {
    using row = mountRow();
    using _zoom = zoomTo(1.100000023841858);
    expect(feed(row, [[35_000, 99.99999783255842, -109]])).toEqual([0]);
    await vi.waitFor(() => expect(row.scrollLeft).toBeCloseTo(100, 0));
    zoomTo(1.5);
    expect(feed(row, [[36_000, 100, -80]])).toEqual([row.scrollLeft]);
    await vi.waitFor(() => expect(row.scrollLeft).toBeCloseTo(200, 0));
    // 200% on 1x (ratio=2), 150% on 2x (ratio=3), and 125% on 1.5x (ratio=1.875).
    zoomTo(2);
    expect(feed(row, [[36_200, 100, -60]])).toEqual([row.scrollLeft]);
    await vi.waitFor(() => expect(row.scrollLeft).toBeCloseTo(300, 0));
    // Trackpad at 100% on 2x Retina still moves directly when legacy === -3 * delta.
    expect(feed(row, [[36_400, 20, -60]])).toEqual([320]);
    zoomTo(3);
    expect(feed(row, [[36_600, 100, -80]])).toEqual([320]);
    await vi.waitFor(() => expect(row.scrollLeft).toBeCloseTo(420, 0));
    zoomTo(1.875);
    expect(feed(row, [[36_800, 100, -96]])).toEqual([420]);
    await vi.waitFor(() => expect(row.scrollLeft).toBeCloseTo(520, 0));
    zoomTo(1.100000023841858);
    const deltas = [11.818181, 6.363636, 20.909091];
    const positions = feed(
      row,
      deltas.map((delta, index) => [37_000 + index * 16, delta, -Math.trunc(3 * delta)] as const),
    );
    let sum = row.scrollLeft - deltas.reduce((total, delta) => total + delta, 0);
    expect(positions.map((value) => Math.round(value))).toEqual(
      deltas.map((delta) => Math.round((sum += delta))),
    );
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

  it("keeps an active ease alive when a direct wheel hits the left edge", async () => {
    using row = mountRow();
    const positions = feed(row, [
      [50_000, 100, -120],
      [50_016, -10, 30],
    ]);
    expect(positions).toEqual([0, 0]);
    await vi.waitFor(() => expect(row.scrollLeft).toBe(90));
  });

  it("ends a running ease when reduced motion turns on", async () => {
    using row = mountRow();
    using other = mountRow();
    expect(feed(other, [[60_000, 100, -120]])).toEqual([0]);
    expect(feed(row, [[60_001, 100, -120]])).toEqual([0]);
    using _reduced = vi.spyOn(MediaQueryList.prototype, "matches", "get").mockReturnValue(true);
    expect(feed(row, [[60_016, 40, -120]])).toEqual([40]);
    await vi.waitFor(() => expect(other.scrollLeft).toBe(100));
    expect(row.scrollLeft).toBe(40);
  });

  it("isolates wheel stream state across windows with separate timeOrigins", async () => {
    using row = mountRow();
    // Main window sends a trackpad delta at a high timestamp.
    expect(feed(row, [[70_000, 7, -21]])).toEqual([7]);
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    using _iframe = { [Symbol.dispose]: () => iframe.remove() };
    const otherWin = iframe.contentWindow!;
    const notched = {
      deltaMode: 0,
      deltaX: 100,
      deltaY: 0,
      wheelDeltaX: -120,
      wheelDeltaY: 0,
      timeStamp: 1_000,
      view: otherWin,
    } as unknown as WheelEvent;
    scrollLeftByWheel(row, notched, 100);
    expect(row.scrollLeft).toBe(7);
    await vi.waitFor(() => expect(row.scrollLeft).toBe(107));
  });
});

describe("workspaceSwitch", () => {
  it("settles back onto the focused workspace if the swipe target disappears before release", async () => {
    const previousLayout = useLayoutStore.getState().layout;
    const root = document.createElement("div");
    const scroller = document.createElement("div");
    const stage = document.createElement("div");
    scroller.style.cssText = "width: 400px; height: 200px; overflow: hidden";
    root.append(scroller, stage);
    document.body.append(root);

    useLayoutStore.setState({ layout: createLayoutState() });
    useLayoutStore.getState().openTab({ kind: "settings" }, { placement: "new-column" });
    const focusedBefore = useLayoutStore.getState().layout.focusedWorkspaceId;
    expect(useLayoutStore.getState().layout.workspaces).toHaveLength(2);

    const detach = attachWorkspaceSwitch({
      root,
      scroller,
      stage,
      gap: () => 0,
      blocked: () => false,
      stripShown: () => true,
    });
    using _cleanup = {
      [Symbol.dispose]: () => {
        detach();
        root.remove();
        useLayoutStore.setState({ layout: previousLayout });
        window.dispatchEvent(new Event("blur"));
      },
    };

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", ...CHORD }));
    const sendWheel = (deltaY: number) =>
      root.dispatchEvent(
        new WheelEvent("wheel", {
          cancelable: true,
          deltaMode: 0,
          deltaY,
          ...CHORD,
        }),
      );
    sendWheel(70);
    sendWheel(70);
    expect(stage.style.transform).not.toBe("");

    // Close the only tab in workspace A while swiping toward trailing blank workspace B:
    // layout normalization keeps A focused and drops B.
    const tabId = useLayoutStore.getState().layout.workspaces[0]!.columns[0]!.panes[0]!.tabs[0]!.id;
    useLayoutStore.getState().closeTab(tabId);
    expect(useLayoutStore.getState().layout.workspaces).toHaveLength(1);
    expect(useLayoutStore.getState().layout.focusedWorkspaceId).toBe(focusedBefore);

    await vi.waitFor(() => expect(stage.style.transform).toBe(""), { timeout: 2_000 });
    expect(useLayoutStore.getState().layout.focusedWorkspaceId).toBe(focusedBefore);
  });
});
