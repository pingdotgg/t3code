import { describe, expect, it } from "vite-plus/test";

import {
  FOLLOWING,
  initialTimelineFollow,
  navigationReleasesFollow,
  nextListOpening,
  transitionTimelineFollow,
  type TimelineFollow,
  type TimelineListOpening,
} from "./timelineViewport";

describe("nextListOpening", () => {
  const unmounted: TimelineListOpening = { mounted: false };

  it("records the thread a list mounts on", () => {
    expect(nextListOpening(unmounted, true, "a")).toEqual({ mounted: true, identity: "a" });
  });

  it("drops the opening once the list shows another thread, even after returning", () => {
    const switched = nextListOpening({ mounted: true, identity: "a" }, true, "b");
    expect(switched).toEqual({ mounted: true, identity: null });
    expect(nextListOpening(switched, true, "a")).toBe(switched);
  });

  it("records a fresh opening after the list unmounts and remounts", () => {
    const gone = nextListOpening({ mounted: true, identity: null }, false, "b");
    expect(gone).toEqual(unmounted);
    expect(nextListOpening(gone, true, "b")).toEqual({ mounted: true, identity: "b" });
  });

  it("keeps the same state object when nothing changes", () => {
    const opened: TimelineListOpening = { mounted: true, identity: "a" };
    expect(nextListOpening(opened, true, "a")).toBe(opened);
    expect(nextListOpening(unmounted, false, "a")).toBe(unmounted);
  });
});

describe("transitionTimelineFollow", () => {
  const releasedAtEnd: TimelineFollow = { mode: "released", atEnd: true };
  const releasedAway: TimelineFollow = { mode: "released", atEnd: false };

  it("releases on navigation and stays released", () => {
    expect(transitionTimelineFollow(FOLLOWING, { type: "navigated" })).toEqual(releasedAtEnd);
    expect(transitionTimelineFollow(releasedAway, { type: "navigated" })).toBe(releasedAway);
  });

  it("ignores the end band flicker while following", () => {
    expect(transitionTimelineFollow(FOLLOWING, { type: "leftEnd" })).toBe(FOLLOWING);
  });

  it("re-arms only after the released view leaves the end and comes back", () => {
    expect(transitionTimelineFollow(releasedAtEnd, { type: "reachedEnd" })).toBe(releasedAtEnd);
    const away = transitionTimelineFollow(releasedAtEnd, { type: "leftEnd" });
    expect(away).toEqual(releasedAway);
    expect(transitionTimelineFollow(away, { type: "reachedEnd" })).toBe(FOLLOWING);
  });

  it("follows the end on request from any state", () => {
    expect(transitionTimelineFollow(releasedAway, { type: "followEnd" })).toBe(FOLLOWING);
  });

  it("starts a thread visit from its remembered position", () => {
    expect(initialTimelineFollow(true)).toBe(FOLLOWING);
    expect(initialTimelineFollow(false)).toEqual(releasedAway);
  });
});

describe("navigationReleasesFollow", () => {
  const viewport = (contentScrollsUp: boolean, awayFromEnd: boolean) => ({
    contentScrollsUp: () => contentScrollsUp,
    awayFromEnd: () => awayFromEnd,
  });

  it("releases on upward input only when the content can scroll up", () => {
    const up = { source: "wheel", direction: "up" } as const;
    expect(navigationReleasesFollow(up, viewport(true, false))).toBe(true);
    expect(navigationReleasesFollow(up, viewport(false, true))).toBe(false);
    expect(
      navigationReleasesFollow({ source: "wheel", direction: "down" }, viewport(true, true)),
    ).toBe(false);
  });

  it("releases on downward keys, touch and row clicks only away from the end", () => {
    const down = { source: "key", key: "PageDown", direction: "down" } as const;
    expect(navigationReleasesFollow(down, viewport(true, false))).toBe(false);
    expect(navigationReleasesFollow(down, viewport(false, true))).toBe(true);
    expect(navigationReleasesFollow({ source: "touch" }, viewport(true, false))).toBe(false);
    expect(
      navigationReleasesFollow({ source: "pointer", onScrollbar: false }, viewport(true, false)),
    ).toBe(false);
    expect(
      navigationReleasesFollow({ source: "pointer", onScrollbar: true }, viewport(true, false)),
    ).toBe(true);
  });

  it("lets commands decide for themselves", () => {
    expect(
      navigationReleasesFollow({ source: "command", releasesFollow: false }, viewport(true, true)),
    ).toBe(false);
    expect(navigationReleasesFollow({ source: "scroll" }, viewport(false, false))).toBe(true);
  });
});
