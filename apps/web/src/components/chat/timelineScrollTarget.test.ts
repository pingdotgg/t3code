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
  const at = (offset: number, maxOffset: number, programmatic = false) => ({
    offset,
    maxOffset,
    programmatic,
  });

  it("detects iframe-only upward scrolling after following streaming content", () => {
    const scrolledUp = createUpwardScrollDetector(1000);
    expect(scrolledUp(at(1000, 1300))).toBe(false);
    expect(scrolledUp(at(1300, 1300))).toBe(false);
    // Content shrinking below the view pulls the scroll up to the new end.
    expect(scrolledUp(at(1200, 1200))).toBe(false);

    // Sandboxed frames deliver no wheel or touch event to the parent timeline.
    expect(scrolledUp(at(1199.5, 1200))).toBe(false);
    expect(scrolledUp(at(1199, 1200))).toBe(false);
    expect(scrolledUp(at(1198.5, 1200))).toBe(true);

    // The new end explains only the distance down to it: jumping from the end to the top
    // while a virtualized row remeasures 4px smaller.
    const jumpedToTop = createUpwardScrollDetector(18040);
    expect(jumpedToTop(at(0, 18036))).toBe(true);
  });

  it("preserves upward new-turn positioning, then detects the reader leaving that anchor", () => {
    const scrolledUp = createUpwardScrollDetector(1400);
    // The caller must distinguish its animated positioning from iframe scroll chaining.
    expect(scrolledUp(at(1200, 1900, true))).toBe(false);
    expect(scrolledUp(at(1100, 1900, true))).toBe(false);

    expect(scrolledUp(at(1100, 1900))).toBe(false);
    expect(scrolledUp(at(950, 1900))).toBe(true);
  });
});
