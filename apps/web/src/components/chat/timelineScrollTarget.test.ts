import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createComposerScrollGestureState,
  recordComposerScrollGestureEvent,
} from "./composerScrollGesture";
import { isTimelineScrollTarget } from "./timelineScrollTarget";

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

  it.each(["contain", "none"])("respects overscroll-y %s at either edge", (overscrollBehaviorY) => {
    const { timeline, group, content } = setup();
    group.overscrollBehaviorY = overscrollBehaviorY;
    group.scrollTop = 0;
    expect(targetsTimeline(content, timeline, -30)).toBe(false);
    group.scrollTop = 200;
    expect(targetsTimeline(content, timeline, 30)).toBe(false);
    group.scrollTop = 0;
    group.scrollHeight = group.clientHeight;
    expect(targetsTimeline(content, timeline, 30)).toBe(false);
  });

  it("checks nested results even when the tool group cannot scroll", () => {
    const { timeline, group } = setup();
    group.scrollTop = 0;
    group.scrollHeight = group.clientHeight;
    const result = Object.assign(new ScrollElement(group), {
      overflowY: "scroll",
      scrollHeight: 300,
      scrollTop: 0.25,
    });
    expect(targetsTimeline(new ScrollElement(result), timeline, -30)).toBe(false);
    result.scrollTop = 0;
    expect(targetsTimeline(result, timeline, -30)).toBe(true);
  });

  it("checks an outer group when an inner result reaches its edge", () => {
    const { timeline, group } = setup();
    const result = Object.assign(new ScrollElement(group), { overflowY: "auto" });
    expect(targetsTimeline(result, timeline, -30)).toBe(false);
    group.scrollTop = 0;
    expect(targetsTimeline(result, timeline, -30)).toBe(true);
  });

  it.each(["visible", "hidden", "clip"])("ignores overflow-y %s", (overflowY) => {
    const { timeline, group, content } = setup();
    group.overflowY = overflowY;
    expect(targetsTimeline(content, timeline, -30)).toBe(true);
  });

  it("allows ordinary message content and the outer viewport", () => {
    const { timeline } = setup();
    expect(targetsTimeline(new ScrollElement(timeline), timeline, -30)).toBe(true);
    expect(targetsTimeline(timeline, timeline, 30)).toBe(true);
  });

  it("rejects outside targets, non-elements, and horizontal-only scrolling", () => {
    const { timeline, content } = setup();
    expect(targetsTimeline(new ScrollElement(), timeline, -30)).toBe(false);
    expect(targetsTimeline(new EventTarget(), timeline, -30)).toBe(false);
    expect(targetsTimeline(null, timeline, -30)).toBe(false);
    expect(targetsTimeline(content, timeline, 0)).toBe(false);
  });

  it("does not accumulate nested scrolling toward composer collapse", () => {
    const { timeline, group, content } = setup();
    const state = createComposerScrollGestureState();
    const record = (target: ScrollElement, now: number, deltaPx: number) =>
      recordComposerScrollGestureEvent(state, {
        now,
        deltaPx,
        collapseThresholdPx: 24,
        collapseEligible: targetsTimeline(target, timeline, -deltaPx),
        canScrollInGestureDirection: timeline.scrollTop > 0,
        scrollsTowardLogicalEnd: false,
      });

    expect(record(timeline, 0, 20)).toBe(false);
    expect(record(content, 20, 30)).toBe(false);
    group.scrollTop = 0;
    expect(record(content, 40, 10)).toBe(false);
    expect(record(content, 60, 14)).toBe(true);
  });
});
