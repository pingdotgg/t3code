import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers } from "../../../test/render";
import { forwardWheelToTimeline } from "./timelineMinimapWheel";

function mountTimeline() {
  const timeline = document.createElement("div");
  timeline.style.cssText = "height: 200px; overflow-y: auto;";
  const content = document.createElement("div");
  content.style.height = "2000px";
  timeline.append(content);
  document.body.append(timeline);
  return Object.assign(timeline, { [Symbol.dispose]: () => timeline.remove() });
}

function wheel(deltaY: number, wheelDeltaY: number): WheelEvent {
  const init = { cancelable: true, deltaY, wheelDeltaY };
  return new WheelEvent("wheel", init);
}

describe("forwardWheelToTimeline", () => {
  it.each([
    ["macOS", -360],
    ["Linux and Windows", -120],
  ])("scrolls %s trackpad deltas immediately", (_platform, wheelDeltaY) => {
    using timeline = mountTimeline();
    forwardWheelToTimeline(wheel(120, wheelDeltaY), timeline);
    expect(timeline.scrollTop).toBe(120);
  });

  it("glides mouse wheel notches and accumulates them", () => {
    using timeline = mountTimeline();
    using _timers = fakeTimers();
    forwardWheelToTimeline(wheel(100, -120), timeline);
    forwardWheelToTimeline(wheel(100, -120), timeline);
    expect(timeline.scrollTop).toBe(0);
    vi.advanceTimersByTime(75);
    expect(timeline.scrollTop).toBeGreaterThan(0);
    expect(timeline.scrollTop).toBeLessThan(200);
    vi.advanceTimersByTime(100);
    expect(timeline.scrollTop).toBe(200);
  });

  it("stops gliding when the user clicks or navigates", () => {
    using timeline = mountTimeline();
    using _timers = fakeTimers();
    forwardWheelToTimeline(wheel(100, -120), timeline);
    vi.advanceTimersByTime(50);
    timeline.scrollTop = 1000;
    window.dispatchEvent(new PointerEvent("pointerdown"));
    vi.advanceTimersByTime(200);
    expect(timeline.scrollTop).toBe(1000);
  });
});
