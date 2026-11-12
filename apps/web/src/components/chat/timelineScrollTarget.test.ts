import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createUpwardScrollDetector, isTimelineScrollTarget } from "./timelineScrollTarget";

class ScrollElement extends EventTarget {
  scrollTop = 0;
  scrollHeight = 100;
  clientHeight = 100;
  overflowY = "visible";
  overscrollBehaviorY = "auto";

  constructor(readonly parentElement: ScrollElement | null = null) {
    super();
  }

  contains(target: ScrollElement): boolean {
    return (
      target === this || (target.parentElement !== null && this.contains(target.parentElement))
    );
  }
}

function targetsTimeline(target: EventTarget | null, timeline: ScrollElement, deltaY: number) {
  return isTimelineScrollTarget(target, timeline as unknown as HTMLElement, deltaY);
}

function setup() {
  const timeline = Object.assign(new ScrollElement(), {
    overflowY: "auto",
    scrollHeight: 1500,
    clientHeight: 500,
    scrollTop: 1000,
  });
  const group = Object.assign(new ScrollElement(timeline), {
    overflowY: "auto",
    scrollHeight: 300,
    scrollTop: 80,
  });
  return { timeline, group, content: new ScrollElement(group) };
}

beforeEach(() => {
  vi.stubGlobal("Element", ScrollElement);
  vi.stubGlobal("getComputedStyle", (element: ScrollElement) => element);
});
afterEach(() => vi.unstubAllGlobals());

describe("timeline scroll targets", () => {
  it.each([-30, 30])("keeps a nested tool group's scroll out of the timeline: %i", (deltaY) => {
    const { timeline, group, content } = setup();
    expect(targetsTimeline(content, timeline, deltaY)).toBe(false);
    expect(targetsTimeline(group, timeline, deltaY)).toBe(false);
  });

  it.each([
    { scrollTop: 0, deltaY: -30 },
    { scrollTop: 200, deltaY: 30 },
  ])("allows chaining only past the matching edge: %j", ({ scrollTop, deltaY }) => {
    const { timeline, group, content } = setup();
    group.scrollTop = scrollTop;
    expect(targetsTimeline(content, timeline, deltaY)).toBe(true);
    expect(targetsTimeline(content, timeline, -deltaY)).toBe(false);
  });
});

describe("timeline scroll follow opt-out", () => {
  it("detects iframe-only upward scrolling after following streaming content", () => {
    const scrolledUp = createUpwardScrollDetector({ top: 1000, height: 1500 });
    expect(scrolledUp({ top: 1000, height: 1800 })).toBe(false);
    expect(scrolledUp({ top: 1300, height: 1800 })).toBe(false);
    expect(scrolledUp({ top: 1200, height: 1700 })).toBe(false);

    // Sandboxed frames deliver no wheel or touch event to the parent timeline.
    expect(scrolledUp({ top: 1199.5, height: 1700 })).toBe(false);
    expect(scrolledUp({ top: 1199, height: 1700 })).toBe(false);
    expect(scrolledUp({ top: 1198.5, height: 1700 })).toBe(true);
  });

  it("preserves upward new-turn positioning, then detects the reader leaving that anchor", () => {
    const scrolledUp = createUpwardScrollDetector({ top: 1400, height: 2400 });
    // The caller must distinguish its animated positioning from iframe scroll chaining.
    const positioning = { top: 1200, height: 2400, programmatic: true };
    expect(scrolledUp(positioning)).toBe(false);
    expect(scrolledUp({ ...positioning, top: 1100 })).toBe(false);

    expect(scrolledUp({ top: 1100, height: 2400 })).toBe(false);
    expect(scrolledUp({ top: 950, height: 2400 })).toBe(true);
  });
});
