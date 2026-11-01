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
  const at = (offset: number, maxOffset: number) => ({ offset, maxOffset });

  it("detects iframe-only upward scrolling after following streaming content", () => {
    const { scrolled } = createUpwardScrollDetector(at(1000, 1000));
    expect(scrolled(at(1000, 1300))).toBe(false);
    expect(scrolled(at(1300, 1300))).toBe(false);
    // Content shrinking below the view pulls the scroll up to the new end.
    expect(scrolled(at(1200, 1200))).toBe(false);

    // Sandboxed frames deliver no wheel or touch event to the parent timeline.
    expect(scrolled(at(1199.5, 1200))).toBe(false);
    expect(scrolled(at(1199, 1200))).toBe(false);
    expect(scrolled(at(1198.5, 1200))).toBe(true);

    // The new end explains only the distance down to it.
    expect(scrolled(at(1194.5, 1194.5))).toBe(false);
    expect(scrolled(at(1193, 1194.5))).toBe(true);
    // Jumping from the end to the top as a virtualized row remeasures 4px smaller.
    const jumpedToTop = createUpwardScrollDetector(at(18040, 18040));
    expect(jumpedToTop.scrolled(at(0, 18036))).toBe(true);
  });

  it("ignores the list keeping content in place, but not the reader's movement around it", () => {
    // A row above shrinks 150px while the answer below grows 50px.
    const mixed = createUpwardScrollDetector(at(3000, 5000));
    mixed.adjusted({ before: at(3000, 4900), after: at(2850, 4900) });
    expect(mixed.scrolled(at(2850, 4900))).toBe(false);
    expect(mixed.scrolled(at(2848, 4900))).toBe(true);

    // Sub-pixel moves on either side of a correction still add up.
    const slow = createUpwardScrollDetector(at(3000, 5000));
    expect(slow.scrolled(at(2999.5, 5000))).toBe(false);
    slow.adjusted({ before: at(2999.2, 4850), after: at(2849.2, 4850) });
    expect(slow.scrolled(at(2849.2, 4850))).toBe(false);
    expect(slow.scrolled(at(2848.9, 4850))).toBe(true);

    // The reader moved up before a correction landed in the same frame.
    const early = createUpwardScrollDetector(at(3000, 5000));
    early.adjusted({ before: at(2980, 4850), after: at(2830, 4850) });
    expect(early.scrolled(at(2830, 4850))).toBe(true);
    expect(early.scrolled(at(2830, 4850))).toBe(false);

    // At the end, content below shrinks 100px and a row above grows 100px: the browser pulls
    // the scroll to the new end, then the list scrolls back down over temporary end padding.
    const clamped = createUpwardScrollDetector(at(3000, 3000));
    clamped.adjusted({ before: at(2900, 2900), after: at(3000, 3100) });
    expect(clamped.scrolled(at(3000, 3100))).toBe(false);
  });

  it("preserves upward new-turn positioning, then detects the reader leaving that anchor", () => {
    const { scrolled, adjusted } = createUpwardScrollDetector(at(1400, 1900));
    // The caller must distinguish its animated positioning from iframe scroll chaining.
    expect(scrolled(at(1200, 1900), true)).toBe(false);
    // The list corrects mid-positioning; its scroll event arrives after the hold ends.
    adjusted({ before: at(1150, 1900), after: at(1100, 1850) }, true);
    expect(scrolled(at(1100, 1850))).toBe(false);
    expect(scrolled(at(950, 1850))).toBe(true);
  });
});
