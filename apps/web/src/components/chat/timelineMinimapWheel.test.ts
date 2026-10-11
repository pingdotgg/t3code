// @vitest-environment jsdom

import { describe, expect, it, vi } from "vite-plus/test";

import { forwardWheelToTimeline } from "./timelineMinimapWheel";

function setup() {
  const timeline = document.createElement("div");
  const minimap = document.createElement("div");
  Object.defineProperty(timeline, "clientHeight", { value: 500 });
  const scrollBy = vi.fn();
  timeline.scrollBy = scrollBy as typeof timeline.scrollBy;
  const seen: WheelEvent[] = [];
  timeline.addEventListener("wheel", (event) => seen.push(event));
  minimap.addEventListener("wheel", (event) => forwardWheelToTimeline(event, timeline));
  document.body.append(timeline, minimap);
  const wheel = (init: WheelEventInit) => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    minimap.dispatchEvent(event);
    return event;
  };
  return { timeline, scrollBy, seen, wheel };
}

describe("forwardWheelToTimeline", () => {
  it("replays the wheel on the timeline and scrolls it instead of the minimap", () => {
    const { timeline, scrollBy, seen, wheel } = setup();
    const original = wheel({ deltaY: -120, clientX: 20, clientY: 300 });

    expect(original.defaultPrevented).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.target).toBe(timeline);
    expect(seen[0]?.deltaY).toBe(-120);
    expect(seen[0]?.clientY).toBe(300);
    expect(scrollBy).toHaveBeenCalledWith({ top: -120 });
  });

  it.each([
    { deltaMode: WheelEvent.DOM_DELTA_LINE, top: 48 },
    { deltaMode: WheelEvent.DOM_DELTA_PAGE, top: 1500 },
  ])("converts delta mode $deltaMode to pixels", ({ deltaMode, top }) => {
    const { scrollBy, wheel } = setup();
    wheel({ deltaY: 3, deltaMode });
    expect(scrollBy).toHaveBeenCalledWith({ top });
  });

  it("lets a timeline listener cancel the scroll", () => {
    const { timeline, scrollBy, wheel } = setup();
    timeline.addEventListener("wheel", (event) => event.preventDefault());
    wheel({ deltaY: 40 });
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it.each([{ deltaY: 40, ctrlKey: true }, { deltaX: 40 }])(
    "leaves pinch zoom and horizontal wheels alone: %j",
    (init) => {
      const { scrollBy, seen, wheel } = setup();
      expect(wheel(init).defaultPrevented).toBe(false);
      expect(seen).toHaveLength(0);
      expect(scrollBy).not.toHaveBeenCalled();
    },
  );
});
